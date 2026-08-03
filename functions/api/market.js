// 상단 지표 15종 실시간 — /api/market
// 국내 지수·미국채 10/2년물은 네이버 시장지표 우선(신선도), 야후 chart API 폴백.
// 2년물 스파크라인·최종 폴백은 美재무부 일일 CSV. 모듈 캐시(60s) + 엣지 캐시.
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

// 국내 지수는 네이버 실시간(지연 0분) 우선 — 야후는 약 15분 지연. (해외 IP 차단 시 야후 폴백)
const NAVER_CODE = { kospi: 'KOSPI', kosdaq: 'KOSDAQ' };
async function naverIndex(code) {
  const r = await fetch('https://polling.finance.naver.com/api/realtime/domestic/index/' + code,
    { headers: { 'User-Agent': UA, 'Referer': 'https://finance.naver.com/sise/' } });
  if (!r.ok) throw new Error('naver ' + r.status);
  const j = await r.json(); const row = j.datas[0];
  // ⚠️ 네이버 Raw 필드(compareToPreviousClosePriceRaw·fluctuationsRatioRaw)는 이미 부호 포함(하락이면 음수).
  //    별도 부호를 곱하면 하락장에서 +/−가 뒤집힘 → 그대로 사용한다.
  return {
    price: round(+row.closePriceRaw, 4), chg: round(+row.compareToPreviousClosePriceRaw, 4),
    pct: round(+row.fluctuationsRatioRaw, 2), delay: +((row.stockExchangeType || {}).delayTime || 0),
  };
}

// 시계열을 스파크라인용 ~N점으로 균등 다운샘플(마지막=최신가 포함)
function downsample(arr, n) {
  const a = (arr || []).filter((v) => typeof v === 'number' && isFinite(v));
  if (a.length <= n) return a.map((v) => round(v, 4));
  const out = [], step = (a.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) out.push(round(a[Math.round(i * step)], 4));
  return out;
}

// 네이버 시장지표 productDetail — 채권·환율·원자재 공용 (yieldgap.js 검증 엔드포인트).
// 카테고리 슬러그가 상품군마다 달라 후보를 순차 시도한다.
async function naverMI(cats, rc) {
  let lastErr = null;
  for (const cat of cats) {
    try {
      const u = 'https://m.stock.naver.com/front-api/marketIndex/productDetail?category=' + cat
        + '&reutersCode=' + encodeURIComponent(rc);
      const r = await fetch(u, { headers: { 'User-Agent': UA, 'Referer': 'https://m.stock.naver.com/' } });
      const d = await r.json();
      const v = d && d.result;
      // ⚠️ 값이 천단위 콤마 문자열("1,385.50")로 온다 — parseFloat 는 콤마에서 잘려 1이 되므로 반드시 제거
      const num = (x) => parseFloat(String(x == null ? '' : x).replace(/,/g, ''));
      const px = v && num(v.closePrice);
      if (!isFinite(px)) throw new Error('no data');
      // 등락 필드명은 화면 버전에 따라 달라 방어적으로 조회 (Raw 계열은 부호 포함)
      const chg = num([v.compareToPreviousClosePrice, v.fluctuations, v.changeValue, v.compareToPreviousPrice]
        .find((x) => x != null && isFinite(num(x))));
      const pct = num([v.fluctuationsRatio, v.changeRate].find((x) => x != null && isFinite(num(x))));
      return { price: round(px, 4), chg: isFinite(chg) ? round(chg, 4) : null, pct: isFinite(pct) ? round(pct, 2) : null };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('naver mi fail ' + rc);
}
const naverBond = (rc) => naverMI(['bond'], rc);
// 네이버 월드스톡 기본 시세 — 나스닥100 선물(NQcv1, 미니) 등 futures/stock 공용
async function naverWorldBasic(rc) {
  const u = 'https://api.stock.naver.com/stock/' + encodeURIComponent(rc) + '/basic';
  const r = await fetch(u, { headers: { 'User-Agent': UA, 'Referer': 'https://m.stock.naver.com/' } });
  const v = await r.json();
  const num = (x) => parseFloat(String(x == null ? '' : x).replace(/,/g, ''));
  const px = num(v && v.closePrice);
  if (!isFinite(px)) throw new Error('no basic ' + rc);
  const pct = num(v.fluctuationsRatio);
  let chg = num(v.compareToPreviousClosePrice);
  if (isFinite(chg) && isFinite(pct) && pct < 0 && chg > 0) chg = -chg;   // 등락폭 부호 결손 방어
  return { price: round(px, 4), chg: isFinite(chg) ? round(chg, 4) : null, pct: isFinite(pct) ? round(pct, 2) : null };
}
// 네이버 우선 지표: 미국채·환율·금·WTI (실패 시 야후 폴백 — 지수·선물·BTC·VIX 는 야후 유지)
const NAVER_MI = {
  ust10y: { cats: ['bond'], rc: 'US10YT=RR' },
  usdkrw: { cats: ['exchange'], rc: 'FX_USDKRW' },
  usdjpy: { cats: ['worldExchange', 'exchange'], rc: 'FX_USDJPY' },   // 달러/엔은 국제 환율 분류
  gold:   { cats: ['metals', 'gold'], rc: 'CMDT_GC' },
  wti:    { cats: ['oil', 'energy'], rc: 'OIL_CL' },
};

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

async function __cfHandler(event) {
  if (CACHE.data && Date.now() - CACHE.ts < TTL) return ok(CACHE.data);
  const res = {};
  await Promise.all(Object.entries(SYMS).map(async ([k, s]) => {
    // 국내 지수: 네이버 실시간(가격·등락) + 야후 스파크라인. 실패 시 야후 전체로 폴백.
    if (NAVER_CODE[k]) {
      try {
        const [nv, ch] = await Promise.all([naverIndex(NAVER_CODE[k]), chartQuote(s).catch(() => null)]);
        res[k] = { sym: s, price: nv.price, chg: nv.chg, pct: nv.pct, sp: (ch && ch.sp) || [], src: 'naver', delay: nv.delay };
        return;
      } catch (e) { /* 야후 폴백 */ }
    }
    // 나스닥100 선물: 네이버 미니 나스닥100 선물(NQcv1) 우선 + 야후 NQ=F 스파크라인/폴백
    if (k === 'ndxfut') {
      try {
        const [nb, ch] = await Promise.all([naverWorldBasic('NQcv1'), chartQuote(s).catch(() => null)]);
        res[k] = { sym: s, price: nb.price,
          chg: nb.chg != null ? nb.chg : (ch ? ch.chg : null),
          pct: nb.pct != null ? nb.pct : (ch ? ch.pct : 0),
          sp: (ch && ch.sp) || [], src: 'naver' };
        return;
      } catch (e) { /* 야후 폴백 */ }
    }
    // 미국채·환율·금·WTI: 네이버 시장지표 우선(가격·등락) + 야후 스파크라인. 실패 시 야후 전체로 폴백.
    if (NAVER_MI[k]) {
      try {
        const [nb, ch] = await Promise.all([naverMI(NAVER_MI[k].cats, NAVER_MI[k].rc), chartQuote(s).catch(() => null)]);
        res[k] = { sym: s, price: nb.price,
          chg: nb.chg != null ? nb.chg : (ch ? ch.chg : null),
          pct: nb.pct != null ? nb.pct : (ch ? ch.pct : 0),
          sp: (ch && ch.sp) || [], src: 'naver' };
        return;
      } catch (e) { /* 야후 폴백 */ }
    }
    try { res[k] = { sym: s, ...(await chartQuote(s)), src: 'yahoo' }; }
    catch (e) { res[k] = { sym: s, error: String(e).slice(0, 60) }; }
  }));
  // 미국채 2년: 네이버 시장지표 우선(재무부 CSV는 하루 지연) + 재무부 일별 시계열(스파크라인·폴백)
  {
    const [nb, tr] = await Promise.all([naverBond('US2YT=RR').catch(() => null), treasury2y().catch(() => null)]);
    if (nb) {
      // 장중엔 재무부 최신 확정치 = 어제 종가 → 등락 폴백 기준으로 사용
      const prevDaily = tr ? tr.price : null;
      res.ust2y = { sym: 'UST2Y', price: nb.price,
        chg: nb.chg != null ? nb.chg : (prevDaily != null ? round(nb.price - prevDaily, 3) : null),
        pct: nb.pct != null ? nb.pct : (prevDaily ? round((nb.price - prevDaily) / prevDaily * 100, 2) : null),
        sp: (tr && tr.sp) || [], src: 'naver' };
    } else if (tr) {
      res.ust2y = { sym: 'UST2Y', ...tr, src: 'treasury' };
    } else {
      res.ust2y = { sym: 'UST2Y', error: 'naver+treasury fail' };
    }
  }
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
