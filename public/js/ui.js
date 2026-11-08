// Small UI helpers: escaping, money, toasts, sound and haptics.

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function money(value, currency = 'USD') {
  const n = Number(value || 0);
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(n);
  } catch {
    return `$${n.toFixed(2)}`;
  }
}

export function cents(value) {
  return Math.round(Number(value || 0) * 100);
}

export function initials(name = '') {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}

export function avatar(user, size = 40) {
  if (!user) return `<span class="avatar" style="--s:${size}px;background:#334">?</span>`;
  const glyph = user.type === 'business' ? '☕' : esc(initials(user.name));
  return `<span class="avatar" style="--s:${size}px;background:${esc(user.color || '#5B5BF7')}">${glyph}</span>`;
}

export function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

let toastTimer;
export function toast(text, kind = '') {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.className = `toast show ${kind}`;
  el.textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast'), 2600);
}

let audioCtx;
function ctx() {
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

export function unlockAudio() {
  try {
    ctx().resume();
  } catch {}
}

function tone(freq, start, dur, gain = 0.08, type = 'sine') {
  try {
    const c = ctx();
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, c.currentTime + start);
    g.gain.linearRampToValueAtTime(gain, c.currentTime + start + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + start + dur);
    o.connect(g).connect(c.destination);
    o.start(c.currentTime + start);
    o.stop(c.currentTime + start + dur + 0.05);
  } catch {}
}

export const sounds = {
  tap() {
    tone(880, 0, 0.08, 0.06, 'triangle');
  },
  success() {
    tone(1046.5, 0, 0.18);
    tone(1318.5, 0.09, 0.22);
    tone(1568, 0.18, 0.35);
  },
  error() {
    tone(220, 0, 0.25, 0.08, 'sawtooth');
  },
};

export function haptic(pattern = 30) {
  if (document.documentElement.classList.contains('embed')) return; // simulator iframes
  try {
    navigator.vibrate?.(pattern);
  } catch {}
}

export function markdownLite(text) {
  return esc(text)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^- (.*)$/gm, '• $1')
    .replace(/\n/g, '<br>');
}
