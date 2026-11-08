import { test } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { toGridState, gridSpecHeuristic } from '../server/gridquery.js';
import * as ai from '../server/ai.js';

const ctx = { today: '2026-11-09', payers: ['Alice Chen', 'Leo Martin', 'Walk-in customer'] };

test('toGridState builds AG Grid filter models and drops invalid conditions', () => {
  const s = toGridState({
    filters: [
      { column: 'amount', op: 'greaterThan', value: '$20', valueTo: '' },
      { column: 'amount', op: 'lessThan', value: '50', valueTo: '' },
      { column: 'when', op: 'inRange', value: '2026-11-01', valueTo: '2026-11-08' },
      { column: 'status', op: 'contains', value: 'refunded', valueTo: '' },
      { column: 'status', op: 'greaterThan', value: 'x', valueTo: '' }, // wrong op for text
      { column: 'amount', op: 'equals', value: 'lots', valueTo: '' }, // not a number
      { column: 'nope', op: 'equals', value: '1', valueTo: '' },
    ],
    sort: [{ column: 'amount', direction: 'desc' }, { column: 'bogus', direction: 'asc' }],
    quickFilter: '',
    explanation: 'x',
  });
  assert.deepEqual(s.filterModel.amount, {
    filterType: 'number',
    operator: 'AND',
    conditions: [
      { filterType: 'number', type: 'greaterThan', filter: 20 },
      { filterType: 'number', type: 'lessThan', filter: 50 },
    ],
  });
  assert.deepEqual(s.filterModel.when, { filterType: 'date', type: 'inRange', dateFrom: '2026-11-01', dateTo: '2026-11-08' });
  assert.deepEqual(s.filterModel.status, { filterType: 'text', type: 'contains', filter: 'refunded' });
  assert.equal(Object.keys(s.filterModel).length, 3);
  assert.deepEqual(s.sort, [{ colId: 'amount', sort: 'desc', sortIndex: 0 }]);
});

test('rule fallback understands common ledger questions', () => {
  const a = toGridState(gridSpecHeuristic('refunds over $10 this week', ctx));
  assert.equal(a.filterModel.status.filter, 'refunded');
  assert.equal(a.filterModel.amount.filter, 10);
  assert.equal(a.filterModel.when.dateFrom, '2026-11-02');

  const b = toGridState(gridSpecHeuristic("Alice's NFC sticker payments today, biggest first", ctx));
  assert.equal(b.filterModel.payer.filter, 'Alice');
  assert.equal(b.filterModel.method.filter, 'NFC sticker');
  assert.equal(b.filterModel.when.dateFrom, '2026-11-09');
  assert.deepEqual(b.sort[0], { colId: 'amount', sort: 'desc', sortIndex: 0 });

  const c = toGridState(gridSpecHeuristic('suspicious taps', ctx));
  assert.equal(c.filterModel.guardScore.type, 'greaterThanOrEqual');
  assert.equal(c.filterModel.guardScore.filter, 60);
});

test('gridQuery asks Claude for a schema-constrained spec', async () => {
  let body;
  const client = new Anthropic({
    apiKey: 'test',
    baseURL: 'http://claude.test',
    maxRetries: 0,
    fetch: async (url, init) => {
      body = JSON.parse(init.body);
      const spec = {
        filters: [{ column: 'payer', op: 'contains', value: 'Leo', valueTo: '' }],
        sort: [{ column: 'when', direction: 'desc' }],
        quickFilter: '',
        explanation: "Leo Martin's payments, newest first.",
      };
      return new Response(
        JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: JSON.stringify(spec) }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });
  ai.configure({ client });
  const r = await ai.gridQuery("what did leo buy", ctx);
  assert.equal(r.source, 'claude');
  assert.equal(r.filterModel.payer.filter, 'Leo');
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.match(body.messages[0].content, /TODAY: 2026-11-09/);
  assert.match(body.messages[0].content, /Leo Martin/);
  ai.configure({ client: null });
});
