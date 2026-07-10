# -*- coding: utf-8 -*-
"""섹터 전문가 데스크 스냅샷 → data/themes_kr.json, data/themes_us.json  (폴백·GitHub Actions용)

서버리스 functions/api/themes.js 와 동일한 비중의견 엔진:
  절대모멘텀(6M) 30% + 지수대비 상대강도 30% + 추세구조(50/200일선) 25% + 폭(breadth) 15%
  − 리스크 감점(20일 이격·변동성·RSI 과열, 최대 30) → 스코어 −100~+100
  가드레일: 과열·낙폭·시장 리스크오프·저신뢰·데이터부족 → 비중확대 억제/판단보류
⚠️ 가격(추세) 기반 상대 판단. 밸류에이션·실적·수급 미반영 — 매수/매도 신호가 아님.

실행: python fetch_themes.py
"""
import os, sys, re, json, math, datetime, urllib.request, urllib.parse
from email.utils import parsedate_to_datetime

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'

BENCH = {'kr': ('^KS11', 'KOSPI'), 'us': ('^GSPC', 'S&P 500')}

DESKS = {
 'kr': [
  {'nm': 'AI · 반도체', 'desk': '반도체 데스크', 'thesis': 'HBM·파운드리 증설과 AI 서버 수요가 실적 레버리지의 축',
   'basket': [('005930.KS', '삼성전자'), ('000660.KS', 'SK하이닉스'), ('042700.KS', '한미반도체'), ('058470.KQ', '리노공업')],
   'q': 'HBM OR SK하이닉스 OR AI반도체'},
  {'nm': '방산 · 우주', 'desk': '방산 데스크', 'thesis': '글로벌 국방비 증액과 K-방산 수출 파이프라인이 장기 수주잔고를 지지',
   'basket': [('012450.KS', '한화에어로스페이스'), ('079550.KS', 'LIG넥스원'), ('064350.KS', '현대로템'), ('047810.KS', '한국항공우주')],
   'q': '방산 OR 한화에어로스페이스 OR 방산수출'},
  {'nm': '원전 · 전력기기', 'desk': '에너지 데스크', 'thesis': 'AI 데이터센터 전력수요와 노후 송배전 교체 사이클이 구조적 수요',
   'basket': [('034020.KS', '두산에너빌리티'), ('267260.KS', 'HD현대일렉트릭'), ('010120.KS', 'LS ELECTRIC'), ('298040.KS', '효성중공업')],
   'q': '원전 OR SMR OR 전력기기 수출'},
  {'nm': '조선 · 기계', 'desk': '조선 데스크', 'thesis': '친환경 선박 교체 수요와 고선가 수주잔고가 수익성 개선을 견인',
   'basket': [('009540.KS', 'HD한국조선해양'), ('329180.KS', 'HD현대중공업'), ('042660.KS', '한화오션'), ('010140.KS', '삼성중공업')],
   'q': '조선 수주 OR LNG선 OR 한화오션'},
  {'nm': '2차전지 · 소재', 'desk': '2차전지 데스크', 'thesis': '전기차 캐즘 단기 부담 vs 메탈가 바닥·전고체 로드맵의 장기 옵션',
   'basket': [('373220.KS', 'LG에너지솔루션'), ('006400.KS', '삼성SDI'), ('247540.KQ', '에코프로비엠'), ('003670.KS', '포스코퓨처엠')],
   'q': '2차전지 OR 전기차 배터리 OR 에코프로'},
  {'nm': '바이오 · 헬스케어', 'desk': '헬스케어 데스크', 'thesis': 'CDMO 수주 확대와 비만치료제 밸류체인이 실적 가시성을 높임',
   'basket': [('207940.KS', '삼성바이오로직스'), ('068270.KS', '셀트리온'), ('196170.KQ', '알테오젠'), ('000100.KS', '유한양행')],
   'q': '바이오 신약 OR CDMO OR 알테오젠'},
  {'nm': '금융 · 밸류업', 'desk': '매크로·금융 데스크', 'thesis': '주주환원 확대와 금리 하강 국면의 자본비용 완화가 재평가 요인',
   'basket': [('105560.KS', 'KB금융'), ('055550.KS', '신한지주'), ('138040.KS', '메리츠금융'), ('000810.KS', '삼성화재')],
   'q': '밸류업 OR 은행 배당 OR 기준금리'},
 ],
 'us': [
  {'nm': 'AI · 반도체', 'desk': 'Semis 데스크', 'thesis': '가속컴퓨팅 전환으로 AI 인프라 CapEx가 반도체 이익에 집중',
   'basket': [('NVDA', '엔비디아'), ('AVGO', '브로드컴'), ('AMD', 'AMD'), ('TSM', 'TSMC')],
   'q': 'Nvidia OR AI chip OR semiconductor demand'},
  {'nm': '빅테크 · 소프트웨어', 'desk': '테크 데스크', 'thesis': 'AI 수익화 초기 국면 — 클라우드·광고 현금흐름이 투자를 뒷받침',
   'basket': [('MSFT', '마이크로소프트'), ('GOOGL', '알파벳'), ('META', '메타'), ('PLTR', '팔란티어')],
   'q': 'Microsoft OR Alphabet OR AI software'},
  {'nm': '전력 · 원자력', 'desk': '유틸리티 데스크', 'thesis': '데이터센터 전력수요 급증으로 발전·원자력 계약단가가 재평가',
   'basket': [('GEV', 'GE버노바'), ('VST', '비스트라'), ('CEG', '콘스텔레이션'), ('NRG', 'NRG에너지')],
   'q': 'data center power OR nuclear PPA OR Vistra'},
  {'nm': '방산 · 우주', 'desk': '방산 데스크', 'thesis': '지정학 리스크 상시화로 다년 방위예산 가시성 확보',
   'basket': [('RTX', 'RTX'), ('LMT', '록히드마틴'), ('NOC', '노스롭그루먼'), ('GD', '제너럴다이내믹스')],
   'q': 'defense budget OR Lockheed OR missile order'},
  {'nm': '헬스케어 · 비만치료', 'desk': '헬스케어 데스크', 'thesis': 'GLP-1 시장 확대와 대형 M&A가 파이프라인 가치를 재산정',
   'basket': [('LLY', '일라이릴리'), ('NVO', '노보노디스크'), ('UNH', '유나이티드헬스'), ('ABBV', '애브비')],
   'q': 'GLP-1 OR obesity drug OR Eli Lilly'},
  {'nm': '금융 · 은행', 'desk': '금융 데스크', 'thesis': '금리 하강기 순이자마진 둔화 vs 자본시장 수수료·자사주 매입',
   'basket': [('JPM', 'JP모건'), ('GS', '골드만삭스'), ('BAC', '뱅크오브아메리카'), ('MS', '모건스탠리')],
   'q': 'Fed rate cut OR bank earnings OR JPMorgan'},
  {'nm': '에너지', 'desk': '에너지 데스크', 'thesis': '공급 규율과 지정학 프리미엄 vs 수요 둔화의 균형',
   'basket': [('XOM', '엑슨모빌'), ('CVX', '셰브론'), ('COP', '코노코필립스'), ('SLB', 'SLB')],
   'q': 'oil price OR OPEC OR Exxon'},
 ],
}

CAVEAT = '가격(추세) 기반 상대 판단 — 밸류에이션·실적·수급 미반영. 매수/매도 신호가 아닌 비중 참고지표입니다.'


# ── 수학 헬퍼 ──
def clamp(x, lo, hi): return max(lo, min(hi, x))
def mean(a): return sum(a) / len(a)


def stdev(a):
    if len(a) < 2: return 0.0
    m = mean(a)
    return math.sqrt(sum((v - m) ** 2 for v in a) / (len(a) - 1))


def daily_rets(a): return [a[i] / a[i - 1] - 1 for i in range(1, len(a))]


def wilder_rsi(a, p=14):
    if len(a) < p + 1: return 50.0
    ag = al = 0.0
    for i in range(1, p + 1):
        d = a[i] - a[i - 1]
        if d > 0: ag += d
        else: al -= d
    ag /= p; al /= p
    for i in range(p + 1, len(a)):
        d = a[i] - a[i - 1]
        ag = (ag * (p - 1) + (d if d > 0 else 0)) / p
        al = (al * (p - 1) + (-d if d < 0 else 0)) / p
    return 100.0 if al == 0 else 100 - 100 / (1 + ag / al)


def stale_series(c):
    """최근 10봉 전부 동일(거래정지·상폐) 또는 반복봉 비율 20% 초과(데이터 품질 불량)면 제외.
       중간 구간의 짧은 동일값(야후 아티팩트)만으로 종목을 버리지 않는다."""
    k = min(10, len(c))
    if k >= 5 and all(v == c[-1] for v in c[-k:]): return True
    rep = sum(1 for i in range(1, len(c)) if c[i] == c[i - 1])
    return rep / len(c) > 0.20


# ── 수집 ──
def close_series(sym):
    try:
        u = 'https://query1.finance.yahoo.com/v8/finance/chart/%s?interval=1d&range=1y' % urllib.parse.quote(sym)
        req = urllib.request.Request(u, headers={'User-Agent': UA})
        d = json.loads(urllib.request.urlopen(req, timeout=15).read())
        raw = d['chart']['result'][0]['indicators']['quote'][0]['close']
    except Exception:
        return None
    out, miss = [], 0
    for v in raw:
        if isinstance(v, (int, float)) and v and v > 0:
            out.append(float(v)); miss = 0
        elif out and miss < 3:
            out.append(out[-1]); miss += 1
    return out or None


def _decode(s):
    s = re.sub(r'<!\[CDATA\[([\s\S]*?)\]\]>', r'\1', s or '')
    for a, b in [('&lt;', '<'), ('&gt;', '>'), ('&quot;', '"'), ('&#39;', "'"), ('&apos;', "'"), ('&amp;', '&')]:
        s = s.replace(a, b)
    return s.strip()


def _tag(block, name):
    m = re.search(r'<%s[^>]*>([\s\S]*?)</%s>' % (name, name), block)
    return m.group(1) if m else ''


def _reltime(mins):
    if mins < 1: return '방금'
    if mins < 60: return '%d분 전' % mins
    h = mins // 60
    return ('%d시간 전' % h) if h < 24 else ('%d일 전' % (h // 24))


def latest_news(q, mkt):
    try:
        loc = '&hl=en-US&gl=US&ceid=US:en' if mkt == 'us' else '&hl=ko&gl=KR&ceid=KR:ko'
        u = 'https://news.google.com/rss/search?q=' + urllib.parse.quote(q) + loc
        req = urllib.request.Request(u, headers={'User-Agent': UA})
        xml = urllib.request.urlopen(req, timeout=15).read().decode('utf-8', 'ignore')
        m = re.search(r'<item\b[\s\S]*?</item>', xml)
        if not m: return None
        item = m.group(0)
        ti = _decode(_tag(item, 'title')); link = _decode(_tag(item, 'link')); src = _decode(_tag(item, 'source'))
        if src and ti.endswith(' - ' + src):
            ti = ti[:-(len(src) + 3)].strip()
        elif not src and ' - ' in ti:
            ti, src = [x.strip() for x in ti.rsplit(' - ', 1)]
        tm = ''
        pd = _tag(item, 'pubDate')
        if pd:
            try:
                now = datetime.datetime.now(datetime.timezone.utc)
                tm = _reltime(max(0, int((now - parsedate_to_datetime(pd)).total_seconds() // 60)))
            except Exception:
                pass
        return {'ti': ti, 'link': link, 'src': src, 'tm': tm} if ti else None
    except Exception:
        return None


# ── 비중의견 엔진 ──
def _pct(x, d=1): return ('+' if x >= 0 else '') + ('%.*f%%' % (d, x * 100))


def sector_metrics(series, bench, bench_name):
    valids = [s for s in series if s and len(s) >= 120 and not stale_series(s)]
    vc = len(valids)
    if not bench or len(bench) < 25 or vc < 1: return None
    n = min([len(bench)] + [len(a) for a in valids])
    if n < 25: return None

    cols = []
    for a in valids:
        t = a[len(a) - n:]
        cols.append([v / t[0] for v in t])
    S = [mean([c[t] for c in cols]) for t in range(n)]
    bt = bench[len(bench) - n:]
    B = [v / bt[0] for v in bt]
    i = n - 1

    w = min(126, n - 1)
    r126 = S[i] / S[i - w] - 1
    rs = r126 - (B[i] / B[i - w] - 1)
    r252 = (S[i] / S[i - min(252, n - 1)] - 1) if n > 200 else None
    sub1 = clamp(r126 / 0.20, -1, 1)
    sub2 = clamp(rs / 0.15, -1, 1)
    ma50 = mean(S[n - min(50, n):])
    long_len = min(200, n); ma_long = mean(S[n - long_len:])
    short_hist = long_len < 200
    sub3 = clamp((0.5 if S[i] > ma50 else -0.5) + (0.5 if ma50 > ma_long else -0.5), -1, 1)

    above = pos = 0; rets = []; todays = []
    for a in valids:
        c = a[len(a) - n:]
        last = c[n - 1]
        if last > mean(c[n - min(50, n):]): above += 1
        ww = min(63, n - 1)
        r63 = last / c[n - 1 - ww] - 1
        rets.append(r63)
        if r63 > 0: pos += 1
        todays.append(c[n - 1] / c[n - 2] - 1)
    breadth = (above / vc + pos / vc) / 2
    sub4 = 2 * breadth - 1
    dispersion = stdev(rets) if vc > 1 else 0.0

    driver = round(100 * (0.30 * sub1 + 0.30 * sub2 + 0.25 * sub3 + 0.15 * sub4))

    ma20 = mean(S[n - min(20, n):])
    ext20 = S[i] / ma20 - 1
    p_ext = clamp((ext20 - 0.10) / 0.10, 0, 1) * 15
    volS = stdev(daily_rets(S)[-20:]) * math.sqrt(252)
    volB = stdev(daily_rets(B)[-20:]) * math.sqrt(252)
    vol_ratio = volS / max(volB, 1e-6)
    p_vol = clamp((vol_ratio - 1.5) / 1.0, 0, 1) * 10
    rsi14 = wilder_rsi(S, 14)
    p_rsi = clamp((rsi14 - 70) / 15, 0, 1) * 10
    penalty = min(p_ext + p_vol + p_rsi, 30)
    final = round(clamp(driver - penalty, -100, 100))

    sgn = 1 if driver > 0 else (-1 if driver < 0 else 1)
    agree = 0.0
    for sub, wgt in ((sub1, .30), (sub2, .30), (sub3, .25), (sub4, .15)):
        if (sub > 0 and sgn > 0) or (sub < 0 and sgn < 0): agree += wgt
    dq = min(n / 252, 1) * (vc / 4)
    conf = 100 * (0.45 * agree + 0.25 * (abs(driver) / 100) + 0.15 * breadth + 0.15 * dq)
    if n < 200: conf *= 0.85
    if n < 120: conf *= 0.6
    if n < 60: conf = min(conf, 30)
    conf = round(clamp(conf, 0, 100))

    cur_dd = S[i] / max(S[n - min(252, n):]) - 1
    return dict(n=n, validCount=vc, r126=r126, r252=r252, rs=rs, breadth=breadth, above=above, pos=pos,
                dispersion=dispersion, shortHist=short_hist, driverScore=driver, penalty=round(penalty),
                finalScore=final, conf=conf, curDD=cur_dd, ext20=ext20, volRatio=vol_ratio, rsi14=rsi14,
                perfToday=round(mean(todays) * 100, 2), benchName=bench_name)


def opine(m, risk_off):
    if not m or m['n'] < 60 or m['validCount'] < 3:
        return dict(op='op-hold', opTxt='판단보류', warns=['데이터 부족 — 판단보류'],
                    conf=min(m['conf'], 30) if m else 0)
    op, op_txt = 'op-hold', '중립'
    if m['finalScore'] >= 25 and m['rs'] > 0:
        op, op_txt = 'op-buy', '비중확대'
    elif m['finalScore'] <= -25 and m['rs'] < 0:
        op, op_txt = 'op-sell', '비중축소'

    demote = (m['ext20'] > 0.25 or m['rsi14'] > 80) or (m['curDD'] < -0.20) or risk_off or (m['conf'] < 40)
    if demote and op == 'op-buy':
        op, op_txt = 'op-hold', '중립'

    warns = []
    if m['ext20'] > 0.20 or m['rsi14'] > 75: warns.append('과열 — 분할·눌림목 대기')
    if m['curDD'] < -0.20: warns.append('하락추세 가능 — 저가매수 아님')
    if m['dispersion'] > 0.30: warns.append('특정 종목 주도 — 개별 확인 필요')
    if m['r126'] > 0 and m['rs'] <= 0: warns.append('지수 동반 상승 — 초과성과 없음')
    if m['conf'] < 40: warns.append('참고용 · 저신뢰')
    return dict(op=op, opTxt=op_txt, warns=warns, conf=m['conf'])


def bullets(m):
    rel = '지수 상회' if m['rs'] > 0.02 else ('지수 하회' if m['rs'] < -0.02 else '시장 수준')
    b1 = '최근 6개월 %s · %s 대비 %sp — %s%s' % (
        _pct(m['r126']), m['benchName'], _pct(m['rs']), rel,
        (' (12개월 %s)' % _pct(m['r252'])) if m['r252'] is not None else '')
    part = '광범위' if m['breadth'] >= 0.6 else ('제한적' if m['breadth'] <= 0.4 else '보통')
    b2 = '구성 %d종목 중 %d개 50일선 위 · %d개 3개월 상승 — 폭 %d%%%s, 참여 %s' % (
        m['validCount'], m['above'], m['pos'], round(m['breadth'] * 100),
        ' (단기 이력)' if m['shortHist'] else '', part)
    b3 = '52주 고점 대비 %s · 20일 이격 %s · 변동성 지수 대비 %.1f배 — 종합 %s%d/100 (리스크 −%d)' % (
        _pct(m['curDD']), _pct(m['ext20']), m['volRatio'],
        '+' if m['finalScore'] >= 0 else '', m['finalScore'], m['penalty'])
    return [b1, b2, b3]


def build(mkt):
    desks = DESKS[mkt]
    bsym, bname = BENCH[mkt]
    bench = close_series(bsym)
    cache = {}
    for d in desks:
        for sym, _ in d['basket']:
            if sym not in cache:
                cache[sym] = close_series(sym)

    risk_off = bool(bench and len(bench) > 21 and (bench[-1] / bench[-21] - 1) < -0.08)

    themes = []
    for d in desks:
        m = sector_metrics([cache[s] for s, _ in d['basket']], bench, bname)
        o = opine(m, risk_off)
        picks = []
        for sym, name in d['basket']:
            c = cache.get(sym)
            picks.append({'name': name, 'pct': round((c[-1] / c[-2] - 1) * 100, 2) if (c and len(c) > 1) else None})
        lead = None
        for p in picks:
            if p['pct'] is not None and (lead is None or p['pct'] > lead['pct']): lead = p
        cb = '높음' if o['conf'] >= 70 else ('보통' if o['conf'] >= 45 else '낮음')
        themes.append({
            'nm': d['nm'], 'desk': d['desk'], 'thesis': d['thesis'],
            'op': o['op'], 'opTxt': o['opTxt'], 'warns': o['warns'], 'conf': o['conf'], 'confBand': cb,
            'score': m['finalScore'] if m else None,
            'pts': bullets(m) if m else ['구성종목 시세 이력이 부족해 정량 판단을 보류합니다.',
                                         '데이터가 쌓이면 자동으로 의견이 산출됩니다.', d['thesis']],
            'perf': m['perfToday'] if m else None, 'lead': lead, 'picks': picks,
            'cat': latest_news(d['q'], mkt),
            'metrics': ({'r126': round(m['r126'], 4), 'rs': round(m['rs'], 4), 'breadth': round(m['breadth'], 3),
                         'ext20': round(m['ext20'], 4), 'rsi14': round(m['rsi14'], 1),
                         'volRatio': round(m['volRatio'], 2), 'curDD': round(m['curDD'], 4),
                         'penalty': m['penalty'], 'driver': m['driverScore']} if m else None),
        })
        print('  [%s] %-16s score=%s conf=%s' % (o['opTxt'], d['nm'],
              (m['finalScore'] if m else '—'), o['conf']))

    now_utc = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)   # 프런트 parseUTC가 Z 없는 값을 UTC로 해석
    return {'_updated': now_utc.isoformat(timespec='seconds'), 'mkt': mkt,
            'benchmark': bname, 'riskOff': risk_off, 'caveat': CAVEAT,
            'count': len(themes), 'themes': themes}


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    os.makedirs(os.path.join(here, 'data'), exist_ok=True)
    for mkt in ('kr', 'us'):
        print('== %s ==' % mkt.upper())
        data = build(mkt)
        with open(os.path.join(here, 'data', 'themes_%s.json' % mkt), 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        dist = {}
        for t in data['themes']:
            dist[t['opTxt']] = dist.get(t['opTxt'], 0) + 1
        print('themes_%s.json 저장: %d개 섹터 · riskOff=%s · %s\n' % (mkt, len(data['themes']), data['riskOff'], dist))


if __name__ == '__main__':
    main()
