/**
 * End-to-end coverage against a real Express app and fake payment gateways.
 *
 * The app runs as a child process with the gateway base URL pointed at a local stub, so
 * every assertion goes through the genuine routes, session middleware and rendering
 * without contacting a real provider or spending money. Both gateways are exercised:
 * Elicate Pay, which is the production default, and Flutterwave, which stays supported
 * behind PAYMENT_PROVIDER.
 *
 * State is inspected by opening a second read-only connection to the child's database
 * file rather than requiring db.js here: requiring it would open the real
 * data/events.db in the test process, which is exactly what these tests must not do.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');

const ELICATE_WEBHOOK_SECRET = 'test-webhook-secret';

// Guarantee that a stray require in this file can never reach the real database.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tickets-guard-'));

// --- HTTP helpers ------------------------------------------------------------
function request(port, method, urlPath, { fields, json, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = json !== undefined ? JSON.stringify(json) : fields ? new URLSearchParams(fields).toString() : '';
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: {
          ...(payload
            ? {
                'Content-Type': json !== undefined ? 'application/json' : 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(payload),
              }
            : {}),
          ...headers,
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const get = (port, p, headers) => request(port, 'GET', p, { headers });
const post = (port, p, fields, headers) => request(port, 'POST', p, { fields, headers });
const postJson = (port, p, obj, verifHash) =>
  request(port, 'POST', p, { json: obj, headers: verifHash ? { 'verif-hash': verifHash } : {} });

/**
 * Elicate Pay signs the exact bytes it sends, so a test has to reproduce that signature
 * over the same JSON the client will serialise.
 */
function postElicateJson(port, path, obj, secret = ELICATE_WEBHOOK_SECRET) {
  const signature = crypto.createHmac('sha256', secret).update(JSON.stringify(obj)).digest('hex');
  return request(port, 'POST', path, {
    json: obj,
    headers: secret ? { 'x-elicatepay-signature': signature } : {},
  });
}

function waitForPort(port, tries = 80) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/', headers: { 'Accept-Encoding': 'identity' } }, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (n <= 0) return reject(new Error('server never came up'));
        setTimeout(() => attempt(n - 1), 100);
      });
    };
    attempt(tries);
  });
}

function cookies(res) {
  const raw = res.headers['set-cookie'];
  return raw ? raw.map((c) => c.split(';')[0]).join('; ') : '';
}

// --- reading the child's database -------------------------------------------
function query(dataDir, sql, params = []) {
  const db = new DatabaseSync(path.join(dataDir, 'events.db'));
  try {
    // The child may be mid-write; wait rather than reporting a spurious failure.
    db.exec('PRAGMA busy_timeout = 3000');
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

const orderByRef = (dataDir, ref) => query(dataDir, 'SELECT * FROM orders WHERE booking_ref = ?', [ref])[0] || null;
const orders = (dataDir) => query(dataDir, 'SELECT * FROM orders ORDER BY id');
const ticketsFor = (dataDir, orderId) => query(dataDir, 'SELECT * FROM tickets WHERE order_id = ?', [orderId]);
const beneficiaries = (dataDir) => query(dataDir, 'SELECT * FROM beneficiaries ORDER BY id');
const payouts = (dataDir) => query(dataDir, 'SELECT * FROM payouts ORDER BY id');

// --- fake Flutterwave gateway ------------------------------------------------
// Stands in for Flutterwave so charge, verification, balance and transfer paths are
// all exercised for real. Set customerBearsFee to simulate the wrong fee mode.
function startFakeGateway(state) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      const parsed = body ? JSON.parse(body) : {};

      // Both spellings, because the app uses ?type=mobile_money_zambia.
      if (/^\/v1\/charges(\?|$)/.test(req.url) && req.method === 'POST') {
        state.lastCharge = parsed;
        const id = ++state.chargeSeq;
        const amount = Number(parsed.amount);
        state.charges[id] = {
          id,
          tx_ref: parsed.tx_ref,
          status: state.chargeFails ? 'failed' : 'successful',
          amount,
          currency: parsed.currency,
          charged_amount: state.customerBearsFee ? Number((amount * 1.03).toFixed(2)) : amount,
          app_fee: state.customerBearsFee ? 0 : Number((amount * 0.03).toFixed(2)),
          processor_response: state.chargeFails ? 'Payment declined' : 'Payment successful',
        };
        // The app requires meta.authorization.redirect to proceed.
        return send(200, {
          status: 'success',
          message: 'Charge created',
          meta: { authorization: { redirect: `http://127.0.0.1:${state.port}/fake-auth/${id}` } },
          data: { id, status: 'success' },
        });
      }

      if (/^\/v1\/transactions\/\d+\/verify$/.test(req.url) && req.method === 'GET') {
        const charge = state.charges[req.url.split('/')[3]];
        if (!charge) return send(404, { status: 'error', message: 'Transaction not found' });
        return send(200, { status: 'success', message: 'Transaction verified', data: charge });
      }

      if (/^\/v1\/transactions\/verify_by_reference\?/.test(req.url) && req.method === 'GET') {
        const ref = new URL(req.url, 'http://x').searchParams.get('tx_ref');
        const charge = Object.values(state.charges).find((c) => c.tx_ref === ref);
        if (!charge) return send(404, { status: 'error', message: 'Transaction not found' });
        return send(200, { status: 'success', message: 'Transaction verified', data: charge });
      }

      if (req.url === '/v1/transfers' && req.method === 'POST') {
        state.lastTransfer = parsed;
        if (state.transferFails) return send(200, { status: 'error', message: 'Insufficient balance' });
        const id = ++state.transferSeq;
        state.transfers[id] = {
          id,
          reference: parsed.reference,
          status: 'successful',
          amount: parsed.amount,
          fee: 5,
          complete_message: 'Transfer complete',
        };
        return send(200, { status: 'success', data: { id, status: 'new', amount: parsed.amount, bank_name: parsed.account_bank } });
      }

      // Flutterwave reports balance in the account's settlement currency. Naming it
      // ZMW keeps the dashboard tile honest instead of implying another currency.
      if (req.url === '/v1/balance' && req.method === 'GET') {
        return send(200, { status: 'success', data: { available: state.available ?? 5000, ledger: state.available ?? 5000 } });
      }

      if (req.url.startsWith('/v1/transfers/') && req.method === 'GET') {
        const t = state.transfers[req.url.split('/').pop()];
        if (!t) return send(404, { status: 'error', message: 'Transfer not found' });
        return send(200, { status: 'success', data: t });
      }

      return send(404, { status: 'error', message: 'Unknown endpoint' });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// --- fake Elicate Pay gateway ------------------------------------------------
// Mirrors the documented v1 surface: charge, transaction read, and payouts. Sandbox
// transactions settle as "test success", which is the quirk most likely to break
// verification if it is ever ignored, so the stub returns it faithfully.
function startFakeElicate(state) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      const parsed = body ? JSON.parse(body) : {};
      const settledStatus = () => (state.chargeFails ? 'failed' : 'test success');

      if (req.url === '/api/v1/payments/charge' && req.method === 'POST') {
        state.lastCharge = parsed;
        const id = `EP-TEST-${++state.chargeSeq}`;
        const amount = Number(parsed.amount);
        const fee = Number((amount * 0.026).toFixed(2));
        state.charges[id] = {
          transaction_id: id,
          status: settledStatus(),
          amount,
          fee,
          net_amount: Number((amount - fee).toFixed(2)),
          currency: parsed.currency || 'ZMW',
          reference: parsed.reference,
        };
        return send(200, {
          transaction_id: id,
          status: 'pending',
          reference: parsed.reference,
          meta: { authorization: { mode: 'redirect', redirect_url: `http://127.0.0.1:${state.port}/fake-auth/${id}` } },
        });
      }

      if (/^\/api\/v1\/payments\/[^/]+$/.test(req.url) && req.method === 'GET') {
        const charge = state.charges[req.url.split('/').pop()];
        if (!charge) return send(404, { error: 'Transaction not found' });
        return send(200, charge);
      }

      if (req.url === '/api/v1/payouts' && req.method === 'POST') {
        state.lastTransfer = parsed;
        if (state.transferFails) return send(402, { error: 'Insufficient merchant balance' });
        const id = `PO-TEST-${++state.transferSeq}`;
        state.transfers[id] = {
          payout_id: id,
          status: 'success',
          amount: Number(parsed.amount),
          fee: 0.75,
          reference: parsed.reference,
          account_bank: parsed.account_bank,
          flutterwave_status: 'SUCCESS',
        };
        return send(200, {
          payout_id: id,
          status: 'pending',
          reference: parsed.reference,
          amount: Number(parsed.amount),
        });
      }

      if (/^\/api\/v1\/payouts\/[^/]+$/.test(req.url) && req.method === 'GET') {
        const t = state.transfers[req.url.split('/').pop()];
        if (!t) return send(404, { error: 'Payout not found' });
        return send(200, t);
      }

      return send(404, { error: 'Unknown endpoint' });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// --- app harness -------------------------------------------------------------
async function startApp(overrides = {}) {
  const provider = overrides.provider || 'flutterwave';
  const state = { chargeSeq: 0, transferSeq: 0, charges: {}, transfers: {}, customerBearsFee: false, ...overrides.state };
  const gateway = provider === 'elicate' ? await startFakeElicate(state) : await startFakeGateway(state);
  const gatewayPort = gateway.address().port;

  const dataDir = overrides.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'tickets-app-'));
  const port = overrides.port || 20000 + Math.floor(Math.random() * 20000);
  state.port = port; // the fake gateway builds charge redirect links from this

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      UPLOADS_DIR: path.join(dataDir, 'uploads'),
      ADMIN_PASSWORD: 'test-pass',
      SESSION_SECRET: 'test-secret',
      PAYMENT_PROVIDER: provider,
      FLW_SECRET_KEY: 'FLWSECK_TEST-HARNESS-X',
      FLW_SECRET_HASH: 'test-verif-hash',
      // Must keep the /v3 prefix: the client appends /charges, /transactions,
      // /transfers and /balance to this base.
      FLW_API_BASE: `http://127.0.0.1:${gatewayPort}/v1`,
      ELICATE_SECRET_KEY: 'ep_test_sk_harness',
      ELICATE_WEBHOOK_SECRET,
      ELICATE_API_BASE: `http://127.0.0.1:${gatewayPort}/api/v1`,
      PUBLIC_URL: `http://127.0.0.1:${port}`,
      RATE_LIMIT_CHECKOUT_IP: String(overrides.checkoutIpLimit ?? 20),
      RATE_LIMIT_CHECKOUT_PHONE: String(overrides.checkoutPhoneLimit ?? 5),
      RATE_LIMIT_LOGIN: String(overrides.loginLimit ?? 10),
      ...overrides.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  child.on('exit', (code) => {
    if (code) log += `\n[child exited ${code}]`;
  });

  await waitForPort(port);

  return {
    port,
    provider,
    state,
    dataDir,
    getLog: () => log,
    async stop() {
      child.kill();
      await new Promise((r) => child.on('exit', r));
      gateway.close();
    },
  };
}

async function login(app) {
  const res = await post(app.port, '/admin/login', { password: 'test-pass' });
  assert.equal(res.status, 302, 'login redirects on success');
  const session = cookies(res);
  assert.ok(session, 'a session cookie was issued');
  return session;
}

/** Checkout, then press the confirm button so the provider charge actually starts. */
async function buy(app, { qty = '1', phone, email }) {
  const res = await post(app.port, '/checkout', { qty, phone, email, method: 'zmw' });
  assert.equal(res.status, 302);
  const orderId = Number(res.headers.location.split('/pay/')[1]);
  assert.ok(Number.isInteger(orderId), `expected /pay/<id>, got ${res.headers.location}`);
  const started = await post(app.port, `/pay/${orderId}`, {});
  // On failure the route re-renders the pay page with the provider's message, so a
  // non-302 here means the charge was refused. Surface that instead of a bare 200.
  assert.equal(started.status, 302, `charge did not start: ${started.body.slice(0, 300)}\n\n${app.getLog()}`);
  assert.ok(app.state.lastCharge, 'the provider charge was created');
  return {
    orderId,
    ref: query(app.dataDir, 'SELECT booking_ref FROM orders WHERE id = ?', [orderId])[0].booking_ref,
  };
}

const issuedCode = (rows) => (rows[0] ? rows[0].code : '');

// --- Flutterwave path --------------------------------------------------------

test('checkout reserves stock and the pay page starts the provider charge', async () => {
  const app = await startApp();
  try {
    const res = await post(app.port, '/checkout', {
      qty: '2', phone: '260955000001', email: 'buyer@example.com', method: 'zmw',
    });
    assert.equal(res.status, 302);
    const location = res.headers.location;
    assert.ok(location.startsWith('/pay/'), `expected a pay redirect, got ${location}`);
    const orderId = Number(location.split('/pay/')[1]);

    const pay = await get(app.port, location);
    assert.equal(pay.status, 200);
    // The page must never ask for a PIN; approval happens on the customer's phone.
    assert.ok(!/name="pin"/i.test(pay.body), 'no PIN input exists');
    assert.match(pay.body, /never asks for, sees or stores your PIN/);

    // GET only shows the confirmation step. The charge starts on the button press,
    // which is what makes a double submission safe to reject.
    assert.equal(app.state.lastCharge, undefined, 'no charge before the customer confirms');

    const started = await post(app.port, location, {});
    assert.equal(started.status, 302);
    assert.ok(app.state.lastCharge, 'a charge was created with the provider');
    assert.equal(app.state.lastCharge.amount, 300, 'two K150 tickets are charged as 300');
    assert.equal(app.state.lastCharge.currency, 'ZMW');
    assert.equal(app.state.lastCharge.network, 'Airtel', 'the default wallet maps to the provider enum value');

    const order = orders(app.dataDir)[0];
    assert.equal(order.status, 'processing', 'the order stays in flight while payment runs');
    assert.equal(order.qty, 2);
    // Ticket codes are minted up front to hold the stock, but the door only opens for a
    // paid order, so an in-flight booking cannot be admitted.
    const held = ticketsFor(app.dataDir, orderId);
    assert.equal(held.length, 2, 'stock is held for the in-flight booking');
    assert.ok(held.every((t) => t.status === 'unused'));
  } finally {
    await app.stop();
  }
});

test('webhook settlement issues tickets and records the provider fee', async () => {
  const app = await startApp();
  try {
    const { orderId } = await buy(app, { phone: '260955000002', email: 'b2@example.com' });
    const ref = orders(app.dataDir)[0].booking_ref;
    const txId = Object.keys(app.state.charges)[0];

    const hook = await postJson(
      app.port,
      '/flw-webhook',
      {
        event: 'charge.completed',
        data: {
          id: Number(txId), tx_ref: ref, status: 'successful', amount: 150, currency: 'ZMW',
          charged_amount: 150, app_fee: 4.5,
        },
      },
      'test-verif-hash'
    );
    assert.equal(hook.status, 200);

    const paid = orderByRef(app.dataDir, ref);
    assert.equal(paid.status, 'paid');
    assert.equal(Number(paid.charged_amount), 150, 'merchant absorbs the fee');
    assert.equal(Number(paid.app_fee), 4.5, 'the fee is recorded for the dashboard');

    const issued = ticketsFor(app.dataDir, orderId);
    assert.equal(issued.length, 1, 'exactly the paid quantity is issued');
    assert.equal(issued[0].status, 'unused');

    // /ticket/<ref> is a resolver: it redirects a paid booking to the confirmation page.
    const resolved = await get(app.port, `/ticket/${ref}`);
    assert.equal(resolved.status, 302);
    assert.match(resolved.headers.location, /^\/confirmation\//);
    const page = await get(app.port, resolved.headers.location);
    assert.equal(page.status, 200);
    assert.ok(page.body.includes(ref), 'the confirmation page shows the booking');
  } finally {
    await app.stop();
  }
});

test('the webhook secret is enforced', async () => {
  const app = await startApp();
  try {
    const bad = await postJson(app.port, '/flw-webhook', { event: 'charge.completed', data: { tx_ref: 'x', status: 'successful' } }, 'wrong-hash');
    assert.equal(bad.status, 401);
    const missing = await postJson(app.port, '/flw-webhook', { event: 'charge.completed', data: { tx_ref: 'x', status: 'successful' } }, '');
    assert.equal(missing.status, 401, 'a missing verif-hash is refused too');
  } finally {
    await app.stop();
  }
});

test('a webhook claiming success is ignored when the provider says the charge failed', async () => {
  // The whole point of server-side verification: the webhook body is a claim, not proof.
  const app = await startApp({ state: { chargeFails: true } });
  try {
    const { orderId } = await buy(app, { phone: '260955000003', email: 'b3@example.com' });
    const ref = orders(app.dataDir)[0].booking_ref;
    assert.equal(orderByRef(app.dataDir, ref).status, 'processing', 'the charge is in flight');

    // Forged webhook: correct hash, correct reference, but the provider reports failure.
    const hook = await postJson(
      app.port,
      '/flw-webhook',
      { event: 'charge.completed', data: { id: 1, tx_ref: ref, status: 'successful', amount: 150, currency: 'ZMW' } },
      'test-verif-hash'
    );
    assert.equal(hook.status, 200, 'the provider is always answered 200 so it stops retrying');

    const order = orderByRef(app.dataDir, ref);
    assert.notEqual(order.status, 'paid', 'a failed charge must never become paid');
    // The stock is still held for this booking, and the door stays shut.
    assert.equal(ticketsFor(app.dataDir, orderId).length, 1);
    const session = await login(app);
    const scan = await post(app.port, '/admin/verify', { code: ticketsFor(app.dataDir, orderId)[0].code }, { Cookie: session });
    assert.equal(scan.status, 200);
    assert.match(scan.body, /not completed/);
  } finally {
    await app.stop();
  }
});

test('the return page releases a failed payment instead of holding tickets forever', async () => {
  const app = await startApp({ state: { chargeFails: true } });
  try {
    const { orderId } = await buy(app, { phone: '260955000016', email: 'b16@example.com' });
    const returned = await get(app.port, `/pay/return/${orderId}`);
    assert.equal(returned.status, 302, 'a failed payment sends the customer back to the event page');
    assert.match(returned.headers.location, /^\/#tickets$/);
    assert.equal(orders(app.dataDir)[0].status, 'cancelled', 'the held tickets are released at once');

    // The polling endpoint agrees, so the browser stops waiting.
    const poll = await get(app.port, `/pay/return/${orderId}/status`);
    assert.equal(JSON.parse(poll.body).state, 'cancelled');
  } finally {
    await app.stop();
  }
});

test('a webhook for an unknown booking reference is ignored', async () => {
  const app = await startApp();
  try {
    const hook = await postJson(
      app.port,
      '/flw-webhook',
      { event: 'charge.completed', data: { id: 1, tx_ref: 'NOT-A-REAL-REF', status: 'successful' } },
      'test-verif-hash'
    );
    assert.equal(hook.status, 200);
    assert.equal(orders(app.dataDir).length, 0);
  } finally {
    await app.stop();
  }
});

test('the dashboard flags when Flutterwave is charging the customer', async () => {
  const app = await startApp({ state: { customerBearsFee: true } });
  try {
    const { orderId } = await buy(app, { phone: '260955000004', email: 'b4@example.com' });
    const ref = orders(app.dataDir)[0].booking_ref;
    const txId = Object.keys(app.state.charges)[0];
    await postJson(
      app.port,
      '/flw-webhook',
      {
        event: 'charge.completed',
        data: {
          id: Number(txId), tx_ref: ref, status: 'successful', amount: 150, currency: 'ZMW',
          charged_amount: app.state.charges[txId].charged_amount, app_fee: 0,
        },
      },
      'test-verif-hash'
    );
    const paid = orderByRef(app.dataDir, ref);
    assert.ok(Number(paid.charged_amount) > paid.amount, 'the customer was debited more than the price');
    const session = await login(app);
    const dash = await get(app.port, '/admin', { Cookie: session });
    assert.equal(dash.status, 200);
    assert.match(dash.body, /Customers are paying extra/);
    assert.match(dash.body, /customer bears the charge/i);
    assert.ok(dash.body.includes(issuedCode(ticketsFor(app.dataDir, orderId))), 'the order is listed');
  } finally {
    await app.stop();
  }
});

test('the dashboard reports gross, fees and net separately', async () => {
  const app = await startApp();
  try {
    const { orderId } = await buy(app, { qty: '2', phone: '260955000005', email: 'b5@example.com' });
    const ref = orders(app.dataDir)[0].booking_ref;
    const txId = Object.keys(app.state.charges)[0];
    await postJson(
      app.port,
      '/flw-webhook',
      {
        event: 'charge.completed',
        data: {
          id: Number(txId), tx_ref: ref, status: 'successful', amount: 300, currency: 'ZMW',
          charged_amount: 300, app_fee: 9,
        },
      },
      'test-verif-hash'
    );
    assert.equal(orderByRef(app.dataDir, ref).status, 'paid');
    const session = await login(app);
    const dash = await get(app.port, '/admin', { Cookie: session });
    assert.match(dash.body, /Money collected \(gross\)/);
    assert.match(dash.body, /Provider fees/);
    assert.match(dash.body, /Net after fees/);
    // 300 gross, 9 fees, 291 net, rendered through the currency helper as "K 300" etc.
    assert.match(dash.body, /K 300<\/div>\s*<div class="l">Money collected/);
    assert.match(dash.body, /K 9<\/div>\s*<div class="l">Provider fees/);
    assert.match(dash.body, /K 291<\/div>\s*<div class="l">Net after fees/);
    void orderId;
  } finally {
    await app.stop();
  }
});

test('checkout is rate limited per phone so stock cannot be farmed', async () => {
  const app = await startApp({ checkoutPhoneLimit: 3, checkoutIpLimit: 100 });
  try {
    let blocked = 0;
    for (let i = 0; i < 6; i += 1) {
      const res = await post(app.port, '/checkout', {
        qty: '1', phone: '260955111222', email: `farmer${i}@example.com`, method: 'zmw',
      });
      if (res.headers['retry-after']) {
        blocked += 1;
        assert.ok(Number(res.headers['retry-after']) > 0, 'Retry-After tells the caller how long to wait');
      }
    }
    assert.equal(blocked, 3, 'exactly the requests past the limit are refused');
    assert.equal(orders(app.dataDir).length, 3, 'only the allowed attempts reserved stock');
  } finally {
    await app.stop();
  }
});

test('the per-IP checkout limit is independent of the per-phone limit', async () => {
  const app = await startApp({ checkoutPhoneLimit: 2, checkoutIpLimit: 3 });
  try {
    const results = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await post(app.port, '/checkout', {
        qty: '1', phone: `26095522200${i}`, email: `buyer${i}@example.com`, method: 'zmw',
      });
      results.push(Boolean(res.headers['retry-after']));
    }
    // Five distinct numbers, same IP: the IP budget of 3 is what stops this.
    assert.deepEqual(results, [false, false, false, true, true]);
  } finally {
    await app.stop();
  }
});

test('admin login is rate limited against brute force', async () => {
  const app = await startApp({ loginLimit: 4 });
  try {
    let sawLimit = false;
    for (let i = 0; i < 10; i += 1) {
      const res = await post(app.port, '/admin/login', { password: 'wrong' });
      if (res.status === 429) {
        sawLimit = true;
        assert.match(res.body, /Too many sign-in attempts/);
        assert.ok(res.headers['retry-after']);
        break;
      }
    }
    assert.ok(sawLimit, 'brute-forcing the admin password stops');
    assert.equal(orders(app.dataDir).length, 0);
  } finally {
    await app.stop();
  }
});

test('a blocked login does not lock out a correct password on the same budget alone', async () => {
  const app = await startApp({ loginLimit: 2 });
  try {
    await post(app.port, '/admin/login', { password: 'wrong' });
    const good = await post(app.port, '/admin/login', { password: 'test-pass' });
    assert.equal(good.status, 302, 'a correct password still works below the limit');
    assert.ok(cookies(good));
  } finally {
    await app.stop();
  }
});

test('a payout is impossible without a saved beneficiary and explicit confirmation', async () => {
  const app = await startApp();
  try {
    const session = await login(app);
    // No destination saved yet.
    await post(app.port, '/admin/payouts', { amount: '100', confirm: 'on' }, { Cookie: session });
    assert.equal(payouts(app.dataDir).length, 0, 'nothing is attempted without a destination');

    await post(
      app.port,
      '/admin/beneficiaries',
      { label: 'Event account', accountBank: 'ZMB', accountNumber: '001122334455', beneficiaryName: 'Festival Trust' },
      { Cookie: session }
    );
    const [b] = beneficiaries(app.dataDir);
    assert.equal(b.is_default, 1, 'the first destination becomes the default');

    // Over the available balance: rejected without contacting the provider.
    await post(app.port, '/admin/payouts', { beneficiaryId: b.id, amount: '999999', confirm: 'on' }, { Cookie: session });
    assert.equal(payouts(app.dataDir).length, 0, 'an oversized payout never reaches the provider');

    // Missing the confirmation box: rejected.
    await post(app.port, '/admin/payouts', { beneficiaryId: b.id, amount: '10' }, { Cookie: session });
    assert.equal(payouts(app.dataDir).length, 0, 'the confirmation checkbox is mandatory');

    // Not signed in.
    const anon = await post(app.port, '/admin/payouts', { beneficiaryId: b.id, amount: '10', confirm: 'on' });
    assert.match(anon.headers.location, /^\/admin\/login/);
    assert.equal(payouts(app.dataDir).length, 0);
  } finally {
    await app.stop();
  }
});

test('an accepted payout is recorded and the transfer webhook completes it', async () => {
  const app = await startApp();
  try {
    const session = await login(app);
    await post(
      app.port,
      '/admin/beneficiaries',
      { label: 'Event account', accountBank: 'ZMB', accountNumber: '001122334455', beneficiaryName: 'Festival Trust' },
      { Cookie: session }
    );
    const [b] = beneficiaries(app.dataDir);

    // Create paid revenue to fund the payout.
    const paid = await buy(app, { qty: '4', phone: '260955000009', email: 'b9@example.com' });
    const txId = Object.keys(app.state.charges)[0];
    await postJson(
      app.port,
      '/flw-webhook',
      {
        event: 'charge.completed',
        data: {
          id: Number(txId), tx_ref: paid.ref, status: 'successful', amount: 600, currency: 'ZMW',
          charged_amount: 600, app_fee: 18,
        },
      },
      'test-verif-hash'
    );

    const res = await post(
      app.port,
      '/admin/payouts',
      { beneficiaryId: b.id, amount: '250', narration: 'Bank run', confirm: 'on' },
      { Cookie: session }
    );
    assert.equal(res.status, 302);

    const [payout] = payouts(app.dataDir);
    assert.equal(payout.status, 'processing');
    assert.ok(payout.provider_transfer_id, 'the provider transfer id is stored');
    assert.equal(app.state.lastTransfer.reference, payout.reference, 'our reference is sent to the provider');
    assert.equal(app.state.lastTransfer.amount, 250);
    assert.equal(app.state.lastTransfer.account_number, '001122334455');
    assert.equal(app.state.lastTransfer.currency, 'ZMW');
    assert.equal(app.state.lastTransfer.narration, 'Bank run');
    assert.equal(payout.initiated_by, 'admin');
    assert.ok(payout.initiated_ip, 'the source IP is recorded for the audit trail');

    const hook = await postJson(
      app.port,
      '/flw-webhook',
      {
        event: 'transfer.completed',
        data: { id: Number(payout.provider_transfer_id), reference: payout.reference, status: 'successful', fee: 5, complete_message: 'Transfer complete' },
      },
      'test-verif-hash'
    );
    assert.equal(hook.status, 200);

    const settled = payouts(app.dataDir)[0];
    assert.equal(settled.status, 'completed');
    assert.equal(Number(settled.fee), 5);
    assert.match(settled.complete_message, /Transfer complete/);

    // Replaying the webhook must not double count.
    await postJson(
      app.port,
      '/flw-webhook',
      { event: 'transfer.completed', data: { id: Number(payout.provider_transfer_id), reference: payout.reference, status: 'successful' } },
      'test-verif-hash'
    );
    assert.equal(payouts(app.dataDir)[0].status, 'completed');

    const dash = await get(app.port, '/admin', { Cookie: session });
    assert.match(dash.body, /Still to withdraw/);
    assert.match(dash.body, /250\.00/, 'the payout is listed in history');
  } finally {
    await app.stop();
  }
});

test('a transfer the provider rejects is marked failed and is not money out', async () => {
  const app = await startApp({ state: { transferFails: true } });
  try {
    const session = await login(app);
    await post(
      app.port,
      '/admin/beneficiaries',
      { label: 'Event account', accountBank: 'ZMB', accountNumber: '001122334455', beneficiaryName: 'Festival Trust' },
      { Cookie: session }
    );
    const [b] = beneficiaries(app.dataDir);
    const paid = await buy(app, { qty: '2', phone: '260955000010', email: 'b10@example.com' });
    const txId = Object.keys(app.state.charges)[0];
    await postJson(
      app.port,
      '/flw-webhook',
      {
        event: 'charge.completed',
        data: {
          id: Number(txId), tx_ref: paid.ref, status: 'successful', amount: 300, currency: 'ZMW',
          charged_amount: 300, app_fee: 9,
        },
      },
      'test-verif-hash'
    );
    await post(app.port, '/admin/payouts', { beneficiaryId: b.id, amount: '100', confirm: 'on' }, { Cookie: session });
    const [payout] = payouts(app.dataDir);
    assert.equal(payout.status, 'failed', 'the attempt is still recorded for the audit trail');
    assert.ok(payout.complete_message, 'the provider message is kept');

    const dash = await get(app.port, '/admin', { Cookie: session });
    const paidOutRow = query(app.dataDir, "SELECT COALESCE(SUM(amount),0) AS n FROM payouts WHERE status='completed'")[0];
    assert.equal(Number(paidOutRow.n), 0, 'a failed payout is not counted as money out');
    assert.match(dash.body, /failed/);
  } finally {
    await app.stop();
  }
});

test('a malformed account number is refused before any provider call', async () => {
  const app = await startApp();
  try {
    const session = await login(app);
    await post(
      app.port,
      '/admin/beneficiaries',
      { label: 'Broken', accountBank: 'ZMB', accountNumber: 'not-a-number', beneficiaryName: 'Broken' },
      { Cookie: session }
    );
    assert.equal(beneficiaries(app.dataDir).length, 0, 'an invalid account number is not saved');
  } finally {
    await app.stop();
  }
});

test('a beneficiary with payout history cannot be deleted', async () => {
  const app = await startApp();
  try {
    const session = await login(app);
    await post(
      app.port,
      '/admin/beneficiaries',
      { label: 'Keep', accountBank: 'ZMB', accountNumber: '001122334455', beneficiaryName: 'Festival Trust' },
      { Cookie: session }
    );
    await post(
      app.port,
      '/admin/beneficiaries',
      { label: 'Drop', accountBank: 'ZMB', accountNumber: '998877665544', beneficiaryName: 'Festival Spare' },
      { Cookie: session }
    );
    const list = beneficiaries(app.dataDir);
    assert.equal(list.length, 2);

    // Give the second one payout history by funding and sending from it.
    const paid = await buy(app, { qty: '2', phone: '260955000011', email: 'b11@example.com' });
    const txId = Object.keys(app.state.charges)[0];
    await postJson(
      app.port,
      '/flw-webhook',
      {
        event: 'charge.completed',
        data: {
          id: Number(txId), tx_ref: paid.ref, status: 'successful', amount: 300, currency: 'ZMW',
          charged_amount: 300, app_fee: 9,
        },
      },
      'test-verif-hash'
    );
    await post(app.port, '/admin/payouts', { beneficiaryId: list[1].id, amount: '50', confirm: 'on' }, { Cookie: session });
    await post(app.port, `/admin/beneficiaries/${list[1].id}/delete`, {}, { Cookie: session });
    assert.equal(beneficiaries(app.dataDir).length, 2, 'the destination with history is protected');

    await post(app.port, `/admin/beneficiaries/${list[0].id}/delete`, {}, { Cookie: session });
    assert.equal(beneficiaries(app.dataDir).length, 1, 'an unused destination can be removed');
  } finally {
    await app.stop();
  }
});

test('admin sessions survive a restart because they live in the database', async () => {
  const first = await startApp();
  const session = await login(first);
  const before = await get(first.port, '/admin', { Cookie: session });
  assert.equal(before.status, 200, 'logged in before the restart');
  const dataDir = first.dataDir;
  await first.stop();

  // Same DATA_DIR, brand new process: the old in-memory store would have forgotten us.
  const second = await startApp({ dataDir });
  try {
    const after = await get(second.port, '/admin', { Cookie: session });
    assert.equal(after.status, 200, 'the same cookie is still valid after a deploy-like restart');
    assert.match(after.body, /Money out/);
  } finally {
    await second.stop();
  }
});

test('sessions are scoped to the secret, so a stolen cookie cannot be replayed elsewhere', async () => {
  const first = await startApp({ env: { SESSION_SECRET: 'secret-one' } });
  const session = await login(first);
  const dataDir = first.dataDir;
  await first.stop();

  const second = await startApp({ dataDir, env: { SESSION_SECRET: 'secret-two' } });
  try {
    const res = await get(second.port, '/admin', { Cookie: session });
    assert.notEqual(res.status, 200, 'a cookie signed with a different secret is rejected');
    assert.match(res.headers.location || '', /admin\/login/);
  } finally {
    await second.stop();
  }
});

test('checkout is disabled and says so when the provider is unconfigured', async () => {
  const app = await startApp({ env: { FLW_SECRET_KEY: '' } });
  try {
    const home = await get(app.port, '/');
    assert.equal(home.status, 200);
    assert.match(home.body, /not configured|unavailable|disabled/i);
    const res = await post(app.port, '/checkout', {
      qty: '1', phone: '260955000012', email: 'b12@example.com', method: 'zmw',
    });
    assert.equal(res.status, 302);
    assert.equal(orders(app.dataDir).length, 0, 'no order is created without a provider');
  } finally {
    await app.stop();
  }
});

test('an out-of-stock request is refused before a charge is attempted', async () => {
  const app = await startApp();
  try {
    await post(
      app.port,
      '/admin/settings',
      {
        eventName: 'Festival', eventDate: '2026-12-05', eventTime: '16:00', venue: 'Lusaka',
        description: 'Test', price: '150', totalTickets: '1', currency: 'K',
      },
      { Cookie: await login(app) }
    );

    const first = await post(app.port, '/checkout', { qty: '1', phone: '260955000013', email: 'b13@example.com', method: 'zmw' });
    assert.match(first.headers.location, /^\/pay\//);
    await post(app.port, first.headers.location, {});
    assert.ok(app.state.lastCharge, 'the first buyer is charged');

    const second = await post(app.port, '/checkout', { qty: '1', phone: '260955000014', email: 'b14@example.com', method: 'zmw' });
    assert.doesNotMatch(second.headers.location, /^\/pay\//, 'the second buyer is not charged');
    assert.equal(orders(app.dataDir).length, 1);
  } finally {
    await app.stop();
  }
});

test('cancelling a payment releases the reserved tickets', async () => {
  const app = await startApp();
  try {
    const res = await post(app.port, '/checkout', {
      qty: '2', phone: '260955000015', email: 'b15@example.com', method: 'zmw',
    });
    const orderId = Number(res.headers.location.split('/pay/')[1]);

    // Cancelling before the charge starts is allowed and releases the hold.
    const cancel = await get(app.port, `/pay/${orderId}/cancel`);
    assert.equal(cancel.status, 302);
    assert.equal(orders(app.dataDir)[0].status, 'cancelled');

    // Once a charge is in flight the hold must NOT be released, because the customer
    // may still be approving and the money may already have left their wallet.
    const res2 = await post(app.port, '/checkout', {
      qty: '1', phone: '260955000017', email: 'b17@example.com', method: 'zmw',
    });
    const id2 = Number(res2.headers.location.split('/pay/')[1]);
    await post(app.port, `/pay/${id2}`, {});
    assert.equal(orders(app.dataDir)[1].status, 'processing');
    await get(app.port, `/pay/${id2}/cancel`);
    assert.equal(orders(app.dataDir)[1].status, 'processing', 'an in-flight payment keeps its tickets');
  } finally {
    await app.stop();
  }
});

test('the startup log warns about the things that quietly cost money', async () => {
  const app = await startApp({ env: { FLW_SECRET_HASH: '' } });
  try {
    const log = app.getLog();
    assert.match(log, /FLW_SECRET_HASH is not set/, 'a missing webhook secret is called out');
    assert.match(log, /Data directory:/, 'the data location is printed so a volume misconfiguration is visible');
  } finally {
    await app.stop();
  }
});

// --- Elicate Pay path --------------------------------------------------------

test('Elicate is the default gateway and its charge uses the local phone format', async () => {
  const app = await startApp({ provider: 'elicate' });
  try {
    assert.match(app.getLog(), /Payment gateway: Elicate Pay/);
    assert.match(app.getLog(), /webhooks at: http:\/\/127\.0\.0\.1:\d+\/elicate-webhook/, 'the webhook URL to copy into the dashboard is printed');

    const { ref } = await buy(app, { phone: '260971234567', email: 'e1@example.com' });
    const charge = app.state.lastCharge;
    // Elicate documents 0962000000-style numbers, not the +260 form Flutterwave wants.
    assert.equal(charge.phone, '0971234567');
    assert.equal(charge.network, 'AIRTEL', 'networks go up in the documented enum');
    assert.equal(charge.currency, 'ZMW');
    assert.equal(charge.amount, 150);
    assert.equal(charge.reference, ref, 'our booking reference travels with the charge');
    assert.match(charge.redirect_url, /\/pay\/return\/\d+$/, 'a return URL is forwarded so the customer comes back');

    assert.ok(orderByRef(app.dataDir, ref).provider_tx_id, 'the Elicate transaction id is stored for verification');
  } finally {
    await app.stop();
  }
});

test('an Elicate sandbox charge settles on the "test success" status', async () => {
  const app = await startApp({ provider: 'elicate' });
  try {
    const { orderId, ref } = await buy(app, { phone: '0971234567', email: 'e2@example.com' });
    assert.equal(orderByRef(app.dataDir, ref).status, 'processing');

    // The customer returns without the webhook, which is the normal Elicate flow.
    const returned = await get(app.port, `/pay/return/${orderId}`);
    assert.equal(returned.status, 302);
    assert.match(returned.headers.location, /^\/confirmation\//, 'the sandbox success settles immediately');

    const paid = orderByRef(app.dataDir, ref);
    assert.equal(paid.status, 'paid');
    assert.equal(Number(paid.app_fee), 3.9, 'the 2.6% collection fee is recorded');
    assert.equal(Number(paid.charged_amount), 150, 'the customer pays the advertised price');
    assert.equal(ticketsFor(app.dataDir, orderId).length, 1);
  } finally {
    await app.stop();
  }
});

test('an Elicate webhook is refused unless it carries a valid HMAC signature', async () => {
  const app = await startApp({ provider: 'elicate' });
  try {
    const event = { event: 'payment.success', data: { transaction_id: 'EP-TEST-1', reference: 'EVT-NOPE', status: 'success' } };
    const unsigned = await request(app.port, 'POST', '/elicate-webhook', { json: event });
    assert.equal(unsigned.status, 401, 'no signature at all is refused');

    const wrongSecret = await postElicateJson(app.port, '/elicate-webhook', event, 'not-the-secret');
    assert.equal(wrongSecret.status, 401, 'a signature from the wrong secret is refused');

    // Tampering with the body after signing must also fail.
    const signed = crypto.createHmac('sha256', ELICATE_WEBHOOK_SECRET).update(JSON.stringify(event)).digest('hex');
    const tampered = await request(app.port, 'POST', '/elicate-webhook', {
      json: { ...event, data: { ...event.data, reference: 'EVT-SOMETHINGELSE' } },
      headers: { 'x-elicatepay-signature': signed },
    });
    assert.equal(tampered.status, 401, 'the signature covers the bytes, not the parsed object');
    assert.equal(orders(app.dataDir).length, 0, 'nothing was trusted from any of them');
  } finally {
    await app.stop();
  }
});

test('an Elicate payout is sent to the provider and completed by its webhook', async () => {
  const app = await startApp({ provider: 'elicate' });
  try {
    const session = await login(app);
    await post(
      app.port,
      '/admin/beneficiaries',
      { label: 'Festival wallet', accountBank: 'MPS', accountNumber: '260971234567', beneficiaryName: 'Festival Trust' },
      { Cookie: session }
    );
    const [b] = beneficiaries(app.dataDir);

    const { ref } = await buy(app, { qty: '4', phone: '0971234568', email: 'e3@example.com' });
    await postElicateJson(app.port, '/elicate-webhook', {
      event: 'payment.success',
      data: { transaction_id: 'EP-TEST-1', reference: ref, status: 'test success', amount: 600, fee: 15.6 },
    });
    assert.equal(orderByRef(app.dataDir, ref).status, 'paid');

    await post(
      app.port,
      '/admin/payouts',
      { beneficiaryId: b.id, amount: '300', narration: 'Wallet run', confirm: 'on' },
      { Cookie: session }
    );

    const [payout] = payouts(app.dataDir);
    assert.equal(payout.status, 'processing');
    assert.ok(payout.provider_transfer_id, 'the Elicate payout id is stored');
    assert.equal(app.state.lastTransfer.reference, payout.reference);
    assert.equal(app.state.lastTransfer.account_bank, 'MPS', 'mobile money payouts use the MPS operator code');
    assert.equal(app.state.lastTransfer.amount, 300);
    assert.equal(app.state.lastTransfer.currency, 'ZMW');

    await postElicateJson(app.port, '/elicate-webhook', {
      event: 'payout.success',
      data: { payout_id: payout.provider_transfer_id, reference: payout.reference, status: 'success', fee: 4.5 },
    });

    const settled = payouts(app.dataDir)[0];
    assert.equal(settled.status, 'completed');
    assert.equal(Number(settled.fee), 4.5);

    // Elicate publishes no balance endpoint, so the dashboard must not invent one.
    const dash = await get(app.port, '/admin', { Cookie: session });
    assert.equal(dash.status, 200);
    assert.match(dash.body, /In your Elicate Pay account|Still to withdraw/);
    assert.doesNotMatch(dash.body, /In your Flutterwave account/);
  } finally {
    await app.stop();
  }
});

test('an Elicate payout the provider rejects is recorded as failed', async () => {
  const app = await startApp({ provider: 'elicate', state: { transferFails: true } });
  try {
    const session = await login(app);
    await post(
      app.port,
      '/admin/beneficiaries',
      { label: 'Festival wallet', accountBank: 'MPS', accountNumber: '260971234567', beneficiaryName: 'Festival Trust' },
      { Cookie: session }
    );
    const [b] = beneficiaries(app.dataDir);

    const { ref } = await buy(app, { qty: '2', phone: '0971234569', email: 'e4@example.com' });
    await get(app.port, `/pay/return/${orderByRef(app.dataDir, ref).id}`);

    await post(
      app.port,
      '/admin/payouts',
      { beneficiaryId: b.id, amount: '50', confirm: 'on' },
      { Cookie: session }
    );

    const [payout] = payouts(app.dataDir);
    assert.equal(payout.status, 'failed');
    assert.match(payout.complete_message, /Insufficient merchant balance/, 'the provider message is surfaced');
    const total = query(app.dataDir, "SELECT COALESCE(SUM(amount),0) AS n FROM payouts WHERE status='completed'")[0];
    assert.equal(Number(total.n), 0, 'a rejected payout is never counted as money out');
  } finally {
    await app.stop();
  }
});
