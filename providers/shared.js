/**
 * Pieces that are identical whichever gateway is in use: the ZMW currency, phone
 * normalisation, amount validation and the error type. Keeping them here means a
 * provider module only has to describe what is genuinely different about its API.
 */

const CURRENCY = 'ZMW';

class PaymentError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'PaymentError';
    this.detail = detail;
  }
}

function countryCode() {
  const cc = String(process.env.MM_COUNTRY_CODE || '+260').replace(/\D/g, '');
  return cc || '260';
}

/**
 * Zambian mobile numbers arrive in every shape a customer might type: 0971234567,
 * +260971234567, 260 971 234 567. Providers disagree about which they want, so we
 * resolve once and expose each form rather than re-parsing at every call site.
 */
function parsePhone(phone) {
  const cc = countryCode();
  let digits = String(phone == null ? '' : phone).replace(/\D/g, '');
  if (!digits) throw new PaymentError('A mobile number is required to charge your wallet.');
  if (digits.startsWith(cc) && digits.length > cc.length + 6) digits = digits.slice(cc.length);
  digits = digits.replace(/^0/, '');
  if (digits.length < 9) throw new PaymentError('That mobile number looks too short.');
  return {
    cc,
    national: digits,
    local: `0${digits}`,
    e164: `${cc}${digits}`,
    international: `+${cc}${digits}`,
  };
}

/**
 * Flutterwave treats ZMW as a whole-unit currency: 1500 means K1500, not K15.00.
 * Our orders store whole kwacha, so the integer passes through unchanged. Every
 * verify() re-checks the returned amount against the order, so a wrong assumption
 * here can never issue unpaid tickets.
 */
function toAmountUnits(kwacha) {
  const n = Math.round(Number(kwacha));
  if (!Number.isFinite(n) || n <= 0) {
    throw new PaymentError('Charge amount must be a positive whole number of kwacha.');
  }
  return n;
}

function numberOr(value, fallback) {
  const v = value === undefined || value === null || value === '' ? fallback : value;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isValidAccountNumber(accountNumber) {
  return /^\d{6,20}$/.test(String(accountNumber || '').replace(/\s/g, ''));
}

function methodFor(method) {
  const key = String(method || '').toLowerCase();
  if (key !== 'mtn' && key !== 'airtel' && key !== 'zamtel') {
    throw new PaymentError('Choose a supported mobile money network.');
  }
  return key;
}

async function readJson(res, what) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new PaymentError(`${what} returned an unreadable response.`, { httpStatus: res.status });
  }
}

module.exports = {
  CURRENCY,
  PaymentError,
  countryCode,
  parsePhone,
  toAmountUnits,
  numberOr,
  isValidAccountNumber,
  methodFor,
  readJson,
};
