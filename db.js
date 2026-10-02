const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'events.db');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_ref   TEXT NOT NULL UNIQUE,
  phone         TEXT NOT NULL,
  email         TEXT NOT NULL DEFAULT '',
  method        TEXT NOT NULL,
  qty           INTEGER NOT NULL,
  amount        INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  created_at    TEXT NOT NULL,
  paid_at       TEXT,
  provider_tx_id TEXT,
  provider_ref   TEXT
);

CREATE TABLE IF NOT EXISTS tickets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   INTEGER NOT NULL REFERENCES orders(id),
  code       TEXT NOT NULL UNIQUE,
  status     TEXT NOT NULL DEFAULT 'unused',
  used_at    TEXT,
  scanned_by TEXT
);

CREATE TABLE IF NOT EXISTS beneficiaries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  label           TEXT NOT NULL,
  account_bank    TEXT NOT NULL,
  account_number  TEXT NOT NULL,
  beneficiary_name TEXT NOT NULL,
  is_default      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payouts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  reference         TEXT NOT NULL UNIQUE,
  beneficiary_id    INTEGER NOT NULL REFERENCES beneficiaries(id),
  amount            REAL NOT NULL,
  fee               REAL,
  currency          TEXT NOT NULL DEFAULT 'ZMW',
  narration         TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'pending',
  provider          TEXT,
  provider_transfer_id TEXT,
  complete_message  TEXT,
  initiated_by      TEXT NOT NULL DEFAULT '',
  initiated_ip      TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
`);

function columnExists(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

function addColumnIfMissing(table, column, definition) {
  if (columnExists(table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

addColumnIfMissing('orders', 'email', "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing('orders', 'provider_tx_id', 'TEXT');
addColumnIfMissing('orders', 'provider_ref', 'TEXT');
addColumnIfMissing('payouts', 'provider', 'TEXT');
addColumnIfMissing('payouts', 'provider_transfer_id', 'TEXT');

// Provider fee detail. REAL because a percentage fee on whole-kwacha prices is
// fractional (3% of 150 is 4.50). NULL means the provider has not reported it.
addColumnIfMissing('orders', 'charged_amount', 'REAL');
addColumnIfMissing('orders', 'app_fee', 'REAL');
addColumnIfMissing('orders', 'merchant_fee', 'REAL');
addColumnIfMissing('orders', 'currency', "TEXT NOT NULL DEFAULT 'ZMW'");

// Databases created before the provider switch stored gateway identifiers under
// Flutterwave-specific names. Carry them across once so in-flight charges and payouts
// stay reconcilable instead of being orphaned by a rename.
if (columnExists('orders', 'flw_tx_id')) {
  db.exec("UPDATE orders SET provider_tx_id = flw_tx_id WHERE provider_tx_id IS NULL AND flw_tx_id IS NOT NULL");
}
if (columnExists('orders', 'flw_ref')) {
  db.exec("UPDATE orders SET provider_ref = flw_ref WHERE provider_ref IS NULL AND flw_ref IS NOT NULL");
}
if (columnExists('payouts', 'flw_transfer_id')) {
  db.exec('UPDATE payouts SET provider_transfer_id = flw_transfer_id WHERE provider_transfer_id IS NULL AND flw_transfer_id IS NOT NULL');
  db.exec("UPDATE payouts SET provider = 'flutterwave' WHERE provider IS NULL AND flw_transfer_id IS NOT NULL");
}

const DEFAULTS = {
  eventName: 'Annual Community Festival',
  eventDate: '2026-12-05',
  eventTime: '16:00',
  venue: 'Lusaka Showgrounds',
  description:
    'A fun-filled day of live music, food, and activities for the whole family. Tickets are limited, so book early.',
  price: '150',
  totalTickets: '500',
  banner: '',
  currency: 'K',
};

const getSetting = (key) => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : undefined;
};

const setSetting = (key, value) => {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
};

for (const [k, v] of Object.entries(DEFAULTS)) {
  if (getSetting(k) === undefined) setSetting(k, v);
}

function getSettings() {
  const out = {};
  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    out[row.key] = row.value;
  }
  return { ...DEFAULTS, ...out };
}

function createOrder({ phone, email, method, qty, amount }) {
  const bookingRef = 'EVT-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  const createdAt = new Date().toISOString();
  const info = db
    .prepare(
      'INSERT INTO orders (booking_ref, phone, email, method, qty, amount, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(bookingRef, String(phone), String(email || ''), String(method), Number(qty), Number(amount), 'pending', createdAt);
  const orderId = Number(info.lastInsertRowid);
  const ins = db.prepare(
    'INSERT INTO tickets (order_id, code, status) VALUES (?, ?, ?)'
  );
  for (let i = 0; i < Number(qty); i++) {
    const code = 'ET-' + crypto.randomBytes(5).toString('hex').toUpperCase();
    ins.run(orderId, code, 'unused');
  }
  return getOrder(orderId);
}

function getOrder(id) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(id)) || null;
}

function getOrderByRef(ref) {
  return db.prepare('SELECT * FROM orders WHERE UPPER(booking_ref) = UPPER(?)').get(String(ref)) || null;
}

function getTicketsForOrder(orderId) {
  return db.prepare('SELECT * FROM tickets WHERE order_id = ? ORDER BY id').all(Number(orderId));
}

function getOrderWithTickets(id) {
  const order = getOrder(id);
  if (!order) return null;
  return { order, tickets: getTicketsForOrder(id) };
}

function markChargeStarted(id, { txId, providerRef }) {
  db.prepare("UPDATE orders SET status = 'processing', provider_tx_id = ?, provider_ref = ? WHERE id = ? AND status = 'pending'").run(
    txId ? String(txId) : null,
    providerRef ? String(providerRef) : null,
    Number(id)
  );
  return getOrder(id);
}

function markOrderPaid(id, fees) {
  const paidAt = new Date().toISOString();
  const f = fees || {};
  db.prepare(
    `UPDATE orders SET status = 'paid', paid_at = ?,
       charged_amount = ?, app_fee = ?, merchant_fee = ?
     WHERE id = ? AND status <> 'paid'`
  ).run(
    paidAt,
    numOrNull(f.chargedAmount),
    numOrNull(f.appFee),
    numOrNull(f.merchantFee),
    Number(id)
  );
  return getOrder(id);
}

function numOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function cancelOrder(id) {
  db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(Number(id));
  db.prepare('DELETE FROM tickets WHERE order_id = ?').run(Number(id));
  return getOrder(id);
}

function countSold() {
  const r = db.prepare("SELECT COALESCE(SUM(qty), 0) AS n FROM orders WHERE status = 'paid'").get();
  return Number(r.n);
}

function sumRevenue() {
  const r = db.prepare("SELECT COALESCE(SUM(amount), 0) AS n FROM orders WHERE status = 'paid'").get();
  return Number(r.n);
}

/**
 * What the provider actually kept. Gateways report this either split into a platform
 * fee and a merchant fee or as one combined figure; both land in app_fee and
 * merchant_fee. Orders where the provider has not reported a fee contribute their full
 * amount, which is the right fallback for legacy rows and any missing report.
 */
function sumFees() {
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(COALESCE(app_fee, 0) + COALESCE(merchant_fee, 0)), 0) AS n
       FROM orders WHERE status = 'paid'`
    )
    .get();
  return Number(r.n);
}

function sumNet() {
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(amount - COALESCE(app_fee, 0) - COALESCE(merchant_fee, 0)), 0) AS n
       FROM orders WHERE status = 'paid'`
    )
    .get();
  return Number(r.n);
}

/**
 * Detects the provider charging the customer rather than the merchant. When the
 * dashboard has "customer bears the charge" enabled, the customer is debited more
 * than the advertised ticket price, so charged_amount exceeds amount.
 */
function countCustomerBearingCharges() {
  const r = db
    .prepare(
      `SELECT COUNT(*) AS n FROM orders
       WHERE status = 'paid' AND charged_amount IS NOT NULL AND charged_amount > amount + 0.009`
    )
    .get();
  return Number(r.n);
}

function sumPaidOut() {
  const r = db
    .prepare("SELECT COALESCE(SUM(amount), 0) AS n FROM payouts WHERE status = 'completed'")
    .get();
  return Number(r.n);
}

/**
 * Tickets stay reserved while a charge is in flight. A `processing` order holds its
 * tickets regardless of age, because the customer may still be approving the payment
 * and the money may already have left their wallet.
 */
function countActivePending(minutes) {
  const cutoff = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(qty), 0) AS n FROM orders
       WHERE status = 'processing' OR (status = 'pending' AND created_at > ?)`
    )
    .get(cutoff);
  return Number(r.n);
}

/**
 * Only `pending` orders are safe to auto-cancel: no charge was ever started, so no
 * money can be outstanding. Cancelling an in-flight `processing` order would take
 * tickets away from a customer who already paid.
 */
function expireStalePending(minutes) {
  const cutoff = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  const stale = db
    .prepare("SELECT id FROM orders WHERE status = 'pending' AND created_at < ?")
    .all(cutoff);
  for (const row of stale) cancelOrder(row.id);
  return stale.length;
}

function getOrdersAwaitingConfirmation(minutes) {
  const cutoff = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  return db
    .prepare("SELECT * FROM orders WHERE status = 'processing' AND created_at < ? ORDER BY id")
    .all(cutoff);
}

function getOrders() {
  return db.prepare('SELECT * FROM orders ORDER BY id DESC').all();
}

function getAllTickets() {
  return db.prepare('SELECT * FROM tickets ORDER BY id DESC').all();
}

function getTicketByCode(code) {
  return db.prepare('SELECT * FROM tickets WHERE UPPER(code) = UPPER(?)').get(String(code)) || null;
}

function markTicketUsed(ticketId, scannedBy) {
  const usedAt = new Date().toISOString();
  const info = db
    .prepare("UPDATE tickets SET status = 'used', used_at = ?, scanned_by = ? WHERE id = ? AND status = 'unused'")
    .run(usedAt, String(scannedBy || ''), Number(ticketId));
  return Number(info.changes) > 0;
}

function addBeneficiary({ label, accountBank, accountNumber, beneficiaryName, makeDefault }) {
  const now = new Date().toISOString();
  const isFirst = countBeneficiaries() === 0;
  const isDefault = makeDefault || isFirst ? 1 : 0;
  if (isDefault) db.prepare('UPDATE beneficiaries SET is_default = 0').run();
  const info = db
    .prepare(
      'INSERT INTO beneficiaries (label, account_bank, account_number, beneficiary_name, is_default, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(
      String(label || '').trim().slice(0, 60),
      String(accountBank || '').trim().slice(0, 20),
      String(accountNumber || '').trim().slice(0, 40),
      String(beneficiaryName || '').trim().slice(0, 120),
      isDefault,
      now
    );
  return getBeneficiary(Number(info.lastInsertRowid));
}

function countBeneficiaries() {
  return Number(db.prepare('SELECT COUNT(*) AS n FROM beneficiaries').get().n);
}

function getBeneficiary(id) {
  return db.prepare('SELECT * FROM beneficiaries WHERE id = ?').get(Number(id)) || null;
}

function getBeneficiaries() {
  return db.prepare('SELECT * FROM beneficiaries ORDER BY is_default DESC, id').all();
}

function deleteBeneficiary(id) {
  const b = getBeneficiary(id);
  if (!b) return false;
  const used = Number(db.prepare('SELECT COUNT(*) AS n FROM payouts WHERE beneficiary_id = ?').get(Number(id)).n);
  // Never remove a beneficiary that money movement is already recorded against.
  if (used > 0) return false;
  db.prepare('DELETE FROM beneficiaries WHERE id = ?').run(Number(id));
  return true;
}

/**
 * Records the intended payout before the provider is called, so a crash or a lost
 * response still leaves an audit row rather than an unexplained gap in the books.
 * The unique reference is what stops a double-submit sending the money twice.
 * The provider is stamped on the row because switching gateways must not make an
 * in-flight payout look like it failed: its id only means anything to the gateway
 * that issued it.
 */
function createPayout({ beneficiaryId, amount, narration, initiatedBy, initiatedIp, provider }) {
  const now = new Date().toISOString();
  const reference = 'PO-' + crypto.randomBytes(5).toString('hex').toUpperCase();
  const info = db
    .prepare(
      'INSERT INTO payouts (reference, beneficiary_id, amount, narration, status, provider, initiated_by, initiated_ip, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      reference,
      Number(beneficiaryId),
      Number(amount),
      String(narration || '').trim().slice(0, 140),
      'pending',
      String(provider || '').trim().slice(0, 40) || null,
      String(initiatedBy || '').slice(0, 60),
      String(initiatedIp || '').slice(0, 60),
      now,
      now
    );
  return getPayout(Number(info.lastInsertRowid));
}

function getPayout(id) {
  return db.prepare('SELECT * FROM payouts WHERE id = ?').get(Number(id)) || null;
}

function getPayoutByRef(reference) {
  return db.prepare('SELECT * FROM payouts WHERE UPPER(reference) = UPPER(?)').get(String(reference)) || null;
}

function getPayouts() {
  return db.prepare('SELECT * FROM payouts ORDER BY id DESC').all();
}

function getPayoutsInFlight() {
  return db.prepare("SELECT * FROM payouts WHERE status IN ('pending', 'processing') ORDER BY id").all();
}

function markPayoutProcessing(id, transferId) {
  db.prepare("UPDATE payouts SET status = 'processing', provider_transfer_id = ?, updated_at = ? WHERE id = ?").run(
    transferId ? String(transferId) : null,
    new Date().toISOString(),
    Number(id)
  );
  return getPayout(id);
}

function markPayout(id, { status, fee, completeMessage, transferId }) {
  db.prepare(
    `UPDATE payouts SET status = ?, fee = COALESCE(?, fee), complete_message = COALESCE(?, complete_message),
       provider_transfer_id = COALESCE(?, provider_transfer_id), updated_at = ? WHERE id = ?`
  ).run(
    String(status),
    fee === undefined || fee === null ? null : Number(fee),
    completeMessage === undefined || completeMessage === null ? null : String(completeMessage).slice(0, 200),
    transferId === undefined || transferId === null ? null : String(transferId),
    new Date().toISOString(),
    Number(id)
  );
  return getPayout(id);
}

module.exports = {
  raw: db,
  dataDir: DATA_DIR,
  getSettings,
  setSetting,
  createOrder,
  getOrder,
  getOrderByRef,
  getOrderWithTickets,
  markChargeStarted,
  markOrderPaid,
  cancelOrder,
  countSold,
  sumRevenue,
  sumFees,
  sumNet,
  sumPaidOut,
  countCustomerBearingCharges,
  countActivePending,
  expireStalePending,
  getOrdersAwaitingConfirmation,
  getOrders,
  getAllTickets,
  getTicketByCode,
  markTicketUsed,
  addBeneficiary,
  countBeneficiaries,
  getBeneficiary,
  getBeneficiaries,
  deleteBeneficiary,
  createPayout,
  getPayout,
  getPayoutByRef,
  getPayouts,
  getPayoutsInFlight,
  markPayoutProcessing,
  markPayout,
};