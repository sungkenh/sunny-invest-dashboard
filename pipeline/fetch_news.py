# -*- coding: utf-8 -*-
"""구글뉴스 RSS → data/news.json  (한국/미국, 카테고리별 실시간 헤드라인)
   실행: py fetch_news.py
"""
import json, os, datetime, urllib.request, urllib.parse, html
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime

# (mk, cat, query) — 섹터별 수집 → 카테고리 칩은 당일 기사 수 기준 동적 표시. news.js 와 동일.
QUERIES = [
    ('kr', '반도체',    '삼성전자 OR SK하이닉스 OR HBM 반도체'),
    ('kr', 'AI',        'AI 반도체 OR 생성형 AI OR 네이버 카카오 AI'),
    ('kr', '2차전지',   '2차전지 OR 에코프로 OR LG에너지솔루션'),
    ('kr', '방산',      '방산 OR 한화에어로스페이스 OR LIG넥스원'),
    ('kr', '원전·전력', '원전 OR SMR OR 두산에너빌리티 OR 전력설비'),
    ('kr', '조선',      '조선 OR HD현대중공업 OR 한화오션 OR 삼성중공업'),
    ('kr', '자동차',    '현대차 OR 기아 OR 자동차 수출'),
    ('kr', '바이오',    '삼성바이오 OR 셀트리온 OR 바이오 신약'),
    ('kr', '코인',      '비트코인 OR 가상자산 OR 알트코인'),
    ('kr', '국내증시',  '코스피 OR 코스닥 증시 외국인'),
    ('kr', '매크로',    '한국은행 기준금리 OR 원달러 환율'),
    ('us', '반도체',    'Nvidia OR TSMC OR semiconductor'),
    ('us', '빅테크',    'Apple OR Microsoft OR Amazon AI'),
    ('us', 'AI',        'Palantir OR AI stocks OR OpenAI'),
    ('us', '전기차',    'Tesla OR EV sales'),
    ('us', '코인',      'Bitcoin OR Coinbase OR crypto'),
    ('us', '금리',      'Treasury yields OR Fed rate cut'),
    ('us', '매크로',    'Federal Reserve OR US jobs report OR inflation'),
]

def reltime(mins):
    if mins < 1:  return '방금'
    if mins < 60: return '%d분 전' % mins
    h = mins // 60
    if h < 24:    return '%d시간 전' % h
    return '%d일 전' % (h // 24)

def translate_en_ko(text):
    """영문 → 한국어 (구글 번역 무료 엔드포인트). 실패 시 원문 반환."""
    if not text:
        return text
    try:
        u = ('https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ko&dt=t&q='
             + urllib.parse.quote(text))
        req = urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'})
        data = json.loads(urllib.request.urlopen(req, timeout=8).read())
        return ''.join(seg[0] for seg in data[0] if seg and seg[0]) or text
    except Exception:
        return text

def fetch(mk, cat, q):
    hl, gl, ceid = ('ko', 'KR', 'KR:ko') if mk == 'kr' else ('en-US', 'US', 'US:en')
    url = 'https://news.google.com/rss/search?q=%s&hl=%s&gl=%s&ceid=%s' % (
        urllib.parse.quote(q), hl, gl, ceid)
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    root = ET.fromstring(urllib.request.urlopen(req, timeout=20).read())
    now = datetime.datetime.now(datetime.timezone.utc)
    out = []
    for it in list(root.iter('item'))[:8]:
        title = html.unescape((it.findtext('title') or '').strip())
        link = it.findtext('link') or ''
        s = it.find('source')
        src = (s.text or '').strip() if s is not None else ''
        if src and title.endswith(' - ' + src):
            title = title[:-(len(src) + 3)].strip()
        elif not src and ' - ' in title:
            title, src = [x.strip() for x in title.rsplit(' - ', 1)]
        try:
            mins = max(0, int((now - parsedate_to_datetime(it.findtext('pubDate'))).total_seconds() // 60))
        except Exception:
            mins = 999
        if title:
            out.append({'mk': mk, 'cat': cat, 'src': src, 'ti': title, 'link': link,
                        'min': mins, 'tm': reltime(mins), 'sum': '', 'pop': max(1, 100000 - mins)})
    return out

items, seen = [], set()
for mk, cat, q in QUERIES:
    try:
        for n in fetch(mk, cat, q):
            k = n['ti'][:28]
            if k in seen:
                continue
            seen.add(k); items.append(n)
    except Exception as e:
        print('[news 실패] %s/%s: %s' % (mk, cat, str(e)[:60]))

# 미국 기사(영문) → 한국어 번역 (원문은 ti_en/sum 에 보존 → 뉴스 페이지 부제로 표시)
for n in items:
    if n['mk'] == 'us':
        en = n['ti']
        ko = translate_en_ko(en)
        if ko and ko != en:
            n['ti'] = ko
            n['ti_en'] = en
            n['sum'] = en

items.sort(key=lambda x: x['min'])
for i, n in enumerate(items):       # 최신 6건은 HOT
    n['hot'] = i < 6

data = {'_updated': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
        'count': len(items), 'items': items}
here = os.path.dirname(os.path.abspath(__file__))
os.makedirs(os.path.join(here, 'data'), exist_ok=True)
with open(os.path.join(here, 'data', 'news.json'), 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, indent=1)
print('news.json 저장: %d건 (KR %d / US %d)' % (
    len(items), sum(x['mk'] == 'kr' for x in items), sum(x['mk'] == 'us' for x in items)))
