const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const QRCode = require('qrcode');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tickets-mailer-'));
process.env.MAILERSEND_API_KEY = 'test-api-key';
process.env.MAIL_FROM = 'tickets@example.com';
process.env.PUBLIC_URL = 'http://';
process.env.RAILWAY_PUBLIC_DOMAIN = 'tickets.example.up.railway.app';

const store = require('../db');
const { parseMailFrom, getPublicBaseUrl, sendTicketEmail } = require('../mailer');

test('parses a plain sender email address', () => {
  assert.deepEqual(parseMailFrom('tickets@example.com'), {
    email: 'tickets@example.com',
    name: 'Tickets',
  });
});

test('parses an unquoted sender display name and email', () => {
  assert.deepEqual(parseMailFrom('Event Tickets <tickets@example.com>'), {
    email: 'tickets@example.com',
    name: 'Event Tickets',
  });
});

test('parses a quoted sender display name and email', () => {
  assert.deepEqual(parseMailFrom('"Event Tickets" <tickets@example.com>'), {
    email: 'tickets@example.com',
    name: 'Event Tickets',
  });
});

test('uses the Railway public domain when PUBLIC_URL is invalid', () => {
  assert.equal(
    getPublicBaseUrl('http://', 'tickets.example.up.railway.app'),
    'https://tickets.example.up.railway.app'
  );
});

test('omits a ticket link when no valid public URL is available', () => {
  assert.equal(getPublicBaseUrl('http://', ''), '');
});

test('sends inline and downloadable ticket QR images with an absolute ticket link', async (t) => {
  const order = store.createOrder({
    phone: '260955000001',
    email: 'buyer@example.com',
    method: 'zmw',
    qty: 2,
    amount: 300,
  });
  store.markOrderPaid(order.id, {});

  const originalFetch = global.fetch;
  let requestBody;
  global.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return { ok: true, status: 202, json: async () => ({}) };
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  await sendTicketEmail(order.id);

  const tickets = store.getOrderWithTickets(order.id).tickets;
  const ticketUrl = `https://tickets.example.up.railway.app/ticket/${order.booking_ref}`;
  assert.ok(requestBody.html.includes(`href="${ticketUrl}"`));
  assert.ok(requestBody.text.includes(ticketUrl));
  assert.equal(requestBody.attachments.length, tickets.length * 2);

  for (const ticket of tickets) {
    const inlineImage = requestBody.attachments.find((attachment) => attachment.disposition === 'inline' && attachment.id === `ticket-qr-${ticket.code}`);
    const downloadableImage = requestBody.attachments.find((attachment) => attachment.disposition === 'attachment' && attachment.filename === `ticket-${ticket.code}-qr.png`);
    const expectedQr = await QRCode.toBuffer(ticket.code, { width: 320, margin: 2 });
    assert.ok(requestBody.html.includes(`src="cid:ticket-qr-${ticket.code}"`));
    assert.ok(inlineImage);
    assert.ok(downloadableImage);
    assert.deepEqual(Buffer.from(downloadableImage.content, 'base64'), expectedQr);
  }
});
