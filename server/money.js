// Money helpers. All arithmetic happens in integer cents.

export const MAX_AMOUNT_CENTS = 1_000_000; // $10,000 per tap (sandbox demo cap)

export function toCents(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[^0-9.-]/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

export function fromCents(cents) {
  return (cents / 100).toFixed(2);
}

export function normalizeAmount(value) {
  const cents = toCents(value);
  if (cents === null) return null;
  if (cents <= 0 || cents > MAX_AMOUNT_CENTS) return null;
  return fromCents(cents);
}

export function sumItems(items = []) {
  return items.reduce((acc, it) => acc + (toCents(it.unitPrice) || 0) * (Number(it.qty) || 1), 0);
}

// Split a total into n shares that add back up exactly (remainder cents go to the first shares).
export function evenShares(totalCents, n) {
  const base = Math.floor(totalCents / n);
  let rem = totalCents - base * n;
  return Array.from({ length: n }, () => base + (rem-- > 0 ? 1 : 0));
}

export function formatMoney(value, currency = 'USD') {
  const n = typeof value === 'string' ? Number(value) : value;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n);
  } catch {
    return `$${Number(n).toFixed(2)}`;
  }
}
