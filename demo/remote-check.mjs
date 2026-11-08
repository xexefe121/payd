// Smoke test a deployed Payd: two WebSocket "phones" tap, pay and settle.
// Usage: node demo/remote-check.mjs https://your-deployment.vercel.app
import { WebSocket } from 'ws';
const U = process.argv[2];
const WSU = U.replace(/^http/, 'ws') + '/ws';
function phone(userId) {
  const ws = new WebSocket(WSU);
  const inbox = [];
  ws.on('message', (r) => inbox.push(JSON.parse(r)));
  const ready = new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  return { ws, inbox, ready, send: (m) => ws.send(JSON.stringify(m)), wait: async (t, ms = 6000) => { const s = Date.now(); while (Date.now() - s < ms) { const i = inbox.findIndex((m) => m.type === t); if (i >= 0) return inbox.splice(i, 1)[0]; await new Promise((r) => setTimeout(r, 50)); } throw new Error('timeout ' + t + ' inbox=' + JSON.stringify(inbox.map(m=>m.type))); } };
}
const a = phone('alice'), c = phone('cafe');
await Promise.all([a.ready, c.ready]);
a.send({ type: 'hello', clientId: 'ra', userId: 'alice' }); c.send({ type: 'hello', clientId: 'rc', userId: 'cafe' });
await a.wait('welcome'); await c.wait('welcome');
c.send({ type: 'arm', mode: 'receive', amount: '9.00', items: [] }); a.send({ type: 'arm', mode: 'pay' });
await a.wait('armed'); await c.wait('armed');
const t = Date.now();
a.send({ type: 'tap', t, method: 'bump' }); c.send({ type: 'tap', t: t + 30, method: 'bump' });
const { intent } = await a.wait('intent:new');
console.log('matched', intent.id, intent.amount, 'dt', intent.match.dt);
const r = await fetch(`${U}/api/intents/${intent.id}/pay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: 'alice' }) });
console.log('pay', r.status, (await r.json()).status);
const done = await c.wait('intent:completed');
console.log('payee completed', done.tx.amount, done.tx.paypal.captureId);
a.ws.close(); c.ws.close();
