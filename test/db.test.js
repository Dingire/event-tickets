/**
 * Unit coverage for the money maths and the data-layer guarantees the dashboard and
 * payout flow depend on. Each suite runs against its own throwaway database so the
 * real data/events.db is never touched.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tickets-db-'));
  process.env.DATA_DIR = dir;
  for (const key of Object.keys(require.cache)) {
    if (key.includes('db.js')) delete require.cache[key];
  }
  return { store: require('../db'), dir };
}

test('money aggregations separate gross, fees and net', () => {
  const { store } = freshStore();
  const a = store.createOrder({ phone: '260955000001', email: 'a@example.com', method: 'zmw', qty: 2, amount: 300 });
  const b = store.createOrder({ phone: '260955000002', email: 'b@example.com', method: 'zmw', qty: 1, amount: 150 });
  store.markChargeStarted(a.id, { txId: 111, providerRef: 'a' });
  store.markChargeStarted(b.id, { txId: 222, providerRef: 'b' });
  store.markOrderPaid(a.id, { chargedAmount: 300, appFee: 9, merchantFee: 0 });
  store.markOrderPaid(b.id, { chargedAmount: 154.5, appFee: 0, merchantFee: 4.5 });
  assert.equal(store.sumRevenue(), 450, 'gross is the advertised ticket total');
  assert.equal(store.sumFees(), 13.5, 'fees are what the provider kept');
  assert.equal(store.sumNet(), 436.5, 'net is gross minus fees');
});

test('unreported fees do not silently inflate net', () => {
  const { store } = freshStore();
  const o = store.createOrder({ phone: '260955000003', email: 'c@example.com', method: 'zmw', qty: 1, amount: 150 });
  store.markOrderPaid(o.id, {});
  // A paid order with no provider fee report must contribute zero fees, not crash.
  assert.equal(store.sumFees(), 0);
  assert.equal(store.sumNet(), 150);
});

test('markOrderPaid is idempotent and does not double count', () => {
  const { store } = freshStore();
  const o = store.createOrder({ phone: '260955000004', email: 'd@example.com', method: 'zmw', qty: 1, amount: 150 });
  store.markOrderPaid(o.id, { chargedAmount: 150, appFee: 4.5 });
  store.markOrderPaid(o.id, { chargedAmount: 150, appFee: 4.5 });
  store.markOrderPaid(o.id, { chargedAmount: 150, appFee: 4.5 });
  assert.equal(store.sumRevenue(), 150);
  assert.equal(store.sumFees(), 4.5);
});

test('customer-bearing charges are detected', () => {
  const { store } = freshStore();
  assert.equal(store.countCustomerBearingCharges(), 0);

  const over = store.createOrder({ phone: '260955000005', email: 'e@example.com', method: 'zmw', qty: 1, amount: 150 });
  const normal = store.createOrder({ phone: '260955000006', email: 'f@example.com', method: 'zmw', qty: 1, amount: 150 });

  // Merchant absorbs the fee: charged amount equals the advertised price.
  store.markOrderPaid(over.id, { chargedAmount: 150, appFee: 4.5 });
  // Customer bears the fee: the customer is debited more than advertised.
  store.markOrderPaid(normal.id, { chargedAmount: 154.5 });

  assert.equal(store.countCustomerBearingCharges(), 1);
});

test('pending reservations never count as sold and only pending can expire', () => {
  const { store } = freshStore();
  const pending = store.createOrder({ phone: '260955000007', email: 'g@example.com', method: 'zmw', qty: 3, amount: 450 });
  const processing = store.createOrder({ phone: '260955000008', email: 'h@example.com', method: 'zmw', qty: 2, amount: 300 });
  store.markChargeStarted(processing.id, { txId: 333, providerRef: 'c' });

  assert.equal(store.countActivePending(15), 5, 'both are held against stock');
  assert.equal(store.countSold(), 0);

  // Backdate, then confirm expiry only releases the order that never took money.
  store.raw.prepare('UPDATE orders SET created_at = ? WHERE id = ?').run(
    new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    pending.id
  );
  assert.equal(store.expireStalePending(15), 1);
  assert.equal(store.getOrder(pending.id).status, 'cancelled');
  assert.equal(store.getOrder(processing.id).status, 'processing', 'a charged order keeps its tickets');
});

test('beneficiaries: first is default, used ones are protected', () => {
  const { store } = freshStore();
  const first = store.addBeneficiary({ label: 'Event account', accountBank: 'ZMB', accountNumber: '001122334455', beneficiaryName: 'Community Festival' });
  assert.equal(first.is_default, 1);

  const second = store.addBeneficiary({ label: 'Spare', accountBank: 'ZMB', accountNumber: '998877665544', beneficiaryName: 'Festival Spare' });
  assert.equal(second.is_default, 0);

  store.createPayout({ beneficiaryId: first.id, amount: 500, initiatedBy: 'admin' });
  assert.equal(store.deleteBeneficiary(first.id), false, 'cannot delete a beneficiary with payout history');
  assert.equal(store.deleteBeneficiary(second.id), true);
});

test('payouts record an audit trail and track what left the account', () => {
  const { store } = freshStore();
  const b = store.addBeneficiary({ label: 'Event account', accountBank: 'ZMB', accountNumber: '001122334455', beneficiaryName: 'Festival' });
  const p = store.createPayout({ beneficiaryId: b.id, amount: 250.5, narration: 'Sales', initiatedBy: 'admin', initiatedIp: '127.0.0.1', provider: 'elicate' });

  assert.match(p.reference, /^PO-[0-9A-F]{10}$/);
  assert.equal(p.status, 'pending');
  assert.equal(p.provider, 'elicate', 'the issuing gateway is recorded on the row');
  assert.equal(store.sumPaidOut(), 0, 'a pending payout has not left the account');

  store.markPayoutProcessing(p.id, 'tr_123');
  assert.equal(store.sumPaidOut(), 0, 'still in flight, not yet counted as gone');

  store.markPayout(p.id, { status: 'completed', fee: 5, completeMessage: 'Sent' });
  assert.equal(store.getPayout(p.id).status, 'completed');
  assert.equal(store.getPayout(p.id).provider_transfer_id, 'tr_123', 'transfer id is preserved');
  assert.equal(store.sumPaidOut(), 250.5);

  const failed = store.createPayout({ beneficiaryId: b.id, amount: 10, initiatedBy: 'admin' });
  store.markPayout(failed.id, { status: 'failed', completeMessage: 'Insufficient balance' });
  assert.equal(store.sumPaidOut(), 250.5, 'a failed payout is not money out');
});

test('in-flight payouts are enumerable for reconciliation', () => {
  const { store } = freshStore();
  const b = store.addBeneficiary({ label: 'Event account', accountBank: 'ZMB', accountNumber: '001122334455', beneficiaryName: 'Festival' });
  const a = store.createPayout({ beneficiaryId: b.id, amount: 100, initiatedBy: 'admin' });
  const c = store.createPayout({ beneficiaryId: b.id, amount: 200, initiatedBy: 'admin' });
  const d = store.createPayout({ beneficiaryId: b.id, amount: 300, initiatedBy: 'admin' });
  store.markPayout(d.id, { status: 'completed' });

  const ids = store.getPayoutsInFlight().map((p) => p.id).sort();
  assert.deepEqual(ids, [a.id, c.id].sort(), 'completed payouts drop out of the worklist');
});

test('legacy databases migrate without losing orders', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tickets-legacy-'));
  const file = path.join(dir, 'events.db');
  process.env.DATA_DIR = dir;
  for (const key of Object.keys(require.cache)) if (key.includes('db.js')) delete require.cache[key];
  const { DatabaseSync } = require('node:sqlite');

  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT, booking_ref TEXT NOT NULL UNIQUE, phone TEXT NOT NULL,
      method TEXT NOT NULL, qty INTEGER NOT NULL, amount INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, paid_at TEXT
    );
    CREATE TABLE tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, code TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'unused', used_at TEXT, scanned_by TEXT
    );
    INSERT INTO orders (booking_ref, phone, method, qty, amount, status, created_at)
      VALUES ('OLD-1', '260955111111', 'zmw', 1, 150, 'paid', '2026-01-01T00:00:00.000Z');
  `);
  legacy.close();

  const store = require('../db');
  const old = store.getOrderByRef('OLD-1');
  assert.equal(old.status, 'paid');
  assert.equal(old.amount, 150);
  assert.equal(old.charged_amount, null, 'fee columns start empty for historical orders');
  assert.equal(store.sumRevenue(), 150, 'legacy revenue still totals');
  assert.equal(store.sumFees(), 0);
  assert.ok(store.getBeneficiaries().length === 0);

  // The temp directory is left in place on purpose: the module still holds the SQLite
  // file open, and Windows refuses to delete an open file.
});

test('gateway ids written under the old Flutterwave names survive the rename', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tickets-flw-legacy-'));
  const file = path.join(dir, 'events.db');
  process.env.DATA_DIR = dir;
  for (const key of Object.keys(require.cache)) if (key.includes('db.js')) delete require.cache[key];
  const { DatabaseSync } = require('node:sqlite');

  // A database written by the pre-switch schema, mid-flight on both a charge and a payout.
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT, booking_ref TEXT NOT NULL UNIQUE, phone TEXT NOT NULL,
      method TEXT NOT NULL, qty INTEGER NOT NULL, amount INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, paid_at TEXT,
      flw_tx_id TEXT, flw_ref TEXT
    );
    CREATE TABLE tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, code TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'unused', used_at TEXT, scanned_by TEXT
    );
    CREATE TABLE beneficiaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, account_bank TEXT NOT NULL,
      account_number TEXT NOT NULL, beneficiary_name TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE payouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, reference TEXT NOT NULL UNIQUE,
      beneficiary_id INTEGER NOT NULL, amount REAL NOT NULL, fee REAL,
      currency TEXT NOT NULL DEFAULT 'ZMW', narration TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending', flw_transfer_id TEXT, complete_message TEXT,
      initiated_by TEXT NOT NULL DEFAULT '', initiated_ip TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO orders (booking_ref, phone, method, qty, amount, status, created_at, flw_tx_id, flw_ref)
      VALUES ('OLD-2', '260955222222', 'zmw', 1, 150, 'processing', '2026-01-01T00:00:00.000Z', '9001', 'flwref_x');
    INSERT INTO beneficiaries (label, account_bank, account_number, beneficiary_name, is_default, created_at)
      VALUES ('Event account', 'ZMB', '001122334455', 'Festival', 1, '2026-01-01T00:00:00.000Z');
    INSERT INTO payouts (reference, beneficiary_id, amount, status, flw_transfer_id, created_at, updated_at)
      VALUES ('PO-OLDONE001', 1, 100, 'processing', '7788', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  `);
  legacy.close();

  const store = require('../db');
  const order = store.getOrderByRef('OLD-2');
  assert.equal(order.provider_tx_id, '9001', 'an in-flight charge stays reconcilable');
  assert.equal(order.provider_ref, 'flwref_x');

  const [payout] = store.getPayoutsInFlight();
  assert.equal(payout.reference, 'PO-OLDONE001');
  assert.equal(payout.provider_transfer_id, '7788', 'an in-flight payout stays reconcilable');
  assert.equal(payout.provider, 'flutterwave', 'a legacy payout keeps the gateway that issued it');
});
