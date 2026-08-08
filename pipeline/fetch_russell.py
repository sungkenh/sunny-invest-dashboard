# -*- coding: utf-8 -*-
"""러셀 2000 유니버스(시총 상위 500) → data/usheatmap_russell2000.json

구성종목 원천: Vanguard VTWO(러셀2000 ETF) 보유종목 API — 지수 비중(유동시총) 내림차순
  https://investor.vanguard.com/investment-products/etfs/profile/api/VTWO/portfolio-holding/stock
  (네이버에는 러셀 지수 편입종목 API 가 없어 — .RUT enrollStocks 0건 — ETF 보유내역을 원천으로 쓴다)

시세·한글명·거래소: 네이버 해외주식 폴링 API 다중 조회(콤마 구분, 40개/호출)
  티커의 거래소 접미사(.O 나스닥 / .N NYSE / .A AMEX)를 모르므로 세 후보를 모두 질의해
  응답에 존재하는 코드로 확정한다(없는 코드는 조용히 무시됨 — 프로브로 확인).

시가총액: yfinance fast_info (야후 티커는 '.'→'-'). 실패 종목은
  '보유액×중앙값 배율'로 근사(비중 정렬이 목적이라 순위 왜곡 없음).

섹터: data/us_sectors.json (핀비즈 맵) 조인 — usheatmap.js 와 동일 분류.

산출 스키마는 /api/usheatmap 스냅샷과 동일 + rc(로이터 코드) 필드.
실행: python fetch_russell.py  (refresh-data 워크플로가 6시간마다 호출)
"""
import os, sys, json, time, datetime, urllib.request

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'data')
TOP_N = 520          # 필터 탈락 여유분 포함 (최종 500)
MIN_OK = 300         # 이보다 적게 만들어지면 실패로 보고 직전 파일 보존


def _json(url, referer=None, timeout=25):
    h = {'User-Agent': UA, 'Accept': 'application/json'}
    if referer:
        h['Referer'] = referer
    return json.loads(urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=timeout).read())


# ── 1. VTWO 보유종목 (비중 내림차순 → 1페이지 500건이 곧 상위 500) ──
def fetch_vtwo(n=TOP_N):
    ents = []
    start = 1
    while len(ents) < n:
        d = _json('https://investor.vanguard.com/investment-products/etfs/profile/api/VTWO/portfolio-holding/stock'
                  '?start=%d&count=500' % start)
        page = (d.get('fund') or {}).get('entity') or []
        if not page:
            break
        ents += page
        start += 500
        time.sleep(0.3)
    out = []
    for e in ents[:n]:
        t = (e.get('ticker') or '').strip()
        if not t or t in ('-', 'USD'):
            continue
        try:
            hv = float(e.get('marketValue') or 0)
        except Exception:
            hv = 0
        out.append({'ticker': t, 'longName': (e.get('longName') or '').strip(), 'hold': hv})
    return out


# ── 2. 네이버 폴링 다중 조회 — 로이터코드 확정 + 한글명·시세 ──
def naver_poll_many(codes):
    """코드 목록(<=40) → {reutersCode: row}. 존재하지 않는 코드는 응답에서 빠진다."""
    u = 'https://polling.finance.naver.com/api/realtime/worldstock/stock/' + ','.join(codes)
    d = _json(u, referer='https://m.stock.naver.com/')
    return {r.get('reutersCode'): r for r in (d.get('datas') or []) if r.get('reutersCode')}


def resolve_naver(tickers):
    """티커 → 네이버 row. 접미사 .O/.N/.A 후보를 40개 단위로 묶어 질의."""
    cand = []
    for t in tickers:
        base = t.replace('/', '.')          # BRK/B 형태 방어
        for suf in ('.O', '.N', '.A'):
            cand.append((t, base + suf))
    found = {}
    for i in range(0, len(cand), 40):
        chunk = cand[i:i + 40]
        try:
            rows = naver_poll_many([rc for _, rc in chunk])
        except Exception as e:
            print('    [naver chunk %d] %s' % (i // 40, str(e)[:60]))
            rows = {}
        for t, rc in chunk:
            if rc in rows and t not in found:
                found[t] = rows[rc]
        time.sleep(0.15)
    return found


def num(x):
    try:
        return float(str(x).replace(',', ''))
    except Exception:
        return None


# ── 3. 시가총액 (yfinance, 야후 티커는 '.'→'-') ──
def yahoo_caps(tickers):
    caps = {}
    try:
        import yfinance as yf
    except Exception:
        return caps
    for t in tickers:
        try:
            c = yf.Ticker(t.replace('.', '-')).fast_info.market_cap
            if c and c > 0:
                caps[t] = float(c)
        except Exception:
            pass
        time.sleep(0.05)
    return caps


def main():
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, 'usheatmap_russell2000.json')

    print('== VTWO 보유종목 수집 ==')
    holds = fetch_vtwo()
    print('  보유종목(비중순):', len(holds))
    if len(holds) < MIN_OK:
        print('  수집 부족 → 직전 파일 보존')
        return

    print('== 네이버 코드 확정·시세 ==')
    rows = resolve_naver([h['ticker'] for h in holds])
    print('  네이버 매칭:', len(rows), '/', len(holds))

    print('== 야후 시가총액 ==')
    caps = yahoo_caps([h['ticker'] for h in holds if h['ticker'] in rows])
    print('  시총 확보:', len(caps))

    # 시총 미확보 종목: 보유액×중앙값 배율로 근사 (순위 보존용)
    ratios = sorted(caps[t] / h['hold'] for h in holds for t in [h['ticker']]
                    if t in caps and h['hold'] > 0)
    k = ratios[len(ratios) // 2] if ratios else 150.0
    print('  보유액→시총 중앙값 배율: %.1f' % k)

    # 섹터맵 조인 (핀비즈)
    sectors = {}
    try:
        with open(os.path.join(OUT, 'us_sectors.json'), encoding='utf-8') as f:
            sectors = json.load(f).get('sectors') or {}
    except Exception:
        pass

    items = []
    for h in holds:
        t = h['ticker']
        r = rows.get(t)
        if not r:
            continue
        px = num(r.get('closePrice'))
        if not px or px <= 0:
            continue
        code = str((r.get('compareToPreviousPrice') or {}).get('code') or '')
        s = -1 if code in ('4', '5') else (0 if code == '3' else 1)
        pct = num(r.get('fluctuationsRatio'))
        it = {
            'code': r.get('symbolCode') or t, 'rc': r.get('reutersCode'),
            'name': r.get('stockName') or h['longName'],
            'mk': (r.get('stockExchangeType') or {}).get('code') or '',
            'price': px, 'pct': (pct * s) if pct is not None else 0,
            'cap': caps.get(t) or (h['hold'] * k),
        }
        sec = sectors.get(it['code'])
        if sec:
            it['sector'] = sec[0]
            if len(sec) > 1 and sec[1]:
                it['ind'] = sec[1]
        else:
            it['sector'] = '기타'
        st = r.get('tradeStopType') or {}
        if st.get('code') and st.get('code') != '1':
            it['h'] = 1
        items.append(it)
    items.sort(key=lambda x: -x['cap'])
    items = items[:500]
    print('  최종:', len(items), '종목')
    if len(items) < MIN_OK:
        print('  구성 부족 → 직전 파일 보존')
        return

    now = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
    snap = {
        '_updated': now.isoformat(timespec='seconds'), 'source': 'snapshot',
        'mkt': 'russell2000', 'n': 500,
        'marketStatus': (rows.get(holds[0]['ticker']) or {}).get('marketStatus') or '',
        'delay': 0, 'count': len(items), 'items': items,
    }
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(snap, f, ensure_ascii=False, indent=1)
    named = sum(1 for i in items if i.get('sector') != '기타')
    print('usheatmap_russell2000.json 저장: %d종목 · 섹터매핑 %d · marketStatus=%s'
          % (len(items), named, snap['marketStatus']))


if __name__ == '__main__':
    main()
