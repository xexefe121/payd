import { api, Realtime } from './net.js';
import { TapSensor, getGeo } from './sensor.js';
import { esc, money, avatar, timeAgo, toast, sounds, haptic, unlockAudio, markdownLite, cents } from './ui.js';
import { renderPayPalButtons } from './paypal-buttons.js';
import { SAMPLE_RECEIPT } from './sample-receipt.js';

const qs = new URLSearchParams(location.search);
const EMBED = qs.has('embed');
const $app = document.getElementById('app');
const $sheet = document.getElementById('sheet');

const S = {
  config: null,
  users: [],
  user: null,
  tab: 'home',
  mode: 'pay',
  payAmount: '',
  recvAmount: '',
  recvNote: '',
  armedMode: 'idle',
  cart: [],
  charging: null,
  tapState: 'idle',
  sensor: 'off',
  geo: null,
  intent: null,
  role: null,
  sheetAmount: '',
  paying: false,
  needsApproval: false,
  ack: false,
  success: null,
  activity: [],
  detail: null,
  split: null,
  copilot: [],
  copilotBusy: false,
  aiReply: null,
  aiBusy: false,
  online: false,
  link: null,
  keypad: null,
  showQr: false,
  onboardingCreate: false,
};

// ------------------------------------------------------------------ boot

// One id per device/tab. Simulator iframes share sessionStorage, so they get a fresh id each.
const freshId = () => `c_${Math.random().toString(36).slice(2, 10)}`;
const clientId = EMBED ? `${freshId()}_${qs.get('phone') || ''}` : sessionStorage.getItem('payd.client') || freshId();
if (!EMBED) sessionStorage.setItem('payd.client', clientId);
if (EMBED) document.documentElement.classList.add('embed');

let rt;
let sensor;

async function boot() {
  const linkMatch = location.pathname.match(/^\/t\/([\w-]+)/);
  if (linkMatch) S.link = { userId: linkMatch[1], src: qs.get('src') || 'link', data: null };

  [S.config, S.users] = await Promise.all([api('/api/config'), api('/api/users')]);
  const wanted = qs.get('as') || (!EMBED && localStorage.getItem('payd.user'));
  S.user = S.users.find((u) => u.id === wanted) || null;
  if (S.user) applyUserDefaults();

  rt = new Realtime({
    clientId,
    userId: S.user?.id,
    onMessage,
    onStatus: (s) => {
      S.online = s === 'online';
      if (S.online) syncArm(true);
      renderHeaderStatus();
    },
  });

  sensor = new TapSensor({ onTap: ({ peak }) => doTap('bump', peak) });
  if (EMBED) S.sensor = 'sim';
  else if (!TapSensor.supported() || !('ontouchstart' in window)) S.sensor = 'unsupported';
  else if (!TapSensor.needsPermission()) {
    S.sensor = await sensor.start();
  }

  window.addEventListener('message', (e) => {
    if (e.data?.type === 'payd:sim-tap') doTap('sim', e.data.peak);
  });
  window.addEventListener('keydown', (e) => {
    if (e.target.closest('input,textarea')) return;
    if (e.key === 't' || e.key === 'T') doTap('key');
  });

  if (S.link && S.user) loadLink();
  if (S.user) refreshActivity();
  render();
}

function applyUserDefaults() {
  S.tab = S.user.type === 'business' ? 'terminal' : 'home';
  S.mode = 'pay';
  S.copilot = [
    {
      role: 'assistant',
      content: `Hi! I'm Payd Copilot. I can read your PayPal sales, ring up orders, and prepare refunds or payouts for you to approve.`,
    },
  ];
}

function selectUser(id) {
  S.user = S.users.find((u) => u.id === id);
  if (!EMBED) localStorage.setItem('payd.user', id);
  applyUserDefaults();
  rt.setUser(id);
  S.cart = [];
  S.charging = null;
  S.split = null;
  refreshActivity();
  if (S.link) loadLink();
  syncArm(true);
  render();
}

// ------------------------------------------------------------------ arming & tapping

function desiredArm() {
  if (!S.user || S.link) return { mode: 'idle' };
  if (S.user.type === 'business') {
    if (S.charging) return { mode: 'receive', amount: S.charging.amount, items: S.charging.items, note: S.charging.note };
    return { mode: 'idle' };
  }
  if (S.split?.live && S.split.live.shares.some((s) => s.status !== 'paid')) {
    return { mode: 'receive', splitId: S.split.live.id };
  }
  if (S.mode === 'receive') return { mode: 'receive', amount: S.recvAmount || null, note: S.recvNote };
  return { mode: 'pay', amount: S.payAmount || null };
}

let lastArm = '';
function syncArm(force = false) {
  if (!rt) return;
  const arm = desiredArm();
  const key = JSON.stringify(arm);
  if (!force && key === lastArm) return;
  lastArm = key;
  S.armedMode = arm.mode;
  rt.send({ type: 'arm', ...arm });
}

async function doTap(method, peak) {
  if (!S.user || S.intent || S.success) return;
  syncArm();
  if (S.armedMode === 'idle') {
    toast(S.user.type === 'business' ? 'Ring up a sale first, then tap' : 'Choose Pay or Get paid first');
    return;
  }
  unlockAudio();
  sounds.tap();
  haptic(25);
  S.tapState = 'tapping';
  renderStage();
  rt.send({ type: 'tap', t: rt.serverNow(), geo: S.geo, method, peak });
  clearTimeout(S.tapTimer);
  S.tapTimer = setTimeout(() => {
    if (S.tapState !== 'idle' && !S.intent) {
      S.tapState = 'idle';
      renderStage();
    }
  }, 4000);
}

async function enableSensor() {
  unlockAudio();
  const r = await sensor.start();
  S.sensor = r;
  if (r === 'on') {
    toast('Tap sensor on — knock phones together');
    S.geo = await getGeo();
    setInterval(async () => (S.geo = (await getGeo()) || S.geo), 60000);
  } else toast(r === 'denied' ? 'Motion access denied — use QR or link instead' : 'Motion sensor not available');
  render();
}

// ------------------------------------------------------------------ realtime events

function onMessage(msg) {
  switch (msg.type) {
    case 'welcome':
      if (msg.user) S.user = { ...S.user, ...msg.user };
      break;
    case 'armed':
      S.armedMode = msg.mode;
      break;
    case 'tap:waiting':
      S.tapState = 'waiting';
      renderStage();
      break;
    case 'tap:timeout':
    case 'tap:ignored':
      S.tapState = 'idle';
      renderStage();
      if (msg.type === 'tap:timeout') toast('No phone found — tap again');
      break;
    case 'tap:error':
    case 'error':
      S.tapState = 'idle';
      toast(msg.error, 'bad');
      renderStage();
      break;
    case 'intent:new':
      S.tapState = 'idle';
      S.intent = msg.intent;
      S.role = msg.intent.payer.id === S.user.id ? 'payer' : 'payee';
      S.sheetAmount = '';
      S.paying = false;
      S.needsApproval = false;
      S.ack = false;
      sounds.tap();
      haptic([20, 40, 20]);
      renderStage();
      renderSheet();
      break;
    case 'intent:update':
      if (S.intent?.id !== msg.intent.id) return;
      S.intent = msg.intent;
      if (msg.intent.status === 'declined') {
        toast(S.role === 'payer' ? 'Payment cancelled' : `${msg.intent.payer.name.split(' ')[0]} cancelled`);
        closeIntent();
        return;
      }
      renderSheet();
      break;
    case 'intent:completed':
      onCompleted(msg.intent, msg.tx);
      break;
    case 'terminal:reset':
      if (S.user.type === 'business') {
        S.charging = null;
        S.cart = [];
        S.aiReply = null;
      } else if (!S.split?.live) {
        S.recvAmount = '';
        S.recvNote = '';
      }
      syncArm();
      break;
    case 'terminal:load':
      S.cart = msg.items;
      S.tab = 'terminal';
      S.aiReply = { text: `Copilot rang up ${money(msg.total)}${msg.note ? ' — ' + msg.note : ''}. Tap Charge when ready.`, source: 'claude' };
      toast(`Copilot rang up ${money(msg.total)}`);
      render();
      break;
    case 'tx:update': {
      const i = S.activity.findIndex((t) => t.id === msg.tx.id);
      if (i >= 0) S.activity[i] = msg.tx;
      if (S.detail?.id === msg.tx.id) S.detail = msg.tx;
      if (msg.toast) toast(msg.toast, 'good');
      render();
      break;
    }
    case 'split:update':
      if (S.split?.live?.id === msg.split.id) {
        S.split.live = msg.split;
        if (msg.split.shares.every((s) => s.status === 'paid')) {
          toast('Everyone has paid 🎉', 'good');
        }
        syncArm();
        render();
      }
      break;
    case 'demo:reset':
      location.reload();
      break;
  }
}

function onCompleted(intent, tx) {
  const role = intent.payer.id === S.user.id ? 'payer' : 'payee';
  S.intent = null;
  S.success = { intent, tx, role };
  sounds.success();
  haptic([30, 60, 90]);
  if (role === 'payee' && S.user.type === 'business') {
    S.charging = null;
    S.cart = [];
    S.aiReply = null;
  }
  if (role === 'payer') S.payAmount = '';
  if (S.link) {
    S.link = null;
    history.replaceState(null, '', EMBED ? `/?embed=1&as=${S.user.id}&phone=${qs.get('phone') || ''}` : '/');
  }
  refreshActivity();
  syncArm();
  render();
  renderSheet();
  clearTimeout(S.successTimer);
  S.successTimer = setTimeout(() => {
    if (S.success?.tx?.id === tx.id) {
      S.success = null;
      renderSheet();
    }
  }, EMBED ? 5200 : 9000);
}

function closeIntent() {
  S.intent = null;
  S.paying = false;
  S.needsApproval = false;
  renderSheet();
  renderStage();
}

async function refreshActivity() {
  if (!S.user) return;
  try {
    S.activity = await api(`/api/users/${S.user.id}/activity`);
    if (['activity', 'sales', 'home'].includes(S.tab)) render();
  } catch {}
}

// ------------------------------------------------------------------ payments

async function pay() {
  const intent = S.intent;
  if (!intent || S.paying) return;
  S.paying = true;
  renderSheet();
  try {
    const r = await api(`/api/intents/${intent.id}/pay`, { userId: S.user.id, override: S.ack });
    if (r.status === 'needs_approval') {
      S.paying = false;
      S.needsApproval = true;
      if (r.warning) toast('Saved PayPal needs re-approval', 'bad');
      renderSheet();
      await renderPayPalButtons({
        container: '#pp-buttons',
        clientId: S.config.paypal.clientId,
        currency: S.config.currency,
        createOrder: async () => (await api(`/api/intents/${intent.id}/order`, { userId: S.user.id })).id,
        onApprove: async (data) => {
          S.paying = true;
          renderSheet();
          await api(`/api/intents/${intent.id}/capture`, { userId: S.user.id, orderId: data.orderID });
        },
        onError: (err) => {
          S.paying = false;
          toast(err.message || 'PayPal error', 'bad');
          renderSheet();
        },
      });
    }
  } catch (err) {
    S.paying = false;
    sounds.error();
    toast(err.message, 'bad');
    renderSheet();
  }
}

async function submitSheetAmount() {
  if (!S.sheetAmount || Number(S.sheetAmount) <= 0) return toast('Enter an amount');
  try {
    S.intent = await api(`/api/intents/${S.intent.id}/amount`, { userId: S.user.id, amount: S.sheetAmount });
    renderSheet();
  } catch (err) {
    toast(err.message, 'bad');
  }
}

function decline() {
  if (S.intent) rt.send({ type: 'decline', intentId: S.intent.id });
  closeIntent();
}

// ------------------------------------------------------------------ terminal (business)

function cartTotal(items = S.cart) {
  return (items.reduce((s, i) => s + cents(i.unitPrice) * i.qty, 0) / 100).toFixed(2);
}

function addToCart(sku, delta = 1) {
  const p = (S.user.catalog || []).find((x) => x.sku === sku) || S.cart.find((x) => x.sku === sku);
  if (!p) return;
  const line = S.cart.find((x) => x.sku === sku);
  if (line) line.qty += delta;
  else if (delta > 0) S.cart.push({ sku: p.sku, name: p.name, emoji: p.emoji, unitPrice: p.price || p.unitPrice, qty: 1 });
  S.cart = S.cart.filter((x) => x.qty > 0);
  render();
}

async function askCart() {
  const input = document.getElementById('ask-input');
  const text = input?.value.trim();
  if (!text) return toast('Say or type an order');
  S.aiBusy = true;
  render();
  try {
    const r = await api('/api/ai/cart', { userId: S.user.id, text });
    for (const it of r.items) {
      const line = S.cart.find((x) => x.sku === it.sku);
      if (line) line.qty += it.qty;
      else S.cart.push({ ...it });
    }
    S.aiReply = {
      text: r.reply + (r.unmatched?.length ? ` (Not on menu: ${r.unmatched.join(', ')})` : ''),
      source: r.source,
    };
    if (input) input.value = '';
  } catch (err) {
    toast(err.message, 'bad');
  }
  S.aiBusy = false;
  render();
}

function startCharge(items = S.cart, note = '') {
  const amount = cartTotal(items);
  if (Number(amount) <= 0) return toast('Add something to the cart');
  S.charging = { amount, items: items.map((i) => ({ ...i })), note };
  syncArm();
  render();
}

function cancelCharge() {
  S.charging = null;
  syncArm();
  render();
}

let recognition;
function listen() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return toast('Voice input not supported here — type instead');
  if (recognition) {
    recognition.stop();
    return;
  }
  recognition = new SR();
  recognition.lang = 'en-US';
  recognition.interimResults = true;
  const input = document.getElementById('ask-input');
  document.querySelector('[data-action="mic"]')?.classList.add('live');
  recognition.onresult = (e) => {
    input.value = [...e.results].map((r) => r[0].transcript).join(' ');
  };
  recognition.onend = () => {
    recognition = null;
    document.querySelector('[data-action="mic"]')?.classList.remove('live');
    if (input.value.trim()) askCart();
  };
  recognition.start();
}

// ------------------------------------------------------------------ split

async function scanReceipt(file) {
  S.split = { parsing: true };
  render();
  try {
    const dataUrl = await downscale(file);
    const r = await api('/api/ai/receipt', { image: dataUrl });
    loadDraft(r);
  } catch (err) {
    S.split = null;
    toast(err.code === 'AI_OFFLINE' ? 'Receipt AI needs an Anthropic key — try the sample' : err.message, 'bad');
    render();
  }
}

async function sampleReceipt() {
  S.split = { parsing: true };
  render();
  try {
    const dataUrl = await svgToPng('/img/sample-receipt.svg');
    const r = await api('/api/ai/receipt', { image: dataUrl });
    loadDraft(r);
  } catch (err) {
    loadDraft({ ...SAMPLE_RECEIPT, source: 'sample' });
    if (err.code === 'AI_OFFLINE') toast('Claude offline — loaded sample data');
  }
}

function loadDraft(r) {
  if (!r.items?.length || !r.total) {
    S.split = null;
    toast("Couldn't read that receipt — try again", 'bad');
    return render();
  }
  S.split = { draft: r, people: 3 };
  render();
}

async function startSplit() {
  const d = S.split.draft;
  try {
    const live = await api('/api/splits', {
      hostId: S.user.id,
      title: d.merchant || 'Group bill',
      merchant: d.merchant,
      items: d.items,
      total: d.total,
      people: S.split.people,
    });
    S.split = { live };
    syncArm();
    render();
  } catch (err) {
    toast(err.message, 'bad');
  }
}

function endSplit() {
  S.split = null;
  syncArm();
  render();
}

function downscale(file, max = 1600) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', 0.85));
      URL.revokeObjectURL(img.src);
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

function svgToPng(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth * 2 || 760;
      c.height = img.naturalHeight * 2 || 1400;
      const g = c.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, c.width, c.height);
      g.drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = reject;
    img.src = url;
  });
}

// ------------------------------------------------------------------ copilot

async function askCopilot(text) {
  const input = document.getElementById('copilot-input');
  const q = (text || input?.value || '').trim();
  if (!q || S.copilotBusy) return;
  S.copilot.push({ role: 'user', content: q });
  if (input) input.value = '';
  S.copilotBusy = true;
  render();
  scrollChat();
  try {
    const history = S.copilot.filter((m, i) => !(i === 0 && m.role === 'assistant')).map(({ role, content }) => ({ role, content }));
    const r = await api('/api/ai/copilot', { userId: S.user.id, messages: history });
    S.copilot.push({ role: 'assistant', content: r.reply, actions: r.actions || [], source: r.source });
  } catch (err) {
    S.copilot.push({ role: 'assistant', content: `Sorry — ${err.message}`, actions: [] });
  }
  S.copilotBusy = false;
  render();
  scrollChat();
}

function scrollChat() {
  requestAnimationFrame(() => {
    const el = document.querySelector('.chat');
    if (el) el.scrollTop = el.scrollHeight;
  });
}

async function decideAction(id, decision) {
  try {
    const a = await api(`/api/actions/${id}/${decision}`, { userId: S.user.id });
    for (const m of S.copilot) for (const x of m.actions || []) if (x.id === id) Object.assign(x, a);
    if (decision === 'approve') {
      sounds.success();
      toast(`${a.kind === 'refund' ? 'Refund' : 'Payout'} sent via PayPal`, 'good');
    }
    refreshActivity();
  } catch (err) {
    toast(err.message, 'bad');
  }
  render();
}

// ------------------------------------------------------------------ link landing (NFC sticker / QR)

async function loadLink() {
  try {
    S.link.data = await api(`/api/terminal/${S.link.userId}`);
  } catch (err) {
    S.link.data = { error: err.message };
  }
  render();
}

async function payLink() {
  try {
    await api(`/api/terminal/${S.link.userId}/pay`, {
      payerId: S.user.id,
      method: S.link.src,
      amount: S.link.data?.armed?.amount || S.link.data?.split ? undefined : S.sheetAmount || undefined,
    });
  } catch (err) {
    toast(err.message, 'bad');
  }
}

// ------------------------------------------------------------------ rendering

function render() {
  const active = document.activeElement;
  const focusId = active?.id;
  const sel = active && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;

  if (!S.config) {
    $app.innerHTML = `<div class="splash"><div class="logo-mark big">P</div></div>`;
    return;
  }
  if (!S.user) {
    $app.innerHTML = viewOnboarding();
  } else {
    $app.innerHTML = `
      ${viewHeader()}
      <main class="content">${S.link ? viewLink() : viewTab()}</main>
      ${S.link ? '' : viewNav()}`;
  }
  if (focusId) {
    const el = document.getElementById(focusId);
    if (el) {
      el.focus();
      if (sel && 'setSelectionRange' in el) {
        try {
          el.setSelectionRange(sel[0], sel[1]);
        } catch {}
      }
    }
  }
  renderHeaderStatus();
}

function renderHeaderStatus() {
  const dot = document.getElementById('net-dot');
  if (dot) dot.className = `net-dot ${S.online ? 'on' : ''}`;
}

function renderStage() {
  const el = document.getElementById('stage');
  if (el) el.outerHTML = viewStage();
}

function viewOnboarding() {
  const people = S.users.filter((u) => u.type === 'personal');
  const biz = S.users.filter((u) => u.type === 'business');
  const row = (u) => `
    <button class="profile-row" data-action="pick-user" data-id="${esc(u.id)}">
      ${avatar(u, 44)}
      <span><b>${esc(u.name)}</b><small>${esc(u.handle)} · ${u.type === 'business' ? 'Business terminal' : 'Personal'}</small></span>
      <span class="chev">›</span>
    </button>`;
  return `
    <div class="onboard">
      <div class="hero">
        <div class="logo-mark big">P</div>
        <h1>Payd</h1>
        <p>Tap phones. Get paid.<br><span class="muted">Any iPhone or Android with PayPal — person to person or at the counter.</span></p>
      </div>
      ${S.link ? `<div class="notice">Choose who you are to pay this terminal.</div>` : ''}
      <h3 class="section">People</h3>
      <div class="list">${people.map(row).join('')}</div>
      <h3 class="section">Businesses</h3>
      <div class="list">${biz.map(row).join('')}</div>
      ${
        S.onboardingCreate
          ? `<form class="card form" data-form="create-user">
              <label>Name<input id="new-name" required minlength="2" placeholder="Your name or business"></label>
              <label>PayPal sandbox email <small class="muted">(optional — where you get paid)</small><input id="new-email" type="email" placeholder="you@personal.example.com"></label>
              <div class="seg small"><label><input type="radio" name="new-type" value="personal" checked> Personal</label><label><input type="radio" name="new-type" value="business"> Business</label></div>
              <button class="btn primary" type="submit">Create profile</button>
            </form>`
          : `<button class="btn ghost wide" data-action="show-create">+ Create a new profile</button>`
      }
      <p class="fine center">Hackathon demo · PayPal ${esc(S.config.paypal.mode === 'sandbox' ? 'Sandbox' : 'sandbox simulated')} · ${S.config.ai.enabled ? 'Claude' : 'rules'} AI</p>
    </div>`;
}

function viewHeader() {
  const u = S.user;
  const pp = S.config.paypal.mode === 'sandbox' ? 'sandbox' : 'sim';
  return `
    <header class="top">
      <button class="me-chip" data-action="tab" data-tab="me">${avatar(u, 34)}<span><b>${esc(u.name)}</b><small>${esc(u.handle)}</small></span></button>
      <div class="badges">
        <span class="badge pp" title="PayPal mode">PayPal ${pp}</span>
        <span class="badge ai ${S.config.ai.enabled ? 'on' : ''}" title="AI">${S.config.ai.enabled ? '✦ Claude' : '✦ Rules'}</span>
        <span id="net-dot" class="net-dot"></span>
      </div>
    </header>`;
}

function viewNav() {
  const tabs =
    S.user.type === 'business'
      ? [
          ['terminal', 'Terminal', '◉'],
          ['sales', 'Sales', '▤'],
          ['copilot', 'Copilot', '✦'],
          ['me', 'Me', '☺'],
        ]
      : [
          ['home', 'Tap', '◉'],
          ['split', 'Split', '⧉'],
          ['activity', 'Activity', '▤'],
          ['me', 'Me', '☺'],
        ];
  return `<nav class="tabs">${tabs
    .map(([id, label, icon]) => `<button class="${S.tab === id ? 'active' : ''}" data-action="tab" data-tab="${id}"><i>${icon}</i>${label}</button>`)
    .join('')}</nav>`;
}

function viewTab() {
  switch (S.tab) {
    case 'home':
      return viewHome();
    case 'split':
      return viewSplit();
    case 'activity':
    case 'sales':
      return viewActivity();
    case 'terminal':
      return viewTerminal();
    case 'copilot':
      return viewCopilot();
    case 'me':
      return viewMe();
  }
  return '';
}

function sensorChip() {
  if (S.sensor === 'sim') return `<span class="chip">Simulator · drag phones together</span>`;
  if (S.sensor === 'on') return `<span class="chip good">● Tap sensor on</span>`;
  if (S.sensor === 'unsupported') return `<span class="chip">No motion sensor · press <kbd>T</kbd> or use QR</span>`;
  if (S.sensor === 'denied') return `<span class="chip bad">Motion blocked · use QR/link</span>`;
  return `<button class="chip action" data-action="enable-sensor">Enable tap to pay</button>`;
}

function viewStage() {
  const recv = S.armedMode === 'receive' || (S.user.type === 'personal' && S.mode === 'receive');
  let title;
  let sub;
  if (S.tapState === 'tapping') {
    title = 'Tapping…';
    sub = 'Hold phones together';
  } else if (S.tapState === 'waiting') {
    title = 'Finding phone…';
    sub = 'Matching the tap on both phones';
  } else if (S.user.type === 'business') {
    title = S.charging ? money(S.charging.amount) : 'Ring up a sale';
    sub = S.charging ? 'Customer: tap your phone here' : 'Add items or ask Payd';
  } else if (S.split?.live) {
    const next = S.split.live.shares.find((s) => s.status !== 'paid');
    title = next ? money(next.amount) : 'All paid';
    sub = next ? 'Friends: tap your phone on mine' : 'Everyone settled up';
  } else if (recv) {
    title = S.recvAmount ? money(S.recvAmount) : 'Ready to receive';
    sub = S.recvAmount ? 'Tap their phone to request' : 'They choose the amount';
  } else {
    title = S.payAmount ? `Send ${money(S.payAmount)}` : 'Ready to pay';
    sub = 'Hold near their phone or terminal';
  }
  return `
    <div id="stage" class="stage ${recv ? 'recv' : 'pay'} ${S.tapState}" data-action="stage-tap">
      <div class="rings"><span></span><span></span><span></span></div>
      <div class="phone-glyph">${recv ? '⤓' : '⤒'}</div>
      <div class="stage-text"><div class="stage-title">${esc(title)}</div><div class="stage-sub">${esc(sub)}</div></div>
    </div>`;
}

function keypad(target, value) {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫'];
  return `
    <div class="amount-entry">
      <div class="amount-display ${value ? '' : 'empty'}">${value ? '$' + esc(value) : '$0'}</div>
      <div class="keypad">${keys.map((k) => `<button data-action="key" data-target="${target}" data-k="${k}">${k}</button>`).join('')}</div>
    </div>`;
}

function viewHome() {
  const recv = S.mode === 'receive';
  return `
    <div class="seg" role="tablist">
      <button class="${!recv ? 'on' : ''}" data-action="mode" data-mode="pay">Pay</button>
      <button class="${recv ? 'on' : ''}" data-action="mode" data-mode="receive">Get paid</button>
    </div>
    ${viewStage()}
    <div class="center">${sensorChip()}</div>
    ${
      recv
        ? `${keypad('recv', S.recvAmount)}
           <input id="recv-note" class="input" placeholder="What's it for? (optional)" value="${esc(S.recvNote)}" maxlength="80">
           <div class="row gap">
             <button class="btn ghost" data-action="toggle-qr">${S.showQr ? 'Hide' : 'Show'} QR</button>
             ${S.recvAmount ? `<button class="btn ghost" data-action="clear-recv">Clear</button>` : ''}
           </div>
           ${S.showQr ? qrBlock() : ''}`
        : `<div class="row gap center">
             ${
               S.payAmount
                 ? `<span class="chip">Sending ${money(S.payAmount)} <button class="x" data-action="clear-pay">✕</button></span>`
                 : `<button class="btn ghost" data-action="keypad" data-target="pay">Send a set amount</button>`
             }
           </div>
           ${S.keypad === 'pay' ? keypad('pay', S.payAmount) + `<button class="btn primary wide" data-action="keypad-done">Done</button>` : ''}`
    }
    <h3 class="section">Recent</h3>
    ${activityList(S.activity.slice(0, 4))}
  `;
}

function qrBlock() {
  const url = `${location.origin}/t/${S.user.id}?src=qr`;
  return `<div class="qr card"><img src="/api/qr?data=${encodeURIComponent(url)}" alt="Pay me QR"><small>Scan to pay ${esc(S.user.name)} — no app needed</small></div>`;
}

function activityList(items) {
  if (!items.length) return `<p class="muted center pad">No payments yet. Tap a phone to start.</p>`;
  return `<div class="list">${items
    .map((t) => {
      const other = t.direction === 'in' ? t.payer || { name: t.payerLabel } : t.payee;
      const sign = t.direction === 'in' ? '+' : '−';
      const status = t.status === 'refunded' ? 'Refunded' : t.status === 'partially_refunded' ? 'Part refunded' : '';
      const desc = t.note || (t.items?.length ? t.items.map((i) => `${i.qty}× ${i.name}`).join(', ') : methodLabel(t.method));
      return `
        <button class="tx-row" data-action="tx" data-id="${esc(t.id)}">
          ${avatar(other, 40)}
          <span class="tx-main"><b>${esc(other?.name || 'Customer')}</b><small>${esc(desc)}</small></span>
          <span class="tx-amt ${t.direction}"><b>${sign}${money(t.amount)}</b><small>${status || timeAgo(t.createdAt)}</small></span>
        </button>`;
    })
    .join('')}</div>`;
}

function methodLabel(m) {
  return { bump: 'Phone tap', sim: 'Phone tap (sim)', 'nfc-tag': 'NFC sticker', qr: 'QR code', link: 'Pay link', key: 'Tap' }[m] || 'Tap';
}

function viewActivity() {
  const isBiz = S.user.type === 'business';
  let header = '';
  if (isBiz) {
    const today = S.activity.filter((t) => t.direction === 'in' && Date.now() - t.createdAt < 86400000 && t.status !== 'refunded');
    const total = today.reduce((s, t) => s + cents(t.amount) - cents(t.refundedAmount || 0), 0);
    header = `
      <div class="tiles">
        <div class="tile"><small>Today</small><b>${money(total / 100)}</b></div>
        <div class="tile"><small>Taps</small><b>${today.length}</b></div>
        <div class="tile"><small>Avg ticket</small><b>${money(today.length ? total / today.length / 100 : 0)}</b></div>
      </div>`;
  }
  if (isBiz) header += `<a class="btn ghost wide center" href="/dashboard?as=${esc(S.user.id)}" target="_blank" rel="noopener">Open live ledger (AG Grid) ↗</a>`;
  return `${header}<h3 class="section">${isBiz ? 'Payments received' : 'Activity'}</h3>${activityList(S.activity)}`;
}

function viewTerminal() {
  if (S.charging) {
    const url = `${location.origin}/t/${S.user.id}?src=qr`;
    return `
      ${viewStage()}
      <div class="charge-items card">${S.charging.items
        .map((i) => `<div class="line"><span>${esc(i.emoji || '')} ${i.qty}× ${esc(i.name)}</span><span>${money(cents(i.unitPrice) * i.qty / 100)}</span></div>`)
        .join('')}</div>
      <div class="qr card small"><img src="/api/qr?data=${encodeURIComponent(url)}" alt="QR"><small>No tap? Scan to pay</small></div>
      <button class="btn ghost wide" data-action="cancel-charge">Cancel sale</button>`;
  }
  const catalog = (S.user.catalog || [])
    .map(
      (p) => `
      <button class="product" data-action="add" data-sku="${esc(p.sku)}">
        <span class="emoji">${esc(p.emoji || '•')}</span><b>${esc(p.name)}</b><small>${money(p.price)}</small>
      </button>`,
    )
    .join('');
  const lines = S.cart
    .map(
      (i) => `
      <div class="line">
        <span>${esc(i.emoji || '')} ${esc(i.name)}</span>
        <span class="qty"><button data-action="dec" data-sku="${esc(i.sku)}">−</button>${i.qty}<button data-action="inc" data-sku="${esc(i.sku)}">+</button></span>
        <span>${money(cents(i.unitPrice) * i.qty / 100)}</span>
      </div>`,
    )
    .join('');
  return `
    <div class="ask">
      <input id="ask-input" class="input" placeholder='Try "two flat whites, one oat, and a banana bread"' autocomplete="off">
      <button class="icon-btn" data-action="mic" title="Speak the order">🎙</button>
      <button class="btn primary" data-action="ask" ${S.aiBusy ? 'disabled' : ''}>${S.aiBusy ? '…' : 'Ring up'}</button>
    </div>
    ${S.aiReply ? `<div class="ai-bubble"><span class="spark">✦</span> ${esc(S.aiReply.text)} <small class="muted">${S.aiReply.source === 'claude' ? 'Claude' : 'rules'}</small></div>` : ''}
    <div class="catalog">${catalog}</div>
    <div class="cart card">
      ${lines || `<p class="muted center">Cart is empty</p>`}
      <div class="line total"><span>Total</span><span></span><span>${money(cartTotal())}</span></div>
      <div class="row gap">
        <button class="btn ghost" data-action="keypad" data-target="custom">Custom $</button>
        <button class="btn primary grow" data-action="charge" ${S.cart.length ? '' : 'disabled'}>Charge ${money(cartTotal())}</button>
      </div>
      ${S.keypad === 'custom' ? keypad('custom', S.customAmount || '') + `<button class="btn primary wide" data-action="charge-custom">Charge custom amount</button>` : ''}
    </div>`;
}

function viewSplit() {
  const sp = S.split;
  if (!sp) {
    return `
      <div class="card hero-card">
        <div class="hero-icon">🧾</div>
        <h2>Snap &amp; Split</h2>
        <p class="muted">Photo the bill. Claude reads every line, works out each share — then friends just tap their phone on yours to pay you back through PayPal.</p>
        <label class="btn primary wide file">📷 Scan a receipt<input type="file" accept="image/*" capture="environment" data-action="receipt-file"></label>
        <button class="btn ghost wide" data-action="sample-receipt">Try the sample receipt</button>
      </div>`;
  }
  if (sp.parsing) {
    return `<div class="card center pad"><div class="spinner"></div><p>Claude is reading the receipt…</p></div>`;
  }
  if (sp.draft) {
    const d = sp.draft;
    const shares = evenSharesClient(cents(d.total), sp.people);
    return `
      <div class="card">
        <div class="row between"><h2>${esc(d.merchant || 'Receipt')}</h2><small class="badge ai ${d.source === 'claude' ? 'on' : ''}">✦ ${d.source === 'claude' ? 'read by Claude' : 'sample data'}</small></div>
        ${d.items.map((i) => `<div class="line"><span>${i.qty}× ${esc(i.name)}</span><span>${money(i.lineTotal)}</span></div>`).join('')}
        <div class="line sub"><span>Subtotal</span><span>${money(d.subtotal)}</span></div>
        ${d.tax ? `<div class="line sub"><span>Tax</span><span>${money(d.tax)}</span></div>` : ''}
        ${d.tip ? `<div class="line sub"><span>Tip</span><span>${money(d.tip)}</span></div>` : ''}
        <div class="line total"><span>Total</span><span>${money(d.total)}</span></div>
      </div>
      <div class="card">
        <div class="row between"><b>Split between</b>
          <span class="stepper"><button data-action="people" data-d="-1">−</button><b>${sp.people}</b><button data-action="people" data-d="1">+</button></span>
        </div>
        <p class="muted">${sp.people} people · ${money(shares[1] / 100)} each. You already paid, so you'll collect ${money((cents(d.total) - shares[0]) / 100)}.</p>
      </div>
      <button class="btn primary wide" data-action="start-split">Start collecting by tap</button>
      <button class="btn ghost wide" data-action="end-split">Discard</button>`;
  }
  const live = sp.live;
  const paid = live.shares.filter((s) => s.status === 'paid');
  const collected = paid.slice(1).reduce((s, x) => s + cents(x.amount), 0);
  const toCollect = live.shares.slice(1).reduce((s, x) => s + cents(x.amount), 0);
  return `
    ${viewStage()}
    <div class="card">
      <div class="row between"><b>${esc(live.title)}</b><span>${money(collected / 100)} / ${money(toCollect / 100)}</span></div>
      <div class="progress"><span style="width:${toCollect ? (collected / toCollect) * 100 : 100}%"></span></div>
      ${live.shares
        .map(
          (s) => `
        <div class="share ${s.status}">
          <span>${s.status === 'paid' ? '✓' : s.status === 'reserved' ? '…' : '○'}</span>
          <span class="grow">${esc(s.payer?.name || s.label)}</span>
          <b>${money(s.amount)}</b>
        </div>`,
        )
        .join('')}
    </div>
    <button class="btn ghost wide" data-action="end-split">${paid.length === live.shares.length ? 'Done' : 'Stop collecting'}</button>`;
}

function evenSharesClient(total, n) {
  const base = Math.floor(total / n);
  let rem = total - base * n;
  return Array.from({ length: n }, () => base + (rem-- > 0 ? 1 : 0));
}

function viewCopilot() {
  const suggestions = ['How did we do today?', 'Top sellers this week?', 'Ring up 2 lattes and a croissant', 'Refund the last payment'];
  return `
    <div class="chat">
      ${S.copilot
        .map(
          (m) => `
        <div class="msg ${m.role}">
          <div class="bubble">${markdownLite(m.content)}</div>
          ${(m.actions || [])
            .map(
              (a) => `
            <div class="action-card ${a.status}">
              <div><b>${a.kind === 'refund' ? '↩ Refund' : '↗ Payout'}</b> · ${esc(a.summary)}${a.reason ? `<br><small class="muted">${esc(a.reason)}</small>` : ''}</div>
              ${
                a.status === 'pending'
                  ? `<div class="row gap"><button class="btn ghost" data-action="act" data-id="${a.id}" data-d="dismiss">Dismiss</button><button class="btn primary" data-action="act" data-id="${a.id}" data-d="approve">Approve</button></div>`
                  : `<small class="muted">${a.status === 'approved' ? '✓ Sent via PayPal' : 'Dismissed'}</small>`
              }
            </div>`,
            )
            .join('')}
        </div>`,
        )
        .join('')}
      ${S.copilotBusy ? `<div class="msg assistant"><div class="bubble typing"><span></span><span></span><span></span></div></div>` : ''}
    </div>
    <div class="chips">${suggestions.map((s) => `<button class="chip action" data-action="suggest" data-q="${esc(s)}">${esc(s)}</button>`).join('')}</div>
    <form class="ask" data-form="copilot">
      <input id="copilot-input" class="input" placeholder="Ask about sales, refunds, payouts…" autocomplete="off">
      <button class="btn primary" type="submit" ${S.copilotBusy ? 'disabled' : ''}>Send</button>
    </form>`;
}

function viewMe() {
  const u = S.user;
  const link = `${location.origin}/t/${u.id}?src=nfc-tag`;
  const nfc = 'NDEFReader' in window;
  return `
    <div class="card profile">
      ${avatar(u, 64)}
      <div><h2>${esc(u.name)}</h2><span class="muted">${esc(u.handle)} · ${u.type === 'business' ? 'Business' : 'Personal'}</span></div>
    </div>
    <div class="card form">
      <h3>PayPal</h3>
      <p class="muted small">${u.paypalLinked ? '✓ PayPal wallet saved — taps are one-touch.' : 'Approve once with PayPal on your first tap; Payd saves it (PayPal Vault) for one-touch taps after that.'}</p>
      <label>Get paid to (PayPal sandbox email)<input id="pp-email" type="email" value="${esc(u.paypalEmail || '')}" placeholder="you@business.example.com"></label>
      ${u.type === 'personal' ? `<label>One-touch limit (Payd Guard asks above this)<input id="tap-limit" inputmode="decimal" value="${esc(u.tapLimit || '50.00')}"></label>` : ''}
      <div class="row gap"><button class="btn primary" data-action="save-profile">Save</button>${u.paypalLinked ? `<button class="btn ghost" data-action="unlink">Unlink PayPal</button>` : ''}</div>
    </div>
    <div class="card">
      <h3>Tap to pay</h3>
      <div class="center">${sensorChip()}</div>
      <p class="muted small">iPhone and Android: knock phones together — both accelerometers feel the same impact and Payd matches them in under a second. No NFC chip access needed.</p>
    </div>
    <div class="card">
      <h3>${u.type === 'business' ? 'Counter sticker &amp; QR' : 'My pay link'}</h3>
      <div class="qr"><img src="/api/qr?data=${encodeURIComponent(link.replace('nfc-tag', 'qr'))}" alt="QR"></div>
      <input class="input mono" readonly value="${esc(link)}">
      <div class="row gap">
        <button class="btn ghost" data-action="copy-link" data-link="${esc(link)}">Copy link</button>
        ${nfc ? `<button class="btn primary" data-action="write-nfc" data-link="${esc(link)}">Write NFC sticker</button>` : ''}
      </div>
      <p class="muted small">Program a $0.20 NFC sticker with this link. Any iPhone (XS+) or Android opens it natively on tap — no app install — and pays whatever is on your terminal.</p>
    </div>
    <div class="card">
      <h3>Demo</h3>
      <p class="muted small">PayPal: <b>${S.config.paypal.mode === 'sandbox' ? 'Sandbox (live API)' : 'Simulated sandbox (add PAYPAL_CLIENT_ID)'}</b><br>AI: <b>${S.config.ai.enabled ? esc(S.config.ai.model) : 'Rules fallback (add ANTHROPIC_API_KEY)'}</b></p>
      <div class="row gap"><button class="btn ghost" data-action="switch-user">Switch profile</button><button class="btn ghost" data-action="reset-demo">Reset demo data</button></div>
    </div>`;
}

function viewLink() {
  const d = S.link.data;
  if (!d) return `<div class="card center pad"><div class="spinner"></div></div>`;
  if (d.error) return `<div class="card center pad"><p>${esc(d.error)}</p><button class="btn ghost" data-action="leave-link">Back</button></div>`;
  const fixed = d.armed?.amount || d.split?.nextAmount;
  return `
    <div class="card link-card">
      <div class="via">${S.link.src === 'nfc-tag' ? '📶 Tapped NFC sticker' : S.link.src === 'qr' ? '▦ Scanned QR' : '🔗 Pay link'}</div>
      ${avatar(d.user, 72)}
      <h2>${esc(d.user.name)}</h2>
      <p class="muted">${esc(d.user.handle)} ${d.online ? '· <span class="good">terminal online</span>' : ''}</p>
      ${
        fixed
          ? `<div class="big-amount">${money(fixed)}</div>
             ${(d.armed?.items || []).map((i) => `<div class="line"><span>${i.qty}× ${esc(i.name)}</span><span>${money(cents(i.unitPrice) * i.qty / 100)}</span></div>`).join('')}
             ${d.split ? `<p class="muted">${esc(d.split.title)} — your share</p>` : ''}`
          : `<p class="muted">No amount on the terminal — enter one</p>${keypad('sheet', S.sheetAmount)}`
      }
      <button class="btn primary wide" data-action="pay-link">Continue to pay</button>
      <button class="btn ghost wide" data-action="leave-link">Not now</button>
    </div>`;
}

// ------------------------------------------------------------------ sheets

function renderSheet() {
  if (S.success) {
    $sheet.innerHTML = viewSuccess();
    return;
  }
  if (S.detail) {
    $sheet.innerHTML = viewDetail();
    return;
  }
  if (!S.intent) {
    $sheet.innerHTML = '';
    return;
  }
  $sheet.innerHTML = S.role === 'payer' ? viewPaySheet() : viewWaitSheet();
}

function guardBox(g) {
  if (!g) return '';
  if (g.level === 'pending') return `<div class="guard pending"><span class="shield">🛡</span><div><b>Payd Guard</b><small>${esc(g.headline)}</small></div></div>`;
  return `
    <div class="guard ${esc(g.level)} ${g.refining ? 'refining' : ''}">
      <span class="shield">🛡</span>
      <div class="grow">
        <div class="row between"><b>${esc(g.headline)}</b><small class="score">${g.level} · ${g.score}</small></div>
        <ul>${(g.reasons || []).map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
        <small class="muted">Payd Guard · ${g.refining ? 'Claude is reviewing…' : g.source === 'claude' ? 'reviewed by Claude' : 'rule check'}</small>
      </div>
    </div>`;
}

function viewPaySheet() {
  const i = S.intent;
  const highRisk = i.guard && (i.guard.level === 'high' || i.guard.action === 'confirm' || i.guard.action === 'block');
  const locked = highRisk && !S.ack;
  const sandbox = i.paypalMode === 'sandbox';
  return `
    <div class="backdrop">
      <div class="sheet">
        <div class="grabber"></div>
        <div class="pay-head">
          ${avatar(i.payee, 56)}
          <div><small class="muted">${i.split ? 'Pay your share to' : 'Pay'}</small><h2>${esc(i.payee.name)}</h2><small class="muted">${esc(i.payee.handle)} · ${methodLabel(i.method)}</small></div>
        </div>
        ${
          i.amount
            ? `<div class="big-amount">${money(i.amount)}</div>`
            : `${keypad('sheet', S.sheetAmount)}<button class="btn primary wide" data-action="sheet-amount">Continue</button>`
        }
        ${i.items?.length ? `<div class="items">${i.items.map((x) => `<div class="line"><span>${esc(x.emoji || '')} ${x.qty}× ${esc(x.name)}</span><span>${money(cents(x.unitPrice) * x.qty / 100)}</span></div>`).join('')}</div>` : ''}
        ${i.note ? `<p class="note">“${esc(i.note)}”</p>` : ''}
        ${i.amount ? guardBox(i.guard) : ''}
        ${highRisk && i.amount ? `<label class="ack"><input type="checkbox" data-action="ack" ${S.ack ? 'checked' : ''}> I know ${esc(i.payee.name.split(' ')[0])} and ${money(i.amount)} is right</label>` : ''}
        ${
          i.amount && !S.needsApproval
            ? `<button class="hold ${S.paying ? 'busy' : ''}" data-hold="pay" ${locked || S.paying ? 'disabled' : ''}>
                 <span class="fill"></span>
                 <span class="label">${S.paying ? 'Paying with PayPal…' : i.payerPaypalLinked || !sandbox ? 'Hold to pay with PayPal' : 'Hold to pay — approve with PayPal'}</span>
               </button>`
            : ''
        }
        <div id="pp-buttons" class="${S.needsApproval ? 'show' : ''}"></div>
        <button class="btn ghost wide" data-action="decline">Cancel</button>
        <p class="fine center">${
          sandbox
            ? i.payerPaypalLinked
              ? 'One-touch · PayPal wallet saved with Vault'
              : 'First tap: approve once, Payd saves PayPal for one-touch next time'
            : 'PayPal sandbox simulated · add API keys for live sandbox'
        }</p>
      </div>
    </div>`;
}

function viewWaitSheet() {
  const i = S.intent;
  const status =
    i.status === 'processing' ? 'Processing with PayPal…' : i.amount ? 'Confirming on their phone' : 'Entering an amount on their phone';
  return `
    <div class="backdrop">
      <div class="sheet">
        <div class="grabber"></div>
        <div class="pay-head">
          ${avatar(i.payer, 56)}
          <div><small class="muted">${i.split ? 'Collecting a share from' : 'Payment from'}</small><h2>${esc(i.payer.name)}</h2><small class="muted">${methodLabel(i.method)}${i.match?.dt != null ? ` · matched in ${i.match.dt} ms` : ''}</small></div>
        </div>
        ${i.amount ? `<div class="big-amount">${money(i.amount)}</div>` : ''}
        <div class="waiting"><div class="spinner"></div><span>${status}</span></div>
        <button class="btn ghost wide" data-action="decline">Cancel</button>
      </div>
    </div>`;
}

function viewSuccess() {
  const { intent, tx, role } = S.success;
  const other = role === 'payer' ? intent.payee : intent.payer;
  return `
    <div class="backdrop success-bg" data-action="close-success">
      <div class="success">
        <div class="check"><svg viewBox="0 0 52 52"><circle cx="26" cy="26" r="24"/><path d="M14 27l8 8 16-17"/></svg></div>
        <div class="big-amount">${money(tx.amount)}</div>
        <h2>${role === 'payer' ? `Paid ${esc(other.name)}` : `Received from ${esc(other.name.split(' ')[0])}`}</h2>
        <p class="muted">${esc(intent.note || methodLabel(intent.method))}</p>
        <p class="fine mono">PayPal ${tx.paypal?.mode === 'sandbox' ? 'capture' : 'sim capture'} ${esc(tx.paypal?.captureId || '')}</p>
        <button class="btn primary" data-action="close-success">Done</button>
      </div>
    </div>`;
}

function viewDetail() {
  const t = S.detail;
  const other = t.direction === 'in' ? t.payer || { name: t.payerLabel } : t.payee;
  const refundable = t.direction === 'in' && (t.status === 'completed' || t.status === 'partially_refunded');
  return `
    <div class="backdrop" data-action="close-detail">
      <div class="sheet" data-stop>
        <div class="grabber"></div>
        <div class="pay-head">${avatar(other, 56)}<div><small class="muted">${t.direction === 'in' ? 'From' : 'To'}</small><h2>${esc(other?.name || 'Customer')}</h2><small class="muted">${new Date(t.createdAt).toLocaleString()}</small></div></div>
        <div class="big-amount">${t.direction === 'in' ? '+' : '−'}${money(t.amount)}</div>
        ${t.items?.length ? `<div class="items">${t.items.map((x) => `<div class="line"><span>${x.qty}× ${esc(x.name)}</span><span>${money(cents(x.unitPrice) * x.qty / 100)}</span></div>`).join('')}</div>` : ''}
        ${t.note ? `<p class="note">“${esc(t.note)}”</p>` : ''}
        <div class="kv">
          <span>Status</span><b>${esc(t.status.replace('_', ' '))}${t.refundedAmount ? ` (${money(t.refundedAmount)} back)` : ''}</b>
          <span>Method</span><b>${methodLabel(t.method)}</b>
          <span>PayPal order</span><b class="mono">${esc(t.paypal?.orderId || '—')}</b>
          <span>Capture</span><b class="mono">${esc(t.paypal?.captureId || '—')}</b>
          ${t.guard ? `<span>Payd Guard</span><b>${esc(t.guard.level)} · ${t.guard.score ?? ''} (${esc(t.guard.source || '')})</b>` : ''}
        </div>
        ${refundable ? `<button class="btn danger wide" data-action="refund" data-id="${esc(t.id)}">Refund ${money((cents(t.amount) - cents(t.refundedAmount || 0)) / 100)} via PayPal</button>` : ''}
        <button class="btn ghost wide" data-action="close-detail">Close</button>
      </div>
    </div>`;
}

// ------------------------------------------------------------------ events

const actions = {
  'pick-user': (el) => selectUser(el.dataset.id),
  'show-create': () => {
    S.onboardingCreate = true;
    render();
  },
  tab: (el) => {
    S.tab = el.dataset.tab;
    S.keypad = null;
    if (['activity', 'sales', 'home'].includes(S.tab)) refreshActivity();
    render();
    if (S.tab === 'copilot') scrollChat();
  },
  mode: (el) => {
    S.mode = el.dataset.mode;
    S.keypad = null;
    syncArm();
    render();
  },
  'enable-sensor': enableSensor,
  'stage-tap': () => {
    if (S.sensor === 'unsupported') doTap('key');
  },
  key: (el) => {
    const k = el.dataset.k;
    const target = el.dataset.target;
    const field = { recv: 'recvAmount', pay: 'payAmount', sheet: 'sheetAmount', custom: 'customAmount' }[target];
    let v = S[field] || '';
    if (k === '⌫') v = v.slice(0, -1);
    else if (k === '.') v = v.includes('.') ? v : (v || '0') + '.';
    else if (/\.\d\d$/.test(v) || v.replace('.', '').length >= 6) return;
    else v = v === '0' ? k : v + k;
    S[field] = v;
    if (target === 'recv') syncArm();
    if (target === 'sheet' && S.intent) return renderSheet();
    render();
  },
  keypad: (el) => {
    S.keypad = S.keypad === el.dataset.target ? null : el.dataset.target;
    render();
  },
  'keypad-done': () => {
    S.keypad = null;
    syncArm();
    render();
  },
  'clear-pay': () => {
    S.payAmount = '';
    syncArm();
    render();
  },
  'clear-recv': () => {
    S.recvAmount = '';
    syncArm();
    render();
  },
  'toggle-qr': () => {
    S.showQr = !S.showQr;
    render();
  },
  add: (el) => addToCart(el.dataset.sku, 1),
  inc: (el) => addToCart(el.dataset.sku, 1),
  dec: (el) => addToCart(el.dataset.sku, -1),
  ask: askCart,
  mic: listen,
  charge: () => startCharge(),
  'charge-custom': () => {
    if (!Number(S.customAmount)) return toast('Enter an amount');
    S.keypad = null;
    startCharge([{ sku: 'custom', name: 'Custom amount', emoji: '✎', unitPrice: Number(S.customAmount).toFixed(2), qty: 1 }]);
    S.customAmount = '';
  },
  'cancel-charge': cancelCharge,
  'sheet-amount': submitSheetAmount,
  ack: (el) => {
    S.ack = el.checked;
    renderSheet();
  },
  decline,
  'close-success': () => {
    S.success = null;
    renderSheet();
  },
  tx: (el) => {
    S.detail = S.activity.find((t) => t.id === el.dataset.id);
    renderSheet();
  },
  'close-detail': (el, e) => {
    if (e.target.closest('[data-stop]') && !e.target.closest('[data-action="close-detail"].btn')) return;
    S.detail = null;
    renderSheet();
  },
  refund: async (el) => {
    el.disabled = true;
    try {
      S.detail = await api(`/api/transactions/${el.dataset.id}/refund`, { userId: S.user.id });
      sounds.success();
      toast('Refunded via PayPal', 'good');
      refreshActivity();
    } catch (err) {
      toast(err.message, 'bad');
    }
    renderSheet();
  },
  'receipt-file': () => {},
  'sample-receipt': sampleReceipt,
  people: (el) => {
    S.split.people = Math.max(2, Math.min(12, S.split.people + Number(el.dataset.d)));
    render();
  },
  'start-split': startSplit,
  'end-split': endSplit,
  suggest: (el) => askCopilot(el.dataset.q),
  act: (el) => decideAction(el.dataset.id, el.dataset.d),
  'save-profile': async () => {
    const body = { paypalEmail: document.getElementById('pp-email')?.value || '' };
    const lim = document.getElementById('tap-limit');
    if (lim) body.tapLimit = lim.value;
    try {
      S.user = await api(`/api/users/${S.user.id}`, body, 'PATCH');
      toast('Saved', 'good');
      render();
    } catch (err) {
      toast(err.message, 'bad');
    }
  },
  unlink: async () => {
    S.user = await api(`/api/users/${S.user.id}`, { unlinkPaypal: true }, 'PATCH');
    render();
  },
  'copy-link': async (el) => {
    try {
      await navigator.clipboard.writeText(el.dataset.link);
      toast('Link copied');
    } catch {
      toast(el.dataset.link);
    }
  },
  'write-nfc': async (el) => {
    try {
      const ndef = new window.NDEFReader();
      toast('Hold a blank NFC sticker to the back of your phone');
      await ndef.write({ records: [{ recordType: 'url', data: el.dataset.link }] });
      toast('Sticker programmed ✓', 'good');
    } catch (err) {
      toast(`NFC: ${err.message}`, 'bad');
    }
  },
  'switch-user': () => {
    S.user = null;
    localStorage.removeItem('payd.user');
    rt.setUser(null);
    S.armedMode = 'idle';
    render();
  },
  'reset-demo': async () => {
    if (!confirm('Reset all demo payments and profiles?')) return;
    await api('/api/demo/reset', {});
  },
  'pay-link': payLink,
  'leave-link': () => {
    S.link = null;
    history.replaceState(null, '', '/');
    syncArm(true);
    render();
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const name = el.dataset.action;
  if (el.tagName === 'INPUT' && el.type === 'file') return;
  if (name === 'close-detail' || name === 'close-success') {
    // Only close when clicking the backdrop itself or a close button.
    if (e.target !== el && !e.target.closest('.btn')) return;
  }
  unlockAudio();
  actions[name]?.(el, e);
});

document.addEventListener('change', (e) => {
  if (e.target.matches('[data-action="receipt-file"]') && e.target.files?.[0]) scanReceipt(e.target.files[0]);
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'recv-note') {
    S.recvNote = e.target.value;
    clearTimeout(S.noteTimer);
    S.noteTimer = setTimeout(syncArm, 300);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'ask-input') askCart();
});

document.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target.dataset.form;
  if (form === 'copilot') askCopilot();
  if (form === 'create-user') {
    try {
      const user = await api('/api/users', {
        name: document.getElementById('new-name').value,
        paypalEmail: document.getElementById('new-email').value,
        type: document.querySelector('input[name="new-type"]:checked')?.value,
      });
      S.users.push(user);
      selectUser(user.id);
    } catch (err) {
      toast(err.message, 'bad');
    }
  }
});

// Press-and-hold to pay (a deliberate gesture, like double-click on Apple Pay).
let holdTimer;
document.addEventListener('pointerdown', (e) => {
  const btn = e.target.closest('[data-hold]');
  if (!btn || btn.disabled) return;
  unlockAudio();
  btn.classList.add('holding');
  haptic(10);
  holdTimer = setTimeout(() => {
    btn.classList.remove('holding');
    haptic(40);
    pay();
  }, 650);
});
const cancelHold = () => {
  clearTimeout(holdTimer);
  document.querySelectorAll('.holding').forEach((b) => b.classList.remove('holding'));
};
document.addEventListener('pointerup', cancelHold);
document.addEventListener('pointercancel', cancelHold);
document.addEventListener('pointerleave', cancelHold);

if ('serviceWorker' in navigator && !EMBED && location.protocol === 'https:') {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

window.__payd = { S, doTap };
boot().catch((err) => {
  $app.innerHTML = `<div class="card pad">Failed to start: ${esc(err.message)}</div>`;
});
