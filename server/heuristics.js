// Deterministic fallbacks used when no Claude API key is configured (and as the
// instant first answer while Claude refines it). Also unit-tested.

import { toCents, fromCents } from './money.js';

const NUMBER_WORDS = {
  a: 1, an: 1, one: 1, single: 1, two: 2, couple: 2, pair: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, dozen: 12,
};

function norm(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** "two flat whites, one with oat, and a banana bread" -> cart items */
export function parseOrderHeuristic(text, catalog = []) {
  const names = [];
  for (const p of catalog) {
    for (const n of [p.name, ...(p.aliases || [])]) names.push({ words: norm(n).split(' '), product: p });
  }
  names.sort((a, b) => b.words.length - a.words.length || b.words.join(' ').length - a.words.join(' ').length);

  const SEPARATORS = new Set(['and', 'plus', 'with', 'also', 'then']);
  const FILLER = new Set(['please', 'thanks', 'thank', 'you', 'can', 'could', 'i', 'get', 'have', 'll', 'id', 'd', 'like', 'want',
    'to', 'go', 'for', 'here', 'the', 'of', 'x', 'some', 'me', 'us', 'we', 'that', 's', 'it', 'is', 'all', 'just', 'too', 'oh']);

  const words = String(text).toLowerCase().replace(/,/g, ' , ').split(/\s+/).flatMap((w) => (w === ',' ? [','] : norm(w).split(' '))).filter(Boolean);
  const cart = new Map();
  const unmatched = [];
  let phrase = [];
  let pendingQty = null;
  const flush = () => {
    if (phrase.length) unmatched.push(phrase.join(' '));
    phrase = [];
  };

  for (let i = 0; i < words.length; ) {
    const w = words[i];
    if (w === ',' || SEPARATORS.has(w)) {
      flush();
      i++;
      continue;
    }
    const hit = names.find((n) => n.words.every((nw, k) => words[i + k] === nw));
    if (hit) {
      flush();
      const p = hit.product;
      const q = pendingQty ?? 1;
      pendingQty = null;
      const prev = cart.get(p.sku);
      cart.set(p.sku, { sku: p.sku, name: p.name, qty: (prev?.qty || 0) + q, unitPrice: p.price, emoji: p.emoji });
      i += hit.words.length;
      continue;
    }
    if (/^\d+$/.test(w)) pendingQty = Math.min(Number(w), 99);
    else if (NUMBER_WORDS[w]) pendingQty = NUMBER_WORDS[w];
    else if (!FILLER.has(w)) {
      phrase.push(w);
      pendingQty = null;
    }
    i++;
  }
  flush();
  const items = [...cart.values()];
  return { items, unmatched, total: cartTotal(items) };
}

export function cartTotal(items) {
  return fromCents(items.reduce((s, it) => s + (toCents(it.unitPrice) || 0) * (Number(it.qty) || 1), 0));
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Risk signals for a tap. ctx = {
 *   amount, payerHistory: number[] (past amounts), knownPayee: bool, payeeType,
 *   recentTapCount (last 10 min), distanceM, ambiguous, hour, tapLimit, method
 * }
 */
export function guardHeuristic(ctx) {
  const reasons = [];
  let score = 4;
  const amount = Number(ctx.amount) || 0;
  const med = median(ctx.payerHistory || []);

  if (amount && med && amount > med * 4 && amount > 20) {
    score += 28;
    reasons.push(`${(amount / med).toFixed(1)}× your usual tap of $${med.toFixed(2)}`);
  }
  if (ctx.tapLimit && amount > Number(ctx.tapLimit)) {
    score += 18;
    reasons.push(`Above your $${Number(ctx.tapLimit).toFixed(0)} tap limit`);
  }
  if (!ctx.knownPayee && ctx.payeeType !== 'business') {
    score += 14;
    reasons.push('First payment to this person');
  }
  if ((ctx.recentTapCount || 0) >= 3) {
    score += 26;
    reasons.push(`${ctx.recentTapCount} taps in the last 10 minutes`);
  }
  if (ctx.ambiguous) {
    score += 22;
    reasons.push('Another phone tapped at the same moment nearby');
  }
  if (ctx.distanceM != null && ctx.distanceM > 120) {
    score += 12;
    reasons.push(`Phones look ${Math.round(ctx.distanceM)} m apart`);
  }
  if (ctx.hour != null && ctx.hour >= 0 && ctx.hour < 5 && amount > 40) {
    score += 8;
    reasons.push('Late-night payment');
  }
  if (ctx.payeeType === 'business' && ctx.knownPayee) {
    score -= 3;
  }
  score = Math.max(1, Math.min(99, score));
  const level = score < 30 ? 'low' : score < 60 ? 'medium' : 'high';
  const headline =
    level === 'low'
      ? ctx.knownPayee
        ? 'Looks normal — you have paid them before'
        : 'Looks normal'
      : level === 'medium'
        ? 'Double-check before paying'
        : 'Unusual tap — confirm carefully';
  return {
    level,
    score,
    headline,
    reasons: reasons.length ? reasons.slice(0, 3) : ['Amount and pattern match your history'],
    action: level === 'high' ? 'confirm' : 'allow',
    source: 'rules',
  };
}

/** Very small intent parser for the merchant copilot when Claude is offline. */
export function copilotHeuristic(message) {
  const m = norm(message);
  if (/refund/.test(m)) return { intent: 'refund_last' };
  if (/payout|pay (my )?supplier|send .*@/.test(m)) {
    const email = String(message).match(/[\w.+-]+@[\w-]+\.[\w.]+/)?.[0];
    const amt = String(message).match(/\$?\s?(\d+(?:\.\d{1,2})?)/)?.[1];
    return { intent: 'payout', email, amount: amt };
  }
  if (/best|top|popular|selling/.test(m)) return { intent: 'top_items' };
  if (/sales|revenue|today|week|made|earn|how .* doing/.test(m)) return { intent: 'summary' };
  return { intent: 'help' };
}
