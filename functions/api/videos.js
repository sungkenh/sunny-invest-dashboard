// 추천 투자 영상 — /api/videos  (국내 경제 유튜브 채널 RSS, 최신순)
// 방문 시점 수집. 모듈 캐시(30분) + 엣지 캐시. 쇼츠 제외.
// 최근 약 1주일(8일) 내 업로드된 영상을 채널 구분 없이 전부 수집해 최신순 정렬.
// (조회수도 함께 보존 → 영상 페이지에서 인기순 토글 가능). 진짜 watch 링크 + 썸네일.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';

// (channel_id, 표시명) — 국내 인기 경제·투자 유튜브 (영어 채널 제외)
const CHANNELS = [
  ['UChlv4GSd7OQl3js-jkLOnFA', '삼프로TV'],
  ['UCsJ6RuBiTVWRX156FVbeaGg', '슈카월드'],
  ['UCF8AeLlUbEpKju6v1H6p8Eg', '한국경제TV'],
  ['UCC3yfxS5qC6PCwDzetUuEWg', '소수몽키'],
  ['UCupslRq5jW95UGzPjOZz0FA', '와이스트릿'],
  ['UCCG6BEYjfQMGzypJw2EJCDQ', '815머니톡'],
  ['UCVt6ZWdDbVKDYkciplQTsvQ', '홍춘욱'],
  ['UCgH2THmX3KgZN72xGO5K_gw', '김단테'],
  ['UCpqD9_OJNtF6suPpi6mOQCQ', '월가아재'],
  ['UCOio3vyYLWiKlHSYRKW-9UA', '설명왕_테이버'],
  ['UCxvdCnvGODDyuvnELnLkQWw', '이효석아카데미'],
  ['UCC8IAk37ddIvOqoo9yXKjqA', '송팀장'],
  ['UCIUni4ScRp4mqPXsxy62L5w', '언더스탠딩'],
  ['UCOB62fKRT7b73X7tRxMuN2g', '박종훈 지식한방'],
  ['UCpTC-SMFjA3EDRhZIKOcKuQ', '자산제곱'],
  ['UCznImSIaxZR7fdLCICLdgaQ', '전인구경제연구소'],
  ['UCfnqgWlC5IvJEAPTmyjaixA', '수페TV'],
];
const WINDOW_MIN = 8 * 24 * 60;    // 최근 약 1주일(8일) 이내 업로드 전부
const TOTAL = 160;                 // 기간 내 영상 전부(과도 페이로드 방지 상한)
const HOT_MIN = 24 * 60;           // 24시간 내 업로드 = 신규(HOT)
let CACHE = { ts: 0, data: null };
const TTL = 30 * 60 * 1000;

function decode(s) {
  return (s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n))
    .replace(/&amp;/g, '&').trim();
}
function reltime(mins) { if (mins < 1) return '방금'; if (mins < 60) return mins + '분 전'; const h = Math.floor(mins / 60); if (h < 24) return h + '시간 전'; return Math.floor(h / 24) + '일 전'; }
function viewsKo(v) {
  if (!v) return '';
  if (v >= 1e8) return (v / 1e8).toFixed(1) + '억';
  if (v >= 1e5) return Math.round(v / 1e4) + '만';
  if (v >= 1e4) return (v / 1e4).toFixed(1) + '만';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + '천';
  return '' + v;
}

async function fetchChannel(cid, name) {
  const url = 'https://www.youtube.com/feeds/videos.xml?channel_id=' + cid;
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  const xml = await r.text();
  const now = Date.now();
  const entries = (xml.match(/<entry\b[\s\S]*?<\/entry>/g) || []).slice(0, 15);
  const out = [];
  for (const e of entries) {
    const lm = e.match(/<link[^>]*rel="alternate"[^>]*href="([^"]+)"/) || e.match(/<link[^>]*href="([^"]+)"/);
    const link = lm ? decode(lm[1]) : '';
    if (!link || link.includes('/shorts/')) continue;             // 쇼츠 제외
    const tm = e.match(/<media:title>([\s\S]*?)<\/media:title>/) || e.match(/<title[^>]*>([\s\S]*?)<\/title>/);
    const title = tm ? decode(tm[1]) : '';
    const thm = e.match(/<media:thumbnail[^>]*url="([^"]+)"/);
    const thumb = thm ? decode(thm[1]) : '';
    const vm = e.match(/<media:statistics views="(\d+)"/);
    const views = vm ? parseInt(vm[1], 10) : 0;
    const pm = e.match(/<published>([\s\S]*?)<\/published>/);
    let mins = 99999;
    if (pm) { const t = Date.parse(pm[1]); if (!isNaN(t)) mins = Math.max(0, Math.floor((now - t) / 60000)); }
    if (title) out.push({ ti: title, ch: name, link, mk: 'kr', min: mins, tm: reltime(mins), thumb, views, viewsKo: viewsKo(views) });
  }
  return out;
}

async function __cfHandler(event) {
  if (CACHE.data && Date.now() - CACHE.ts < TTL) return ok(CACHE.data);

  const lists = await Promise.all(CHANNELS.map(([cid, name]) => fetchChannel(cid, name).catch(() => [])));
  const all = [].concat(...lists);
  const seen = new Set();
  const dedup = arr => arr.filter(v => (seen.has(v.link) ? false : (seen.add(v.link), true)));
  // 최근 1주일 내 업로드 전부 → 최신순(동시각대는 조회수). 윈도 내 너무 적으면 전체 최근영상으로 보강.
  let pool = dedup(all.filter(v => v.min <= WINDOW_MIN)).sort((a, b) => (a.min - b.min) || (b.views - a.views));
  if (pool.length < 12) {
    seen.clear();
    pool = dedup(all.slice()).sort((a, b) => a.min - b.min);
  }
  const picked = pool.slice(0, TOTAL);
  picked.forEach(v => { v.hot = v.min <= HOT_MIN; });       // 24시간 내 업로드 = 신규(HOT)

  const data = { _updated: new Date().toISOString().slice(0, 19), sort: 'recent',
    window_days: WINDOW_MIN / 1440, count: picked.length, items: picked };
  CACHE = { ts: Date.now(), data };
  return ok(data);
};

function ok(obj) {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=300',
      'Netlify-CDN-Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=1800',
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
