// 상단 지표 14종 — /api/market  (거의 실시간)
//  · 미국 지수·금리·원자재·USD/JPY : CNBC 견적(quote.htm, 실시간/근실시간)
//  · 코스피·코스닥·USD/KRW          : 네이버 금융 실시간(국내 delayTime 0)
//  · 비트코인                       : 프런트가 Binance 실시간으로 전담
//  · 역레포(ON RRP)                 : NY연준(일별)
// yfinance(약 15분 지연) 대비 지연 최소화. 스파크라인은 프런트가 스냅샷 시드 + 실시간 틱 누적.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
let CACHE = { ts: 0, data: null };
const TTL = 15 * 1000;            // 15초(엣지캐시 30초) — 거의 실시간

function round(x, n) { const p = Math.pow(10, n); return Math.round(x * p) / p; }
function pnum(v) { const f = parseFloat(String(v == null ? '' : v).replace(/,/g, '')); return isFinite(f) ? f : null; }

// ── CNBC: 미국 지수·금리·원자재·USD/JPY (한 번에 배치 조회) ──────────────
const CNBC_MAP = {
  '.SPX': 'spx', '.NDX': 'ndx', '.SOX': 'sox', '.VIX': 'vix',
  'US10Y': 'ust10y', 'US2Y': 'ust2y', '@GC.1': 'gold', '@CL.1': 'wti', 'JPY=': 'usdjpy',
};
async function cnbcQuotes() {
  const syms = Object.keys(CNBC_MAP).join('|');
  const u = 'https://quote.cnbc.com/quote-html-webservice/quote.htm?symbols=' + encodeURIComponent(syms) + '&output=json';
  const r = await fetch(u, { headers: { 'User-Agent': UA } });
  const j = await r.json();
  let qr = ((j.QuickQuoteResult || {}).QuickQuote) || [];
  if (!Array.isArray(qr)) qr = [qr];
  const out = {};
  for (const q of qr) {
    const key = CNBC_MAP[q.symbol]; if (!key) continue;
    const last = pnum(q.last), prev = pnum(q.previous_day_closing);
    let chg = pnum(q.change);
    if (last == null) continue;
    if (chg == null && prev != null) chg = last - prev;
    // pct는 prev 기준으로 직접 산출(CNBC change_pct가 금리에서 부호 불일치하는 경우 보정)
    const pct = (prev != null && prev !== 0) ? (chg / prev * 100) : pnum(q.change_pct);
    out[key] = { price: round(last, 4), chg: round(chg || 0, 4), pct: round(pct || 0, 2), asof: q.last_time || '' };
  }
  return out;
}

// ── 네이버 금융: 국내 지수(실시간) ──────────────────────────────────────
async function naverIndex(code, key) {
  const u = 'https://polling.finance.naver.com/api/realtime/domestic/index/' + code;
  const r = await fetch(u, { headers: { 'User-Agent': UA } });
  const j = await r.json();
  const d = ((j.datas || [])[0]) || null;
  if (!d) throw new Error('naver ' + code);
  const price = pnum(d.closePriceRaw != null ? d.closePriceRaw : d.closePrice);
  const chg = pnum(d.compareToPreviousClosePriceRaw != null ? d.compareToPreviousClosePriceRaw : d.compareToPreviousClosePrice);
  const pct = pnum(d.fluctuationsRatioRaw != null ? d.fluctuationsRatioRaw : d.fluctuationsRatio);
  if (price == null) throw new Error('naver price ' + code);
  return { [key]: { price: round(price, 2), chg: round(chg || 0, 2), pct: round(pct || 0, 2), asof: d.localTradedAt || '' } };
}

// ── 네이버 금융: USD/KRW(하나은행 고시, 실시간) ─────────────────────────
async function naverUsdKrw() {
  const u = 'https://m.stock.naver.com/front-api/marketIndex/productDetail?category=exchange&reutersCode=FX_USDKRW';
  const r = await fetch(u, { headers: { 'User-Agent': UA } });
  const j = await r.json();
  const d = (j.result) || {};
  const price = pnum(d.calcPrice != null ? d.calcPrice : d.closePrice);
  if (price == null) throw new Error('naver usdkrw');
  let chg = Math.abs(pnum(d.fluctuations) || 0), pct = Math.abs(pnum(d.fluctuationsRatio) || 0);
  const t = (d.fluctuationsType || {}); const dir = (t.name || t.code || t.text || '') + '';
  if (/FALL|하락|^5$/i.test(dir)) { chg = -chg; pct = -pct; }
  return { usdkrw: { price: round(price, 2), chg: round(chg, 2), pct: round(pct, 2), asof: d.localTradedAt || '' } };
}

// ── 미국 익일물 역레포(ON RRP) 잔고 — NY연준 공개 API. 단위: 10억$ ───────
async function reverseRepo() {
  const u = 'https://markets.newyorkfed.org/api/rp/reverserepo/all/results/last/30.json';
  const r = await fetch(u, { headers: { 'User-Agent': UA } });
  const d = await r.json();
  const ops = (d && d.repo && d.repo.operations) || [];
  const byDate = new Map();
  for (const o of ops) {
    if (o.operationType !== 'Reverse Repo' || o.operationMethod !== 'Fixed Rate') continue;
    const amt = Number(o.totalAmtAccepted);
    if (!isFinite(amt) || byDate.has(o.operationDate)) continue;
    byDate.set(o.operationDate, amt);
  }
  const dated = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  if (!dated.length) throw new Error('no rrp');
  const bil = dated.map(([, v]) => v / 1e9);
  const last = bil[bil.length - 1], prev = bil.length > 1 ? bil[bil.length - 2] : last;
  return { price: round(last, 3), chg: round(last - prev, 3), pct: prev ? round((last - prev) / prev * 100, 2) : 0, date: dated[dated.length - 1][0] };
}

exports.handler = async () => {
  if (CACHE.data && Date.now() - CACHE.ts < TTL) return ok(CACHE.data);
  const res = {};
  await Promise.all([
    cnbcQuotes().then((o) => Object.assign(res, o)).catch(() => {}),
    naverIndex('KOSPI', 'kospi').then((o) => Object.assign(res, o)).catch(() => {}),
    naverIndex('KOSDAQ', 'kosdaq').then((o) => Object.assign(res, o)).catch(() => {}),
    naverUsdKrw().then((o) => Object.assign(res, o)).catch(() => {}),
    reverseRepo().then((o) => { res.rrp = Object.assign({ sym: 'ON RRP' }, o); }).catch(() => {}),
  ]);
  res._updated = new Date().toISOString().slice(0, 19);
  res._src = 'CNBC · 네이버금융 · NY연준';
  CACHE = { ts: Date.now(), data: res };
  return ok(res);
};

function ok(obj) {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=10',
      'Netlify-CDN-Cache-Control': 'public, s-maxage=30, stale-while-revalidate=120',
    },
    body: JSON.stringify(obj),
  };
}
