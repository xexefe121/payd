import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TapMatcher, haversineMeters } from '../server/tapmatch.js';

const tap = (o) => ({ id: Math.random().toString(36), clientId: o.userId, method: 'bump', ...o });

test('pairs a pay tap with a receive tap inside the window', () => {
  const m = new TapMatcher({ now: () => 1000 });
  assert.equal(m.submit(tap({ userId: 'alice', role: 'pay', t: 1000 })), null);
  const r = m.submit(tap({ userId: 'cafe', role: 'receive', t: 1080 }));
  assert.ok(r);
  assert.equal(r.match.userId, 'alice');
  assert.equal(r.dt, 80);
  assert.equal(m.pending.length, 0);
});

test('does not pair taps outside the time window', () => {
  const m = new TapMatcher({ now: () => 5000 });
  m.submit(tap({ userId: 'alice', role: 'pay', t: 1000 }));
  assert.equal(m.submit(tap({ userId: 'cafe', role: 'receive', t: 2500 })), null);
});

test('does not pair two payers', () => {
  const m = new TapMatcher({ now: () => 1000 });
  m.submit(tap({ userId: 'alice', role: 'pay', t: 1000 }));
  assert.equal(m.submit(tap({ userId: 'ben', role: 'pay', t: 1010 })), null);
});

test('does not pair a user with their own second device', () => {
  const m = new TapMatcher({ now: () => 1000 });
  m.submit(tap({ userId: 'alice', role: 'pay', t: 1000 }));
  assert.equal(m.submit(tap({ userId: 'alice', clientId: 'alice-2', role: 'receive', t: 1010 })), null);
});

test('picks the closest tap in time and flags ambiguity', () => {
  const m = new TapMatcher({ now: () => 1000 });
  m.submit(tap({ userId: 'ben', role: 'receive', t: 1000 }));
  m.submit(tap({ userId: 'maya', role: 'receive', t: 1300 }));
  const r = m.submit(tap({ userId: 'alice', role: 'pay', t: 1020 }));
  assert.equal(r.match.userId, 'ben');
  assert.equal(r.ambiguous, false);

  const m2 = new TapMatcher({ now: () => 1000 });
  m2.submit(tap({ userId: 'ben', role: 'receive', t: 1000 }));
  m2.submit(tap({ userId: 'maya', role: 'receive', t: 1040 }));
  const r2 = m2.submit(tap({ userId: 'alice', role: 'pay', t: 1020 }));
  assert.equal(r2.ambiguous, true);
});

test('geo gate rejects phones far apart', () => {
  const m = new TapMatcher({ now: () => 1000 });
  m.submit(tap({ userId: 'alice', role: 'pay', t: 1000, geo: { lat: -33.8688, lng: 151.2093, acc: 20 } }));
  // ~3 km away
  assert.equal(m.submit(tap({ userId: 'cafe', role: 'receive', t: 1005, geo: { lat: -33.8401, lng: 151.2093, acc: 20 } })), null);
  // same spot
  const r = m.submit(tap({ userId: 'ben', role: 'receive', t: 1010, geo: { lat: -33.8689, lng: 151.2094, acc: 20 } }));
  assert.ok(r);
  assert.ok(r.distance < 50);
});

test('unmatched taps expire', () => {
  let now = 1000;
  const m = new TapMatcher({ now: () => now });
  m.submit(tap({ userId: 'alice', role: 'pay', t: 1000 }));
  now = 10_000;
  assert.equal(m.submit(tap({ userId: 'cafe', role: 'receive', t: 1100 })), null);
});

test('haversine distance is sane', () => {
  const d = haversineMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 1 });
  assert.ok(Math.abs(d - 111_195) < 200);
});
