# -*- coding: utf-8 -*-
"""테마별 전문가 데스크 스냅샷 → data/themes.json  (폴백·GitHub Actions용)
   큐레이션 thesis(durable) + 바스켓 라이브 등락(야후 chart) + 최신 촉매 뉴스(구글 RSS).
   서버리스 functions/api/themes.js 와 동일 로직(데일리 갱신).
   실행: python fetch_themes.py
"""
import os, sys, re, json, html, datetime, urllib.request, urllib.parse
from email.utils import parsedate_to_datetime

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'

# 테마 = 큐레이션 정의(thesis·바스켓·뉴스쿼리). 바스켓은 야후 심볼(.KS/.KQ/티커).
THEMES = [
    {'nm': 'AI · 반도체', 'desk': '반도체 섹터 데스크', 'op': 'op-buy', 'opTxt': '비중확대',
     'pts': ['하이퍼스케일러 CapEx 가이던스 연속 상향', 'HBM 공급 부족 2026년까지 지속', '전력·냉각 인프라로 수혜 확산'],
     'basket': [['NVDA', '엔비디아'], ['000660.KS', 'SK하이닉스'], ['042700.KS', '한미반도체'], ['SMCI', '슈퍼마이크로']],
     'q': '엔비디아 OR HBM OR AI반도체'},
    {'nm': '방산 · 우주', 'desk': '방산 데스크', 'op': 'op-buy', 'opTxt': '비중확대',
     'pts': ['글로벌 국방비 GDP 2%+ 증액 기조', 'K-방산 수출 파이프라인 확대', '장기 수주잔고 가시성 높음'],
     'basket': [['012450.KS', '한화에어로'], ['079550.KS', 'LIG넥스원'], ['064350.KS', '현대로템'], ['RTX', 'RTX']],
     'q': '방산 OR 한화에어로스페이스 OR 방산수출'},
    {'nm': '원전 · 전력인프라', 'desk': '에너지 데스크', 'op': 'op-buy', 'opTxt': '비중확대',
     'pts': ['AI 데이터센터 전력수요 폭증', 'SMR·송배전 투자 사이클', '전력기기 공급 타이트'],
     'basket': [['034020.KS', '두산에너빌리티'], ['GEV', 'GE Vernova'], ['VST', '비스트라'], ['010120.KS', 'LS ELECTRIC']],
     'q': '원전 OR SMR OR 전력 데이터센터'},
    {'nm': '2차전지 · 소재', 'desk': '2차전지 데스크', 'op': 'op-hold', 'opTxt': '중립',
     'pts': ['전기차 캐즘 단기 지속', '메탈 가격 바닥 다지기', '고체전지 로드맵 장기 모멘텀'],
     'basket': [['373220.KS', 'LG에너지솔루션'], ['247540.KQ', '에코프로비엠'], ['003670.KS', '포스코퓨처엠']],
     'q': '2차전지 OR 전기차 배터리 OR 에코프로'},
    {'nm': '바이오 · 헬스케어', 'desk': '헬스케어 데스크', 'op': 'op-hold', 'opTxt': '중립',
     'pts': ['비만치료제(GLP-1) 시장 확대', '대형 M&A·라이선스 딜 활발', '금리 인하 시 밸류 우호'],
     'basket': [['LLY', '일라이릴리'], ['NVO', '노보노디스크'], ['196170.KQ', '알테오젠']],
     'q': '비만치료제 OR GLP-1 OR 바이오 신약'},
    {'nm': '금융 · 금리', 'desk': '매크로·금융 데스크', 'op': 'op-hold', 'opTxt': '중립',
     'pts': ['금리인하 사이클 진입 국면', '국내 밸류업 배당 매력', '순이자마진 둔화 주의'],
     'basket': [['105560.KS', 'KB금융'], ['138040.KS', '메리츠금융'], ['JPM', 'JP모건']],
     'q': 'FOMC OR 기준금리 OR 밸류업'},
]


def reltime(mins):
    if mins < 1:
        return '방금'
    if mins < 60:
        return '%d분 전' % mins
    h = mins // 60
    if h < 24:
        return '%d시간 전' % h
    return '%d일 전' % (h // 24)


def quote_pct(sym):
    """바스켓 한 종목 오늘 등락%. 야후 chart(crumb 불필요)."""
    try:
        u = 'https://query1.finance.yahoo.com/v8/finance/chart/%s?interval=1d&range=1d' % urllib.parse.quote(sym)
        req = urllib.request.Request(u, headers={'User-Agent': UA})
        d = json.loads(urllib.request.urlopen(req, timeout=12).read())
        m = d['chart']['result'][0]['meta']
        px = m.get('regularMarketPrice')
        pc = m.get('chartPreviousClose') or m.get('previousClose')
        if px is None or not pc:
            return None
        return round((px - pc) / pc * 100, 2)
    except Exception:
        return None


def basket_perf(basket):
    picks = [{'name': name, 'pct': quote_pct(sym)} for sym, name in basket]
    valid = [p for p in picks if isinstance(p['pct'], (int, float))]
    avg = round(sum(p['pct'] for p in valid) / len(valid), 2) if valid else None
    lead = None
    for p in valid:
        if lead is None or p['pct'] > lead['pct']:
            lead = p
    return picks, avg, lead


def latest_news(q):
    """테마 최신 촉매 뉴스 1건. 구글뉴스 RSS(한국어)."""
    try:
        url = 'https://news.google.com/rss/search?q=%s&hl=ko&gl=KR&ceid=KR:ko' % urllib.parse.quote(q)
        req = urllib.request.Request(url, headers={'User-Agent': UA})
        xml = urllib.request.urlopen(req, timeout=12).read().decode('utf-8', 'ignore')
        m = re.search(r'<item\b[\s\S]*?</item>', xml)
        if not m:
            return None
        block = m.group(0)

        def tag(n):
            mm = re.search(r'<%s[^>]*>([\s\S]*?)</%s>' % (n, n), block)
            return html.unescape(mm.group(1)).strip() if mm else ''
        ti = tag('title'); link = tag('link'); src = tag('source')
        if src and ti.endswith(' - ' + src):
            ti = ti[:-(len(src) + 3)].strip()
        elif not src and ' - ' in ti:
            ti, src = [x.strip() for x in ti.rsplit(' - ', 1)]
        tm = ''
        pd = tag('pubDate')
        if pd:
            try:
                now = datetime.datetime.now(datetime.timezone.utc)
                mins = max(0, int((now - parsedate_to_datetime(pd)).total_seconds() // 60))
                tm = reltime(mins)
            except Exception:
                pass
        return {'ti': ti, 'link': link, 'src': src, 'tm': tm} if ti else None
    except Exception:
        return None


def main():
    themes = []
    for t in THEMES:
        picks, perf, lead = basket_perf(t['basket'])
        cat = latest_news(t['q'])
        themes.append({'nm': t['nm'], 'desk': t['desk'], 'op': t['op'], 'opTxt': t['opTxt'],
                       'pts': t['pts'], 'perf': perf, 'lead': lead, 'picks': picks, 'cat': cat})
        print('  [OK] %-14s 바스켓 %s · 촉매 %s' % (
            t['nm'], ('%+.2f%%' % perf) if perf is not None else '—', (cat['ti'][:24] if cat else '없음')))

    data = {'_updated': datetime.datetime.now().isoformat(timespec='seconds'),
            'count': len(themes), 'themes': themes}
    here = os.path.dirname(os.path.abspath(__file__))
    os.makedirs(os.path.join(here, 'data'), exist_ok=True)
    with open(os.path.join(here, 'data', 'themes.json'), 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    print('themes.json 저장: %d개 테마' % len(themes))


if __name__ == '__main__':
    main()
