// 트럼프 Truth Social: /api/trump
// truthsocial.com 직접 접근은 Cloudflare 403 → 공개 아카이브 trumpstruth.org RSS 사용.
// 최신 게시물 한국어 번역(원문 보존). 방문 시점 수집 + 모듈/엣지 캐시.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const N = 8;                       // 최신 게시물 수
let CACHE = { ts: 0, data: null };
const TTL = 10 * 60 * 1000;

function tag(block, name) { const m = block.match(new RegExp('<' + name + '[^>]*>([\\s\\S]*?)</' + name + '>')); return m ? m[1] : ''; }
function clean(s) {
  return (s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')   // CDATA 해제
    .replace(/<br\s*\/?>(\s*)/gi, ' ')
    .replace(/<[^>]+>/g, ' ')                        // 태그 제거
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n))
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}
function reltime(mins) { if (mins < 1) return '방금'; if (mins < 60) return mins + '분 전'; const h = Math.floor(mins / 60); if (h < 24) return h + '시간 전'; return Math.floor(h / 24) + '일 전'; }

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
function hasKo(s) { return /[가-힣]/.test(s || ''); }

// gtx 1회 호출: HTTP 오류·빈 응답·미번역(한국어 없음)이면 throw
async function gtxOnce(text) {
  const s = text.slice(0, 900);   // gtx 길이 보호
  const u = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ko&dt=t&q=' + encodeURIComponent(s);
  const r = await fetch(u, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (!r.ok) throw new Error('gtx ' + r.status);
  const d = await r.json();
  const out = (d[0] || []).map((seg) => seg[0]).filter(Boolean).join('');
  if (!hasKo(out)) throw new Error('not-ko');
  return out;
}
// 영어→한국어. 스태거 + 3회 재시도(백오프). 끝내 실패 시 {ko:영어원문, ok:false}
async function translate(text, stagger) {
  if (!text) return { ko: '', ok: true };
  if (stagger) await sleep(stagger);
  for (let i = 0; i < 3; i++) {
    try { return { ko: await gtxOnce(text), ok: true }; }
    catch (e) { await sleep(150 * (i + 1)); }
  }
  return { ko: text, ok: false };
}

async function __cfHandler(event) {
  if (CACHE.data && Date.now() - CACHE.ts < TTL) return ok(CACHE.data);
  try {
    const r = await fetch('https://trumpstruth.org/feed?per_page=20', { headers: { 'User-Agent': UA, 'Accept': 'application/rss+xml, application/xml' } });
    if (!r.ok) throw new Error('http ' + r.status);
    const xml = await r.text();
    const now = Date.now();
    const blocks = (xml.match(/<item\b[\s\S]*?<\/item>/g) || []);
    const items = [];
    for (const b of blocks) {
      const en = clean(tag(b, 'title'));
      if (!en || en.length < 4 || /^\[No Title\]/i.test(en)) continue;   // 이미지·미디어 전용 글 제외
      const link = clean(tag(b, 'link'));
      const pd = tag(b, 'pubDate');
      let mins = 9999; if (pd) { const t = Date.parse(pd); if (!isNaN(t)) mins = Math.max(0, Math.floor((now - t) / 60000)); }
      items.push({ en, link, mins, tm: reltime(mins) });
      if (items.length >= N) break;
    }
    // 한국어 번역(80ms 스태거로 분산 + 재시도). 실패분은 영어 원문 유지하되 카운트
    const tr = await Promise.all(items.map((it, i) => translate(it.en, i * 80)));
    items.forEach((it, i) => { it.ti = tr[i].ko; });
    const failed = tr.filter((t) => !t.ok).length;
    const out = items.map((it) => ({
      ti: it.ti, ti_en: it.en, link: it.link, tm: it.tm, min: it.mins,
      src: 'Truth Social', cat: '트럼프', mk: 'us', sum: it.en, pop: Math.max(1, 100000 - it.mins),
    }));
    const data = { _updated: new Date().toISOString().slice(0, 19), count: out.length, items: out };
    // 번역 전부 성공 → 10분 캐시. 일부 실패 → 60초 뒤 만료(다음 방문 시 재시도)
    CACHE = { ts: failed ? Date.now() - (TTL - 60000) : Date.now(), data };
    return ok(data, failed);
  } catch (e) {
    return { statusCode: 502, headers: cors(), body: JSON.stringify({ error: String(e).slice(0, 80) }) };
  }
};

function cors() { return { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }; }
function ok(obj, failed) {
  const mx = failed ? 60 : 120;          // 번역 실패분 있으면 짧게 캐시(다음 방문 재시도)
  const sm = failed ? 60 : 600;
  return { statusCode: 200, headers: Object.assign(cors(), {
    'Cache-Control': 'public, max-age=' + mx,
    'Netlify-CDN-Cache-Control': 'public, s-maxage=' + sm + ', stale-while-revalidate=1200',
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
