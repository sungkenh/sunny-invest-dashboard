// /api/go?u=<구글뉴스 RSS 링크> → 실제 기사 URL로 302 리다이렉트
// 구글뉴스 CBMi… 링크는 클릭해도 중간 'Google 뉴스' 페이지에 머물러 원문 접속이 안 되는 것처럼 보임.
// 기사 페이지의 signature·timestamp로 batchexecute를 호출해 실제 기사 URL을 얻어 바로 보낸다. 실패 시 원래 링크로 폴백.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const CACHE = new Map();   // 구글뉴스 url → 실제 url (아이솔레이트 메모리 캐시)

async function resolveGNews(u) {
  if (CACHE.has(u)) return CACHE.get(u);
  const m0 = u.match(/\/articles\/([^?]+)/);
  if (!m0) return null;
  const art = m0[1];
  // 1) 기사 페이지에서 signature·timestamp 추출
  const r1 = await fetch('https://news.google.com/rss/articles/' + art, { headers: { 'User-Agent': UA } });
  if (!r1.ok) return null;
  const html = await r1.text();
  const sg = html.match(/data-n-a-sg="([^"]+)"/);
  const ts = html.match(/data-n-a-ts="([^"]+)"/);
  if (!sg || !ts) return null;
  // 2) batchexecute 로 실제 URL 요청
  const inner = JSON.stringify(['garturlreq', [['X', 'X', ['X', 'X'], null, null, 1, 1, 'US:en', null, 1, null, null, null, null, null, 0, 1], 'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0], art, Number(ts[1]), sg[1]]);
  const body = 'f.req=' + encodeURIComponent(JSON.stringify([[['Fbv4je', inner, null, '1']]]));
  const r2 = await fetch('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
    method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body,
  });
  const t = await r2.text();
  let real = null;
  try {
    const arr = JSON.parse(t.split('\n\n')[1]);     // )]}'\n\n[[ "wrb.fr","Fbv4je","[\"garturlres\",[\"URL\"]]" ...
    const v = JSON.parse(arr[0][2])[1];             // ["garturlres", ["URL", ...]] → [1] = URL
    if (v && /^https?:\/\//.test(v)) real = v;
  } catch (e) { /* 파싱 실패 → 폴백 */ }
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
  const ok = (dest !== u);   // 해석 성공 시만 길게 캐시
  return new Response(null, { status: 302, headers: { 'Location': dest, 'Cache-Control': ok ? 'public, max-age=86400' : 'public, max-age=60', 'Access-Control-Allow-Origin': '*' } });
}
