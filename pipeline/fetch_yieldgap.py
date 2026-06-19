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
US_NASDAQ_EY_EST = 2.9    # QQQ(NASDAQ-100) 라이브 실패 시 폴백 (PER ~34)
UPDATE_DAYS = 28          # 월 1회 정책: 스냅샷이 이보다 최근이면 갱신 스킵
LONGTERM = [
    {'k': 'stock', 'label': '주식 (S&P500·KOSPI)', 'us': 10.0, 'kr': 8.0},
    {'k': 'nasdaq', 'label': '주식 (NASDAQ100)', 'us': 13.0, 'kr': None},
    {'k': 'bond', 'label': '채권 (국채)', 'us': 4.5, 'kr': 3.5},
    {'k': 'real', 'label': '부동산 (리츠)', 'us': 8.5, 'kr': 5.0},
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


def qqq_earnings_yield():
    # NASDAQ-100 어닝일드 = 100 / QQQ trailingPE
    try:
        import yfinance as yf
        pe = yf.Ticker('QQQ').info.get('trailingPE')
        if pe and float(pe) > 0:
            return round(100 / float(pe), 2)
    except Exception:
        pass
    return None


def gapf(a, b):
    return None if (a is None or b is None) else round(a - b, 2)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    pipe_snap = os.path.join(here, 'data', 'yieldgap.json')
    root_snap = os.path.join(here, '..', 'data', 'yieldgap.json')
    os.makedirs(os.path.join(here, 'data'), exist_ok=True)

    # 월 1회 갱신: 기존 스냅샷이 UPDATE_DAYS 이내 + 새 구조(us.nasdaq 보유)면 그대로 유지
    # (동일 내용을 pipeline/data 에 써서 cp 라운드트립이 git diff 0이 되도록 → 실제 갱신은 ~월 1회)
    try:
        with open(root_snap, encoding='utf-8') as f:
            prev = json.load(f)
        upd = (prev.get('_updated') or '').replace('Z', '+00:00')
        dt = datetime.datetime.fromisoformat(upd) if upd else None
        if dt is not None and dt.tzinfo is None:
            dt = dt.replace(tzinfo=datetime.timezone.utc)
        age = (datetime.datetime.now(datetime.timezone.utc) - dt).days if dt else 999
        has_new = isinstance(prev.get('us'), dict) and 'nasdaq' in prev['us']
        if has_new and age < UPDATE_DAYS:
            with open(pipe_snap, 'w', encoding='utf-8') as f:
                json.dump(prev, f, ensure_ascii=False, indent=1)
            print('yieldgap: 최근 갱신 %d일 전 — 월 1회 정책으로 유지(스킵)' % age)
            return
    except Exception:
        pass

    kr10 = naver_bond('KR10YT=RR')
    us10 = naver_bond('US10YT=RR')
    spx = spx_earnings_yield()
    vnq = vnq_yield()
    ndx = qqq_earnings_yield()
    us_reit = vnq if vnq is not None else US_REIT_YIELD_EST
    us_ndx = ndx if ndx is not None else US_NASDAQ_EY_EST
    us = {
        'safe': {'label': '국채 10년', 'val': r2(us10), 'est': us10 is None},
        'stock': {'label': '주식 어닝일드 (S&P500)', 'val': r2(spx), 'est': spx is None},
        'nasdaq': {'label': '주식 어닝일드 (NASDAQ100)', 'val': r2(us_ndx), 'est': ndx is None},
        'reit': {'label': '리츠 배당 (VNQ)', 'val': r2(us_reit), 'est': vnq is None},
    }
    us['gap'] = gapf(us['stock']['val'], us['safe']['val'])
    us['gapNdx'] = gapf(us['nasdaq']['val'], us['safe']['val'])
    kr = {
        'safe': {'label': '국채 10년', 'val': r2(kr10), 'est': kr10 is None},
        'stock': {'label': '주식 어닝일드 (KOSPI)', 'val': KR_KOSPI_EY_EST, 'est': True},
        'reit': {'label': '리츠 배당', 'val': KR_REIT_YIELD_EST, 'est': True},
    }
    kr['gap'] = gapf(kr['stock']['val'], kr['safe']['val'])
    data = {'_updated': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
            'us': us, 'kr': kr, 'longterm': LONGTERM}
    with open(pipe_snap, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    print('yieldgap.json 저장: US gap=%s(나스닥 %s), KR gap=%s (us10=%s kr10=%s spx=%s ndx=%s vnq=%s)'
          % (us['gap'], us['gapNdx'], kr['gap'], us10, kr10, spx, ndx, vnq))


if __name__ == '__main__':
    main()
