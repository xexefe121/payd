// Renders PNG app icons (iOS home screen needs PNG) from public/img/icon.svg.
import { chromium } from 'playwright';
import fs from 'node:fs';

const svg = fs.readFileSync(new URL('../public/img/icon.svg', import.meta.url), 'utf8');
const browser = await chromium.launch({ channel: process.env.PAYD_BROWSER_CHANNEL || 'chrome' });
for (const size of [180, 192, 512]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<style>html,body{margin:0;background:#070A16}svg{width:${size}px;height:${size}px;display:block}</style>${svg}`);
  await page.screenshot({ path: new URL(`../public/img/icon-${size}.png`, import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1') });
  await page.close();
}
await browser.close();
console.log('icons written');
