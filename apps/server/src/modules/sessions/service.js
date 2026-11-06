'use strict';
/* Anonymous customer sessions (plan C1).
   - The cookie holds a 256-bit random token; the database stores only its SHA-256 hash.
   - Sliding 30-day lifetime, refreshed at most once per hour of activity.
   - A session that owns an active order never expires (no time limit), so a customer who closes the
     tab or kills the browser still sees their order when they come back, until it is delivered.
   - When its last order is delivered (handed over) or refunded, the session ends: after a short grace
     period (show "Collected", take a rating) it stops resolving and the next visit starts fresh.
     Starting a new order inside the grace period keeps the session going. */
const { randomToken, newId, sha256 } = require('../../lib/crypto');
const { ACTIVE_ORDER_STATUSES } = require('../../../../../shared/constants');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const END_GRACE_MS = 60 * 60 * 1000;
// Browser cookie lifetime: the server decides validity, so the cookie must never expire before an
// order is delivered, however long it waits. 400 days is the maximum browsers accept.
const COOKIE_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000;
const FINISHED_STATUSES = ['handed_over', 'refunded'];
const SLIDE_INTERVAL_MS = 60 * 60 * 1000;
const MAX_TOKEN_LENGTH = 128;

function createSessionService({ db, now = () => Date.now() }) {
  const activeList = ACTIVE_ORDER_STATUSES.map(() => '?').join(',');
  const q = {
    insert: db.prepare('INSERT INTO sessions (id, token_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)'),
    byHash: db.prepare('SELECT * FROM sessions WHERE token_hash = ?'),
    touch: db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?'),
    hasActive: db.prepare(`SELECT 1 FROM orders WHERE session_id = ? AND status IN (${activeList}) LIMIT 1`).pluck(),
    hasDraft: db.prepare("SELECT 1 FROM orders WHERE session_id = ? AND status = 'draft' LIMIT 1").pluck(),
    end: db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL'),
    unend: db.prepare('UPDATE sessions SET ended_at = NULL WHERE id = ?'),
    orderSession: db.prepare('SELECT session_id, status FROM orders WHERE id = ?')
  };

  function create() {
    const t = now();
    const token = randomToken(32);
    const session = {
      id: newId(),
      createdAt: new Date(t).toISOString(),
      expiresAt: new Date(t + SESSION_TTL_MS).toISOString()
    };
    q.insert.run(session.id, sha256(token), session.createdAt, session.createdAt, session.expiresAt);
    return { ...session, token };
  }

  const hasActiveOrder = (sessionId) => Boolean(q.hasActive.get(sessionId, ...ACTIVE_ORDER_STATUSES));

  /**
   * Resolves a cookie token to a live session, or null.
   * Returns { id, expiresAt, refreshed } where `refreshed` means the cookie should be re-issued.
   */
  function resolve(token) {
    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
    const row = q.byHash.get(sha256(token));
    if (!row) return null;

    const t = now();
    if (row.ended_at) {
      if (hasActiveOrder(row.id) || q.hasDraft.get(row.id)) {
        q.unend.run(row.id); // a new order started: the session continues
      } else if (Date.parse(row.ended_at) + END_GRACE_MS <= t) {
        return null;
      } else {
        return { id: row.id, expiresAt: new Date(Date.parse(row.ended_at) + END_GRACE_MS).toISOString(), refreshed: false };
      }
    }
    const expired = Date.parse(row.expires_at) <= t;
    if (expired && !hasActiveOrder(row.id)) return null;

    const due = expired || t - Date.parse(row.last_seen_at) >= SLIDE_INTERVAL_MS;
    if (!due) return { id: row.id, expiresAt: row.expires_at, refreshed: false };

    const expiresAt = new Date(t + SESSION_TTL_MS).toISOString();
    q.touch.run(new Date(t).toISOString(), expiresAt, row.id);
    return { id: row.id, expiresAt, refreshed: true };
  }

  /** Called after any order change: ends the session once nothing is left to collect. */
  function endIfDelivered(orderId) {
    const o = q.orderSession.get(orderId);
    if (!o || !FINISHED_STATUSES.includes(o.status)) return false;
    if (hasActiveOrder(o.session_id) || q.hasDraft.get(o.session_id)) return false;
    return q.end.run(new Date(now()).toISOString(), o.session_id).changes > 0;
  }

  return { create, resolve, hasActiveOrder, endIfDelivered };
}

module.exports = { createSessionService, SESSION_TTL_MS, COOKIE_MAX_AGE_MS, END_GRACE_MS };
