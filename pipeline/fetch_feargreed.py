# -*- coding: utf-8 -*-
"""공포·탐욕 지수 스냅샷 → data/feargreed.json  (폴백·GitHub Actions용)
   CNN Fear & Greed 공개 dataviz API. 서버리스 feargreed.js 와 동일.
   실행: python fetch_feargreed.py
"""
import os, sys, json, datetime, urllib.request

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'


def label_ko(score):
    if score < 25:
        return '극단적 공포', 'Extreme Fear', 'ef'
    if score < 45:
        return '공포', 'Fear', 'f'
    if score < 55:
        return '중립', 'Neutral', 'n'
    if score < 75:
        return '탐욕', 'Greed', 'g'
    return '극단적 탐욕', 'Extreme Greed', 'eg'


def r1(x):
    return None if x is None else round(x, 1)


def main():
    url = 'https://production.dataviz.cnn.io/index/fearandgreed/graphdata'
    req = urllib.request.Request(url, headers={
        'User-Agent': UA, 'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://edition.cnn.com/', 'Origin': 'https://edition.cnn.com'})
    j = json.loads(urllib.request.urlopen(req, timeout=15).read())
    fg = j.get('fear_and_greed') or {}
    score = int(round(fg['score']))
    ko, en, zone = label_ko(score)
    data = {'_updated': datetime.datetime.now().isoformat(timespec='seconds'),
            'score': score, 'rating': fg.get('rating') or en, 'label': ko, 'zone': zone,
            'ts': fg.get('timestamp', ''),
            'prev': {'close': r1(fg.get('previous_close')), 'week': r1(fg.get('previous_1_week')),
                     'month': r1(fg.get('previous_1_month')), 'year': r1(fg.get('previous_1_year'))}}
    here = os.path.dirname(os.path.abspath(__file__))
    os.makedirs(os.path.join(here, 'data'), exist_ok=True)
    with open(os.path.join(here, 'data', 'feargreed.json'), 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    print('feargreed.json 저장: %d (%s)' % (score, ko))


if __name__ == '__main__':
    main()
