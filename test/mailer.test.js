const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tickets-mailer-'));

const { parseMailFrom } = require('../mailer');

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
