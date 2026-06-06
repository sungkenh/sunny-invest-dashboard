// 테마별 전문가 데스크 — /api/themes
// 큐레이션 thesis(durable) + 바스켓 라이브 등락(야후 chart) + 최신 촉매 뉴스(구글뉴스 RSS).
// 방문 시점 수집 → 데일리(엣지캐시 30분) 갱신. 모듈 캐시 + 엣지 캐시.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
let CACHE = { ts: 0, data: null };
const TTL = 30 * 60 * 1000;

// 테마 = 큐레이션 정의(thesis·바스켓·뉴스쿼리). 바스켓은 야후 심볼(.KS/.KQ/티커).
const THEMES = [
  { nm: 'AI · 반도체', desk: '반도체 섹터 데스크', op: 'op-buy', opTxt: '비중확대',
    pts: ['하이퍼스케일러 CapEx 가이던스 연속 상향', 'HBM 공급 부족 2026년까지 지속', '전력·냉각 인프라로 수혜 확산'],
    basket: [['NVDA', '엔비디아'], ['000660.KS', 'SK하이닉스'], ['042700.KS', '한미반도체'], ['SMCI', '슈퍼마이크로']],
    q: '엔비디아 OR HBM OR AI반도체' },
  { nm: '방산 · 우주', desk: '방산 데스크', op: 'op-buy', opTxt: '비중확대',
    pts: ['글로벌 국방비 GDP 2%+ 증액 기조', 'K-방산 수출 파이프라인 확대', '장기 수주잔고 가시성 높음'],
    basket: [['012450.KS', '한화에어로'], ['079550.KS', 'LIG넥스원'], ['064350.KS', '현대로템'], ['RTX', 'RTX']],
    q: '방산 OR 한화에어로스페이스 OR 방산수출' },
  { nm: '원전 · 전력인프라', desk: '에너지 데스크', op: 'op-buy', opTxt: '비중확대',
    pts: ['AI 데이터센터 전력수요 폭증', 'SMR·송배전 투자 사이클', '전력기기 공급 타이트'],
    basket: [['034020.KS', '두산에너빌리티'], ['GEV', 'GE Vernova'], ['VST', '비스트라'], ['010120.KS', 'LS ELECTRIC']],
    q: '원전 OR SMR OR 전력 데이터센터' },
  { nm: '2차전지 · 소재', desk: '2차전지 데스크', op: 'op-hold', opTxt: '중립',
    pts: ['전기차 캐즘 단기 지속', '메탈 가격 바닥 다지기', '고체전지 로드맵 장기 모멘텀'],
    basket: [['373220.KS', 'LG에너지솔루션'], ['247540.KQ', '에코프로비엠'], ['003670.KS', '포스코퓨처엠']],
    q: '2차전지 OR 전기차 배터리 OR 에코프로' },
  { nm: '바이오 · 헬스케어', desk: '헬스케어 데스크', op: 'op-hold', opTxt: '중립',
    pts: ['비만치료제(GLP-1) 시장 확대', '대형 M&A·라이선스 딜 활발', '금리 인하 시 밸류 우호'],
    basket: [['LLY', '일라이릴리'], ['NVO', '노보노디스크'], ['196170.KQ', '알테오젠']],
    q: '비만치료제 OR GLP-1 OR 바이오 신약' },
  { nm: '금융 · 금리', desk: '매크로·금융 데스크', op: 'op-hold', opTxt: '중립',
    pts: ['금리인하 사이클 진입 국면', '국내 밸류업 배당 매력', '순이자마진 둔화 주의'],
    basket: [['105560.KS', 'KB금융'], ['138040.KS', '메리츠금융'], ['JPM', 'JP모건']],
    q: 'FOMC OR 기준금리 OR 밸류업' },
];

function round(x, n) { const p = Math.pow(10, n); return Math.round(x * p) / p; }
function reltime(mins) { if (mins < 1) return '방금'; if (mins < 60) return mins + '분 전'; const h = Math.floor(mins / 60); if (h < 24) return h + '시간 전'; return Math.floor(h / 24) + '일 전'; }
function decode(s) {
  return (s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&').trim();
}
function tag(block, name) { const m = block.match(new RegExp('<' + name + '[^>]*>([\\s\\S]*?)<\\/' + name + '>')); return m ? m[1] : ''; }

// 바스켓 한 종목 오늘 등락% (야후 chart, crumb 불필요)
async function quotePct(sym) {
  try {
    const u = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?interval=1d&range=1d';
    const r = await fetch(u, { headers: { 'User-Agent': UA } });
    const d = await r.json();
    const m = d && d.chart && d.chart.result && d.chart.result[0] && d.chart.result[0].meta;
    if (!m || typeof m.regularMarketPrice !== 'number') return null;
    const pc = (typeof m.chartPreviousClose === 'number') ? m.chartPreviousClose : m.previousClose;
    if (!pc) return null;
    return round((m.regularMarketPrice - pc) / pc * 100, 2);
  } catch (e) { return null; }
}

async function basketPerf(basket) {
  const picks = await Promise.all(basket.map(async ([sym, name]) => ({ name, pct: await quotePct(sym) })));
  const valid = picks.filter(p => typeof p.pct === 'number');
  const avg = valid.length ? round(valid.reduce((s, p) => s + p.pct, 0) / valid.length, 2) : null;
  let lead = null;
  for (const p of valid) if (!lead || p.pct > lead.pct) lead = p;
  return { picks, perf: avg, lead };
}

// 테마 최신 촉매 뉴스 1건 (구글뉴스 RSS, 한국어)
async function latestNews(q) {
  try {
    const url = 'https://news.google.com/rss/search?q=' + encodeURIComponent(q) + '&hl=ko&gl=KR&ceid=KR:ko';
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    const xml = await r.text();
    const item = (xml.match(/<item\b[\s\S]*?<\/item>/) || [])[0];
    if (!item) return null;
    let ti = decode(tag(item, 'title'));
    const link = decode(tag(item, 'link'));
    let src = decode(tag(item, 'source'));
    if (src && ti.endsWith(' - ' + src)) ti = ti.slice(0, -(src.length + 3)).trim();
    else if (!src && ti.includes(' - ')) { const i = ti.lastIndexOf(' - '); src = ti.slice(i + 3).trim(); ti = ti.slice(0, i).trim(); }
    let tm = '';
    const pd = tag(item, 'pubDate');
    if (pd) { const t = Date.parse(pd); if (!isNaN(t)) tm = reltime(Math.max(0, Math.floor((Date.now() - t) / 60000))); }
    return ti ? { ti, link, src, tm } : null;
  } catch (e) { return null; }
}

exports.handler = async () => {
  if (CACHE.data && Date.now() - CACHE.ts < TTL) return ok(CACHE.data);
  const themes = await Promise.all(THEMES.map(async (t) => {
    const [bp, cat] = await Promise.all([basketPerf(t.basket), latestNews(t.q)]);
    return { nm: t.nm, desk: t.desk, op: t.op, opTxt: t.opTxt, pts: t.pts,
      perf: bp.perf, lead: bp.lead, picks: bp.picks, cat };
  }));
  const data = { _updated: new Date().toISOString().slice(0, 19), count: themes.length, themes };
  CACHE = { ts: Date.now(), data };
  return ok(data);
};

function cors() { return { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }; }
function ok(obj) {
  return { statusCode: 200, headers: Object.assign(cors(), {
    'Cache-Control': 'public, max-age=300',
    'Netlify-CDN-Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=3600',
  }), body: JSON.stringify(obj) };
}
