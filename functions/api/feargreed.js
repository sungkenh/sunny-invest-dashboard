// 공포·탐욕 지수 — /api/feargreed  (CNN Fear & Greed, 공개 dataviz API)
// 브라우저 CORS 차단 → 서버리스 프록시. 모듈 캐시(30분) + 엣지 캐시.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
let CACHE = { ts: 0, data: null };
const TTL = 30 * 60 * 1000;

// 점수 → 한국어 등급/구간(0~100)
function labelKo(score) {
  if (score < 25) return { ko: '극단적 공포', en: 'Extreme Fear', zone: 'ef' };
  if (score < 45) return { ko: '공포', en: 'Fear', zone: 'f' };
  if (score < 55) return { ko: '중립', en: 'Neutral', zone: 'n' };
  if (score < 75) return { ko: '탐욕', en: 'Greed', zone: 'g' };
  return { ko: '극단적 탐욕', en: 'Extreme Greed', zone: 'eg' };
}
function r1(x) { return x == null ? null : Math.round(x * 10) / 10; }

async function __cfHandler(event) {
  if (CACHE.data && Date.now() - CACHE.ts < TTL) return ok(CACHE.data);
  try {
    const r = await fetch('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    });
    if (!r.ok) throw new Error('http ' + r.status);
    const j = await r.json();
    const fg = j.fear_and_greed || {};
    if (typeof fg.score !== 'number') throw new Error('no score');
    const score = Math.round(fg.score);
    const lab = labelKo(score);
    const data = {
      _updated: new Date().toISOString().slice(0, 19),
      score, rating: fg.rating || lab.en, label: lab.ko, zone: lab.zone,
      ts: fg.timestamp || '',
      prev: {
        close: r1(fg.previous_close), week: r1(fg.previous_1_week),
        month: r1(fg.previous_1_month), year: r1(fg.previous_1_year),
      },
    };
    CACHE = { ts: Date.now(), data };
    return ok(data);
  } catch (e) {
    return { statusCode: 502, headers: cors(), body: JSON.stringify({ error: String(e).slice(0, 80) }) };
  }
};

function cors() { return { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }; }
function ok(obj) {
  return { statusCode: 200, headers: Object.assign(cors(), {
    'Cache-Control': 'public, max-age=600',
    'Netlify-CDN-Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=3600',
  }), body: JSON.stringify(obj) };
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
