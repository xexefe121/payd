// Tiny JSON-file store. Good enough for a hackathon demo; swap for Postgres later.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// Vercel's filesystem is read-only except /tmp.
const DATA_DIR = process.env.PAYD_DATA_DIR || (process.env.VERCEL ? '/tmp/payd' : path.join(here, '..', 'data'));
const DB_FILE = path.join(DATA_DIR, 'payd.json');

export const id = (prefix) => `${prefix}_${crypto.randomBytes(6).toString('hex')}`;

const COLORS = ['#5B5BF7', '#00B37E', '#F25C54', '#F7B32B', '#2EC4F1', '#B15BF7', '#FF7AB6'];

export const CAFE_CATALOG = [
  { sku: 'flat-white', name: 'Flat White', price: '4.50', emoji: '☕', aliases: ['flat whites', 'flatwhite', 'fw'] },
  { sku: 'latte', name: 'Latte', price: '4.80', emoji: '🥛', aliases: ['lattes', 'cafe latte'] },
  { sku: 'cappuccino', name: 'Cappuccino', price: '4.60', emoji: '☕', aliases: ['cap', 'capp', 'cappuccinos', 'cappucino'] },
  { sku: 'long-black', name: 'Long Black', price: '3.90', emoji: '⚫', aliases: ['americano', 'long blacks', 'black coffee'] },
  { sku: 'cold-brew', name: 'Cold Brew', price: '5.50', emoji: '🧊', aliases: ['iced coffee', 'cold brews'] },
  { sku: 'iced-matcha', name: 'Iced Matcha', price: '6.00', emoji: '🍵', aliases: ['matcha', 'matcha latte', 'green tea'] },
  { sku: 'oat-milk', name: 'Oat Milk', price: '0.70', emoji: '🌾', aliases: ['oat', 'oaty', 'with oat'], modifier: true },
  { sku: 'extra-shot', name: 'Extra Shot', price: '0.80', emoji: '➕', aliases: ['double shot', 'extra espresso'], modifier: true },
  { sku: 'croissant', name: 'Croissant', price: '4.20', emoji: '🥐', aliases: ['croissants', 'butter croissant'] },
  { sku: 'banana-bread', name: 'Banana Bread', price: '5.20', emoji: '🍌', aliases: ['banana loaf', 'banana breads'] },
  { sku: 'avo-toast', name: 'Avocado Toast', price: '12.50', emoji: '🥑', aliases: ['avo toast', 'smashed avo', 'avocado'] },
  { sku: 'muffin', name: 'Blueberry Muffin', price: '4.40', emoji: '🧁', aliases: ['muffin', 'muffins', 'blueberry'] },
];

function seedUsers() {
  return [
    {
      id: 'alice',
      name: 'Alice Chen',
      handle: '@alice',
      type: 'personal',
      color: COLORS[0],
      paypalEmail: process.env.PAYD_SEED_ALICE_EMAIL || '',
      vaultId: null,
      tapLimit: '50.00',
    },
    {
      id: 'ben',
      name: 'Ben Okafor',
      handle: '@ben',
      type: 'personal',
      color: COLORS[1],
      paypalEmail: process.env.PAYD_SEED_BEN_EMAIL || '',
      vaultId: null,
      tapLimit: '50.00',
    },
    {
      id: 'maya',
      name: 'Maya Patel',
      handle: '@maya',
      type: 'personal',
      color: COLORS[6],
      paypalEmail: process.env.PAYD_SEED_MAYA_EMAIL || '',
      vaultId: null,
      tapLimit: '50.00',
    },
    {
      id: 'cafe',
      name: 'Bean There Café',
      handle: '@beanthere',
      type: 'business',
      color: COLORS[3],
      paypalEmail: process.env.PAYD_SEED_CAFE_EMAIL || '',
      vaultId: null,
      catalog: CAFE_CATALOG,
    },
  ];
}

// Deterministic history so the merchant copilot and fraud guard have a baseline.
function seedTransactions() {
  let seed = 42;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const tx = [];
  const now = Date.now();
  const buyers = ['alice', 'ben', 'maya', 'walkin'];
  for (let i = 0; i < 38; i++) {
    const ts = now - Math.floor(rand() * 7 * 24 * 3600 * 1000) - 3600 * 1000;
    const nItems = 1 + Math.floor(rand() * 3);
    const items = [];
    for (let j = 0; j < nItems; j++) {
      const p = CAFE_CATALOG[Math.floor(rand() * CAFE_CATALOG.length)];
      if (p.modifier) continue;
      const existing = items.find((x) => x.sku === p.sku);
      if (existing) existing.qty += 1;
      else items.push({ sku: p.sku, name: p.name, qty: 1, unitPrice: p.price });
    }
    if (!items.length) items.push({ sku: 'flat-white', name: 'Flat White', qty: 1, unitPrice: '4.50' });
    const cents = items.reduce((s, it) => s + Math.round(Number(it.unitPrice) * 100) * it.qty, 0);
    const payerId = buyers[Math.floor(rand() * buyers.length)];
    tx.push({
      id: id('tx'),
      payerId: payerId === 'walkin' ? null : payerId,
      payerName: payerId === 'walkin' ? 'Walk-in customer' : null,
      payeeId: 'cafe',
      amount: (cents / 100).toFixed(2),
      currency: 'USD',
      items,
      note: '',
      method: rand() > 0.3 ? 'bump' : 'nfc-tag',
      status: rand() > 0.95 ? 'refunded' : 'completed',
      createdAt: ts,
      completedAt: ts,
      paypal: { mode: 'seed', orderId: 'SEED' + i, captureId: 'SEEDCAP' + i },
      seeded: true,
    });
  }
  // A little P2P history for Alice
  const p2p = [
    ['alice', 'ben', '18.00', 'Pizza 🍕'],
    ['ben', 'alice', '6.50', 'Coffee'],
    ['alice', 'maya', '12.00', 'Cinema tickets'],
    ['maya', 'alice', '9.25', 'Uber split'],
  ];
  p2p.forEach(([payerId, payeeId, amount, note], i) => {
    const ts = now - (i + 1) * 26 * 3600 * 1000;
    tx.push({
      id: id('tx'),
      payerId,
      payeeId,
      amount,
      currency: 'USD',
      items: [],
      note,
      method: 'bump',
      status: 'completed',
      createdAt: ts,
      completedAt: ts,
      paypal: { mode: 'seed', orderId: 'SEEDP' + i, captureId: 'SEEDPC' + i },
      seeded: true,
    });
  });
  return tx.sort((a, b) => b.createdAt - a.createdAt);
}

function freshDb() {
  return { users: seedUsers(), transactions: seedTransactions(), splits: [], actions: [], version: 1 };
}

let db = null;
let saveTimer = null;

export function load() {
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    db = freshDb();
    save();
  }
  return db;
}

export function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    } catch (err) {
      console.error('[store] save failed', err.message);
    }
  }, 150);
}

export function reset() {
  db = freshDb();
  save();
  return db;
}

export const getDb = () => db || load();

export function getUser(userId) {
  return getDb().users.find((u) => u.id === userId) || null;
}

export function publicUser(u) {
  if (!u) return null;
  const { vaultId, ...rest } = u;
  return { ...rest, paypalLinked: Boolean(vaultId), hasPaypalEmail: Boolean(u.paypalEmail) };
}

export function upsertUser(data) {
  const d = getDb();
  let user = data.id ? getUser(data.id) : null;
  if (!user) {
    user = {
      id: id('u'),
      name: 'New user',
      handle: '',
      type: 'personal',
      color: COLORS[d.users.length % COLORS.length],
      paypalEmail: '',
      vaultId: null,
      tapLimit: '50.00',
    };
    d.users.push(user);
  }
  for (const key of ['name', 'handle', 'type', 'paypalEmail', 'tapLimit', 'catalog']) {
    if (data[key] !== undefined) user[key] = data[key];
  }
  if (user.type === 'business' && !user.catalog) user.catalog = [];
  if (!user.handle) user.handle = '@' + user.name.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 14);
  save();
  return user;
}

export function addTransaction(tx) {
  getDb().transactions.unshift(tx);
  save();
  return tx;
}

export function getTransaction(txId) {
  return getDb().transactions.find((t) => t.id === txId) || null;
}

export function transactionsFor(userId, limit = 50) {
  return getDb()
    .transactions.filter((t) => t.payerId === userId || t.payeeId === userId)
    .slice(0, limit);
}
