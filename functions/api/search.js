// 종목 검색 — /api/search?q=...  (네이버 증권 한글검색 + 야후 폴백)
// Node 18+ 전역 fetch 사용, 의존성 없음 (Netlify가 자동 번들)
async function __cfHandler(event) {
  const q = ((event.queryStringParameters || {}).q || '').trim();
  if (!q) return resp([]);
  let out = [];

  // 1) 네이버 증권 검색 (한글 지원, 국내+해외)
  try {
    const url = 'https://m.stock.naver.com/front-api/search/autoComplete?query=' +
      encodeURIComponent(q) + '&target=stock,index,etf';
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://m.stock.naver.com/' } });
    const data = await r.json();
    const items = ((data.result || {}).items) || [];
    for (const it of items) {
      const code = it.code, tc = it.typeCode || '', nation = it.nationCode || '';
      if (!code) continue;
      let sym, mk;
      if (nation === 'KOR' || tc === 'KOSPI' || tc === 'KOSDAQ' || tc === 'KONEX') {
        sym = code + (tc === 'KOSPI' ? '.KS' : '.KQ'); mk = 'kr';
      } else { sym = code; mk = 'us'; }
      out.push({ sym, name: it.name, exch: it.typeName || tc, mk });
    }
  } catch (e) { /* 네이버 실패 시 야후 폴백 */ }

  // 2) 야후 검색 폴백 (영문명/티커)
  if (!out.length) {
    try {
      const r = await fetch('https://query1.finance.yahoo.com/v1/finance/search?q=' +
        encodeURIComponent(q) + '&quotesCount=10&newsCount=0', { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const data = await r.json();
      for (const it of (data.quotes || [])) {
        const sym = it.symbol, qt = it.quoteType || '';
        if (!sym || !['EQUITY', 'ETF', 'INDEX', 'CRYPTOCURRENCY'].includes(qt)) continue;
        const mk = (sym.endsWith('.KS') || sym.endsWith('.KQ')) ? 'kr' : 'us';
        out.push({ sym, name: it.shortname || it.longname || sym, exch: it.exchDisp || '', mk });
      }
    } catch (e) { /* ignore */ }
  }

  return resp(out.slice(0, 12));
};

function resp(obj) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
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
