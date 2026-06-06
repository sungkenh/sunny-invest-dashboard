# -*- coding: utf-8 -*-
"""추천 투자 영상 스냅샷 → data/videos.json  (국내 경제 유튜브, 최신순)
   채널 RSS(키 불필요)에서 최근 약 1주일(8일) 내 업로드 영상을 채널 구분 없이 전부 수집,
   최신순 정렬(조회수도 보존 → 페이지 인기순 토글), 쇼츠 제외. 서버리스 videos.js 와 동일 로직.
   실행: python fetch_videos.py
"""
import os, sys, re, json, html, datetime, urllib.request

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'

# (channel_id, 표시명) — 국내 인기 경제·투자 유튜브 (영어 채널 제외)
CHANNELS = [
    ('UChlv4GSd7OQl3js-jkLOnFA', '삼프로TV'),
    ('UCsJ6RuBiTVWRX156FVbeaGg', '슈카월드'),
    ('UCF8AeLlUbEpKju6v1H6p8Eg', '한국경제TV'),
    ('UCC3yfxS5qC6PCwDzetUuEWg', '소수몽키'),
    ('UCupslRq5jW95UGzPjOZz0FA', '와이스트릿'),
    ('UCCG6BEYjfQMGzypJw2EJCDQ', '815머니톡'),
    ('UCVt6ZWdDbVKDYkciplQTsvQ', '홍춘욱'),
    ('UCgH2THmX3KgZN72xGO5K_gw', '김단테'),
    ('UCpqD9_OJNtF6suPpi6mOQCQ', '월가아재'),
    ('UCOio3vyYLWiKlHSYRKW-9UA', '설명왕_테이버'),
    ('UCxvdCnvGODDyuvnELnLkQWw', '이효석아카데미'),
    ('UCC8IAk37ddIvOqoo9yXKjqA', '송팀장'),
    ('UCIUni4ScRp4mqPXsxy62L5w', '언더스탠딩'),
    ('UCOB62fKRT7b73X7tRxMuN2g', '박종훈 지식한방'),
    ('UCpTC-SMFjA3EDRhZIKOcKuQ', '자산제곱'),
    ('UCznImSIaxZR7fdLCICLdgaQ', '전인구경제연구소'),
    ('UCfnqgWlC5IvJEAPTmyjaixA', '수페TV'),
]
WINDOW_MIN = 8 * 24 * 60     # 최근 약 1주일(8일) 이내 업로드 전부
TOTAL = 160                  # 기간 내 영상 전부(과도 페이로드 방지 상한)
HOT_MIN = 24 * 60            # 24시간 내 업로드 = 신규(HOT)


def reltime(mins):
    if mins < 1:
        return '방금'
    if mins < 60:
        return '%d분 전' % mins
    h = mins // 60
    if h < 24:
        return '%d시간 전' % h
    return '%d일 전' % (h // 24)


def views_ko(v):
    if not v:
        return ''
    if v >= 1e8:
        return '%.1f억' % (v / 1e8)
    if v >= 1e5:
        return '%d만' % round(v / 1e4)
    if v >= 1e4:
        return '%.1f만' % (v / 1e4)
    if v >= 1e3:
        return '%.1f천' % (v / 1e3)
    return '%d' % v


def fetch_channel(cid, name):
    url = 'https://www.youtube.com/feeds/videos.xml?channel_id=' + cid
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    xml = urllib.request.urlopen(req, timeout=15).read().decode('utf-8', 'ignore')
    now = datetime.datetime.now(datetime.timezone.utc)
    out = []
    for e in re.findall(r'<entry\b[\s\S]*?</entry>', xml)[:15]:
        lm = re.search(r'<link[^>]*rel="alternate"[^>]*href="([^"]+)"', e) or re.search(r'<link[^>]*href="([^"]+)"', e)
        link = html.unescape(lm.group(1)) if lm else ''
        if not link or '/shorts/' in link:
            continue
        tm = re.search(r'<media:title>([\s\S]*?)</media:title>', e) or re.search(r'<title[^>]*>([\s\S]*?)</title>', e)
        title = html.unescape(tm.group(1)).strip() if tm else ''
        thm = re.search(r'<media:thumbnail[^>]*url="([^"]+)"', e)
        thumb = html.unescape(thm.group(1)) if thm else ''
        vm = re.search(r'<media:statistics views="(\d+)"', e)
        views = int(vm.group(1)) if vm else 0
        pm = re.search(r'<published>([\s\S]*?)</published>', e)
        mins = 99999
        if pm:
            try:
                dt = datetime.datetime.fromisoformat(pm.group(1).replace('Z', '+00:00'))
                mins = max(0, int((now - dt).total_seconds() // 60))
            except Exception:
                pass
        if title:
            out.append({'ti': title, 'ch': name, 'link': link, 'mk': 'kr', 'min': mins,
                        'tm': reltime(mins), 'thumb': thumb, 'views': views, 'viewsKo': views_ko(views)})
    return out


def main():
    allv = []
    for cid, name in CHANNELS:
        try:
            allv.extend(fetch_channel(cid, name))
        except Exception as ex:
            print('[video 실패] %s: %s' % (name, str(ex)[:60]))

    # 최근 1주일 내 업로드 전부 → 최신순(동시각대는 조회수). 중복 링크 제거.
    seen = set()
    def dedup(arr):
        out = []
        for v in arr:
            if v['link'] in seen:
                continue
            seen.add(v['link']); out.append(v)
        return out

    pool = sorted(dedup([v for v in allv if v['min'] <= WINDOW_MIN]), key=lambda v: (v['min'], -v['views']))
    if len(pool) < 12:
        seen.clear()
        pool = sorted(dedup(list(allv)), key=lambda v: v['min'])
    picked = pool[:TOTAL]
    for v in picked:
        v['hot'] = v['min'] <= HOT_MIN     # 24시간 내 업로드 = 신규(HOT)

    n_ch = len({v['ch'] for v in picked})
    data = {'_updated': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
            'sort': 'recent', 'window_days': WINDOW_MIN // 1440, 'count': len(picked), 'items': picked}
    here = os.path.dirname(os.path.abspath(__file__))
    os.makedirs(os.path.join(here, 'data'), exist_ok=True)
    with open(os.path.join(here, 'data', 'videos.json'), 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    print('videos.json 저장: %d편 / %d채널 (최신순·최근 %d일) · 최신: %s' % (
        len(picked), n_ch, WINDOW_MIN // 1440,
        ' / '.join('%s %s' % (v['ch'], v['tm']) for v in picked[:3])))


if __name__ == '__main__':
    main()
