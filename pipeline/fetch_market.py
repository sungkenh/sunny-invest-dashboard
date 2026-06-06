# -*- coding: utf-8 -*-
"""써니의 투자 인사이트 시세 수집기 — yfinance 12종 + 美재무부 2년물 + NY연준 역레포 = 14지표 → data/market.json.
   실행: py fetch_market.py   (스케줄러로 5~10분마다 돌리면 준실시간)"""
import json, os, datetime
import yfinance as yf

SYMS = {
    'kospi':  '^KS11',   'kosdaq': '^KQ11',  'spx': '^GSPC', 'ndx': '^NDX', 'sox': '^SOX',
    'btc':    'BTC-USD', 'gold':   'GC=F',   'wti': 'CL=F',
    'ust10y': '^TNX',
    'usdkrw': 'KRW=X',   'usdjpy': 'JPY=X',  'vix': '^VIX',
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
    try:
        lp, pc = quote(s)
        res[k] = {'sym': s, 'price': round(lp, 4), 'chg': round(lp - pc, 4),
                  'pct': round((lp - pc) / pc * 100, 2), 'sp': series(s)}
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
                    'pct': round((last - prev) / prev * 100, 2), 'sp': sp2}
except Exception as e:
    res['ust2y'] = {'sym': 'UST2Y', 'error': str(e)[:90]}

# 미국 익일물 역레포(ON RRP) 잔고 — NY연준 공개 API(키 불필요). 단위: 10억$(billions)
res['rrp'] = {'sym': 'ON RRP', 'error': 'n/a'}
try:
    u = 'https://markets.newyorkfed.org/api/rp/reverserepo/all/results/last/30.json'
    req = urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'})
    jd = json.loads(urllib.request.urlopen(req, timeout=25).read())
    ops = (jd.get('repo') or {}).get('operations') or []
    by_date = {}   # 고정금리 익일물 ON RRP만, 날짜별 1건
    for o in ops:
        if o.get('operationType') != 'Reverse Repo' or o.get('operationMethod') != 'Fixed Rate':
            continue
        d = o.get('operationDate')
        if not d or d in by_date:
            continue
        try:
            by_date[d] = float(o.get('totalAmtAccepted'))
        except Exception:
            pass
    dated = sorted(by_date.items())   # old→new
    bil = [v / 1e9 for _, v in dated]
    last = bil[-1]; prev = bil[-2] if len(bil) > 1 else last
    sp = [round(v, 3) for v in bil[-24:]]
    res['rrp'] = {'sym': 'ON RRP', 'price': round(last, 3), 'chg': round(last - prev, 3),
                  'pct': round((last - prev) / prev * 100, 2) if prev else 0,
                  'sp': sp, 'date': dated[-1][0]}
except Exception as e:
    res['rrp'] = {'sym': 'ON RRP', 'error': str(e)[:90]}

res['_updated'] = datetime.datetime.now().isoformat(timespec='seconds')
here = os.path.dirname(os.path.abspath(__file__))
os.makedirs(os.path.join(here, 'data'), exist_ok=True)
with open(os.path.join(here, 'data', 'market.json'), 'w', encoding='utf-8') as f:
    json.dump(res, f, ensure_ascii=False, indent=2)
print(json.dumps(res, ensure_ascii=False, indent=2))
