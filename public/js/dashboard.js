// Payd Live Ledger: AG Grid over the merchant's PayPal transactions.
// New taps stream in over the WebSocket and flash into the grid, refunds go
// through PayPal from the row, and "Ask your ledger" turns a sentence into
// AG Grid filters and sorting (Claude, with a rule fallback).

import { api, Realtime } from './net.js';
import { esc, money, sounds, markdownLite, initials } from './ui.js';

const { createGrid, ModuleRegistry, AllCommunityModule, themeQuartz, colorSchemeDark } = window.agGrid;
ModuleRegistry.registerModules([AllCommunityModule]);

const qs = new URLSearchParams(location.search);
const MERCHANT = qs.get('as') || 'cafe';
const METHOD_LABELS = { bump: 'Phone tap', sim: 'Phone tap', key: 'Phone tap', 'nfc-tag': 'NFC sticker', qr: 'QR code', link: 'Pay link' };
const $ = (id) => document.getElementById(id);

let grid;
let merchant;
let config;
const chat = [];

// ------------------------------------------------------------------ rows

function toRow(tx) {
  return {
    id: tx.id,
    when: new Date(tx.createdAt),
    payer: tx.payerLabel || tx.payer?.name || 'Customer',
    payerColor: tx.payer?.color || '#3a4470',
    items: (tx.items || []).map((i) => `${i.qty}× ${i.name}`).join(', ') || tx.note || '—',
    amount: Number(tx.amount),
    refunded: Number(tx.refundedAmount || 0),
    method: METHOD_LABELS[tx.method] || 'Phone tap',
    guardScore: tx.guard?.score ?? null,
    guardLevel: tx.guard?.level || '',
    status: String(tx.status || '').replace('_', ' '),
    captureId: tx.paypal?.captureId || '',
    live: !tx.seeded,
  };
}

function localDay(d = new Date()) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

// ------------------------------------------------------------------ renderers

function customerRenderer(p) {
  if (p.node.rowPinned) return `<b>${esc(p.value)}</b>`;
  const ini = initials(p.value) || '?';
  return `<span class="cust"><span class="av" style="background:${esc(p.data.payerColor)}">${esc(ini)}</span>${esc(p.value)}${p.data.live ? '<span class="live-tag">live</span>' : ''}</span>`;
}

function methodRenderer(p) {
  if (p.node.rowPinned || !p.value) return '';
  const icon = { 'Phone tap': '⤒', 'NFC sticker': '📶', 'QR code': '▦', 'Pay link': '🔗' }[p.value] || '•';
  return `<span class="pill method">${icon} ${esc(p.value)}</span>`;
}

function guardRenderer(p) {
  if (p.node.rowPinned || p.value == null) return '';
  return `<span class="pill guard ${esc(p.data.guardLevel)}">🛡 ${esc(p.data.guardLevel)} · ${p.value}</span>`;
}

function statusRenderer(p) {
  if (p.node.rowPinned || !p.value) return '';
  const extra = p.data.refunded && p.value === 'partially refunded' ? ` (${money(p.data.refunded)})` : '';
  return `<span class="pill status ${esc(p.value.replace(' ', '-'))}">${esc(p.value)}${extra}</span>`;
}

function actionRenderer(p) {
  if (p.node.rowPinned) return '';
  const remaining = p.data.amount - p.data.refunded;
  if (p.data.status === 'refunded' || remaining <= 0.001) return '<span class="muted">—</span>';
  const btn = document.createElement('button');
  btn.className = 'row-btn';
  btn.textContent = 'Refund';
  btn.title = `Refund up to ${money(remaining)} through PayPal`;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    refundRow(p.data, btn);
  });
  return btn;
}

// ------------------------------------------------------------------ grid

const dateComparator = (filterDate, cellValue) => {
  if (!cellValue) return -1;
  const d = new Date(cellValue);
  d.setHours(0, 0, 0, 0);
  return d < filterDate ? -1 : d > filterDate ? 1 : 0;
};

const theme = themeQuartz.withPart(colorSchemeDark).withParams({
  accentColor: '#4f6bff',
  backgroundColor: '#0d1226',
  foregroundColor: '#eef1ff',
  chromeBackgroundColor: '#121933',
  headerBackgroundColor: '#121933',
  oddRowBackgroundColor: '#0f1530',
  borderColor: 'rgba(255,255,255,0.07)',
  rowHoverColor: 'rgba(79,107,255,0.10)',
  selectedRowBackgroundColor: 'rgba(79,107,255,0.22)',
  fontFamily: 'inherit',
  fontSize: 13,
  headerFontWeight: 600,
  wrapperBorderRadius: 16,
  spacing: 7,
});

const columnDefs = [
  {
    field: 'when',
    headerName: 'Time',
    cellDataType: 'date',
    sort: 'desc',
    width: 150,
    filter: 'agDateColumnFilter',
    filterParams: { comparator: dateComparator },
    valueFormatter: (p) =>
      p.value instanceof Date
        ? p.value.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
        : '',
  },
  { field: 'payer', headerName: 'Customer', minWidth: 170, flex: 1.1, filter: 'agTextColumnFilter', cellRenderer: customerRenderer },
  { field: 'items', headerName: 'Items', minWidth: 200, flex: 2, filter: 'agTextColumnFilter', tooltipField: 'items' },
  {
    field: 'amount',
    headerName: 'Amount',
    width: 115,
    type: 'rightAligned',
    filter: 'agNumberColumnFilter',
    cellDataType: 'number',
    valueFormatter: (p) => (p.value == null ? '' : money(p.value)),
    cellClass: 'num',
  },
  { field: 'method', headerName: 'Paid by', width: 140, filter: 'agTextColumnFilter', cellRenderer: methodRenderer },
  { field: 'guardScore', headerName: 'Payd Guard', width: 150, filter: 'agNumberColumnFilter', cellDataType: 'number', cellRenderer: guardRenderer },
  { field: 'guardLevel', hide: true, filter: 'agTextColumnFilter' },
  { field: 'status', headerName: 'Status', width: 170, filter: 'agTextColumnFilter', cellRenderer: statusRenderer },
  { field: 'captureId', headerName: 'PayPal capture', width: 170, filter: 'agTextColumnFilter', cellClass: 'mono' },
  { colId: 'actions', headerName: '', width: 96, pinned: 'right', sortable: false, filter: false, resizable: false, cellRenderer: actionRenderer },
];

function initGrid(rows) {
  grid = createGrid($('grid'), {
    theme,
    rowData: rows,
    columnDefs,
    defaultColDef: { sortable: true, resizable: true, filter: true, floatingFilter: false },
    getRowId: (p) => p.data.id,
    animateRows: true,
    rowSelection: { mode: 'singleRow', checkboxes: false, enableClickSelection: true },
    tooltipShowDelay: 300,
    onModelUpdated: updateTotals,
    onFilterChanged: updateTotals,
  });
}

function displayedRows() {
  const rows = [];
  grid?.forEachNodeAfterFilter((n) => n.data && rows.push(n.data));
  return rows;
}

function updateTotals() {
  if (!grid) return;
  const rows = displayedRows();
  const gross = rows.reduce((s, r) => s + r.amount, 0);
  const refunded = rows.reduce((s, r) => s + r.refunded, 0);
  const net = gross - refunded;
  const flagged = rows.filter((r) => (r.guardScore || 0) >= 30).length;
  grid.setGridOption('pinnedBottomRowData', [{ id: 'total', payer: `${rows.length} payments`, items: refunded ? `${money(refunded)} refunded` : '', amount: gross }]);
  const filtered = Object.keys(grid.getFilterModel() || {}).length > 0 || grid.getGridOption('quickFilterText');
  $('kpis').innerHTML = [
    ['Net sales', money(net)],
    ['Payments', rows.length],
    ['Avg ticket', money(rows.length ? gross / rows.length : 0)],
    ['Refunded', money(refunded)],
    ['Flagged by Guard', flagged],
  ]
    .map(([k, v]) => `<div class="kpi"><small>${k}${filtered ? ' · in view' : ''}</small><b>${v}</b></div>`)
    .join('');
}

function flashRow(id) {
  const node = grid.getRowNode(id);
  if (!node) return null;
  grid.ensureNodeVisible(node, 'middle');
  grid.flashCells({ rowNodes: [node] });
  return node;
}

function upsertTx(tx, { isNew = false } = {}) {
  const row = toRow(tx);
  const exists = grid.getRowNode(row.id);
  if (exists) grid.applyTransaction({ update: [row] });
  else grid.applyTransaction({ add: [row], addIndex: 0 });
  setTimeout(() => flashRow(row.id), 50);
  if (isNew) {
    sounds.success();
    toast(`New tap: ${money(row.amount)} from ${row.payer} via ${row.method}`);
  }
}

// ------------------------------------------------------------------ refunds

async function refundRow(row, btn) {
  const remaining = (row.amount - row.refunded).toFixed(2);
  const input = prompt(`Refund ${row.payer} through PayPal.\nAmount (max ${money(remaining)}):`, remaining);
  if (input === null) return;
  const amount = Number(input);
  if (!(amount > 0) || amount > Number(remaining) + 0.001) return toast('Enter an amount up to the remaining total');
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const tx = await api(`/api/transactions/${row.id}/refund`, { userId: MERCHANT, amount: amount.toFixed(2), reason: 'Refunded from the ledger' });
    upsertTx(tx);
    toast(`Refunded ${money(amount)} to ${row.payer}`);
  } catch (err) {
    toast(err.message);
    btn.disabled = false;
    btn.textContent = 'Refund';
  }
}

// ------------------------------------------------------------------ ask your ledger

const SUGGESTIONS = [
  'Refunds this week',
  'Riskiest taps',
  'Over $20 today, biggest first',
  "Alice's payments",
  'NFC sticker sales this week',
  'Orders with banana bread',
];

async function ask(question) {
  const q = (question ?? $('ask').value).trim();
  if (!q) return;
  $('ask').value = q;
  $('ask-btn').disabled = true;
  $('explain').innerHTML = '<span class="thinking">✦ Reading your ledger…</span>';
  try {
    const r = await api('/api/ai/grid', { userId: MERCHANT, question: q, today: localDay() });
    grid.setFilterModel(Object.keys(r.filterModel).length ? r.filterModel : null);
    grid.applyColumnState({ state: r.sort, defaultState: { sort: null } });
    grid.setGridOption('quickFilterText', r.quickFilter || '');
    const n = displayedRows().length;
    $('explain').innerHTML = `<span class="src ${r.source}">${r.source === 'claude' ? '✦ Claude' : 'rules'}</span> ${esc(r.explanation)} <b>${n}</b> payment${n === 1 ? '' : 's'}.`;
  } catch (err) {
    $('explain').textContent = err.message;
  }
  $('ask-btn').disabled = false;
}

function resetView() {
  $('ask').value = '';
  grid.setFilterModel(null);
  grid.setGridOption('quickFilterText', '');
  grid.applyColumnState({ state: [{ colId: 'when', sort: 'desc' }], defaultState: { sort: null } });
  $('explain').textContent = '';
}

// ------------------------------------------------------------------ copilot

function renderChat() {
  $('chat').innerHTML = chat
    .map(
      (m) => `
      <div class="msg ${m.role}">
        <div class="bubble">${m.pending ? '<span class="dots"><i></i><i></i><i></i></span>' : markdownLite(m.content)}</div>
        ${(m.actions || [])
          .map(
            (a) => `
          <div class="action ${a.status}" data-tx="${esc(a.transactionId || '')}">
            <div><b>${a.kind === 'refund' ? '↩ Refund' : '↗ Payout'}</b> ${esc(a.summary)}</div>
            ${
              a.status === 'pending'
                ? `<div class="row"><button class="btn ghost" data-act="${a.id}" data-d="dismiss">Dismiss</button><button class="btn primary" data-act="${a.id}" data-d="approve">Approve</button></div>`
                : `<small class="muted">${a.status === 'approved' ? '✓ Sent via PayPal' : 'Dismissed'}</small>`
            }
          </div>`,
          )
          .join('')}
      </div>`,
    )
    .join('');
  $('chat').scrollTop = $('chat').scrollHeight;
}

async function askCopilot(text) {
  const q = (text ?? $('copilot-input').value).trim();
  if (!q) return;
  $('copilot-input').value = '';
  chat.push({ role: 'user', content: q });
  const pending = { role: 'assistant', content: '', pending: true };
  chat.push(pending);
  renderChat();
  try {
    const history = chat.filter((m) => !m.pending && !m.intro).map(({ role, content }) => ({ role, content }));
    const r = await api('/api/ai/copilot', { userId: MERCHANT, messages: history });
    Object.assign(pending, { content: r.reply, actions: r.actions || [], pending: false });
    for (const a of r.actions || []) {
      if (a.transactionId) {
        const node = flashRow(a.transactionId);
        node?.setSelected(true);
      }
    }
  } catch (err) {
    Object.assign(pending, { content: `Sorry: ${err.message}`, pending: false });
  }
  renderChat();
}

async function decide(id, decision) {
  try {
    const a = await api(`/api/actions/${id}/${decision}`, { userId: MERCHANT });
    for (const m of chat) for (const x of m.actions || []) if (x.id === id) Object.assign(x, a);
    if (decision === 'approve') {
      sounds.success();
      toast(`${a.kind === 'refund' ? 'Refund' : 'Payout'} sent through PayPal`);
    }
  } catch (err) {
    toast(err.message);
  }
  renderChat();
}

// ------------------------------------------------------------------ misc

let toastTimer;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

async function boot() {
  [config, merchant] = await Promise.all([api('/api/config'), api(`/api/users/${MERCHANT}`)]);
  $('merchant').innerHTML = `<span class="av big" style="background:${esc(merchant.color)}">${merchant.type === 'business' ? '☕' : esc(initials(merchant.name))}</span><div><b>${esc(merchant.name)}</b><small class="muted">${esc(merchant.handle)} · PayPal ${config.paypal.mode === 'sandbox' ? 'sandbox' : 'sim'}</small></div>`;
  $('env').insertAdjacentHTML(
    'afterbegin',
    `<span class="pill-env">AG Grid Community</span><span class="pill-env ${config.ai.enabled ? 'ai' : ''}">AI: ${config.ai.enabled ? esc(config.ai.model) : 'rules fallback'}</span>`,
  );
  const txs = await api(`/api/users/${MERCHANT}/activity?limit=500`);
  initGrid(txs.filter((t) => t.payeeId === MERCHANT).map(toRow));

  $('chips').innerHTML = SUGGESTIONS.map((s) => `<button class="chip" data-q="${esc(s)}">${esc(s)}</button>`).join('');
  $('copilot-chips').innerHTML = ['How did we do today?', 'Top sellers this week?', 'Refund the last payment']
    .map((s) => `<button class="chip" data-cq="${esc(s)}">${esc(s)}</button>`)
    .join('');
  chat.push({ role: 'assistant', intro: true, content: 'I read your PayPal sales. Refunds and payouts I suggest show up here for you to approve.' });
  renderChat();

  new Realtime({
    clientId: `dash_${Math.random().toString(36).slice(2, 8)}`,
    userId: MERCHANT,
    onStatus: (s) => ($('net').className = `net ${s === 'online' ? 'on' : ''}`),
    onMessage: (msg) => {
      if (msg.type === 'intent:completed' && msg.tx?.payeeId === MERCHANT) upsertTx(msg.tx, { isNew: true });
      if (msg.type === 'tx:update' && msg.tx?.payeeId === MERCHANT) upsertTx(msg.tx);
      if (msg.type === 'demo:reset') location.reload();
    },
  });
}

$('ask-form').addEventListener('submit', (e) => {
  e.preventDefault();
  ask();
});
$('reset').addEventListener('click', resetView);
$('copilot-form').addEventListener('submit', (e) => {
  e.preventDefault();
  askCopilot();
});
document.addEventListener('click', (e) => {
  const chip = e.target.closest('[data-q]');
  if (chip) return ask(chip.dataset.q);
  const cchip = e.target.closest('[data-cq]');
  if (cchip) return askCopilot(cchip.dataset.cq);
  const act = e.target.closest('[data-act]');
  if (act) return decide(act.dataset.act, act.dataset.d);
  const card = e.target.closest('.action[data-tx]');
  if (card?.dataset.tx) flashRow(card.dataset.tx)?.setSelected(true);
});

window.__ledger = { ask, resetView, get grid() { return grid; } };
boot().catch((err) => {
  document.body.insertAdjacentHTML('beforeend', `<p style="padding:20px">Failed to load ledger: ${esc(err.message)}</p>`);
});
