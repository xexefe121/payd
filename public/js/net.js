// REST + realtime socket with NTP-style clock sync so taps from two phones
// can be compared on the server's clock.

export async function api(path, body, method) {
  const res = await fetch(path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.error || `Request failed (${res.status})`);
    err.code = json.code;
    err.status = res.status;
    throw err;
  }
  return json;
}

export class Realtime {
  constructor({ clientId, userId, observer = false, onMessage, onStatus }) {
    this.clientId = clientId;
    this.userId = userId;
    this.observer = observer;
    this.onMessage = onMessage;
    this.onStatus = onStatus || (() => {});
    this.offset = 0; // serverTime - localTime
    this.bestRtt = Infinity;
    this.queue = [];
    this.retry = 0;
    this.connect();
  }

  get url() {
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  }

  connect() {
    this.ws = new WebSocket(this.url);
    this.ws.onopen = () => {
      this.retry = 0;
      this.onStatus('online');
      this.raw({ type: 'hello', clientId: this.clientId, userId: this.userId, observer: this.observer });
      this.syncClock();
      for (const m of this.queue.splice(0)) this.raw(m);
    };
    this.ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === 'sync') return this.handleSync(msg);
      this.onMessage?.(msg);
    };
    this.ws.onclose = () => {
      this.onStatus('offline');
      const wait = Math.min(8000, 500 * 2 ** this.retry++);
      setTimeout(() => this.connect(), wait);
    };
  }

  syncClock(rounds = 6) {
    this.bestRtt = Infinity;
    let i = 0;
    const tick = () => {
      if (i++ >= rounds) return;
      this.raw({ type: 'sync', t0: Date.now() });
      setTimeout(tick, 120);
    };
    tick();
    clearInterval(this.syncTimer);
    this.syncTimer = setInterval(() => this.raw({ type: 'sync', t0: Date.now() }), 20000);
  }

  handleSync({ t0, ts }) {
    const t1 = Date.now();
    const rtt = t1 - t0;
    if (rtt <= this.bestRtt) {
      this.bestRtt = rtt;
      this.offset = ts - (t0 + rtt / 2);
    }
  }

  serverNow() {
    return Date.now() + this.offset;
  }

  raw(msg) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg));
    else this.queue.push(msg);
  }

  send(msg) {
    this.raw(msg);
  }

  setUser(userId) {
    this.userId = userId;
    this.raw({ type: 'hello', clientId: this.clientId, userId, observer: this.observer });
  }
}
