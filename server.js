require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const QRCode = require('qrcode');
const store = require('./db');
const payments = require('./payments');
const ratelimit = require('./ratelimit');
const { SqliteStore } = require('./session-store');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const RESERVATION_MINUTES = 15;
const PAYMENT_WINDOW_MINUTES = Number(process.env.PAYMENT_WINDOW_MINUTES) || 120;
const RECONCILE_INTERVAL_MS = 60 * 1000;
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Generous per-IP, tighter per-phone. See ratelimit.js for why.
const CHECKOUT_IP_LIMIT = { limit: Number(process.env.RATE_LIMIT_CHECKOUT_IP) || 20, windowMs: 15 * 60 * 1000 };
const CHECKOUT_PHONE_LIMIT = { limit: Number(process.env.RATE_LIMIT_CHECKOUT_PHONE) || 5, windowMs: 60 * 60 * 1000 };
const LOGIN_LIMIT = { limit: Number(process.env.RATE_LIMIT_LOGIN) || 10, windowMs: 15 * 60 * 1000 };

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
// Elicate Pay signs the exact bytes it sends, so the unparsed body has to survive for
// webhook verification. Flutterwave only ever checked a header and never needed this.
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(
  session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    store: new SqliteStore(store.raw),
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 },
  })
);

const METHODS = {
  airtel: { id: 'airtel', name: 'Airtel Money', brand: 'airtel', preferred: true },
  mtn: { id: 'mtn', name: 'MTN Mobile Money', brand: 'mtn', preferred: false },
  zamtel: { id: 'zamtel', name: 'Zamtel Kwacha', brand: 'zamtel', preferred: false },
};

app.use((req, res, next) => {
  const settings = store.getSettings();
  res.locals.settings = settings;
  res.locals.currency = (n) => {
    const amount = Number(n || 0);
    return `${settings.currency} ${amount.toLocaleString('en-US')}`;
  };
  res.locals.methods = METHODS;
  res.locals.paymentsReady = payments.isConfigured();
  res.locals.providerName = payments.displayName;
  res.locals.providerSecretKey = payments.envKeys.secret;
  res.locals.webhookPath = payments.webhookPath;
  res.locals.isAdmin = !!(req.session && req.session.admin);
  res.locals.toDateLabel = toOrdinal(settings.eventDate);
  res.locals.toTimeLabel = toTime(settings.eventTime);
  res.locals.fmtWhen = (iso) => {
    const dt = new Date(iso);
    return isNaN(dt) ? iso : dt.toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' });
  };
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  next();
});

function requireAdmin(req, res, next) {
  if (!res.locals.isAdmin) return res.redirect('/admin/login');
  next();
}

function setFlash(req, msg, type = 'success') {
  req.session.flash = { msg, type };
}

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
      cb(null, `banner-${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(png|jpe?g|gif|webp)$/.test(file.mimetype);
    cb(ok ? null : new Error('Only image files are allowed.'), ok);
  },
});

function toOrdinal(d) {
  const dt = new Date(d);
  if (isNaN(dt)) return d;
  return dt.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function toTime(t) {
  if (!t) return t;
  const [h, m] = String(t).split(':').map(Number);
  if (Number.isNaN(h)) return t;
  const period = h >= 12 ? 'PM' : 'AM';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:${String(m || 0).padStart(2, '0')} ${period}`;
}

/**
 * Deliberately does no database work and renders nothing. Railway probes this to decide
 * whether the process is alive; pointing it at `/` meant a slow or contended query could
 * answer "unhealthy" and get a perfectly good server killed and restarted.
 */
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: Math.round(process.uptime()) });
});

app.get('/', (req, res) => {
  store.expireStalePending(RESERVATION_MINUTES);
  const options = store.getSettings();
  const total = Number(options.totalTickets) || 0;
  const sold = store.countSold();
  const reserved = store.countActivePending(RESERVATION_MINUTES);
  const remaining = Math.max(0, total - sold - reserved);
  res.render('index', {
    eventOptions: options,
    total,
    sold,
    remaining,
  });
});

function methodFor(req) {
  return METHODS[req.body.method] ? req.body.method : 'airtel';
}

function emailFor(req) {
  return String(req.body.email || '').trim().slice(0, 160);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

/**
 * Guards the two routes that cost money or leak information. Returns true when the
 * request was blocked, so the caller can render the right response.
 */
function tooManyRequests(req, res, keys) {
  for (const [key, opts] of keys) {
    const result = ratelimit.hit(key, opts);
    if (!result.allowed) {
      res.set('Retry-After', String(result.retryAfter));
      return { blocked: true, retryAfter: result.retryAfter };
    }
  }
  return { blocked: false };
}

function phoneKey(req) {
  const raw = String(req.body.phone || '').replace(/\D/g, '');
  return raw ? `phone:${raw.slice(-10)}` : null;
}

/**
 * Where the provider should send the customer once they have approved (or declined)
 * the charge, so they land back on their tickets instead of a provider page.
 */
function publicUrl() {
  return String(process.env.PUBLIC_URL || '').replace(/\/+$/, '');
}

function returnUrlFor(req, orderId) {
  const base = publicUrl();
  const path = `/pay/return/${orderId}`;
  return base ? `${base}${path}` : `${req.protocol}://${req.get('host')}${path}`;
}

app.post('/checkout', (req, res) => {
  store.expireStalePending(RESERVATION_MINUTES);
  const options = store.getSettings();
  const qty = Number.parseInt(req.body.qty, 10);
  const method = methodFor(req);
  const phone = String(req.body.phone || '').trim();
  const email = emailFor(req);

  // Refuse before reserving anything. Without a provider the customer can never pay,
  // so an order here would only hold stock hostage until it expired.
  if (!payments.isConfigured()) {
    setFlash(req, 'Online payment is temporarily unavailable. Please try again later.', 'error');
    return res.redirect('/#tickets');
  }

  const pk = phoneKey(req);
  const keys = [['ip:' + req.ip, CHECKOUT_IP_LIMIT], ...(pk ? [[pk, CHECKOUT_PHONE_LIMIT]] : [])];
  const limit = tooManyRequests(req, res, keys);
  if (limit.blocked) {
    setFlash(req, 'Too many booking attempts. Please wait a few minutes and try again.', 'error');
    return res.redirect('/#tickets');
  }

  const maxQty = !options.maxQtyPerOrder ? 10 : Number(options.maxQtyPerOrder);
  const validQty = Number.isInteger(qty) && qty >= 1 && qty <= maxQty;

  if (!validQty) {
    setFlash(req, 'Please choose a valid number of tickets.', 'error');
    return res.redirect('/#tickets');
  }

  const total = Number(options.totalTickets) || 0;
  const sold = store.countSold();
  const reserved = store.countActivePending(RESERVATION_MINUTES);
  const remaining = Math.max(0, total - sold - reserved);
  if (remaining < qty) {
    setFlash(req, `Sorry, only ${remaining} ticket(s) left.`, 'error');
    return res.redirect('/#tickets');
  }

  if (!/^(\+?\d{9,12})$/.test(phone.replace(/[\s-]/g, ''))) {
    setFlash(req, 'Please enter a valid mobile number so we can send your tickets.', 'error');
    return res.redirect('/#tickets');
  }

  if (!isValidEmail(email)) {
    setFlash(req, 'Please enter a valid email address for your payment receipt.', 'error');
    return res.redirect('/#tickets');
  }

  const amount = Number(options.price) * qty;
  const order = store.createOrder({ phone, email, method, qty, amount });
  res.redirect(`/pay/${order.id}`);
});

app.get('/pay/:id', (req, res) => {
  const item = store.getOrderWithTickets(req.params.id);
  if (!item || item.order.status === 'cancelled') {
    return res.render('pay', { item: null, error: 'This booking has expired or does not exist.', awaiting: false, failure: null });
  }
  if (item.order.status === 'paid') return res.redirect(`/confirmation/${item.order.id}`);
  if (item.order.status === 'processing') return res.redirect(`/pay/return/${item.order.id}`);
  res.render('pay', { item, error: null, awaiting: false, failure: null });
});

app.post('/pay/:id', async (req, res) => {
  const item = store.getOrderWithTickets(req.params.id);
  if (!item || item.order.status === 'cancelled') {
    return res.render('pay', { item: null, error: 'This booking has expired or does not exist.', awaiting: false, failure: null });
  }
  if (item.order.status === 'paid') return res.redirect(`/confirmation/${item.order.id}`);
  // A charge is already in flight. Never start a second one: that would double-charge.
  if (item.order.status === 'processing') return res.redirect(`/pay/return/${item.order.id}`);

  const order = item.order;
  try {
    const result = await payments.charge({
      amount: order.amount,
      phone: order.phone,
      method: order.method,
      email: order.email,
      txRef: order.booking_ref,
      returnUrl: returnUrlFor(req, order.id),
      clientIp: req.ip,
    });
    store.markChargeStarted(order.id, result);
    return res.redirect(result.redirectUrl);
  } catch (err) {
    if (err instanceof payments.PaymentError) {
      return res.render('pay', { item, error: err.message, awaiting: false, failure: null });
    }
    throw err;
  }
});

app.get('/pay/return/:id', async (req, res) => {
  const order = store.getOrder(req.params.id);
  if (!order || order.status === 'cancelled') return res.redirect('/');
  if (order.status === 'paid') return res.redirect(`/confirmation/${order.id}`);

  const outcome = await settleOrder(order);
  if (outcome.paid) return res.redirect(`/confirmation/${order.id}`);

  // A definitive failure means no money moved, so the held tickets are released now
  // rather than after the payment window. An inconclusive result is not a failure:
  // the customer may still be approving on their handset, so the hold stays.
  if (outcome.reason) {
    store.cancelOrder(order.id);
    setFlash(req, `Your payment was not completed (${outcome.reason}). Your tickets have been released, please book again.`, 'error');
    return res.redirect('/#tickets');
  }

  res.render('pay', { item: store.getOrderWithTickets(order.id), error: null, awaiting: true, failure: null });
});

app.get('/pay/return/:id/status', async (req, res) => {
  const order = store.getOrder(req.params.id);
  if (!order) return res.status(404).json({ state: 'unknown' });
  if (order.status === 'paid') return res.json({ state: 'paid', url: `/confirmation/${order.id}` });
  if (order.status === 'cancelled') return res.json({ state: 'cancelled' });

  const outcome = await settleOrder(order);
  if (outcome.paid) return res.json({ state: 'paid', url: `/confirmation/${order.id}` });
  if (outcome.reason) {
    store.cancelOrder(order.id);
    return res.json({ state: 'failed', reason: outcome.reason });
  }
  res.json({ state: 'processing' });
});

/**
 * Re-reads the transaction from the provider and only settles when the amount,
 * currency and reference all match the order. Safe to call repeatedly: the provider
 * is the source of truth and the order transition itself is idempotent.
 */
async function settleOrder(order) {
  try {
    const result = await payments.verify({
      txId: order.provider_tx_id,
      txRef: order.booking_ref,
      amount: order.amount,
    });
    if (result.paid) {
      store.markOrderPaid(order.id, {
        chargedAmount: result.chargedAmount,
        appFee: result.appFee,
        merchantFee: result.merchantFee,
      });
      if (order.charged_amount === null && result.chargedAmount !== null && result.chargedAmount > order.amount + 0.009) {
        console.warn(
          `Order ${order.booking_ref}: charged K${result.chargedAmount} for a K${order.amount} booking. ` +
            `${payments.displayName} is charging the customer, not the merchant. Turn off "customer bears the charge" in your dashboard.`
        );
      }
      return { paid: true };
    }
    return { paid: false, reason: result.status === 'failed' ? result.reason : null };
  } catch (err) {
    if (err instanceof payments.PaymentError) {
      console.error(`Payment check failed for order ${order.booking_ref}: ${err.message}`, err.detail || '');
      return { paid: false, reason: null };
    }
    throw err;
  }
}

app.get('/pay/:id/cancel', (req, res) => {
  const order = store.getOrder(req.params.id);
  if (order && order.status === 'pending') {
    store.cancelOrder(order.id);
    setFlash(req, 'Your booking was cancelled. No payment was collected.');
  } else if (order && order.status === 'processing') {
    setFlash(req, 'A payment is already being processed. Contact the organiser if you were charged.', 'error');
  }
  res.redirect('/');
});

/**
 * One webhook handler for whichever gateway is live. Each provider parses its own event
 * names into the same { type, succeeded, reference } shape, so nothing below this
 * point branches on the provider. Both paths are mounted so an account's dashboard URL
 * keeps working whichever provider is configured; the active provider's signature check
 * is what actually decides whether a delivery is trusted.
 */
async function handleProviderWebhook(req, res) {
  if (!payments.isWebhookConfigured()) {
    console.error(`Rejected ${payments.displayName} webhook: ${payments.envKeys.webhookSecret} is not set.`);
    return res.status(401).end();
  }
  if (!payments.webhookSecretValid(req)) {
    console.error(`Rejected ${payments.displayName} webhook: signature did not match.`);
    return res.status(401).end();
  }

  const event = payments.parseWebhook(req);
  if (!event) return res.status(200).end();

  // The provider wants a 2xx within a few seconds or it marks the delivery permanently
  // failed, and this is one GET, so it is settled inline. Both handlers are idempotent
  // against the stored order status, so a redelivery is harmless.
  try {
    if (event.type === 'payout') await handlePayoutEvent(event);
    else await handleChargeEvent(event);
  } catch (err) {
    console.error(`${payments.displayName} webhook handling failed:`, err.message);
  }
  res.status(200).end();
}

app.post('/elicate-webhook', handleProviderWebhook);
app.post('/flw-webhook', handleProviderWebhook);

async function handleChargeEvent(event) {
  if (!event.succeeded) {
    const order = event.reference ? store.getOrderByRef(event.reference) : null;
    if (order) console.error(`Payment failed for ${order.booking_ref}: ${event.message || 'declined'}`);
    return;
  }

  const order = event.reference ? store.getOrderByRef(event.reference) : null;
  if (!order) {
    console.error(`${payments.displayName} webhook referenced unknown reference: ${event.reference}`);
    return;
  }
  if (order.status === 'paid') return;

  // The webhook says so, but the provider is re-read before anything is issued, so a
  // forged or mis-routed delivery cannot create a ticket.
  const outcome = await settleOrder(order);
  if (!outcome.paid) {
    console.error(`Webhook for ${order.booking_ref} could not be settled; leaving for the reconciler.`);
  }
}

app.get('/confirmation/:id', async (req, res) => {
  const item = store.getOrderWithTickets(req.params.id);
  if (!item || item.order.status !== 'paid') return res.redirect('/');
  const qrs = [];
  for (const t of item.tickets) {
    qrs.push({ code: t.code, dataUrl: await QRCode.toDataURL(t.code, { width: 300, margin: 1 }) });
  }
  res.render('confirmation', { item, qrs });
});

app.get('/ticket/:ref', async (req, res) => {
  const order = store.getOrderByRef(req.params.ref);
  if (!order) return res.redirect('/');
  if (order.status === 'pending') return res.redirect(`/pay/${order.id}`);
  if (order.status !== 'paid') return res.redirect('/');
  res.redirect(`/confirmation/${order.id}`);
});

app.get('/admin/login', (req, res) => {
  if (res.locals.isAdmin) return res.redirect('/admin');
  res.render('admin/login');
});

app.post('/admin/login', (req, res) => {
  const limit = tooManyRequests(req, res, [['ip:' + req.ip, LOGIN_LIMIT]]);
  if (limit.blocked) {
    res.set('Retry-After', String(limit.retryAfter));
    return res.status(429).render('admin/login', {
      error: 'Too many sign-in attempts. Please wait a few minutes and try again.',
    });
  }
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    req.session.admin = true;
    req.session.save(() => res.redirect('/admin'));
  } else {
    res.render('admin/login', { error: 'Incorrect password.' });
  }
});

app.post('/admin/logout', (req, res) => {
  req.session.admin = false;
  res.redirect('/admin/login');
});

app.get('/admin', requireAdmin, async (req, res) => {
  const options = store.getSettings();
  const total = Number(options.totalTickets) || 0;
  const sold = store.countSold();
  const reserved = store.countActivePending(RESERVATION_MINUTES);
  const remaining = Math.max(0, total - sold);
  const revenue = store.sumRevenue();
  const fees = store.sumFees();
  const net = store.sumNet();
  const orders = store.getOrders();
  const tickets = store.getAllTickets();
  const beneficiaries = store.getBeneficiaries();
  const payouts = store.getPayouts();
  const paidOut = store.sumPaidOut();
  const customerBearing = store.countCustomerBearingCharges();

  // Balance comes from the provider, not our database. A failure here must not take
  // the dashboard down, so it degrades to null and the template hides the tile. Some
  // gateways publish no balance endpoint at all, which is also null.
  let balance = null;
  if (payouts.length && payments.isConfigured()) {
    try {
      balance = await payments.getBalance();
    } catch (err) {
      console.error(`Could not read ${payments.displayName} balance:`, err.message);
    }
  }

  res.render('admin/dashboard', {
    total,
    sold,
    reserved,
    remaining,
    revenue,
    fees,
    net,
    paidOut,
    balance,
    customerBearing,
    payoutConfigured: payments.isConfigured(),
    orders,
    tickets,
    beneficiaries,
    payouts,
    netAfterPayouts: net - paidOut,
  });
});

app.get('/admin/settings', requireAdmin, (req, res) => {
  res.render('admin/settings', { settings: store.getSettings() });
});

app.post('/admin/settings', requireAdmin, (req, res) => {
  const { eventName, eventDate, eventTime, venue, description, price, totalTickets, currency } = req.body;
  if (!eventName || !eventDate || !eventTime) {
    setFlash(req, 'Event name, date and time are required.', 'error');
    return res.redirect('/admin/settings');
  }
  let intPrice = Number.parseInt(price, 10);
  let intTotal = Number.parseInt(totalTickets, 10);
  if (!Number.isInteger(intPrice) || intPrice < 0) intPrice = 0;
  if (!Number.isInteger(intTotal) || intTotal < 0) intTotal = parseInt(store.getSettings().totalTickets, 10) || 0;

  store.setSetting('eventName', String(eventName).trim());
  store.setSetting('eventDate', String(eventDate).trim());
  store.setSetting('eventTime', String(eventTime).trim());
  store.setSetting('venue', String(venue || '').trim());
  store.setSetting('description', String(description || '').trim());
  store.setSetting('price', String(intPrice));
  store.setSetting('totalTickets', String(intTotal));
  store.setSetting('currency', String(currency || 'K').trim().slice(0, 4));

  setFlash(req, 'Event details saved.');
  res.redirect('/admin/settings');
});

app.post('/admin/beneficiaries', requireAdmin, (req, res) => {
  const { label, accountBank, accountNumber, beneficiaryName } = req.body;
  if (!label || !accountBank || !accountNumber || !beneficiaryName) {
    setFlash(req, 'Every beneficiary needs a label, bank, account number and account name.', 'error');
    return res.redirect('/admin#payouts');
  }
  if (!payments.isValidAccountNumber(accountNumber)) {
    setFlash(req, 'That bank account number does not look right. Use digits only.', 'error');
    return res.redirect('/admin#payouts');
  }
  store.addBeneficiary({
    label: label,
    accountBank: accountBank,
    accountNumber: accountNumber,
    beneficiaryName: beneficiaryName,
    makeDefault: false,
  });
  setFlash(req, `Saved ${String(label).trim()} as a payout destination.`);
  res.redirect('/admin#payouts');
});

app.post('/admin/beneficiaries/:id/default', requireAdmin, (req, res) => {
  const b = store.getBeneficiary(req.params.id);
  if (!b) {
    setFlash(req, 'That beneficiary no longer exists.', 'error');
    return res.redirect('/admin#payouts');
  }
  store.raw.prepare('UPDATE beneficiaries SET is_default = 0').run();
  store.raw.prepare('UPDATE beneficiaries SET is_default = 1 WHERE id = ?').run(b.id);
  setFlash(req, `${b.label} is now the default payout destination.`);
  res.redirect('/admin#payouts');
});

app.post('/admin/beneficiaries/:id/delete', requireAdmin, (req, res) => {
  const removed = store.deleteBeneficiary(req.params.id);
  setFlash(
    req,
    removed ? 'Beneficiary removed.' : 'That beneficiary has payout history and cannot be removed.',
    removed ? 'ok' : 'error'
  );
  res.redirect('/admin#payouts');
});

/**
 * Sends real money. The order of operations matters: the payout row is written
 * first so that a crash or a lost provider response still leaves an audit trail,
 * and the provider is then called with that row's unique reference, which is what
 * makes a double-submit harmless rather than a doubled transfer.
 */
app.post('/admin/payouts', requireAdmin, async (req, res) => {
  if (!payments.isConfigured()) {
    setFlash(req, `Payouts are unavailable until ${payments.envKeys.secret} is set.`, 'error');
    return res.redirect('/admin#payouts');
  }

  const beneficiary = store.getBeneficiary(req.body.beneficiaryId);
  if (!beneficiary) {
    setFlash(req, 'Choose a saved payout destination first.', 'error');
    return res.redirect('/admin#payouts');
  }
  const amount = Number(req.body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    setFlash(req, 'Enter an amount greater than zero.', 'error');
    return res.redirect('/admin#payouts');
  }

  const available = store.sumNet() - store.sumPaidOut();
  if (amount > available + 0.009) {
    setFlash(req, `That is more than the available ${formatKwacha(available)}.`, 'error');
    return res.redirect('/admin#payouts');
  }
  if (amount > payoutCeiling()) {
    setFlash(req, 'That payout exceeds the per-payout limit. Check the PAYOUT_MAX setting.', 'error');
    return res.redirect('/admin#payouts');
  }
  if (req.body.confirm !== 'on') {
    setFlash(req, 'Tick the confirmation box before sending a payout.', 'error');
    return res.redirect('/admin#payouts');
  }

  const payout = store.createPayout({
    beneficiaryId: beneficiary.id,
    amount,
    narration: req.body.narration,
    initiatedBy: 'admin',
    initiatedIp: req.ip,
    provider: payments.name,
  });

  try {
    const transfer = await payments.createTransfer({
      beneficiary,
      amount,
      reference: payout.reference,
      narration: payout.narration,
      destinationBranchCode: req.body.destinationBranchCode,
    });
    store.markPayoutProcessing(payout.id, transfer.transferId);
    setFlash(
      req,
      `Payout ${payout.reference} for ${formatKwacha(amount)} to ${beneficiary.label} is on its way.`
    );
  } catch (err) {
    store.markPayout(payout.id, { status: 'failed', completeMessage: err.message });
    setFlash(req, `Payout ${payout.reference} failed: ${err.message}`, 'error');
  }
  res.redirect('/admin#payouts');
});

function formatKwacha(value) {
  const n = Number(value) || 0;
  return `K${n.toLocaleString('en-ZM', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Largest single payout allowed, from PAYOUT_MAX with a hard-coded fallback. */
function payoutCeiling() {
  const configured = Number(process.env.PAYOUT_MAX);
  return Number.isFinite(configured) && configured > 0 ? configured : 100000;
}

app.post('/admin/banner', requireAdmin, (req, res) => {
  upload.single('banner')(req, res, (err) => {
    if (err) {
      setFlash(req, err.message, 'error');
      return res.redirect('/admin/settings');
    }
    if (!req.file) {
      setFlash(req, 'Please choose an image to upload.', 'error');
      return res.redirect('/admin/settings');
    }
    const previous = store.getSettings().banner;
    if (previous) {
      const prevPath = path.join(UPLOADS_DIR, path.basename(previous));
      fs.unlink(prevPath, () => {});
    }
    store.setSetting('banner', req.file.filename);
    setFlash(req, 'Banner photo updated.');
    res.redirect('/admin/settings');
  });
});

app.get('/admin/verify', requireAdmin, (req, res) => {
  res.render('admin/verify');
});

app.post('/admin/verify', requireAdmin, (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  if (!code) return res.redirect('/admin/verify');
  const ticket = store.getTicketByCode(code);
  res.render('admin/verify', { result: resolveTicket(ticket) });
});

app.post('/admin/verify/use/:ticketId', requireAdmin, (req, res) => {
  const ticket = store.getTicketByCode(String(req.body.code || '').trim()) || { id: Number(req.params.ticketId) };
  const used = store.markTicketUsed(ticket.id, 'Admin');
  setFlash(req, used ? 'Ticket marked as used. Person can now enter.' : 'Could not mark — already used or missing.', used ? 'success' : 'error');
  res.redirect('/admin/verify');
});

function resolveTicket(ticket) {
  if (!ticket) {
    return { found: false };
  }
  const item = store.getOrderWithTickets(ticket.order_id);
  const order = item ? item.order : null;
  return {
    found: true,
    ticket,
    order,
    ticketIndex: item ? item.tickets.findIndex((t) => t.id === ticket.id) + 1 : 0,
  };
}

/**
 * The transfer webhook is the authoritative signal that money actually left the
 * account, so it is what marks a payout completed. Matching is by our own reference,
 * which is sent on every payout we initiate.
 */
async function handlePayoutEvent(event) {
  if (!event.reference) {
    console.error(`${payments.displayName} payout webhook had no reference.`);
    return;
  }
  const payout = store.getPayoutByRef(event.reference);
  if (!payout) {
    console.error(`${payments.displayName} payout webhook referenced unknown payout: ${event.reference}`);
    return;
  }
  if (payout.status === 'completed' || payout.status === 'failed') return;

  store.markPayout(payout.id, {
    status: event.succeeded ? 'completed' : 'failed',
    fee: event.fee,
    completeMessage: event.message,
    transferId: event.providerId,
  });
  console.log(`Payout ${payout.reference} marked ${event.succeeded ? 'completed' : 'failed'}.`);
}

async function reconcileStalledPayments() {
  if (!payments.isConfigured()) return;
  const stalled = store.getOrdersAwaitingConfirmation(PAYMENT_WINDOW_MINUTES);
  for (const order of stalled) {
    try {
      const outcome = await settleOrder(order);
      if (outcome.paid) {
        console.log(`Reconciler settled order ${order.booking_ref}.`);
      } else if (outcome.reason) {
        console.log(`Reconciler released ${order.booking_ref}: ${outcome.reason}`);
        store.cancelOrder(order.id);
      }
    } catch (err) {
      console.error(`Reconciler error for ${order.booking_ref}:`, err.message);
    }
  }
}

/**
 * Webhooks get lost, so any payout still in flight is re-checked against the provider
 * on the same cadence. Without this a completed transfer with a dropped webhook would
 * sit as "processing" forever and never count against the available balance.
 */
const warnedPayoutIds = new Set();

async function reconcileStalledPayouts() {
  if (!payments.isConfigured()) return;
  for (const payout of store.getPayoutsInFlight()) {
    // A payout belongs to whichever gateway issued it. After a switchover its id is
    // meaningless to the current one, so asking anyway would just produce errors that
    // look like the transfer failed.
    if (payout.provider && payout.provider !== payments.name) {
      if (!warnedPayoutIds.has(payout.id)) {
        warnedPayoutIds.add(payout.id);
        console.error(
          `Payout ${payout.reference} was sent via ${payout.provider} and cannot be reconciled while ` +
            `${payments.displayName} is the configured gateway. Settle or cancel it in the ${payout.provider} dashboard.`
        );
      }
      continue;
    }
    if (!payout.provider_transfer_id) {
      // The row was written but no provider id came back, which means either the call
      // never reached the gateway or the response was lost. Neither gateway can look a
      // transfer up by our own reference, so there is nothing to retry: say so loudly
      // once and leave the row alone rather than calling a 404 every minute.
      if (!warnedPayoutIds.has(payout.id)) {
        warnedPayoutIds.add(payout.id);
        console.error(
          `Payout ${payout.reference} has no ${payments.displayName} id and cannot be checked automatically. ` +
            'Confirm it by hand in the provider dashboard and mark it settled.'
        );
      }
      continue;
    }
    try {
      const result = await payments.getTransfer(payout.provider_transfer_id);
      if (result.status !== 'processing') {
        store.markPayout(payout.id, {
          status: result.status,
          fee: result.fee,
          completeMessage: result.completeMessage,
        });
        console.log(`Payout ${payout.reference} reconciled to ${result.status}.`);
      }
    } catch (err) {
      console.error(`Payout reconcile failed for ${payout.reference}:`, err.message);
    }
  }
}

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Something went wrong. Please try again.');
});

const server = app.listen(PORT, () => {
  console.log(`Event ticket site running at http://localhost:${PORT}`);
  console.log(`Data directory: ${store.dataDir}`);
  console.log(`Payment gateway: ${payments.displayName}`);
  if (!payments.isConfigured()) {
    console.warn(`${payments.envKeys.secret} is not set - mobile money checkout is disabled.`);
  }
  if (!payments.isWebhookConfigured()) {
    console.warn(`${payments.envKeys.webhookSecret} is not set - payment webhooks will be rejected.`);
  }
  console.log(`Point ${payments.displayName} webhooks at: ${publicUrl()}${payments.webhookPath}`);
  if (!process.env.SESSION_SECRET) {
    console.warn('SESSION_SECRET is not set - a random secret is used, so every deploy signs admins out.');
  }
  if (ADMIN_PASSWORD === 'admin123') {
    console.warn('ADMIN_PASSWORD is still the default. Anyone can sign in to the admin area.');
  }
  if (process.env.NODE_ENV === 'production' && store.dataDir !== '/app/data') {
    console.warn(
      `Data directory is ${store.dataDir}, not the Railway volume at /app/data. ` +
        'If this is an ephemeral filesystem, every order, ticket and session will be lost on the next deploy.'
    );
  }
  const timer = setInterval(() => {
    reconcileStalledPayments().catch((err) => console.error('Reconciler failed:', err));
    reconcileStalledPayouts().catch((err) => console.error('Payout reconciler failed:', err));
  }, RECONCILE_INTERVAL_MS);
  timer.unref();
});

/**
 * Railway sends SIGTERM before every redeploy and whenever it stops the service. Node's
 * default is to die instantly, which cuts off any request mid-response and leaves no
 * trace in the log - so a routine deploy is indistinguishable from a crash. Closing the
 * listener drains what is in flight and makes the reason visible in the log.
 */
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`${signal} received - stopping gracefully.`);
    server.close(() => process.exit(0));
    // A socket that never drains must not hold the deploy open.
    setTimeout(() => {
      console.error(`${signal} shutdown timed out - forcing exit.`);
      process.exit(0);
    }, 10000).unref();
  });
}