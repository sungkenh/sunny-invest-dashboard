// 종목 최신 뉴스: /api/stocknews?q=<종목명>  (구글뉴스 RSS, 한국어)
// 관심종목 심층패널의 '최신 뉴스' 탭. 종목명으로 구글뉴스를 검색해 최신순 상위 8건.
// 방문 시점 수집. 쿼리별 모듈 캐시(10분) + 엣지 캐시.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const CACHE = {};                 // q(lower) -> { ts, data }
const TTL = 10 * 60 * 1000;

function decode(s) {
  return (s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n))
    .replace(/&amp;/g, '&').trim();
}
function tag(block, name) { const m = block.match(new RegExp('<' + name + '[^>]*>([\\s\\S]*?)<\\/' + name + '>')); return m ? m[1] : ''; }
function reltime(mins) { if (mins < 1) return '방금'; if (mins < 60) return mins + '분 전'; const h = Math.floor(mins / 60); if (h < 24) return h + '시간 전'; return Math.floor(h / 24) + '일 전'; }

async function __cfHandler(event) {
  const q = (((event && event.queryStringParameters) || {}).q || '').trim();
  if (!q) return resp(400, { error: 'q required', items: [] });
  const ck = q.toLowerCase();
  if (CACHE[ck] && Date.now() - CACHE[ck].ts < TTL) return resp(200, CACHE[ck].data);

  const url = 'https://news.google.com/rss/search?q=' + encodeURIComponent(q) + '&hl=ko&gl=KR&ceid=KR:ko';
  let items = [];
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    const xml = await r.text();
    const now = Date.now();
    const seen = new Set();
    items = (xml.match(/<item\b[\s\S]*?<\/item>/g) || []).slice(0, 14).map((b) => {
      let title = decode(tag(b, 'title'));
      const link = decode(tag(b, 'link'));
      let src = decode(tag(b, 'source'));
      if (src && title.endsWith(' - ' + src)) title = title.slice(0, -(src.length + 3)).trim();
      else if (!src && title.includes(' - ')) { const i = title.lastIndexOf(' - '); src = title.slice(i + 3).trim(); title = title.slice(0, i).trim(); }
      let mins = 999;
      const pd = tag(b, 'pubDate');
      if (pd) { const t = Date.parse(pd); if (!isNaN(t)) mins = Math.max(0, Math.floor((now - t) / 60000)); }
      return title ? { ti: title, link, src, tm: reltime(mins), min: mins } : null;
    }).filter((n) => {
      if (!n) return false;
      const k = n.ti.slice(0, 28);
      if (seen.has(k)) return false; seen.add(k); return true;
    }).sort((a, b) => a.min - b.min).slice(0, 8);
  } catch (e) { /* 빈 결과 반환 */ }

  const data = { q, count: items.length, items, _updated: new Date().toISOString().slice(0, 19) };
  CACHE[ck] = { ts: Date.now(), data };
  return resp(200, data);
};

function resp(code, obj) {
  return {
    statusCode: code,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=120',
      'Netlify-CDN-Cache-Control': 'public, s-maxage=600, stale-while-revalidate=900',
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
