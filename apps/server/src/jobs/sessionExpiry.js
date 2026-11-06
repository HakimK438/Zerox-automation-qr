'use strict';
/* Removes expired sessions that never placed an order. Sessions with orders are kept for the
   order history foreign key; they simply stop resolving once expired with no active order
   (see sessions/service.js). */

function createSessionExpiryJob({ db, logger, now = () => Date.now(), intervalMs = 60 * 60 * 1000 }) {
  const purge = db.prepare(`
    DELETE FROM sessions
    WHERE expires_at < ? AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.session_id = sessions.id)`);

  const runOnce = () => {
    const { changes } = purge.run(new Date(now()).toISOString());
    if (changes) logger.info('sessions_purged', { count: changes });
    return changes;
  };

  let timer = null;
  return {
    runOnce,
    start() { timer = setInterval(runOnce, intervalMs); timer.unref(); },
    stop() { if (timer) clearInterval(timer); }
  };
}

module.exports = { createSessionExpiryJob };
