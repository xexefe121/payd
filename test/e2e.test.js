// End-to-end: boots the real server (PayPal mock mode, rules AI), connects two
// "phones" over WebSocket, taps them together and pays.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://localhost:${PORT}`;
let proc;

before(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'payd-test-'));
  proc = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(PORT), PAYD_DATA_DIR: dataDir, PAYPAL_CLIENT_ID: '', PAYPAL_CLIENT_SECRET: '', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => String(d).includes('Payd running') && resolve());
    proc.on('exit', (c) => reject(new Error(`server exited ${c}`)));
  });
});

after(() => proc?.kill());

function phone(userId) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    inbox.push(msg);
    for (const w of [...waiters]) if (w.pred(msg)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(msg);
    }
  });
  const ready = new Promise((r) => ws.on('open', r)).then(() => ws.send(JSON.stringify({ type: 'hello', clientId: `c_${userId}`, userId })));
  return {
    ws,
    ready,
    send: (m) => ws.send(JSON.stringify(m)),
    next: (type, timeout = 3000) => {
      const found = inbox.find((m) => m.type === type);
      if (found) {
        inbox.splice(inbox.indexOf(found), 1);
        return Promise.resolve(found);
      }
      return new Promise((resolve, reject) => {
        const w = { pred: (m) => m.type === type, resolve };
        waiters.push(w);
        setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeout);
      });
    },
  };
}

const post = async (p, body) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
};

test('two phones tap, payer confirms, PayPal order is captured', async () => {
  const alice = phone('alice');
  const cafe = phone('cafe');
  await Promise.all([alice.ready, cafe.ready]);
  await Promise.all([alice.next('welcome'), cafe.next('welcome')]);

  cafe.send({ type: 'arm', mode: 'receive', amount: '9.00', items: [{ sku: 'latte', name: 'Latte', qty: 1, unitPrice: '4.80' }, { sku: 'croissant', name: 'Croissant', qty: 1, unitPrice: '4.20' }] });
  alice.send({ type: 'arm', mode: 'pay' });
  await Promise.all([alice.next('armed'), cafe.next('armed')]);

  const t = Date.now();
  alice.send({ type: 'tap', t, method: 'bump', peak: 15 });
  cafe.send({ type: 'tap', t: t + 40, method: 'bump', peak: 14 });

  const [a, c] = await Promise.all([alice.next('intent:new'), cafe.next('intent:new')]);
  assert.equal(a.intent.id, c.intent.id);
  assert.equal(a.intent.amount, '9.00');
  assert.equal(a.intent.payee.id, 'cafe');
  assert.equal(a.intent.match.dt, 40);

  const pay = await post(`/api/intents/${a.intent.id}/pay`, { userId: 'alice' });
  assert.equal(pay.status, 200);
  assert.equal(pay.json.status, 'completed');
  assert.ok(pay.json.tx.paypal.captureId);

  const done = await cafe.next('intent:completed');
  assert.equal(done.tx.amount, '9.00');

  // Merchant refunds it
  const refund = await post(`/api/transactions/${done.tx.id}/refund`, { userId: 'cafe' });
  assert.equal(refund.json.status, 'refunded');
  alice.ws.close();
  cafe.ws.close();
});

test('taps that are too far apart in time do not pair', async () => {
  const ben = phone('ben');
  const maya = phone('maya');
  await Promise.all([ben.ready, maya.ready]);
  ben.send({ type: 'arm', mode: 'pay' });
  maya.send({ type: 'arm', mode: 'receive', amount: '5' });
  await Promise.all([ben.next('armed'), maya.next('armed')]);
  const t = Date.now();
  ben.send({ type: 'tap', t, method: 'bump' });
  maya.send({ type: 'tap', t: t + 2000, method: 'bump' });
  await ben.next('tap:waiting');
  await maya.next('tap:waiting');
  await ben.next('tap:timeout', 4000);
  ben.ws.close();
  maya.ws.close();
});

test('only the payer can pay, and guard blocks are enforced server side', async () => {
  const alice = phone('alice');
  const ben = phone('ben');
  await Promise.all([alice.ready, ben.ready]);
  ben.send({ type: 'arm', mode: 'receive', amount: '20' });
  alice.send({ type: 'arm', mode: 'pay' });
  await Promise.all([alice.next('armed'), ben.next('armed')]);
  const t = Date.now();
  alice.send({ type: 'tap', t, method: 'bump' });
  ben.send({ type: 'tap', t: t + 10, method: 'bump' });
  const { intent } = await alice.next('intent:new');
  const wrong = await post(`/api/intents/${intent.id}/pay`, { userId: 'ben' });
  assert.equal(wrong.status, 403);
  alice.ws.close();
  ben.ws.close();
});

test('NFC sticker link pays whatever is armed on the terminal', async () => {
  const cafe = phone('cafe');
  const maya = phone('maya');
  await Promise.all([cafe.ready, maya.ready]);
  cafe.send({ type: 'arm', mode: 'receive', amount: '6.00', items: [{ sku: 'iced-matcha', name: 'Iced Matcha', qty: 1, unitPrice: '6.00' }] });
  await cafe.next('armed');
  const term = await (await fetch(`${BASE}/api/terminal/cafe`)).json();
  assert.equal(term.armed.amount, '6.00');
  const r = await post('/api/terminal/cafe/pay', { payerId: 'maya', method: 'nfc-tag' });
  assert.equal(r.json.method, 'nfc-tag');
  assert.equal(r.json.amount, '6.00');
  const pay = await post(`/api/intents/${r.json.id}/pay`, { userId: 'maya' });
  assert.equal(pay.json.status, 'completed');
  cafe.ws.close();
  maya.ws.close();
});

test('split bill: each tap collects the next share', async () => {
  const split = await post('/api/splits', { hostId: 'alice', title: 'Dinner', total: '90.00', people: 3 });
  assert.deepEqual(split.json.shares.map((s) => s.amount), ['30.00', '30.00', '30.00']);
  const alice = phone('alice');
  const ben = phone('ben');
  await Promise.all([alice.ready, ben.ready]);
  alice.send({ type: 'arm', mode: 'receive', splitId: split.json.id });
  ben.send({ type: 'arm', mode: 'pay' });
  await Promise.all([alice.next('armed'), ben.next('armed')]);
  const t = Date.now();
  ben.send({ type: 'tap', t, method: 'bump' });
  alice.send({ type: 'tap', t: t + 25, method: 'bump' });
  const { intent } = await ben.next('intent:new');
  assert.equal(intent.amount, '30.00');
  assert.equal(intent.split.index, 1);
  await post(`/api/intents/${intent.id}/pay`, { userId: 'ben' });
  const upd = await alice.next('split:update');
  assert.equal(upd.split.shares[1].status, 'paid');
  assert.equal(upd.split.shares[1].payer.id, 'ben');
  alice.ws.close();
  ben.ws.close();
});
