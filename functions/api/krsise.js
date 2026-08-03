// 한국 종목 일·주봉 시세 + 외국인 소진율 — /api/krsise?code=005930&tf=day|week&days=420
// 네이버 siseJson 프록시(수정주가·외국인 보유한도 소진율 포함). 매매 시그널 페이지의
// 스윙(일봉)·장기(주봉) 캔들과 외국인 수급 판정에 쓴다. subrequest 1 / 무료 50.
// 행 포맷은 pipeline/fetch_kr_perf.py 와 동일: ["YYYYMMDD", 시, 고, 저, 종, 량, 소진율]
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const CACHE = {};                 // `${code}|${tf}|${days}` → {ts, data}
const TTL = 60 * 1000;

const iso = () => new Date().toISOString().slice(0, 19);

/*PARSE-BEGIN*/
// siseJson 본문(JS 배열 리터럴 텍스트)에서 데이터 행만 추출. 헤더 행은 숫자 날짜가 아니라 걸러진다.
function parseSise(text) {
  const out = [];
  const re = /\[\s*"(\d{8})"\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.-]+)\s*\]/g;
  let m;
  while ((m = re.exec(text))) {
    const c = parseFloat(m[5]);
    if (!(c > 0)) continue;                        // 종가 0/결측 행 방어
    out.push({ d: m[1], o: +m[2], h: +m[3], l: +m[4], c, v: +m[6], f: parseFloat(m[7]) });
  }
  return out;
}
/*PARSE-END*/

function kstYMD(offsetDays) {
  const d = new Date(Date.now() + 9 * 3600 * 1000 - (offsetDays || 0) * 86400 * 1000);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

async function __cfHandler(event) {
  const p = event.queryStringParameters || {};
  const code = String(p.code || '').trim();
  if (!/^\d{6}$/.test(code)) return resp({ error: 'bad code' });
  const tf = p.tf === 'week' ? 'week' : 'day';
  let days = parseInt(p.days, 10);
  if (!isFinite(days)) days = tf === 'week' ? 2600 : 420;
  days = Math.min(3000, Math.max(30, days));

  const key = code + '|' + tf + '|' + days;
  const c = CACHE[key];
  if (c && Date.now() - c.ts < TTL) return resp(c.data);

  try {
    const u = 'https://api.finance.naver.com/siseJson.naver?symbol=' + code
      + '&requestType=1&startTime=' + kstYMD(days) + '&endTime=' + kstYMD(0) + '&timeframe=' + tf;
    const r = await fetch(u, { headers: { 'User-Agent': UA, 'Referer': 'https://finance.naver.com/' } });
    if (!r.ok) return resp({ error: 'naver ' + r.status, code });
    const rows = parseSise(await r.text());
    if (!rows.length) return resp({ error: 'no data', code });
    const data = { _updated: iso(), code, tf, days, count: rows.length, rows };
    CACHE[key] = { ts: Date.now(), data };
    return resp(data);
  } catch (e) {
    return resp({ error: String(e).slice(0, 80), code });
  }
}

function resp(obj) {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=30',
      'Netlify-CDN-Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
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
