// 추천 투자 영상 — /api/videos  (유튜브 채널 RSS, 진짜 watch 링크)
// 방문 시점 수집. 모듈 캐시(30분) + 엣지 캐시. 쇼츠 제외, 최신순 14편.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';

// (channel_id, 표시명, 시장) — fetch_videos.py와 동일
const CHANNELS = [
  ['UChlv4GSd7OQl3js-jkLOnFA', '삼프로TV', 'kr'],
  ['UCsJ6RuBiTVWRX156FVbeaGg', '슈카월드', 'kr'],
  ['UCF8AeLlUbEpKju6v1H6p8Eg', '한국경제TV', 'kr'],
  ['UCC3yfxS5qC6PCwDzetUuEWg', '소수몽키', 'kr'],
  ['UCvJJ_dzjViJCoLf5uKUTwoA', 'CNBC', 'us'],
  ['UCEAZeUIeJs0IjQiqTCdVSIg', 'Yahoo Finance', 'us'],
  ['UCIALMKvObZNtJ6AmdCLP7Lg', 'Bloomberg TV', 'us'],
];
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

async function fetchChannel(cid, name, mk) {
  const url = 'https://www.youtube.com/feeds/videos.xml?channel_id=' + cid;
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  const xml = await r.text();
  const now = Date.now();
  const entries = (xml.match(/<entry\b[\s\S]*?<\/entry>/g) || []).slice(0, 5);
  const out = [];
  for (const e of entries) {
    const lm = e.match(/<link[^>]*rel="alternate"[^>]*href="([^"]+)"/) || e.match(/<link[^>]*href="([^"]+)"/);
    const link = lm ? decode(lm[1]) : '';
    if (!link || link.includes('/shorts/')) continue;          // 쇼츠 제외
    const tm = e.match(/<title[^>]*>([\s\S]*?)<\/title>/);
    const title = tm ? decode(tm[1]) : '';
    const thm = e.match(/<media:thumbnail[^>]*url="([^"]+)"/);
    const thumb = thm ? decode(thm[1]) : '';
    const pm = e.match(/<published>([\s\S]*?)<\/published>/);
    let mins = 99999;
    if (pm) { const t = Date.parse(pm[1]); if (!isNaN(t)) mins = Math.max(0, Math.floor((now - t) / 60000)); }
    if (title) out.push({ ti: title, ch: name, link, mk, min: mins, tm: reltime(mins), thumb });
  }
  return out;
}

exports.handler = async () => {
  if (CACHE.data && Date.now() - CACHE.ts < TTL) return ok(CACHE.data);

  const lists = await Promise.all(CHANNELS.map(([cid, name, mk]) => fetchChannel(cid, name, mk).catch(() => [])));
  let vids = [].concat(...lists);
  vids.sort((a, b) => a.min - b.min);
  vids = vids.slice(0, 14);
  vids.forEach((v, i) => { v.hot = i < 3; });

  const data = { _updated: new Date().toISOString().slice(0, 19), count: vids.length, items: vids };
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
