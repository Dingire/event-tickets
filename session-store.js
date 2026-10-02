/**
 * Session store backed by the same SQLite database as the orders, so admin logins
 * and any in-progress checkout survive a deploy on the persistent volume. This also
 * fixes the unbounded growth of the default in-memory store, which never evicted
 * expired sessions.
 */
const { Store } = require('express-session');

const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;

class SqliteStore extends Store {
  constructor(db, { ttlMs = DEFAULT_TTL_MS } = {}) {
    super();
    this.db = db;
    this.ttlMs = ttlMs;
    this.ensureSchema();
    this.timer = setInterval(() => this.prune(), 15 * 60 * 1000);
    this.timer.unref();
  }

  ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid        TEXT PRIMARY KEY,
        data       TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions(expires_at);
    `);
  }

  expiryFor(session) {
    const cookieExpires = session && session.cookie && session.cookie.expires;
    if (cookieExpires) return new Date(cookieExpires).getTime();
    return Date.now() + this.ttlMs;
  }

  get(sid, cb) {
    try {
      const row = this.db.prepare('SELECT data, expires_at FROM sessions WHERE sid = ?').get(sid);
      if (!row) return cb(null, null);
      if (row.expires_at <= Date.now()) {
        this.destroy(sid, () => {});
        return cb(null, null);
      }
      return cb(null, JSON.parse(row.data));
    } catch (err) {
      return cb(err);
    }
  }

  set(sid, session, cb = () => {}) {
    try {
      const expires = this.expiryFor(session);
      this.db
        .prepare(
          'INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at'
        )
        .run(sid, JSON.stringify(session), expires);
      return cb(null);
    } catch (err) {
      return cb(err);
    }
  }

  destroy(sid, cb = () => {}) {
    try {
      this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      return cb(null);
    } catch (err) {
      return cb(err);
    }
  }

  touch(sid, session, cb = () => {}) {
    try {
      this.db.prepare('UPDATE sessions SET expires_at = ? WHERE sid = ?').run(this.expiryFor(session), sid);
      return cb(null);
    } catch (err) {
      return cb(err);
    }
  }

  length(cb = () => {}) {
    try {
      return cb(null, Number(this.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n));
    } catch (err) {
      return cb(err);
    }
  }

  clear(cb = () => {}) {
    try {
      this.db.prepare('DELETE FROM sessions').run();
      return cb(null);
    } catch (err) {
      return cb(err);
    }
  }

  prune() {
    try {
      this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
    } catch {
      // A failed sweep is retried on the next tick; never fatal.
    }
  }
}

module.exports = { SqliteStore };
