// 미국 주식 실시간 히트맵 — /api/usheatmap?us=sp500|nasdaq&n=50|100|200
//   sp500  : 지수 편입종목 API(index/.INX/enrollStocks, 시총순 정렬·NYSE+나스닥 혼합)
//   nasdaq : 나스닥 거래소 시총 랭킹 전체(상위 N — 나스닥100을 포함하는 상위집합)
// 둘 다 delayTime 0 실시간, 한글 업종 그룹 내장, overMarketPriceInfo 로 프리·애프터마켓 체결가 제공
// (직접 폴링으로 초단위 체결 전진 확인). subrequest 예산: 페이지 1~6 + 섹터 1 (실패 시 스냅샷 +1) / 무료 50
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const CACHE = {};                 // `us|${n}` → {ts, data}
const TTL = 5 * 1000;             // 클라이언트 5초 폴링에 맞춤 (네이버 앱 자체 폴링은 7초)

const UNIVERSES = {
  sp500:  { url: (p) => 'https://api.stock.naver.com/index/.INX/enrollStocks?page=' + p + '&pageSize=100' },
  nasdaq: { url: (p) => 'https://api.stock.naver.com/stock/exchange/NASDAQ/marketValue?page=' + p + '&pageSize=100' },
};
const ALLOWED_N = [50, 100, 200, 500];        // 500 = S&P500 전체(503종목 중 유효분)

const iso = () => new Date().toISOString().slice(0, 19);
const num = (v) => parseFloat(String(v == null ? '' : v).replace(/,/g, ''));

async function naverUS(us, page) {
  const r = await fetch(UNIVERSES[us].url(page), { headers: { 'User-Agent': UA, 'Referer': 'https://m.stock.naver.com/' } });
  if (!r.ok) throw new Error('naver ' + us + ' p' + page + ' ' + r.status);
  const j = await r.json();
  return (j && j.stocks) || [];
}

/* 섹터: 핀비즈(finviz.com/map)와 동일한 분류 — 파이프라인이 핀비즈 맵 데이터에서 추출한
   us_sectors.json(GICS 11개 섹터 한글 + 세부 산업 핀비즈 원문, 약 5,500종목)을 조인한다.
   파일이 없거나 미등재 종목은 TRBC 업종코드 앞 2자리로 GICS 근사 폴백. */
const GICS_FALLBACK = { '50':'에너지','51':'소재','52':'산업재','53':'경기소비재','54':'필수소비재',
                        '55':'금융','56':'헬스케어','57':'기술','59':'유틸리티','60':'부동산' };
function trbcSector(s) {
  const code = String((s.industryCodeType || {}).code || '');
  if (code.slice(0, 4) === '5740') return '통신 서비스';
  return GICS_FALLBACK[code.slice(0, 2)]
    || ((s.industryCodeType || {}).industryGroupKor || '').trim() || '기타';
}
let SEC_CACHE = null, SEC_TS = 0;
async function loadUsSectors(rawUrl) {
  if (SEC_CACHE && Date.now() - SEC_TS < 60 * 60 * 1000) return SEC_CACHE;   // 정적 파일 — 1시간 캐시
  try {
    const r = await fetch(new URL('/data/us_sectors.json', rawUrl).toString());
    if (r.ok) { const j = await r.json(); SEC_CACHE = (j && j.sectors) || {}; SEC_TS = Date.now(); return SEC_CACHE; }
  } catch (e) { /* 폴백 유지 */ }
  return SEC_CACHE || {};
}

// SKHYV: SK하이닉스 ADR 중복 상장분 — 정규 티커 SKHY와 동일 종목·동일 시총으로 이중 집계됨
const EXCLUDE = new Set(['SKHYV']);

// ⚠ 거래정지는 제외하지 않는다(국내판 서킷브레이커 사고와 동일 원칙) — h:1 로 표시만.
function dropReason(s) {
  if (EXCLUDE.has(s.symbolCode)) return 'dup';
  if ((s.stockEndType || '') !== 'stock') return 'etf';            // ETF/ETN (랭킹엔 거의 없지만 방어)
  const cap = num(s.marketValue), px = num(s.closePrice), pct = num(s.fluctuationsRatio);
  if (!(isFinite(cap) && cap > 0 && isFinite(px) && px > 0 && isFinite(pct))) return 'bad';
  return null;
}

function norm(s) {
  const it = {
    code: s.symbolCode, rc: s.reutersCode || '', name: s.stockName,
    mk: (s.stockExchangeType || {}).code || '',
    sector: trbcSector(s),                                             // 핀비즈 맵 조인으로 아래에서 덮어씀
    ind: ((s.industryCodeType || {}).industryGroupKor || '').trim(),
    price: num(s.closePrice),
    // ⚠️ fluctuationsRatio 는 이미 부호 포함 — 다시 곱하지 말 것 (krheatmap 과 동일)
    pct: num(s.fluctuationsRatio),
    cap: num(s.marketValue) * 1000,               // marketValue 단위는 천달러 → 달러로 통일
  };
  const o = s.overMarketPriceInfo;
  if (o && o.overPrice != null && isFinite(num(o.overPrice))) {
    it.o = { p: num(o.overPrice), pct: num(o.fluctuationsRatio),
             t: o.tradingSessionType || '', s: o.overMarketStatus || '' };
  }
  const st = s.tradeStopType || {};
  if (st.code && st.code !== '1') it.h = 1;            // 거래정지 — 표시용
  return it;
}

async function loadSnapshot(rawUrl, us) {
  try {
    const r = await fetch(new URL('/data/usheatmap_' + us + '.json', rawUrl).toString());
    if (r.ok) return await r.json();
  } catch (e) { /* 폴백 실패 */ }
  return null;
}

// 시총순 정렬이므로 n=100 까지 1페이지, n=200 은 2페이지, n=500 은 6페이지(503종목 커버)
const pagesFor = (n) => (n <= 100 ? 1 : (n <= 200 ? 2 : 6));

async function __cfHandler(event) {
  const p = event.queryStringParameters || {};
  const us = (p.us === 'nasdaq') ? 'nasdaq' : 'sp500';
  let n = parseInt(p.n, 10);
  if (ALLOWED_N.indexOf(n) < 0) n = 100;

  const key = us + '|' + n;
  const c = CACHE[key];
  if (c && c.data && Date.now() - c.ts < TTL) return ok(c.data);

  const pages = pagesFor(n);
  const res = await Promise.all(
    Array.from({ length: pages }, (_, i) => naverUS(us, i + 1).catch(() => null))
  );
  const raw = [];
  for (const arr of res) if (arr) raw.push.apply(raw, arr);

  const drop = { etf: 0, bad: 0, dup: 0 };
  const seen = new Set(), items = [];
  for (const s of raw) {
    if (seen.has(s.symbolCode)) continue;
    const why = dropReason(s);
    if (why) { drop[why]++; continue; }
    seen.add(s.symbolCode); items.push(norm(s));
  }
  items.sort((a, b) => b.cap - a.cap);
  items.length = Math.min(items.length, n);

  // 라이브 전멸 또는 필터 전량 탈락 → 스냅샷 → 빈결과
  if (!items.length) {
    const snap = await loadSnapshot(event.rawUrl, us);
    let data;
    if (snap && Array.isArray(snap.items) && snap.items.length) {
      const its = snap.items.slice(0, n);
      data = Object.assign({}, snap, { source: 'snapshot', n, count: its.length, items: its });
    } else {
      data = { _updated: iso(), source: 'error', mkt: us, n, marketStatus: '', delay: 0, count: 0, items: [] };
    }
    if (raw.length) data.filtered = drop;
    CACHE[key] = { ts: Date.now() - (TTL - 5000), data };   // 곧 재시도
    return ok(data, true);
  }

  const secMap = await loadUsSectors(event.rawUrl);                    // 핀비즈 섹터·세부 산업 조인
  for (const it of items) {
    const m = secMap[it.code];
    if (m) { it.sector = m[0]; if (m[1]) it.ind = m[1]; }
  }

  const first = raw[0] || {};
  const halted = items.reduce((a, i) => a + (i.h ? 1 : 0), 0);
  const data = {
    _updated: iso(), source: 'naver', mkt: us, n,
    marketStatus: first.marketStatus || '',
    overStatus: ((first.overMarketPriceInfo || {}).tradingSessionType) || '',
    delay: ((first.stockExchangeType || {}).delayTime) || 0,
    count: items.length,
    halted: halted || undefined,
    filtered: drop,
    partial: res.some((x) => !x) || undefined,
    items,
  };
  CACHE[key] = { ts: Date.now(), data };
  return ok(data);
}

function ok(obj, short) {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': short ? 'public, max-age=30' : 'public, max-age=3',
      'Netlify-CDN-Cache-Control': short ? 'public, s-maxage=30' : 'public, s-maxage=5, stale-while-revalidate=60',
    },
    body: JSON.stringify(obj),
  };
}


// ── Cloudflare Pages Function 어댑터 ──
export async function onRequest(context) {
  const url = new URL(context.request.url);
  const event = { queryStringParameters: Object.fromEntries(url.searchParams), rawUrl: context.request.url };
  if (context.request.method === 'OPTIONS') {
    return new Response('', { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,OPTIONS' } });
  }
  const r = await __cfHandler(event);
  return new Response(r.body, { status: r.statusCode || 200, headers: r.headers || { 'Content-Type': 'application/json' } });
}
