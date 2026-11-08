import { api, Realtime } from './net.js';
import { esc } from './ui.js';

const SCENARIOS = {
  cafe: ['alice', 'cafe'],
  p2p: ['alice', 'ben'],
  split: ['maya', 'alice'],
};

const $ = (id) => document.getElementById(id);
const phones = { A: $('phoneA'), B: $('phoneB') };
const frames = { A: $('frameA'), B: $('frameB') };
const sels = { A: $('selA'), B: $('selB') };

let users = [];

async function init() {
  const [config, list] = await Promise.all([api('/api/config'), api('/api/users')]);
  users = list;
  $('env').innerHTML = `
    <span class="pill">PayPal: ${config.paypal.mode === 'sandbox' ? 'Sandbox API' : 'simulated sandbox'}</span>
    <span class="pill ${config.ai.enabled ? 'ai' : ''}">AI: ${config.ai.enabled ? esc(config.ai.model) : 'rules fallback'}</span>`;
  for (const k of ['A', 'B']) {
    sels[k].innerHTML = users.map((u) => `<option value="${esc(u.id)}">${esc(u.name)}</option>`).join('');
    sels[k].addEventListener('change', () => load(k, sels[k].value));
  }
  const scn = new URLSearchParams(location.search).get('scenario') || 'cafe';
  scenario(scn);
  fit();
  new Realtime({ clientId: 'observer', observer: true, onMessage: onLog });
}

function scenario(name) {
  const [a, b] = SCENARIOS[name] || SCENARIOS.cafe;
  document.querySelectorAll('[data-scn]').forEach((el) => el.classList.toggle('on', el.dataset.scn === name));
  sels.A.value = a;
  sels.B.value = b;
  load('A', a);
  load('B', b);
}

function load(k, userId) {
  frames[k].src = `/?embed=1&as=${encodeURIComponent(userId)}&phone=${k}`;
}

function fit() {
  const h = window.innerHeight - 120;
  const scale = Math.min(1, h / 812);
  document.documentElement.style.setProperty('--scale', scale.toFixed(3));
}

// ---- bump

let bumping = false;
function bump() {
  if (bumping) return;
  bumping = true;
  phones.A.classList.add('bumpA');
  phones.B.classList.add('bumpB');
  // impact frame of the CSS animation
  setTimeout(() => {
    const peak = 14 + Math.round(Math.random() * 60) / 10;
    // Real phones never report at exactly the same instant: add sensor + network jitter.
    const j = Math.round(Math.random() * 90);
    setTimeout(() => frames.A.contentWindow.postMessage({ type: 'payd:sim-tap', peak }, '*'), j);
    setTimeout(() => frames.B.contentWindow.postMessage({ type: 'payd:sim-tap', peak: Math.round((peak - 1.3) * 10) / 10 }, '*'), 90 - j);
    $('spark').classList.add('on');
  }, 210);
  setTimeout(() => {
    phones.A.classList.remove('bumpA');
    phones.B.classList.remove('bumpB');
    $('spark').classList.remove('on');
    bumping = false;
  }, 620);
}

// drag a phone onto the other
function draggable(k) {
  const el = phones[k];
  const handle = el.querySelector('.handle');
  let start = null;
  handle.addEventListener('pointerdown', (e) => {
    if (e.target.tagName === 'SELECT') return;
    start = { x: e.clientX, y: e.clientY };
    handle.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
  });
  handle.addEventListener('pointermove', (e) => {
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    el.style.transform = `translate(${dx}px, ${dy}px) scale(var(--scale))`;
    const other = phones[k === 'A' ? 'B' : 'A'].getBoundingClientRect();
    const me = el.getBoundingClientRect();
    const overlap = Math.max(0, Math.min(me.right, other.right) - Math.max(me.left, other.left));
    if (overlap > 30) {
      start = null;
      el.classList.remove('dragging');
      el.style.transform = '';
      bump();
    }
  });
  const end = () => {
    start = null;
    el.classList.remove('dragging');
    el.style.transform = '';
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

// ---- log

function onLog(msg) {
  if (msg.type !== 'log') return;
  const t = new Date(msg.at).toLocaleTimeString([], { hour12: false });
  let icon = '•';
  let text = '';
  let cls = msg.kind;
  switch (msg.kind) {
    case 'tap':
      icon = '👆';
      text = `<b>${esc(msg.user)}</b> tapped · ${esc(msg.role)} · ${esc(msg.method)}${msg.peak ? ` · ${msg.peak} m/s²` : ''} · clock skew ${msg.skewMs} ms`;
      break;
    case 'match':
      icon = '🤝';
      text = `Matched <b>${esc(name(msg.payer))}</b> → <b>${esc(name(msg.payee))}</b> · Δt ${msg.dt} ms${msg.distance != null ? ` · ${Math.round(msg.distance)} m` : ''}${msg.ambiguous ? ' · ambiguous' : ''}`;
      break;
    case 'intent':
      icon = '💳';
      text = `Payment intent ${msg.amount ? '$' + esc(msg.amount) : '(amount pending)'} · ${esc(msg.method)}`;
      break;
    case 'guard':
      icon = '🛡';
      text = `Payd Guard: <b>${esc(msg.level)}</b> (${msg.score}) · ${msg.source === 'claude' ? 'Claude' : 'rules'}`;
      break;
    case 'paypal':
      icon = 'Ⓟ';
      text = `PayPal <code>${esc(msg.method)} ${esc(msg.path)}</code> → <b>${msg.status}</b> · ${msg.ms} ms <span class="dim">${esc(msg.mode)}</span>`;
      break;
    case 'ai':
      icon = '✦';
      text = `Claude <b>${esc(msg.feature)}</b> · ${esc(msg.model)} · ${(msg.ms / 1000).toFixed(1)} s${msg.ok ? '' : ` · <span class="bad">${esc(msg.error)}</span>`}`;
      break;
    case 'completed':
      icon = '✅';
      text = `Captured <b>$${esc(msg.amount)}</b> · capture <code>${esc(msg.captureId || '')}</code>`;
      break;
    case 'action':
      icon = '✔';
      text = `Merchant approved ${esc(msg.actionKind)}: ${esc(msg.summary)}`;
      break;
    default:
      text = esc(JSON.stringify(msg));
  }
  const row = document.createElement('div');
  row.className = `entry ${cls}`;
  row.innerHTML = `<span class="time">${t}</span><span class="icon">${icon}</span><span class="text">${text}</span>`;
  const log = $('log');
  log.prepend(row);
  while (log.children.length > 80) log.lastChild.remove();
}

function name(id) {
  return users.find((u) => u.id === id)?.name || id;
}

// ---- wire up

$('bump').addEventListener('click', bump);
$('clear').addEventListener('click', () => ($('log').innerHTML = ''));
document.querySelectorAll('[data-scn]').forEach((b) => b.addEventListener('click', () => scenario(b.dataset.scn)));
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.target.closest('input,select,textarea')) {
    e.preventDefault();
    bump();
  }
});
window.addEventListener('resize', fit);
draggable('A');
draggable('B');
window.__sim = { bump, scenario };
init();
