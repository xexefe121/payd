// Exercises the Claude integration against a fake transport: verifies request
// shape (model, structured output schema, refusal fallbacks) and the copilot's
// tool-use loop without network access or an API key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import * as ai from '../server/ai.js';
import { CAFE_CATALOG } from '../server/store.js';

function fakeClient(responder) {
  const calls = [];
  const client = new Anthropic({
    apiKey: 'test-key',
    baseURL: 'http://claude.test',
    maxRetries: 0,
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      const headers = Object.fromEntries(new Headers(init.headers).entries());
      calls.push({ url: String(url), body, headers });
      const content = responder(body, calls.length);
      return new Response(
        JSON.stringify({
          id: `msg_${calls.length}`,
          type: 'message',
          role: 'assistant',
          model: body.model,
          content,
          stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 10 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });
  return { client, calls };
}

test('buildCart sends a structured-output request and maps SKUs to the catalog', async () => {
  const { client, calls } = fakeClient(() => [
    {
      type: 'text',
      text: JSON.stringify({
        items: [
          { sku: 'flat-white', qty: 2, note: '' },
          { sku: 'oat-milk', qty: 1, note: 'one oat' },
          { sku: 'not-a-sku', qty: 1, note: '' },
        ],
        unmatched: ['pizza'],
        reply: 'Two flat whites, one with oat!',
      }),
    },
  ]);
  ai.configure({ client });
  const r = await ai.buildCart('two flat whites one oat and a pizza', CAFE_CATALOG);
  assert.equal(r.source, 'claude');
  assert.equal(r.total, '9.70');
  assert.deepEqual(r.unmatched, ['pizza']);
  assert.equal(r.items.length, 2);

  const req = calls[0];
  assert.equal(req.body.model, ai.MODEL);
  assert.equal(req.body.output_config.format.type, 'json_schema');
  assert.equal(req.body.fallbacks, 'default');
  assert.match(req.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  assert.match(req.body.messages[0].content, /flat-white \| Flat White \| \$4\.50/);
});

test('buildCart falls back to rules when Claude errors', async () => {
  const client = new Anthropic({
    apiKey: 'x',
    baseURL: 'http://claude.test',
    maxRetries: 0,
    fetch: async () => new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }), { status: 529 }),
  });
  ai.configure({ client });
  const r = await ai.buildCart('a latte', CAFE_CATALOG);
  assert.equal(r.source, 'rules');
  assert.equal(r.items[0].sku, 'latte');
});

test('reviewTap returns Claude verdict clamped and tagged', async () => {
  const { client } = fakeClient(() => [
    {
      type: 'text',
      text: JSON.stringify({ level: 'medium', score: 140, headline: 'First time paying Ben', reasons: ['a', 'b', 'c', 'd'], action: 'confirm' }),
    },
  ]);
  ai.configure({ client });
  const g = await ai.reviewTap({ amount: '40' }, { level: 'low', score: 10, reasons: [], source: 'rules' });
  assert.equal(g.source, 'claude');
  assert.equal(g.score, 99);
  assert.equal(g.reasons.length, 3);
});

test('copilot runs the tool loop and only proposes refunds', async () => {
  const proposals = [];
  const { client, calls } = fakeClient((body, n) => {
    if (n === 1) return [{ type: 'tool_use', id: 'tu_1', name: 'list_transactions', input: { limit: 3 } }];
    if (n === 2) return [{ type: 'tool_use', id: 'tu_2', name: 'propose_refund', input: { transaction_id: 'tx_1', reason: 'cold coffee' } }];
    return [{ type: 'text', text: 'Refund ready — tap Approve.' }];
  });
  ai.configure({ client });
  const deps = {
    merchant: { name: 'Bean There Café', catalog: CAFE_CATALOG },
    transactions: () => [{ id: 'tx_1', createdAt: Date.now(), amount: '9.00', status: 'completed', payerLabel: 'Alice', items: [] }],
    proposeRefund: (a) => {
      proposals.push(a);
      return { action: { id: 'act_1', kind: 'refund', summary: 'Refund $9.00 to Alice' } };
    },
    proposePayout: () => ({ error: 'no' }),
    armTerminal: () => ({ error: 'no' }),
  };
  const r = await ai.copilot([{ role: 'user', content: 'refund alice, her coffee was cold' }], deps);
  assert.equal(r.reply, 'Refund ready — tap Approve.');
  assert.equal(r.actions.length, 1);
  assert.deepEqual(proposals, [{ transactionId: 'tx_1', amount: undefined, reason: 'cold coffee' }]);
  assert.equal(calls.length, 3);
  // tool results were sent back to Claude
  const last = calls[2].body.messages.at(-1);
  assert.equal(last.role, 'user');
  assert.equal(last.content[0].type, 'tool_result');
  assert.deepEqual(calls[0].body.tools.map((t) => t.name), ['sales_summary', 'list_transactions', 'propose_refund', 'propose_payout', 'ring_up']);
});
