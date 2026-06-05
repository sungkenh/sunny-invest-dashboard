# -*- coding: utf-8 -*-
"""관심종목/주요 종목 시세 → data/quotes.json (yfinance)
   대시보드 표시심볼(key) → yfinance 심볼(value). 화면의 r.sym 으로 조회.
"""
import json, os, datetime
import yfinance as yf

SYMS = [
    # 한국 (.KS=코스피 / .KQ=코스닥)
    '005930.KS', '000660.KS', '012450.KS', '247540.KQ', '005380.KS', '000270.KS',
    '035420.KS', '373220.KS', '042660.KS', '079550.KS',
    # 미국
    'NVDA', 'TSLA', 'PLTR', 'TSM', 'AAPL', 'MSFT', 'GOOGL', 'AMD', 'AVGO', 'AMZN', 'META', 'LLY',
]

res = {}
for s in SYMS:
    try:
        fi = yf.Ticker(s).fast_info
        lp = float(fi.last_price); pc = float(fi.previous_close)
        res[s] = {'price': round(lp, 2), 'pct': round((lp - pc) / pc * 100, 2)}
    except Exception as e:
        res[s] = {'error': str(e)[:60]}

res['_updated'] = datetime.datetime.now().isoformat(timespec='seconds')
here = os.path.dirname(os.path.abspath(__file__))
os.makedirs(os.path.join(here, 'data'), exist_ok=True)
with open(os.path.join(here, 'data', 'quotes.json'), 'w', encoding='utf-8') as f:
    json.dump(res, f, ensure_ascii=False, indent=1)
ok = sum(1 for k, v in res.items() if isinstance(v, dict) and 'price' in v)
print('quotes.json 저장: %d종목' % ok)
