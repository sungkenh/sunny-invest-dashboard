// 상단 지표 15종 실시간 — /api/market  (야후 chart API + 美재무부 2년물 CSV)
// 방문 시점에 직접 수집. 모듈 캐시(60s) + 엣지 캐시로 함수 호출 최소화.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const SYMS = {
  kospi: '^KS11', ewy: 'EWY', kosdaq: '^KQ11', spx: '^GSPC', ndx: '^NDX', ndxfut: 'NQ=F', sox: '^SOX',
  btc: 'BTC-USD', gold: 'GC=F', wti: 'CL=F', ust10y: '^TNX',
  usdkrw: 'KRW=X', usdjpy: 'JPY=X', vix: '^VIX',
};
let CACHE = { ts: 0, data: null };
const TTL = 60 * 1000;

// 장중 1일 5분봉 — 현재가·등락 + 스파크라인 시계열(sp)을 한 번에
async function chartQuote(sym) {
  const u = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?interval=5m&range=1d';
  const r = await fetch(u, { headers: { 'User-Agent': UA } });
  const d = await r.json();
  const res = d && d.chart && d.chart.result && d.chart.result[0];
  const m = res && res.meta;
  if (!m || typeof m.regularMarketPrice !== 'number') throw new Error('no data');
  const price = m.regularMarketPrice;
  const pc = (typeof m.chartPreviousClose === 'number') ? m.chartPreviousClose
    : (typeof m.previousClose === 'number' ? m.previousClose : price);
  let sp = [];
  try {
    const closes = res.indicators.quote[0].close || [];
    sp = downsample(closes, 40);
  } catch (e) { /* 시계열 없으면 sp 생략 */ }
  return { price: round(price, 4), chg: round(price - pc, 4), pct: pc ? round((price - pc) / pc * 100, 2) : 0, sp };
}

// 시계열을 스파크라인용 ~N점으로 균등 다운샘플(마지막=최신가 포함)
function downsample(arr, n) {
  const a = (arr || []).filter((v) => typeof v === 'number' && isFinite(v));
  if (a.length <= n) return a.map((v) => round(v, 4));
  const out = [], step = (a.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) out.push(round(a[Math.round(i * step)], 4));
  return out;
}

async function treasury2y() {
  const yr = new Date().getUTCFullYear();
  const u = 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/'
    + yr + '/all?type=daily_treasury_yield_curve&field_tdr_date_value=' + yr + '&page&_format=csv';
  const r = await fetch(u, { headers: { 'User-Agent': UA } });
  const txt = (await r.text()).trim();
  const rows = txt.split(/\r?\n/).map((line) => line.split(','));
  const hdr = rows[0].map((c) => c.trim().replace(/^"|"$/g, ''));
  const i2 = hdr.indexOf('2 Yr');
  if (i2 < 0 || rows.length < 2) throw new Error('no 2yr');
  const last = parseFloat(rows[1][i2]);
  const prev = rows.length > 2 ? parseFloat(rows[2][i2]) : last;
  // 2년물은 장중 틱이 없어 최근 ~24거래일 일별 추이로 스파크라인(과거→최신)
  const sp = [];
  for (let i = Math.min(rows.length - 1, 24); i >= 1; i--) {
    const v = parseFloat(rows[i][i2]);
    if (!isNaN(v)) sp.push(round(v, 3));
  }
  return { price: round(last, 3), chg: round(last - prev, 3), pct: prev ? round((last - prev) / prev * 100, 2) : 0, sp };
}

exports.handler = async () => {
  if (CACHE.data && Date.now() - CACHE.ts < TTL) return ok(CACHE.data);
  const res = {};
  await Promise.all(Object.entries(SYMS).map(async ([k, s]) => {
    try { res[k] = { sym: s, ...(await chartQuote(s)) }; }
    catch (e) { res[k] = { sym: s, error: String(e).slice(0, 60) }; }
  }));
  try { res.ust2y = { sym: 'UST2Y', ...(await treasury2y()) }; }
  catch (e) { res.ust2y = { sym: 'UST2Y', error: String(e).slice(0, 60) }; }
  res._updated = new Date().toISOString().slice(0, 19);
  CACHE = { ts: Date.now(), data: res };
  return ok(res);
};

function round(x, n) { const p = Math.pow(10, n); return Math.round(x * p) / p; }
function ok(obj) {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=15',
      'Netlify-CDN-Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
    },
    body: JSON.stringify(obj),
  };
}
