# -*- coding: utf-8 -*-
"""경제지표·실적 캘린더 → data/calendar.json
   - 미국: nasdaq.com 공개 API (경제지표 actual/consensus/previous + 실적 EPS 컨센서스). 키 불필요.
   - 한국: nasdaq.com 한국 지표 행 + 아래 CURATED_KR(공개 발표일정) 보강.
   - 모든 시각은 미 동부(ET) → 한국(KST)로 변환해 KST 날짜/시각으로 그룹화.
   실행: py fetch_calendar.py
"""
import json, os, re, csv, io, datetime, urllib.request, urllib.parse
from concurrent.futures import ThreadPoolExecutor
from zoneinfo import ZoneInfo

ET = ZoneInfo('America/New_York')
KST = ZoneInfo('Asia/Seoul')
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
HDR = {'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', 'Accept-Language': 'en-US,en;q=0.9'}

# 표시 윈도: 한국 시간 기준
#  - 경제지표: 지난 결과 -3일 ~ 다가올 +7일
#  - 실적(미국·한국): 다음 분기 실적 시즌까지 +EARN_HORIZON일 (한·미 동일)
TODAY_KST = datetime.datetime.now(KST).date()
PAST_DAYS, FUTURE_DAYS = 3, 7
EARN_HORIZON = 80

# ── 경제지표 영문→한글 (주요 지표 우선; 미수록은 영문 유지) ──────────────
ECON_KO = {
    'Nonfarm Payrolls': '비농업 고용', 'Private Nonfarm Payrolls': '민간 비농업 고용',
    'Unemployment Rate': '실업률', 'Average Hourly Earnings': '시간당 평균임금',
    'Participation Rate': '경제활동참가율', 'Initial Jobless Claims': '신규 실업수당청구',
    'Continuing Jobless Claims': '연속 실업수당청구', 'Jobless Claims 4-Week Avg.': '실업수당청구 4주 평균',
    'JOLTs Job Openings': 'JOLTs 구인건수', 'ADP Nonfarm Employment Change': 'ADP 민간고용',
    'Challenger Job Cuts': '챌린저 감원', 'CPI': '소비자물가(CPI)', 'Core CPI': '근원 소비자물가',
    'CPI (YoY)': '소비자물가(전년比)', 'CPI (MoM)': '소비자물가(전월比)',
    'Core CPI (YoY)': '근원 CPI(전년比)', 'Core CPI (MoM)': '근원 CPI(전월比)',
    'PPI': '생산자물가(PPI)', 'Core PPI': '근원 생산자물가', 'PCE Price Index': 'PCE 물가',
    'Core PCE Price Index': '근원 PCE 물가', 'GDP': '국내총생산(GDP)', 'GDP (QoQ)': 'GDP(전분기比)',
    'Retail Sales': '소매판매', 'Core Retail Sales': '근원 소매판매',
    'ISM Manufacturing PMI': 'ISM 제조업 PMI', 'ISM Non-Manufacturing PMI': 'ISM 서비스업 PMI',
    'ISM Services PMI': 'ISM 서비스업 PMI', 'S&P Global Manufacturing PMI': 'S&P 제조업 PMI',
    'S&P Global Services PMI': 'S&P 서비스업 PMI', 'S&P Global Composite PMI': 'S&P 종합 PMI',
    'Durable Goods Orders': '내구재 주문', 'Factory Orders': '공장 주문',
    'Industrial Production': '산업생산', 'Building Permits': '건축허가', 'Housing Starts': '주택착공',
    'New Home Sales': '신규주택판매', 'Existing Home Sales': '기존주택판매',
    'Pending Home Sales': '잠정주택판매', 'CB Consumer Confidence': 'CB 소비자신뢰',
    'Michigan Consumer Sentiment': '미시간대 소비심리', 'Trade Balance': '무역수지',
    'Current Account': '경상수지', 'Federal Funds Rate': '기준금리 결정', 'Interest Rate Decision': '기준금리 결정',
    'Fed Interest Rate Decision': '연준 기준금리 결정', 'FOMC Economic Projections': 'FOMC 경제전망',
    'FOMC Statement': 'FOMC 성명', 'FOMC Meeting Minutes': 'FOMC 의사록',
    'Nonfarm Productivity': '비농업 생산성', 'Unit Labor Costs': '단위노동비용',
    'Natural Gas Storage': '천연가스 재고', 'Crude Oil Inventories': '원유 재고',
    'Consumer Credit': '소비자신용', 'Wholesale Inventories': '도매 재고', 'Business Inventories': '기업 재고',
    'Chicago PMI': '시카고 PMI', 'Philadelphia Fed Manufacturing Index': '필라델피아 연은 제조업',
    'NY Empire State Manufacturing Index': '뉴욕 엠파이어스테이트 제조업',
    'Personal Income': '개인소득', 'Personal Spending': '개인소비', 'Consumer Spending': '개인소비',
    # 한국 지표
    'Exports': '수출(전년比)', 'Imports': '수입(전년比)', 'FX Reserves - USD': '외환보유액',
    'South Korea - Election Day': '전국동시지방선거', 'Election Day': '선거일',
    'S&P Global South Korea Manufacturing PMI': '한국 제조업 PMI(S&P)',
    'S&P Global Manufacturing PMI': '제조업 PMI(S&P)', 'Manufacturing PMI': '제조업 PMI',
    'U6 Unemployment Rate': 'U6 실업률(광의)', 'BoK Interest Rate Decision': '한국은행 기준금리 결정',
    'Business Confidence': '기업경기실사지수(BSI)', 'Construction Output': '건설기성',
    'Thomson Reuters IPSOS PCSI': '소비자심리지수(IPSOS)',
    'PPI ex. Food/Energy/Transport': '생산자물가(식품·에너지·운송 제외)',
    'Factory orders ex transportation': '공장 주문(운송 제외)',
}
# 같은 일시에 두 번 발표되는 헤드라인 지표 → 전년比/전월比 구분
PERIOD_PAIR = {'소비자물가(CPI)', '근원 소비자물가', '생산자물가(PPI)', '근원 생산자물가',
               '소매판매', '근원 소매판매', '국내총생산(GDP)'}

# ── 미국 실적: S&P500 구성종목만 표시 ──────────────────────────────────
SP500_FALLBACK = ("A AAPL ABBV ABNB ABT ACGL ACN ADBE ADI ADM ADP ADSK AEE AEP AES AFL AIG AIZ AJG AKAM ALB "
    "ALGN ALL ALLE AMAT AMCR AMD AME AMGN AMP AMT AMZN ANET AON AOS APA APD APH APO APP APTV ARE ARES ATO AVB "
    "AVGO AVY AWK AXON AXP AZO BA BAC BALL BAX BBY BDX BEN BF.B BG BIIB BKNG BKR BLDR BLK BMY BNY BR BRK.B BRO "
    "BSX BX BXP C CAG CAH CARR CASY CAT CB CBOE CBRE CCI CCL CDNS CDW CEG CF CFG CHD CHRW CHTR CI CIEN CINF CL "
    "CLX CMCSA CME CMG CMI CMS CNC CNP COF COHR COIN COO COP COR COST CPAY CPB CPRT CPT CRH CRL CRM CRWD CSCO "
    "CSGP CSX CTAS CTSH CTVA CVNA CVS CVX D DAL DASH DD DDOG DE DECK DELL DG DGX DHI DHR DIS DLR DLTR DOC DOV "
    "DOW DPZ DRI DTE DUK DVA DVN DXCM EA EBAY ECL ED EFX EG EIX EL ELV EME EMR EOG EQIX EQR EQT ERIE ES ESS ETN "
    "ETR EVRG EW EXC EXE EXPD EXPE EXR F FANG FAST FCX FDS FDX FE FFIV FICO FIS FISV FITB FIX FOX FOXA FRT FSLR "
    "FTNT FTV GD GDDY GE GEHC GEN GEV GILD GIS GL GLW GM GNRC GOOG GOOGL GPC GPN GRMN GS GWW HAL HAS HBAN HCA HD "
    "HIG HII HLT HON HOOD HPE HPQ HRL HSIC HST HSY HUBB HUM HWM IBKR IBM ICE IDXX IEX IFF INCY INTC INTU INVH IP "
    "IQV IR IRM ISRG IT ITW IVZ J JBHT JBL JCI JKHY JNJ JPM KDP KEY KEYS KHC KIM KKR KLAC KMB KMI KO KR KVUE L "
    "LDOS LEN LH LHX LII LIN LITE LLY LMT LNT LOW LRCX LULU LUV LVS LYB LYV MA MAA MAR MAS MCD MCHP MCK MCO MDLZ "
    "MDT MET META MGM MKC MLM MMM MNST MO MOS MPC MPWR MRK MRNA MRSH MS MSCI MSFT MSI MTB MTD MU NCLH NDAQ NDSN "
    "NEE NEM NFLX NI NKE NOC NOW NRG NSC NTAP NTRS NUE NVDA NVR NWS NWSA NXPI O ODFL OKE OMC ON ORCL ORLY OTIS "
    "OXY PANW PAYX PCAR PCG PEG PEP PFE PFG PG PGR PH PHM PKG PLD PLTR PM PNC PNR PNW PODD POOL PPG PPL PRU PSA "
    "PSKY PSX PTC PWR PYPL QCOM RCL REG REGN RF RJF RL RMD ROK ROL ROP ROST RSG RTX RVTY SBAC SBUX SCHW SHW SJM "
    "SLB SMCI SNA SNPS SO SOLV SPG SPGI SRE STE STLD STT STX STZ SW SWK SWKS SYF SYK SYY T TAP TDG TDY TECH TEL "
    "TER TFC TGT TJX TKO TMO TMUS TPL TPR TRGP TRMB TROW TRV TSCO TSLA TSN TT TTD TTWO TXN TXT TYL UAL UBER UDR "
    "UHS ULTA UNH UNP UPS URI USB V VEEV VICI VLO VLTO VMC VRSK VRSN VRT VRTX VST VTR VTRS VZ WAB WAT WBD WDAY "
    "WDC WEC WELL WFC WM WMB WMT WRB WSM WST WTW WY WYNN XEL XOM XYL XYZ YUM ZBH ZBRA ZTS").split()


def load_sp500():
    """S&P500 구성종목 set — datahub CSV(최신) 우선, 실패 시 내장 폴백."""
    try:
        req = urllib.request.Request(
            'https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv', headers=HDR)
        txt = urllib.request.urlopen(req, timeout=15).read().decode('utf-8')
        s = set(r['Symbol'].strip() for r in csv.DictReader(io.StringIO(txt)) if r.get('Symbol'))
        if len(s) > 400:
            return s
    except Exception:
        pass
    return set(SP500_FALLBACK)


# 나스닥100(최신은 nasdaq.com API) + 다우30(고정·전원 S&P500 포함)
NDX_FALLBACK = ("AAPL ABNB ADBE ADI ADP ADSK AEP ALNY AMAT AMD AMGN AMZN APP ARM ASML AVGO AXON BKNG BKR CCEP "
    "CDNS CEG CHTR CMCSA COST CPRT CRWD CSCO CSX CTAS CTSH DASH DDOG DXCM EA EXC FANG FAST FER FTNT GEHC GILD "
    "GOOG GOOGL HON IDXX INSM INTC INTU ISRG KDP KHC KLAC LIN LITE LRCX MAR MCHP MDLZ MELI META MNST MPWR MRVL "
    "MSFT MSTR MU NFLX NVDA NXPI ODFL ORLY PANW PAYX PCAR PDD PEP PLTR PYPL QCOM REGN ROP ROST SBUX SHOP SNDK "
    "SNPS STX TMUS TRI TSLA TTWO TXN VRSK VRTX WBD WDAY WDC WMT XEL ZS").split()
DOW = ("AAPL AMGN AMZN AXP BA CAT CRM CSCO CVX DIS GS HD HON IBM JNJ JPM KO MCD MMM MRK "
       "MSFT NKE NVDA PG SHW TRV UNH V VZ WMT").split()


def load_ndx():
    """나스닥100 구성종목 set — nasdaq.com 지수 API 우선, 실패 시 내장 폴백."""
    try:
        j = get_json('https://api.nasdaq.com/api/quote/list-type/nasdaq100')
        rows = (((j.get('data') or {}).get('data') or {}).get('rows')) or (j.get('data') or {}).get('rows') or []
        s = set((r.get('symbol') or '').strip() for r in rows if r.get('symbol'))
        if len(s) > 80:
            return s
    except Exception:
        pass
    return set(NDX_FALLBACK)


def us_index_of(sym, sp, ndx, dow):
    """종목이 속한 대표 지수 라벨."""
    base = sym.replace('/', '.')
    if sym in sp or base in sp:
        return 'S&P500'
    if sym in ndx:
        return 'NASDAQ100'
    if sym in dow:
        return 'DOW'
    return ''


# ── 한국 실적: KOSPI/KOSDAQ 주요 종목 (yfinance 다음 발표일 + 컨센서스 EPS) ──
# (yfinance 심볼, 표시명, 시장, 중요도)
KR_EARN_UNIV = [
    ('005930.KS', '삼성전자', 'KOSPI', 3), ('000660.KS', 'SK하이닉스', 'KOSPI', 3),
    ('373220.KS', 'LG에너지솔루션', 'KOSPI', 3), ('207940.KS', '삼성바이오로직스', 'KOSPI', 3),
    ('005380.KS', '현대차', 'KOSPI', 3), ('000270.KS', '기아', 'KOSPI', 2),
    ('068270.KS', '셀트리온', 'KOSPI', 2), ('035420.KS', 'NAVER', 'KOSPI', 2),
    ('035720.KS', '카카오', 'KOSPI', 2), ('005490.KS', 'POSCO홀딩스', 'KOSPI', 2),
    ('051910.KS', 'LG화학', 'KOSPI', 2), ('006400.KS', '삼성SDI', 'KOSPI', 2),
    ('012330.KS', '현대모비스', 'KOSPI', 2), ('105560.KS', 'KB금융', 'KOSPI', 2),
    ('055550.KS', '신한지주', 'KOSPI', 2), ('012450.KS', '한화에어로스페이스', 'KOSPI', 2),
    ('034020.KS', '두산에너빌리티', 'KOSPI', 2), ('066570.KS', 'LG전자', 'KOSPI', 2),
    ('009150.KS', '삼성전기', 'KOSPI', 2), ('042700.KS', '한미반도체', 'KOSPI', 2),
    ('259960.KS', '크래프톤', 'KOSPI', 2), ('010130.KS', '고려아연', 'KOSPI', 2),
    ('329180.KS', 'HD현대중공업', 'KOSPI', 2), ('011200.KS', 'HMM', 'KOSPI', 2),
    ('247540.KQ', '에코프로비엠', 'KOSDAQ', 2), ('086520.KQ', '에코프로', 'KOSDAQ', 2),
    ('196170.KQ', '알테오젠', 'KOSDAQ', 2), ('348370.KQ', '엔켐', 'KOSDAQ', 2),
    ('058470.KQ', '리노공업', 'KOSDAQ', 2), ('263750.KQ', '펄어비스', 'KOSDAQ', 2),
    ('141080.KQ', '리가켐바이오', 'KOSDAQ', 2), ('214150.KQ', '클래시스', 'KOSDAQ', 2),
]


def fmt_krw(v):
    """KRW EPS(예: 10955.64) → '10,956원'. NaN/None → ''."""
    try:
        if v is None:
            return ''
        f = float(v)
        if f != f:   # NaN
            return ''
        return '{:,.0f}원'.format(round(f))
    except Exception:
        return ''
SPEAK_KO = {'Powell': '파월', 'Bowman': '보먼', 'Barkin': '바킨', 'Williams': '윌리엄스',
            'Waller': '월러', 'Jefferson': '제퍼슨', 'Cook': '쿡', 'Goolsbee': '굴스비',
            'Logan': '로건', 'Daly': '데일리', 'Kashkari': '카시카리', 'Bostic': '보스틱',
            'Collins': '콜린스', 'Musalem': '무살렘', 'Schmid': '슈미드', 'Hammack': '해맥'}

# 3성(최우선) / 2성(주요) 지표 키워드
HI3 = ['Nonfarm Payroll', 'Unemployment Rate', 'CPI', 'Core PCE', 'PCE Price', 'GDP',
       'Interest Rate Decision', 'Federal Funds', 'FOMC Economic', 'FOMC Statement',
       'ISM Manufacturing', 'ISM Non-Manufacturing', 'ISM Services', 'Retail Sales', 'PPI']
HI2 = ['Jobless Claims', 'ADP', 'JOLTs', 'PMI', 'Durable Goods', 'Factory Orders',
       'Industrial Production', 'Consumer Confidence', 'Consumer Sentiment', 'Building Permits',
       'Housing Starts', 'Home Sales', 'Trade Balance', 'Current Account', 'Personal Income',
       'Personal Spending', 'Philadelphia Fed', 'Empire State', 'Chicago PMI', 'Productivity',
       'Unit Labor', 'FOMC Meeting Minutes', 'Challenger']

# 실적: 주요 미국 종목 티커 → 한글명 (없으면 영문 표기)
TICKER_KO = {
    'NVDA': '엔비디아', 'AAPL': '애플', 'MSFT': '마이크로소프트', 'AMZN': '아마존', 'GOOGL': '알파벳',
    'GOOG': '알파벳', 'META': '메타', 'TSLA': '테슬라', 'AVGO': '브로드컴', 'AMD': 'AMD',
    'MU': '마이크론', 'INTC': '인텔', 'QCOM': '퀄컴', 'ORCL': '오라클', 'ADBE': '어도비',
    'CRM': '세일즈포스', 'NFLX': '넷플릭스', 'PLTR': '팔란티어', 'SMCI': '슈퍼마이크로',
    'DELL': '델', 'TSM': 'TSMC', 'ASML': 'ASML', 'COST': '코스트코', 'WMT': '월마트',
    'NKE': '나이키', 'LULU': '룰루레몬', 'DRI': '다든레스토랑', 'FDX': '페덱스', 'KR': '크로거',
    'GIS': '제너럴밀스', 'MKC': '맥코믹', 'JPM': 'JP모건', 'BAC': '뱅크오브아메리카',
    'GS': '골드만삭스', 'MS': '모건스탠리', 'LEN': '레나', 'KBH': 'KB홈',
}


# 미국 경제지표 잡음(중복 하위지표·나우캐스트) 제거용
NOISE_US = re.compile(r'Index, ?n\.s\.a|Index, ?s\.a|, n\.s\.a|CPI Index|Core CPI Index|'
                      r'4-Week Avg|Real Earnings|Redbook|MBA |API ', re.I)
ISM_SUB = re.compile(r'ISM .*(Employment|New Orders|Prices|Business Activity|Backlog|'
                     r'Inventories|Supplier|Imports|Exports|Production|New Export)', re.I)
NOWCAST = re.compile(r'GDPNow|Cleveland CPI|Nowcast|GDPNowcast', re.I)
HHMM = re.compile(r'(\d{1,2}):(\d{2})')


def get_json(url, timeout=22):
    req = urllib.request.Request(url, headers=HDR)
    return json.loads(urllib.request.urlopen(req, timeout=timeout).read())


def clean(v):
    if v is None:
        return ''
    s = re.sub(r'&nbsp;|\xa0', '', str(v)).strip()
    return '' if s in ('', '-', 'N/A') else s


def importance(name):
    for k in HI3:
        if k.lower() in name.lower():
            return 3
    for k in HI2:
        if k.lower() in name.lower():
            return 2
    return 1


def econ_title(name):
    if name in ECON_KO:
        return ECON_KO[name]
    m = re.search(r'(?:Member |Gov |Governor |President )?([A-Z][a-z]+) Speaks', name)
    if 'Speaks' in name:
        for en, ko in SPEAK_KO.items():
            if en in name:
                return '연준 %s 연설' % ko
        return name.replace(' Speaks', ' 연설')
    # 부분 매칭
    for en, ko in ECON_KO.items():
        if en.lower() in name.lower():
            return ko
    return name


def et_to_kst(date_str, et_hhmm):
    """미 동부 (date, 'HH:MM') → KST datetime. 시각 미상이면 09:00 ET 가정."""
    try:
        y, m, d = [int(x) for x in date_str.split('-')]
    except Exception:
        return None
    hh, mm = 9, 0
    t = clean(et_hhmm)
    mt = re.match(r'(\d{1,2}):(\d{2})', t)
    if mt:
        hh, mm = int(mt.group(1)), int(mt.group(2))
    dt_et = datetime.datetime(y, m, d, hh, mm, tzinfo=ET)
    return dt_et.astimezone(KST)


def in_window(dkst):
    lo = TODAY_KST - datetime.timedelta(days=PAST_DAYS)
    hi = TODAY_KST + datetime.timedelta(days=FUTURE_DAYS)
    return lo <= dkst <= hi


# ── 미국 경제지표 + 한국 경제지표(나스닥) ───────────────────────────────
# 나스닥 경제캘린더 quirk: economicevents?date=D 는 '실제 ET 발표일 + 1'에 해당.
# (검증: ISM→6/1월, ADP→6/3수, 신규실업청구→목, 비농업→6/5금, CPI→6/10수 모두 일치)
# → ET 발표일 = ds - 1 로 보정 후 KST 변환. (실적 endpoint 은 보정 불필요)
def fetch_econ(events):
    seen = set()
    for off in range(-PAST_DAYS, FUTURE_DAYS + 2):
        d = TODAY_KST + datetime.timedelta(days=off)
        ds = d.isoformat()
        try:
            j = get_json('https://api.nasdaq.com/api/calendar/economicevents?date=%s' % ds)
        except Exception as e:
            print('  [econ %s] %s' % (ds, str(e)[:50]))
            continue
        et_date = (d - datetime.timedelta(days=1)).isoformat()   # ET 실제 발표일 보정
        for r in (((j.get('data') or {}).get('rows')) or []):
            country = (r.get('country') or '').strip()
            if country == 'United States':
                mk = 'us'
            elif country == 'South Korea':
                mk = 'kr'
            else:
                continue
            name = clean(r.get('eventName'))
            if not name:
                continue
            # 미국: 중복 하위지표·나우캐스트·군소 1성 연설 제외(한국은 행이 적어 모두 유지)
            if mk == 'us' and (NOISE_US.search(name) or ISM_SUB.search(name) or NOWCAST.search(name)):
                continue
            imp = importance(name)
            is_speak = 'Speaks' in name
            if mk == 'us' and imp == 1 and not (is_speak and 'Powell' in name):
                continue
            kst = et_to_kst(et_date, r.get('gmt'))
            if not kst:
                continue
            has_time = bool(HHMM.search(clean(r.get('gmt'))))
            ev_date = kst.date().isoformat()
            ev_time = kst.strftime('%H:%M') if has_time else ''
            try:
                if not in_window(datetime.date.fromisoformat(ev_date)):
                    continue
            except Exception:
                continue
            title = econ_title(name)
            key = (mk, ev_date, ev_time, title, clean(r.get('consensus')), clean(r.get('previous')))
            if key in seen:
                continue
            seen.add(key)
            events.append({
                'date': ev_date, 'time': ev_time, 'et': clean(r.get('gmt')), 'mk': mk, 'type': 'econ',
                'title': title, 'title_en': name,
                'importance': 3 if (is_speak and 'Powell' in name) else imp,
                'forecast': clean(r.get('consensus')), 'previous': clean(r.get('previous')),
                'actual': clean(r.get('actual')), 'category': '연설' if is_speak else '지표',
            })


# ── 미국 실적 (시총 상위만) ─────────────────────────────────────────────
def parse_cap(s):
    s = re.sub(r'[^0-9.]', '', str(s or ''))
    try:
        return float(s)
    except Exception:
        return 0.0


def cap_str(n):
    if n >= 1e12:
        return '$%.2fT' % (n / 1e12)
    if n >= 1e9:
        return '$%.0fB' % (n / 1e9)
    if n >= 1e6:
        return '$%.0fM' % (n / 1e6)
    return ''


def fetch_earnings(events):
    """미국 실적 — S&P500 ∪ 나스닥100 ∪ 다우 구성종목, 다음 분기 시즌까지(+EARN_HORIZON일)."""
    SESS = {'time-pre-market': '장 시작 전', 'time-after-hours': '장 마감 후', 'time-not-supplied': '시간 미정'}
    sp, ndx, dow = load_sp500(), load_ndx(), set(DOW)
    universe = sp | ndx | dow
    print('  지수 구성종목 S&P500 %d · 나스닥100 %d · 다우 %d → 합집합 %d개 기준 필터'
          % (len(sp), len(ndx), len(dow), len(universe)))

    dates = [(off, (TODAY_KST + datetime.timedelta(days=off)).isoformat()) for off in range(0, EARN_HORIZON + 1)]

    def fetch_day(item):
        off, ds = item
        try:
            return off, ds, get_json('https://api.nasdaq.com/api/calendar/earnings?date=%s' % ds)
        except Exception:
            return off, ds, None

    with ThreadPoolExecutor(max_workers=10) as ex:
        results = list(ex.map(fetch_day, dates))

    for off, ds, j in sorted(results, key=lambda x: x[0]):
        if not j:
            continue
        rows = (((j.get('data') or {}).get('rows')) or [])
        big = []
        for r in rows:
            sym = clean(r.get('symbol'))
            if not sym or (sym not in universe and sym.replace('/', '.') not in universe):
                continue
            big.append((parse_cap(r.get('marketCap')), r))
        big.sort(key=lambda x: -x[0])
        # 근시일(±10일)은 폭넓게, 그 이후 먼 일정은 대형주 위주로
        picked = big[:12] if off <= 10 else [(c, r) for c, r in big if c >= 25e9][:10]
        for cap, r in picked:
            sym = clean(r.get('symbol'))
            events.append({
                'date': ds, 'time': '', 'mk': 'us', 'type': 'earnings', 'index': us_index_of(sym, sp, ndx, dow),
                'title': TICKER_KO.get(sym, clean(r.get('name')).replace(', Inc.', '').replace(' Inc.', '')
                                       .replace(', Incorporated', '').replace(' Corporation', '').strip()),
                'ticker': sym, 'session': SESS.get(clean(r.get('time')), '시간 미정'),
                'eps_est': clean(r.get('epsForecast')), 'eps_prev': clean(r.get('lastYearEPS')),
                'n_ests': clean(r.get('noOfEsts')), 'mktcap': cap_str(cap),
                'importance': 3 if cap >= 1e11 else 2,
            })


def fetch_kr_earnings(events):
    """한국 실적 — KOSPI/KOSDAQ 주요 종목의 다음 실적 발표일 + 컨센서스 EPS (yfinance)."""
    try:
        import logging
        logging.getLogger('yfinance').setLevel(logging.CRITICAL)   # "delisted" 등 noise 억제
        import yfinance as yf
        import pandas as pd
    except Exception as e:
        print('  [kr-earn] yfinance/pandas 미설치 — 건너뜀 (%s)' % str(e)[:40])
        return
    n = 0
    for sym, nm, mkt, imp in KR_EARN_UNIV:
        try:
            ed = yf.Ticker(sym).get_earnings_dates(limit=16)
            if ed is None or ed.empty:
                continue
            rows = sorted([(d, row.get('EPS Estimate'), row.get('Reported EPS')) for d, row in ed.iterrows()],
                          key=lambda x: x[0])
            tz = rows[0][0].tz
            now = pd.Timestamp.now(tz=tz)
            future = [r for r in rows if r[0] >= now]
            if not future:
                continue
            nxt = future[0]
            dd = nxt[0].date()
            if not (TODAY_KST <= dd <= TODAY_KST + datetime.timedelta(days=EARN_HORIZON)):
                continue
            # 전년 동기 보고 EPS(다음 발표일 −1년에 가장 가까운 과거 실적)
            target = nxt[0] - pd.Timedelta(days=365)
            past = [r for r in rows if r[0] < now and r[2] == r[2]]   # Reported EPS not NaN
            prev = min(past, key=lambda r: abs((r[0] - target).days))[2] if past else None
            events.append({
                'date': dd.isoformat(), 'time': '', 'et': '', 'mk': 'kr', 'type': 'earnings',
                'title': nm, 'ticker': sym, 'market': mkt, 'index': mkt, 'session': '',
                'eps_est': fmt_krw(nxt[1]), 'eps_prev': fmt_krw(prev), 'mktcap': '', 'n_ests': '',
                'importance': imp,
            })
            n += 1
        except Exception as e:
            print('  [kr-earn %s] %s' % (sym, str(e)[:40]))
            continue
    print('  한국 실적 %d건 (KOSPI/KOSDAQ, 다음 %d일)' % (n, EARN_HORIZON))


# ── 한국 보강(공개 발표일정) ── 날짜는 발표예정일, 수치는 직전/예상(확인된 범위) ──
# fetch_calendar 실행 시점 윈도 안에 드는 항목만 반영됨.
CURATED_KR = [
    # 예: {'date':'2026-06-11','time':'08:00','type':'econ','title':'5월 고용동향',
    #      'title_en':'Employment','importance':3,'forecast':'','previous':'','actual':'','category':'고용','agency':'통계청'},
]


def add_curated_kr(events):
    seen = {(e['mk'], e['type'], e.get('title_en') or e['title'], e['date']) for e in events}
    for c in CURATED_KR:
        try:
            dkst = datetime.date.fromisoformat(c['date'])
        except Exception:
            continue
        if not in_window(dkst):
            continue
        key = ('kr', c.get('type', 'econ'), c.get('title_en') or c['title'], c['date'])
        if key in seen:
            continue
        e = {'date': c['date'], 'time': c.get('time', ''), 'et': '', 'mk': 'kr',
             'type': c.get('type', 'econ'), 'title': c['title'], 'title_en': c.get('title_en', ''),
             'importance': c.get('importance', 2), 'forecast': c.get('forecast', ''),
             'previous': c.get('previous', ''), 'actual': c.get('actual', ''),
             'category': c.get('category', '지표'), 'agency': c.get('agency', '')}
        if c.get('type') == 'earnings':
            e.update({'ticker': c.get('ticker', ''), 'session': c.get('session', ''),
                      'eps_est': c.get('eps_est', ''), 'eps_prev': c.get('eps_prev', ''), 'mktcap': c.get('mktcap', '')})
        events.append(e)


def _mag(s):
    m = re.search(r'-?\d+(?:\.\d+)?', re.sub(r',', '', str(s or '')))
    return abs(float(m.group())) if m else None


def disambiguate_period(events):
    """같은 (제목·날짜·시각)으로 2건이면 값 크기로 전년比/전월比(또는 전기比) 라벨."""
    from collections import defaultdict
    g = defaultdict(list)
    for e in events:
        if e['type'] == 'econ' and e['title'] in PERIOD_PAIR:
            g[(e['title'], e['date'], e['time'])].append(e)
    for (title, _, _), rows in g.items():
        if len(rows) != 2:
            continue
        vals = [_mag(r['forecast'] or r['previous']) for r in rows]
        if None in vals or vals[0] == vals[1]:
            continue
        yoy = '(전년比)'
        mom = '(전기比)' if '국내총생산' in title else '(전월比)'
        hi = 0 if vals[0] > vals[1] else 1
        rows[hi]['title'] = title + ' ' + yoy
        rows[1 - hi]['title'] = title + ' ' + mom


def preserve_kr_earnings(events):
    """한국 실적이 새로 0건(예: 클라우드 IP에서 야후 차단)이면 직전 calendar.json의
       미래 한국 실적을 보존해 데이터가 사라지지 않게 한다. (티커 기준 신규 우선)"""
    here = os.path.dirname(os.path.abspath(__file__))
    fresh_tickers = {e.get('ticker') for e in events if e.get('mk') == 'kr' and e.get('type') == 'earnings'}
    lo = TODAY_KST.isoformat()
    hi = (TODAY_KST + datetime.timedelta(days=EARN_HORIZON)).isoformat()
    kept = 0
    try:
        prev = json.load(open(os.path.join(here, 'data', 'calendar.json'), encoding='utf-8'))
        for e in (prev.get('events') or []):
            if (e.get('mk') == 'kr' and e.get('type') == 'earnings'
                    and e.get('ticker') not in fresh_tickers
                    and lo <= (e.get('date') or '') <= hi):
                events.append(e)
                fresh_tickers.add(e.get('ticker'))
                kept += 1
    except Exception:
        return
    if kept:
        print('  [kr-earn] 신규 수집 부족 → 직전 스냅샷에서 한국 실적 %d건 보존' % kept)


def main():
    events = []
    print('경제지표 수집(US/KR, nasdaq)…')
    fetch_econ(events)
    print('실적 수집(US S&P500, nasdaq)…')
    fetch_earnings(events)
    print('실적 수집(KR KOSPI/KOSDAQ, yfinance)…')
    fetch_kr_earnings(events)
    add_curated_kr(events)
    preserve_kr_earnings(events)   # 야후 차단 등으로 0건이면 직전 스냅샷 보존
    disambiguate_period(events)

    # 정렬: 날짜 → 시각 → 중요도
    def sk(e):
        return (e['date'], e.get('time') or '99:99', -e.get('importance', 0))
    events.sort(key=sk)

    lo = (TODAY_KST - datetime.timedelta(days=PAST_DAYS)).isoformat()
    hi = (TODAY_KST + datetime.timedelta(days=FUTURE_DAYS)).isoformat()
    data = {'_updated': datetime.datetime.now().isoformat(timespec='seconds'),
            'today': TODAY_KST.isoformat(), 'window': {'from': lo, 'to': hi},
            'count': len(events), 'events': events}
    here = os.path.dirname(os.path.abspath(__file__))
    os.makedirs(os.path.join(here, 'data'), exist_ok=True)
    with open(os.path.join(here, 'data', 'calendar.json'), 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    ne = sum(e['type'] == 'econ' for e in events)
    nr = sum(e['type'] == 'earnings' for e in events)
    nk = sum(e['mk'] == 'kr' for e in events)
    print('calendar.json 저장: %d건 (지표 %d / 실적 %d · 한국 %d / 미국 %d)' % (
        len(events), ne, nr, nk, len(events) - nk))


if __name__ == '__main__':
    main()
