# -*- coding: utf-8 -*-
"""일드갭 스냅샷 → data/yieldgap.json  (폴백·GitHub Actions용). 서버리스 yieldgap.js 와 동일 로직.
   자산군 기대수익률(연%): 안전자산(국채10Y)·위험자산(주식 어닝일드=100/PER)·실물자산(리츠 배당)
   + 일드갭(주식 어닝일드 − 국채). 한·미. 韓 주식/리츠는 추정치(무료 라이브 소스 부재).
   실행: python fetch_yieldgap.py
"""
import os, sys, re, json, datetime, urllib.request, urllib.parse

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
KR_KOSPI_EY_EST = 8.7     # KOSPI 추정 PER ~11.5 → 어닝일드 ~8.7%
KR_REIT_YIELD_EST = 6.0   # 국내 상장 리츠 평균 배당수익률 추정 ~6%
US_REIT_YIELD_EST = 3.6   # VNQ 라이브 실패 시 폴백
LONGTERM = [
    {'k': 'stock', 'label': '주식', 'us': 10.0, 'kr': 8.0},
    {'k': 'bond', 'label': '채권', 'us': 4.5, 'kr': 3.5},
    {'k': 'real', 'label': '부동산', 'us': 8.5, 'kr': 5.0},
]


def _get(url, timeout=15):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    return urllib.request.urlopen(req, timeout=timeout).read()


def r2(x):
    return None if x is None else round(float(x), 2)


def naver_bond(rc):
    try:
        u = 'https://m.stock.naver.com/front-api/marketIndex/productDetail?category=bond&reutersCode=' + urllib.parse.quote(rc)
        d = json.loads(_get(u))
        v = (d.get('result') or {}).get('closePrice')
        return float(v) if v is not None else None
    except Exception:
        return None


def spx_earnings_yield():
    try:
        html = _get('https://www.multpl.com/s-p-500-earnings-yield').decode('utf-8', 'ignore')
        m = re.search(r'Earnings Yield is\s*([0-9.]+)\s*%', html, re.I)
        if m:
            return float(m.group(1))
        h2 = _get('https://www.multpl.com/s-p-500-pe-ratio').decode('utf-8', 'ignore')
        m = re.search(r'PE Ratio is\s*([0-9.]+)', h2, re.I)
        if m and float(m.group(1)) > 0:
            return round(100 / float(m.group(1)), 2)
    except Exception:
        pass
    return None


def vnq_yield():
    try:
        import yfinance as yf
        info = yf.Ticker('VNQ').info
        y = info.get('dividendYield') or info.get('yield') or info.get('trailingAnnualDividendYield')
        if y is not None:
            y = float(y)
            return round(y * 100, 2) if y < 1 else round(y, 2)   # 버전따라 0.036 or 3.6
    except Exception:
        pass
    return None


def gapf(a, b):
    return None if (a is None or b is None) else round(a - b, 2)


def main():
    kr10 = naver_bond('KR10YT=RR')
    us10 = naver_bond('US10YT=RR')
    spx = spx_earnings_yield()
    vnq = vnq_yield()
    us_reit = vnq if vnq is not None else US_REIT_YIELD_EST
    us = {
        'safe': {'label': '국채 10년', 'val': r2(us10), 'est': us10 is None},
        'stock': {'label': '주식 어닝일드 (S&P500)', 'val': r2(spx), 'est': spx is None},
        'reit': {'label': '리츠 배당 (VNQ)', 'val': r2(us_reit), 'est': vnq is None},
    }
    us['gap'] = gapf(us['stock']['val'], us['safe']['val'])
    kr = {
        'safe': {'label': '국채 10년', 'val': r2(kr10), 'est': kr10 is None},
        'stock': {'label': '주식 어닝일드 (KOSPI)', 'val': KR_KOSPI_EY_EST, 'est': True},
        'reit': {'label': '리츠 배당', 'val': KR_REIT_YIELD_EST, 'est': True},
    }
    kr['gap'] = gapf(kr['stock']['val'], kr['safe']['val'])
    data = {'_updated': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
            'us': us, 'kr': kr, 'longterm': LONGTERM}
    here = os.path.dirname(os.path.abspath(__file__))
    os.makedirs(os.path.join(here, 'data'), exist_ok=True)
    with open(os.path.join(here, 'data', 'yieldgap.json'), 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    print('yieldgap.json 저장: US gap=%s, KR gap=%s (us10=%s kr10=%s spx=%s vnq=%s)'
          % (us['gap'], kr['gap'], us10, kr10, spx, vnq))


if __name__ == '__main__':
    main()
