// 개인 데이터 저장 — /api/store?key=memo|watchlist  (Cloudflare KV)
// 메모·관심종목을 서버(KV)에 보관 → 새로고침·재배포·브라우저 청소·다른 기기에서도 유지.
//   GET  /api/store?key=memo        → { key, value }   (value=저장 JSON 또는 null)
//   PUT  /api/store?key=memo  body=JSON → { ok:true }
// 사용 조건: Pages 프로젝트에 KV 네임스페이스를 변수명 'KV' 로 바인딩.
//   (Cloudflare 대시보드 → Settings → Functions → KV namespace bindings → Variable name: KV)
//   바인딩이 없으면 503 반환 → 프런트가 localStorage 로만 동작(기존과 동일, 무중단).
// 보안(선택): 환경변수 STORE_TOKEN 을 설정하면 X-Store-Token 헤더(또는 ?t=)가 일치해야 읽기/쓰기 허용.
//   공개 URL이므로 개인정보성 메모를 쓴다면 STORE_TOKEN 설정을 권장.
const ALLOW = { memo: 1, watchlist: 1 };
const MAX = 200 * 1024;   // 값 크기 상한 200KB

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Store-Token',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
  };
}
function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, cors()),
  });
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return new Response('', { status: 204, headers: cors() });

  const kv = env.KV;                                   // KV 네임스페이스 바인딩(변수명 KV)
  if (!kv) return json({ error: 'kv-unbound' }, 503);  // 미설정 → 프런트는 localStorage 폴백

  if (env.STORE_TOKEN) {                               // 토큰이 설정된 경우만 검사
    const url0 = new URL(request.url);
    const t = request.headers.get('X-Store-Token') || url0.searchParams.get('t') || '';
    if (t !== env.STORE_TOKEN) return json({ error: 'unauthorized' }, 401);
  }

  const url = new URL(request.url);
  const key = (url.searchParams.get('key') || '').toLowerCase();
  if (!ALLOW[key]) return json({ error: 'bad-key' }, 400);
  const kvKey = 'alphadesk:' + key;

  if (request.method === 'GET') {
    const raw = await kv.get(kvKey);
    let value = null;
    if (raw) { try { value = JSON.parse(raw); } catch (e) { value = null; } }
    return json({ key, value }, 200);
  }
  if (request.method === 'PUT' || request.method === 'POST') {
    const body = await request.text();
    if (body.length > MAX) return json({ error: 'too-large' }, 413);
    try { JSON.parse(body); } catch (e) { return json({ error: 'bad-json' }, 400); }   // 유효 JSON만 저장
    await kv.put(kvKey, body);
    return json({ ok: true, key }, 200);
  }
  return json({ error: 'method' }, 405);
}
