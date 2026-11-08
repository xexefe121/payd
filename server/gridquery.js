// "Ask your ledger": natural-language questions -> AG Grid view state.
//
// Claude (or the rule fallback below) produces a small, validated spec:
//   { filters: [{column, op, value, valueTo}], sort: [{column, direction}], quickFilter, explanation }
// which toGridState() turns into an AG Grid filterModel + column sort state.

export const GRID_COLUMNS = {
  when: { type: 'date', label: 'Date/time of the payment' },
  payer: { type: 'text', label: 'Customer name' },
  items: { type: 'text', label: 'Items bought, e.g. "2× Flat White, 1× Croissant"' },
  amount: { type: 'number', label: 'Amount in USD' },
  method: { type: 'text', label: 'How they paid: "Phone tap", "NFC sticker", "QR code" or "Pay link"' },
  guardScore: { type: 'number', label: 'Payd Guard risk score 1-99 (30+ medium, 60+ high)' },
  guardLevel: { type: 'text', label: 'Payd Guard level: "low", "medium" or "high"' },
  status: { type: 'text', label: 'Payment status: "completed", "refunded" or "partially refunded"' },
};

const OPS = {
  text: ['equals', 'notEqual', 'contains', 'notContains'],
  number: ['equals', 'notEqual', 'greaterThan', 'greaterThanOrEqual', 'lessThan', 'lessThanOrEqual', 'inRange'],
  date: ['equals', 'notEqual', 'greaterThan', 'lessThan', 'inRange'],
};

export const GRID_SPEC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['filters', 'sort', 'quickFilter', 'explanation'],
  properties: {
    filters: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['column', 'op', 'value', 'valueTo'],
        properties: {
          column: { type: 'string', enum: Object.keys(GRID_COLUMNS) },
          op: { type: 'string', enum: [...new Set(Object.values(OPS).flat())] },
          value: { type: 'string' },
          valueTo: { type: 'string' },
        },
      },
    },
    sort: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['column', 'direction'],
        properties: {
          column: { type: 'string', enum: Object.keys(GRID_COLUMNS) },
          direction: { type: 'string', enum: ['asc', 'desc'] },
        },
      },
    },
    quickFilter: { type: 'string' },
    explanation: { type: 'string' },
  },
};

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Validate a spec and convert it to AG Grid state. Invalid conditions are dropped. */
export function toGridState(spec) {
  const byColumn = new Map();
  for (const f of spec.filters || []) {
    const col = GRID_COLUMNS[f.column];
    if (!col || !OPS[col.type].includes(f.op)) continue;
    let cond;
    if (col.type === 'number') {
      const v = Number(String(f.value).replace(/[$,]/g, ''));
      if (!Number.isFinite(v)) continue;
      cond = { filterType: 'number', type: f.op, filter: v };
      if (f.op === 'inRange') {
        const to = Number(String(f.valueTo).replace(/[$,]/g, ''));
        if (!Number.isFinite(to)) continue;
        cond.filterTo = to;
      }
    } else if (col.type === 'date') {
      if (!isDate(f.value)) continue;
      cond = { filterType: 'date', type: f.op, dateFrom: f.value, dateTo: null };
      if (f.op === 'inRange') {
        if (!isDate(f.valueTo)) continue;
        cond.dateTo = f.valueTo;
      }
    } else {
      if (!String(f.value).trim()) continue;
      cond = { filterType: 'text', type: f.op, filter: String(f.value).trim() };
    }
    if (!byColumn.has(f.column)) byColumn.set(f.column, []);
    byColumn.get(f.column).push(cond);
  }
  const filterModel = {};
  for (const [column, conds] of byColumn) {
    filterModel[column] =
      conds.length === 1 ? conds[0] : { filterType: conds[0].filterType, operator: 'AND', conditions: conds.slice(0, 2) };
  }
  const sort = (spec.sort || [])
    .filter((s) => GRID_COLUMNS[s.column] && (s.direction === 'asc' || s.direction === 'desc'))
    .slice(0, 2)
    .map((s, i) => ({ colId: s.column, sort: s.direction, sortIndex: i }));
  return {
    filterModel,
    sort,
    quickFilter: String(spec.quickFilter || '').slice(0, 60),
    explanation: String(spec.explanation || '').slice(0, 200),
  };
}

function shiftDate(isoDay, days) {
  const d = new Date(`${isoDay}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Rule-based fallback when Claude is not configured. ctx = { today: 'YYYY-MM-DD', payers: [names] } */
export function gridSpecHeuristic(question, ctx) {
  const q = String(question).toLowerCase();
  const filters = [];
  const sort = [];
  const said = [];
  const add = (column, op, value, valueTo = '') => filters.push({ column, op, value: String(value), valueTo: String(valueTo) });

  if (/partial/.test(q)) {
    add('status', 'contains', 'partially');
    said.push('partial refunds');
  } else if (/refund/.test(q)) {
    add('status', 'contains', 'refunded');
    said.push('refunds');
  }

  const over = q.match(/(?:over|above|more than|greater than|>)\s*\$?\s*(\d+(?:\.\d+)?)/);
  const under = q.match(/(?:under|below|less than|<)\s*\$?\s*(\d+(?:\.\d+)?)/);
  if (over) {
    add('amount', 'greaterThan', over[1]);
    said.push(`over $${over[1]}`);
  }
  if (under) {
    add('amount', 'lessThan', under[1]);
    said.push(`under $${under[1]}`);
  }

  if (/today/.test(q)) {
    add('when', 'equals', ctx.today);
    said.push('today');
  } else if (/yesterday/.test(q)) {
    add('when', 'equals', shiftDate(ctx.today, -1));
    said.push('yesterday');
  } else if (/this week|last 7 days|past week/.test(q)) {
    add('when', 'greaterThan', shiftDate(ctx.today, -7));
    said.push('last 7 days');
  }

  if (/nfc|sticker/.test(q)) {
    add('method', 'equals', 'NFC sticker');
    said.push('NFC sticker');
  } else if (/\bqr\b/.test(q)) {
    add('method', 'equals', 'QR code');
    said.push('QR');
  } else if (/\bbump|phone tap|tapped phones\b/.test(q)) {
    add('method', 'equals', 'Phone tap');
    said.push('phone taps');
  }

  if (/high[- ]risk|suspicious|fraud|risky/.test(q)) {
    add('guardScore', 'greaterThanOrEqual', '60');
    said.push('high risk');
  } else if (/medium|flagged|unusual/.test(q)) {
    add('guardScore', 'greaterThanOrEqual', '30');
    said.push('flagged by Guard');
  }

  for (const name of ctx.payers || []) {
    const first = name.toLowerCase().split(' ')[0];
    if (first.length > 2 && new RegExp(`\\b${first}`).test(q)) {
      add('payer', 'contains', name.split(' ')[0]);
      said.push(`paid by ${name.split(' ')[0]}`);
      break;
    }
  }

  const itemMatch = q.match(/(flat white|latte|cappuccino|long black|cold brew|matcha|croissant|banana bread|avocado|muffin)/);
  if (itemMatch) {
    add('items', 'contains', itemMatch[1]);
    said.push(`with ${itemMatch[1]}`);
  }

  let order = 'newest first';
  if (/biggest|largest|highest|top|most expensive|sorted by amount|by amount/.test(q)) {
    sort.push({ column: 'amount', direction: 'desc' });
    order = 'biggest first';
  } else if (/smallest|cheapest|lowest/.test(q)) {
    sort.push({ column: 'amount', direction: 'asc' });
    order = 'smallest first';
  } else if (/riskiest|by risk|risk/.test(q)) {
    sort.push({ column: 'guardScore', direction: 'desc' });
    order = 'riskiest first';
  } else if (/oldest|earliest/.test(q)) {
    sort.push({ column: 'when', direction: 'asc' });
    order = 'oldest first';
  } else sort.push({ column: 'when', direction: 'desc' });

  return {
    filters,
    sort,
    quickFilter: '',
    explanation: `${said.length ? `Payments ${said.join(', ')}` : 'All payments'}, ${order}.`,
  };
}
