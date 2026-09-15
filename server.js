require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const QRCode = require('qrcode');
const store = require('./db');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const RESERVATION_MINUTES = 15;
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(
  session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 },
  })
);

const METHODS = {
  airtel: { id: 'airtel', name: 'Airtel Money', brand: 'airtel', preferred: true },
  mtn: { id: 'mtn', name: 'MTN Mobile Money', brand: 'mtn', preferred: false },
};

app.use((req, res, next) => {
  const settings = store.getSettings();
  res.locals.settings = settings;
  res.locals.currency = (n) => {
    const amount = Number(n || 0);
    return `${settings.currency} ${amount.toLocaleString('en-US')}`;
  };
  res.locals.methods = METHODS;
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

app.post('/checkout', (req, res) => {
  store.expireStalePending(RESERVATION_MINUTES);
  const options = store.getSettings();
  const qty = Number.parseInt(req.body.qty, 10);
  const method = METHODS[req.body.method] ? req.body.method : 'airtel';
  const phone = String(req.body.phone || '').trim();

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

  const amount = Number(options.price) * qty;
  const order = store.createOrder({ phone, method, qty, amount });
  res.redirect(`/pay/${order.id}`);
});

app.get('/pay/:id', (req, res) => {
  const item = store.getOrderWithTickets(req.params.id);
  if (!item || item.order.status === 'cancelled') {
    return res.render('pay', { item: null, error: 'This booking has expired or does not exist.' });
  }
  if (item.order.status === 'paid') return res.redirect(`/confirmation/${item.order.id}`);
  res.render('pay', { item, error: null });
});

app.post('/pay/:id', (req, res) => {
  const item = store.getOrderWithTickets(req.params.id);
  if (!item || item.order.status === 'cancelled') {
    return res.render('pay', { item: null, error: 'This booking has expired or does not exist.' });
  }
  if (item.order.status === 'paid') return res.redirect(`/confirmation/${item.order.id}`);

  const phone = String(req.body.phone || '').trim().replace(/[\s-]/g, '');
  const pin = String(req.body.pin || '').trim();

  if (!/^(\+?\d{9,12})$/.test(phone)) {
    return res.render('pay', { item, error: 'Please enter the mobile number paying for this booking.' });
  }
  if (!/^\d{4}$/.test(pin)) {
    return res.render('pay', { item, error: 'Please enter the 4-digit PIN for your ' + METHODS[item.order.method].name + ' account.' });
  }

  store.markOrderPaid(item.order.id);
  const paid = store.getOrderWithTickets(item.order.id);
  res.redirect(`/confirmation/${paid.order.id}`);
});

app.get('/pay/:id/cancel', (req, res) => {
  const order = store.getOrder(req.params.id);
  if (order && order.status === 'pending') {
    store.cancelOrder(order.id);
    setFlash(req, 'Your booking was cancelled. No payment was collected.');
  }
  res.redirect('/');
});

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

app.get('/admin', requireAdmin, (req, res) => {
  const options = store.getSettings();
  const total = Number(options.totalTickets) || 0;
  const sold = store.countSold();
  const reserved = store.countActivePending(RESERVATION_MINUTES);
  const remaining = Math.max(0, total - sold);
  const revenue = store.sumRevenue();
  const orders = store.getOrders();
  const tickets = store.getAllTickets();
  res.render('admin/dashboard', {
    total,
    sold,
    reserved,
    remaining,
    revenue,
    orders,
    tickets,
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

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Something went wrong. Please try again.');
});

app.listen(PORT, () => {
  console.log(`Event ticket site running at http://localhost:${PORT}`);
});