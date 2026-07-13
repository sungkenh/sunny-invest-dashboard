# -*- coding: utf-8 -*-
"""한국 히트맵 기간 수익률 기준가 → data/kr_perf.json

네이버 siseJson(일봉·수정주가)에서 종목별 1주/1달/3달/6달/올해/1년 전 '기준 종가'를 뽑는다.
프런트(heatmap.html)가 (실시간가 / 기준종가 - 1) 로 기간 수익률을 실시간 계산한다.

종목당 1요청 × 약 400종목(코스피·코스닥 시총 상위 200 합집합) — 파이프라인 전용,
런타임(Cloudflare Function, subrequest 50 상한)에서는 절대 불가.

유니버스 필터는 functions/api/krheatmap.js 의 keep() 과 동일하게 유지해야 한다.

실행: python fetch_kr_perf.py
"""
import os, re, sys, json, time, datetime, urllib.request

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'data')

PERIOD_KEYS = ['w1', 'm1', 'm3', 'm6', 'ytd', 'y1']
TOP_N = 200          # 시장별 상위 200 (히트맵 최대 표시 수와 동일)


def _get(url, referer='https://finance.naver.com/'):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Referer': referer})
    return urllib.request.urlopen(req, timeout=20).read().decode('utf-8', 'ignore')


# ── 유니버스: 네이버 시총 랭킹 (krheatmap.js 와 동일 필터) ──
def naver_mv(market, page):
    u = 'https://m.stock.naver.com/api/stocks/marketValue/%s?page=%d&pageSize=100' % (market, page)
    d = json.loads(_get(u, referer='https://m.stock.naver.com/'))
    return d.get('stocks') or []


def keep(s):
    if (s.get('stockEndType') or '') != 'stock':          # ETF/ETN 제외
        return False
    code = s.get('itemCode') or ''
    if len(code) != 6 or code[5] != '0':                  # 우선주 제외
        return False
    if '스팩' in (s.get('stockName') or ''):
        return False
    # 거래정지 종목도 포함(서킷브레이커 방어 — krheatmap.js 와 동일)
    try:
        return float(s['marketValueRaw']) > 0 and float(s['closePriceRaw']) > 0 and \
            float(s['fluctuationsRatio']) == float(s['fluctuationsRatio'])
    except Exception:
        return False


def universe():
    codes = []
    seen = set()
    for market in ('KOSPI', 'KOSDAQ'):
        rows = []
        for p in (1, 2, 3):
            try:
                rows += naver_mv(market, p)
            except Exception as e:
                print('  [%s p%d] %s' % (market, p, str(e)[:60]))
            time.sleep(0.2)
        kept = [s for s in rows if keep(s) and s['itemCode'] not in seen]
        kept.sort(key=lambda s: -float(s['marketValueRaw']))
        for s in kept[:TOP_N]:
            seen.add(s['itemCode'])
            codes.append(s['itemCode'])
        print('  %s: %d종목' % (market, min(len(kept), TOP_N)))
    return codes


# ── 일봉 종가 (siseJson: [["YYYYMMDD", 시, 고, 저, 종, 량, 소진율], ...]) ──
ROW_RE = re.compile(r'\[\s*"(\d{8})"\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)')


def daily_closes(code, start, end):
    u = ('https://api.finance.naver.com/siseJson.naver?symbol=%s&requestType=1'
         '&startTime=%s&endTime=%s&timeframe=day' % (code, start, end))
    return [(d, float(c)) for d, c in ROW_RE.findall(_get(u))]


def ref_closes(rows, targets):
    """각 목표일(YYYYMMDD) 이전(포함) 마지막 종가. 없으면(신규상장) None."""
    out = []
    for t in targets:
        best = None
        for d, c in rows:                 # rows 는 날짜 오름차순
            if d <= t:
                best = c
            else:
                break
        out.append(best)
    return out


def main():
    os.makedirs(OUT, exist_ok=True)
    kst = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=9)))
    today = kst.date()
    tgt = [
        today - datetime.timedelta(days=7),      # w1
        today - datetime.timedelta(days=30),     # m1
        today - datetime.timedelta(days=91),     # m3
        today - datetime.timedelta(days=182),    # m6
        datetime.date(today.year - 1, 12, 31),   # ytd = 작년 말 종가 대비
        today - datetime.timedelta(days=365),    # y1
    ]
    targets = [d.strftime('%Y%m%d') for d in tgt]
    start = (today - datetime.timedelta(days=380)).strftime('%Y%m%d')
    end = today.strftime('%Y%m%d')

    print('== 유니버스 수집 ==')
    codes = universe()
    print('합계 %d종목 · 기준일 %s' % (len(codes), dict(zip(PERIOD_KEYS, targets))))

    refs, fail = {}, 0
    for i, code in enumerate(codes):
        try:
            rows = daily_closes(code, start, end)
            if rows:
                refs[code] = ref_closes(rows, targets)
            else:
                fail += 1
        except Exception:
            fail += 1
        time.sleep(0.06)
        if (i + 1) % 100 == 0:
            print('  …%d/%d (실패 %d)' % (i + 1, len(codes), fail))

    if len(refs) < len(codes) * 0.5:      # 절반 이상 실패 → 수집 실패로 보고 직전 파일 보존
        print('수집 실패(%d/%d) → 직전 kr_perf.json 보존' % (len(refs), len(codes)))
        return

    now = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
    with open(os.path.join(OUT, 'kr_perf.json'), 'w', encoding='utf-8') as f:
        json.dump({'_updated': now.isoformat(timespec='seconds'),
                   'periods': PERIOD_KEYS,
                   'targets': dict(zip(PERIOD_KEYS, targets)),
                   'count': len(refs), 'refs': refs}, f, ensure_ascii=False, separators=(',', ':'))
    full = sum(1 for v in refs.values() if all(x is not None for x in v))
    print('kr_perf.json 저장: %d종목 (전기간 보유 %d · 실패 %d)' % (len(refs), full, fail))


if __name__ == '__main__':
    main()
