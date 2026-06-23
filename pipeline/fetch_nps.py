# -*- coding: utf-8 -*-
"""연기금 일일 순매수/순매도 상위 종목 → data/nps.json  (pykrx · KRX)

   KRX 정보데이터시스템의 '투자자별 순매수' 중 연기금(국민연금 등) 데이터를 수집한다.
   ⚠️ KRX는 anti-bot으로 데이터센터/특정 IP를 막는다 → 이 스크립트는 **GitHub Actions(실IP)**
      에서만 안정적으로 동작. 로컬·Cloudflare에선 빈 결과가 날 수 있고, 그땐 프런트가 '준비 중'을 표시.
   휴장일/장중(미마감)이면 데이터가 없어 직전 영업일까지 최대 7일 백오프.
   실행: python fetch_nps.py
"""
import json, os, datetime

TOPN = 15   # 순매수·순매도 각각 상위 N


def _now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')


def empty(reason=''):
    return {'_updated': _now(), 'date': None, 'buy': [], 'sell': [], 'note': reason}


def run():
    try:
        from pykrx import stock
    except Exception:
        return empty('pykrx 미설치')

    # 기준일: 가장 가까운 영업일(장중·휴장이면 직전으로 백오프)
    try:
        d0 = stock.get_nearest_business_day_in_a_week()
    except Exception:
        d0 = datetime.datetime.now().strftime('%Y%m%d')
    try:
        base = datetime.datetime.strptime(d0, '%Y%m%d')
    except Exception:
        base = datetime.datetime.now()

    rows, used = [], None
    for back in range(0, 7):
        day = (base - datetime.timedelta(days=back)).strftime('%Y%m%d')
        got = []
        for mk in ('KOSPI', 'KOSDAQ'):
            try:
                df = stock.get_market_net_purchases_of_equities(day, day, mk, '연기금')
            except Exception:
                df = None
            if df is None or len(df) == 0:
                continue
            amtcol = '순매수거래대금' if '순매수거래대금' in df.columns else df.columns[-1]
            nmcol = '종목명' if '종목명' in df.columns else df.columns[0]
            for tk, r in df.iterrows():
                try:
                    won = float(r[amtcol])
                except Exception:
                    continue
                if won == 0:
                    continue
                got.append({'name': str(r[nmcol]).strip(), 'ticker': str(tk), 'mk': mk, 'won': won})
        if got:
            rows, used = got, day
            break

    if not rows:
        return empty('데이터 없음(휴장 또는 KRX 차단)')

    rows.sort(key=lambda x: x['won'], reverse=True)

    def fmt(lst):
        return [{'name': x['name'], 'ticker': x['ticker'], 'mk': x['mk'],
                 'amt': round(x['won'] / 1e8, 1)} for x in lst]   # 억원

    buy = fmt([r for r in rows if r['won'] > 0][:TOPN])
    sell = fmt(sorted([r for r in rows if r['won'] < 0], key=lambda x: x['won'])[:TOPN])
    return {'_updated': _now(), 'date': used, 'buy': buy, 'sell': sell}


data = run()
here = os.path.dirname(os.path.abspath(__file__))
os.makedirs(os.path.join(here, 'data'), exist_ok=True)
with open(os.path.join(here, 'data', 'nps.json'), 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, indent=1)
print('nps.json: date=%s · 순매수 %d · 순매도 %d %s' % (
    data.get('date'), len(data.get('buy', [])), len(data.get('sell', [])),
    '(' + data['note'] + ')' if data.get('note') else ''))
