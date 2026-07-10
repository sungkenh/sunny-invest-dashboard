# -*- coding: utf-8 -*-
"""미국 히트맵 기간 수익률 기준가 → data/us_perf.json

야후 차트 API(일봉·수정주가 adjclose)에서 종목별 1주/1달/3달/6달/올해/1년 전
'기준 종가'를 뽑는다. 유니버스는 fetch_us_heatmap.py 스냅샷 2종(sp500·nasdaq)의 합집합.
프런트(heatmap.html)가 (현재가 / 기준종가 - 1) 로 기간 수익률을 실시간 계산한다.

종목당 1요청 — 파이프라인 전용. fetch_us_heatmap.py 다음에 실행할 것.

실행: python fetch_us_perf.py
"""
import os, sys, json, time, datetime, urllib.request, urllib.parse

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'data')

PERIOD_KEYS = ['w1', 'm1', 'm3', 'm6', 'ytd', 'y1']


def yahoo_daily(sym):
    """(YYYYMMDD, adjclose) 오름차순. 야후 심볼은 '.' 대신 '-' (BRK.B → BRK-B)."""
    u = ('https://query1.finance.yahoo.com/v8/finance/chart/%s'
         '?range=400d&interval=1d&events=div%%2Csplit' % urllib.parse.quote(sym.replace('.', '-')))
    req = urllib.request.Request(u, headers={'User-Agent': UA})
    d = json.loads(urllib.request.urlopen(req, timeout=20).read().decode('utf-8', 'ignore'))
    r = d['chart']['result'][0]
    ts = r.get('timestamp') or []
    ind = r.get('indicators') or {}
    adj = ((ind.get('adjclose') or [{}])[0].get('adjclose')) or \
          ((ind.get('quote') or [{}])[0].get('close')) or []
    out = []
    for t, c in zip(ts, adj):
        if c is None:
            continue
        day = datetime.datetime.fromtimestamp(t, datetime.timezone.utc).strftime('%Y%m%d')
        out.append((day, float(c)))
    return out


def ref_closes(rows, targets):
    out = []
    for t in targets:
        best = None
        for d, c in rows:
            if d <= t:
                best = c
            else:
                break
        out.append(round(best, 4) if best is not None else None)
    return out


def main():
    os.makedirs(OUT, exist_ok=True)
    codes, seen = [], set()
    for us in ('sp500', 'nasdaq'):
        p1 = os.path.join(OUT, 'usheatmap_%s.json' % us)
        p2 = os.path.join(HERE, '..', 'data', 'usheatmap_%s.json' % us)
        path = p1 if os.path.exists(p1) else p2
        if not os.path.exists(path):
            continue
        for i in json.load(open(path, encoding='utf-8'))['items']:
            if i['code'] not in seen:
                seen.add(i['code'])
                codes.append(i['code'])
    if not codes:
        print('스냅샷 없음 → fetch_us_heatmap.py 먼저 실행')
        return

    # 기준일은 미국 동부 기준이지만 일 단위 근사라 UTC 날짜로 충분
    today = datetime.datetime.now(datetime.timezone.utc).date()
    tgt = [
        today - datetime.timedelta(days=7),
        today - datetime.timedelta(days=30),
        today - datetime.timedelta(days=91),
        today - datetime.timedelta(days=182),
        datetime.date(today.year - 1, 12, 31),
        today - datetime.timedelta(days=365),
    ]
    targets = [d.strftime('%Y%m%d') for d in tgt]
    print('유니버스 %d종목 · 기준일 %s' % (len(codes), dict(zip(PERIOD_KEYS, targets))))

    refs, fail = {}, 0
    for i, code in enumerate(codes):
        try:
            rows = yahoo_daily(code)
            if rows:
                refs[code] = ref_closes(rows, targets)
            else:
                fail += 1
        except Exception:
            fail += 1
        time.sleep(0.12)
        if (i + 1) % 50 == 0:
            print('  …%d/%d (실패 %d)' % (i + 1, len(codes), fail))

    if len(refs) < len(codes) * 0.5:
        print('수집 실패(%d/%d) → 직전 us_perf.json 보존' % (len(refs), len(codes)))
        return

    now = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
    with open(os.path.join(OUT, 'us_perf.json'), 'w', encoding='utf-8') as f:
        json.dump({'_updated': now.isoformat(timespec='seconds'),
                   'periods': PERIOD_KEYS,
                   'targets': dict(zip(PERIOD_KEYS, targets)),
                   'count': len(refs), 'refs': refs}, f, ensure_ascii=False, separators=(',', ':'))
    full = sum(1 for v in refs.values() if all(x is not None for x in v))
    print('us_perf.json 저장: %d종목 (전기간 보유 %d · 실패 %d)' % (len(refs), full, fail))


if __name__ == '__main__':
    main()
