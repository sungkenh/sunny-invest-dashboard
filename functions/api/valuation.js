// 종목 밸류에이션(PER·PBR·ROE 등) 프록시 — /api/valuation?mkt=kr|us&codes=005930,000660 (최대 20개)
//   kr: m.stock.naver.com/api/stock/{code}/integration → totalInfos [{code,value}]
//       per '18.67배', pbr '3.21배', eps '12,372원', bps, dividendYieldRatio '0.72%',
//       highPriceOf52Weeks/lowPriceOf52Weeks (숫자)
//   us: api.stock.naver.com/stock/{reutersCode}/basic → stockItemTotalInfos (동일 {code,value} 배열)
// ROE 는 네이버가 직접 주지 않아 PBR/PER×100 으로 근사(둘 다 최근 실적 기준이라 정합).
// 밸류 지표는 하루 단위로만 변해 코드당 6시간 모듈 캐시 — 반복 조회 시 subrequest 0.
// subrequest 예산: 미캐시 코드 수(≤20)/호출, 무료 50 한도 내.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const CACHE = {};                       // `${mkt}|${code}` → {ts, v}
const TTL = 6 * 60 * 60 * 1000;         // 6시간
const MAX_CODES = 20;

const iso = () => new Date().toISOString().slice(0, 19);
// '18.67배' '12,372원' '0.72%' '380,000' → 숫자 (음수 PER 'N/A' 등은 null)
function num(v) {
  if (v == null) return null;
  const x = parseFloat(String(v).replace(/,/g, '').replace(/(배|원|달러|%|\s)/g, ''));
  return isFinite(x) ? x : null;
}

function parseInfos(arr) {
  const m = {};
  for (const t of (arr || [])) if (t && t.code) m[t.code] = t.value;
  const per = num(m.per), pbr = num(m.pbr);
  const v = {
    per, pbr,
    eps: num(m.eps), bps: num(m.bps),
    cnsPer: num(m.cnsPer),                                  // 컨센서스(추정) PER — 있으면 참고 표시
    divYield: num(m.dividendYieldRatio),
    hi52: num(m.highPriceOf52Weeks), lo52: num(m.lowPriceOf52Weeks),
    roe: (per && per > 0 && pbr && pbr > 0) ? Math.round(pbr / per * 1000) / 10 : null,
  };
  // 전부 비면 데이터 없음으로 간주
  return (v.per == null && v.pbr == null && v.eps == null) ? null : v;
}

async function fetchOne(mkt, code) {
  const url = mkt === 'kr'
    ? 'https://m.stock.naver.com/api/stock/' + encodeURIComponent(code) + '/integration'
    : 'https://api.stock.naver.com/stock/' + encodeURIComponent(code) + '/basic';
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': 'https://m.stock.naver.com/' } });
  if (!r.ok) throw new Error(mkt + ' ' + code + ' ' + r.status);
  const j = await r.json();
  return parseInfos(mkt === 'kr' ? j.totalInfos : j.stockItemTotalInfos);
}

async function __cfHandler(event) {
  const p = event.queryStringParameters || {};
  const mkt = p.mkt === 'us' ? 'us' : 'kr';
  const codes = String(p.codes || p.code || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, MAX_CODES);
  if (!codes.length) return ok({ _updated: iso(), mkt, vals: {} });

  const vals = {}, misses = [];
  for (const c of codes) {
    const hit = CACHE[mkt + '|' + c];
    if (hit && Date.now() - hit.ts < TTL) vals[c] = hit.v;
    else misses.push(c);
  }
  await Promise.all(misses.map((c) =>
    fetchOne(mkt, c)
      .then((v) => { CACHE[mkt + '|' + c] = { ts: Date.now(), v }; vals[c] = v; })
      .catch(() => { vals[c] = null; })            // 실패는 캐시하지 않음 — 다음 호출 때 재시도
  ));
  return ok({ _updated: iso(), mkt, vals });
}

function ok(obj) {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=1800',
      'Netlify-CDN-Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
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
