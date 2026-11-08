import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOrderHeuristic, guardHeuristic, copilotHeuristic } from '../server/heuristics.js';
import { CAFE_CATALOG } from '../server/store.js';
import { normalizeAmount, evenShares, toCents } from '../server/money.js';

test('parses a spoken café order with modifiers', () => {
  const r = parseOrderHeuristic('two flat whites, one with oat, and a banana bread please', CAFE_CATALOG);
  const bySku = Object.fromEntries(r.items.map((i) => [i.sku, i.qty]));
  assert.deepEqual(bySku, { 'flat-white': 2, 'oat-milk': 1, 'banana-bread': 1 });
  assert.equal(r.total, '14.90');
  assert.deepEqual(r.unmatched, []);
});

test('handles digits, aliases and unknown items', () => {
  const r = parseOrderHeuristic('3 cappuccinos, an americano and a pizza', CAFE_CATALOG);
  const bySku = Object.fromEntries(r.items.map((i) => [i.sku, i.qty]));
  assert.equal(bySku.cappuccino, 3);
  assert.equal(bySku['long-black'], 1);
  assert.ok(r.unmatched.some((u) => u.includes('pizza')));
});

test('guard: normal café tap is low risk', () => {
  const g = guardHeuristic({ amount: '9.00', payerHistory: [5, 9, 12], knownPayee: true, payeeType: 'business', recentTapCount: 1, tapLimit: '50' });
  assert.equal(g.level, 'low');
  assert.equal(g.action, 'allow');
});

test('guard: large first payment to a stranger is high risk and needs confirmation', () => {
  const g = guardHeuristic({ amount: '480', payerHistory: [5, 9, 12, 18], knownPayee: false, payeeType: 'personal', recentTapCount: 3, tapLimit: '50' });
  assert.equal(g.level, 'high');
  assert.equal(g.action, 'confirm');
  assert.ok(g.reasons.length >= 2);
});

test('copilot rules map common intents', () => {
  assert.equal(copilotHeuristic('how did we do today?').intent, 'summary');
  assert.equal(copilotHeuristic('refund the last one').intent, 'refund_last');
  const p = copilotHeuristic('pay supplier@beans.co $120 for beans');
  assert.equal(p.intent, 'payout');
  assert.equal(p.email, 'supplier@beans.co');
  assert.equal(p.amount, '120');
});

test('money helpers', () => {
  assert.equal(normalizeAmount('12.5'), '12.50');
  assert.equal(normalizeAmount('0'), null);
  assert.equal(normalizeAmount('20000'), null);
  assert.equal(toCents('4.35'), 435);
  const s = evenShares(10033, 3);
  assert.equal(s.reduce((a, b) => a + b, 0), 10033);
  assert.deepEqual(s, [3345, 3344, 3344]);
});
