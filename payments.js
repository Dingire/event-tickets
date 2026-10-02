/**
 * Provider facade. Everything above this file talks only to the normalised shapes the
 * modules in providers/ export, so switching gateways is a PAYMENT_PROVIDER value in
 * the environment rather than a code change.
 */
const { CURRENCY, PaymentError, isValidAccountNumber } = require('./providers/shared');

const PROVIDERS = {
  elicate: require('./providers/elicate'),
  flutterwave: require('./providers/flutterwave'),
};

const requested = String(process.env.PAYMENT_PROVIDER || '').trim().toLowerCase();
const chosen = PROVIDERS[requested] || (process.env.PAYMENT_PROVIDER ? null : PROVIDERS.elicate);

if (!chosen) {
  throw new Error(`Unknown PAYMENT_PROVIDER "${process.env.PAYMENT_PROVIDER}". Use one of: ${Object.keys(PROVIDERS).join(', ')}.`);
}

module.exports = {
  CURRENCY,
  PaymentError,
  isValidAccountNumber,
  name: chosen.name,
  displayName: chosen.displayName,
  envKeys: chosen.envKeys,
  webhookPath: chosen.envKeys.webhookPath,
  isConfigured: chosen.isConfigured,
  isWebhookConfigured: chosen.isWebhookConfigured,
  charge: chosen.charge,
  verify: chosen.verify,
  getBalance: chosen.getBalance,
  createTransfer: chosen.createTransfer,
  getTransfer: chosen.getTransfer,
  webhookSecretValid: chosen.webhookSecretValid,
  parseWebhook: chosen.parseWebhook,
};
