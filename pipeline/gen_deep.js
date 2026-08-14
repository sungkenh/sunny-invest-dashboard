// pipeline/gen_deep.js
// 관심종목(data/watchlist.json) ∪ 인기종목의 '심층분석(기업 생태계·투자지표·개요·리포트)'을
// 사전 생성해 data/deep.json 에 병합한다. → 모든 사용자·기기에서 /api/deep 호출 없이 즉시 표시.
//
// 핵심: 서버리스 함수 functions/api/deep.js (Cloudflare) 의 생성 로직을 그대로 재사용(중복 없음).
//      curated:true(손작성 큐레이션) 항목은 절대 덮어쓰지 않고 보존.
// 실행: node pipeline/gen_deep.js   (GitHub Actions·로컬 공용. Node 18+ 전역 fetch 필요)
// 테스트: GEN_DEEP_SYMS=AAPL,005930.KS DEEP_PATH=/tmp/deep.json node pipeline/gen_deep.js

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const DEEP_PATH = process.env.DEEP_PATH || path.join(ROOT, 'data', 'deep.json');
const WL_PATH = process.env.WL_PATH || path.join(ROOT, 'data', 'watchlist.json');

// 인기종목: 한·미 성장·대형주(사용자 추가 가능성이 높은 종목). curated는 런타임에 자동 스킵.
const POPULAR_DEFAULT = [
  // 미국: 빅테크·성장·핵심
  'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'AVGO', 'AMD', 'NFLX', 'CRM', 'ORCL',
  'ADBE', 'QCOM', 'MU', 'ASML', 'ARM', 'SMCI', 'COST', 'JPM', 'V', 'MA',
  'LLY', 'UNH', 'XOM', 'COIN', 'UBER', 'SHOP', 'NOW', 'MRVL', 'INTC', 'DIS',
  // 한국: KOSPI 대형
  '373220.KS', '207940.KS', '005380.KS', '000270.KS', '035420.KS', '035720.KS',
  '051910.KS', '006400.KS', '005490.KS', '105560.KS', '028260.KS', '068270.KS',
  '012330.KS', '042700.KS', '009540.KS',
  // 한국: KOSDAQ
  '086520.KQ', '196170.KQ',
];
const POPULAR = process.env.GEN_DEEP_SYMS ? process.env.GEN_DEEP_SYMS.split(',').map((s) => s.trim()).filter(Boolean) : POPULAR_DEFAULT;

const baseSym = (s) => (s || '').replace(/\.(KS|KQ)$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // Cloudflare Pages Function(ESM)을 동적 import: Cloudflare는 onRequest만 쓰지만 여기선 내부 핸들러 __cfHandler 재사용
  const deep = await import(pathToFileURL(path.join(__dirname, '..', 'functions', 'api', 'deep.js')).href);
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(DEEP_PATH, 'utf8')); }
  catch (e) { console.log('· 기존 deep.json 없음, 새로 생성'); }

  let wl = [];
  try { wl = (JSON.parse(fs.readFileSync(WL_PATH, 'utf8')).items || []).map((x) => x.sym).filter(Boolean); }
  catch (e) { /* watchlist 없으면 인기종목만 */ }

  const targets = Array.from(new Set([...wl, ...POPULAR]));
  const out = { ...existing };   // 큐레이션 포함 기존 항목 전부 보존
  let made = 0, kept = 0, failed = 0;

  console.log(`· 대상 ${targets.length}종목 (관심 ${wl.length} ∪ 인기 ${POPULAR.length})`);
  for (const sym of targets) {
    const base = baseSym(sym);
    if (existing[base] && existing[base].curated) { kept++; continue; }   // 손작성 큐레이션 보존

    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      try {
        const r = await deep.__cfHandler({ queryStringParameters: { sym } });
        const d = JSON.parse(r.body);
        if (d && !d.error && Array.isArray(d.metrics) && d.metrics.length) {
          out[base] = d; made++; ok = true;
          console.log('  ✓', sym.padEnd(11), '→', (d.name || '').slice(0, 18), '| 생태계', (d.chain || []).length + '단');
        }
      } catch (e) { /* 재시도 */ }
      if (!ok) await sleep(1500);
    }
    if (!ok) { failed++; console.log('  ✗', sym, '(스킵, 기존값 유지)'); }
    await sleep(500);   // 야후 레이트리밋 완화
  }

  fs.writeFileSync(DEEP_PATH, JSON.stringify(out, null, 1));
  console.log(`· 완료. 신규/갱신 ${made} · 큐레이션 보존 ${kept} · 실패 ${failed} · 총 ${Object.keys(out).length}종목`);
})();
