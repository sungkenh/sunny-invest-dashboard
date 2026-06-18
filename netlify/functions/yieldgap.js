// 일드갭 — /api/yieldgap
// 자산군 기대수익률(연%): 안전자산(국채 10Y) · 위험자산(주식 어닝일드=1/PER) · 실물자산(리츠 배당)
// + 일드갭(주식 어닝일드 − 국채금리). 한·미. 슬로무빙 매크로 지표(캐시 길게).
// 데이터: 국채=Naver, 美주식 어닝일드=multpl.com, 美리츠=Yahoo(VNQ). 韓주식/리츠는 추정치(무료 라이브 소스 부재).
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
let CACHE = { ts: 0, data: null };
const TTL = 30 * 60 * 1000;   // 30분

// 한국 추정치 — 무료 라이브 소스 부재로 주기 업데이트(라벨 '추정' 표시). KOSPI 어닝일드=100/PER.
const KR_KOSPI_EY_EST = 8.7;    // KOSPI 추정 PER ~11.5 → 어닝일드 ~8.7%
const KR_REIT_YIELD_EST = 6.0;  // 국내 상장 리츠 평균 배당수익률 추정 ~6%
const US_REIT_YIELD_EST = 3.6;  // VNQ 라이브 실패 시 폴백

// 장기 연평균(참고·역사적, 명목·배당/임대 포함). 추세 기반 참고치.
const LONGTERM = [
  { k: 'stock', label: '주식', us: 10.0, kr: 8.0 },  // S&P500 ~10% / KOSPI ~8%
  { k: 'bond', label: '채권', us: 4.5, kr: 3.5 },     // 국채 장기 평균 수익률
  { k: 'real', label: '부동산', us: 8.5, kr: 5.0 },   // 美리츠 총수익 ~8.5% / 韓부동산(가격+임대) ~5%
];

const r2 = (x) => (x == null || isNaN(x) ? null : Math.round(x * 100) / 100);
const gap = (a, b) => (a != null && b != null ? Math.round((a - b) * 100) / 100 : null);

// 국채 수익률 — Naver 마켓인덱스(productDetail, closePrice = 연%)
async function naverBond(rc) {
  const u = 'https://m.stock.naver.com/front-api/marketIndex/productDetail?category=bond&reutersCode=' + encodeURIComponent(rc);
  const r = await fetch(u, { headers: { 'User-Agent': UA } });
  const d = await r.json();
  const v = d && d.result && d.result.closePrice;
  return v != null && !isNaN(+v) ? +v : null;
}

// 미국 S&P500 어닝일드 — multpl.com (meta: "Current S&P 500 Earnings Yield is X%")
async function spxEarningsYield() {
  const r = await fetch('https://www.multpl.com/s-p-500-earnings-yield', { headers: { 'User-Agent': UA } });
  const html = await r.text();
  let m = html.match(/Earnings Yield is\s*([0-9.]+)\s*%/i);
  if (m) return +m[1];
  const r3 = await fetch('https://www.multpl.com/s-p-500-pe-ratio', { headers: { 'User-Agent': UA } });
  m = (await r3.text()).match(/PE Ratio is\s*([0-9.]+)/i);
  return m && +m[1] > 0 ? r2(100 / +m[1]) : null;
}

// 미국 리츠(VNQ) 배당수익률 — Yahoo quoteSummary(크럼 인증)
async function vnqYield() {
  try {
    const r1 = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA } });
    const ck = (r1.headers.getSetCookie ? r1.headers.getSetCookie() : [r1.headers.get('set-cookie')])
      .filter(Boolean).map((c) => c.split(';')[0]).join('; ');
    const crumb = await (await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, 'Cookie': ck } })).text();
    const u = 'https://query1.finance.yahoo.com/v10/finance/quoteSummary/VNQ?modules=summaryDetail&crumb=' + encodeURIComponent(crumb);
    const d = await (await fetch(u, { headers: { 'User-Agent': UA, 'Cookie': ck } })).json();
    const sd = d && d.quoteSummary && d.quoteSummary.result && d.quoteSummary.result[0] && d.quoteSummary.result[0].summaryDetail;
    const y = sd && ((sd.dividendYield && sd.dividendYield.raw) || (sd.yield && sd.yield.raw) || (sd.trailingAnnualDividendYield && sd.trailingAnnualDividendYield.raw));
    return y != null ? r2(y * 100) : null;
  } catch (e) { return null; }
}

exports.handler = async () => {
  if (CACHE.data && Date.now() - CACHE.ts < TTL) return ok(CACHE.data);

  const [kr10, us10, spxEY, vnq] = await Promise.all([
    naverBond('KR10YT=RR').catch(() => null),
    naverBond('US10YT=RR').catch(() => null),
    spxEarningsYield().catch(() => null),
    vnqYield(),
  ]);
  const usReit = vnq != null ? vnq : US_REIT_YIELD_EST;

  const us = {
    safe: { label: '국채 10년', val: r2(us10), est: us10 == null },
    stock: { label: '주식 어닝일드 (S&P500)', val: r2(spxEY), est: spxEY == null },
    reit: { label: '리츠 배당 (VNQ)', val: r2(usReit), est: vnq == null },
  };
  us.gap = gap(us.stock.val, us.safe.val);
  const kr = {
    safe: { label: '국채 10년', val: r2(kr10), est: kr10 == null },
    stock: { label: '주식 어닝일드 (KOSPI)', val: KR_KOSPI_EY_EST, est: true },
    reit: { label: '리츠 배당', val: KR_REIT_YIELD_EST, est: true },
  };
  kr.gap = gap(kr.stock.val, kr.safe.val);

  const failed = us10 == null && kr10 == null && spxEY == null;
  const data = { _updated: new Date().toISOString().slice(0, 19), us, kr, longterm: LONGTERM };
  CACHE = { ts: failed ? Date.now() - (TTL - 60000) : Date.now(), data };
  return ok(data, failed);
};

function cors() { return { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }; }
function ok(obj, short) {
  const mx = short ? 60 : 600, sm = short ? 60 : 1800;
  return {
    statusCode: 200,
    headers: Object.assign(cors(), {
      'Cache-Control': 'public, max-age=' + mx,
      'Netlify-CDN-Cache-Control': 'public, s-maxage=' + sm + ', stale-while-revalidate=3600',
    }),
    body: JSON.stringify(obj),
  };
}
