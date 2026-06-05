# -*- coding: utf-8 -*-
"""유튜브 채널 RSS → data/videos.json  (큐레이션 투자 채널 최신 영상, 진짜 링크)
   채널 RSS는 키 없이 공개. 실행: py fetch_videos.py
"""
import json, os, datetime, urllib.request
import xml.etree.ElementTree as ET

# (channel_id, 표시명, 시장)  — @handle 페이지의 externalId 로 확보
CHANNELS = [
    ('UChlv4GSd7OQl3js-jkLOnFA', '삼프로TV',    'kr'),
    ('UCsJ6RuBiTVWRX156FVbeaGg', '슈카월드',     'kr'),
    ('UCF8AeLlUbEpKju6v1H6p8Eg', '한국경제TV',   'kr'),
    ('UCC3yfxS5qC6PCwDzetUuEWg', '소수몽키',     'kr'),
    ('UCvJJ_dzjViJCoLf5uKUTwoA', 'CNBC',        'us'),
    ('UCEAZeUIeJs0IjQiqTCdVSIg', 'Yahoo Finance','us'),
    ('UCIALMKvObZNtJ6AmdCLP7Lg', 'Bloomberg TV', 'us'),
]
NS = {'a': 'http://www.w3.org/2005/Atom', 'media': 'http://search.yahoo.com/mrss/'}

def reltime(mins):
    if mins < 1:  return '방금'
    if mins < 60: return '%d분 전' % mins
    h = mins // 60
    if h < 24:    return '%d시간 전' % h
    return '%d일 전' % (h // 24)

def fetch_channel(cid, name, mk):
    url = 'https://www.youtube.com/feeds/videos.xml?channel_id=' + cid
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    root = ET.fromstring(urllib.request.urlopen(req, timeout=15).read())
    now = datetime.datetime.now(datetime.timezone.utc)
    out = []
    for e in root.findall('a:entry', NS)[:5]:
        ln = e.find('a:link', NS)
        link = ln.get('href') if ln is not None else ''
        if not link or '/shorts/' in link:      # 쇼츠 제외 (정식 영상만)
            continue
        title = (e.findtext('a:title', '', NS) or '').strip()
        thumb = ''
        mt = e.find('media:group/media:thumbnail', NS)
        if mt is not None:
            thumb = mt.get('url', '')
        try:
            dt = datetime.datetime.fromisoformat((e.findtext('a:published', '', NS)).replace('Z', '+00:00'))
            mins = max(0, int((now - dt).total_seconds() // 60))
        except Exception:
            mins = 99999
        if title:
            out.append({'ti': title, 'ch': name, 'link': link, 'mk': mk,
                        'min': mins, 'tm': reltime(mins), 'thumb': thumb})
    return out

vids = []
for cid, name, mk in CHANNELS:
    try:
        vids.extend(fetch_channel(cid, name, mk))
    except Exception as e:
        print('[video 실패] %s: %s' % (name, str(e)[:60]))

vids.sort(key=lambda x: x['min'])
vids = vids[:14]
for i, v in enumerate(vids):
    v['hot'] = i < 3

data = {'_updated': datetime.datetime.now().isoformat(timespec='seconds'), 'count': len(vids), 'items': vids}
here = os.path.dirname(os.path.abspath(__file__))
os.makedirs(os.path.join(here, 'data'), exist_ok=True)
with open(os.path.join(here, 'data', 'videos.json'), 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, indent=1)
print('videos.json 저장: %d편 (KR %d / US %d)' % (
    len(vids), sum(v['mk'] == 'kr' for v in vids), sum(v['mk'] == 'us' for v in vids)))
