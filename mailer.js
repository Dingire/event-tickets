const nodemailer = require('nodemailer');
const QRCode = require('qrcode');
const store = require('./db');
const payments = require('./payments');

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT) || 587;
const SMTP_SECURE = String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const MAIL_FROM = process.env.MAIL_FROM || SMTP_USER;
const PUBLIC_URL = String(process.env.PUBLIC_URL || '').replace(/\/+$/, '');

function isMailEnabled() {
  return Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS);
}

let transporter = null;

function getTransporter() {
  if (!isMailEnabled()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: {
        user: SMTP_USER,
        pass: SMTP_PASS,
      },
    });
  }
  return transporter;
}

function currency(n) {
  const num = Number(n) || 0;
  return `K ${num.toLocaleString('en-ZM')}`;
}

function toDateLabel(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return d;
  return dt.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

async function sendTicketEmail(orderId) {
  const transport = getTransporter();
  if (!transport) return;

  try {
    const item = store.getOrderWithTickets(orderId);
    if (!item) return;
    const order = item.order;
    const tickets = item.tickets || [];

    if (!order.email) return;
    if (order.ticket_email_sent_at) return;

    const settings = store.getSettings();
    const eventName = settings.eventName || 'Event';
    const eventDate = toDateLabel(settings.eventDate);
    const venue = settings.venue || '';
    const time = settings.eventTime || '';

    const ticketLink = PUBLIC_URL
      ? `${PUBLIC_URL}/ticket/${order.booking_ref}`
      : `/ticket/${order.booking_ref}`;

    const qrDataUrl = await QRCode.toDataURL(order.booking_ref, { width: 320, margin: 2 });

    const ticketList = tickets
      .map((t, i) => `Ticket ${i + 1} - Code: <strong>${t.code}</strong>`)
      .join('<br>');

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;background:#f9f9f9;">
        <div style="background:#1a1136;color:#fff;padding:20px;border-radius:8px 8px 0 0;text-align:center;">
          <h1 style="margin:0;">Payment Successful</h1>
        </div>
        <div style="background:#fff;padding:30px;border-radius:0 0 8px 8px;border:1px solid #eee;">
          <p>Hi there,</p>
          <p>Thank you for your payment. Your tickets for <strong>${eventName}</strong> are ready!</p>
          
          <div style="background:#f5f3ff;padding:20px;border-radius:8px;margin:20px 0;">
            <p style="margin:5px 0;"><strong>Event:</strong> ${eventName}</p>
            ${eventDate ? `<p style="margin:5px 0;"><strong>Date:</strong> ${eventDate}</p>` : ''}
            ${time ? `<p style="margin:5px 0;"><strong>Time:</strong> ${time}</p>` : ''}
            ${venue ? `<p style="margin:5px 0;"><strong>Venue:</strong> ${venue}</p>` : ''}
            <p style="margin:5px 0;"><strong>Booking Reference:</strong> ${order.booking_ref}</p>
            <p style="margin:5px 0;"><strong>Quantity:</strong> ${order.qty} ticket(s)</p>
            <p style="margin:5px 0;"><strong>Amount Paid:</strong> ${currency(order.charged_amount || order.amount)}</p>
            <p style="margin:5px 0;"><strong>Paid via:</strong> ${payments.displayName}</p>
          </div>

          <p style="text-align:center;"><strong>Your Entry QR Code</strong></p>
          <div style="text-align:center;margin:20px 0;">
            <img src="${qrDataUrl}" alt="Booking QR Code" style="width:250px;height:250px;border:1px solid #ddd;padding:10px;background:#fff;" />
          </div>

          <p style="text-align:center;font-size:14px;color:#666;">Show this QR code at the gate for entry</p>

          <div style="text-align:center;margin:30px 0;">
            <a href="${ticketLink}" style="background:#7c3aed;color:#fff;padding:14px 28px;text-decoration:none;border-radius:6px;display:inline-block;">View & Download Your Tickets</a>
          </div>

          <p style="font-size:14px;color:#666;"><strong>Your Ticket Codes:</strong><br>${ticketList}</p>

          <hr style="border:none;border-top:1px solid #eee;margin:30px 0;">

          <p style="font-size:12px;color:#999;text-align:center;">
            This email was sent because you purchased tickets for ${eventName}.<br>
            Keep this email safe - you'll need it to gain entry.
          </p>
        </div>
      </div>
    `;

    const text = `
Payment Successful - ${eventName}

Booking Reference: ${order.booking_ref}
Quantity: ${order.qty} ticket(s)
Amount Paid: ${currency(order.charged_amount || order.amount)}

View your tickets: ${ticketLink}

Ticket Codes:
${tickets.map((t, i) => `- Ticket ${i + 1}: ${t.code}`).join('\n')}

Show your QR code at the gate for entry.
    `.trim();

    await transport.sendMail({
      from: MAIL_FROM,
      to: order.email,
      subject: `Your ${eventName} tickets - ${order.booking_ref}`,
      text,
      html,
    });

    try {
      store.raw.prepare("UPDATE orders SET ticket_email_sent_at = datetime('now') WHERE id = ?").run(orderId);
    } catch (e) {
      // column might not exist yet, ignore
    }

    console.log(`Ticket email sent to ${order.email} for order ${order.booking_ref}`);
  } catch (err) {
    console.error('Failed to send ticket email:', err.message);
  }
}

module.exports = { sendTicketEmail, isMailEnabled };
