// 미국 주식 실시간 히트맵 — /api/usheatmap?us=sp500|nasdaq&n=50|100|200
//   sp500  : 지수 편입종목 API(index/.INX/enrollStocks, 시총순 정렬·NYSE+나스닥 혼합)
//   nasdaq : 나스닥 거래소 시총 랭킹 전체(상위 N — 나스닥100을 포함하는 상위집합)
// 둘 다 delayTime 0 실시간, 한글 업종 그룹 내장, overMarketPriceInfo 로 프리·애프터마켓 체결가 제공
// (직접 폴링으로 초단위 체결 전진 확인). subrequest 예산: 페이지 1~2 (실패 시 스냅샷 +1) / 무료 50
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const CACHE = {};                 // `us|${n}` → {ts, data}
const TTL = 5 * 1000;             // 클라이언트 5초 폴링에 맞춤 (네이버 앱 자체 폴링은 7초)

const UNIVERSES = {
  sp500:  { url: (p) => 'https://api.stock.naver.com/index/.INX/enrollStocks?page=' + p + '&pageSize=100' },
  nasdaq: { url: (p) => 'https://api.stock.naver.com/stock/exchange/NASDAQ/marketValue?page=' + p + '&pageSize=100' },
};
const ALLOWED_N = [50, 100, 200];

const iso = () => new Date().toISOString().slice(0, 19);
const num = (v) => parseFloat(String(v == null ? '' : v).replace(/,/g, ''));

async function naverUS(us, page) {
  const r = await fetch(UNIVERSES[us].url(page), { headers: { 'User-Agent': UA, 'Referer': 'https://m.stock.naver.com/' } });
  if (!r.ok) throw new Error('naver ' + us + ' p' + page + ' ' + r.status);
  const j = await r.json();
  return (j && j.stocks) || [];
}

function keep(s) {
  if ((s.stockEndType || '') !== 'stock') return false;            // ETF/ETN (랭킹엔 거의 없지만 방어)
  const cap = num(s.marketValue), px = num(s.closePrice), pct = num(s.fluctuationsRatio);
  return isFinite(cap) && cap > 0 && isFinite(px) && px > 0 && isFinite(pct);
}

function norm(s) {
  const it = {
    code: s.symbolCode, rc: s.reutersCode || '', name: s.stockName,
    mk: (s.stockExchangeType || {}).code || '',
    sector: ((s.industryCodeType || {}).industryGroupKor || '').trim() || '기타',
    price: num(s.closePrice),
    // ⚠️ fluctuationsRatio 는 이미 부호 포함 — 다시 곱하지 말 것 (krheatmap 과 동일)
    pct: num(s.fluctuationsRatio),
    cap: num(s.marketValue) * 1000,               // marketValue 단위는 천달러 → 달러로 통일
  };
  const o = s.overMarketPriceInfo;
  if (o && o.overPrice != null && isFinite(num(o.overPrice))) {
    it.o = { p: num(o.overPrice), pct: num(o.fluctuationsRatio),
             t: o.tradingSessionType || '', s: o.overMarketStatus || '' };
  }
  return it;
}

async function loadSnapshot(rawUrl, us) {
  try {
    const r = await fetch(new URL('/data/usheatmap_' + us + '.json', rawUrl).toString());
    if (r.ok) return await r.json();
  } catch (e) { /* 폴백 실패 */ }
  return null;
}

// 시총순 정렬이므로 n=100 까지 1페이지, n=200 은 2페이지
const pagesFor = (n) => (n <= 100 ? 1 : 2);

async function __cfHandler(event) {
  const p = event.queryStringParameters || {};
  const us = (p.us === 'nasdaq') ? 'nasdaq' : 'sp500';
  let n = parseInt(p.n, 10);
  if (ALLOWED_N.indexOf(n) < 0) n = 100;

  const key = us + '|' + n;
  const c = CACHE[key];
  if (c && c.data && Date.now() - c.ts < TTL) return ok(c.data);

  const pages = pagesFor(n);
  const res = await Promise.all(
    Array.from({ length: pages }, (_, i) => naverUS(us, i + 1).catch(() => null))
  );
  const raw = [];
  for (const arr of res) if (arr) raw.push.apply(raw, arr);

  if (!raw.length) {                                   // 라이브 전멸 → 스냅샷 → 빈결과
    const snap = await loadSnapshot(event.rawUrl, us);
    let data;
    if (snap && Array.isArray(snap.items) && snap.items.length) {
      const items = snap.items.slice(0, n);
      data = Object.assign({}, snap, { source: 'snapshot', n, count: items.length, items });
    } else {
      data = { _updated: iso(), source: 'error', mkt: us, n, marketStatus: '', delay: 0, count: 0, items: [] };
    }
    CACHE[key] = { ts: Date.now() - (TTL - 5000), data };   // 곧 재시도
    return ok(data, true);
  }

  const seen = new Set(), items = [];
  for (const s of raw) {
    if (!keep(s) || seen.has(s.symbolCode)) continue;
    seen.add(s.symbolCode); items.push(norm(s));
  }
  items.sort((a, b) => b.cap - a.cap);
  items.length = Math.min(items.length, n);

  const first = raw[0] || {};
  const data = {
    _updated: iso(), source: 'naver', mkt: us, n,
    marketStatus: first.marketStatus || '',
    overStatus: ((first.overMarketPriceInfo || {}).tradingSessionType) || '',
    delay: ((first.stockExchangeType || {}).delayTime) || 0,
    count: items.length,
    partial: res.some((x) => !x) || undefined,
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
