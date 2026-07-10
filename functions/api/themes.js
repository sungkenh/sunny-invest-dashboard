// 섹터 전문가 데스크 — /api/themes?mkt=kr|us[&fresh=1]
// 큐레이션 구조적 논지 + 실시세 기반 비중의견 엔진(매 갱신 시 재계산) + 최신 촉매 뉴스.
//   비중의견 = 절대모멘텀(6M) 30% + 지수대비 상대강도 30% + 추세구조(50/200일선) 25% + 폭(breadth) 15%
//              − 리스크 감점(20일 이격·변동성·RSI 과열, 최대 30점)
//   가드레일: 과열·낙폭·시장 리스크오프·저신뢰·데이터부족 → 비중확대 억제/판단보류
// ⚠️ 가격(추세) 기반 상대 판단. 밸류에이션·실적·수급 미반영 — 매수/매도 신호가 아님.
// subrequest: 종목 28 + 벤치 1 + 뉴스 7 = 36 (Cloudflare 무료 50 제한 내)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const CACHE = {};                    // mkt → {ts, data}
const TTL = 30 * 60 * 1000;

const BENCH = { kr: { sym: '^KS11', name: 'KOSPI' }, us: { sym: '^GSPC', name: 'S&P 500' } };

// 섹터 = 큐레이션(구조적 논지·바스켓·뉴스쿼리). 바스켓 심볼은 야후 실데이터로 전량 검증됨.
const DESKS = {
  kr: [
    { nm: 'AI · 반도체', desk: '반도체 데스크', thesis: 'HBM·파운드리 증설과 AI 서버 수요가 실적 레버리지의 축',
      basket: [['005930.KS', '삼성전자'], ['000660.KS', 'SK하이닉스'], ['042700.KS', '한미반도체'], ['058470.KQ', '리노공업']],
      q: 'HBM OR SK하이닉스 OR AI반도체' },
    { nm: '방산 · 우주', desk: '방산 데스크', thesis: '글로벌 국방비 증액과 K-방산 수출 파이프라인이 장기 수주잔고를 지지',
      basket: [['012450.KS', '한화에어로스페이스'], ['079550.KS', 'LIG넥스원'], ['064350.KS', '현대로템'], ['047810.KS', '한국항공우주']],
      q: '방산 OR 한화에어로스페이스 OR 방산수출' },
    { nm: '원전 · 전력기기', desk: '에너지 데스크', thesis: 'AI 데이터센터 전력수요와 노후 송배전 교체 사이클이 구조적 수요',
      basket: [['034020.KS', '두산에너빌리티'], ['267260.KS', 'HD현대일렉트릭'], ['010120.KS', 'LS ELECTRIC'], ['298040.KS', '효성중공업']],
      q: '원전 OR SMR OR 전력기기 수출' },
    { nm: '조선 · 기계', desk: '조선 데스크', thesis: '친환경 선박 교체 수요와 고선가 수주잔고가 수익성 개선을 견인',
      basket: [['009540.KS', 'HD한국조선해양'], ['329180.KS', 'HD현대중공업'], ['042660.KS', '한화오션'], ['010140.KS', '삼성중공업']],
      q: '조선 수주 OR LNG선 OR 한화오션' },
    { nm: '2차전지 · 소재', desk: '2차전지 데스크', thesis: '전기차 캐즘 단기 부담 vs 메탈가 바닥·전고체 로드맵의 장기 옵션',
      basket: [['373220.KS', 'LG에너지솔루션'], ['006400.KS', '삼성SDI'], ['247540.KQ', '에코프로비엠'], ['003670.KS', '포스코퓨처엠']],
      q: '2차전지 OR 전기차 배터리 OR 에코프로' },
    { nm: '바이오 · 헬스케어', desk: '헬스케어 데스크', thesis: 'CDMO 수주 확대와 비만치료제 밸류체인이 실적 가시성을 높임',
      basket: [['207940.KS', '삼성바이오로직스'], ['068270.KS', '셀트리온'], ['196170.KQ', '알테오젠'], ['000100.KS', '유한양행']],
      q: '바이오 신약 OR CDMO OR 알테오젠' },
    { nm: '금융 · 밸류업', desk: '매크로·금융 데스크', thesis: '주주환원 확대와 금리 하강 국면의 자본비용 완화가 재평가 요인',
      basket: [['105560.KS', 'KB금융'], ['055550.KS', '신한지주'], ['138040.KS', '메리츠금융'], ['000810.KS', '삼성화재']],
      q: '밸류업 OR 은행 배당 OR 기준금리' },
  ],
  us: [
    { nm: 'AI · 반도체', desk: 'Semis 데스크', thesis: '가속컴퓨팅 전환으로 AI 인프라 CapEx가 반도체 이익에 집중',
      basket: [['NVDA', '엔비디아'], ['AVGO', '브로드컴'], ['AMD', 'AMD'], ['TSM', 'TSMC']],
      q: 'Nvidia OR AI chip OR semiconductor demand' },
    { nm: '빅테크 · 소프트웨어', desk: '테크 데스크', thesis: 'AI 수익화 초기 국면 — 클라우드·광고 현금흐름이 투자를 뒷받침',
      basket: [['MSFT', '마이크로소프트'], ['GOOGL', '알파벳'], ['META', '메타'], ['PLTR', '팔란티어']],
      q: 'Microsoft OR Alphabet OR AI software' },
    { nm: '전력 · 원자력', desk: '유틸리티 데스크', thesis: '데이터센터 전력수요 급증으로 발전·원자력 계약단가가 재평가',
      basket: [['GEV', 'GE버노바'], ['VST', '비스트라'], ['CEG', '콘스텔레이션'], ['NRG', 'NRG에너지']],
      q: 'data center power OR nuclear PPA OR Vistra' },
    { nm: '방산 · 우주', desk: '방산 데스크', thesis: '지정학 리스크 상시화로 다년 방위예산 가시성 확보',
      basket: [['RTX', 'RTX'], ['LMT', '록히드마틴'], ['NOC', '노스롭그루먼'], ['GD', '제너럴다이내믹스']],
      q: 'defense budget OR Lockheed OR missile order' },
    { nm: '헬스케어 · 비만치료', desk: '헬스케어 데스크', thesis: 'GLP-1 시장 확대와 대형 M&A가 파이프라인 가치를 재산정',
      basket: [['LLY', '일라이릴리'], ['NVO', '노보노디스크'], ['UNH', '유나이티드헬스'], ['ABBV', '애브비']],
      q: 'GLP-1 OR obesity drug OR Eli Lilly' },
    { nm: '금융 · 은행', desk: '금융 데스크', thesis: '금리 하강기 순이자마진 둔화 vs 자본시장 수수료·자사주 매입',
      basket: [['JPM', 'JP모건'], ['GS', '골드만삭스'], ['BAC', '뱅크오브아메리카'], ['MS', '모건스탠리']],
      q: 'Fed rate cut OR bank earnings OR JPMorgan' },
    { nm: '에너지', desk: '에너지 데스크', thesis: '공급 규율과 지정학 프리미엄 vs 수요 둔화의 균형',
      basket: [['XOM', '엑슨모빌'], ['CVX', '셰브론'], ['COP', '코노코필립스'], ['SLB', 'SLB']],
      q: 'oil price OR OPEC OR Exxon' },
  ],
};

/* ── 수학 헬퍼 ── */
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const round = (x, n) => { const p = Math.pow(10, n); return Math.round(x * p) / p; };
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
function stdev(a) { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / (a.length - 1)); }
function dailyRets(a) { const o = []; for (let i = 1; i < a.length; i++) o.push(a[i] / a[i - 1] - 1); return o; }
function wilderRSI(a, p) {
  if (a.length < p + 1) return 50;
  let ag = 0, al = 0;
  for (let i = 1; i <= p; i++) { const d = a[i] - a[i - 1]; if (d > 0) ag += d; else al -= d; }
  ag /= p; al /= p;
  for (let i = p + 1; i < a.length; i++) { const d = a[i] - a[i - 1]; ag = (ag * (p - 1) + (d > 0 ? d : 0)) / p; al = (al * (p - 1) + (d < 0 ? -d : 0)) / p; }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}
// 표본 제외 조건: 최근 10봉이 전부 동일(거래정지·상폐) 또는 반복봉 비율 20% 초과(데이터 품질 불량).
// ⚠️ 중간 구간의 짧은 동일값 구간(야후 데이터 아티팩트)만으로 종목을 버리면 섹터 대표성이 무너진다.
function staleSeries(c) {
  const k = Math.min(10, c.length), last = c[c.length - 1];
  let tailSame = k >= 5;
  for (let i = c.length - k; i < c.length && tailSame; i++) if (c[i] !== last) tailSame = false;
  if (tailSame) return true;
  let rep = 0; for (let i = 1; i < c.length; i++) if (c[i] === c[i - 1]) rep++;
  return rep / c.length > 0.20;
}

/* ── 데이터 수집 ── */
// 1년 일봉 종가(결측 forward-fill 최대 3일, 초과 구간은 스킵)
async function closeSeries(sym) {
  try {
    const u = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?interval=1d&range=1y';
    const r = await fetch(u, { headers: { 'User-Agent': UA } });
    if (!r.ok) return null;
    const d = await r.json();
    const res = d && d.chart && d.chart.result && d.chart.result[0];
    const raw = res && res.indicators && res.indicators.quote && res.indicators.quote[0] && res.indicators.quote[0].close;
    if (!raw || !raw.length) return null;
    const out = []; let miss = 0;
    for (const v of raw) {
      if (typeof v === 'number' && isFinite(v) && v > 0) { out.push(v); miss = 0; }
      else if (out.length && miss < 3) { out.push(out[out.length - 1]); miss++; }
    }
    return out.length ? out : null;
  } catch (e) { return null; }
}

// 최신 촉매 뉴스 1건 (구글뉴스 RSS)
function decode(s) {
  return (s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&').trim();
}
function tag(block, name) { const m = block.match(new RegExp('<' + name + '[^>]*>([\\s\\S]*?)<\\/' + name + '>')); return m ? m[1] : ''; }
function reltime(mins) { if (mins < 1) return '방금'; if (mins < 60) return mins + '분 전'; const h = Math.floor(mins / 60); if (h < 24) return h + '시간 전'; return Math.floor(h / 24) + '일 전'; }
async function latestNews(q, mkt) {
  try {
    const loc = mkt === 'us' ? '&hl=en-US&gl=US&ceid=US:en' : '&hl=ko&gl=KR&ceid=KR:ko';
    const r = await fetch('https://news.google.com/rss/search?q=' + encodeURIComponent(q) + loc, { headers: { 'User-Agent': UA } });
    const xml = await r.text();
    const item = (xml.match(/<item\b[\s\S]*?<\/item>/) || [])[0];
    if (!item) return null;
    let ti = decode(tag(item, 'title'));
    const link = decode(tag(item, 'link'));
    let src = decode(tag(item, 'source'));
    if (src && ti.endsWith(' - ' + src)) ti = ti.slice(0, -(src.length + 3)).trim();
    else if (!src && ti.includes(' - ')) { const i = ti.lastIndexOf(' - '); src = ti.slice(i + 3).trim(); ti = ti.slice(0, i).trim(); }
    let tm = '';
    const pd = tag(item, 'pubDate');
    if (pd) { const t = Date.parse(pd); if (!isNaN(t)) tm = reltime(Math.max(0, Math.floor((Date.now() - t) / 60000))); }
    return ti ? { ti, link, src, tm } : null;
  } catch (e) { return null; }
}

/* ── 비중의견 엔진 ── */
const pct = (x, d) => (x >= 0 ? '+' : '') + (x * 100).toFixed(d === undefined ? 1 : d) + '%';

function sectorMetrics(series, bench, benchName) {
  const valids = series.filter((s) => s && s.length >= 120 && !staleSeries(s));
  const validCount = valids.length;
  if (!bench || bench.length < 25 || validCount < 1) return null;
  const n = Math.min(bench.length, ...valids.map((a) => a.length));
  if (n < 25) return null;
  const tail = (a) => a.slice(a.length - n);

  // 등가중 리베이스 컴포지트 S, 벤치 B
  const cols = valids.map((a) => { const t = tail(a); return t.map((v) => v / t[0]); });
  const S = []; for (let t = 0; t < n; t++) S.push(mean(cols.map((a) => a[t])));
  const bt = tail(bench); const B = bt.map((v) => v / bt[0]);
  const i = n - 1;

  // S1 절대모멘텀(6M) · S2 상대강도 · S3 추세구조 · S4 폭
  const w = Math.min(126, n - 1);
  const r126 = S[i] / S[i - w] - 1;
  const rs = r126 - (B[i] / B[i - w] - 1);
  const r252 = n > 200 ? S[i] / S[i - Math.min(252, n - 1)] - 1 : null;
  const sub1 = clamp(r126 / 0.20, -1, 1);
  const sub2 = clamp(rs / 0.15, -1, 1);
  const ma50 = mean(S.slice(n - Math.min(50, n)));
  const longLen = Math.min(200, n); const maLong = mean(S.slice(n - longLen));
  const shortHist = longLen < 200;
  const sub3 = clamp((S[i] > ma50 ? 0.5 : -0.5) + (ma50 > maLong ? 0.5 : -0.5), -1, 1);

  let above = 0, pos = 0; const rets = [], todays = [];
  for (const a of valids) {
    const c = tail(a), last = c[n - 1];
    if (last > mean(c.slice(n - Math.min(50, n)))) above++;
    const ww = Math.min(63, n - 1); const r63 = last / c[n - 1 - ww] - 1;
    rets.push(r63); if (r63 > 0) pos++;
    todays.push(c[n - 1] / c[n - 2] - 1);
  }
  const breadth = (above / validCount + pos / validCount) / 2;
  const sub4 = 2 * breadth - 1;
  const dispersion = validCount > 1 ? stdev(rets) : 0;

  const driverScore = Math.round(100 * (0.30 * sub1 + 0.30 * sub2 + 0.25 * sub3 + 0.15 * sub4));

  // 리스크 감점(급등 후 추격 억제) — 최대 30
  const ma20 = mean(S.slice(n - Math.min(20, n)));
  const ext20 = S[i] / ma20 - 1;
  const pExt = clamp((ext20 - 0.10) / 0.10, 0, 1) * 15;
  const gS = dailyRets(S).slice(-20), gB = dailyRets(B).slice(-20);
  const volS = stdev(gS) * Math.sqrt(252), volB = stdev(gB) * Math.sqrt(252);
  const volRatio = volS / Math.max(volB, 1e-6);
  const pVol = clamp((volRatio - 1.5) / 1.0, 0, 1) * 10;
  const rsi14 = wilderRSI(S, 14);
  const pRsi = clamp((rsi14 - 70) / 15, 0, 1) * 10;
  const penalty = Math.min(pExt + pVol + pRsi, 30);
  const finalScore = Math.round(clamp(driverScore - penalty, -100, 100));

  // 신뢰도
  const sgn = Math.sign(driverScore) || 1;
  let agree = 0;
  if (Math.sign(sub1) === sgn) agree += 0.30;
  if (Math.sign(sub2) === sgn) agree += 0.30;
  if (Math.sign(sub3) === sgn) agree += 0.25;
  if (Math.sign(sub4) === sgn) agree += 0.15;
  const dataQuality = Math.min(n / 252, 1) * (validCount / 4);
  let conf = 100 * (0.45 * agree + 0.25 * (Math.abs(driverScore) / 100) + 0.15 * breadth + 0.15 * dataQuality);
  if (n < 200) conf *= 0.85;
  if (n < 120) conf *= 0.6;
  if (n < 60) conf = Math.min(conf, 30);
  conf = Math.round(clamp(conf, 0, 100));

  const curDD = S[i] / Math.max.apply(null, S.slice(n - Math.min(252, n))) - 1;
  const bench20 = n > 20 ? B[i] / B[i - 20] - 1 : 0;
  const perfToday = round(mean(todays) * 100, 2);

  return { n, validCount, r126, r252, rs, breadth, above, pos, dispersion, shortHist,
    driverScore, penalty: Math.round(penalty), finalScore, conf, curDD, ext20, volRatio, rsi14, bench20, perfToday, benchName };
}

// 스코어·가드레일 → 3단계 의견 + 경고 (시장 리스크오프는 카드마다 반복하지 않고 상단 배너로 표시)
function opine(m, riskOff) {
  if (!m || m.n < 60 || m.validCount < 3) {
    return { op: 'op-hold', opTxt: '판단보류', warns: ['데이터 부족 — 판단보류'], conf: m ? Math.min(m.conf, 30) : 0 };
  }
  let op = 'op-hold', opTxt = '중립';
  if (m.finalScore >= 25 && m.rs > 0) { op = 'op-buy'; opTxt = '비중확대'; }
  else if (m.finalScore <= -25 && m.rs < 0) { op = 'op-sell'; opTxt = '비중축소'; }

  // 가드레일: 비중확대만 한 단계 강등(사유는 아래 경고로 노출)
  const cap = () => { if (op === 'op-buy') { op = 'op-hold'; opTxt = '중립'; } };
  if (m.ext20 > 0.25 || m.rsi14 > 80) cap();
  if (m.curDD < -0.20) cap();
  if (riskOff) cap();
  if (m.conf < 40) cap();

  const warns = [];
  if (m.ext20 > 0.20 || m.rsi14 > 75) warns.push('과열 — 분할·눌림목 대기');
  if (m.curDD < -0.20) warns.push('하락추세 가능 — 저가매수 아님');
  if (m.dispersion > 0.30) warns.push('특정 종목 주도 — 개별 확인 필요');
  if (m.r126 > 0 && m.rs <= 0) warns.push('지수 동반 상승 — 초과성과 없음');
  if (m.conf < 40) warns.push('참고용 · 저신뢰');
  return { op, opTxt, warns, conf: m.conf };
}

function bullets(m) {
  const rel = m.rs > 0.02 ? '지수 상회' : (m.rs < -0.02 ? '지수 하회' : '시장 수준');
  const b1 = '최근 6개월 ' + pct(m.r126) + ' · ' + m.benchName + ' 대비 ' + pct(m.rs) + 'p — ' + rel
    + (m.r252 != null ? ' (12개월 ' + pct(m.r252) + ')' : '');
  // 폭(breadth)은 '50일선 위' + '3개월 상승' 두 비율의 평균 — 둘 다 명시해 오해 방지
  const b2 = '구성 ' + m.validCount + '종목 중 ' + m.above + '개 50일선 위 · ' + m.pos + '개 3개월 상승 — 폭 ' + Math.round(m.breadth * 100) + '%'
    + (m.shortHist ? ' (단기 이력)' : '')
    + ', 참여 ' + (m.breadth >= 0.6 ? '광범위' : (m.breadth <= 0.4 ? '제한적' : '보통'));
  const b3 = '52주 고점 대비 ' + pct(m.curDD) + ' · 20일 이격 ' + pct(m.ext20) + ' · 변동성 지수 대비 ' + m.volRatio.toFixed(1) + '배'
    + ' — 종합 ' + (m.finalScore >= 0 ? '+' : '') + m.finalScore + '/100 (리스크 −' + m.penalty + ')';
  return [b1, b2, b3];
}

const CAVEAT = '가격(추세) 기반 상대 판단 — 밸류에이션·실적·수급 미반영. 매수/매도 신호가 아닌 비중 참고지표입니다.';

/* ── 동시 요청 제한 풀 ── */
async function runPool(items, limit, fn) {
  const out = new Array(items.length); let idx = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) { const k = idx++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

async function build(mkt) {
  const desks = DESKS[mkt], bm = BENCH[mkt];
  const syms = []; desks.forEach((d) => d.basket.forEach(([s]) => syms.push(s)));
  const [benchSeries, seriesList] = await Promise.all([
    closeSeries(bm.sym),
    runPool(syms, 10, (s) => closeSeries(s)),
  ]);
  const news = await runPool(desks, 7, (d) => latestNews(d.q, mkt));

  const byS = {}; syms.forEach((s, i) => { byS[s] = seriesList[i]; });
  // 시장 리스크오프: 벤치 20일 수익률 < −8%
  let riskOff = false;
  if (benchSeries && benchSeries.length > 21) { const b = benchSeries, j = b.length - 1; riskOff = (b[j] / b[j - 20] - 1) < -0.08; }

  const themes = desks.map((d, di) => {
    const series = d.basket.map(([s]) => byS[s]);
    const m = sectorMetrics(series, benchSeries, bm.name);
    const o = opine(m, riskOff);
    const picks = d.basket.map(([s, name]) => {
      const c = byS[s];
      const p = (c && c.length > 1) ? round((c[c.length - 1] / c[c.length - 2] - 1) * 100, 2) : null;
      return { name, pct: p };
    });
    let lead = null; for (const p of picks) if (typeof p.pct === 'number' && (!lead || p.pct > lead.pct)) lead = p;
    return {
      nm: d.nm, desk: d.desk, thesis: d.thesis,
      op: o.op, opTxt: o.opTxt, warns: o.warns, conf: o.conf,
      confBand: o.conf >= 70 ? '높음' : (o.conf >= 45 ? '보통' : '낮음'),
      score: m ? m.finalScore : null,
      pts: m ? bullets(m) : ['구성종목 시세 이력이 부족해 정량 판단을 보류합니다.', '데이터가 쌓이면 자동으로 의견이 산출됩니다.', d.thesis],
      perf: m ? m.perfToday : null, lead, picks, cat: news[di],
      metrics: m ? { r126: round(m.r126, 4), rs: round(m.rs, 4), breadth: round(m.breadth, 3), ext20: round(m.ext20, 4), rsi14: round(m.rsi14, 1), volRatio: round(m.volRatio, 2), curDD: round(m.curDD, 4), penalty: m.penalty, driver: m.driverScore } : null,
    };
  });

  return { _updated: new Date().toISOString().slice(0, 19), mkt, benchmark: bm.name, riskOff, caveat: CAVEAT, count: themes.length, themes };
}

async function __cfHandler(event) {
  const p = event.queryStringParameters || {};
  const mkt = (p.mkt === 'us') ? 'us' : 'kr';
  const fresh = p.fresh === '1' || p.fresh === 'true';
  const c = CACHE[mkt];
  if (!fresh && c && c.data && Date.now() - c.ts < TTL) return ok(c.data, false);
  const data = await build(mkt);
  CACHE[mkt] = { ts: Date.now(), data };
  return ok(data, fresh);
}

function ok(obj, noStore) {
  return { statusCode: 200, headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': noStore ? 'no-store' : 'public, max-age=300',
    'Netlify-CDN-Cache-Control': noStore ? 'no-store' : 'public, s-maxage=1800, stale-while-revalidate=3600',
  }, body: JSON.stringify(obj) };
}


// ── Cloudflare Pages Function 어댑터 ──
export async function onRequest(context) {
  const url = new URL(context.request.url);
  const event = { queryStringParameters: Object.fromEntries(url.searchParams), rawUrl: context.request.url };
  if (context.request.method === 'OPTIONS') {
    return new Response('', { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,OPTIONS' } });
  }
  const r = await __cfHandler(event);
  return new Response(r.body, { status: r.statusCode || 200, headers: r.headers || { 'Content-Type': 'application/json' } });
}
