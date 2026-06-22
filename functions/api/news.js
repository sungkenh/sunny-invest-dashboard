// 실시간 뉴스 — /api/news  (한국=네이버 검색 API, 미국=Yahoo Finance RSS, 전쟁·지정학=구글뉴스 · 직접 기사 URL)
// 방문 시점 수집. 모듈 캐시(10분) + 엣지 캐시. 미국 기사 번역 병렬. 네이버 키=context.env.NAVER_ID/NAVER_SECRET.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';

// (mk, cat, query) — fetch_news.py와 동일. 섹터별로 수집 → 카테고리 칩은 당일 기사 수 기준 동적 표시.
// 전쟁·지정학·속보를 맨 앞에 둬 분류·중복제거 우선권을 가짐.
const QUERIES = [
  ['kr', '전쟁·지정학', '이스라엘 이란 OR 우크라이나 전쟁 OR 중동 정세 OR 휴전 OR 호르무즈 OR 북한 미사일'],
  ['us', '전쟁·지정학', 'Israel Iran OR Ukraine Russia war OR Middle East conflict OR ceasefire OR Hormuz'],
  ['kr', '속보', '속보 코스피 OR 속보 금리 OR 속보 환율 OR 속보 유가 OR 속보 전쟁 OR 속보 이란 OR 속보 반도체'],
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
// 미국 뉴스: 구글뉴스(클릭 시 원문 연결 깨짐·CF 차단) 대신 Yahoo Finance RSS(직접 기사 URL·CF 동작).
// 카테고리 → 종목군 매핑. 전쟁·지정학은 야후가 커버 못해 구글 유지.
const US_TICKERS = {
  '반도체': 'NVDA,TSM,AVGO,AMD,MU,ASML,SMCI',
  '빅테크': 'AAPL,MSFT,AMZN,GOOGL,META',
  'AI': 'PLTR,SMCI,NVDA,MSFT',
  '전기차': 'TSLA,RIVN,LCID,NIO',
  '코인': 'COIN,MSTR,MARA,RIOT',
  '금리': '^TNX,^TYX,TLT',
  '매크로': '^GSPC,^IXIC,^DJI',
};
// 한국 뉴스: 네이버 검색 API(originallink=직접 기사 URL). 카테고리 → 집중 키워드(공백=AND).
const KR_NAVER = {
  '전쟁·지정학': '이스라엘 이란',
  '속보': '속보 증시',
  '반도체': '반도체 삼성전자',
  'AI': 'AI 반도체',
  '2차전지': '2차전지 배터리',
  '방산': '방산 수출',
  '원전·전력': '원전 전력',
  '조선': '조선업 수주',
  '자동차': '현대차 자동차',
  '바이오': '제약 바이오',
  '코인': '비트코인 가상자산',
  '국내증시': '코스피 증시',
  '매크로': '기준금리 환율',
};
const PER_QUERY = 7;
let CACHE = { ts: 0, data: null };
const TTL = 10 * 60 * 1000;

// ── last-good 보관(엣지 Cache API) ──
// 모듈 캐시는 아이솔레이트 재활용 시 사라짐 → 직전 '양호한 스캔'을 Cache API에 보관해,
// 새 스캔이 빈약(0건/번역실패)할 때 6시간 스냅샷 대신 '직전 최신본'을 유지한다.
const MIN_GOOD = 20;                       // 이 미만이면 빈약한 스캔으로 간주
function lgKey(event) {
  let origin = 'https://sunny-invest-dashboard.pages.dev';
  try { origin = new URL(event.rawUrl).origin; } catch (e) {}
  return origin + '/__news_lastgood';      // 실경로 아님 — Cache API 키로만 사용
}
async function readLastGood(event) {
  try { const r = await caches.default.match(new Request(lgKey(event))); if (r) return await r.json(); } catch (e) {}
  return null;
}
async function writeLastGood(event, data) {
  try {
    await caches.default.put(new Request(lgKey(event)),
      new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' } }));
  } catch (e) {}
}

// 속보 마커: [속보] <속보> 속보: [긴급] [1보] BREAKING JUST IN URGENT 등 (제목 기준)
const BRK_RE = /\[?\s*(속보|긴급|\d{1,2}\s*보)\s*[\]\)>:.]|^\s*속보|BREAKING|JUST IN|URGENT|DEVELOPING|LIVE:/i;
// 속보 전용 쿼리 기사 → 제목으로 실제 카테고리 분류
function classify(t) {
  if (/전쟁|이란|이스라엘|우크라|러시아|미사일|휴전|호르무즈|중동|북한|하마스|헤즈볼라/.test(t)) return '전쟁·지정학';
  if (/반도체|삼성전자|하이닉스|HBM|D램|낸드|파운드리|마이크론|TSMC|엔비디아|필라델피아/.test(t)) return '반도체';
  if (/코스피|코스닥|증시|외국인|순매수/.test(t)) return '국내증시';
  if (/금리|연준|FOMC|환율|국채|물가|인플레|수출물가/.test(t)) return '매크로';
  if (/유가|원유|WTI|기름값|정유/.test(t)) return '원자재';
  if (/비트코인|코인|가상자산|이더리움/.test(t)) return '코인';
  return '속보';
}

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function hasKo(s) { return /[가-힣]/.test(s || ''); }
// gtx가 깨는 고유명사 보정(원문에 그 브랜드가 있을 때만 — 오작동 방지)
function fixBrands(en, ko) {
  if (/\bAnthropic\b/i.test(en)) ko = ko.replace(/인류\s*주식/g, '앤트로픽');
  return ko;
}
// gtx 1회 — 여러 헤드라인을 줄바꿈으로 묶어 한 번에 번역(서브리퀘스트·레이트리밋 최소화).
// 반환=번역된 줄 배열. HTTP오류·줄수 불일치·미번역(한국어 없음)이면 throw → 재시도.
async function gtxLines(texts) {
  const joined = texts.map((t) => (t || '').replace(/\s*\n\s*/g, ' ')).join('\n');
  const u = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ko&dt=t&q=' + encodeURIComponent(joined.slice(0, 1800));
  const r = await fetch(u, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (!r.ok) throw new Error('gtx ' + r.status);
  const d = await r.json();
  const out = (d[0] || []).map((seg) => seg[0]).filter(Boolean).join('');
  const lines = out.split('\n');
  if (lines.length !== texts.length || !hasKo(out)) throw new Error('mismatch');
  return lines.map((ko, i) => fixBrands(texts[i], ko.trim()));
}
// 헤드라인 묶음 번역 — 3회 재시도(백오프). 끝내 실패 시 원문(영어) 유지 + ok:false
async function translateChunk(texts) {
  for (let i = 0; i < 3; i++) {
    try { return { kos: await gtxLines(texts), ok: true }; }
    catch (e) { await sleep(150 * (i + 1)); }
  }
  return { kos: texts.slice(), ok: false };
}

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
// 미국 — Yahoo Finance RSS(직접 기사 URL, CF서 동작). 종목군 기반 헤드라인. 출처는 링크 도메인.
async function fetchYahooOnce(cat, syms) {
  const url = 'https://feeds.finance.yahoo.com/rss/2.0/headline?s=' + encodeURIComponent(syms) + '&region=US&lang=en-US';
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error('yf ' + r.status);
  const xml = await r.text();
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>/g) || [];
  if (!blocks.length) throw new Error('empty');
  const now = Date.now();
  return blocks.slice(0, PER_QUERY).map((b) => {
    const title = decode(tag(b, 'title'));
    const link = decode(tag(b, 'link'));
    if (!title || !/^https?:\/\//.test(link)) return null;
    const src = (link.match(/^https?:\/\/(?:www\.)?([^\/]+)/) || [, ''])[1];
    let mins = 999;
    const pd = tag(b, 'pubDate');
    if (pd) { const t = Date.parse(pd); if (!isNaN(t)) mins = Math.max(0, Math.floor((now - t) / 60000)); }
    return { mk: 'us', cat, src, ti: title, link, min: mins, tm: reltime(mins), sum: '', pop: Math.max(1, 100000 - mins) };
  }).filter(Boolean);
}
async function fetchYahoo(cat, syms) {
  for (let i = 0; i < 3; i++) { try { return await fetchYahooOnce(cat, syms); } catch (e) { await sleep(250 * (i + 1)); } }
  return [];
}
// 한국 — 네이버 뉴스 검색 API(originallink=직접 기사 URL). 키는 CF 환경변수(context.env).
async function fetchNaverOnce(cat, query, id, secret) {
  const url = 'https://openapi.naver.com/v1/search/news.json?query=' + encodeURIComponent(query) + '&display=8&sort=date';
  const r = await fetch(url, { headers: { 'X-Naver-Client-Id': id, 'X-Naver-Client-Secret': secret, 'User-Agent': UA } });
  if (!r.ok) throw new Error('naver ' + r.status);
  const d = await r.json();
  const now = Date.now();
  return (d.items || []).slice(0, PER_QUERY).map((it) => {
    const title = decode((it.title || '').replace(/<[^>]+>/g, ''));
    const link = it.originallink || it.link || '';
    if (!title || !/^https?:\/\//.test(link)) return null;
    const src = (link.match(/^https?:\/\/(?:www\.)?([^\/]+)/) || [, ''])[1];
    let mins = 999;
    const t = Date.parse(it.pubDate);
    if (!isNaN(t)) mins = Math.max(0, Math.floor((now - t) / 60000));
    return { mk: 'kr', cat, src, ti: title, link, min: mins, tm: reltime(mins), sum: '', pop: Math.max(1, 100000 - mins) };
  }).filter(Boolean);
}
// 네이버 2회 재시도(429 백오프). 끝내 실패면 [] (해당 카테고리만 비고 나머지는 살림)
async function fetchNaver(cat, query, id, secret) {
  for (let i = 0; i < 3; i++) { try { return await fetchNaverOnce(cat, query, id, secret); } catch (e) { await sleep(300 * (i + 1)); } }
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

  const NID = (event && event.env && event.env.NAVER_ID) || '';
  const NSEC = (event && event.env && event.env.NAVER_SECRET) || '';
  const lists = await runPool(QUERIES.map(([mk, cat, q]) => {
    if (mk === 'us' && US_TICKERS[cat]) return () => fetchYahoo(cat, US_TICKERS[cat]);
    if (mk === 'kr' && NID && NSEC && KR_NAVER[cat]) return () => fetchNaver(cat, KR_NAVER[cat], NID, NSEC);
    return () => fetchQuery(mk, cat, q);
  }), 6);
  const items = [], seen = new Set();
  for (const list of lists) for (const n of list) {
    if (n.cat === '속보') n.cat = classify(n.ti);   // 속보 전용 쿼리 → 실제 카테고리 재분류
    const k = n.ti.slice(0, 28);
    if (seen.has(k)) continue;
    seen.add(k); items.push(n);
  }
  // 미국 기사 → 한국어 번역. 8건씩 줄바꿈 배치(서브리퀘스트·레이트리밋 최소화)·재시도. 원문은 ti_en/sum 보존
  const usItems = items.filter((n) => n.mk === 'us');
  const CHUNK = 8, chunks = [];
  for (let i = 0; i < usItems.length; i += CHUNK) chunks.push(usItems.slice(i, i + CHUNK));
  let trFailed = 0;
  await runPool(chunks.map((grp) => async () => {
    const { kos, ok } = await translateChunk(grp.map((n) => n.ti));
    grp.forEach((n, j) => { const en = n.ti; n.ti = kos[j] || en; n.ti_en = en; n.sum = en; });
    if (!ok) trFailed++;
  }), 3);
  // 속보 플래그(제목 마커) — 미국 기사는 원문(ti_en)도 검사
  items.forEach((n) => { n.breaking = BRK_RE.test((n.ti || '') + ' ' + (n.ti_en || '')); });
  items.sort((a, b) => a.min - b.min);
  items.forEach((n, i) => { n.hot = i < 6; });

  const data = { _updated: new Date().toISOString().slice(0, 19), count: items.length, items };
  // 충분히 많고(≥MIN_GOOD) 번역도 다 성공 → '양호한 스캔': last-good 으로 보관 + 10분 캐시
  if (items.length >= MIN_GOOD && trFailed === 0) {
    await writeLastGood(event, data);
    CACHE = { ts: Date.now(), data };
    return ok(data, false);
  }
  // 빈약/부분실패 스캔 → 보관해 둔 직전 양호본(last-good)이 더 풍부하면 그 최신본을 유지
  const lg = await readLastGood(event);
  const serve = (lg && (lg.items ? lg.items.length : 0) >= items.length) ? lg : data;
  CACHE = { ts: Date.now() - (TTL - 60000), data: serve };   // 짧게 캐시(다음 방문 재시도)
  return ok(serve, true);
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
  const event = { queryStringParameters: Object.fromEntries(url.searchParams), rawUrl: context.request.url, env: context.env };
  if (context.request.method === 'OPTIONS') {
    return new Response('', { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,OPTIONS' } });
  }
  const r = await __cfHandler(event);
  return new Response(r.body, { status: r.statusCode || 200, headers: r.headers || { 'Content-Type': 'application/json' } });
}
