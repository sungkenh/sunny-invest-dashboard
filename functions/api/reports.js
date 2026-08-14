// 증권사 리포트 / 공식 공시: /api/reports?sym=005930.KS | NVDA
//  · 한국(.KS/.KQ): 네이버 금융 리서치(종목코드 필터) → 제목·증권사·날짜·PDF 직접 링크
//  · 미국: SEC EDGAR(티커→CIK→최근 공시) → 10-K·10-Q·8-K 등 공식 보고서 문서 링크
// 심볼별 모듈 캐시(30분) + 엣지 캐시.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const SEC_UA = 'AlphaDesk Research contact@alphadesk.example';   // SEC 공정접근정책: 연락처 포함 UA 필요
const CACHE = {};
const TTL = 30 * 60 * 1000;
let SEC_TICKERS = null, SEC_TS = 0;

function strip(s) { return (s || '').replace(/<[^>]+>/g, ''); }
function dec(s) {
  return strip(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'").replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&').trim();
}

// ── 한국: 네이버 금융 리서치(종목분석 리포트) ──────────────────────────
async function naverReports(code) {
  const u = 'https://finance.naver.com/research/company_list.naver?searchType=itemCode&itemCode=' + code;
  const r = await fetch(u, { headers: { 'User-Agent': UA } });
  const buf = await r.arrayBuffer();
  const html = new TextDecoder('euc-kr').decode(buf);           // 네이버는 EUC-KR
  const rows = (html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || []).filter((x) => x.includes('company_read'));
  const out = [];
  for (const row of rows) {
    const tm = row.match(/company_read\.naver[^"]*">([\s\S]*?)<\/a>/);
    const title = tm ? dec(tm[1]) : '';
    if (!title) continue;
    const tds = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => dec(m[1]));
    const broker = tds[2] || '';
    const pm = row.match(/href="(https:\/\/stock\.pstatic\.net\/[^"]+\.pdf)"/);
    const dm = row.match(/(\d{2}\.\d{2}\.\d{2})/);
    const nm = row.match(/company_read\.naver\?nid=(\d+)/);
    const pdf = pm ? pm[1] : '';
    const url = pdf || (nm ? 'https://finance.naver.com/research/company_read.naver?nid=' + nm[1] : u);
    out.push({ title, broker, date: dm ? dm[1] : '', url, pdf: !!pdf });
    if (out.length >= 15) break;
  }
  return out;
}

// ── 미국: SEC EDGAR 공식 공시 ───────────────────────────────────────────
const FORM_KO = { '10-K': '연차보고서 (10-K)', '10-Q': '분기보고서 (10-Q)', '8-K': '주요사항보고 (8-K)',
  '20-F': '연차보고서 (20-F)', '6-K': '수시보고 (6-K)', 'S-1': '증권신고서 (S-1)', 'DEF 14A': '주주총회 안내 (DEF 14A)' };
async function secTickerMap() {
  if (SEC_TICKERS && Date.now() - SEC_TS < 24 * 3600 * 1000) return SEC_TICKERS;
  const r = await fetch('https://www.sec.gov/files/company_tickers.json', { headers: { 'User-Agent': SEC_UA } });
  const j = await r.json();
  const m = {};
  for (const k in j) { const t = (j[k].ticker || '').toUpperCase(); if (t) m[t] = j[k].cik_str; }
  SEC_TICKERS = m; SEC_TS = Date.now();
  return m;
}
async function secFilings(ticker) {
  const map = await secTickerMap();
  const cikNum = map[ticker.toUpperCase()];
  if (cikNum == null) return [];
  const cik = String(cikNum).padStart(10, '0');
  const r = await fetch('https://data.sec.gov/submissions/CIK' + cik + '.json', { headers: { 'User-Agent': SEC_UA } });
  const j = await r.json();
  const rec = (j.filings && j.filings.recent) || {};
  const F = rec.form || [], D = rec.filingDate || [], A = rec.accessionNumber || [], P = rec.primaryDocument || [], DD = rec.primaryDocDescription || [];
  const out = [];
  for (let i = 0; i < F.length && out.length < 15; i++) {
    if (!FORM_KO[F[i]]) continue;
    const acc = (A[i] || '').replace(/-/g, '');
    if (!acc || !P[i]) continue;
    out.push({ title: FORM_KO[F[i]] + (DD[i] ? ' · ' + DD[i] : ''), broker: 'SEC EDGAR', date: D[i],
      url: 'https://www.sec.gov/Archives/edgar/data/' + cikNum + '/' + acc + '/' + P[i], form: F[i], pdf: false });
  }
  return out;
}

async function __cfHandler(event) {
  const sym = (((event && event.queryStringParameters) || {}).sym || '').trim();
  if (!sym) return resp(400, { error: 'sym required', items: [] });
  const ck = sym.toUpperCase();
  if (CACHE[ck] && Date.now() - CACHE[ck].ts < TTL) return resp(200, CACHE[ck].data);

  let items = [], mk = 'us', src = '';
  try {
    const km = sym.match(/^(\d{6})\.(KS|KQ)$/i);
    if (km) { mk = 'kr'; src = '네이버 금융 리서치'; items = await naverReports(km[1]); }
    else { mk = 'us'; src = 'SEC EDGAR'; items = await secFilings(sym.replace(/\.(KS|KQ)$/i, '')); }
  } catch (e) { /* 빈 결과 반환 */ }

  const data = { sym, mk, src, count: items.length, items, _updated: new Date().toISOString().slice(0, 19) };
  CACHE[ck] = { ts: Date.now(), data };
  return resp(200, data);
};

function resp(code, obj) {
  return {
    statusCode: code,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=300',
      'Netlify-CDN-Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=3600',
    },
    body: JSON.stringify(obj),
  };
}


// ── Cloudflare Pages Function 어댑터 (자동 변환) ──
export async function onRequest(context) {
  const url = new URL(context.request.url);
  const event = { queryStringParameters: Object.fromEntries(url.searchParams), rawUrl: context.request.url };
  if (context.request.method === 'OPTIONS') return new Response('', { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' } });
  const r = await __cfHandler(event);
  return new Response(r.body, { status: r.statusCode || 200, headers: r.headers || { 'Content-Type': 'application/json' } });
}
