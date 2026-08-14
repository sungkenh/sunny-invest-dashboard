// 토스증권 Open API 프록시 — 투자자별 수급 + 장 운영 캘린더 (공식 openapi.tossinvest.com v1.x)
//   GET /api/toss?fn=stockInvestors&code=005930[&n=30]   종목별 투자자 매매동향(일별 거래량, KR 전용)
//   GET /api/toss?fn=idxInvestors&mkt=KOSPI|KOSDAQ[&n=30][&interval=1d]  지수 투자자별 매매대금
//   GET /api/toss?fn=calendar&nation=kr|us[&date=YYYY-MM-DD]             장 운영(개장·휴장) 정보
// 인증: OAuth2 Client Credentials (POST /oauth2/token, Bearer JWT, expires_in≈86400).
//   ⚠ 클라이언트당 유효 토큰 1개 — 재발급 시 이전 토큰 즉시 무효. 모듈 캐시 + (있으면) KV에
//   공유 저장해 아이솔레이트 간 재발급 경쟁을 최소화하고, 401 시 1회 재발급·재시도한다.
// 키: Cloudflare Pages 환경변수 TOSS_CLIENT_ID / TOSS_CLIENT_SECRET (secret).
//   미설정이면 {enabled:false} 200 → 프런트는 기능 숨김·기존 소스(네이버 근사) 폴백.
// 요율: STOCK_TRADING_TREND 10/s · MARKET_INDICATOR 10/s · MARKET_INFO 3/s — 30분·6시간 캐시로 흡수.
//
// ⛔ 2026-08 사용 중지. 구현·테스트는 나중에 다시 쓸 수 있게 그대로 보관하고 진입점만 막는다.
//    (토큰 발급이 unidentified-client 로 계속 실패해 매 스캔마다 헛호출이 쌓이던 상태였다.)
//    되살리려면 DISABLED 를 false 로 바꾸고 Cloudflare 환경변수에 키를 등록하면 된다.
const DISABLED = true;
const BASE = 'https://openapi.tossinvest.com';
const CACHE = {};                    // `${fn}|${args}` → {ts, data}
const TTL_TREND = 30 * 60 * 1000;    // 수급 30분 (일별 데이터 — 장중 잠정치 갱신 주기로 충분)
const TTL_CAL = 6 * 60 * 60 * 1000;  // 캘린더 6시간
let TOKEN = { v: '', exp: 0 };       // 모듈(아이솔레이트) 토큰 캐시

const iso = () => new Date().toISOString().slice(0, 19);
const num = (v) => { const x = parseFloat(String(v == null ? '' : v).replace(/,/g, '')); return isFinite(x) ? x : null; };

// {buy, sell, net} 관용 추출 — 거래량(…Volume)·거래대금(…Amount) 필드 모두 대응
function tri(o) {
  if (!o || typeof o !== 'object') return null;
  const pick = (...ks) => { for (const k of ks) if (o[k] != null) return num(o[k]); return null; };
  const buy = pick('buyAmount', 'buyVolume', 'buy');
  const sell = pick('sellAmount', 'sellVolume', 'sell');
  let net = pick('netAmount', 'netVolume', 'net', 'netBuyAmount', 'netBuyVolume');
  if (net == null && buy != null && sell != null) net = buy - sell;
  return (buy == null && sell == null && net == null) ? null : { buy, sell, net };
}

async function issueToken(env) {
  // 등록 실수(복사 시 공백·줄바꿈·따옴표) 방어: trim 후 사용
  const id = String(env.TOSS_CLIENT_ID || '').trim().replace(/^["']|["']$/g, '');
  const secret = String(env.TOSS_CLIENT_SECRET || '').trim().replace(/^["']|["']$/g, '');
  const creds = { grant_type: 'client_credentials', client_id: id, client_secret: secret };
  // 스펙엔 본문 스키마만 있고 미디어타입 확인이 안 돼 JSON → form → Basic 헤더 순서로 시도 (표준 OAuth2 호환 폭 최대화)
  const attempts = [
    { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(creds) },
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(creds).toString() },
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': 'Basic ' + btoa(id + ':' + secret) },
      body: 'grant_type=client_credentials' },
  ];
  let last = '';
  for (const a of attempts) {
    const r = await fetch(BASE + '/oauth2/token', { method: 'POST', headers: a.headers, body: a.body });
    if (r.ok) {
      const j = await r.json();
      if (j.access_token) return { v: j.access_token, exp: Date.now() + Math.max(60, (j.expires_in || 86400) - 300) * 1000 };
      last = 'token empty'; continue;
    }
    let code = '';
    try { code = (((await r.json()) || {}).error || {}).code || ''; } catch (e) {}
    last = 'token ' + r.status + (code ? ' ' + code : '');   // 진단용 에러 코드(비밀값 미포함)
    if (r.status >= 500) break;
  }
  throw new Error(last || 'token fail');
}

async function getToken(env, force) {
  if (!force && TOKEN.v && Date.now() < TOKEN.exp) return TOKEN.v;
  const kv = env.KV;
  if (!force && kv) {                                     // 다른 아이솔레이트가 발급한 토큰 공유
    try {
      const s = await kv.get('toss.token');
      if (s) { const t = JSON.parse(s); if (t.v && Date.now() < t.exp) { TOKEN = t; return t.v; } }
    } catch (e) {}
  }
  TOKEN = await issueToken(env);
  if (kv) { try { await kv.put('toss.token', JSON.stringify(TOKEN), { expirationTtl: 86400 }); } catch (e) {} }
  return TOKEN.v;
}

// 토스 GET — 401(다른 아이솔레이트의 재발급으로 무효화) 시 1회 강제 재발급 후 재시도
async function tossGet(env, path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const tk = await getToken(env, attempt > 0);
    const r = await fetch(BASE + path, { headers: { 'Authorization': 'Bearer ' + tk } });
    if (r.status === 401 && attempt === 0) continue;
    if (!r.ok) throw new Error('toss ' + r.status + ' ' + path.split('?')[0]);
    const j = await r.json();
    return j.result !== undefined ? j.result : j;         // ApiResponse envelope → result
  }
  throw new Error('unreachable');
}

// ── fn 구현 ──
async function fnStockInvestors(env, p) {
  const code = String(p.code || '').replace(/\D/g, '').slice(0, 6);
  if (code.length !== 6) return { error: 'code는 6자리 KRX 종목코드' };
  const n = Math.min(Math.max(parseInt(p.n, 10) || 30, 1), 100);
  const res = await tossGet(env, '/api/v1/stocks/' + code + '/investor-trading?count=' + n);
  const records = (res.records || []).map((r) => {
    const h = r.foreignerHolding;
    return {
      date: r.date, updatedAt: r.updatedAt || null,
      frgn: tri(r.foreigner), inst: tri(r.institution), indi: tri(r.individual), other: tri(r.otherCorporation),
      hold: h ? { qty: num(h.holdingQuantity), rate: num(h.holdingRate) } : null,   // 외국인 실제 보유(주·%)
    };
  });
  return { unit: 'volume', code, records };              // 단위: 주식 수 (등록외국인 기준)
}

async function fnIdxInvestors(env, p) {
  const mkt = p.mkt === 'KOSDAQ' ? 'KOSDAQ' : 'KOSPI';
  const interval = ['1d', '1w', '1mo', '1y'].includes(p.interval) ? p.interval : '1d';
  const n = Math.min(Math.max(parseInt(p.n, 10) || 30, 1), 100);
  const res = await tossGet(env, '/api/v1/market-indicators/' + mkt + '/investor-trading?interval=' + interval + '&count=' + n);
  const records = (res.records || []).map((r) => ({
    date: r.date, updatedAt: r.updatedAt || null,
    indi: tri(r.individual), frgn: tri(r.foreigner), inst: tri(r.institution), other: tri(r.otherCorporation),
  }));
  return { unit: 'amount', mkt, interval, records };     // 단위: 원 (외국인 = 등록+미등록 합계)
}

function calDay(d, sessions) {
  if (!d) return null;
  const s = {};
  for (const k of sessions) { const v = d[k] || (d.integrated || {})[k]; if (v && v.startTime) s[k] = { start: v.startTime, end: v.endTime }; }
  return { date: d.date, open: Object.keys(s).length > 0, sessions: s };
}
async function fnCalendar(env, p) {
  const nation = p.nation === 'us' ? 'US' : 'KR';
  const q = /^\d{4}-\d{2}-\d{2}$/.test(p.date || '') ? '?date=' + p.date : '';
  const res = await tossGet(env, '/api/v1/market-calendar/' + nation + q);
  const sessions = nation === 'US' ? ['dayMarket', 'preMarket', 'regularMarket', 'afterMarket'] : ['preMarket', 'regularMarket', 'afterMarket'];
  return {
    nation: nation.toLowerCase(),
    today: calDay(res.today, sessions),
    prev: calDay(res.previousBusinessDay, sessions),
    next: calDay(res.nextBusinessDay, sessions),
  };
}

const FNS = { stockInvestors: [fnStockInvestors, TTL_TREND], idxInvestors: [fnIdxInvestors, TTL_TREND], calendar: [fnCalendar, TTL_CAL] };

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') {
    return new Response('', { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,OPTIONS' } });
  }
  // 사용 중지 — 키가 남아 있어도 토스로 나가지 않는다. 미설정과 같은 응답이라 프런트는 기존 «키 없음»
  // 경로(수급 카드 숨김·네이버 소진율 폴백)를 그대로 탄다. 되살릴 때는 이 상수만 false 로.
  if (DISABLED) return ok({ _updated: iso(), enabled: false, disabled: true }, 3600);

  const url = new URL(request.url);
  const p = Object.fromEntries(url.searchParams);

  if (!env || !env.TOSS_CLIENT_ID || !env.TOSS_CLIENT_SECRET) {
    return ok({ _updated: iso(), enabled: false }, 600);   // 키 미설정 — 프런트 기능 숨김
  }
  const entry = FNS[p.fn];
  if (!entry) return ok({ _updated: iso(), enabled: true, error: 'fn은 stockInvestors|idxInvestors|calendar' }, 60);

  const key = p.fn + '|' + (p.code || '') + '|' + (p.mkt || '') + '|' + (p.interval || '') + '|' + (p.nation || '') + '|' + (p.date || '') + '|' + (p.n || '');
  const c = CACHE[key];
  if (c && Date.now() - c.ts < entry[1]) return ok(c.data, Math.round(entry[1] / 2000));

  let data;
  try {
    data = Object.assign({ _updated: iso(), enabled: true, fn: p.fn }, await entry[0](env, p));
    if (!data.error) CACHE[key] = { ts: Date.now(), data };
  } catch (e) {
    data = { _updated: iso(), enabled: true, fn: p.fn, error: String(e && e.message || e).slice(0, 120) };
    return ok(data, 30);                                   // 실패는 짧게만 캐시(재시도 허용)
  }
  return ok(data, Math.round(entry[1] / 2000));
}

function ok(obj, sMaxAge) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=' + Math.min(sMaxAge || 60, 600),
      'Netlify-CDN-Cache-Control': 'public, s-maxage=' + (sMaxAge || 60) + ', stale-while-revalidate=3600',
    },
  });
}
