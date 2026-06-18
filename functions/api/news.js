// 실시간 뉴스 — /api/news  (구글뉴스 RSS, 카테고리별 + 미국기사 한국어 번역)
// 방문 시점 수집. 모듈 캐시(10분) + 엣지 캐시. 미국 기사 번역은 병렬 처리.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';

// (mk, cat, query) — fetch_news.py와 동일. 섹터별로 수집 → 카테고리 칩은 당일 기사 수 기준 동적 표시.
const QUERIES = [
  ['kr', '반도체', '삼성전자 OR SK하이닉스 OR HBM 반도체'],
  ['kr', 'AI', 'AI 반도체 OR 생성형 AI OR 네이버 카카오 AI'],
  ['kr', '2차전지', '2차전지 OR 에코프로 OR LG에너지솔루션'],
  ['kr', '방산', '방산 OR 한화에어로스페이스 OR LIG넥스원'],
  ['kr', '원전·전력', '원전 OR SMR OR 두산에너빌리티 OR 전력설비'],
  ['kr', '조선', '조선 OR HD현대중공업 OR 한화오션 OR 삼성중공업'],
  ['kr', '자동차', '현대차 OR 기아 OR 자동차 수출'],
  ['kr', '바이오', '삼성바이오 OR 셀트리온 OR 바이오 신약'],
  ['kr', '코인', '비트코인 OR 가상자산 OR 알트코인'],
  ['kr', '국내증시', '코스피 OR 코스닥 증시 외국인'],
  ['kr', '매크로', '한국은행 기준금리 OR 원달러 환율'],
  ['us', '반도체', 'Nvidia OR TSMC OR semiconductor'],
  ['us', '빅테크', 'Apple OR Microsoft OR Amazon AI'],
  ['us', 'AI', 'Palantir OR AI stocks OR OpenAI'],
  ['us', '전기차', 'Tesla OR EV sales'],
  ['us', '코인', 'Bitcoin OR Coinbase OR crypto'],
  ['us', '금리', 'Treasury yields OR Fed rate cut'],
  ['us', '매크로', 'Federal Reserve OR US jobs report OR inflation'],
];
const PER_QUERY = 7;
let CACHE = { ts: 0, data: null };
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

async function translate(text) {
  if (!text) return text;
  try {
    const u = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ko&dt=t&q=' + encodeURIComponent(text);
    const r = await fetch(u, { headers: { 'User-Agent': UA } });
    const d = await r.json();
    return (d[0] || []).map((seg) => seg[0]).filter(Boolean).join('') || text;
  } catch (e) { return text; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 단일 쿼리 1회 — HTTP 오류·빈 RSS(차단·레이트리밋 징후)면 throw
async function fetchQueryOnce(mk, cat, q) {
  const [hl, gl, ceid] = mk === 'kr' ? ['ko', 'KR', 'KR:ko'] : ['en-US', 'US', 'US:en'];
  const url = 'https://news.google.com/rss/search?q=' + encodeURIComponent(q) + '&hl=' + hl + '&gl=' + gl + '&ceid=' + ceid;
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/rss+xml, application/xml;q=0.9, */*;q=0.8', 'Accept-Language': hl + ',en;q=0.8' } });
  if (!r.ok) throw new Error('rss ' + r.status);
  const xml = await r.text();
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>/g) || [];
  if (!blocks.length) throw new Error('empty');
  const now = Date.now();
  return blocks.slice(0, PER_QUERY).map((b) => {
    let title = decode(tag(b, 'title'));
    const link = decode(tag(b, 'link'));
    let src = decode(tag(b, 'source'));
    if (src && title.endsWith(' - ' + src)) title = title.slice(0, -(src.length + 3)).trim();
    else if (!src && title.includes(' - ')) { const i = title.lastIndexOf(' - '); src = title.slice(i + 3).trim(); title = title.slice(0, i).trim(); }
    let mins = 999;
    const pd = tag(b, 'pubDate');
    if (pd) { const t = Date.parse(pd); if (!isNaN(t)) mins = Math.max(0, Math.floor((now - t) / 60000)); }
    return title ? { mk, cat, src, ti: title, link, min: mins, tm: reltime(mins), sum: '', pop: Math.max(1, 100000 - mins) } : null;
  }).filter(Boolean);
}
// 2회 재시도(백오프). 끝내 실패면 [] (해당 쿼리만 비고 나머지는 살림)
async function fetchQuery(mk, cat, q) {
  for (let i = 0; i < 3; i++) {
    try { return await fetchQueryOnce(mk, cat, q); }
    catch (e) { await sleep(250 * (i + 1)); }
  }
  return [];
}
// 동시 실행 수 제한 풀 — 18개를 한꺼번에 안 때리고 limit개씩(구글 레이트리밋·차단 회피)
async function runPool(thunks, limit) {
  const out = new Array(thunks.length);
  let idx = 0;
  async function worker() { while (idx < thunks.length) { const i = idx++; out[i] = await thunks[i](); } }
  await Promise.all(Array.from({ length: Math.min(limit, thunks.length) }, worker));
  return out;
}

async function __cfHandler(event) {
  if (CACHE.data && Date.now() - CACHE.ts < TTL) return ok(CACHE.data);

  const lists = await runPool(QUERIES.map(([mk, cat, q]) => () => fetchQuery(mk, cat, q)), 6);
  const items = [], seen = new Set();
  for (const list of lists) for (const n of list) {
    const k = n.ti.slice(0, 28);
    if (seen.has(k)) continue;
    seen.add(k); items.push(n);
  }
  // 미국 기사 → 한국어 번역(병렬), 원문은 ti_en/sum 보존
  await Promise.all(items.filter((n) => n.mk === 'us').map(async (n) => {
    const en = n.ti, ko = await translate(en);
    if (ko && ko !== en) { n.ti = ko; n.ti_en = en; n.sum = en; }
  }));
  items.sort((a, b) => a.min - b.min);
  items.forEach((n, i) => { n.hot = i < 6; });

  const data = { _updated: new Date().toISOString().slice(0, 19), count: items.length, items };
  // 전부 실패(0건)면 빈 결과를 10분 캐시하지 않음 → 60초 뒤 만료(다음 방문 재시도)
  CACHE = { ts: items.length ? Date.now() : Date.now() - (TTL - 60000), data };
  return ok(data, items.length === 0);
};

function ok(obj, empty) {
  const mx = empty ? 60 : 120;     // 0건이면 짧게 캐시(다음 방문 재시도)
  const sm = empty ? 60 : 600;
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=' + mx,
      'Netlify-CDN-Cache-Control': 'public, s-maxage=' + sm + ', stale-while-revalidate=900',
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
