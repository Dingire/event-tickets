/**
 * Fixed-window rate limiting, held in process memory.
 *
 * Deliberately no third-party dependency: this guards two routes, and a payment
 * site is a bad place to take on an unvetted dependency for the sake of one.
 *
 * Per-IP limits are generous on purpose. Mobile carriers in Zambia put many
 * subscribers behind a single shared NAT address, so an aggressive per-IP limit
 * would block genuine buyers at the busiest moment. The per-phone limit is what
 * actually stops someone farming every ticket into a pending reservation, because
 * one attacker cannot cheaply supply many phone numbers.
 */
const buckets = new Map();

function hit(key, { limit, windowMs }) {
  const now = Date.now();
  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1, retryAfter: 0 };
  }
  existing.count += 1;
  const retryAfter = Math.max(0, Math.ceil((existing.resetAt - now) / 1000));
  return {
    allowed: existing.count <= limit,
    remaining: Math.max(0, limit - existing.count),
    retryAfter,
  };
}

function sweep(now = Date.now()) {
  for (const [key, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(key);
  }
}

function reset() {
  buckets.clear();
}

// Without this the map grows forever, which is the leak the old session store had.
const sweepTimer = setInterval(() => sweep(), 5 * 60 * 1000);
sweepTimer.unref();

module.exports = { hit, sweep, reset };
