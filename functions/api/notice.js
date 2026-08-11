// 종목 공시 — /api/notice?code=005930
// 네이버 금융 종목 공시 페이지(finance.naver.com/item/news_notice.naver, EUC-KR HTML)를 파싱해
// {items:[{title, info, date, link}]} 로 정규화. 국내 개별주 전용. 10분 캐시.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const CACHE = {};                  // code → {ts, data}
const TTL = 10 * 60 * 1000;

function decodeEntities(s) {
  return (s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();
}

async function fetchNotices(code) {
  const url = 'https://finance.naver.com/item/news_notice.naver?code=' + code + '&page=1';
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': 'https://finance.naver.com/item/main.naver?code=' + code } });
  if (!r.ok) throw new Error('naver ' + r.status);
  const buf = await r.arrayBuffer();
  let html;
  try { html = new TextDecoder('euc-kr').decode(buf); }         // 페이지는 EUC-KR
  catch (e) { html = new TextDecoder('utf-8').decode(buf); }    // 런타임 미지원 시 폴백(제목 일부 깨질 수 있음)
  const items = [];
  // 행 단위 파싱: 제목 앵커(news_notice_read) + 같은 행의 정보제공·날짜 셀
  const rows = html.split(/<tr[\s>]/).slice(1);
  for (const row of rows) {
    const a = row.match(/href="(\/item\/news_notice_read\.naver\?[^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const title = decodeEntities(a[2].replace(/<[^>]+>/g, ''));
    if (!title) continue;
    const info = (row.match(/class="info"[^>]*>([\s\S]*?)<\/td>/) || [])[1];
    const date = (row.match(/class="date"[^>]*>([\s\S]*?)<\/td>/) || [])[1];
    items.push({
      title,
      info: decodeEntities((info || '').replace(/<[^>]+>/g, '')),
      date: decodeEntities((date || '').replace(/<[^>]+>/g, '')),
      link: 'https://finance.naver.com' + decodeEntities(a[1]),
    });
    if (items.length >= 15) break;
  }
  return items;
}

export async function onRequest(context) {
  const { request } = context;
  if (request.method === 'OPTIONS') {
    return new Response('', { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,OPTIONS' } });
  }
  const url = new URL(request.url);
  const code = String(url.searchParams.get('code') || '').replace(/\D/g, '').slice(0, 6);
  const ok = (obj, sMax) => new Response(JSON.stringify(obj), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=' + (sMax >= 300 ? 300 : 30),
      'Netlify-CDN-Cache-Control': 'public, s-maxage=' + (sMax || 600) + ', stale-while-revalidate=1800',
    },
  });
  if (code.length !== 6) return ok({ error: 'code는 6자리 KRX 종목코드' }, 60);
  const c = CACHE[code];
  if (c && Date.now() - c.ts < TTL) return ok(c.data, 600);
  try {
    const items = await fetchNotices(code);
    const data = { _updated: new Date().toISOString().slice(0, 19), code, count: items.length, items };
    CACHE[code] = { ts: Date.now(), data };
    return ok(data, 600);
  } catch (e) {
    return ok({ _updated: new Date().toISOString().slice(0, 19), code, error: String(e && e.message || e).slice(0, 80) }, 30);
  }
}
