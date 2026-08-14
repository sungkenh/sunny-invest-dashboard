// 일드갭: /api/yieldgap
// 자산군 기대수익률(연%): 안전자산(국채 10Y) · 위험자산(주식 어닝일드=1/PER) · 실물자산(리츠 배당)
// + 일드갭(주식 어닝일드 − 국채금리). 한·미. 슬로무빙 매크로 지표(캐시 길게).
// 데이터: 국채=Naver, 美주식 어닝일드=multpl.com, 美리츠=Yahoo(VNQ). 韓주식/리츠는 추정치(무료 라이브 소스 부재).
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
let CACHE = { ts: 0, data: null };
const TTL = 30 * 60 * 1000;   // 30분

// 한국 추정치: 무료 라이브 소스 부재로 주기 업데이트(라벨 '추정' 표시). KOSPI 어닝일드=100/PER.
// 2026-08-03 갱신: AI 이익 급증(12M 선행 EPS +170%)으로 KOSPI 12M 선행 PER 4.8~6.4 보도(서울경제 7/13·Investing 7월말)
const KR_KOSPI_EY_EST = 18.0;    // 선행 PER 중앙 ~5.6 → 어닝일드 ≈ 18% (선행 기준: 미국 multpl은 후행이라 기준 상이)
const KR_REIT_YIELD_EST = 7.5;   // 상장 리츠 평균 배당수익률: 2025년 7.3%, 2026년 다수 종목 8%+ (한국리츠협회)
const US_REIT_YIELD_EST = 3.6;   // VNQ 라이브 실패 시 폴백
const US_NASDAQ_EY_EST = 2.9;    // QQQ(NASDAQ-100) 라이브 실패 시 폴백 (PER ~34 → ~2.9%)

// 장기 연평균(참고·역사적, 명목·배당/임대 포함). 추세 기반 참고치. (kr:null = 해당 없음)
const LONGTERM = [
  { k: 'stock', label: '주식 (S&P500·KOSPI)', us: 10.0, kr: 8.0 },   // S&P500 ~10% / KOSPI ~8%
  { k: 'nasdaq', label: '주식 (NASDAQ100)', us: 13.0, kr: null },     // 나스닥100 ~13% (성장 프리미엄)
  { k: 'bond', label: '채권 (국채)', us: 4.5, kr: 3.5 },
  { k: 'real', label: '부동산 (리츠)', us: 8.5, kr: 5.0 },            // 美리츠 총수익 ~8.5% / 韓부동산 ~5%
];

const r2 = (x) => (x == null || isNaN(x) ? null : Math.round(x * 100) / 100);
const gap = (a, b) => (a != null && b != null ? Math.round((a - b) * 100) / 100 : null);

// 국채 수익률: Naver 마켓인덱스(productDetail, closePrice = 연%)
async function naverBond(rc) {
  const u = 'https://m.stock.naver.com/front-api/marketIndex/productDetail?category=bond&reutersCode=' + encodeURIComponent(rc);
  const r = await fetch(u, { headers: { 'User-Agent': UA } });
  const d = await r.json();
  const v = d && d.result && d.result.closePrice;
  return v != null && !isNaN(+v) ? +v : null;
}

// 미국 S&P500 어닝일드: multpl.com (meta: "Current S&P 500 Earnings Yield is X%")
async function spxEarningsYield() {
  const r = await fetch('https://www.multpl.com/s-p-500-earnings-yield', { headers: { 'User-Agent': UA } });
  const html = await r.text();
  let m = html.match(/Earnings Yield is\s*([0-9.]+)\s*%/i);
  if (m) return +m[1];
  // 폴백: PER로부터 환산
  const r3 = await fetch('https://www.multpl.com/s-p-500-pe-ratio', { headers: { 'User-Agent': UA } });
  m = (await r3.text()).match(/PE Ratio is\s*([0-9.]+)/i);
  return m && +m[1] > 0 ? r2(100 / +m[1]) : null;
}

// 미국 리츠(VNQ) 배당 + NASDAQ-100(QQQ) 어닝일드: Yahoo quoteSummary(크럼 1회 공유)
async function usYahoo() {
  try {
    const r1 = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA } });
    const ck = (r1.headers.getSetCookie ? r1.headers.getSetCookie() : [r1.headers.get('set-cookie')])
      .filter(Boolean).map((c) => c.split(';')[0]).join('; ');
    const crumb = await (await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, 'Cookie': ck } })).text();
    const summ = async (sym, mods) => {
      const u = 'https://query1.finance.yahoo.com/v10/finance/quoteSummary/' + sym + '?modules=' + mods + '&crumb=' + encodeURIComponent(crumb);
      const d = await (await fetch(u, { headers: { 'User-Agent': UA, 'Cookie': ck } })).json();
      return (d && d.quoteSummary && d.quoteSummary.result && d.quoteSummary.result[0]) || {};
    };
    const [vnq, qqq] = await Promise.all([summ('VNQ', 'summaryDetail'), summ('QQQ', 'summaryDetail,defaultKeyStatistics')]);
    const sd = vnq.summaryDetail || {};
    const y = (sd.dividendYield && sd.dividendYield.raw) || (sd.yield && sd.yield.raw) || (sd.trailingAnnualDividendYield && sd.trailingAnnualDividendYield.raw);
    const qsd = qqq.summaryDetail || {}, qks = qqq.defaultKeyStatistics || {};
    const qpe = (qsd.trailingPE && qsd.trailingPE.raw) || (qks.trailingPE && qks.trailingPE.raw);
    return { reit: y != null ? r2(y * 100) : null, ndxEY: qpe ? r2(100 / qpe) : null };
  } catch (e) { return { reit: null, ndxEY: null }; }
}

async function __cfHandler(event) {
  if (CACHE.data && Date.now() - CACHE.ts < TTL) return ok(CACHE.data);

  const [kr10, us10, spxEY, uy] = await Promise.all([
    naverBond('KR10YT=RR').catch(() => null),
    naverBond('US10YT=RR').catch(() => null),
    spxEarningsYield().catch(() => null),
    usYahoo(),
  ]);
  const usReit = uy.reit != null ? uy.reit : US_REIT_YIELD_EST;
  const usNdx = uy.ndxEY != null ? uy.ndxEY : US_NASDAQ_EY_EST;

  const us = {
    safe: { label: '국채 10년', val: r2(us10), est: us10 == null },
    stock: { label: '주식 어닝일드 (S&P500)', val: r2(spxEY), est: spxEY == null },
    nasdaq: { label: '주식 어닝일드 (NASDAQ100)', val: r2(usNdx), est: uy.ndxEY == null },
    reit: { label: '리츠 배당 (VNQ)', val: r2(usReit), est: uy.reit == null },
  };
  us.gap = gap(us.stock.val, us.safe.val);        // 헤드라인 일드갭 = S&P500 기준
  us.gapNdx = gap(us.nasdaq.val, us.safe.val);     // 나스닥100 기준(참고)
  const kr = {
    safe: { label: '국채 10년', val: r2(kr10), est: kr10 == null },
    stock: { label: '주식 어닝일드 (KOSPI)', val: KR_KOSPI_EY_EST, est: true },
    reit: { label: '리츠 배당', val: KR_REIT_YIELD_EST, est: true },
  };
  kr.gap = gap(kr.stock.val, kr.safe.val);

  const failed = us10 == null && kr10 == null && spxEY == null;   // 핵심 라이브 전부 실패
  const data = { _updated: new Date().toISOString().slice(0, 19), us, kr, longterm: LONGTERM };
  CACHE = { ts: failed ? Date.now() - (TTL - 60000) : Date.now(), data };
  return ok(data, failed);
}

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
