// 한국 주식 실시간 히트맵 — /api/krheatmap?mkt=kospi|kosdaq&n=50|100|200
// 네이버 시총 랭킹(실시간·delayTime 0) + 정적 업종맵(data/kr_sectors.json) 조인.
//   랭킹 응답에 ETF가 섞여 있고(코스피 top100에 14개) 우선주·스팩·거래정지도 포함되므로 반드시 필터링한다.
//   필터로 종목이 줄어들기 때문에 n개를 채우려면 페이지를 더 받아야 한다(코스피 page1 100건 → 84건만 생존).
// subrequest 예산: 랭킹 1~3 + kr_sectors.json 1 = 최대 4 (실패 시 스냅샷 +1) / Cloudflare 무료 50
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const CACHE = {};                 // `${mkt}|${n}` → {ts, data}
const TTL = 15 * 1000;            // 네이버 pollingInterval 7초 · 엣지 s-maxage 20초와 정렬

const MKT = { kospi: 'KOSPI', kosdaq: 'KOSDAQ' };
const ALLOWED_N = [50, 100, 200];

const iso = () => new Date().toISOString().slice(0, 19);

// 시총 랭킹 1페이지(최대 100건). pageSize>100은 비-JSON을 반환하므로 100 고정.
async function naverMV(market, page) {
  const u = 'https://m.stock.naver.com/api/stocks/marketValue/' + market + '?page=' + page + '&pageSize=100';
  const r = await fetch(u, { headers: { 'User-Agent': UA, 'Referer': 'https://m.stock.naver.com/' } });
  if (!r.ok) throw new Error('naver ' + market + ' p' + page + ' ' + r.status);
  const j = await r.json();
  return (j && j.stocks) || [];
}

// 히트맵 왜곡 요소 제거: ETF/ETN · 우선주 · 스팩 · 거래정지 · 값 결손
function keep(s) {
  if ((s.stockEndType || '') !== 'stock') return false;            // KODEX 200, TIGER 미국S&P500 …
  const code = s.itemCode || '';
  if (code.length !== 6 || code[5] !== '0') return false;          // 보통주 코드 6번째 자리는 '0' (005935 삼성전자우 제외)
  if (/스팩/.test(s.stockName || '')) return false;
  const st = s.tradeStopType || {};
  if (st.code && st.code !== '1') return false;                    // '1' = 운영/Trading
  const cap = +s.marketValueRaw, px = +s.closePriceRaw, pct = parseFloat(s.fluctuationsRatio);
  return isFinite(cap) && cap > 0 && isFinite(px) && px > 0 && isFinite(pct);
}

function norm(s) {
  return {
    code: s.itemCode, name: s.stockName,
    mk: (s.stockExchangeType || {}).code || '',
    price: +s.closePriceRaw,
    // ⚠️ fluctuationsRatio 는 이미 부호 포함(-4.48). 별도 부호를 곱하면 하락장에서 뒤집힌다(market.js 과거 버그).
    pct: parseFloat(s.fluctuationsRatio),
    cap: +s.marketValueRaw,
  };
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
const pagesFor = (n) => (n <= 50 ? 1 : (n <= 100 ? 2 : 3));

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

  if (!raw.length) {                                   // 라이브 전멸 → 스냅샷 → 빈결과
    const snap = await loadSnapshot(event.rawUrl, mkt);
    let data;
    if (snap && Array.isArray(snap.items) && snap.items.length) {
      const items = snap.items.slice(0, n);             // 스냅샷은 200종목 → 요청 n으로 자름
      data = Object.assign({}, snap, { source: 'snapshot', n, count: items.length, items });
    } else {
      data = { _updated: iso(), source: 'error', mkt, n, marketStatus: '', delay: 0, count: 0, items: [] };
    }
    CACHE[key] = { ts: Date.now() - (TTL - 5000), data };   // 곧 재시도
    return ok(data, true);
  }

  const seen = new Set(), items = [];
  for (const s of raw) {
    if (!keep(s) || seen.has(s.itemCode)) continue;     // 페이지 간 중복 제거
    seen.add(s.itemCode); items.push(norm(s));
  }
  items.sort((a, b) => b.cap - a.cap);
  items.length = Math.min(items.length, n);

  const sec = await loadSectors(event.rawUrl);
  for (const it of items) it.sector = sec.map[it.code] || '기타';

  const data = {
    _updated: iso(), source: 'naver', mkt, n,
    marketStatus: (raw[0] || {}).marketStatus || '',
    delay: ((raw[0] || {}).stockExchangeType || {}).delayTime || 0,
    sectorsUpdated: sec.up, count: items.length,
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
      'Cache-Control': short ? 'public, max-age=30' : 'public, max-age=10',
      'Netlify-CDN-Cache-Control': short ? 'public, s-maxage=30' : 'public, s-maxage=20, stale-while-revalidate=120',
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
