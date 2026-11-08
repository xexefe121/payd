// Claude-powered features for Payd.
//
//  1. Voice/Text Checkout  - natural language order -> structured cart from the merchant catalog
//  2. Snap & Split         - receipt photo -> line items (vision) -> per-person shares to collect by tap
//  3. Payd Guard           - per-tap risk review that explains itself to the payer in plain English
//  4. Merchant Copilot     - agent with tools over PayPal sales data; money-moving actions
//                            (refunds, payouts) are proposed by the agent and executed only after
//                            the merchant approves them in the UI (human in the loop).
//
// Every feature has a deterministic fallback (server/heuristics.js) so the demo runs without a key.

import Anthropic from '@anthropic-ai/sdk';
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema';
import { EventEmitter } from 'node:events';
import { parseOrderHeuristic, cartTotal } from './heuristics.js';

export const events = new EventEmitter();

export const MODEL = process.env.PAYD_MODEL || 'claude-opus-5-5';
const hasKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

export let enabled = hasKey && process.env.PAYD_AI !== 'off';
let client = enabled ? new Anthropic() : null;

/** Swap the Anthropic client (used by tests with a fake transport). */
export function configure(options) {
  client = options.client || null;
  enabled = Boolean(client);
}

// Server-side refusal fallback: if a request is declined, the API re-runs it on Anthropic's
// recommended fallback model inside the same call.
const FALLBACK = { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };

export function status() {
  return { enabled, model: enabled ? MODEL : null };
}

function textOf(message) {
  return message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

async function structured(feature, { system, content, schema, effort = 'low', maxTokens = 4000 }) {
  const started = Date.now();
  try {
    const message = await client.beta.messages.create({
      ...FALLBACK,
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content }],
      output_config: { effort, format: { type: 'json_schema', schema } },
    });
    if (message.stop_reason === 'refusal') throw new Error('Claude declined this request');
    if (message.stop_reason === 'max_tokens') throw new Error('Claude response was cut off');
    const out = JSON.parse(textOf(message));
    events.emit('call', { feature, model: message.model, ms: Date.now() - started, ok: true, usage: message.usage });
    return out;
  } catch (err) {
    events.emit('call', { feature, model: MODEL, ms: Date.now() - started, ok: false, error: describe(err) });
    throw err;
  }
}

function describe(err) {
  if (err instanceof Anthropic.RateLimitError) return 'rate limited';
  if (err instanceof Anthropic.AuthenticationError) return 'invalid API key';
  if (err instanceof Anthropic.APIError) return `API ${err.status}: ${err.message}`;
  return err.message;
}

// ---------------------------------------------------------------- 1. checkout

const CART_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items', 'unmatched', 'reply'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['sku', 'qty', 'note'],
        properties: {
          sku: { type: 'string' },
          qty: { type: 'integer' },
          note: { type: 'string' },
        },
      },
    },
    unmatched: { type: 'array', items: { type: 'string' } },
    reply: { type: 'string' },
  },
};

export async function buildCart(text, catalog) {
  const fallback = parseOrderHeuristic(text, catalog);
  if (!enabled) return { ...fallback, reply: summarizeCart(fallback.items), source: 'rules' };

  const menu = catalog
    .map((p) => `${p.sku} | ${p.name} | $${p.price}${p.modifier ? ' | modifier (add-on, one per modified item)' : ''}`)
    .join('\n');
  try {
    const out = await structured('checkout', {
      system:
        'You turn a spoken or typed customer order at a café counter into a cart. ' +
        'Only use SKUs from the menu. Map synonyms and typos to the closest menu item ' +
        '(e.g. "americano" -> long-black). Add-ons like oat milk or extra shots become their ' +
        'own line with a quantity equal to the number of items they modify. Anything that is ' +
        'not on the menu goes in "unmatched". "reply" is a short, friendly confirmation the ' +
        'barista can read aloud (max 20 words).',
      content: `MENU (sku | name | price)\n${menu}\n\nORDER: ${text}`,
      schema: CART_SCHEMA,
    });
    const bySku = new Map(catalog.map((p) => [p.sku, p]));
    const merged = new Map();
    for (const it of out.items) {
      const p = bySku.get(it.sku);
      if (!p || it.qty < 1) continue;
      const prev = merged.get(p.sku);
      merged.set(p.sku, {
        sku: p.sku,
        name: p.name,
        emoji: p.emoji,
        unitPrice: p.price,
        qty: (prev?.qty || 0) + Math.min(it.qty, 99),
        note: it.note || prev?.note || '',
      });
    }
    const items = [...merged.values()];
    return { items, unmatched: out.unmatched, total: cartTotal(items), reply: out.reply, source: 'claude' };
  } catch {
    return { ...fallback, reply: summarizeCart(fallback.items), source: 'rules' };
  }
}

function summarizeCart(items) {
  if (!items.length) return "Sorry, I couldn't match that to the menu.";
  return 'Got it: ' + items.map((i) => `${i.qty}× ${i.name}`).join(', ') + '.';
}

// ---------------------------------------------------------------- 2. receipts

const RECEIPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['merchant', 'currency', 'items', 'subtotal', 'tax', 'tip', 'total'],
  properties: {
    merchant: { type: 'string' },
    currency: { type: 'string' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'qty', 'lineTotal'],
        properties: {
          name: { type: 'string' },
          qty: { type: 'integer' },
          lineTotal: { type: 'number' },
        },
      },
    },
    subtotal: { type: 'number' },
    tax: { type: 'number' },
    tip: { type: 'number' },
    total: { type: 'number' },
  },
};

export async function parseReceipt(base64, mediaType = 'image/jpeg') {
  if (!enabled) {
    const err = new Error('Receipt scanning needs ANTHROPIC_API_KEY');
    err.code = 'AI_OFFLINE';
    throw err;
  }
  return structured('receipt', {
    system:
      'You read restaurant and shop receipts. Extract every purchased line item with its ' +
      'quantity and line total (price for that line, not unit price). Use 0 for tax or tip ' +
      'when absent. Use an ISO currency code (default USD). If the image is not a receipt, ' +
      'return an empty items array and total 0.',
    content: [
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
      { type: 'text', text: 'Extract this receipt.' },
    ],
    schema: RECEIPT_SCHEMA,
    effort: 'medium',
  });
}

// ---------------------------------------------------------------- 3. guard

const GUARD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['level', 'score', 'headline', 'reasons', 'action'],
  properties: {
    level: { type: 'string', enum: ['low', 'medium', 'high'] },
    score: { type: 'integer' },
    headline: { type: 'string' },
    reasons: { type: 'array', items: { type: 'string' } },
    action: { type: 'string', enum: ['allow', 'confirm', 'block'] },
  },
};

export async function reviewTap(context, rules) {
  if (!enabled) return rules;
  try {
    const out = await structured('guard', {
      system:
        'You are Payd Guard, the safety check that runs the instant two phones tap to pay. ' +
        'You see the payment context and rule-based signals. Decide how risky this tap is for ' +
        'the PAYER (scams, accidental taps, wrong amount, coerced payments, mismatched pairing). ' +
        'Speak to the payer directly: headline max 8 words, up to 3 reasons max 12 words each, ' +
        'concrete and calm, no jargon. score 1-99. action: allow (normal), confirm (make them ' +
        'look twice), block (only for clear fraud patterns).',
      content: JSON.stringify({ context, ruleSignals: rules }),
      schema: GUARD_SCHEMA,
      maxTokens: 2000,
    });
    return {
      ...out,
      score: Math.max(1, Math.min(99, out.score)),
      reasons: out.reasons.slice(0, 3),
      source: 'claude',
    };
  } catch {
    return rules;
  }
}

// ---------------------------------------------------------------- 4. copilot

/**
 * deps: {
 *   merchant, transactions(), proposeRefund({transactionId, amount, reason}),
 *   proposePayout({email, amount, note}), armTerminal({items, note})
 * }
 */
export async function copilot(history, deps) {
  const { merchant } = deps;
  const actions = [];
  let terminal = null;

  const salesSummary = betaTool({
    name: 'sales_summary',
    description:
      'Totals for the merchant over the last N days: revenue, count, average ticket, refunds, top items, busiest hours.',
    inputSchema: {
      type: 'object',
      properties: { days: { type: 'integer', description: 'Look-back window in days (1-30)' } },
      required: ['days'],
      additionalProperties: false,
    },
    run: async ({ days }) => JSON.stringify(summarize(deps.transactions(), days)),
  });

  const listTransactions = betaTool({
    name: 'list_transactions',
    description: 'Most recent payments received by the merchant, newest first, with ids usable for refunds.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', description: '1-25' } },
      required: ['limit'],
      additionalProperties: false,
    },
    run: async ({ limit }) =>
      JSON.stringify(
        deps
          .transactions()
          .slice(0, Math.min(Math.max(limit, 1), 25))
          .map((t) => ({
            id: t.id,
            when: new Date(t.createdAt).toISOString(),
            amount: t.amount,
            status: t.status,
            payer: t.payerLabel,
            items: t.items.map((i) => `${i.qty}x ${i.name}`).join(', '),
          })),
      ),
  });

  const proposeRefund = betaTool({
    name: 'propose_refund',
    description:
      'Propose refunding a payment through PayPal. Does NOT move money: it creates a pending action the merchant must approve in the app.',
    inputSchema: {
      type: 'object',
      properties: {
        transaction_id: { type: 'string' },
        amount: { type: 'string', description: 'Partial refund amount like "4.50"; omit for full refund' },
        reason: { type: 'string' },
      },
      required: ['transaction_id', 'reason'],
      additionalProperties: false,
    },
    run: async ({ transaction_id, amount, reason }) => {
      const r = deps.proposeRefund({ transactionId: transaction_id, amount, reason });
      if (r.error) return `Error: ${r.error}`;
      actions.push(r.action);
      return `Pending action ${r.action.id} created. Tell the merchant to tap Approve to send the refund.`;
    },
  });

  const proposePayout = betaTool({
    name: 'propose_payout',
    description:
      'Propose sending money from the merchant to an email address with PayPal Payouts (e.g. paying a supplier). Creates a pending action that requires merchant approval.',
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string' },
        amount: { type: 'string', description: 'e.g. "120.00"' },
        note: { type: 'string' },
      },
      required: ['email', 'amount', 'note'],
      additionalProperties: false,
    },
    run: async ({ email, amount, note }) => {
      const r = deps.proposePayout({ email, amount, note });
      if (r.error) return `Error: ${r.error}`;
      actions.push(r.action);
      return `Pending action ${r.action.id} created. Tell the merchant to tap Approve to send it.`;
    },
  });

  const armTerminal = betaTool({
    name: 'ring_up',
    description:
      "Put items on the merchant's tap terminal so the next customer can tap to pay. Customers still confirm on their own phone.",
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { sku: { type: 'string' }, qty: { type: 'integer' } },
            required: ['sku', 'qty'],
            additionalProperties: false,
          },
        },
        note: { type: 'string' },
      },
      required: ['items', 'note'],
      additionalProperties: false,
    },
    run: async ({ items, note }) => {
      const r = deps.armTerminal({ items, note });
      if (r.error) return `Error: ${r.error}`;
      terminal = r;
      return `Terminal armed for $${r.total}. Customer can tap now.`;
    },
  });

  const started = Date.now();
  try {
    const final = await client.beta.messages.toolRunner({
      ...FALLBACK,
      model: MODEL,
      max_tokens: 8000,
      max_iterations: 6,
      output_config: { effort: 'medium' },
      system:
        `You are Payd Copilot for ${merchant.name}, a business that takes tap-to-pay payments through PayPal. ` +
        'Answer questions about sales using the tools, with exact numbers. Keep answers short and scannable ' +
        '(max ~80 words, light markdown, no tables). For refunds and payouts, always use the propose_* tools: ' +
        'you cannot move money yourself, the merchant approves each action. Use list_transactions to find ids. ' +
        `Menu SKUs: ${(merchant.catalog || []).map((p) => `${p.sku} ($${p.price})`).join(', ')}. ` +
        `Today is ${new Date().toDateString()}.`,
      tools: [salesSummary, listTransactions, proposeRefund, proposePayout, armTerminal],
      messages: history.map((m) => ({ role: m.role, content: m.content })),
    });
    if (final.stop_reason === 'refusal') throw new Error('Claude declined this request');
    events.emit('call', { feature: 'copilot', model: final.model, ms: Date.now() - started, ok: true, usage: final.usage });
    return { reply: textOf(final) || 'Done.', actions, terminal, source: 'claude' };
  } catch (err) {
    events.emit('call', { feature: 'copilot', model: MODEL, ms: Date.now() - started, ok: false, error: describe(err) });
    throw err;
  }
}

export function summarize(transactions, days = 7) {
  const since = Date.now() - days * 24 * 3600 * 1000;
  const inWindow = transactions.filter((t) => t.createdAt >= since);
  const done = inWindow.filter((t) => t.status === 'completed' || t.status === 'partially_refunded');
  const refunded = inWindow.filter((t) => t.status === 'refunded' || t.status === 'partially_refunded');
  const revenue = done.reduce((s, t) => s + Math.round(Number(t.amount) * 100) - Math.round(Number(t.refundedAmount || 0) * 100), 0);
  const items = new Map();
  const hours = new Array(24).fill(0);
  for (const t of done) {
    hours[new Date(t.createdAt).getHours()] += 1;
    for (const it of t.items || []) items.set(it.name, (items.get(it.name) || 0) + Number(it.qty || 1));
  }
  const topItems = [...items.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, qty]) => ({ name, qty }));
  const busiest = hours
    .map((count, hour) => ({ hour, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .filter((h) => h.count > 0);
  return {
    days,
    payments: done.length,
    revenue: (revenue / 100).toFixed(2),
    averageTicket: done.length ? (revenue / done.length / 100).toFixed(2) : '0.00',
    refunds: refunded.length,
    topItems,
    busiestHours: busiest,
  };
}
