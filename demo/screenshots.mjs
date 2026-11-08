// Captures README screenshots from a running server: node demo/screenshots.mjs [baseUrl]
import { chromium } from 'playwright';
const BASE = process.argv[2] || 'http://localhost:3000';
const browser = await chromium.launch({ channel: process.env.PAYD_BROWSER_CHANNEL || 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(`${BASE}/dashboard?as=cafe`);
await page.waitForSelector('.ag-row');
await page.evaluate(() => window.__ledger.ask('Riskiest taps over $20'));
await page.waitForTimeout(800);
await page.screenshot({ path: 'docs/screenshot-ledger.png' });
await browser.close();
console.log('docs/screenshot-ledger.png');
