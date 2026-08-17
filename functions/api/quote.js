// 실시간 시세: /api/quote?syms=AAPL,005930.KS
// 국내: 네이버 폴링 API(지연 0: 야후 .KS 는 하루 지연이라 개장 직후에도 전일 등락률이 나왔다) 실시간 체결가 +
//       시간외 overMarketPriceInfo(NXT 프리마켓 08:00~08:50 · 애프터마켓 15:40~20:00, KRX 시간외 단일가 포함).
// 미국: 야후 5분봉 includePrePost 마지막 체결(프리·애프터 포함).
// 응답 {price, pct, ext?:'pre'|'post', rp?, src}: rp 는 직전 정규장 종가(시간외일 때 판정 기준가).
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
// 접미사 없는 6자리 코드도 받는다: 관심종목이 예전 형식(코드만)으로 저장돼 있어도 시세가 나와야 한다.
// 이때 응답의 ex(KS|KQ)로 클라이언트가 저장된 심볼을 스스로 고칠 수 있다.
const KR_RE = /^(\d{6})(?:\.(KS|KQ))?$/;
const r2 = (x) => Math.round(x * 100) / 100;

/*KR-BEGIN*/
// 국내 시간외 창(KST). NXT 프리마켓 08:00~08:50 · 애프터마켓 15:40~20:00 이지만, 마감 직후 마지막 체결도
// 그 세션의 가격이므로 창을 조금 넓게(09:00 · 20:30) 잡는다. 정규장(09:00~15:30)에는 시간외가 없다.
function krExtWindow(nowMs) {
  const k = new Date(nowMs + 9 * 3600 * 1000);          // KST 벽시계 (UTC 게터로 읽는다)
  const dow = k.getUTCDay();
  if (dow === 0 || dow === 6) return null;
  const min = k.getUTCHours() * 60 + k.getUTCMinutes();
  if (min >= 480 && min < 540) return 'pre';            // 08:00~09:00
  if (min >= 940 && min < 1230) return 'post';          // 15:40~20:30
  return null;
}

const krNum = (x) => parseFloat(String(x == null ? '' : x).replace(/,/g, ''));

// 네이버 방향 코드: 1 상한·2 상승 / 3 보합 / 4 하한·5 하락.
// ⚠ fluctuationsRatio 에 부호가 들어있는지는 엔드포인트마다 다르다(과거 market.js 등락 역전 사고).
//   그래서 비율은 항상 절대값을 쓰고 방향 코드로 부호를 붙인다.
function krDir(o) {
  const c = String(((o || {}).compareToPreviousPrice || {}).code || '');
  return (c === '4' || c === '5') ? -1 : (c === '3' ? 0 : 1);
}

// 폴링 응답 1행 → {price, pct, ext?, rp?}. win 은 krExtWindow 결과(없으면 정규장·야간).
// 시간외 등락률은 부호 규약에 기대지 않고 직전 정규장 종가 대비로 직접 계산한다.
function krPick(row, win) {
  if (!row) return null;
  const close = krNum(row.closePriceRaw || row.closePrice);
  if (!(close > 0)) return null;
  // 코스피/코스닥 구분: 코드만 저장된 관심종목의 심볼 복구용
  const exc = String(((row.stockExchangeType || {}).code) || '').toUpperCase();
  const ex = (exc === 'KS' || exc === 'KQ') ? exc : null;
  const o = row.overMarketPriceInfo;
  const over = o ? krNum(o.overPrice) : NaN;
  if (win && over > 0) {
    const ses = String(o.tradingSessionType || '');
    // 세션 표기가 창과 어긋나면(예: 애프터 창인데 아침 프리마켓 값이 남아 있음) 시간외로 쓰지 않는다.
    const kind = /PRE/i.test(ses) ? 'pre' : (ses ? 'post' : win);
    if (kind === win) {
      const q = { price: r2(over), pct: r2((over - close) / close * 100), ext: kind, rp: r2(close) };
      if (ex) q.ex = ex;
      return q;
    }
  }
  // 정규장 체결이 있을 때만 네이버 값을 쓴다: 장 시작 전(PREOPEN)에는 등락률이 0 으로 초기화돼
  // 전일 등락이 사라진다. 그 구간은 야후(전일 종가·전일 등락)로 넘긴다.
  const op = String(row.openPriceRaw != null && row.openPriceRaw !== '' ? row.openPriceRaw : row.openPrice || '').trim();
  if (op && op !== '-' && krNum(op) > 0) {
    const q = { price: r2(close), pct: r2(Math.abs(krNum(row.fluctuationsRatio)) * krDir(row)) };
    if (ex) q.ex = ex;
    return q;
  }
  return null;
}
/*KR-END*/

// 폴링 API 는 콤마로 다종목을 한 번에 준다(운영 프로브 확인): 관심종목 20개도 subrequest 1회.
const KR_BATCH = 20;
async function krRows(codes) {
  const u = 'https://polling.finance.naver.com/api/realtime/domestic/stock/' + codes.join(',');
  const r = await fetch(u, { headers: { 'User-Agent': UA, 'Referer': 'https://m.stock.naver.com/' } });
  if (!r.ok) throw new Error('naver ' + r.status);
  const d = await r.json();
  const by = {};
  for (const row of ((d && d.datas) || [])) if (row && row.itemCode) by[row.itemCode] = row;
  return by;                              // 상장폐지·통합된 코드는 아예 빠져 나온다(rows=0) → 야후 폴백
}

// 야후 chart API (crumb 불필요). 미국은 프리·애프터 체결까지, 국내는 정규장 시세.
async function yQuote(s) {
  const us = !KR_RE.test(s);
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(s)
    + (us ? '?interval=5m&range=1d&includePrePost=true' : '?interval=1d&range=1d');
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  const d = await r.json();
  const res0 = d && d.chart && d.chart.result && d.chart.result[0];
  const m = res0 && res0.meta;
  if (!m || typeof m.regularMarketPrice !== 'number') throw new Error('no data');
  let price = m.regularMarketPrice, ext = null;
  if (us) {
    const ts = res0.timestamp || [];
    const cl = ((res0.indicators && res0.indicators.quote && res0.indicators.quote[0]) || {}).close || [];
    let lastT = 0;
    for (let i = 0; i < cl.length; i++) if (cl[i] != null) { price = cl[i]; lastT = ts[i] || 0; }
    const reg = ((m.currentTradingPeriod || {}).regular) || {};
    if (lastT && reg.start && lastT < reg.start) ext = 'pre';
    else if (lastT && reg.end && lastT >= reg.end) ext = 'post';
  }
  const pc = (typeof m.chartPreviousClose === 'number') ? m.chartPreviousClose
    : (typeof m.previousClose === 'number' ? m.previousClose : price);
  // 시간외 등락은 직전 정규장 종가 대비다. 야후의 previousClose 는 그보다 한 세션 더 뒤라,
  // 프리마켓에 쓰면 직전 정규장 상승분까지 얹혀 이틀치 등락이 나온다
  // (SNDK 프리 1727.71: 정규장 종가 1641.11 대비 +5.28%인데 전전 종가 1528.11 대비로는 +13.06%).
  // 국내(네이버)는 이미 당일 종가 대비로 계산하므로 미국만 기준을 맞춘다.
  const rp = m.regularMarketPrice;
  const base = (ext && typeof rp === 'number' && rp > 0) ? rp : pc;
  const out = { price: r2(price), pct: base ? r2((price - base) / base * 100) : 0, src: 'yahoo' };
  if (ext) { out.ext = ext; out.rp = r2(rp); out.rpct = pc ? r2((rp - pc) / pc * 100) : 0; }
  return out;
}

async function __cfHandler(event) {
  const syms = (((event.queryStringParameters || {}).syms || '')
    .split(',').map((s) => s.trim()).filter(Boolean)).slice(0, 25);
  const win = krExtWindow(Date.now());
  const res = {};

  // 1) 국내는 네이버 폴링 배치로 한 번에: 20종목당 subrequest 1회.
  const krCodes = [];
  for (const s of syms) { const m = s.match(KR_RE); if (m) krCodes.push(m[1]); }
  let rows = {};
  if (krCodes.length) {
    const chunks = [];
    for (let i = 0; i < krCodes.length; i += KR_BATCH) chunks.push(krCodes.slice(i, i + KR_BATCH));
    const got = await Promise.all(chunks.map((c) => krRows(c).catch(() => ({}))));
    for (const g of got) Object.assign(rows, g);
  }

  // 2) 네이버가 못 준 국내 종목(장 시작 전 미체결·폐지 코드)과 미국 종목은 야후로.
  const needY = [];
  for (const s of syms) {
    const m = s.match(KR_RE);
    const q = m ? krPick(rows[m[1]], win) : null;
    if (q) { q.src = 'naver'; res[s] = q; } else needY.push(s);
  }
  await Promise.all(needY.map(async (s) => {
    try { res[s] = await yQuote(s); }
    catch (e) { res[s] = { error: String(e).slice(0, 40) }; }
  }));
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
    body: JSON.stringify(res),
  };
};


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
