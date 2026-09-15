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
  method        TEXT NOT NULL,
  qty           INTEGER NOT NULL,
  amount        INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  created_at    TEXT NOT NULL,
  paid_at       TEXT
);

CREATE TABLE IF NOT EXISTS tickets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   INTEGER NOT NULL REFERENCES orders(id),
  code       TEXT NOT NULL UNIQUE,
  status     TEXT NOT NULL DEFAULT 'unused',
  used_at    TEXT,
  scanned_by TEXT
);
`);

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

function createOrder({ phone, method, qty, amount }) {
  const bookingRef = 'EVT-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  const createdAt = new Date().toISOString();
  const info = db
    .prepare(
      'INSERT INTO orders (booking_ref, phone, method, qty, amount, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(bookingRef, String(phone), String(method), Number(qty), Number(amount), 'pending', createdAt);
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

function markOrderPaid(id) {
  const paidAt = new Date().toISOString();
  db.prepare("UPDATE orders SET status = 'paid', paid_at = ? WHERE id = ?").run(paidAt, Number(id));
  return getOrder(id);
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

function countActivePending(minutes) {
  const cutoff = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  const r = db
    .prepare("SELECT COALESCE(SUM(qty), 0) AS n FROM orders WHERE status = 'pending' AND created_at > ?")
    .get(cutoff);
  return Number(r.n);
}

function expireStalePending(minutes) {
  const cutoff = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  const stale = db
    .prepare("SELECT id FROM orders WHERE status = 'pending' AND created_at < ?")
    .all(cutoff);
  for (const row of stale) cancelOrder(row.id);
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

module.exports = {
  getSettings,
  setSetting,
  createOrder,
  getOrder,
  getOrderByRef,
  getOrderWithTickets,
  markOrderPaid,
  cancelOrder,
  countSold,
  sumRevenue,
  countActivePending,
  expireStalePending,
  getOrders,
  getAllTickets,
  getTicketByCode,
  markTicketUsed,
};