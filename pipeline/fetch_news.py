# -*- coding: utf-8 -*-
"""구글뉴스 RSS → data/news.json  (한국/미국, 카테고리별 실시간 헤드라인)
   실행: py fetch_news.py
"""
import json, os, re, time, datetime, urllib.request, urllib.parse, html
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime

# 속보 마커: [속보] <속보> 속보: [긴급] [1보] BREAKING JUST IN URGENT 등 (제목 기준)
BRK_RE = re.compile(r'\[?\s*(속보|긴급|\d{1,2}\s*보)\s*[\]\)>:.]|^\s*속보|BREAKING|JUST IN|URGENT|DEVELOPING|LIVE:', re.I)
# 속보 전용 쿼리 기사 → 제목으로 실제 카테고리 분류
def classify(t):
    if re.search(r'전쟁|이란|이스라엘|우크라|러시아|미사일|휴전|호르무즈|중동|북한|하마스|헤즈볼라', t): return '전쟁·지정학'
    if re.search(r'반도체|삼성전자|하이닉스|HBM|D램|낸드|파운드리|마이크론|TSMC|엔비디아|필라델피아', t): return '반도체'
    if re.search(r'코스피|코스닥|증시|외국인|순매수', t): return '국내증시'
    if re.search(r'금리|연준|FOMC|환율|국채|물가|인플레|수출물가', t): return '매크로'
    if re.search(r'유가|원유|WTI|기름값|정유', t): return '원자재'
    if re.search(r'비트코인|코인|가상자산|이더리움', t): return '코인'
    return '속보'

# (mk, cat, query) — 섹터별 수집 → 카테고리 칩은 당일 기사 수 기준 동적 표시. news.js 와 동일.
# 전쟁·지정학·속보를 맨 앞에 둬 분류·중복제거에서 우선권을 갖게 함.
QUERIES = [
    ('kr', '전쟁·지정학', '이스라엘 이란 OR 우크라이나 전쟁 OR 중동 정세 OR 휴전 OR 호르무즈 OR 북한 미사일'),
    ('us', '전쟁·지정학', 'Israel Iran OR Ukraine Russia war OR Middle East conflict OR ceasefire OR Hormuz'),
    ('kr', '속보',       '속보 코스피 OR 속보 금리 OR 속보 환율 OR 속보 유가 OR 속보 전쟁 OR 속보 이란 OR 속보 반도체'),
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

# 미국 뉴스: 구글뉴스 대신 Yahoo Finance RSS(직접 기사 URL·CF 동작). 카테고리 → 종목군. 전쟁·지정학은 구글 유지.
US_TICKERS = {
    '반도체': 'NVDA,TSM,AVGO,AMD,MU,ASML,SMCI',
    '빅테크': 'AAPL,MSFT,AMZN,GOOGL,META',
    'AI': 'PLTR,SMCI,NVDA,MSFT',
    '전기차': 'TSLA,RIVN,LCID,NIO',
    '코인': 'COIN,MSTR,MARA,RIOT',
    '금리': '^TNX,^TYX,TLT',
    '매크로': '^GSPC,^IXIC,^DJI',
}
# 한국 뉴스: 네이버 검색 API(originallink=직접 기사 URL). 카테고리 → 집중 키워드(공백=AND).
KR_NAVER = {
    '전쟁·지정학': '이스라엘 이란',
    '속보': '속보 증시',
    '반도체': '반도체 삼성전자',
    'AI': 'AI 반도체',
    '2차전지': '2차전지 배터리',
    '방산': '방산 수출',
    '원전·전력': '원전 전력',
    '조선': '조선업 수주',
    '자동차': '현대차 자동차',
    '바이오': '제약 바이오',
    '코인': '비트코인 가상자산',
    '국내증시': '코스피 증시',
    '매크로': '기준금리 환율',
}


def naver_keys():
    cid = os.environ.get('NAVER_ID') or os.environ.get('NAVER_CLIENT_ID')
    csec = os.environ.get('NAVER_SECRET') or os.environ.get('NAVER_CLIENT_SECRET')
    if cid and csec:
        return cid, csec
    try:   # 로컬 폴백: 투자/api_key.json (repo 바깥 — 깃에 안 올라감)
        p = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'api_key.json')
        with open(p, encoding='utf-8') as f:
            d = json.load(f)
        return d.get('naver_client_id'), d.get('naver_client_secret')
    except Exception:
        return None, None


def reltime(mins):
    if mins < 1:  return '방금'
    if mins < 60: return '%d분 전' % mins
    h = mins // 60
    if h < 24:    return '%d시간 전' % h
    return '%d일 전' % (h // 24)

def has_ko(s):
    return any('가' <= c <= '힣' for c in (s or ''))

def translate_en_ko(text):
    """영문 → 한국어 (구글 번역 무료 엔드포인트). 3회 재시도·한국어 검출. 실패 시 원문 반환."""
    if not text:
        return text
    s = text[:900]
    for i in range(3):
        try:
            u = ('https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ko&dt=t&q='
                 + urllib.parse.quote(s))
            req = urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'})
            data = json.loads(urllib.request.urlopen(req, timeout=8).read())
            out = ''.join(seg[0] for seg in data[0] if seg and seg[0])
            if has_ko(out):                       # 번역 성공(한국어 포함)일 때만 채택
                if re.search(r'Anthropic', text, re.I):   # gtx 고유명사 오역 보정
                    out = out.replace('인류주식', '앤트로픽')
                return out
        except Exception:
            pass
        time.sleep(0.3 * (i + 1))
    return text

def resolve_gnews(u):
    """구글뉴스 RSS 링크(CBMi…) → 실제 기사 URL (batchexecute). 실패 시 원본 반환.
       클릭 시 중간 구글뉴스 페이지에 머무는 문제를 없애기 위해 스냅샷 단계에서 미리 해석한다.
       (Cloudflare 런타임에선 구글이 막아 안 되므로, 차단 안 되는 GitHub Actions/로컬에서 해 둔다.)"""
    m = re.search(r'/articles/([^?]+)', u or '')
    if not m:
        return u
    art = m.group(1)
    try:
        req = urllib.request.Request('https://news.google.com/rss/articles/' + art,
                                     headers={'User-Agent': 'Mozilla/5.0'})
        page = urllib.request.urlopen(req, timeout=12).read().decode('utf-8', 'ignore')
        sg = re.search(r'data-n-a-sg="([^"]+)"', page)
        ts = re.search(r'data-n-a-ts="([^"]+)"', page)
        if not sg or not ts:
            return u
        inner = json.dumps(['garturlreq', [['X', 'X', ['X', 'X'], None, None, 1, 1, 'US:en', None, 1,
                            None, None, None, None, None, 0, 1], 'X', 'X', 1, [1, 1, 1], 1, 1, None, 0, 0, None, 0],
                            art, int(ts.group(1)), sg.group(1)])
        body = ('f.req=' + urllib.parse.quote(json.dumps([[['Fbv4je', inner, None, '1']]]))).encode()
        req2 = urllib.request.Request('https://news.google.com/_/DotsSplashUi/data/batchexecute', data=body,
                                      headers={'User-Agent': 'Mozilla/5.0',
                                               'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'})
        t = urllib.request.urlopen(req2, timeout=12).read().decode('utf-8', 'ignore')
        arr = json.loads(t.split('\n\n')[1])
        real = json.loads(arr[0][2])[1]
        if real and real.startswith('http'):
            return real
    except Exception:
        pass
    return u


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

def fetch_yahoo(cat, syms):
    """미국 — Yahoo Finance RSS(직접 기사 URL). 종목군 기반 헤드라인."""
    url = 'https://feeds.finance.yahoo.com/rss/2.0/headline?s=%s&region=US&lang=en-US' % urllib.parse.quote(syms)
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    root = ET.fromstring(urllib.request.urlopen(req, timeout=20).read())
    now = datetime.datetime.now(datetime.timezone.utc)
    out = []
    for it in list(root.iter('item'))[:8]:
        title = html.unescape((it.findtext('title') or '').strip())
        link = it.findtext('link') or ''
        if not title or not link.startswith('http'):
            continue
        m = re.match(r'https?://(?:www\.)?([^/]+)', link)
        src = m.group(1) if m else ''
        try:
            mins = max(0, int((now - parsedate_to_datetime(it.findtext('pubDate'))).total_seconds() // 60))
        except Exception:
            mins = 999
        out.append({'mk': 'us', 'cat': cat, 'src': src, 'ti': title, 'link': link,
                    'min': mins, 'tm': reltime(mins), 'sum': '', 'pop': max(1, 100000 - mins)})
    return out


def fetch_naver(cat, query, cid, csec):
    """한국 — 네이버 뉴스 검색 API(originallink=직접 기사 URL)."""
    url = 'https://openapi.naver.com/v1/search/news.json?query=%s&display=8&sort=date' % urllib.parse.quote(query)
    req = urllib.request.Request(url, headers={'X-Naver-Client-Id': cid, 'X-Naver-Client-Secret': csec, 'User-Agent': 'Mozilla/5.0'})
    d = json.loads(urllib.request.urlopen(req, timeout=15).read())
    now = datetime.datetime.now(datetime.timezone.utc)
    out = []
    for it in (d.get('items') or [])[:8]:
        title = html.unescape(re.sub(r'<[^>]+>', '', it.get('title', ''))).strip()
        link = it.get('originallink') or it.get('link') or ''
        if not title or not link.startswith('http'):
            continue
        m = re.match(r'https?://(?:www\.)?([^/]+)', link)
        src = m.group(1) if m else ''
        try:
            mins = max(0, int((now - parsedate_to_datetime(it.get('pubDate'))).total_seconds() // 60))
        except Exception:
            mins = 999
        out.append({'mk': 'kr', 'cat': cat, 'src': src, 'ti': title, 'link': link,
                    'min': mins, 'tm': reltime(mins), 'sum': '', 'pop': max(1, 100000 - mins)})
    return out


NAVER_ID, NAVER_SECRET = naver_keys()
print('네이버 키:', '있음' if NAVER_ID else '없음(구글 폴백)')
items, seen = [], set()
for mk, cat, q in QUERIES:
    try:
        if mk == 'us' and cat in US_TICKERS:
            rows = fetch_yahoo(cat, US_TICKERS[cat])
        elif mk == 'kr' and NAVER_ID and cat in KR_NAVER:
            rows = fetch_naver(cat, KR_NAVER[cat], NAVER_ID, NAVER_SECRET)
        else:
            rows = fetch(mk, cat, q)
        for n in rows:
            if cat == '속보':                 # 속보 전용 쿼리 → 제목으로 실제 카테고리 재분류
                n['cat'] = classify(n['ti'])
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

# 속보 플래그(제목 마커 기준) — 미국 기사는 원문(ti_en)도 함께 검사
for n in items:
    n['breaking'] = bool(BRK_RE.search((n.get('ti') or '') + ' ' + (n.get('ti_en') or '')))

items.sort(key=lambda x: x['min'])
for i, n in enumerate(items):       # 최신 6건은 HOT
    n['hot'] = i < 6
brk = sum(1 for x in items if x.get('breaking'))

# 구글뉴스 링크 → 실제 기사 URL 미리 해석(클릭 시 원문 바로 연결). 병렬 + 실패 시 원본 유지.
try:
    from concurrent.futures import ThreadPoolExecutor
    gn = [n for n in items if 'news.google.com/rss/articles' in (n.get('link') or '')]
    with ThreadPoolExecutor(max_workers=6) as ex:
        reals = list(ex.map(lambda n: resolve_gnews(n['link']), gn))
    ok = 0
    for n, real in zip(gn, reals):
        if real and real != n['link']:
            n['link'] = real
            ok += 1
    print('링크 해석: %d/%d 성공' % (ok, len(gn)))
except Exception as e:
    print('[링크 해석 스킵] ' + str(e)[:80])

data = {'_updated': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
        'count': len(items), 'items': items}
here = os.path.dirname(os.path.abspath(__file__))
os.makedirs(os.path.join(here, 'data'), exist_ok=True)
with open(os.path.join(here, 'data', 'news.json'), 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, indent=1)
print('news.json 저장: %d건 (KR %d / US %d · 속보 %d · 전쟁 %d)' % (
    len(items), sum(x['mk'] == 'kr' for x in items), sum(x['mk'] == 'us' for x in items),
    brk, sum(x.get('cat') == '전쟁·지정학' for x in items)))
