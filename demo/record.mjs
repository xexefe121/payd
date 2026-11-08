// Records a narrated walkthrough of the two-phone simulator.
//
//   npm start            (in another terminal)
//   npm run demo:record  -> demo/out/payd-demo.mp4
//
// Narration uses Windows' built-in speech synthesizer (System.Speech); on other
// platforms the video is produced with captions only. Requires ffmpeg on PATH and
// Google Chrome (Playwright drives the installed browser, no download).

import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, 'out');
const BASE = process.env.PAYD_URL || 'http://localhost:3000';
const W = 1440;
const H = 900;
fs.mkdirSync(OUT, { recursive: true });

const SCENES = [
  {
    id: 'intro',
    title: true,
    caption: 'Payd: tap phones, get paid with PayPal',
    say: "Paying with your phone is solved. Getting paid with one isn't. This is Payd. Knock two phones together, and PayPal moves the money. iPhone to Android, no special hardware.",
  },
  {
    id: 'order',
    caption: 'The barista says the order. Payd AI builds the cart from the menu.',
    say: 'At the café, the barista just says the order, and Payd turns it into a cart from the menu. Charge fourteen ninety.',
  },
  {
    id: 'tap',
    caption: 'Tap: both accelerometers feel the knock. Matched on a synced clock in milliseconds.',
    say: 'The customer taps their phone on the terminal. Both phones feel the same knock, and Payd matches the two taps on a synced clock, in milliseconds. Payd Guard checks it. Hold to pay, and PayPal captures it.',
  },
  {
    id: 'log',
    caption: 'Live: tap, match Δt, Payd Guard, PayPal Orders v2 create + capture',
    say: 'Every step is visible in the live log: the two taps, the match time, the guard check, and the PayPal order and capture.',
  },
  {
    id: 'p2p',
    caption: 'Friend to friend: Payd Guard explains unusual taps before money moves',
    say: 'Between friends, Ben requests money with a tap. This one is unusual, so Payd Guard explains why, in plain English, and asks Alice to confirm before anything moves.',
  },
  {
    id: 'split',
    caption: 'Snap & Split: read the bill, then each friend taps to pay their share',
    say: 'Splitting dinner? Snap the bill, and Payd reads every line. Then each friend just taps their phone on yours to pay their share.',
  },
  {
    id: 'copilot',
    caption: 'Merchant Copilot: answers from PayPal sales, proposes refunds you approve',
    say: "For the business, Payd Copilot answers questions from PayPal sales, and prepares refunds and payouts. It never moves money without the owner's approval.",
  },
  {
    id: 'sticker',
    caption: 'No motion sensor? A 20-cent NFC sticker or QR opens the same checkout',
    say: 'No motion sensor? A twenty cent NFC sticker, or a QR code, opens the same checkout on any phone.',
  },
  {
    id: 'outro',
    title: true,
    caption: 'Payd · PayPal Orders, Vault, Refunds & Payouts · AI by Claude',
    say: 'Payd. Tap phones, get paid. Built on PayPal Orders, Vault, Refunds and Payouts, with Claude for the intelligence.',
  },
];

// ---------------------------------------------------------------- narration

function synthesize() {
  if (process.platform !== 'win32' || process.env.PAYD_NO_TTS) return {};
  const durations = {};
  for (const s of SCENES) {
    const wav = path.join(OUT, `${s.id}.wav`);
    const text = s.say.replace(/'/g, "''");
    const ps = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; try { $s.SelectVoice('Microsoft Zira Desktop') } catch {}; $s.Rate = 1; $s.SetOutputToWaveFile('${wav}'); $s.Speak('${text}'); $s.Dispose()`;
    const textFile = `${wav}.txt`;
    const cached = fs.existsSync(wav) && fs.existsSync(textFile) && fs.readFileSync(textFile, 'utf8') === s.say;
    if (!cached) {
      spawnSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'inherit' });
      fs.writeFileSync(textFile, s.say);
    }
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', wav], { encoding: 'utf8' });
    durations[s.id] = Number(probe.stdout.trim()) * 1000 || 4000;
  }
  return durations;
}

// ---------------------------------------------------------------- helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function overlay(page, scene) {
  await page.evaluate(({ caption, title }) => {
    let cap = document.getElementById('demo-cap');
    if (!cap) {
      cap = document.createElement('div');
      cap.id = 'demo-cap';
      cap.style.cssText =
        'position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:99;max-width:1100px;padding:14px 22px;border-radius:16px;background:rgba(5,8,20,.86);border:1px solid rgba(255,255,255,.12);color:#fff;font:600 22px -apple-system,Segoe UI,sans-serif;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,.5);transition:opacity .3s';
      document.body.appendChild(cap);
    }
    cap.textContent = caption;
    let card = document.getElementById('demo-card');
    if (title) {
      if (!card) {
        card = document.createElement('div');
        card.id = 'demo-card';
        card.style.cssText =
          'position:fixed;inset:0;z-index:98;display:grid;place-items:center;background:radial-gradient(70% 60% at 50% 40%,#1b2a7a 0%,#05070f 70%);color:#fff;font-family:-apple-system,Segoe UI,sans-serif;text-align:center;transition:opacity .5s';
        document.body.appendChild(card);
      }
      card.innerHTML = `<div><div style="width:110px;height:110px;margin:0 auto 22px;border-radius:32px;background:linear-gradient(135deg,#4f6bff,#00d1ff);display:grid;place-items:center;font-size:60px;font-weight:800;box-shadow:0 20px 80px rgba(79,107,255,.6)">P</div><div style="font-size:84px;font-weight:850;letter-spacing:-.04em">Payd</div><div style="font-size:30px;opacity:.85;margin-top:8px">Tap phones. Get paid.</div><div style="font-size:18px;opacity:.6;margin-top:26px">iPhone ↔ Android · PayPal sandbox · AI by Claude</div></div>`;
      card.style.opacity = '1';
    } else if (card) {
      card.style.opacity = '0';
      setTimeout(() => card.remove(), 500);
    }
  }, scene);
}

const frame = (page, k) => page.frame({ url: new RegExp(`phone=${k}`) });

async function phoneEval(page, k, fn, arg) {
  for (let i = 0; i < 30; i++) {
    const f = frame(page, k);
    if (f) {
      try {
        return await f.evaluate(fn, arg);
      } catch {}
    }
    await sleep(150);
  }
  throw new Error(`phone ${k} not ready`);
}

async function scenario(page, name) {
  await page.evaluate((n) => window.__sim.scenario(n), name);
  await sleep(2200);
}

async function click(page, k, selector) {
  await phoneEval(page, k, (sel) => document.querySelector(sel)?.click(), selector);
}

async function typeInto(page, k, selector, text) {
  for (let i = 1; i <= text.length; i++) {
    await phoneEval(page, k, ([sel, v]) => (document.querySelector(sel).value = v), [selector, text.slice(0, i)]);
    await sleep(38);
  }
}

async function holdToPay(page, k) {
  await phoneEval(page, k, () => document.querySelector('[data-hold]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
  await sleep(2200);
}

async function closeSuccess(page) {
  for (const k of ['A', 'B']) await click(page, k, '.success .btn');
}

// ---------------------------------------------------------------- run

const durations = synthesize();
await fetch(`${BASE}/api/demo/reset`, { method: 'POST' });

const browser = await chromium.launch({ channel: process.env.PAYD_BROWSER_CHANNEL || 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: OUT, size: { width: W, height: H } } });
const page = await context.newPage();
const t0 = Date.now();
const offsets = {};

async function scene(id, body) {
  const s = SCENES.find((x) => x.id === id);
  offsets[id] = Date.now() - t0;
  await overlay(page, s);
  const started = Date.now();
  await body?.();
  const need = (durations[id] || 4500) + 500;
  const spent = Date.now() - started;
  if (spent < need) await sleep(need - spent);
}

await page.goto(`${BASE}/sim?scenario=cafe`);
await sleep(1800);

await scene('intro');

await scene('order', async () => {
  await sleep(600);
  await typeInto(page, 'B', '#ask-input', 'two flat whites, one with oat, and a banana bread');
  await sleep(300);
  await click(page, 'B', '[data-action="ask"]');
  await sleep(2200);
  await click(page, 'B', '[data-action="charge"]');
});

await scene('tap', async () => {
  await sleep(1400);
  await page.evaluate(() => window.__sim.bump());
  await sleep(4200);
  await page.screenshot({ path: path.join(here, '..', 'docs', 'screenshot-sim.png') });
  await holdToPay(page, 'A');
});

await scene('log', async () => {
  await page.evaluate(() => {
    const log = document.querySelector('.log');
    log.style.transition = 'box-shadow .4s, transform .4s';
    log.style.boxShadow = '0 0 0 3px #00d1ff, 0 0 60px rgba(0,209,255,.4)';
  });
});
await page.evaluate(() => (document.querySelector('.log').style.boxShadow = ''));
await closeSuccess(page);

await scene('p2p', async () => {
  await scenario(page, 'p2p');
  await click(page, 'B', '[data-mode="receive"]');
  for (const k of ['4', '8', '0']) {
    await click(page, 'B', `[data-action="key"][data-k="${k}"]`);
    await sleep(250);
  }
  await sleep(800);
  await page.evaluate(() => window.__sim.bump());
  await sleep(5200);
  await click(page, 'A', '.sheet [data-action="decline"]');
});

await scene('split', async () => {
  await scenario(page, 'split');
  await click(page, 'B', '[data-tab="split"]');
  await sleep(1000);
  await click(page, 'B', '[data-action="sample-receipt"]');
  await sleep(2600);
  await click(page, 'B', '[data-action="start-split"]');
  await sleep(1000);
  await page.evaluate(() => window.__sim.bump());
  await sleep(1800);
  await holdToPay(page, 'A');
  await sleep(1200);
  await closeSuccess(page);
  await page.evaluate(() => {
    const s = document.getElementById('selA');
    s.value = 'ben';
    s.dispatchEvent(new Event('change'));
  });
  await sleep(2400);
  await page.evaluate(() => window.__sim.bump());
  await sleep(1800);
  await holdToPay(page, 'A');
  await sleep(1400);
  await closeSuccess(page);
});

await scene('copilot', async () => {
  await scenario(page, 'cafe');
  await click(page, 'B', '[data-tab="copilot"]');
  await sleep(800);
  await click(page, 'B', '[data-action="suggest"][data-q="How did we do today?"]');
  await sleep(3500);
  await click(page, 'B', '[data-action="suggest"][data-q="Refund the last payment"]');
  await sleep(3500);
  await click(page, 'B', '[data-action="act"][data-d="approve"]');
});

await scene('sticker', async () => {
  await click(page, 'B', '[data-tab="me"]');
  await sleep(600);
  await phoneEval(page, 'B', () => document.querySelectorAll('.card')[3]?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
});

await scene('outro');
await sleep(800);

await context.close();
await browser.close();
const video = await page.video().path();

// ---------------------------------------------------------------- mux

const mp4 = path.join(OUT, 'payd-demo.mp4');
const wavs = SCENES.filter((s) => fs.existsSync(path.join(OUT, `${s.id}.wav`)));
const args = ['-y', '-i', video];
for (const s of wavs) args.push('-i', path.join(OUT, `${s.id}.wav`));
if (wavs.length) {
  const filters = wavs.map((s, i) => `[${i + 1}:a]adelay=${offsets[s.id] + 250}|${offsets[s.id] + 250}[a${i}]`);
  filters.push(`${wavs.map((_, i) => `[a${i}]`).join('')}amix=inputs=${wavs.length}:normalize=0[aout]`);
  args.push('-filter_complex', filters.join(';'), '-map', '0:v', '-map', '[aout]', '-c:a', 'aac', '-b:a', '160k');
}
args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-preset', 'medium', '-movflags', '+faststart', mp4);
const r = spawnSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'inherit'] });
if (r.status !== 0) throw new Error('ffmpeg failed');
const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp4], { encoding: 'utf8' });
console.log(`\nDemo video: ${mp4} (${Number(probe.stdout).toFixed(1)} s)`);
