// /api/go?u=<구글뉴스 RSS 링크> → 실제 기사 URL로 302 리다이렉트
// 구글뉴스 CBMi… 링크는 클릭해도 중간 'Google 뉴스' 페이지에 몇 초 머물러 원문 접속이 느림(=안 되는 것처럼 보임).
// batchexecute로 실제 기사 URL을 추출해 바로 보낸다. 실패 시 원래 링크로 폴백(결국 리다이렉트됨).
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const CACHE = new Map();   // 구글뉴스 url → 실제 url (아이솔레이트 메모리 캐시)

async function resolveGNews(u) {
  if (CACHE.has(u)) return CACHE.get(u);
  const m0 = u.match(/\/articles\/([^?]+)/);
  if (!m0) return null;
  const art = m0[1];
  const html = await (await fetch(u, { headers: { 'User-Agent': UA } })).text();
  const sg = html.match(/data-n-a-sg="([^"]+)"/);
  const ts = html.match(/data-n-a-ts="([^"]+)"/);
  if (!sg || !ts) return null;
  const inner = JSON.stringify(['garturlreq', [['X', 'X', ['X', 'X'], null, null, 1, 1, 'US:en', null, 1, null, null, null, null, null, 0, 1], 'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0], art, parseInt(ts[1]), sg[1]]);
  const body = 'f.req=' + encodeURIComponent(JSON.stringify([[['Fbv4je', inner, null, 'generic']]]));
  const resp = await (await fetch('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
    method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body,
  })).text();
  const m = resp.match(/garturlres[\\",]+?(https?:\/\/[^\\"]+)/);
  const real = m ? m[1] : null;
  if (real) { CACHE.set(u, real); if (CACHE.size > 3000) CACHE.clear(); }
  return real;
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const u = url.searchParams.get('u') || '';
  let dest = u;
  if (/news\.google\.com\/rss\/articles/.test(u)) {
    try { const r = await resolveGNews(u); if (r) dest = r; } catch (e) { /* 폴백: 원래 링크 */ }
  }
  if (!/^https?:\/\//.test(dest)) return new Response('bad request', { status: 400 });
  return new Response(null, { status: 302, headers: { 'Location': dest, 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' } });
}
