# -*- coding: utf-8 -*-
"""미국 히트맵 스냅샷 폴백 → data/usheatmap_sp500.json, data/usheatmap_nasdaq.json

네이버 해외주식(한글 업종 내장)을 /api/usheatmap 과 동일한 스키마로 저장한다
(sp500 은 전체 500종목, nasdaq 은 상위 200종목).
  sp500  : 지수 편입종목(index/.INX/enrollStocks)
  nasdaq : 나스닥 거래소 시총 랭킹
필터·정규화는 functions/api/usheatmap.js 와 **동일하게 유지**해야 한다.

실행: python fetch_us_heatmap.py
"""
import os, sys, json, time, datetime, urllib.request

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'data')

UNIVERSES = {
    'sp500':  'https://api.stock.naver.com/index/.INX/enrollStocks?page=%d&pageSize=100',
    'nasdaq': 'https://api.stock.naver.com/stock/exchange/NASDAQ/marketValue?page=%d&pageSize=100',
}
TOP_N = {'sp500': 500, 'nasdaq': 200}
PAGES = {'sp500': 6, 'nasdaq': 2}


def _get(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Referer': 'https://m.stock.naver.com/'})
    return json.loads(urllib.request.urlopen(req, timeout=20).read().decode('utf-8', 'ignore'))


def num(v):
    try:
        return float(str(v).replace(',', ''))
    except Exception:
        return float('nan')


def keep(s):
    if (s.get('stockEndType') or '') != 'stock':
        return False
    cap, px, pct = num(s.get('marketValue')), num(s.get('closePrice')), num(s.get('fluctuationsRatio'))
    return cap > 0 and px > 0 and pct == pct


# 섹터: 핀비즈 매핑(us_sectors.json, fetch_us_sectors.py 산출) 조인 + TRBC 2자리 GICS 폴백
GICS_FALLBACK = {'50': '에너지', '51': '소재', '52': '산업재', '53': '경기소비재', '54': '필수소비재',
                 '55': '금융', '56': '헬스케어', '57': '기술', '59': '유틸리티', '60': '부동산'}


def load_us_sectors():
    for base in (OUT, os.path.join(HERE, '..', 'data')):
        p = os.path.join(base, 'us_sectors.json')
        if os.path.exists(p):
            return json.load(open(p, encoding='utf-8')).get('sectors') or {}
    return {}


SEC_MAP = load_us_sectors()


def trbc_sector(s):
    code = str((s.get('industryCodeType') or {}).get('code') or '')
    if code[:4] == '5740':
        return '통신 서비스'
    return GICS_FALLBACK.get(code[:2]) or \
        ((s.get('industryCodeType') or {}).get('industryGroupKor') or '').strip() or '기타'


def norm(s):
    it = {
        'code': s['symbolCode'], 'rc': s.get('reutersCode') or '', 'name': s['stockName'],
        'mk': (s.get('stockExchangeType') or {}).get('code') or '',
        'sector': trbc_sector(s),
        'ind': ((s.get('industryCodeType') or {}).get('industryGroupKor') or '').strip(),
        'price': num(s['closePrice']),
        # ⚠️ fluctuationsRatio 는 이미 부호 포함 — 다시 곱하지 말 것
        'pct': num(s['fluctuationsRatio']),
        'cap': num(s['marketValue']) * 1000,          # 천달러 → 달러
    }
    o = s.get('overMarketPriceInfo')
    if o and o.get('overPrice') is not None and num(o.get('overPrice')) == num(o.get('overPrice')):
        it['o'] = {'p': num(o['overPrice']), 'pct': num(o.get('fluctuationsRatio')),
                   't': o.get('tradingSessionType') or '', 's': o.get('overMarketStatus') or ''}
    st = s.get('tradeStopType') or {}
    if st.get('code') and st['code'] != '1':
        it['h'] = 1                                    # 거래정지 표시용
    return it


def build(us):
    raw = []
    for p in range(1, PAGES[us] + 1):
        try:
            d = _get(UNIVERSES[us] % p)
            raw += d.get('stocks') or []
        except Exception as e:
            print('  [%s p%d] %s' % (us, p, str(e)[:60]))
        time.sleep(0.2)

    seen, items = set(), []
    for s in raw:
        if not keep(s) or s['symbolCode'] in seen:
            continue
        seen.add(s['symbolCode'])
        items.append(norm(s))
    items.sort(key=lambda x: -x['cap'])
    items = items[:TOP_N[us]]
    for it in items:                                   # 핀비즈 섹터·세부 산업 조인
        m = SEC_MAP.get(it['code'])
        if m:
            it['sector'] = m[0]
            if m[1]:
                it['ind'] = m[1]

    if not items:
        print('  %s 종목 0 → 스킵(직전 스냅샷 보존)' % us)
        return

    first = raw[0] if raw else {}
    now = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
    snap = {
        '_updated': now.isoformat(timespec='seconds'), 'source': 'snapshot',
        'mkt': us, 'n': TOP_N[us],
        'marketStatus': first.get('marketStatus') or '',
        'overStatus': (first.get('overMarketPriceInfo') or {}).get('tradingSessionType') or '',
        'delay': 0, 'count': len(items), 'items': items,
    }
    with open(os.path.join(OUT, 'usheatmap_%s.json' % us), 'w', encoding='utf-8') as f:
        json.dump(snap, f, ensure_ascii=False, separators=(',', ':'))
    secs = len(set(i['sector'] for i in items))
    print('usheatmap_%s.json 저장: %d종목 · 업종 %d · marketStatus=%s' % (us, len(items), secs, snap['marketStatus']))


def main():
    os.makedirs(OUT, exist_ok=True)
    for us in ('sp500', 'nasdaq'):
        build(us)


if __name__ == '__main__':
    main()
