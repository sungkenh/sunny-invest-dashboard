// 경제지표·실적 캘린더 — /api/calendar  (nasdaq.com 공개 API, 키 불필요)
// 미국: 지표 예상/이전/실제 + 실적 EPS 컨센서스 · 한국: nasdaq 한국 지표 행
// 방문 시점 수집. 모듈 캐시(30분) + 엣지 캐시. 모든 시각 ET→KST 변환.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const HDR = { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', 'Accept-Language': 'en-US,en;q=0.9' };
// 서버리스는 '근시일 신선도'(갓 발표된 실제값) 패치 담당. 넓은 ±30 윈도·분석 기사·원거리 실적은
// 스냅샷(data/calendar.json, fetch_calendar.py 6h)이 제공하며 프런트가 둘을 병합한다.
const PAST = 7, FUT = 10;
let CACHE = { ts: 0, data: null };
const TTL = 30 * 60 * 1000;

const ECON_KO = {
  'Nonfarm Payrolls': '비농업 고용', 'Private Nonfarm Payrolls': '민간 비농업 고용',
  'Unemployment Rate': '실업률', 'U6 Unemployment Rate': 'U6 실업률(광의)', 'Average Hourly Earnings': '시간당 평균임금',
  'Participation Rate': '경제활동참가율', 'Initial Jobless Claims': '신규 실업수당청구',
  'Continuing Jobless Claims': '연속 실업수당청구', 'JOLTS Job Openings': 'JOLTs 구인건수',
  'JOLTs Job Openings': 'JOLTs 구인건수', 'ADP Nonfarm Employment Change': 'ADP 민간고용',
  'Challenger Job Cuts': '챌린저 감원', 'CPI': '소비자물가(CPI)', 'Core CPI': '근원 소비자물가',
  'PPI': '생산자물가(PPI)', 'Core PPI': '근원 생산자물가', 'PCE Price Index': 'PCE 물가',
  'Core PCE Price Index': '근원 PCE 물가', 'GDP': '국내총생산(GDP)', 'Retail Sales': '소매판매',
  'Core Retail Sales': '근원 소매판매', 'ISM Manufacturing PMI': 'ISM 제조업 PMI',
  'ISM Non-Manufacturing PMI': 'ISM 서비스업 PMI', 'ISM Services PMI': 'ISM 서비스업 PMI',
  'S&P Global Manufacturing PMI': '제조업 PMI(S&P)', 'S&P Global Services PMI': 'S&P 서비스업 PMI',
  'S&P Global Composite PMI': 'S&P 종합 PMI', 'Durable Goods Orders': '내구재 주문', 'Factory Orders': '공장 주문',
  'Factory orders ex transportation': '공장 주문(운송 제외)', 'Industrial Production': '산업생산',
  'Building Permits': '건축허가', 'Housing Starts': '주택착공', 'New Home Sales': '신규주택판매',
  'Existing Home Sales': '기존주택판매', 'Pending Home Sales': '잠정주택판매', 'CB Consumer Confidence': 'CB 소비자신뢰',
  'Michigan Consumer Sentiment': '미시간대 소비심리', 'Trade Balance': '무역수지', 'Current Account': '경상수지',
  'Federal Funds Rate': '기준금리 결정', 'Interest Rate Decision': '기준금리 결정',
  'Fed Interest Rate Decision': '연준 기준금리 결정', 'FOMC Economic Projections': 'FOMC 경제전망',
  'FOMC Statement': 'FOMC 성명', 'FOMC Meeting Minutes': 'FOMC 의사록', 'Nonfarm Productivity': '비농업 생산성',
  'Unit Labor Costs': '단위노동비용', 'Natural Gas Storage': '천연가스 재고', 'Crude Oil Inventories': '원유 재고',
  'Consumer Credit': '소비자신용', 'Wholesale Inventories': '도매 재고', 'Business Inventories': '기업 재고',
  'Chicago PMI': '시카고 PMI', 'Philadelphia Fed Manufacturing Index': '필라델피아 연은 제조업',
  'NY Empire State Manufacturing Index': '뉴욕 엠파이어스테이트 제조업', 'Personal Income': '개인소득',
  'Personal Spending': '개인소비', 'Exports': '수출(전년比)', 'Imports': '수입(전년比)', 'FX Reserves - USD': '외환보유액',
  'South Korea - Election Day': '전국동시지방선거', 'Election Day': '선거일',
  'S&P Global South Korea Manufacturing PMI': '한국 제조업 PMI(S&P)', 'Manufacturing PMI': '제조업 PMI',
  'BoK Interest Rate Decision': '한국은행 기준금리 결정', 'Business Confidence': '기업경기실사지수(BSI)',
  'Thomson Reuters IPSOS PCSI': '소비자심리지수(IPSOS)', 'PPI ex. Food/Energy/Transport': '생산자물가(식품·에너지·운송 제외)',
};
const SPEAK_KO = { Powell: '파월', Bowman: '보먼', Barkin: '바킨', Williams: '윌리엄스', Waller: '월러',
  Jefferson: '제퍼슨', Cook: '쿡', Goolsbee: '굴스비', Logan: '로건', Daly: '데일리', Kashkari: '카시카리',
  Bostic: '보스틱', Collins: '콜린스', Musalem: '무살렘', Schmid: '슈미드', Hammack: '해맥' };
const TICKER_KO = { NVDA: '엔비디아', AAPL: '애플', MSFT: '마이크로소프트', AMZN: '아마존', GOOGL: '알파벳',
  GOOG: '알파벳', META: '메타', TSLA: '테슬라', AVGO: '브로드컴', AMD: 'AMD', MU: '마이크론', INTC: '인텔',
  QCOM: '퀄컴', ORCL: '오라클', ADBE: '어도비', CRM: '세일즈포스', NFLX: '넷플릭스', PLTR: '팔란티어',
  SMCI: '슈퍼마이크로', DELL: '델', TSM: 'TSMC', ASML: 'ASML', COST: '코스트코', WMT: '월마트', NKE: '나이키',
  LULU: '룰루레몬', DRI: '다든레스토랑', FDX: '페덱스', KR: '크로거', GIS: '제너럴밀스', MKC: '맥코믹',
  JPM: 'JP모건', BAC: '뱅크오브아메리카', GS: '골드만삭스', MS: '모건스탠리', LEN: '레나', KBH: 'KB홈', RH: 'RH' };
const HI3 = ['Nonfarm Payroll', 'Unemployment Rate', 'CPI', 'Core PCE', 'PCE Price', 'GDP', 'Interest Rate Decision',
  'Federal Funds', 'FOMC Economic', 'FOMC Statement', 'ISM Manufacturing', 'ISM Non-Manufacturing', 'ISM Services',
  'Retail Sales', 'PPI'];
const HI2 = ['Jobless Claims', 'ADP', 'JOLTs', 'PMI', 'Durable Goods', 'Factory Orders', 'Industrial Production',
  'Consumer Confidence', 'Consumer Sentiment', 'Building Permits', 'Housing Starts', 'Home Sales', 'Trade Balance',
  'Current Account', 'Personal Income', 'Personal Spending', 'Philadelphia Fed', 'Empire State', 'Chicago PMI',
  'Productivity', 'Unit Labor', 'FOMC Meeting Minutes', 'Challenger'];
const NOISE_US = /Index, ?n\.s\.a|Index, ?s\.a|, n\.s\.a|CPI Index|Core CPI Index|4-Week Avg|Real Earnings|Redbook|MBA |API /i;
const ISM_SUB = /ISM .*(Employment|New Orders|Prices|Business Activity|Backlog|Inventories|Supplier|Imports|Exports|Production|New Export)/i;
const NOWCAST = /GDPNow|Cleveland CPI|Nowcast|GDPNowcast/i;
const PERIOD_PAIR = new Set(['소비자물가(CPI)', '근원 소비자물가', '생산자물가(PPI)', '근원 생산자물가', '소매판매', '근원 소매판매', '국내총생산(GDP)']);
// 미국 실적은 S&P500 구성종목만 표시 (datahub CSV 최신 우선, 실패 시 내장 폴백)
const SP500_FALLBACK = ('A AAPL ABBV ABNB ABT ACGL ACN ADBE ADI ADM ADP ADSK AEE AEP AES AFL AIG AIZ AJG AKAM ALB ALGN ALL ALLE AMAT AMCR AMD AME AMGN AMP AMT AMZN ANET AON AOS APA APD APH APO APP APTV ARE ARES ATO AVB AVGO AVY AWK AXON AXP AZO BA BAC BALL BAX BBY BDX BEN BF.B BG BIIB BKNG BKR BLDR BLK BMY BNY BR BRK.B BRO BSX BX BXP C CAG CAH CARR CASY CAT CB CBOE CBRE CCI CCL CDNS CDW CEG CF CFG CHD CHRW CHTR CI CIEN CINF CL CLX CMCSA CME CMG CMI CMS CNC CNP COF COHR COIN COO COP COR COST CPAY CPB CPRT CPT CRH CRL CRM CRWD CSCO CSGP CSX CTAS CTSH CTVA CVNA CVS CVX D DAL DASH DD DDOG DE DECK DELL DG DGX DHI DHR DIS DLR DLTR DOC DOV DOW DPZ DRI DTE DUK DVA DVN DXCM EA EBAY ECL ED EFX EG EIX EL ELV EME EMR EOG EQIX EQR EQT ERIE ES ESS ETN ETR EVRG EW EXC EXE EXPD EXPE EXR F FANG FAST FCX FDS FDX FE FFIV FICO FIS FISV FITB FIX FOX FOXA FRT FSLR FTNT FTV GD GDDY GE GEHC GEN GEV GILD GIS GL GLW GM GNRC GOOG GOOGL GPC GPN GRMN GS GWW HAL HAS HBAN HCA HD HIG HII HLT HON HOOD HPE HPQ HRL HSIC HST HSY HUBB HUM HWM IBKR IBM ICE IDXX IEX IFF INCY INTC INTU INVH IP IQV IR IRM ISRG IT ITW IVZ J JBHT JBL JCI JKHY JNJ JPM KDP KEY KEYS KHC KIM KKR KLAC KMB KMI KO KR KVUE L LDOS LEN LH LHX LII LIN LITE LLY LMT LNT LOW LRCX LULU LUV LVS LYB LYV MA MAA MAR MAS MCD MCHP MCK MCO MDLZ MDT MET META MGM MKC MLM MMM MNST MO MOS MPC MPWR MRK MRNA MRSH MS MSCI MSFT MSI MTB MTD MU NCLH NDAQ NDSN NEE NEM NFLX NI NKE NOC NOW NRG NSC NTAP NTRS NUE NVDA NVR NWS NWSA NXPI O ODFL OKE OMC ON ORCL ORLY OTIS OXY PANW PAYX PCAR PCG PEG PEP PFE PFG PG PGR PH PHM PKG PLD PLTR PM PNC PNR PNW PODD POOL PPG PPL PRU PSA PSKY PSX PTC PWR PYPL QCOM RCL REG REGN RF RJF RL RMD ROK ROL ROP ROST RSG RTX RVTY SBAC SBUX SCHW SHW SJM SLB SMCI SNA SNPS SO SOLV SPG SPGI SRE STE STLD STT STX STZ SW SWK SWKS SYF SYK SYY T TAP TDG TDY TECH TEL TER TFC TGT TJX TKO TMO TMUS TPL TPR TRGP TRMB TROW TRV TSCO TSLA TSN TT TTD TTWO TXN TXT TYL UAL UBER UDR UHS ULTA UNH UNP UPS URI USB V VEEV VICI VLO VLTO VMC VRSK VRSN VRT VRTX VST VTR VTRS VZ WAB WAT WBD WDAY WDC WEC WELL WFC WM WMB WMT WRB WSM WST WTW WY WYNN XEL XOM XYL XYZ YUM ZBH ZBRA ZTS').split(' ');
let SP500 = null, SP500_TS = 0;
async function loadSP500() {
  if (SP500 && Date.now() - SP500_TS < 6 * 3600 * 1000) return SP500;
  try {
    const r = await fetch('https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv', { headers: HDR });
    if (r.ok) {
      const t = await r.text();
      const set = new Set(t.split(/\r?\n/).slice(1).map(l => (l.split(',')[0] || '').trim()).filter(Boolean));
      if (set.size > 400) { SP500 = set; SP500_TS = Date.now(); return SP500; }
    }
  } catch (e) { /* 폴백 */ }
  SP500 = new Set(SP500_FALLBACK); SP500_TS = Date.now(); return SP500;
}
// 나스닥100(nasdaq.com 지수 API) + 다우30(고정·전원 S&P500 포함)
const NDX_FALLBACK = ('AAPL ABNB ADBE ADI ADP ADSK AEP ALNY AMAT AMD AMGN AMZN APP ARM ASML AVGO AXON BKNG BKR CCEP CDNS CEG CHTR CMCSA COST CPRT CRWD CSCO CSX CTAS CTSH DASH DDOG DXCM EA EXC FANG FAST FER FTNT GEHC GILD GOOG GOOGL HON IDXX INSM INTC INTU ISRG KDP KHC KLAC LIN LITE LRCX MAR MCHP MDLZ MELI META MNST MPWR MRVL MSFT MSTR MU NFLX NVDA NXPI ODFL ORLY PANW PAYX PCAR PDD PEP PLTR PYPL QCOM REGN ROP ROST SBUX SHOP SNDK SNPS STX TMUS TRI TSLA TTWO TXN VRSK VRTX WBD WDAY WDC WMT XEL ZS').split(' ');
const DOW = new Set(('AAPL AMGN AMZN AXP BA CAT CRM CSCO CVX DIS GS HD HON IBM JNJ JPM KO MCD MMM MRK MSFT NKE NVDA PG SHW TRV UNH V VZ WMT').split(' '));
let NDX = null, NDX_TS = 0;
async function loadNDX() {
  if (NDX && Date.now() - NDX_TS < 6 * 3600 * 1000) return NDX;
  try {
    const r = await fetch('https://api.nasdaq.com/api/quote/list-type/nasdaq100', { headers: HDR });
    if (r.ok) {
      const j = await r.json();
      const rows = ((j.data && j.data.data && j.data.data.rows) || (j.data && j.data.rows)) || [];
      const set = new Set(rows.map(x => (x.symbol || '').trim()).filter(Boolean));
      if (set.size > 80) { NDX = set; NDX_TS = Date.now(); return NDX; }
    }
  } catch (e) { /* 폴백 */ }
  NDX = new Set(NDX_FALLBACK); NDX_TS = Date.now(); return NDX;
}
function usIndexOf(sym, sp, ndx) {
  const base = sym.replace('/', '.');
  if (sp.has(sym) || sp.has(base)) return 'S&P500';
  if (ndx.has(sym)) return 'NASDAQ100';
  if (DOW.has(sym)) return 'DOW';
  return '';
}

function clean(v) { if (v == null) return ''; const s = String(v).replace(/&nbsp;| /g, '').trim(); return (s === '' || s === '-' || s === 'N/A') ? '' : s; }
function importance(name) {
  const n = name.toLowerCase();
  for (const k of HI3) if (n.includes(k.toLowerCase())) return 3;
  for (const k of HI2) if (n.includes(k.toLowerCase())) return 2;
  return 1;
}
function econTitle(name) {
  if (ECON_KO[name]) return ECON_KO[name];
  if (name.includes('Speaks')) {
    for (const en in SPEAK_KO) if (name.includes(en)) return '연준 ' + SPEAK_KO[en] + ' 연설';
    return name.replace(' Speaks', ' 연설');
  }
  for (const en in ECON_KO) if (name.toLowerCase().includes(en.toLowerCase())) return ECON_KO[en];
  return name;
}
function etOffset(y, m, d) { // EDT(-4) or EST(-5); m=1..12
  if (m < 3 || m > 11) return -5;
  if (m > 3 && m < 11) return -4;
  const fdMar = new Date(Date.UTC(y, 2, 1)).getUTCDay();
  const secondSunMar = 1 + ((7 - fdMar) % 7) + 7;
  const fdNov = new Date(Date.UTC(y, 10, 1)).getUTCDay();
  const firstSunNov = 1 + ((7 - fdNov) % 7);
  if (m === 3) return d >= secondSunMar ? -4 : -5;
  return d < firstSunNov ? -4 : -5; // November
}
function etToKst(dateStr, hhmm) {
  const [y, m, d] = dateStr.split('-').map(Number);
  let hh = 9, mm = 0; const mt = /(\d{1,2}):(\d{2})/.exec(hhmm || '');
  if (mt) { hh = +mt[1]; mm = +mt[2]; }
  const off = etOffset(y, m, d);
  const utc = Date.UTC(y, m - 1, d, hh - off, mm);  // ET wall → UTC instant
  return new Date(utc + 9 * 3600 * 1000);           // + KST(+9); read via getUTC*
}
function ymd(dt) { return dt.getUTCFullYear() + '-' + String(dt.getUTCMonth() + 1).padStart(2, '0') + '-' + String(dt.getUTCDate()).padStart(2, '0'); }
function hm(dt) { return String(dt.getUTCHours()).padStart(2, '0') + ':' + String(dt.getUTCMinutes()).padStart(2, '0'); }
function todayKstYmd() {
  const s = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return s;
}
function addDays(ymdStr, n) { const [y, m, d] = ymdStr.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d + n)); return ymd(t); }
function magNum(s) { const m = String(s == null ? '' : s).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/); return m ? Math.abs(parseFloat(m[0])) : null; }
function parseCap(s) { const v = parseFloat(String(s || '').replace(/[^0-9.]/g, '')); return isNaN(v) ? 0 : v; }
function fmtSurprise(s) { const v = parseFloat(String(s == null ? '' : s).replace(/,/g, '')); return isNaN(v) ? '' : (v >= 0 ? '+' : '') + v.toFixed(1) + '%'; }
function capStr(n) { if (n >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T'; if (n >= 1e9) return '$' + Math.round(n / 1e9) + 'B'; if (n >= 1e6) return '$' + Math.round(n / 1e6) + 'M'; return ''; }

async function getJson(url) { const r = await fetch(url, { headers: HDR }); if (!r.ok) throw new Error('http ' + r.status); return r.json(); }

// 나스닥 quirk: economicevents?date=D 는 실제 ET 발표일 + 1 → ET 발표일 = D-1 로 보정(US·KR 공통)
async function fetchEcon(today, events) {
  const lo = addDays(today, -PAST), hi = addDays(today, FUT);
  const seen = new Set();
  const dates = []; for (let o = -PAST; o <= FUT + 1; o++) dates.push(addDays(today, o));
  const lists = await Promise.all(dates.map(ds => getJson('https://api.nasdaq.com/api/calendar/economicevents?date=' + ds).then(j => [ds, j]).catch(() => [ds, null])));
  for (const [ds, j] of lists) {
    const rows = (j && j.data && j.data.rows) || [];
    const etDate = addDays(ds, -1);   // ET 실제 발표일 보정
    for (const r of rows) {
      const country = (r.country || '').trim();
      const mk = country === 'United States' ? 'us' : country === 'South Korea' ? 'kr' : null;
      if (!mk) continue;
      const name = clean(r.eventName); if (!name) continue;
      if (mk === 'us' && (NOISE_US.test(name) || ISM_SUB.test(name) || NOWCAST.test(name))) continue;
      let imp = importance(name);
      const isSpeak = name.includes('Speaks');
      if (mk === 'us' && imp === 1 && !(isSpeak && name.includes('Powell'))) continue;
      const kst = etToKst(etDate, r.gmt);
      const hasTime = /(\d{1,2}):(\d{2})/.test(clean(r.gmt));
      const evDate = ymd(kst);
      const evTime = hasTime ? hm(kst) : '';
      if (evDate < lo || evDate > hi) continue;
      const title = econTitle(name);
      const key = mk + '|' + evDate + '|' + evTime + '|' + title + '|' + clean(r.consensus) + '|' + clean(r.previous);
      if (seen.has(key)) continue; seen.add(key);
      events.push({ date: evDate, time: evTime, et: clean(r.gmt), mk, type: 'econ', title, title_en: name,
        importance: (isSpeak && name.includes('Powell')) ? 3 : imp, forecast: clean(r.consensus),
        previous: clean(r.previous), actual: clean(r.actual), category: isSpeak ? '연설' : '지표' });
    }
  }
}

// 미국 실적 — S&P500 ∪ 나스닥100 ∪ 다우 (서버리스는 근시일만 라이브; 먼 일정은 프론트가 스냅샷에서 보강)
async function fetchEarnings(today, events) {
  const SESS = { 'time-pre-market': '장 시작 전', 'time-after-hours': '장 마감 후', 'time-not-supplied': '시간 미정' };
  const [sp, ndx] = await Promise.all([loadSP500(), loadNDX()]);
  const dates = []; for (let o = -PAST; o <= FUT; o++) dates.push([o, addDays(today, o)]);
  const lists = await Promise.all(dates.map(([o, ds]) => getJson('https://api.nasdaq.com/api/calendar/earnings?date=' + ds).then(j => [o, ds, j]).catch(() => [o, ds, null])));
  for (const [o, ds, j] of lists) {
    const rows = (j && j.data && j.data.rows) || [];
    const big = [];
    for (const r of rows) {
      const sym = clean(r.symbol);
      if (!sym || (!sp.has(sym) && !sp.has(sym.replace('/', '.')) && !ndx.has(sym) && !DOW.has(sym))) continue;
      big.push([parseCap(r.marketCap), r]);
    }
    big.sort((a, b) => b[0] - a[0]);
    // 과거: 실제 보고된 종목 위주, 그 외: 시총 상위 12
    const picked = o < 0 ? big.filter(([, r]) => clean(r.eps)).slice(0, 12) : big.slice(0, 12);
    for (const [cap, r] of picked) {
      const sym = clean(r.symbol);
      const nm = TICKER_KO[sym] || clean(r.name).replace(', Inc.', '').replace(' Inc.', '').replace(', Incorporated', '').replace(' Corporation', '').trim();
      const released = o <= 0;
      const epsActual = released ? clean(r.eps) : '';
      events.push({ date: ds, time: '', mk: 'us', type: 'earnings', index: usIndexOf(sym, sp, ndx), title: nm, ticker: sym,
        session: SESS[clean(r.time)] || '시간 미정', eps_est: clean(r.epsForecast), eps_prev: clean(r.lastYearEPS),
        eps_actual: epsActual, surprise: epsActual ? fmtSurprise(r.surprise) : '',
        n_ests: clean(r.noOfEsts), mktcap: capStr(cap), importance: cap >= 1e11 ? 3 : 2 });
    }
  }
}

function disambiguate(events) {
  const g = {};
  for (const e of events) if (e.type === 'econ' && PERIOD_PAIR.has(e.title)) {
    const k = e.title + '|' + e.date + '|' + e.time; (g[k] = g[k] || []).push(e);
  }
  for (const k in g) {
    const rows = g[k]; if (rows.length !== 2) continue;
    const v = rows.map(r => magNum(r.forecast || r.previous));
    if (v[0] == null || v[1] == null || v[0] === v[1]) continue;
    const yoy = '(전년比)', mom = rows[0].title.includes('국내총생산') ? '(전기比)' : '(전월比)';
    const hi = v[0] > v[1] ? 0 : 1;
    rows[hi].title += ' ' + yoy; rows[1 - hi].title += ' ' + mom;
  }
}

async function __cfHandler(event) {
  if (CACHE.data && Date.now() - CACHE.ts < TTL) return ok(CACHE.data);
  const today = todayKstYmd();
  const events = [];
  try { await fetchEcon(today, events); } catch (e) { /* 부분 실패 허용 */ }
  try { await fetchEarnings(today, events); } catch (e) { /* 부분 실패 허용 */ }
  if (!events.length) return { statusCode: 502, headers: cors(), body: JSON.stringify({ error: 'no data' }) };
  disambiguate(events);
  events.sort((a, b) => (a.date + (a.time || '99:99') + (9 - (a.importance || 0))).localeCompare(b.date + (b.time || '99:99') + (9 - (b.importance || 0))));
  const data = { _updated: new Date().toISOString().slice(0, 19), today, window: { from: addDays(today, -PAST), to: addDays(today, FUT) }, count: events.length, events };
  CACHE = { ts: Date.now(), data };
  return ok(data);
};

function cors() { return { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }; }
function ok(obj) {
  return { statusCode: 200, headers: Object.assign(cors(), {
    'Cache-Control': 'public, max-age=300',
    'Netlify-CDN-Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=3600',
  }), body: JSON.stringify(obj) };
}


// ── Cloudflare Pages Function 어댑터 (자동 변환) ──
export async function onRequest(context) {
  const url = new URL(context.request.url);
  const event = { queryStringParameters: Object.fromEntries(url.searchParams), rawUrl: context.request.url };
  if (context.request.method === 'OPTIONS') {
    return new Response('', { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,OPTIONS' } });
  }
  const r = await __cfHandler(event);
  return new Response(r.body, { status: r.statusCode || 200, headers: r.headers || { 'Content-Type': 'application/json' } });
}
