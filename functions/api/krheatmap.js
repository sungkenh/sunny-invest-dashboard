// 한국 주식 실시간 히트맵 — /api/krheatmap?mkt=kospi|kosdaq&n=50|100|200|500
// 네이버 시총 랭킹(실시간·delayTime 0) + 정적 업종맵(data/kr_sectors.json) 조인.
//   랭킹 응답에 ETF가 섞여 있고(코스피 top100에 14개) 우선주·스팩·거래정지도 포함되므로 반드시 필터링한다.
//   필터로 종목이 줄어들기 때문에 n개를 채우려면 페이지를 더 받아야 한다(코스피 page1 100건 → 84건만 생존).
// subrequest 예산: 랭킹 1~7 + kr_sectors.json 1 = 최대 8 (실패 시 스냅샷 +1) / Cloudflare 무료 50
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const CACHE = {};                 // `${mkt}|${n}` → {ts, data}
const TTL = 5 * 1000;             // 클라이언트 5초 폴링에 맞춤 (네이버 앱 자체 폴링은 7초)

const MKT = { kospi: 'KOSPI', kosdaq: 'KOSDAQ' };
const ALLOWED_N = [50, 100, 200, 500];

const iso = () => new Date().toISOString().slice(0, 19);

// 시총 랭킹 1페이지(최대 100건). pageSize>100은 비-JSON을 반환하므로 100 고정.
async function naverMV(market, page) {
  const u = 'https://m.stock.naver.com/api/stocks/marketValue/' + market + '?page=' + page + '&pageSize=100';
  const r = await fetch(u, { headers: { 'User-Agent': UA, 'Referer': 'https://m.stock.naver.com/' } });
  if (!r.ok) throw new Error('naver ' + market + ' p' + page + ' ' + r.status);
  const j = await r.json();
  return (j && j.stocks) || [];
}

// 히트맵 왜곡 요소 제거: ETF/ETN · 우선주 · 스팩 · 값 결손.
// ⚠ 거래정지는 제외하지 않는다 — 서킷브레이커(2026-07-11 코스피 -8%)처럼 시장 전체가 일시 정지되면
//   전 종목이 걸러져 히트맵이 비는 사고가 났다. 정지 종목은 h:1 플래그로 표시만 한다(마지막 체결가는 유효).
function dropReason(s) {
  if ((s.stockEndType || '') !== 'stock') return 'etf';            // KODEX 200, TIGER 미국S&P500 …
  const code = s.itemCode || '';
  if (code.length !== 6 || code[5] !== '0') return 'pref';         // 보통주 코드 6번째 자리는 '0'
  if (/스팩/.test(s.stockName || '')) return 'spac';
  const cap = +s.marketValueRaw, px = +s.closePriceRaw, pct = parseFloat(s.fluctuationsRatio);
  if (!(isFinite(cap) && cap > 0 && isFinite(px) && px > 0 && isFinite(pct))) return 'bad';
  return null;
}

function norm(s) {
  const it = {
    code: s.itemCode, name: s.stockName,
    mk: (s.stockExchangeType || {}).code || '',
    price: +s.closePriceRaw,
    // ⚠️ fluctuationsRatio 는 이미 부호 포함(-4.48). 별도 부호를 곱하면 하락장에서 뒤집힌다(market.js 과거 버그).
    pct: parseFloat(s.fluctuationsRatio),
    cap: +s.marketValueRaw,
  };
  const st = s.tradeStopType || {};
  if (st.code && st.code !== '1') it.h = 1;            // 거래정지(서킷브레이커·VI 포함) — 표시용
  return it;
}

// 정적 자산 조인 (CF Function은 자기 오리진의 /data/*.json 을 fetch 할 수 있다)
async function loadSectors(rawUrl) {
  try {
    const r = await fetch(new URL('/data/kr_sectors.json', rawUrl).toString());
    if (r.ok) { const j = await r.json(); return { map: (j && j.sectors) || {}, up: (j && j._updated) || null }; }
  } catch (e) { /* 없으면 전부 '기타' */ }
  return { map: {}, up: null };
}
async function loadSnapshot(rawUrl, mkt) {
  try {
    const r = await fetch(new URL('/data/krheatmap_' + mkt + '.json', rawUrl).toString());
    if (r.ok) return await r.json();
  } catch (e) { /* 폴백 실패 */ }
  return null;
}

// 필터로 종목이 깎이므로 여유 있게 페이지를 받는다
const pagesFor = (n) => (n <= 50 ? 1 : (n <= 100 ? 2 : (n <= 200 ? 3 : 7)));

async function __cfHandler(event) {
  const p = event.queryStringParameters || {};
  const mkt = (p.mkt === 'kosdaq') ? 'kosdaq' : 'kospi';
  let n = parseInt(p.n, 10);
  if (ALLOWED_N.indexOf(n) < 0) n = 100;

  const key = mkt + '|' + n;
  const c = CACHE[key];
  if (c && c.data && Date.now() - c.ts < TTL) return ok(c.data);

  const pages = pagesFor(n);
  const res = await Promise.all(
    Array.from({ length: pages }, (_, i) => naverMV(MKT[mkt], i + 1).catch(() => null))
  );
  const raw = [];
  for (const arr of res) if (arr) raw.push.apply(raw, arr);

  const drop = { etf: 0, pref: 0, spac: 0, bad: 0 };
  const seen = new Set(), items = [];
  for (const s of raw) {
    if (seen.has(s.itemCode)) continue;                 // 페이지 간 중복 제거
    const why = dropReason(s);
    if (why) { drop[why]++; continue; }
    seen.add(s.itemCode); items.push(norm(s));
  }
  items.sort((a, b) => b.cap - a.cap);
  items.length = Math.min(items.length, n);

  // 라이브 전멸 또는 필터 전량 탈락(어떤 필터 이상에도 화면이 비지 않게) → 스냅샷 → 빈결과
  if (!items.length) {
    const snap = await loadSnapshot(event.rawUrl, mkt);
    let data;
    if (snap && Array.isArray(snap.items) && snap.items.length) {
      const its = snap.items.slice(0, n);               // 스냅샷은 500종목 → 요청 n으로 자름
      data = Object.assign({}, snap, { source: 'snapshot', n, count: its.length, items: its });
    } else {
      data = { _updated: iso(), source: 'error', mkt, n, marketStatus: '', delay: 0, count: 0, items: [] };
    }
    if (raw.length) data.filtered = drop;               // 원인 판독용: 무엇이 걸러냈나
    CACHE[key] = { ts: Date.now() - (TTL - 5000), data };   // 곧 재시도
    return ok(data, true);
  }

  const sec = await loadSectors(event.rawUrl);
  for (const it of items) it.sector = sec.map[it.code] || '기타';

  const halted = items.reduce((a, i) => a + (i.h ? 1 : 0), 0);
  const data = {
    _updated: iso(), source: 'naver', mkt, n,
    marketStatus: (raw[0] || {}).marketStatus || '',
    delay: ((raw[0] || {}).stockExchangeType || {}).delayTime || 0,
    sectorsUpdated: sec.up, count: items.length,
    halted: halted || undefined,                        // 거래정지 종목 수(서킷브레이커 감지용)
    filtered: drop,
    partial: res.some((x) => !x) || undefined,          // 일부 페이지 실패
    items,
  };
  CACHE[key] = { ts: Date.now(), data };
  return ok(data);
}

function ok(obj, short) {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': short ? 'public, max-age=30' : 'public, max-age=3',
      'Netlify-CDN-Cache-Control': short ? 'public, s-maxage=30' : 'public, s-maxage=5, stale-while-revalidate=60',
    },
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
