// PayPal REST client (sandbox) with a faithful mock for running without keys.
//
// APIs used:
//   POST /v1/oauth2/token                        - client-credentials access token
//   POST /v2/checkout/orders                     - create order (payee = person/business being paid,
//                                                  optional "save PayPal to vault on success")
//   POST /v2/checkout/orders/{id}/capture        - capture after buyer approval
//   POST /v2/checkout/orders  (vault_id)         - one-tap repeat payment with a vaulted PayPal wallet
//   POST /v2/payments/captures/{id}/refund       - refunds from the merchant terminal / copilot
//   POST /v1/payments/payouts                    - send money out (supplier payouts, cash-out)

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

export const events = new EventEmitter();

const CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || '';
const API_BASE = process.env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com';
const VAULT_ENABLED = (process.env.PAYPAL_ENABLE_VAULT || 'true') !== 'false';

export const mode = CLIENT_ID && CLIENT_SECRET ? 'sandbox' : 'mock';

export function clientConfig() {
  return {
    mode,
    clientId: mode === 'sandbox' ? CLIENT_ID : null,
    vault: mode === 'sandbox' && VAULT_ENABLED,
  };
}

export class PayPalError extends Error {
  constructor(message, status, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

let cachedToken = null;

async function accessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const res = await fetch(`${API_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new PayPalError(json.error_description || 'PayPal auth failed', res.status, json);
  cachedToken = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return cachedToken.value;
}

async function api(method, path, body, { requestId } = {}) {
  const started = Date.now();
  const token = await accessToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(requestId ? { 'PayPal-Request-Id': requestId } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  events.emit('call', {
    mode,
    method,
    path,
    status: res.status,
    ms: Date.now() - started,
    debugId: res.headers.get('paypal-debug-id'),
  });
  if (!res.ok) {
    const issue = json.details?.[0]?.issue || json.name || 'PAYPAL_ERROR';
    const desc = json.details?.[0]?.description || json.message || 'PayPal request failed';
    throw new PayPalError(`${issue}: ${desc}`, res.status, json);
  }
  return json;
}

// ---------- mock ----------

const mockStore = new Map();
const mockId = (prefix, len = 17) =>
  prefix + crypto.randomBytes(16).toString('hex').toUpperCase().slice(0, len);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function mockCall(method, path, status, fn) {
  const started = Date.now();
  await delay(180 + Math.random() * 220);
  const out = fn();
  events.emit('call', { mode, method, path, status, ms: Date.now() - started, debugId: 'mock-' + mockId('', 8) });
  return out;
}

// ---------- order body ----------

function purchaseUnit({ amount, currency, payeeEmail, description, referenceId, items }) {
  const unit = {
    reference_id: referenceId,
    description: description?.slice(0, 127),
    custom_id: referenceId,
    soft_descriptor: 'PAYD',
    amount: { currency_code: currency, value: amount },
  };
  if (payeeEmail) unit.payee = { email_address: payeeEmail };
  if (items?.length) {
    const lines = items.map((it) => ({
      name: String(it.name).slice(0, 127),
      quantity: String(it.qty || 1),
      unit_amount: { currency_code: currency, value: Number(it.unitPrice).toFixed(2) },
    }));
    const itemTotal = lines.reduce(
      (s, l) => s + Math.round(Number(l.unit_amount.value) * 100) * Number(l.quantity),
      0,
    );
    // PayPal requires the breakdown to add up exactly; only send line items when it does.
    if (itemTotal === Math.round(Number(amount) * 100)) {
      unit.items = lines;
      unit.amount.breakdown = { item_total: { currency_code: currency, value: amount } };
    }
  }
  return unit;
}

/**
 * Create an order the payer approves with the PayPal JS SDK.
 * If vault is enabled, the payer's PayPal wallet is saved on success so the
 * next tap can be charged instantly (Apple-Pay-like one-tap).
 */
export async function createOrder(opts) {
  const { amount, currency = 'USD', referenceId, returnUrl, cancelUrl } = opts;
  if (mode === 'mock') {
    return mockCall('POST', '/v2/checkout/orders', 201, () => {
      const id = mockId('');
      const order = { id, status: 'CREATED', amount, currency, referenceId, payee: opts.payeeEmail || null };
      mockStore.set(id, order);
      return order;
    });
  }
  const experience = {
    brand_name: 'Payd',
    shipping_preference: 'NO_SHIPPING',
    user_action: 'PAY_NOW',
    return_url: returnUrl,
    cancel_url: cancelUrl,
  };
  const body = {
    intent: 'CAPTURE',
    purchase_units: [purchaseUnit(opts)],
    payment_source: {
      paypal: {
        experience_context: experience,
        ...(VAULT_ENABLED
          ? { attributes: { vault: { store_in_vault: 'ON_SUCCESS', usage_type: 'MERCHANT', customer_type: 'CONSUMER' } } }
          : {}),
      },
    },
  };
  try {
    return await api('POST', '/v2/checkout/orders', body, { requestId: `order-${referenceId}` });
  } catch (err) {
    // Sandbox apps without "Save payment methods" enabled reject vault attributes: retry without.
    if (VAULT_ENABLED && err.status && err.status < 500) {
      delete body.payment_source.paypal.attributes;
      return api('POST', '/v2/checkout/orders', body, { requestId: `order-nv-${referenceId}` });
    }
    throw err;
  }
}

export async function captureOrder(orderId) {
  if (mode === 'mock') {
    return mockCall('POST', `/v2/checkout/orders/${orderId}/capture`, 201, () => {
      const order = mockStore.get(orderId);
      if (!order) throw new PayPalError('RESOURCE_NOT_FOUND: order not found', 404);
      order.status = 'COMPLETED';
      order.captureId = mockId('', 17);
      return {
        id: orderId,
        status: 'COMPLETED',
        payment_source: { paypal: { attributes: { vault: { id: 'mockvault_' + mockId('', 10), status: 'VAULTED' } } } },
        purchase_units: [
          { payments: { captures: [{ id: order.captureId, status: 'COMPLETED', amount: { value: order.amount, currency_code: order.currency } }] } },
        ],
      };
    });
  }
  return api('POST', `/v2/checkout/orders/${orderId}/capture`, {}, { requestId: `capture-${orderId}` });
}

/** One-tap payment with a previously vaulted PayPal wallet (no buyer redirect). */
export async function chargeVault(opts) {
  const { vaultId, referenceId } = opts;
  if (mode === 'mock') {
    return mockCall('POST', '/v2/checkout/orders', 201, () => {
      const captureId = mockId('', 17);
      return {
        id: mockId(''),
        status: 'COMPLETED',
        purchase_units: [{ payments: { captures: [{ id: captureId, status: 'COMPLETED' }] } }],
      };
    });
  }
  const body = {
    intent: 'CAPTURE',
    purchase_units: [purchaseUnit(opts)],
    payment_source: { paypal: { vault_id: vaultId } },
  };
  let order = await api('POST', '/v2/checkout/orders', body, { requestId: `vault-${referenceId}` });
  if (order.status === 'APPROVED') order = await captureOrder(order.id);
  if (order.status !== 'COMPLETED') {
    throw new PayPalError(`VAULT_CHARGE_${order.status}: vaulted payment needs buyer approval`, 422, order);
  }
  return order;
}

export async function refundCapture(captureId, { amount, currency = 'USD', note } = {}) {
  if (mode === 'mock') {
    return mockCall('POST', `/v2/payments/captures/${captureId}/refund`, 201, () => ({
      id: mockId('', 17),
      status: 'COMPLETED',
    }));
  }
  const body = {};
  if (amount) body.amount = { value: amount, currency_code: currency };
  if (note) body.note_to_payer = note.slice(0, 255);
  return api('POST', `/v2/payments/captures/${captureId}/refund`, body, {
    requestId: `refund-${captureId}-${amount || 'full'}`,
  });
}

export async function createPayout({ email, amount, currency = 'USD', note, referenceId }) {
  if (mode === 'mock') {
    return mockCall('POST', '/v1/payments/payouts', 201, () => ({
      batch_header: { payout_batch_id: mockId('', 13), batch_status: 'SUCCESS' },
    }));
  }
  return api(
    'POST',
    '/v1/payments/payouts',
    {
      sender_batch_header: {
        sender_batch_id: `payd-${referenceId}`,
        email_subject: 'You received a payout via Payd',
        email_message: note || 'Sent with Payd',
      },
      items: [
        {
          recipient_type: 'EMAIL',
          amount: { value: amount, currency },
          receiver: email,
          note: note || 'Sent with Payd',
          sender_item_id: referenceId,
        },
      ],
    },
    { requestId: `payout-${referenceId}` },
  );
}

export function extractCapture(order) {
  const capture = order?.purchase_units?.[0]?.payments?.captures?.[0];
  const vault = order?.payment_source?.paypal?.attributes?.vault;
  const payer = order?.payer || order?.payment_source?.paypal;
  return {
    orderId: order?.id,
    captureId: capture?.id || null,
    status: capture?.status || order?.status,
    vaultId: vault?.status === 'VAULTED' ? vault.id : null,
    payerEmail: payer?.email_address || null,
  };
}
