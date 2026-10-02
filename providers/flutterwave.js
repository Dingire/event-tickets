/**
 * Flutterwave v3 client. Kept intact behind the provider facade because it remains the
 * right gateway if the account ever reaches the enterprise volume tier.
 */
const crypto = require('crypto');
const {
  CURRENCY,
  PaymentError,
  countryCode,
  parsePhone,
  toAmountUnits,
  numberOr,
  isValidAccountNumber,
  methodFor,
  readJson,
} = require('./shared');

const SECRET_KEY = String(process.env.FLW_SECRET_KEY || '').trim();
const SECRET_HASH = String(process.env.FLW_SECRET_HASH || '').trim();
const BASE_URL = (process.env.FLW_API_BASE || 'https://api.flutterwave.com/v3').replace(/\/+$/, '');

// Values per the documented enum for /charges?type=mobile_money_zambia: ["MTN","Airtel","Zamtel"].
// The prose in Flutterwave's docs shows these in upper case, so each one can be
// overridden with FLW_NETWORK_<NAME> if your account rejects a given spelling.
function networkValue(name, fallback) {
  return String(process.env[`FLW_NETWORK_${name}`] || fallback).trim();
}

const NETWORKS = {
  mtn: networkValue('MTN', 'MTN'),
  airtel: networkValue('AIRTEL', 'Airtel'),
  zamtel: networkValue('ZAMTEL', 'Zamtel'),
};

const name = 'flutterwave';
const displayName = 'Flutterwave';

function isConfigured() {
  return SECRET_KEY.startsWith('FLWSECK_');
}

function assertConfigured() {
  if (!isConfigured()) {
    throw new PaymentError('Payments are not configured. Set FLW_SECRET_KEY in your environment.');
  }
}

async function request(path, { method = 'GET', body } = {}) {
  assertConfigured();
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = await readJson(res, 'Payments provider');
  if (!res.ok) {
    throw new PaymentError(json.message || 'Payments provider rejected the request.', {
      httpStatus: res.status,
      response: json,
    });
  }
  return json;
}

/**
 * Initiates a Zambian mobile money charge. The customer authorises on their handset
 * via the returned redirect URL; final status is confirmed by verify() on return
 * and again on the webhook.
 */
async function charge({ amount, phone, method, email, txRef, name: customerName, returnUrl, clientIp }) {
  const payload = {
    tx_ref: txRef,
    order_id: txRef,
    amount: toAmountUnits(amount),
    currency: CURRENCY,
    email: String(email || '').trim(),
    phone_number: parsePhone(phone).e164,
    network: NETWORKS[methodFor(method)],
  };
  if (customerName) payload.fullname = String(customerName).trim().slice(0, 60);
  if (clientIp) payload.client_ip = String(clientIp).replace(/[^0-9a-fA-F.:]/g, '').slice(0, 45);
  // Not in the documented request schema, but accepted by the charge endpoint on
  // live accounts and harmless otherwise. The webhook is the reliable settlement path.
  if (returnUrl) payload.redirect_url = returnUrl;

  const json = await request('/charges?type=mobile_money_zambia', { method: 'POST', body: payload });

  const redirect = json.meta && json.meta.authorization && json.meta.authorization.redirect;
  if (!redirect) {
    throw new PaymentError('The payment could not be started. Please try again.', { response: json });
  }

  const data = json.data || {};
  return {
    redirectUrl: redirect,
    txId: data.id ? String(data.id) : null,
    providerRef: data.flw_ref ? String(data.flw_ref) : null,
  };
}

/**
 * Server-side confirmation. Never trust a webhook body or a customer-facing redirect
 * on its own: the transaction is re-read from the provider and matched against the
 * amount, currency and reference we expect before we treat it as paid.
 */
async function verify({ txId, txRef, amount }) {
  let json;
  if (txId) {
    json = await request(`/transactions/${encodeURIComponent(txId)}/verify`);
  } else if (txRef) {
    json = await request(`/transactions/verify_by_reference?tx_ref=${encodeURIComponent(txRef)}`);
  } else {
    throw new PaymentError('Cannot verify a payment without a transaction id or reference.');
  }

  const data = json.data || {};
  const status = String(data.status || '').toLowerCase();

  if (status !== 'successful') {
    return { paid: false, status: status || 'unknown', reason: data.processor_response || 'Payment not completed.', data };
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
  if (txRef && data.tx_ref && String(data.tx_ref) !== String(txRef)) {
    throw new PaymentError('Payment reference did not match the booking.', { received: data.tx_ref, data });
  }

  return {
    paid: true,
    status,
    chargedAmount: numberOr(data.charged_amount, data.amount),
    appFee: numberOr(data.app_fee),
    merchantFee: numberOr(data.merchant_fee),
    data,
  };
}

async function getBalance() {
  const json = await request('/balance');
  const data = json.data || {};
  return { available: Number(data.available || 0), ledger: Number(data.ledger || 0) };
}

/**
 * Moves real money, so the guards here are deliberately strict. Only pre-registered
 * beneficiaries reach this function (see the admin route), the amount must be a
 * positive number of kwacha, and the caller's reference must be a fresh payout row.
 */
async function createTransfer({ beneficiary, amount, reference, narration, destinationBranchCode }) {
  if (!isValidAccountNumber(beneficiary.account_number)) {
    throw new PaymentError('That bank account number does not look right.');
  }
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    throw new PaymentError('Enter an amount greater than zero.');
  }
  if (!reference) throw new PaymentError('A payout reference is required.');

  const body = {
    account_bank: String(beneficiary.account_bank || '').trim(),
    account_number: String(beneficiary.account_number || '').replace(/\s/g, ''),
    beneficiary_name: String(beneficiary.beneficiary_name || '').trim(),
    amount: value,
    currency: CURRENCY,
    reference,
    narration: String(narration || 'Event ticket payout').slice(0, 140),
  };
  if (destinationBranchCode) body.destination_branch_code = String(destinationBranchCode).trim();

  const json = await request('/transfers', { method: 'POST', body });
  const data = json.data || {};
  if (!data.id) {
    throw new PaymentError('The payout was not accepted. Check your balance and details.', { response: json });
  }
  return {
    transferId: String(data.id),
    status: transferStatusFrom(data.status),
    fee: numberOr(data.fee),
    bankName: data.bank_name || null,
  };
}

async function getTransfer(id) {
  const json = await request(`/transfers/${encodeURIComponent(id)}`);
  const data = json.data || {};
  return {
    transferId: String(data.id == null ? id : data.id),
    status: transferStatusFrom(data.status),
    fee: numberOr(data.fee),
    completeMessage: data.complete_message ? String(data.complete_message) : null,
  };
}

/** Collapses each provider's transfer vocabulary onto our three payout states. */
function transferStatusFrom(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'successful' || s === 'completed' || s === 'success') return 'completed';
  if (s === 'failed' || s === 'reversed' || s === 'cancelled') return 'failed';
  return 'processing';
}

function isWebhookConfigured() {
  return Boolean(SECRET_HASH);
}

function webhookSecretValid(req) {
  if (!SECRET_HASH) return false;
  const received = String(req.headers['verif-hash'] || '');
  const a = Buffer.from(received);
  const b = Buffer.from(SECRET_HASH);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Normalises Flutterwave's two webhook families onto the shape server.js handles,
 * so the route itself never needs to know which gateway is live.
 */
function parseWebhook(req) {
  const event = String((req.body && req.body.event) || '');
  const data = (req.body && req.body.data) || {};

  if (event === 'transfer.completed' || event === 'transfer.failed') {
    const succeeded = event === 'transfer.completed' && String(data.status || '').toLowerCase() === 'successful';
    return {
      type: 'payout',
      succeeded,
      reference: data.reference || data.tx_ref || null,
      providerId: data.id == null ? null : String(data.id),
      fee: numberOr(data.fee),
      message: data.complete_message || data.complete_message_text || data.processor_response || null,
    };
  }

  if (event !== 'charge.completed') return null;
  return {
    type: 'charge',
    succeeded: String(data.status || '').toLowerCase() === 'successful',
    reference: data.tx_ref || null,
    providerId: data.id == null ? null : String(data.id),
    message: data.processor_response || null,
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
    secret: 'FLW_SECRET_KEY',
    webhookSecret: 'FLW_SECRET_HASH',
    webhookPath: '/flw-webhook',
  },
};
