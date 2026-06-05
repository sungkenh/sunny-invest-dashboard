// 종목 심층분석 온디맨드 생성 — /api/deep?sym=AAPL
// 야후 quoteSummary(크럼)로 개요·투자지표, 실패 시 chart 메타로 폴백.
// 큐레이션 7종목은 정적 data/deep.json이 담당 → 이 함수는 '신규 종목' 자동 생성.
// Node 18+ 전역 fetch, 의존성 없음.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';

const SECTOR_CHAIN = {
  'Technology': ['업스트림 (장비·부품·IP)', '제조·개발 (코어)', '플랫폼·제품', '다운스트림 (수요·고객)'],
  'Financial Services': ['자금·예수금', '핵심 영업 (여신·운용)', '상품·채널', '고객·시장'],
  'Healthcare': ['R&D·원료', '제조·임상', '제품·파이프라인', '의료기관·환자'],
  'Consumer Cyclical': ['원재료·부품', '제조·생산', '브랜드·제품', '유통·소비자'],
  'Consumer Defensive': ['원재료', '가공·생산', '브랜드·제품', '유통·소비자'],
  'Industrials': ['소재·부품', '제조·체계', '완성품·체계종합', '고객·수출'],
  'Energy': ['탐사·생산(업스트림)', '정제·가공(미드스트림)', '제품', '판매(다운스트림)'],
  'Communication Services': ['콘텐츠·인프라', '플랫폼·서비스', '제품·구독', '이용자·광고주'],
  'Basic Materials': ['원자재 채굴', '제련·가공', '소재·제품', '전방 산업'],
  'Utilities': ['연료·발전원', '발전·송배전', '전력·에너지', '가정·산업 수요'],
  'Real Estate': ['토지·개발', '건설·보유', '임대·운영', '임차인·시장'],
};
const DEFAULT_CHAIN = ['업스트림 (공급)', '핵심 사업', '제품·서비스', '다운스트림 (수요)'];

const baseSym = (s) => (s || '').replace('.KS', '').replace('.KQ', '');
const isKR = (s) => s.endsWith('.KS') || s.endsWith('.KQ');
const raw = (o) => (o && typeof o === 'object' && 'raw' in o) ? o.raw : (typeof o === 'number' ? o : null);

function trim(x) {
  if (x >= 100) return Math.round(x).toLocaleString('en-US');
  if (x >= 10) return x.toFixed(1);
  return x.toFixed(2);
}
function fmtMcap(v, kr) {
  if (!v) return '-';
  if (kr) { if (v >= 1e12) return trim(v / 1e12) + '조'; if (v >= 1e8) return trim(v / 1e8) + '억'; return Math.round(v).toLocaleString(); }
  if (v >= 1e12) return '$' + trim(v / 1e12) + 'T';
  if (v >= 1e9) return '$' + trim(v / 1e9) + 'B';
  if (v >= 1e6) return '$' + trim(v / 1e6) + 'M';
  return '$' + trim(v);
}
function fmtPx(v, kr) { if (v == null) return '-'; return kr ? Math.round(v).toLocaleString() : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function num(x, suf = '', mul = 1, dec = 1) { if (x == null || isNaN(x)) return '-'; return (x * mul).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec }) + suf; }
function rangePos(p, lo, hi) { if (p == null || lo == null || hi == null || hi <= lo) return null; return Math.max(0, Math.min(100, Math.round((p - lo) / (hi - lo) * 100))); }
function perNote(p) { if (p == null) return ''; if (p < 0) return '적자(N/A)'; if (p < 12) return '저평가 구간'; if (p < 25) return '시장 평균권'; if (p < 45) return '성장 프리미엄'; return '고평가 구간'; }
function pbrNote(p) { if (p == null) return ''; if (p < 1) return '순자산 이하'; if (p < 2) return '낮은 편'; if (p < 5) return '보통'; return '높은 편'; }

async function translate(text) {
  if (!text) return '';
  try {
    let s = text.trim().slice(0, 600);
    const u = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ko&dt=t&q=' + encodeURIComponent(s);
    const r = await fetch(u, { headers: { 'User-Agent': UA } });
    const d = await r.json();
    return (d[0] || []).map((seg) => seg[0]).filter(Boolean).join('');
  } catch (e) { return text; }
}

async function getCrumb() {
  try {
    const r1 = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA } });
    let cookie = '';
    const sc = r1.headers.get('set-cookie');
    if (sc) cookie = sc.split(',').map((c) => c.split(';')[0].trim()).filter(Boolean).join('; ');
    const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, 'Cookie': cookie } });
    const crumb = (await r2.text()).trim();
    if (crumb && !crumb.includes('<')) return { cookie, crumb };
  } catch (e) { /* fall through */ }
  return null;
}

async function quoteSummary(sym, cr) {
  const mods = 'assetProfile,summaryDetail,financialData,defaultKeyStatistics,price';
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  for (const h of hosts) {
    try {
      const u = `https://${h}/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=${mods}` +
        (cr ? `&crumb=${encodeURIComponent(cr.crumb)}` : '');
      const r = await fetch(u, { headers: { 'User-Agent': UA, ...(cr ? { 'Cookie': cr.cookie } : {}) } });
      if (!r.ok) continue;
      const d = await r.json();
      const res = d && d.quoteSummary && d.quoteSummary.result && d.quoteSummary.result[0];
      if (res) return res;
    } catch (e) { /* try next host */ }
  }
  return null;
}

async function chartMeta(sym) {
  try {
    const u = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?interval=1d&range=1d';
    const r = await fetch(u, { headers: { 'User-Agent': UA } });
    const d = await r.json();
    return d && d.chart && d.chart.result && d.chart.result[0] && d.chart.result[0].meta;
  } catch (e) { return null; }
}

exports.handler = async (event) => {
  const sym = ((event.queryStringParameters || {}).sym || '').trim();
  if (!sym) return resp({ error: 'no sym' });
  const kr = isKR(sym);
  const ASOF = new Date().toISOString().slice(0, 16).replace('T', ' ');

  const cr = await getCrumb();
  const qs = await quoteSummary(sym, cr);
  const meta = qs ? null : await chartMeta(sym);

  const sd = (qs && qs.summaryDetail) || {};
  const fd = (qs && qs.financialData) || {};
  const ks = (qs && qs.defaultKeyStatistics) || {};
  const ap = (qs && qs.assetProfile) || {};
  const pr = (qs && qs.price) || {};

  const px = raw(fd.currentPrice) || raw(pr.regularMarketPrice) || (meta && meta.regularMarketPrice) || null;
  const pc = raw(pr.regularMarketPreviousClose) || raw(sd.previousClose) || (meta && meta.chartPreviousClose) || null;
  const pct = (px && pc) ? Math.round((px - pc) / pc * 10000) / 100 : 0;

  const sector = ap.sector || '';
  const industry = ap.industry || '';
  const name = pr.longName || pr.shortName || (meta && (meta.longName || meta.shortName)) || baseSym(sym);

  // PER(후행→선행), PBR(없으면 가격/주당순자산), 배당(%)
  let per = raw(sd.trailingPE), perFwd = false;
  if (per == null && raw(ks.forwardPE) != null) { per = raw(ks.forwardPE); perFwd = true; }
  let pbr = raw(ks.priceToBook) || raw(sd.priceToBook);
  if (pbr == null) { const bv = raw(ks.bookValue); if (bv && px) pbr = px / bv; }
  const mcap = raw(sd.marketCap) || raw(pr.marketCap);
  const roe = raw(fd.returnOnEquity);
  const rg = raw(fd.revenueGrowth);
  const opm = raw(fd.operatingMargins) != null ? raw(fd.operatingMargins) : raw(fd.profitMargins);
  let divPct = null;
  const dRate = raw(sd.dividendRate) || raw(sd.trailingAnnualDividendRate);
  if (dRate && px) divPct = dRate / px * 100;
  else if (raw(sd.dividendYield) != null) divPct = raw(sd.dividendYield) * 100;
  else if (raw(sd.trailingAnnualDividendYield) != null) divPct = raw(sd.trailingAnnualDividendYield) * 100;
  const tgt = raw(fd.targetMeanPrice);
  const lo = raw(sd.fiftyTwoWeekLow) || (meta && meta.fiftyTwoWeekLow);
  const hi = raw(sd.fiftyTwoWeekHigh) || (meta && meta.fiftyTwoWeekHigh);
  const pos = rangePos(px, lo, hi);

  const metrics = [
    { k: '시가총액', v: fmtMcap(mcap, kr), x: sector },
    { k: perFwd ? 'PER (Fwd)' : 'PER (TTM)', v: num(per, '', 1, 1), x: perNote(per) },
    { k: 'PBR', v: num(pbr, '', 1, 2), x: pbrNote(pbr) },
    { k: 'ROE', v: num(roe, '%', 100), x: '자기자본이익률' },
    { k: '매출성장(YoY)', v: num(rg, '%', 100), x: '연간 매출 증가율' },
    { k: '영업이익률', v: num(opm, '%', 100), x: '수익성' },
    { k: '배당수익률', v: num(divPct, '%', 1, 2), x: '연환산' },
    { k: '컨센서스 목표가', v: tgt ? fmtPx(tgt, kr) : '-', x: (tgt && px) ? ('상승여력 ' + (((tgt - px) / px * 100 >= 0 ? '+' : '') + ((tgt - px) / px * 100).toFixed(1)) + '%') : '' },
  ];
  if (pos != null) metrics.push({ k: '52주 위치', v: pos + '%', x: '저점' + fmtPx(lo, kr) + ' ~ 고점' + fmtPx(hi, kr), bar: pos });

  // 개요
  let overview;
  if (ap.longBusinessSummary) {
    let ko = await translate(ap.longBusinessSummary);
    const parts = ko.replace(/。/g, '.').split('. ').slice(0, 2).join('. ').trim();
    overview = parts + (parts.endsWith('.') ? '' : '.');
    if (sector) overview += ' (업종: ' + sector + (industry ? ' · ' + industry : '') + ')';
  } else {
    overview = sector ? ('업종: ' + sector + (industry ? ' · ' + industry : '')) : '회사 개요 데이터가 아직 수집되지 않았습니다.';
  }

  // 밸류체인(섹터 템플릿)
  const stages = SECTOR_CHAIN[sector] || DEFAULT_CHAIN;
  const chain = [
    { h: stages[0], nodes: [['공급망', '소재·부품·인프라']] },
    { h: stages[1], nodes: [[name, industry || '핵심 사업']] },
    { h: stages[2], nodes: [['주력 제품·서비스', '']] },
    { h: stages[3], nodes: [['최종 수요·고객', sector || '시장']] },
  ];

  // 연관종목(추천 유사종목)
  let rel = {};
  try {
    const u = 'https://query2.finance.yahoo.com/v6/finance/recommendationsbysymbol/' + encodeURIComponent(sym);
    const r = await fetch(u, { headers: { 'User-Agent': UA } });
    const d = await r.json();
    const recs = (((d.finance || {}).result || [{}])[0].recommendedSymbols || []).map((x) => [x.symbol, '']).filter((a) => a[0]).slice(0, 6);
    if (recs.length) rel['유사·연관 종목'] = recs;
  } catch (e) { /* ignore */ }
  if (sector) rel['동일 섹터'] = [[sector, '']];
  if (!Object.keys(rel).length) rel = { '연관 종목': [['데이터 수집 중', '']] };

  // 전문가 리포트(데이터 기반 자동)
  const bull = [], bear = [];
  if (per != null && per < 15) bull.push('밸류에이션 매력(PER ' + per.toFixed(1) + ')');
  if (pos != null && pos < 35) bull.push('52주 저점권(현 위치 ' + pos + '%) — 낙폭 과대 가능');
  if (pos != null && pos > 75) bear.push('52주 고점권(현 위치 ' + pos + '%) — 단기 과열 주의');
  if (per != null && per > 45) bear.push('높은 밸류에이션(PER ' + per.toFixed(1) + ') — 실적 민감');
  if (pbr != null && pbr > 6) bear.push('PBR ' + pbr.toFixed(1) + ' 고평가 구간');
  if (!bull.length) bull.push('실적·모멘텀 데이터 보강 중');
  if (!bear.length) bear.push('거시·수급 변동성 모니터링');
  const rep = {
    op: 'op-hold', opTxt: '분석 보강중', desk: '리서치 데스크', asof: ASOF,
    thesis: name + '은(는) ' + (sector || '해당') + ' 섹터 종목으로 현재 밸류에이션은 ' + (perNote(per) || '평가 중') +
      ' 수준입니다. 핵심 정성 분석(밸류체인·투자논거)은 리서치 데스크가 순차 보강하며, 투자지표·개요는 실시간 데이터로 자동 생성됩니다.',
    bull, bear,
    cat: ['분기 실적 발표', '섹터 업황·정책 이벤트'],
    risk: '자동 생성 리포트 — 정성 분석 보강 전까지는 참고용. 분할·소액 접근 권장.',
  };

  return resp({
    name, mk: kr ? 'KR' : 'US', sym,
    px: px || 0, pct, asof: ASOF, curated: false,
    overview, metrics, chain, rel, rep,
  });
};

function resp(obj) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
    body: JSON.stringify(obj),
  };
}
