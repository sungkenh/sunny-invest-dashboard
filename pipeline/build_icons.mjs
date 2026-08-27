// pipeline/build_icons.mjs
// assets/*.svg 원본에서 파비콘 래스터(ico·png)를 만든다.
// 벡터 원본이 유일한 진실이고, 아래 산출물은 전부 여기서 다시 뽑을 수 있다.
//
//   node pipeline/build_icons.mjs
//
// 래스터화는 Chromium(Playwright)을 쓴다. 목표 크기로 바로 그려야 16px 에서
// 선이 뭉개지지 않아서, 축소가 아니라 크기별로 각각 렌더한다.
import { createRequire } from 'module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire('/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

// [원본 svg, 산출 png, 한 변 픽셀]
const PNGS = [
  ['icon.svg',          'assets/icon-192.png',          192],
  ['icon.svg',          'assets/icon-512.png',          512],
  ['icon-square.svg',   'apple-touch-icon.png',         180],
  ['icon-maskable.svg', 'assets/icon-maskable-512.png', 512],
];
// favicon.ico 에 담을 크기. 16 은 탭, 32 는 북마크바·고해상도 탭, 48 은 바탕화면 바로가기.
const ICO_SIZES = [16, 32, 48];

const browser = await chromium.launch({ executablePath: CHROME });

async function raster(svgFile, size) {
  const svg = fs.readFileSync(path.join(ROOT, 'assets', svgFile), 'utf8');
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(
    `<style>html,body{margin:0;padding:0;background:none}svg{display:block}</style>` +
    svg.replace('<svg', `<svg width="${size}" height="${size}"`),
  );
  const buf = await page.screenshot({ omitBackground: true });
  await page.close();
  return buf;
}

// ICO 컨테이너를 직접 조립한다. 항목마다 PNG 를 그대로 담는 형식이고
// 모든 최신 브라우저와 윈도우 탐색기가 읽는다.
function buildIco(entries) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);              // 예약
  head.writeUInt16LE(1, 2);              // 1 = 아이콘
  head.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = head.length + dir.length;
  entries.forEach(({ size, png }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o);     // 너비 (256 은 0 으로 적는다)
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1); // 높이
    dir.writeUInt8(0, o + 2);            // 색상 수 (트루컬러면 0)
    dir.writeUInt8(0, o + 3);            // 예약
    dir.writeUInt16LE(1, o + 4);         // 컬러 플레인
    dir.writeUInt16LE(32, o + 6);        // 비트 깊이
    dir.writeUInt32LE(png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([head, dir, ...entries.map(e => e.png)]);
}

for (const [svgFile, out, size] of PNGS) {
  const png = await raster(svgFile, size);
  fs.writeFileSync(path.join(ROOT, out), png);
  console.log(`${out.padEnd(30)} ${size}x${size}  ${png.length.toLocaleString()} B`);
}

const ico = buildIco(await Promise.all(
  ICO_SIZES.map(async size => ({ size, png: await raster('icon.svg', size) })),
));
fs.writeFileSync(path.join(ROOT, 'favicon.ico'), ico);
console.log(`${'favicon.ico'.padEnd(30)} ${ICO_SIZES.join('·')}  ${ico.length.toLocaleString()} B`);

await browser.close();
