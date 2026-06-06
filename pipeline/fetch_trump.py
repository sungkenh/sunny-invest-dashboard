# -*- coding: utf-8 -*-
"""트럼프 Truth Social 스냅샷 → data/trump.json  (폴백·GitHub Actions용)
   truthsocial.com 직접 접근은 Cloudflare 403 → 공개 아카이브 trumpstruth.org RSS 사용.
   최신 게시물 한국어 번역(원문 보존). 서버리스 trump.js 와 동일.
   실행: python fetch_trump.py
"""
import os, sys, re, json, html, datetime, urllib.request, urllib.parse
from email.utils import parsedate_to_datetime

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
N = 8


def tag(block, name):
    m = re.search(r'<%s[^>]*>([\s\S]*?)</%s>' % (name, name), block)
    return m.group(1) if m else ''


def clean(s):
    s = re.sub(r'<!\[CDATA\[([\s\S]*?)\]\]>', r'\1', s or '')
    s = re.sub(r'<br\s*/?>', ' ', s, flags=re.I)
    s = re.sub(r'<[^>]+>', ' ', s)
    s = html.unescape(s)
    return re.sub(r'\s+', ' ', s).strip()


def reltime(mins):
    if mins < 1:
        return '방금'
    if mins < 60:
        return '%d분 전' % mins
    h = mins // 60
    if h < 24:
        return '%d시간 전' % h
    return '%d일 전' % (h // 24)


def translate(text):
    if not text:
        return ''
    try:
        s = text[:900]
        u = ('https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ko&dt=t&q='
             + urllib.parse.quote(s))
        req = urllib.request.Request(u, headers={'User-Agent': UA})
        d = json.loads(urllib.request.urlopen(req, timeout=12).read())
        return ''.join(seg[0] for seg in d[0] if seg and seg[0]) or text
    except Exception:
        return text


def main():
    url = 'https://trumpstruth.org/feed?per_page=20'
    req = urllib.request.Request(url, headers={'User-Agent': UA,
                                               'Accept': 'application/rss+xml, application/xml'})
    xml = urllib.request.urlopen(req, timeout=15).read().decode('utf-8', 'ignore')
    now = datetime.datetime.now(datetime.timezone.utc)
    items = []
    for b in re.findall(r'<item\b[\s\S]*?</item>', xml):
        en = clean(tag(b, 'title'))
        if not en or len(en) < 4 or re.match(r'^\[No Title\]', en, re.I):
            continue
        link = clean(tag(b, 'link'))
        pd = tag(b, 'pubDate')
        mins = 9999
        if pd:
            try:
                mins = max(0, int((now - parsedate_to_datetime(pd)).total_seconds() // 60))
            except Exception:
                pass
        ko = translate(en)
        items.append({'ti': ko, 'ti_en': en, 'link': link, 'tm': reltime(mins), 'min': mins,
                      'src': 'Truth Social', 'cat': '트럼프', 'mk': 'us', 'sum': en,
                      'pop': max(1, 100000 - mins)})
        if len(items) >= N:
            break

    data = {'_updated': datetime.datetime.now().isoformat(timespec='seconds'),
            'count': len(items), 'items': items}
    here = os.path.dirname(os.path.abspath(__file__))
    os.makedirs(os.path.join(here, 'data'), exist_ok=True)
    with open(os.path.join(here, 'data', 'trump.json'), 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    print('trump.json 저장: %d개 (최신: %s)' % (len(items), (items[0]['ti'][:30] if items else '없음')))


if __name__ == '__main__':
    main()
