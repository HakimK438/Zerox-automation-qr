'use strict';
/* Token + PIN recovery (plan C1). Moves an active order to the caller's session, e.g. when the QR
   scanner or UPI app opened the site in a different browser with its own cookies.
   The same 4-digit PIN is shown on the token page and is asked for at pickup. */
const { sha256, safeEqual, newId } = require('../../lib/crypto');
const { istDate } = require('../../lib/token');
const { ACTIVE_ORDER_STATUSES } = require('../../../../../shared/constants');

const MAX_RECOVERY_FAILURES = 10;  // then the order can only be recovered at the counter
const LOOKBACK_DAYS = 3;           // tokens restart daily; ready orders may be collected a few days later

/** PIN hash, salted with the order id so equal PINs on different orders hash differently. */
const hashRecoveryPin = (orderId, pin) => sha256(`${orderId}:${pin}`);

function createRecoveryService({ db, now = () => Date.now() }) {
  const activeList = ACTIVE_ORDER_STATUSES.map(() => '?').join(',');
  const q = {
    candidates: db.prepare(`
      SELECT id, session_id, recovery_pin_hash, recovery_failures, recovery_locked_at
      FROM orders
      WHERE token_no = ? AND token_date >= ? AND status IN (${activeList}) AND recovery_pin_hash IS NOT NULL`),
    claim: db.prepare('UPDATE orders SET session_id = ?, recovery_failures = 0, updated_at = ? WHERE id = ?'),
    fail: db.prepare(`
      UPDATE orders SET recovery_failures = recovery_failures + 1,
        recovery_locked_at = CASE WHEN recovery_failures + 1 >= ? THEN ? ELSE recovery_locked_at END
      WHERE id = ? AND recovery_locked_at IS NULL`),
    audit: db.prepare(`INSERT INTO audit_logs (id, actor, actor_id, action, order_id, details, ip, created_at)
      VALUES (?, 'system', NULL, ?, ?, ?, ?, ?)`)
  };

  /**
   * @returns {{ ok: true, orderId: string } | { ok: false, reason: 'no_match' | 'locked' }}
   * Callers must answer 'no_match' identically for unknown tokens and wrong PINs.
   */
  const recover = db.transaction(({ tokenNo, pin, sessionId, ip }) => {
    const t = now();
    const iso = new Date(t).toISOString();
    const rows = q.candidates.all(tokenNo, istDate(t, -LOOKBACK_DAYS), ...ACTIVE_ORDER_STATUSES);

    const open = rows.filter((r) => !r.recovery_locked_at);
    const match = open.find((r) => safeEqual(hashRecoveryPin(r.id, pin), r.recovery_pin_hash));
    if (match) {
      q.claim.run(sessionId, iso, match.id);
      q.audit.run(newId(), 'order_recovered', match.id,
        JSON.stringify({ fromSession: match.session_id === sessionId ? 'same' : 'other' }), ip || null, iso);
      return { ok: true, orderId: match.id };
    }

    for (const r of open) {
      q.fail.run(MAX_RECOVERY_FAILURES, iso, r.id);
    }
    if (rows.length > 0 && open.length === 0) return { ok: false, reason: 'locked' };
    return { ok: false, reason: 'no_match' };
  });

  return { recover };
}

module.exports = { createRecoveryService, hashRecoveryPin, MAX_RECOVERY_FAILURES };
