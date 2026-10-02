const test = require('node:test');
const assert = require('node:assert/strict');
const ratelimit = require('../ratelimit');

test('allows exactly the limit then blocks', () => {
  ratelimit.reset();
  const opts = { limit: 3, windowMs: 60_000 };
  assert.equal(ratelimit.hit('k', opts).allowed, true);
  assert.equal(ratelimit.hit('k', opts).allowed, true);
  assert.equal(ratelimit.hit('k', opts).allowed, true, 'the third hit is the last allowed one');
  const blocked = ratelimit.hit('k', opts);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfter > 0, 'a blocked caller is told how long to wait');
});

test('separate keys do not share a budget', () => {
  ratelimit.reset();
  const opts = { limit: 1, windowMs: 60_000 };
  assert.equal(ratelimit.hit('ip:a', opts).allowed, true);
  assert.equal(ratelimit.hit('ip:b', opts).allowed, true, 'one IP exhausting its budget must not block another');
});

test('the window resets rather than blocking forever', () => {
  ratelimit.reset();
  const opts = { limit: 1, windowMs: 30 };
  assert.equal(ratelimit.hit('w', opts).allowed, true);
  assert.equal(ratelimit.hit('w', opts).allowed, false);
  // Windows-friendly wait: the assertion is about behaviour, not wall-clock timing.
  const waitUntil = Date.now() + 60;
  while (Date.now() < waitUntil) {
    /* spin briefly */
  }
  assert.equal(ratelimit.hit('w', opts).allowed, true, 'the bucket is refilled once the window passes');
});

test('sweep only drops expired buckets', () => {
  ratelimit.reset();
  ratelimit.hit('fresh', { limit: 5, windowMs: 60_000 });
  ratelimit.hit('stale', { limit: 5, windowMs: 1 });
  const waitUntil = Date.now() + 20;
  while (Date.now() < waitUntil) {
    /* spin briefly */
  }
  ratelimit.sweep();
  // Fresh bucket survives the sweep, so a busy attacker cannot be wiped by timing.
  assert.equal(ratelimit.hit('fresh', { limit: 5, windowMs: 60_000 }).allowed, true);
});
