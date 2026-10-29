const QRCode = require('qrcode');
const store = require('./db');
const payments = require('./payments');

const MAILERSEND_API_KEY = process.env.MAILERSEND_API_KEY;
const MAIL_FROM = process.env.MAIL_FROM;

function isMailEnabled() {
  return Boolean(MAILERSEND_API_KEY && MAIL_FROM);
}

function getPublicBaseUrl(publicUrl = process.env.PUBLIC_URL, railwayPublicDomain = process.env.RAILWAY_PUBLIC_DOMAIN) {
  const candidates = [publicUrl, railwayPublicDomain && `https://${railwayPublicDomain}`];
  for (const candidate of candidates) {
    if (!candidate) continue;

    try {
      const value = String(candidate).trim();
      const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`);
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) continue;
      return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
    } catch {
      continue;
    }
  }
  return '';
}

if (isMailEnabled()) {
  console.log(`Ticket emails enabled via MailerSend API from ${MAIL_FROM}`);
} else {
  console.log(`Ticket emails disabled - missing MAILERSEND_API_KEY or MAIL_FROM in environment. MAILERSEND_API_KEY present: ${Boolean(MAILERSEND_API_KEY)}, MAIL_FROM present: ${Boolean(MAIL_FROM)}`);
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

function parseMailFrom(value) {
  if (!value) return { email: '', name: 'Tickets' };
  const match = String(value).trim().match(/^(?:"([^"]+)"|([^<>]+))\s*<\s*([^<>]+)\s*>$/);
  if (match) {
    const name = (match[1] || match[2] || '').trim() || 'Tickets';
    const email = match[3].trim();
    return { email, name };
  }
  return { email: String(value).trim(), name: 'Tickets' };
}

async function sendTicketEmail(orderId) {
  console.log(`Attempting to send ticket email for order ${orderId}`);
  if (!isMailEnabled()) {
    console.log('Email not enabled');
    return;
  }

  try {
    const item = store.getOrderWithTickets(orderId);
    if (!item) {
      console.log(`Order ${orderId} not found`);
      return;
    }
    const order = item.order;
    const tickets = item.tickets || [];

    console.log(`Order ${order.booking_ref} status: ${order.status}, email: ${order.email}, sent: ${order.ticket_email_sent_at}`);
    if (!order.email) {
      console.log('No email on order');
      return;
    }
    if (order.ticket_email_sent_at) {
      console.log('Email already sent');
      return;
    }

    const settings = store.getSettings();
    const eventName = settings.eventName || 'Event';
    const eventDate = toDateLabel(settings.eventDate);
    const venue = settings.venue || '';
    const time = settings.eventTime || '';

    const publicBaseUrl = getPublicBaseUrl();
    const ticketLink = publicBaseUrl
      ? `${publicBaseUrl}/ticket/${encodeURIComponent(order.booking_ref)}`
      : '';
    if (!ticketLink) console.warn('Ticket email has no valid public site URL; omitting ticket link.');

    const ticketQrs = await Promise.all(tickets.map(async (ticket) => {
      const qrBuffer = await QRCode.toBuffer(ticket.code, { width: 320, margin: 2 });
      return {
        ticket,
        contentId: `ticket-qr-${ticket.code}`,
        content: qrBuffer.toString('base64'),
      };
    }));

    const ticketList = tickets
      .map((t, i) => `Ticket ${i + 1} - Code: <strong>${t.code}</strong>`)
      .join('<br>');

    const mf = parseMailFrom(MAIL_FROM);
    const fromEmail = mf.email || 'noreply@mailersend.net';
    const fromName = mf.name || 'Tickets';

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

          <p style="text-align:center;"><strong>Your Entry QR Code${ticketQrs.length === 1 ? '' : 's'}</strong></p>
          ${ticketQrs.map(({ ticket, contentId }, index) => `<div style="text-align:center;margin:20px 0;">
            <p><strong>Ticket ${index + 1} - ${ticket.code}</strong></p>
            <img src="cid:${contentId}" alt="Ticket QR Code" style="width:250px;height:250px;border:1px solid #ddd;padding:10px;background:#fff;" />
          </div>`).join('')}

          <p style="text-align:center;font-size:14px;color:#666;">Show this QR code at the gate for entry</p>

          ${ticketLink ? `<div style="text-align:center;margin:30px 0;">
            <a href="${ticketLink}" style="background:#7c3aed;color:#fff;padding:14px 28px;text-decoration:none;border-radius:6px;display:inline-block;">View & Download Your Tickets</a>
          </div>` : ''}

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

${ticketLink ? `View your tickets: ${ticketLink}` : 'Your QR code is attached to this email.'}

Ticket Codes:
${tickets.map((t, i) => `- Ticket ${i + 1}: ${t.code}`).join('\n')}

Show your QR code at the gate for entry.
    `.trim();

    const res = await fetch('https://api.mailersend.com/v1/email', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${MAILERSEND_API_KEY}`,
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify({
        from: { email: fromEmail, name: fromName },
        to: [{ email: order.email }],
        subject: `Your ${eventName} tickets - ${order.booking_ref}`,
        html,
        text,
        attachments: ticketQrs.flatMap(({ ticket, content, contentId }) => [
          {
            content,
            disposition: 'inline',
            filename: `ticket-${ticket.code}-qr.png`,
            id: contentId,
          },
          {
            content,
            disposition: 'attachment',
            filename: `ticket-${ticket.code}-qr.png`,
          },
        ]),
      }),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      console.error('Failed to send ticket email via MailerSend API:', res.status, data);
      return;
    }

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

module.exports = { sendTicketEmail, isMailEnabled, parseMailFrom, getPublicBaseUrl };
