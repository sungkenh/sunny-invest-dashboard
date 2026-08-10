// 종목 재무제표 프록시 — /api/finance?mkt=kr|us&code=005930|AAPL&period=annual|quarter
//   kr: m.stock.naver.com/api/stock/{code}/finance/{period} → financeInfo.{trTitleList,rowList}
//       (단위: 매출·이익 = 억원 · 이익률/ROE/부채비율 = % · EPS/BPS/주당배당금 = 원 · PER/PBR = 배)
//   us: api.stock.naver.com/stock/{rc}/finance/{period} → 최상위 {unit:'USD(백만)…',trTitleList,rowList}
//       접미사 없는 야후식 티커는 무접미사 → .O → .K 순서로 자동 탐색 (valuation.js 와 동일)
// rowList 는 [{title:'매출액', columns:{'202312':{value:'2,589,355'},…}}] — 열 순서는 trTitleList,
// isConsensus='Y' 열은 증권가 추정치(E). 재무 데이터는 분기 단위로만 변해 6시간 캐시.
// subrequest 예산: 1(kr) / 최대 3(us 접미사 탐색) per 호출.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const NHDR = { 'User-Agent': UA, 'Referer': 'https://m.stock.naver.com/' };
const CACHE = {};                        // `${mkt}|${code}|${period}` → {ts, data}
const TTL = 6 * 60 * 60 * 1000;

const iso = () => new Date().toISOString().slice(0, 19);
function numv(v) {
  if (v == null) return null;
  const x = parseFloat(String(v).replace(/,/g, ''));
  return isFinite(x) ? x : null;         // '-' · 'N/A' → null
}

// trTitleList 순서 기준으로 열 정렬(과거→미래) + 각 행을 열에 맞춰 숫자·원문 동시 제공
function normalize(trTitleList, rowList, unit) {
  const cols = (trTitleList || [])
    .filter((t) => t && t.key)
    .map((t) => ({ key: String(t.key), title: String(t.title || t.key), est: t.isConsensus === 'Y' }));
  cols.sort((a, b) => numv(a.key.replace(/\D/g, '')) - numv(b.key.replace(/\D/g, '')));
  const rows = (rowList || []).filter((r) => r && r.title).map((r) => {
    const c = r.columns || {};
    return {
      title: String(r.title),
      vals: cols.map((k) => numv((c[k.key] || {}).value)),
      raw: cols.map((k) => { const v = (c[k.key] || {}).value; return v == null ? '' : String(v); }),
    };
  });
  return { unit: unit || '', cols, rows };
}

async function fetchFin(mkt, code, period) {
  if (mkt === 'kr') {
    const r = await fetch('https://m.stock.naver.com/api/stock/' + encodeURIComponent(code) + '/finance/' + period, { headers: NHDR });
    if (!r.ok) throw new Error('kr ' + code + ' ' + r.status);
    const j = await r.json();
    const fi = j.financeInfo || {};
    const d = normalize(fi.trTitleList, fi.rowList, '억원 · %, 배, 원 생략');
    return d.rows.length ? d : null;
  }
  const cands = code.indexOf('.') >= 0 ? [code] : [code, code + '.O', code + '.K'];
  let responded = false;
  for (const c of cands) {
    const r = await fetch('https://api.stock.naver.com/stock/' + encodeURIComponent(c) + '/finance/' + period, { headers: NHDR }).catch(() => null);
    if (!r || !r.ok) continue;
    responded = true;
    const j = await r.json();
    const d = normalize(j.trTitleList, j.rowList, j.unit || 'USD(백만)');
    if (d.rows.length) return d;
  }
  if (!responded) throw new Error('us ' + code);
  return null;
}

async function __cfHandler(event) {
  const p = event.queryStringParameters || {};
  const mkt = p.mkt === 'us' ? 'us' : 'kr';
  const period = p.period === 'quarter' ? 'quarter' : 'annual';
  const code = String(p.code || '').trim();
  if (!code) return ok({ _updated: iso(), mkt, period, error: 'code 필요' });

  const key = mkt + '|' + code + '|' + period;
  const c = CACHE[key];
  if (c && Date.now() - c.ts < TTL) return ok(c.data);

  let data;
  try {
    const d = await fetchFin(mkt, code, period);
    data = Object.assign({ _updated: iso(), mkt, code, period }, d || { unit: '', cols: [], rows: [] });
    CACHE[key] = { ts: Date.now(), data };            // 빈 결과(미제공 종목)도 캐시 — 반복 탐색 방지
  } catch (e) {
    data = { _updated: iso(), mkt, code, period, unit: '', cols: [], rows: [], error: 'fetch' };
  }
  return ok(data);
}

function ok(obj) {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600',
      'Netlify-CDN-Cache-Control': 'public, s-maxage=21600, stale-while-revalidate=86400',
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
