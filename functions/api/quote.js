// 실시간 시세 — /api/quote?syms=AAPL,005930.KS  (야후 chart API, crumb 불필요)
async function __cfHandler(event) {
  const syms = (((event.queryStringParameters || {}).syms || '')
    .split(',').map((s) => s.trim()).filter(Boolean)).slice(0, 25);
  const res = {};
  await Promise.all(syms.map(async (s) => {
    try {
      const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
        encodeURIComponent(s) + '?interval=1d&range=1d';
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const d = await r.json();
      const m = d && d.chart && d.chart.result && d.chart.result[0] && d.chart.result[0].meta;
      if (m && typeof m.regularMarketPrice === 'number') {
        const price = m.regularMarketPrice;
        const pc = (typeof m.chartPreviousClose === 'number') ? m.chartPreviousClose
          : (typeof m.previousClose === 'number' ? m.previousClose : price);
        res[s] = { price: Math.round(price * 100) / 100, pct: pc ? Math.round((price - pc) / pc * 10000) / 100 : 0 };
      } else {
        res[s] = { error: 'no data' };
      }
    } catch (e) {
      res[s] = { error: String(e).slice(0, 40) };
    }
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
