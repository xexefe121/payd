import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';

import * as store from './store.js';
import * as paypal from './paypal.js';
import * as ai from './ai.js';
import { TapMatcher, DEFAULTS as MATCH_DEFAULTS } from './tapmatch.js';
import { guardHeuristic, copilotHeuristic, cartTotal } from './heuristics.js';
import { normalizeAmount, toCents, fromCents, evenShares } from './money.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, '..', 'public');
const PORT = Number(process.env.PORT || 3000);
const CURRENCY = process.env.PAYD_CURRENCY || 'USD';

store.load();

const app = express();
// Render terminates HTTPS one proxy hop before the Node process.
app.set('trust proxy', 1);
app.use(express.json({ limit: '15mb' }));
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
// AG Grid Community (MIT) served from node_modules, no CDN needed.
app.use('/vendor/ag-grid', express.static(path.join(here, '..', 'node_modules', 'ag-grid-community', 'dist'), { maxAge: '7d' }));

const server = http.createServer(app);
// No path filter: on Vercel the upgrade arrives through a rewrite (/ws -> /api/server).
const wss = new WebSocketServer({ server });

// ------------------------------------------------------------------ state

/** ws -> { clientId, userId, mode, armed, observer } */
const clients = new Map();
/** userId -> armed terminal state (receive mode), used by NFC sticker / QR links */
const terminals = new Map();
/** intentId -> intent (live, not yet a transaction) */
const intents = new Map();
const recentIntentsByPayer = new Map();
const matcher = new TapMatcher();
const INSTANCE_ID = store.id('inst');

const log = (kind, data) => broadcastObservers({ type: 'log', kind, at: Date.now(), ...data });

paypal.events.on('call', (c) => log('paypal', c));
ai.events.on('call', (c) => log('ai', c));

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}
function socketsOf(userId) {
  return [...clients.entries()].filter(([, c]) => c.userId === userId).map(([ws]) => ws);
}
function sendToUser(userId, msg) {
  for (const ws of socketsOf(userId)) send(ws, msg);
}
function socketByClientId(clientId) {
  for (const [ws, c] of clients) if (c.clientId === clientId) return ws;
  return null;
}
function broadcastObservers(msg) {
  for (const [ws, c] of clients) if (c.observer) send(ws, msg);
}

function mini(user) {
  if (!user) return null;
  return { id: user.id, name: user.name, handle: user.handle, color: user.color, type: user.type };
}

function publicIntent(intent) {
  return {
    id: intent.id,
    payer: mini(store.getUser(intent.payerId)),
    payee: mini(store.getUser(intent.payeeId)),
    amount: intent.amount,
    currency: intent.currency,
    items: intent.items,
    note: intent.note,
    method: intent.method,
    status: intent.status,
    guard: intent.guard,
    split: intent.split,
    match: intent.match,
    createdAt: intent.createdAt,
    paypalMode: paypal.mode,
    payerPaypalLinked: Boolean(store.getUser(intent.payerId)?.vaultId),
    error: intent.error || null,
  };
}

function notifyIntent(intent, type = 'intent:update') {
  const msg = { type, intent: publicIntent(intent) };
  const targets = new Set([...socketsOf(intent.payerId), ...socketsOf(intent.payeeId)]);
  for (const ws of targets) send(ws, msg);
}

// ------------------------------------------------------------------ intents

function labelTx(tx, viewerId) {
  const payer = store.getUser(tx.payerId);
  const payee = store.getUser(tx.payeeId);
  return {
    ...tx,
    payer: mini(payer),
    payee: mini(payee),
    payerLabel: payer?.name || tx.payerName || 'Customer',
    direction: viewerId ? (tx.payeeId === viewerId ? 'in' : 'out') : undefined,
  };
}

function nextSplitShare(splitId) {
  const split = store.getDb().splits.find((s) => s.id === splitId);
  if (!split) return null;
  const share = split.shares.find((s) => s.status === 'open');
  return share ? { split, share } : { split, share: null };
}

async function createIntent({ payerId, payeeId, method, match, payerArmed, payeeArmed }) {
  const payer = store.getUser(payerId);
  const payee = store.getUser(payeeId);
  if (!payer || !payee) throw new Error('Unknown user');
  if (payerId === payeeId) throw new Error('Cannot pay yourself');

  let amount = null;
  let items = [];
  let note = '';
  let split = null;

  if (payeeArmed?.splitId) {
    const next = nextSplitShare(payeeArmed.splitId);
    if (!next?.share) throw new Error('Everyone has already paid this split');
    next.share.status = 'reserved';
    amount = next.share.amount;
    note = `${next.split.title} · share ${next.share.index + 1} of ${next.split.shares.length}`;
    split = { id: next.split.id, index: next.share.index, count: next.split.shares.length, title: next.split.title };
  } else if (payeeArmed?.amount) {
    amount = payeeArmed.amount;
    items = payeeArmed.items || [];
    note = payeeArmed.note || '';
  } else if (payerArmed?.amount) {
    amount = payerArmed.amount;
    note = payerArmed.note || '';
  }

  const intent = {
    id: store.id('tap'),
    payerId,
    payeeId,
    amount,
    currency: CURRENCY,
    items,
    note,
    method,
    status: 'awaiting_payer',
    guard: null,
    split,
    match: match || null,
    createdAt: Date.now(),
  };
  intents.set(intent.id, intent);

  const recent = (recentIntentsByPayer.get(payerId) || []).filter((t) => t > Date.now() - 10 * 60 * 1000);
  recent.push(Date.now());
  recentIntentsByPayer.set(payerId, recent);

  runGuard(intent);
  log('intent', { intentId: intent.id, payer: payer.name, payee: payee.name, amount, method });
  notifyIntent(intent, 'intent:new');
  return intent;
}

function guardContext(intent) {
  const payer = store.getUser(intent.payerId);
  const payee = store.getUser(intent.payeeId);
  const history = store.getDb().transactions.filter((t) => t.payerId === intent.payerId && t.status !== 'failed');
  return {
    amount: intent.amount,
    currency: intent.currency,
    payee: { name: payee.name, type: payee.type, handle: payee.handle },
    payerHistory: history.slice(0, 30).map((t) => Number(t.amount)),
    knownPayee: history.some((t) => t.payeeId === intent.payeeId),
    payeeType: payee.type,
    recentTapCount: (recentIntentsByPayer.get(intent.payerId) || []).length,
    distanceM: intent.match?.distance ?? null,
    ambiguous: Boolean(intent.match?.ambiguous),
    hour: new Date().getHours(),
    tapLimit: payer.tapLimit,
    method: intent.method,
    items: intent.items.map((i) => `${i.qty}x ${i.name}`),
    note: intent.note,
  };
}

async function runGuard(intent) {
  if (!intent.amount) {
    intent.guard = { level: 'pending', headline: 'Enter an amount to run Payd Guard', reasons: [], source: 'rules' };
    return;
  }
  const ctx = guardContext(intent);
  const rules = guardHeuristic(ctx);
  intent.guard = { ...rules, refining: ai.enabled };
  notifyIntent(intent);
  if (!ai.enabled) return;
  const { payerHistory, ...rest } = ctx;
  const context = { ...rest, payerRecentAmounts: payerHistory.slice(0, 12) };
  const refined = await ai.reviewTap(context, rules);
  if (!intents.has(intent.id) || intent.status !== 'awaiting_payer') return;
  intent.guard = { ...refined, refining: false };
  log('guard', { intentId: intent.id, level: refined.level, score: refined.score, source: refined.source });
  notifyIntent(intent);
}

function getLiveIntent(req, res) {
  const intent = intents.get(req.params.id);
  if (!intent) {
    res.status(404).json({ error: 'This tap has expired. Tap again.' });
    return null;
  }
  if (req.body?.userId && req.body.userId !== intent.payerId) {
    res.status(403).json({ error: 'Only the payer can do that' });
    return null;
  }
  if (intent.status === 'completed') {
    res.status(409).json({ error: 'Already paid' });
    return null;
  }
  return intent;
}

function releaseSplitShare(intent) {
  if (!intent.split) return;
  const split = store.getDb().splits.find((s) => s.id === intent.split.id);
  const share = split?.shares[intent.split.index];
  if (share && share.status === 'reserved') share.status = 'open';
}

function completeIntent(intent, pp) {
  intent.status = 'completed';
  const payer = store.getUser(intent.payerId);
  if (pp.vaultId && payer) {
    payer.vaultId = pp.vaultId;
    store.save();
  }
  const tx = store.addTransaction({
    id: store.id('tx'),
    intentId: intent.id,
    payerId: intent.payerId,
    payeeId: intent.payeeId,
    amount: intent.amount,
    currency: intent.currency,
    items: intent.items,
    note: intent.note,
    method: intent.method,
    status: 'completed',
    createdAt: intent.createdAt,
    completedAt: Date.now(),
    guard: intent.guard ? { level: intent.guard.level, score: intent.guard.score, source: intent.guard.source } : null,
    paypal: { mode: paypal.mode, orderId: pp.orderId, captureId: pp.captureId, settledTo: pp.settledTo },
  });
  if (intent.split) {
    const split = store.getDb().splits.find((s) => s.id === intent.split.id);
    const share = split?.shares[intent.split.index];
    if (share) {
      share.status = 'paid';
      share.payerId = intent.payerId;
      share.txId = tx.id;
      store.save();
      sendToUser(split.hostId, { type: 'split:update', split: publicSplit(split) });
    }
  }
  intent.txId = tx.id;
  log('completed', { intentId: intent.id, txId: tx.id, amount: intent.amount, captureId: pp.captureId });
  const msg = { type: 'intent:completed', intent: publicIntent(intent), tx: labelTx(tx) };
  for (const ws of new Set([...socketsOf(intent.payerId), ...socketsOf(intent.payeeId)])) send(ws, msg);

  // Reset the payee terminal (unless it is collecting a split, which re-arms itself).
  const term = terminals.get(intent.payeeId);
  if (term && !term.splitId) {
    terminals.delete(intent.payeeId);
    sendToUser(intent.payeeId, { type: 'terminal:reset' });
  }
  setTimeout(() => intents.delete(intent.id), 60_000);
  return tx;
}

function orderOptions(intent, req) {
  const payee = store.getUser(intent.payeeId);
  const origin = `${req.protocol}://${req.get('host')}`;
  return {
    amount: intent.amount,
    currency: intent.currency,
    payeeEmail: payee?.paypalEmail || undefined,
    description: `Payd tap · ${payee?.name}${intent.note ? ' · ' + intent.note : ''}`,
    referenceId: intent.id,
    items: intent.items,
    returnUrl: `${origin}/paypal/return/${intent.id}`,
    cancelUrl: `${origin}/?as=${encodeURIComponent(intent.payerId)}`,
  };
}

function settledTo(intent) {
  const payee = store.getUser(intent.payeeId);
  return payee?.paypalEmail ? 'payee' : 'platform';
}

// ------------------------------------------------------------------ websocket

wss.on('connection', (ws) => {
  clients.set(ws, { clientId: null, userId: null, mode: 'idle', armed: null, observer: false });

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const state = clients.get(ws);
    try {
      switch (msg.type) {
        case 'hello': {
          state.clientId = String(msg.clientId || store.id('c'));
          state.observer = Boolean(msg.observer);
          state.userId = msg.userId && store.getUser(msg.userId) ? msg.userId : null;
          send(ws, {
            type: 'welcome',
            serverTime: Date.now(),
            instance: INSTANCE_ID,
            user: store.publicUser(store.getUser(state.userId)),
          });
          break;
        }
        case 'sync':
          send(ws, { type: 'sync', t0: msg.t0, ts: Date.now() });
          break;
        case 'arm': {
          state.mode = ['pay', 'receive'].includes(msg.mode) ? msg.mode : 'idle';
          const amount = normalizeAmount(msg.amount);
          state.armed = {
            amount,
            note: String(msg.note || '').slice(0, 140),
            items: Array.isArray(msg.items) ? msg.items.slice(0, 50) : [],
            splitId: msg.splitId || null,
          };
          if (state.mode === 'receive' && state.userId) {
            terminals.set(state.userId, { ...state.armed, armedAt: Date.now() });
          } else if (state.userId && terminals.has(state.userId) && !socketsOf(state.userId).some((s) => clients.get(s)?.mode === 'receive')) {
            terminals.delete(state.userId);
          }
          send(ws, { type: 'armed', mode: state.mode, armed: state.armed });
          break;
        }
        case 'tap': {
          if (!state.userId) return send(ws, { type: 'tap:error', error: 'Pick a profile first' });
          if (state.mode !== 'pay' && state.mode !== 'receive') return send(ws, { type: 'tap:ignored' });
          const tap = {
            id: store.id('t'),
            clientId: state.clientId,
            userId: state.userId,
            role: state.mode,
            t: Number(msg.t) || Date.now(),
            geo: msg.geo && Number.isFinite(msg.geo.lat) ? msg.geo : null,
            method: msg.method || 'bump',
            peak: Number.isFinite(msg.peak) ? Math.round(msg.peak * 10) / 10 : null,
          };
          log('tap', { user: store.getUser(state.userId)?.name, role: tap.role, method: tap.method, skewMs: Date.now() - tap.t, peak: tap.peak });
          const result = matcher.submit(tap);
          if (!result) {
            send(ws, { type: 'tap:waiting', tapId: tap.id });
            setTimeout(() => {
              if (matcher.pending.some((p) => p.id === tap.id)) {
                matcher.cancel(tap.clientId);
                send(ws, { type: 'tap:timeout' });
              }
            }, MATCH_DEFAULTS.ttlMs);
            return;
          }
          const { match, dt, distance, ambiguous, candidateCount } = result;
          const payerTap = tap.role === 'pay' ? tap : match;
          const payeeTap = tap.role === 'receive' ? tap : match;
          const payerWs = socketByClientId(payerTap.clientId);
          const payeeWs = socketByClientId(payeeTap.clientId);
          log('match', { dt, distance, ambiguous, candidateCount, payer: payerTap.userId, payee: payeeTap.userId });
          await createIntent({
            payerId: payerTap.userId,
            payeeId: payeeTap.userId,
            method: payerTap.method === 'sim' || payeeTap.method === 'sim' ? 'sim' : 'bump',
            match: { dt, distance, ambiguous, candidateCount },
            payerArmed: payerWs ? clients.get(payerWs)?.armed : null,
            payeeArmed: payeeWs ? clients.get(payeeWs)?.armed : terminals.get(payeeTap.userId),
          });
          break;
        }
        case 'decline': {
          const intent = intents.get(msg.intentId);
          if (intent && intent.status === 'awaiting_payer' && [intent.payerId, intent.payeeId].includes(state.userId)) {
            intent.status = 'declined';
            releaseSplitShare(intent);
            notifyIntent(intent);
            intents.delete(intent.id);
          }
          break;
        }
      }
    } catch (err) {
      send(ws, { type: 'error', error: err.message });
    }
  });

  ws.on('close', () => {
    const state = clients.get(ws);
    clients.delete(ws);
    if (state?.clientId) matcher.cancel(state.clientId);
    if (state?.userId && state.mode === 'receive' && !socketsOf(state.userId).some((s) => clients.get(s)?.mode === 'receive')) {
      // keep terminal armed briefly so NFC sticker links still work across reconnects
      setTimeout(() => {
        if (!socketsOf(state.userId).length) terminals.delete(state.userId);
      }, 30_000);
    }
  });
});

// ------------------------------------------------------------------ REST

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    console.error('[api]', req.method, req.path, err.message);
    res.status(status >= 500 ? 502 : status).json({ error: err.message, code: err.code });
  });

app.get('/api/config', (req, res) => {
  res.json({
    paypal: paypal.clientConfig(),
    ai: ai.status(),
    currency: CURRENCY,
    match: { windowMs: MATCH_DEFAULTS.windowMs },
  });
});

app.get('/api/users', (req, res) => res.json(store.getDb().users.map(store.publicUser)));

app.post('/api/users', (req, res) => {
  const { name, type, paypalEmail } = req.body || {};
  if (!name || String(name).trim().length < 2) return res.status(400).json({ error: 'Name required' });
  const user = store.upsertUser({
    name: String(name).trim().slice(0, 40),
    type: type === 'business' ? 'business' : 'personal',
    paypalEmail: String(paypalEmail || '').trim().slice(0, 120),
    catalog: type === 'business' ? store.CAFE_CATALOG.slice(0, 6) : undefined,
  });
  res.json(store.publicUser(user));
});

app.get('/api/users/:id', (req, res) => {
  const user = store.getUser(req.params.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json(store.publicUser(user));
});

app.patch('/api/users/:id', (req, res) => {
  const user = store.getUser(req.params.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  const patch = {};
  if (typeof req.body.name === 'string') patch.name = req.body.name.trim().slice(0, 40);
  if (typeof req.body.paypalEmail === 'string') patch.paypalEmail = req.body.paypalEmail.trim().slice(0, 120);
  if (req.body.tapLimit !== undefined) patch.tapLimit = normalizeAmount(req.body.tapLimit) || user.tapLimit;
  if (req.body.unlinkPaypal) user.vaultId = null;
  store.upsertUser({ id: user.id, ...patch });
  res.json(store.publicUser(user));
});

app.get('/api/users/:id/activity', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 80, 1), 500);
  res.json(store.transactionsFor(req.params.id, limit).map((t) => labelTx(t, req.params.id)));
});

// ---- terminal links (NFC sticker / QR / shared link)

app.get('/api/terminal/:userId', (req, res) => {
  const user = store.getUser(req.params.userId);
  if (!user) return res.status(404).json({ error: 'Unknown terminal' });
  const armed = terminals.get(user.id) || null;
  let split = null;
  if (armed?.splitId) {
    const next = nextSplitShare(armed.splitId);
    split = next ? { title: next.split.title, nextAmount: next.share?.amount || null } : null;
  }
  res.json({ user: store.publicUser(user), armed, split, online: socketsOf(user.id).length > 0 });
});

app.post(
  '/api/terminal/:userId/pay',
  wrap(async (req, res) => {
    const payee = store.getUser(req.params.userId);
    const payer = store.getUser(req.body.payerId);
    if (!payee || !payer) return res.status(404).json({ error: 'Unknown user' });
    const armed = terminals.get(payee.id) || null;
    const method = ['nfc-tag', 'qr', 'link'].includes(req.body.method) ? req.body.method : 'link';
    const intent = await createIntent({
      payerId: payer.id,
      payeeId: payee.id,
      method,
      match: null,
      payerArmed: req.body.amount ? { amount: normalizeAmount(req.body.amount), note: req.body.note } : null,
      payeeArmed: armed,
    });
    res.json(publicIntent(intent));
  }),
);

// ---- paying an intent

app.post(
  '/api/intents/:id/amount',
  wrap(async (req, res) => {
    const intent = getLiveIntent(req, res);
    if (!intent) return;
    if (intent.split || (intent.amount && intent.items.length)) return res.status(409).json({ error: 'Amount is fixed by the payee' });
    const amount = normalizeAmount(req.body.amount);
    if (!amount) return res.status(400).json({ error: 'Enter an amount between $0.01 and $10,000' });
    intent.amount = amount;
    if (typeof req.body.note === 'string') intent.note = req.body.note.slice(0, 140);
    runGuard(intent);
    notifyIntent(intent);
    res.json(publicIntent(intent));
  }),
);

app.post(
  '/api/intents/:id/pay',
  wrap(async (req, res) => {
    const intent = getLiveIntent(req, res);
    if (!intent) return;
    if (!intent.amount) return res.status(400).json({ error: 'Amount required' });
    if (intent.guard?.action === 'block' && !req.body.override) {
      return res.status(403).json({ error: 'Payd Guard blocked this tap', code: 'GUARD_BLOCK' });
    }
    const payer = store.getUser(intent.payerId);
    intent.status = 'processing';
    notifyIntent(intent);

    try {
      if (paypal.mode === 'mock') {
        const order = await paypal.createOrder(orderOptions(intent, req));
        const captured = paypal.extractCapture(await paypal.captureOrder(order.id));
        const tx = completeIntent(intent, { ...captured, vaultId: payer.vaultId || captured.vaultId, settledTo: settledTo(intent) });
        return res.json({ status: 'completed', tx: labelTx(tx, payer.id) });
      }
      if (payer.vaultId) {
        const order = await paypal.chargeVault({ ...orderOptions(intent, req), vaultId: payer.vaultId });
        const captured = paypal.extractCapture(order);
        const tx = completeIntent(intent, { ...captured, settledTo: settledTo(intent) });
        return res.json({ status: 'completed', tx: labelTx(tx, payer.id) });
      }
      intent.status = 'awaiting_payer';
      notifyIntent(intent);
      return res.json({ status: 'needs_approval' });
    } catch (err) {
      intent.status = 'awaiting_payer';
      intent.error = err.message;
      notifyIntent(intent);
      if (paypal.mode === 'sandbox' && payer.vaultId) {
        // Vault charge failed (expired/revoked): fall back to an approval with PayPal buttons.
        return res.json({ status: 'needs_approval', warning: err.message });
      }
      throw err;
    }
  }),
);

app.post(
  '/api/intents/:id/order',
  wrap(async (req, res) => {
    const intent = getLiveIntent(req, res);
    if (!intent) return;
    const order = await paypal.createOrder(orderOptions(intent, req));
    intent.orderId = order.id;
    const approvalUrl = order.links?.find((link) => link.rel === 'payer-action' || link.rel === 'approve')?.href || null;
    res.json({ id: order.id, approvalUrl });
  }),
);

async function captureIntent(intent) {
  if (intent.status === 'completed') return store.getTransaction(intent.txId);
  if (!intent.capturePromise) {
    intent.capturePromise = (async () => {
      intent.status = 'processing';
      notifyIntent(intent);
      const captured = paypal.extractCapture(await paypal.captureOrder(intent.orderId));
      if (captured.status !== 'COMPLETED') {
        throw Object.assign(new Error(`Payment ${captured.status}`), { status: 402 });
      }
      return completeIntent(intent, { ...captured, settledTo: settledTo(intent) });
    })().catch((error) => {
      intent.status = 'awaiting_payer';
      notifyIntent(intent);
      delete intent.capturePromise;
      throw error;
    });
  }
  return intent.capturePromise;
}

// Full-page approval is a fallback for browsers where the SDK popup cannot load.
// PayPal still enforces buyer approval before the server can capture this order.
app.get(
  '/paypal/return/:id',
  wrap(async (req, res) => {
    const intent = intents.get(req.params.id);
    if (!intent) return res.status(404).send('This tap has expired. Open Payd and tap again.');
    if (!req.query.token || req.query.token !== intent.orderId) return res.status(400).send('PayPal order mismatch.');
    if (intent.guard?.action === 'block') return res.status(403).send('Payd Guard blocked this payment.');
    const tx = await captureIntent(intent);
    res.redirect(`/?as=${encodeURIComponent(intent.payerId)}&receipt=${encodeURIComponent(tx.id)}`);
  }),
);

app.post(
  '/api/intents/:id/capture',
  wrap(async (req, res) => {
    const intent = getLiveIntent(req, res);
    if (!intent) return;
    const orderId = req.body.orderId || intent.orderId;
    if (!orderId || orderId !== intent.orderId) return res.status(400).json({ error: 'Order mismatch' });
    const tx = await captureIntent(intent);
    res.json({ status: 'completed', tx: labelTx(tx, intent.payerId) });
  }),
);

// ---- refunds & payouts

async function performRefund(tx, { amount, reason } = {}) {
  const remaining = toCents(tx.amount) - toCents(tx.refundedAmount || 0);
  const cents = amount ? toCents(normalizeAmount(amount)) : remaining;
  if (!cents || cents <= 0 || cents > remaining) throw Object.assign(new Error('Invalid refund amount'), { status: 400 });
  let refundId;
  if (tx.paypal?.mode === 'seed') {
    refundId = 'SEEDREFUND' + Date.now();
    log('paypal', { mode: 'seed', method: 'POST', path: `/v2/payments/captures/${tx.paypal.captureId}/refund`, status: 201, ms: 0, note: 'seeded demo transaction' });
  } else {
    const out = await paypal.refundCapture(tx.paypal.captureId, {
      amount: cents === remaining && !tx.refundedAmount ? undefined : fromCents(cents),
      currency: tx.currency,
      note: reason,
    });
    refundId = out.id;
  }
  tx.refundedAmount = fromCents(toCents(tx.refundedAmount || 0) + cents);
  tx.status = toCents(tx.refundedAmount) >= toCents(tx.amount) ? 'refunded' : 'partially_refunded';
  tx.refunds = [...(tx.refunds || []), { id: refundId, amount: fromCents(cents), reason: reason || '', at: Date.now() }];
  store.save();
  const labeled = labelTx(tx);
  if (tx.payerId) sendToUser(tx.payerId, { type: 'tx:update', tx: labelTx(tx, tx.payerId), toast: `Refund received: $${fromCents(cents)} from ${labeled.payee?.name}` });
  sendToUser(tx.payeeId, { type: 'tx:update', tx: labelTx(tx, tx.payeeId) });
  return tx;
}

app.post(
  '/api/transactions/:id/refund',
  wrap(async (req, res) => {
    const tx = store.getTransaction(req.params.id);
    if (!tx) return res.status(404).json({ error: 'Not found' });
    if (tx.payeeId !== req.body.userId) return res.status(403).json({ error: 'Only the payee can refund' });
    const out = await performRefund(tx, { amount: req.body.amount, reason: req.body.reason });
    res.json(labelTx(out, req.body.userId));
  }),
);

app.post(
  '/api/payouts',
  wrap(async (req, res) => {
    const user = store.getUser(req.body.userId);
    const amount = normalizeAmount(req.body.amount);
    const email = String(req.body.email || '').trim();
    if (!user) return res.status(404).json({ error: 'Unknown user' });
    if (!amount || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Valid email and amount required' });
    const out = await paypal.createPayout({ email, amount, currency: CURRENCY, note: req.body.note, referenceId: store.id('po') });
    res.json({ batchId: out.batch_header?.payout_batch_id, status: out.batch_header?.batch_status });
  }),
);

// ---- splits

app.post('/api/splits', (req, res) => {
  const host = store.getUser(req.body.hostId);
  if (!host) return res.status(404).json({ error: 'Unknown host' });
  const totalCents = toCents(normalizeAmount(req.body.total));
  const people = Math.max(2, Math.min(20, Number(req.body.people) || 2));
  if (!totalCents) return res.status(400).json({ error: 'Total required' });
  let amounts;
  if (Array.isArray(req.body.shares) && req.body.shares.length === people) {
    amounts = req.body.shares.map((s) => toCents(normalizeAmount(s)) || 0);
  } else {
    amounts = evenShares(totalCents, people);
  }
  const split = {
    id: store.id('split'),
    hostId: host.id,
    title: String(req.body.title || 'Group bill').slice(0, 60),
    merchant: req.body.merchant || '',
    items: Array.isArray(req.body.items) ? req.body.items.slice(0, 60) : [],
    total: fromCents(totalCents),
    createdAt: Date.now(),
    shares: amounts.map((c, index) => ({
      index,
      amount: fromCents(c),
      label: index === 0 ? `${host.name.split(' ')[0]} (you)` : `Guest ${index}`,
      status: index === 0 ? 'paid' : 'open', // the host already paid the bill
      payerId: index === 0 ? host.id : null,
    })),
  };
  store.getDb().splits.unshift(split);
  store.save();
  res.json(publicSplit(split));
});

function publicSplit(split) {
  return { ...split, shares: split.shares.map((s) => ({ ...s, payer: mini(store.getUser(s.payerId)) })) };
}

app.get('/api/splits/:id', (req, res) => {
  const split = store.getDb().splits.find((s) => s.id === req.params.id);
  if (!split) return res.status(404).json({ error: 'Not found' });
  res.json(publicSplit(split));
});

// ---- AI

app.post(
  '/api/ai/cart',
  wrap(async (req, res) => {
    const user = store.getUser(req.body.userId);
    if (!user || user.type !== 'business') return res.status(400).json({ error: 'Business profile required' });
    const text = String(req.body.text || '').slice(0, 500);
    if (!text.trim()) return res.status(400).json({ error: 'Say or type an order' });
    res.json(await ai.buildCart(text, user.catalog || []));
  }),
);

app.post(
  '/api/ai/receipt',
  wrap(async (req, res) => {
    const m = String(req.body.image || '').match(/^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/);
    if (!m) return res.status(400).json({ error: 'Send a PNG/JPEG/WebP image' });
    try {
      res.json({ ...(await ai.parseReceipt(m[2], m[1])), source: 'claude' });
    } catch (err) {
      if (err.code === 'AI_OFFLINE') return res.status(503).json({ error: err.message, code: err.code });
      throw err;
    }
  }),
);

function merchantDeps(user) {
  const received = () =>
    store.getDb().transactions.filter((t) => t.payeeId === user.id).map((t) => labelTx(t, user.id));
  const createAction = (action) => {
    const a = { id: store.id('act'), userId: user.id, status: 'pending', createdAt: Date.now(), ...action };
    store.getDb().actions.unshift(a);
    store.save();
    return a;
  };
  return {
    merchant: user,
    transactions: received,
    proposeRefund: ({ transactionId, amount, reason }) => {
      const tx = store.getTransaction(transactionId);
      if (!tx || tx.payeeId !== user.id) return { error: 'transaction not found' };
      if (tx.status === 'refunded') return { error: 'already refunded' };
      const amt = amount ? normalizeAmount(amount) : fromCents(toCents(tx.amount) - toCents(tx.refundedAmount || 0));
      if (!amt) return { error: 'invalid amount' };
      return {
        action: createAction({
          kind: 'refund',
          transactionId,
          amount: amt,
          reason: reason || '',
          summary: `Refund $${amt} to ${labelTx(tx).payerLabel}`,
        }),
      };
    },
    proposePayout: ({ email, amount, note }) => {
      const amt = normalizeAmount(amount);
      if (!amt || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || '')) return { error: 'valid email and amount required' };
      return { action: createAction({ kind: 'payout', email, amount: amt, note: note || '', summary: `Pay $${amt} to ${email}` }) };
    },
    armTerminal: ({ items, note }) => {
      const bySku = new Map((user.catalog || []).map((p) => [p.sku, p]));
      const cart = items
        .map((i) => ({ p: bySku.get(i.sku), qty: Math.max(1, Math.min(99, i.qty)) }))
        .filter((x) => x.p)
        .map(({ p, qty }) => ({ sku: p.sku, name: p.name, emoji: p.emoji, unitPrice: p.price, qty }));
      if (!cart.length) return { error: 'no valid items' };
      const total = cartTotal(cart);
      sendToUser(user.id, { type: 'terminal:load', items: cart, note: note || '', total });
      return { items: cart, total };
    },
  };
}

const METHOD_LABELS = { bump: 'Phone tap', sim: 'Phone tap', 'nfc-tag': 'NFC sticker', qr: 'QR code', link: 'Pay link' };

app.post(
  '/api/ai/grid',
  wrap(async (req, res) => {
    const user = store.getUser(req.body.userId);
    if (!user) return res.status(404).json({ error: 'Unknown user' });
    const question = String(req.body.question || '').trim().slice(0, 300);
    if (!question) return res.status(400).json({ error: 'Ask something about your payments' });
    const today = /^\d{4}-\d{2}-\d{2}$/.test(req.body.today) ? req.body.today : new Date().toISOString().slice(0, 10);
    const received = store.getDb().transactions.filter((t) => t.payeeId === user.id).map((t) => labelTx(t, user.id));
    const payers = [...new Set(received.map((t) => t.payerLabel))].slice(0, 40);
    const out = await ai.gridQuery(question, { today, payers, methods: Object.values(METHOD_LABELS) });
    log('ai-grid', { question, source: out.source, filters: Object.keys(out.filterModel) });
    res.json(out);
  }),
);

app.post(
  '/api/ai/copilot',
  wrap(async (req, res) => {
    const user = store.getUser(req.body.userId);
    if (!user) return res.status(404).json({ error: 'Unknown user' });
    const messages = (Array.isArray(req.body.messages) ? req.body.messages : [])
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .slice(-12);
    if (!messages.length || messages[messages.length - 1].role !== 'user') return res.status(400).json({ error: 'Ask something' });
    const deps = merchantDeps(user);

    if (ai.enabled) {
      try {
        return res.json(await ai.copilot(messages, deps));
      } catch (err) {
        console.error('[copilot] falling back to rules:', err.message);
      }
    }
    // Rule-based fallback
    const q = copilotHeuristic(messages[messages.length - 1].content);
    const s = ai.summarize(deps.transactions(), 7);
    const today = ai.summarize(deps.transactions(), 1);
    if (q.intent === 'summary') {
      return res.json({
        reply: `**Today:** $${today.revenue} from ${today.payments} taps (avg $${today.averageTicket}).\n**Last 7 days:** $${s.revenue} from ${s.payments} taps, ${s.refunds} refund(s).`,
        actions: [],
        source: 'rules',
      });
    }
    if (q.intent === 'top_items') {
      return res.json({
        reply: '**Top sellers (7 days):** ' + s.topItems.map((i) => `${i.name} ×${i.qty}`).join(', '),
        actions: [],
        source: 'rules',
      });
    }
    if (q.intent === 'refund_last') {
      const last = deps.transactions().find((t) => t.status === 'completed');
      if (!last) return res.json({ reply: 'No refundable payments yet.', actions: [], source: 'rules' });
      const r = deps.proposeRefund({ transactionId: last.id, reason: 'Requested via Copilot' });
      return res.json({ reply: `I've prepared a refund for the last payment ($${last.amount} from ${last.payerLabel}). Approve it below.`, actions: r.action ? [r.action] : [], source: 'rules' });
    }
    if (q.intent === 'payout' && q.email && q.amount) {
      const r = deps.proposePayout({ email: q.email, amount: q.amount, note: 'Payout via Copilot' });
      return res.json({ reply: r.error ? `Couldn't prepare that: ${r.error}` : `Payout ready for approval.`, actions: r.action ? [r.action] : [], source: 'rules' });
    }
    res.json({
      reply: 'Try: "How did we do today?", "What are my best sellers?", "Refund the last payment", or "Pay supplier@beans.co $120 for beans".',
      actions: [],
      source: 'rules',
    });
  }),
);

app.post(
  '/api/actions/:id/:decision(approve|dismiss)',
  wrap(async (req, res) => {
    const action = store.getDb().actions.find((a) => a.id === req.params.id);
    if (!action || action.userId !== req.body.userId) return res.status(404).json({ error: 'Not found' });
    if (action.status !== 'pending') return res.status(409).json({ error: `Already ${action.status}` });
    if (req.params.decision === 'dismiss') {
      action.status = 'dismissed';
      store.save();
      return res.json(action);
    }
    if (action.kind === 'refund') {
      const tx = store.getTransaction(action.transactionId);
      await performRefund(tx, { amount: action.amount, reason: action.reason });
    } else if (action.kind === 'payout') {
      const out = await paypal.createPayout({ email: action.email, amount: action.amount, currency: CURRENCY, note: action.note, referenceId: action.id });
      action.result = out.batch_header;
    }
    action.status = 'approved';
    action.approvedAt = Date.now();
    store.save();
    log('action', { actionKind: action.kind, summary: action.summary });
    res.json(action);
  }),
);

// ---- utilities

app.get(
  '/api/qr',
  wrap(async (req, res) => {
    const data = String(req.query.data || '').slice(0, 500);
    const svg = await QRCode.toString(data, { type: 'svg', margin: 1, color: { dark: '#0B1020', light: '#FFFFFF' } });
    res.type('image/svg+xml').send(svg);
  }),
);

app.post('/api/demo/reset', (req, res) => {
  store.reset();
  terminals.clear();
  intents.clear();
  for (const [ws] of clients) send(ws, { type: 'demo:reset' });
  res.json({ ok: true });
});

app.get('/healthz', (req, res) => res.json({ ok: true, instance: INSTANCE_ID, uptimeS: Math.round(process.uptime()) }));

// SPA routes: NFC sticker / QR links land on /t/<userId>
app.get(['/t/:userId', '/app', '/app/*'], (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

// On Vercel the platform owns the listener: api/server.js re-exports this server.
if (!process.env.VERCEL) {
  server.listen(PORT, () => {
    console.log(`\n  Payd running on http://localhost:${PORT}`);
    console.log(`  Two-phone simulator: http://localhost:${PORT}/sim`);
    console.log(`  PayPal: ${paypal.mode}${paypal.mode === 'mock' ? ' (set PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET for sandbox)' : ''}`);
    console.log(`  AI:     ${ai.enabled ? ai.MODEL : 'rules fallback (set ANTHROPIC_API_KEY for Claude)'}\n`);
  });
}

export default server;
