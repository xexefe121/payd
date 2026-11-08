// Tap matching engine.
//
// Two phones "tap" each other. Each phone independently detects the physical
// impact with its accelerometer (or an NFC/QR/simulator trigger) and reports a
// tap event stamped in *server* time (clients keep an NTP-style clock offset).
// The server pairs a PAY tap with a RECEIVE tap whose timestamps land inside a
// small window, optionally constrained by GPS distance. This works on iOS and
// Android alike because it only needs motion sensors and a network, not
// phone-to-phone NFC (which neither platform exposes to the web).

export const DEFAULTS = {
  windowMs: 900, // max |t1 - t2| between the two taps
  ttlMs: 2500, // how long an unmatched tap waits for a partner
  maxDistanceM: 250, // geo gate when both phones share location
  ambiguityMs: 120, // two candidates closer than this = ambiguous
};

export function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export class TapMatcher {
  constructor(opts = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.now = opts.now || (() => Date.now());
    this.pending = []; // unmatched taps
  }

  prune() {
    const cutoff = this.now() - this.opts.ttlMs;
    const expired = this.pending.filter((p) => p.receivedAt < cutoff);
    this.pending = this.pending.filter((p) => p.receivedAt >= cutoff);
    return expired;
  }

  geoCompatible(a, b) {
    if (!a.geo || !b.geo) return { ok: true, distance: null };
    const distance = haversineMeters(a.geo, b.geo);
    const slack = (a.geo.acc || 0) + (b.geo.acc || 0);
    return { ok: distance <= this.opts.maxDistanceM + slack, distance };
  }

  /**
   * Submit a tap. Returns { match, candidateCount, ambiguous, dt, distance }
   * when a partner is found, otherwise null (the tap is queued).
   * tap = { id, clientId, userId, role: 'pay'|'receive', t, geo?, method }
   */
  submit(tap) {
    this.prune();
    const entry = { ...tap, receivedAt: this.now() };
    if (entry.role !== 'pay' && entry.role !== 'receive') return null;

    // A device only ever has one outstanding tap.
    this.pending = this.pending.filter((p) => p.clientId !== entry.clientId);

    const candidates = [];
    for (const p of this.pending) {
      if (p.role === entry.role) continue;
      if (p.userId === entry.userId) continue;
      const dt = Math.abs(p.t - entry.t);
      if (dt > this.opts.windowMs) continue;
      const geo = this.geoCompatible(p, entry);
      if (!geo.ok) continue;
      candidates.push({ tap: p, dt, distance: geo.distance });
    }

    if (candidates.length === 0) {
      this.pending.push(entry);
      return null;
    }

    candidates.sort((a, b) => a.dt - b.dt);
    const best = candidates[0];
    const ambiguous =
      candidates.length > 1 && candidates[1].dt - best.dt < this.opts.ambiguityMs;

    this.pending = this.pending.filter((p) => p !== best.tap);
    return {
      match: best.tap,
      tap: entry,
      dt: best.dt,
      distance: best.distance,
      candidateCount: candidates.length,
      ambiguous,
    };
  }

  cancel(clientId) {
    this.pending = this.pending.filter((p) => p.clientId !== clientId);
  }
}
