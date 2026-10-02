/**
 * Elicate Pay v1 client. A Zambian gateway covering MTN, Airtel and Zamtel with ZMW
 * settlement, self-service onboarding and a sandbox key prefix.
 *
 * Two behaviours differ enough from Flutterwave to be worth knowing about:
 *   - test-mode transactions settle with the status string "test success", which has
 *     to be treated as a real success or the sandbox can never complete a booking;
 *   - there is no balance endpoint and no merchant-visible charge fees per network, so
 *     balance degrades to null and the reported collection fee lands in app_fee.
 */
const crypto = require('crypto');
const {
  CURRENCY,
  PaymentError,
  parsePhone,
  toAmountUnits,
  numberOr,
  isValidAccountNumber,
  methodFor,
  readJson,
} = require('./shared');

const SECRET_KEY = String(process.env.ELICATE_SECRET_KEY || '').trim();
const WEBHOOK_SECRET = String(process.env.ELICATE_WEBHOOK_SECRET || '').trim();
const BASE_URL = (process.env.ELICATE_API_BASE || 'https://elicatepay.vercel.app/api/v1').replace(/\/+$/, '');

// Documented values are exactly MTN, AIRTEL, ZAMTEL in upper case.
const NETWORKS = { mtn: 'MTN', airtel: 'AIRTEL', zamtel: 'ZAMTEL' };

const name = 'elicate';
const displayName = 'Elicate Pay';

/**
 * Sandbox and live keys differ only by prefix, and a live key in a test run means real
 * money. Every diagnostic line therefore repeats which key is loaded.
 */
function keyMode() {
  if (SECRET_KEY.startsWith('ep_live_sk_')) return 'LIVE';
  if (SECRET_KEY.startsWith('ep_test_sk_')) return 'test';
  return 'unset';
}

/** A customer's mobile number is their personal data and has no business in a log file. */
function maskPhone(value) {
  const s = String(value == null ? '' : value);
  return s.length > 4 ? '*'.repeat(s.length - 4) + s.slice(-4) : '****';
}

/**
 * Announced once per process on the first API call. This is the one line to read when
 * asking "am I even pointed at the right environment?".
 */
let announced = false;
function announce() {
  if (announced) return;
  announced = true;
  console.log(`Elicate Pay client starting in ${keyMode()} mode against ${BASE_URL}`);
}

function isConfigured() {
  return SECRET_KEY.startsWith('ep_live_sk_') || SECRET_KEY.startsWith('ep_test_sk_');
}

function assertConfigured() {
  if (!isConfigured()) {
    throw new PaymentError('Payments are not configured. Set ELICATE_SECRET_KEY in your environment.');
  }
}

async function request(path, { method = 'GET', body } = {}) {
  assertConfigured();
  announce();
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = await readJson(res, 'Elicate Pay');
  if (!res.ok) {
    const message = json && (json.error || json.message);
    throw new PaymentError(message || 'Elicate Pay rejected the request.', {
      httpStatus: res.status,
      response: json,
    });
  }
  return json;
}

/**
 * Initiates the charge and returns the redirect the customer must complete. The
 * response status is only informational: payment is confirmed by verify() and the
 * webhook, never by this call.
 */
async function charge({ amount, phone, method, email, txRef, name: customerName, returnUrl }) {
  const body = {
    amount: toAmountUnits(amount),
    phone: parsePhone(phone).local,
    network: NETWORKS[methodFor(method)],
    currency: CURRENCY,
    reference: String(txRef),
    customer_name: String(customerName || '').trim().slice(0, 60) || 'Customer',
  };
  // Elicate's charge schema does not include redirect_url (only payment links do), so
  // this is very likely ignored. It is forwarded because Flutterwave does honour it and
  // would otherwise strand the customer with no way back. Do not rely on it for Elicate:
  // the webhook and the customer's own return visit are what settle the booking.
  if (returnUrl) body.redirect_url = returnUrl;

  const json = await request('/payments/charge', { method: 'POST', body });

  const auth = json.meta && json.meta.authorization;
  const redirect = auth && auth.redirect_url;

  // These field names are the single most likely thing to be wrong about a new
  // gateway, so the shape is logged on every charge. "MISSING" here is the signal that
  // the response needs its real field names substituted in above.
  console.log(
    `Elicate charge [${keyMode()}] ref=${body.reference}: ` +
      `top-level keys=[${Object.keys(json).join(',')}] ` +
      `transaction_id=${json.transaction_id == null ? 'MISSING' : json.transaction_id} ` +
      `meta.authorization.redirect_url=${redirect ? 'present' : 'MISSING'} ` +
      `phone_sent=${maskPhone(body.phone)}`
  );

  if (!redirect) {
    console.error(`Elicate charge for ${body.reference} returned no redirect. Raw response:`, JSON.stringify(json));
    throw new PaymentError('The payment could not be started. Please try again.', { response: json });
  }

  return {
    redirectUrl: redirect,
    txId: json.transaction_id ? String(json.transaction_id) : null,
    providerRef: json.reference ? String(json.reference) : null,
  };
}

/**
 * Authoritative confirmation. Elicate reconciles against Flutterwave on each read, so
 * this doubles as the poll the confirmation page depends on.
 */
async function verify({ txId, txRef, amount }) {
  if (!txId) {
    // No id means the charge never got far enough to be trackable; without one there is
    // no lookup-by-reference endpoint, so this cannot be confirmed and must not settle.
    throw new PaymentError('Cannot verify a payment without a transaction id.');
  }

  const json = await request(`/payments/${encodeURIComponent(txId)}`);
  const data = json.data && json.data.transaction_id ? json.data : json;
  const status = String(data.status || '').toLowerCase();

  console.log(
    `Elicate verify [${keyMode()}] tx=${txId}: status="${data.status}" amount=${data.amount} ` +
      `currency=${data.currency || '-'} reference=${data.reference || '-'} fee=${data.fee == null ? '-' : data.fee}`
  );

  const SUCCEEDED = ['success', 'test success'];
  if (!SUCCEEDED.includes(status)) {
    return {
      paid: false,
      status: status === 'failed' ? 'failed' : status || 'unknown',
      reason: status === 'failed' ? data.reason || 'Payment not completed.' : null,
      data,
    };
  }

  const expected = toAmountUnits(amount);
  if (Number(data.amount) !== expected) {
    throw new PaymentError('Payment amount did not match the booking.', {
      expected,
      received: Number(data.amount),
      data,
    });
  }
  if (data.currency && String(data.currency).toUpperCase() !== CURRENCY) {
    throw new PaymentError('Payment currency did not match the booking.', { received: data.currency, data });
  }
  if (txRef && data.reference && String(data.reference) !== String(txRef)) {
    throw new PaymentError('Payment reference did not match the booking.', { received: data.reference, data });
  }

  return {
    paid: true,
    status,
    // Elicate deducts a percentage collection fee at charge time rather than adding to
    // what the customer pays, so there is no customer-bearing case to detect.
    chargedAmount: numberOr(data.amount, expected),
    appFee: numberOr(data.fee),
    merchantFee: 0,
    data,
  };
}

/** No balance endpoint is published, so the dashboard hides the balance tile. */
async function getBalance() {
  return null;
}

async function createTransfer({ beneficiary, amount, reference, narration }) {
  if (!isValidAccountNumber(beneficiary.account_number)) {
    throw new PaymentError('That bank account number does not look right.');
  }
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    throw new PaymentError('Enter an amount greater than zero.');
  }
  if (!reference) throw new PaymentError('A payout reference is required.');

  const body = {
    amount: value,
    currency: CURRENCY,
    account_bank: String(beneficiary.account_bank || '').trim(),
    account_number: String(beneficiary.account_number || '').replace(/\s/g, ''),
    beneficiary_name: String(beneficiary.beneficiary_name || '').trim(),
    reference: String(reference),
    narration: String(narration || 'Event ticket payout').slice(0, 140),
  };

  const json = await request('/payouts', { method: 'POST', body });
  if (!json.payout_id) {
    throw new PaymentError('The payout was not accepted. Check your balance and details.', { response: json });
  }
  return {
    transferId: String(json.payout_id),
    status: transferStatusFrom(json.status),
    fee: numberOr(json.fee),
    bankName: json.account_bank || null,
  };
}

async function getTransfer(id) {
  const json = await request(`/payouts/${encodeURIComponent(id)}`);
  return {
    transferId: String(json.payout_id == null ? id : json.payout_id),
    status: transferStatusFrom(json.status),
    fee: numberOr(json.fee),
    completeMessage: json.flutterwave_status ? `Provider status: ${json.flutterwave_status}` : null,
  };
}

function transferStatusFrom(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'success') return 'completed';
  if (s === 'failed') return 'failed';
  return 'processing';
}

function isWebhookConfigured() {
  return Boolean(WEBHOOK_SECRET);
}

/**
 * Elicate signs the exact bytes it sent, so this needs the raw body rather than the
 * parsed object. server.js keeps a copy on req.rawBody for precisely this reason.
 */
function webhookSecretValid(req) {
  if (!WEBHOOK_SECRET) return false;
  const received = String(req.headers['x-elicatepay-signature'] || '');
  if (!received || !req.rawBody) return false;
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(req.rawBody).digest('hex');
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function parseWebhook(req) {
  const event = String((req.body && req.body.event) || '');
  const data = (req.body && req.body.data) || {};

  // Event names and payload keys are undocumented and may not match the docs. Logging
  // what actually arrives is how the mapping above gets corrected against real traffic.
  console.log(
    `Elicate webhook [${keyMode()}] event="${event || 'MISSING'}" ` +
      `body keys=[${Object.keys(req.body || {}).join(',')}] ` +
      `data keys=[${Object.keys(data).join(',')}] ` +
      `reference=${data.reference == null ? 'MISSING' : data.reference} ` +
      `transaction_id=${data.transaction_id == null ? '-' : data.transaction_id}`
  );

  if (event === 'payout.success' || event === 'payout.failed') {
    return {
      type: 'payout',
      succeeded: event === 'payout.success',
      reference: data.reference || null,
      providerId: data.payout_id == null ? null : String(data.payout_id),
      fee: numberOr(data.fee),
      message: data.flutterwave_status ? `Provider status: ${data.flutterwave_status}` : null,
    };
  }

  if (event === 'payment.test') {
    // Fired by POST /api/v1/webhooks/test to prove the URL and secret work. There is no
    // real transaction behind it, so acknowledging is the whole job.
    console.log(`Elicate test webhook [${keyMode()}] delivered and acknowledged.`);
    return null;
  }

  if (event !== 'payment.success' && event !== 'payment.failed') {
    console.error(`Elicate webhook event "${event}" is not mapped; ignored. Add it to parseWebhook if it is a real event.`);
    return null;
  }
  return {
    type: 'charge',
    succeeded: event === 'payment.success',
    reference: data.reference || null,
    providerId: data.transaction_id == null ? null : String(data.transaction_id),
    message: data.status || null,
  };
}

module.exports = {
  name,
  displayName,
  isConfigured,
  isWebhookConfigured,
  charge,
  verify,
  getBalance,
  createTransfer,
  getTransfer,
  webhookSecretValid,
  parseWebhook,
  envKeys: {
    secret: 'ELICATE_SECRET_KEY',
    webhookSecret: 'ELICATE_WEBHOOK_SECRET',
    webhookPath: '/elicate-webhook',
  },
};
