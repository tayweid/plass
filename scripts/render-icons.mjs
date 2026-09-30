// Render public/icons/plass.svg to the PNGs the manifest, the favicon
// fallback and the Mac app icon use: the rounded square on a transparent
// margin (as Knuth's icons are), 192 and 512 px.
//
//   node scripts/render-icons.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';

const svg = fs.readFileSync('public/icons/plass.svg', 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage();
for (const size of [192, 512]) {
  const square = Math.round(size * 416 / 512);
  const margin = Math.round((size - square) / 2);
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">
    <div style="position:absolute;left:${margin}px;top:${margin}px;width:${square}px;height:${square}px">
      ${svg.replace('width="64" height="64"', `width="${square}" height="${square}"`)}
    </div></body></html>`);
  await page.screenshot({ path: `public/icons/plass-${size}.png`, omitBackground: true });
  console.log(`wrote public/icons/plass-${size}.png`);
}
await browser.close();
