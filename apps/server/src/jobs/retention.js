'use strict';
/* Data retention (phase 8): customer files live only as long as they are needed.
   - Delivered (handed over) or refunded orders: files deleted `afterHandoverHours` later (default 2 h).
   - Drafts nobody finished: cancelled and files deleted after `abandonedDraftHours` (default 24 h).
   - Expired / cancelled orders: files deleted after `unpaidHours` (default 1 h).
   File names are replaced too (they can be personal: "aadhaar_card.pdf"). Order, payment and print
   records stay for the accounts and reports. Raw Paytm payloads are blanked after 90 days.
   Orders still to be printed or collected are NEVER touched. */
const path = require('node:path');
const { newId } = require('../lib/crypto');
const { ORDER_STATUS: S, canTransition } = require('../../../../shared/constants');

const PAYLOAD_DAYS = 90;
const HOUR = 3600000;

function createRetentionJob({ db, storage, settings, logger, notify = () => {}, now = () => Date.now(), intervalMs = 10 * 60000 }) {
  const iso = (ms) => new Date(ms).toISOString();
  const q = {
    finished: db.prepare(`SELECT d.* FROM documents d JOIN orders o ON o.id = d.order_id WHERE d.purged_at IS NULL AND (
        (o.status = 'handed_over' AND o.handed_over_at <= ?) OR (o.status = 'refunded' AND o.updated_at <= ?)) LIMIT 500`),
    dead: db.prepare(`SELECT d.* FROM documents d JOIN orders o ON o.id = d.order_id WHERE d.purged_at IS NULL
        AND o.status IN ('expired','cancelled') AND o.updated_at <= ? LIMIT 500`),
    staleDrafts: db.prepare("SELECT id FROM orders WHERE status = 'draft' AND updated_at <= ? LIMIT 200").pluck(),
    cancel: db.prepare("UPDATE orders SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE id = ? AND status = 'draft'"),
    event: db.prepare(`INSERT INTO order_events (id, order_id, from_status, to_status, actor, reason, created_at)
      VALUES (?, ?, 'draft', 'cancelled', 'system', 'abandoned', ?)`),
    purge: db.prepare('UPDATE documents SET purged_at = ?, original_name = ? WHERE id = ? AND purged_at IS NULL'),
    oldPayloads: db.prepare("UPDATE payment_events SET payload = '{}' WHERE created_at <= ? AND payload <> '{}'")
  };

  async function purgeDocs(docs, at) {
    let n = 0;
    for (const d of docs) {
      try { await storage.remove(d.storage_key); } catch (err) { logger.warn('retention_remove_failed', { documentId: d.id, err: err.message }); continue; }
      const ext = path.extname(d.original_name).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 6);
      n += q.purge.run(iso(at), `deleted${ext}`, d.id).changes;
    }
    return n;
  }

  async function runOnce() {
    const t = now();
    const r = settings.retention();
    const summary = { purged: 0, draftsCancelled: 0, payloadsCleared: 0 };

    // Abandoned drafts first (they then fall under "cancelled" below on a later run, or right away).
    for (const id of q.staleDrafts.all(iso(t - r.abandonedDraftHours * HOUR))) {
      if (!canTransition(S.DRAFT, S.CANCELLED, 'system')) break;
      const changed = db.transaction(() => {
        if (!q.cancel.run(iso(t), iso(t), id).changes) return false;
        q.event.run(newId(), id, iso(t));
        return true;
      })();
      if (changed) { summary.draftsCancelled += 1; notify(id); }
    }

    const after = iso(t - r.afterHandoverHours * HOUR);
    summary.purged += await purgeDocs(q.finished.all(after, after), t);
    summary.purged += await purgeDocs(q.dead.all(iso(t - r.unpaidHours * HOUR)), t);
    summary.payloadsCleared = q.oldPayloads.run(iso(t - PAYLOAD_DAYS * 24 * HOUR)).changes;
    if (summary.purged || summary.draftsCancelled) logger.info('retention', summary);
    return summary;
  }

  let timer = null;
  let running = false;
  return {
    runOnce,
    start() {
      timer = setInterval(() => {
        if (running) return;
        running = true;
        runOnce().catch((err) => logger.error('retention_failed', { err: err.stack })).finally(() => { running = false; });
      }, intervalMs);
      timer.unref();
    },
    stop() { if (timer) clearInterval(timer); }
  };
}

module.exports = { createRetentionJob };
