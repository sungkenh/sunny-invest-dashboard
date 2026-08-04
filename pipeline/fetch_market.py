# -*- coding: utf-8 -*-
"""써니의 투자 인사이트 시세 수집기 — yfinance로 13개 지표를 받아 data/market.json 저장.
   실행: py fetch_market.py   (스케줄러로 5~10분마다 돌리면 준실시간)"""
import json, os, datetime, urllib.request, urllib.parse
import yfinance as yf

SYMS = {
    'kospi':  '^KS11',   'ewy': 'EWY',       'kosdaq': '^KQ11',  'spx': '^GSPC',
    'ndx':    '^NDX',    'ndxfut': 'NQ=F',   'sox': '^SOX',
    'btc':    'BTC-USD', 'gold':   'GC=F',   'wti': 'CL=F',
    'ust10y': '^TNX',
    'usdkrw': 'KRW=X',   'usdjpy': 'JPY=X',  'vix': '^VIX',
}

# 국내 지수는 네이버 증권 실시간(지연 0분) 우선 — 야후는 약 15분 지연.
# (브라우저 직접 호출은 CORS·Origin 차단 → 반드시 서버에서. 해외 IP는 차단될 수 있어 야후 폴백)
NAVER_CODE = {'kospi': 'KOSPI', 'kosdaq': 'KOSDAQ'}
NAVER_HDR = {'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.naver.com/sise/'}

def naver_index(code):
    """네이버 실시간 지수 → (price, chg, pct, delay분). Raw 등락 필드는 이미 부호 포함."""
    u = 'https://polling.finance.naver.com/api/realtime/domestic/index/%s' % code
    d = json.loads(urllib.request.urlopen(urllib.request.Request(u, headers=NAVER_HDR), timeout=8).read())
    row = d['datas'][0]
    # ⚠️ 네이버 Raw 필드는 이미 부호 포함(하락이면 음수) — 부호를 또 곱하면 하락장에서 뒤집힌다. 그대로 사용.
    price = float(row['closePriceRaw'])
    chg = float(row['compareToPreviousClosePriceRaw'])
    pct = float(row['fluctuationsRatioRaw'])
    delay = int((row.get('stockExchangeType') or {}).get('delayTime', 0))
    return price, chg, pct, delay

def naver_mi(tries):
    """네이버 시장지표 productDetail — 프로브로 확정한 (카테고리, 코드) 조합을 순차 시도.
       반환 (price, chg|None, pct|None). 값은 천단위 콤마 문자열이라 반드시 제거 후 변환."""
    hdr = {'User-Agent': 'Mozilla/5.0', 'Referer': 'https://m.stock.naver.com/'}
    err = None
    for cat, rc in tries:
        try:
            u = ('https://m.stock.naver.com/front-api/marketIndex/productDetail?category=%s&reutersCode=%s'
                 % (cat, urllib.parse.quote(rc)))
            d = json.loads(urllib.request.urlopen(urllib.request.Request(u, headers=hdr), timeout=10).read())
            v = d.get('result') or {}
            price = float(str(v['closePrice']).replace(',', ''))
            chg = pct = None
            for kf in ('compareToPreviousClosePrice', 'fluctuations', 'changeValue', 'compareToPreviousPrice'):
                try:
                    chg = float(str(v[kf]).replace(',', '')); break
                except Exception:
                    pass
            for kf in ('fluctuationsRatio', 'changeRate'):
                try:
                    pct = float(str(v[kf]).replace(',', '')); break
                except Exception:
                    pass
            return price, chg, pct
        except Exception as e:
            err = e
    raise err or RuntimeError('naver mi fail')


def naver_bond(rc):
    return naver_mi([('bond', rc)])


def naver_poll(path):
    """네이버 앱 폴링 API(7초 주기) — 선물·시장지표 공용. 등락 부호는 방향 코드(1·2=상승, 4·5=하락, 3=보합)."""
    u = 'https://polling.finance.naver.com/api/realtime/%s' % path
    hdr = {'User-Agent': 'Mozilla/5.0', 'Referer': 'https://m.stock.naver.com/'}
    d = json.loads(urllib.request.urlopen(urllib.request.Request(u, headers=hdr), timeout=10).read())
    row = (d.get('datas') or [None])[0]
    if not row:
        raise RuntimeError('no poll %s' % path)

    def num(x):
        try:
            return float(str(x).replace(',', ''))
        except Exception:
            return None
    price = num(row.get('closePrice'))
    if price is None:
        raise RuntimeError('no poll px')
    code = str((row.get('compareToPreviousPrice') or {}).get('code') or '')
    s = -1 if code in ('4', '5') else (0 if code == '3' else 1)
    chg = num(row.get('compareToPreviousClosePrice'))
    pct = num(row.get('fluctuationsRatio'))
    return price, (chg * s if chg is not None else None), (pct * s if pct is not None else None)


def naver_poll_fut(rc):
    """나스닥100 선물(NQcv1) 등."""
    return naver_poll('worldstock/futures/%s' % urllib.parse.quote(rc))


# 네이버 우선 지표 — 카테고리·코드는 실서비스 프로브로 확정 (금·WTI 는 COMEX·NYMEX 선물 연속물, 지연 10분)
# 금·WTI 는 폴링(poll) 엔드포인트 우선 — 등락폭·방향까지 네이버 자체 값 사용. 실패 시 productDetail 폴백.
NAVER_MI = {
    'ust10y': {'tries': [('bond', 'US10YT=RR')]},
    'usdkrw': {'tries': [('exchange', 'FX_USDKRW')]},
    'usdjpy': {'tries': [('exchangeWorld', 'JPY=X'), ('exchangeWorld', 'JPY='), ('exchange', 'FX_USDJPY')]},
    'gold':   {'poll': 'marketindex/metals/GCcv1', 'tries': [('metals', 'GCcv1')]},
    'wti':    {'poll': 'marketindex/energy/CLcv1', 'tries': [('energy', 'CLcv1')]},
}


def quote(s):
    t = yf.Ticker(s)
    try:
        fi = t.fast_info
        lp = float(fi.last_price); pc = float(fi.previous_close)
        if lp and pc:
            return lp, pc
    except Exception:
        pass
    h = t.history(period='5d')
    return float(h['Close'].iloc[-1]), float(h['Close'].iloc[-2])

def downsample(arr, n=40):
    a = [float(x) for x in arr if x is not None and x == x]   # NaN 제거
    if len(a) <= n:
        return [round(v, 4) for v in a]
    step = (len(a) - 1) / (n - 1)
    return [round(a[round(i * step)], 4) for i in range(n)]

def series(s, n=40):
    """장중 1일 5분봉 종가 → 스파크라인용 ~n점."""
    try:
        h = yf.Ticker(s).history(period='1d', interval='5m')
        return downsample(list(h['Close']), n)
    except Exception:
        return []

res = {}
for k, s in SYMS.items():
    # 국내 지수: 네이버 실시간 우선(가격·등락) + 야후 5분봉(스파크라인). 실패 시 야후 전체로 폴백.
    if k in NAVER_CODE:
        try:
            price, chg, pct, delay = naver_index(NAVER_CODE[k])
            res[k] = {'sym': s, 'price': round(price, 4), 'chg': round(chg, 4), 'pct': round(pct, 2),
                      'sp': series(s), 'src': 'naver', 'delay': delay}
            continue
        except Exception:
            pass
    # 나스닥100 선물: 네이버 미니 나스닥100 선물(NQcv1) 우선 + 야후 스파크라인/폴백
    if k == 'ndxfut':
        try:
            price, chg, pct = naver_poll_fut('NQcv1')
            if chg is None:
                try:
                    _, pc = quote(s)
                    if pc:
                        chg = price - pc
                        pct = (price - pc) / pc * 100
                except Exception:
                    pass
            res[k] = {'sym': s, 'price': round(price, 4),
                      'chg': round(chg, 4) if chg is not None else None,
                      'pct': round(pct, 2) if pct is not None else None,
                      'sp': series(s), 'src': 'naver'}
            continue
        except Exception:
            pass
    # 미국채·환율·금·WTI: 네이버 시장지표 우선(가격·등락) + 야후 스파크라인. 실패 시 야후 전체로 폴백.
    if k in NAVER_MI:
        try:
            cfg = NAVER_MI[k]
            if cfg.get('poll'):
                try:
                    price, chg, pct = naver_poll(cfg['poll'])
                except Exception:
                    price, chg, pct = naver_mi(cfg['tries'])
            else:
                price, chg, pct = naver_mi(cfg['tries'])
            if chg is None:
                try:
                    _, pc = quote(s)
                    if pc:
                        chg = price - pc
                        pct = (price - pc) / pc * 100
                except Exception:
                    pass
            res[k] = {'sym': s, 'price': round(price, 4),
                      'chg': round(chg, 4) if chg is not None else None,
                      'pct': round(pct, 2) if pct is not None else None,
                      'sp': series(s), 'src': 'naver'}
            continue
        except Exception:
            pass
    try:
        lp, pc = quote(s)
        res[k] = {'sym': s, 'price': round(lp, 4), 'chg': round(lp - pc, 4),
                  'pct': round((lp - pc) / pc * 100, 2), 'sp': series(s), 'src': 'yahoo'}
    except Exception as e:
        res[k] = {'sym': s, 'error': str(e)[:90]}

# 미국 2년물은 美 재무부 일일 수익률곡선 CSV에서 (야후/FRED가 불안정해서)
import urllib.request
res['ust2y'] = {'sym': 'UST2Y', 'error': 'n/a'}
try:
    yr = datetime.datetime.now().year
    u = ('https://home.treasury.gov/resource-center/data-chart-center/interest-rates/'
         'daily-treasury-rates.csv/%d/all?type=daily_treasury_yield_curve'
         '&field_tdr_date_value=%d&page&_format=csv' % (yr, yr))
    req = urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'})
    rows = [r.split(',') for r in urllib.request.urlopen(req, timeout=25).read().decode().strip().splitlines()]
    hdr = [c.strip().strip('"') for c in rows[0]]
    i2 = hdr.index('2 Yr')
    last = float(rows[1][i2]); prev = float(rows[2][i2])
    sp2 = []   # 2년물은 장중 틱이 없어 최근 ~24거래일 일별 추이(과거→최신)
    for i in range(min(len(rows) - 1, 24), 0, -1):
        try:
            sp2.append(round(float(rows[i][i2]), 3))
        except Exception:
            pass
    res['ust2y'] = {'sym': 'UST2Y', 'price': round(last, 3), 'chg': round(last - prev, 3),
                    'pct': round((last - prev) / prev * 100, 2), 'sp': sp2, 'src': 'treasury'}
except Exception as e:
    res['ust2y'] = {'sym': 'UST2Y', 'error': str(e)[:90]}

# 미국채 2년: 네이버 시장지표 우선 — 재무부 CSV는 하루 지연(스파크라인·등락 기준은 재무부 값 활용)
try:
    price, chg, pct = naver_bond('US2YT=RR')
    tr = res['ust2y'] if 'price' in res.get('ust2y', {}) else None
    prev_daily = tr['price'] if tr else None            # 장중엔 재무부 최신 확정치 = 어제 종가
    if chg is None and prev_daily:
        chg = price - prev_daily
        pct = (price - prev_daily) / prev_daily * 100
    res['ust2y'] = {'sym': 'UST2Y', 'price': round(price, 4),
                    'chg': round(chg, 4) if chg is not None else None,
                    'pct': round(pct, 2) if pct is not None else None,
                    'sp': (tr or {}).get('sp', []), 'src': 'naver'}
except Exception:
    pass                                                # 실패 시 재무부 값 유지

res['_updated'] = datetime.datetime.now().isoformat(timespec='seconds')
here = os.path.dirname(os.path.abspath(__file__))
os.makedirs(os.path.join(here, 'data'), exist_ok=True)
with open(os.path.join(here, 'data', 'market.json'), 'w', encoding='utf-8') as f:
    json.dump(res, f, ensure_ascii=False, indent=2)
print(json.dumps(res, ensure_ascii=False, indent=2))
