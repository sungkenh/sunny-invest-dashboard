// 주가 차트 데이터 — /api/chart?sym=000660.KS&range=6mo&interval=1d
// 야후 차트 프록시(브라우저는 CORS로 직접 못 받음) → Lightweight Charts용 OHLC/거래량.
// 한국·미국 모두 야후 심볼(.KS/.KQ/티커)로 동작. 모듈 캐시 + 엣지 캐시.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const CACHE = {};
const TTL = 60 * 1000;

function round(x, n) { const p = Math.pow(10, n); return Math.round(x * p) / p; }
function pad(n) { return n < 10 ? '0' + n : '' + n; }
function ymd(sec, gmtoffset) {
  const d = new Date((sec + (gmtoffset || 0)) * 1000);
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}

exports.handler = async (event) => {
  const p = event.queryStringParameters || {};
  const sym = (p.sym || '').trim();
  if (!sym) return resp({ error: 'no sym' });
  const range = p.range || '6mo';
  const interval = p.interval || '1d';
  const key = sym + '|' + range + '|' + interval;
  const c = CACHE[key];
  if (c && Date.now() - c.ts < TTL) return resp(c.data);

  try {
    const u = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym)
      + '?range=' + encodeURIComponent(range) + '&interval=' + encodeURIComponent(interval);
    const r = await fetch(u, { headers: { 'User-Agent': UA } });
    const d = await r.json();
    const res = d && d.chart && d.chart.result && d.chart.result[0];
    if (!res || !res.timestamp || !res.indicators || !res.indicators.quote) {
      return resp({ error: 'no data', sym });
    }
    const ts = res.timestamp, q = res.indicators.quote[0], meta = res.meta || {};
    const intraday = /[mh]/.test(interval);   // 5m, 15m, 1h, 90m...
    const go = meta.gmtoffset || 0;
    const ohlc = [], vol = [];
    let last = null;
    for (let i = 0; i < ts.length; i++) {
      if (q.close[i] == null || q.open[i] == null) continue;
      const time = intraday ? ts[i] : ymd(ts[i], go);
      if (time === last) continue;             // 일봉 중복 날짜 제거
      last = time;
      ohlc.push({ time, open: round(q.open[i], 4), high: round(q.high[i], 4), low: round(q.low[i], 4), close: round(q.close[i], 4) });
      vol.push({ time, value: Math.round(q.volume[i] || 0), up: q.close[i] >= q.open[i] });
    }
    const pc = (meta.chartPreviousClose != null) ? meta.chartPreviousClose
      : (meta.previousClose != null) ? meta.previousClose : null;
    const data = { sym, name: meta.shortName || meta.longName || sym, currency: meta.currency || '', range, interval, ohlc, vol,
      exchange: meta.exchangeName || '',                                    // 거래소(NMS=나스닥, NYQ=NYSE …) → 벤치마크 지수 판별
      prevClose: pc != null ? round(pc, 4) : null,                          // 전일 종가(당일 시작 기준선)
      dayOpen: (intraday && ohlc.length) ? ohlc[0].open : null };           // 당일 첫 봉 시가
    CACHE[key] = { ts: Date.now(), data };
    return resp(data);
  } catch (e) {
    return resp({ error: String(e).slice(0, 80), sym });
  }
};

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
