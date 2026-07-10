# -*- coding: utf-8 -*-
"""한국 히트맵용 업종맵 + 스냅샷 폴백
   → data/kr_sectors.json        (종목코드 → 업종명)
   → data/krheatmap_kospi.json   (/api/krheatmap 과 동일 스키마, 최대 200종목)
   → data/krheatmap_kosdaq.json

업종 소스: 네이버 금융 업종 분류(79개, EUC-KR HTML). 업종당 1요청 = 약 80요청이라
  ⚠️ 런타임(Cloudflare Function)에서는 절대 불가 — 이 파이프라인 전용.
  ⚠️ pykrx(KRX)는 anti-bot으로 데이터센터 IP를 막고 KRX_ID/PW를 요구해 신뢰할 수 없다
     (같은 이유로 fetch_nps.py 산출물이 비어 있다). 그래서 네이버를 1순위로 쓴다.

필터는 functions/api/krheatmap.js 의 keep() 과 **동일하게 유지**해야 한다
  (ETF/ETN · 우선주 · 스팩 · 거래정지 제외).

실행: python fetch_kr_sectors.py
"""
import os, re, sys, json, time, datetime, urllib.request, urllib.parse

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'data')

MIN_SECTORS = 500      # 이보다 적게 모이면 수집 실패로 보고 직전 맵 보존


def _get(url, referer=None, decode='euc-kr'):
    h = {'User-Agent': UA}
    if referer:
        h['Referer'] = referer
    raw = urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=20).read()
    return raw.decode(decode, 'ignore') if decode else raw


# ── 1. 업종맵 (네이버 금융, EUC-KR) ──
def build_sector_map():
    base = 'https://finance.naver.com/sise/'
    html = _get(base + 'sise_group.naver?type=upjong')
    ups = re.findall(r'sise_group_detail\.naver\?type=upjong&no=(\d+)"[^>]*>([^<]+)<', html)
    if not ups:
        raise RuntimeError('업종 목록 파싱 실패')
    print('  업종 %d개' % len(ups))
    sectors = {}
    for i, (no, name) in enumerate(ups):
        name = name.strip()
        try:
            d = _get(base + 'sise_group_detail.naver?type=upjong&no=' + no, referer=base)
            codes = dict.fromkeys(re.findall(r'/item/main\.naver\?code=(\d{6})', d))
            for c in codes:
                sectors.setdefault(c, name)          # 첫 업종 우선(결정적)
        except Exception as e:
            print('    [skip] %s: %s' % (name, str(e)[:60]))
        time.sleep(0.12)                              # 예의상 간격
        if (i + 1) % 20 == 0:
            print('    …%d/%d 업종, 누적 %d종목' % (i + 1, len(ups), len(sectors)))
    return sectors


# ── 2. 스냅샷 (네이버 시총 랭킹) — krheatmap.js 와 동일 필터 ──
def naver_mv(market, page):
    u = 'https://m.stock.naver.com/api/stocks/marketValue/%s?page=%d&pageSize=100' % (market, page)
    d = json.loads(_get(u, referer='https://m.stock.naver.com/', decode=None))
    return d.get('stocks') or []


def keep(s):
    if (s.get('stockEndType') or '') != 'stock':          # ETF/ETN 제외
        return False
    code = s.get('itemCode') or ''
    if len(code) != 6 or code[5] != '0':                  # 우선주 제외(보통주는 6번째 자리가 '0')
        return False
    if '스팩' in (s.get('stockName') or ''):
        return False
    st = s.get('tradeStopType') or {}
    if st.get('code') and st['code'] != '1':               # 거래정지
        return False
    try:
        return float(s['marketValueRaw']) > 0 and float(s['closePriceRaw']) > 0 and \
            float(s['fluctuationsRatio']) == float(s['fluctuationsRatio'])
    except Exception:
        return False


def build_snapshot(mkt, sectors, n=200):
    market = 'KOSPI' if mkt == 'kospi' else 'KOSDAQ'
    raw = []
    for p in (1, 2, 3):
        try:
            raw += naver_mv(market, p)
        except Exception as e:
            print('    [%s p%d] %s' % (market, p, str(e)[:60]))
        time.sleep(0.2)
    seen, items = set(), []
    for s in raw:
        if not keep(s) or s['itemCode'] in seen:
            continue
        seen.add(s['itemCode'])
        items.append({
            'code': s['itemCode'], 'name': s['stockName'],
            'mk': (s.get('stockExchangeType') or {}).get('code', ''),
            'price': float(s['closePriceRaw']),
            # ⚠️ fluctuationsRatio 는 이미 부호 포함 — 다시 곱하지 말 것
            'pct': float(s['fluctuationsRatio']),
            'cap': float(s['marketValueRaw']),
            'sector': sectors.get(s['itemCode'], '기타'),
        })
    items.sort(key=lambda x: -x['cap'])
    items = items[:n]
    now = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
    return {
        '_updated': now.isoformat(timespec='seconds'), 'source': 'snapshot',
        'mkt': mkt, 'n': n,
        'marketStatus': (raw[0].get('marketStatus') if raw else ''),
        'delay': 0, 'count': len(items), 'items': items,
    }


def main():
    os.makedirs(OUT, exist_ok=True)
    sec_path = os.path.join(OUT, 'kr_sectors.json')

    # 업종맵
    sectors = {}
    try:
        print('== 업종맵 수집 (네이버) ==')
        sectors = build_sector_map()
    except Exception as e:
        print('업종맵 수집 실패:', str(e)[:100])

    if len(sectors) < MIN_SECTORS and os.path.exists(sec_path):
        try:
            prev = json.load(open(sec_path, encoding='utf-8'))
            if len(prev.get('sectors') or {}) > len(sectors):
                print('  수집분(%d) < 직전분(%d) → 직전 업종맵 보존' % (len(sectors), len(prev['sectors'])))
                sectors = prev['sectors']
        except Exception:
            pass

    if sectors:
        now = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
        with open(sec_path, 'w', encoding='utf-8') as f:
            json.dump({'_updated': now.isoformat(timespec='seconds'),
                       'count': len(sectors), 'sectors': sectors}, f, ensure_ascii=False, indent=1)
        print('kr_sectors.json 저장: %d종목 · %d업종' % (len(sectors), len(set(sectors.values()))))
    else:
        print('kr_sectors.json 스킵(수집 0)')

    # 스냅샷
    for mkt in ('kospi', 'kosdaq'):
        print('== 스냅샷 %s ==' % mkt)
        try:
            snap = build_snapshot(mkt, sectors)
            if not snap['count']:
                print('  종목 0 → 스킵(직전 스냅샷 보존)')
                continue
            with open(os.path.join(OUT, 'krheatmap_%s.json' % mkt), 'w', encoding='utf-8') as f:
                json.dump(snap, f, ensure_ascii=False, indent=1)
            named = sum(1 for i in snap['items'] if i['sector'] != '기타')
            print('  krheatmap_%s.json 저장: %d종목 · 업종매핑 %d/%d · marketStatus=%s'
                  % (mkt, snap['count'], named, snap['count'], snap['marketStatus']))
        except Exception as e:
            print('  실패:', str(e)[:100])


if __name__ == '__main__':
    main()
