'use strict';
/* Print job dispatch (plan C6).
   - One job per document part. Jobs of an order form a "batch" (1 = first print, 2+ = reprints).
   - Automatic mode: a newly paid order gets jobs at once (unless paused). Manual mode: when the shop
     clicks "Start printing". No usable printer configured -> no jobs; the shop prints by hand.
   - The agent leases one job at a time (2-minute lease, extended by heartbeats) and downloads its PDF
     with a single-use token.
   - NEVER prints anything twice by itself: a lease that expires after the file was downloaded becomes
     "uncertain" and the order goes to Needs attention. Only an untouched lease (file never downloaded)
     is safely put back in the queue. Reprints are always a human decision. */
const { newId, randomToken, sha256, safeEqual } = require('../../lib/crypto');
const { ORDER_STATUS: S, canTransition } = require('../../../../../shared/constants');

const LEASE_MS = 2 * 60 * 1000;
const SPOOLED_LEASE_MS = 15 * 60 * 1000; // big jobs can sit in the Windows spooler for a while
const OPEN_JOB = ['queued', 'leased', 'spooled'];

function matches(printer, job) {
  if (job.color && !(printer.color && (printer.role === 'color' || printer.role === 'any'))) return false;
  if (!job.color && printer.role === 'color') return false;
  if (job.duplex && !printer.duplex) return false;
  return printer.paperSizes.includes(job.paper);
}

function createDispatcher({ db, agents, settings, storage, notify = () => {}, logger, now = () => Date.now() }) {
  const iso = (ms = now()) => new Date(ms).toISOString();
  const wake = new Set(); // listeners (agent streams) to poke when work appears
  const q = {
    order: db.prepare('SELECT * FROM orders WHERE id = ?'),
    parts: db.prepare(`SELECT p.*, d.id AS document_id, d.position AS doc_position FROM document_parts p
      JOIN documents d ON d.id = p.document_id WHERE d.order_id = ? ORDER BY d.position, d.created_at, p.position`),
    openJobs: db.prepare(`SELECT COUNT(*) FROM print_jobs WHERE order_id = ? AND status IN ('queued','leased','spooled')`).pluck(),
    anyJobs: db.prepare('SELECT COUNT(*) FROM print_jobs WHERE order_id = ?').pluck(),
    maxBatch: db.prepare('SELECT COALESCE(MAX(batch), 0) FROM print_jobs WHERE order_id = ?').pluck(),
    insertJob: db.prepare(`INSERT INTO print_jobs (id, order_id, part_id, document_id, status, attempt, is_reprint, batch, position, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'queued', 1, ?, ?, ?, ?, ?)`),
    queued: db.prepare(`SELECT j.*, p.color, p.duplex, p.paper, p.copies, p.page_ranges, p.sides, o.paid_at
      FROM print_jobs j JOIN document_parts p ON p.id = j.part_id JOIN orders o ON o.id = j.order_id
      WHERE j.status = 'queued' ORDER BY o.paid_at, j.batch, j.position LIMIT 200`),
    job: db.prepare('SELECT * FROM print_jobs WHERE id = ?'),
    jobFull: db.prepare(`SELECT j.*, p.color, p.duplex, p.paper, p.copies, p.page_ranges, p.sides FROM print_jobs j
      JOIN document_parts p ON p.id = j.part_id WHERE j.id = ?`),
    orderPrinter: db.prepare(`SELECT printer_id FROM print_jobs WHERE order_id = ? AND batch = ? AND printer_id IS NOT NULL
      AND agent_id = ? ORDER BY leased_at DESC LIMIT 1`).pluck(),
    agentBusy: db.prepare(`SELECT COUNT(*) FROM print_jobs WHERE agent_id = ? AND status = 'leased'`).pluck(),
    lease: db.prepare(`UPDATE print_jobs SET status = 'leased', printer_id = ?, agent_id = ?, leased_at = ?, lease_expires_at = ?,
      download_token_hash = ?, download_used_at = NULL, updated_at = ? WHERE id = ? AND status = 'queued'`),
    useDownload: db.prepare('UPDATE print_jobs SET download_used_at = ?, updated_at = ? WHERE id = ? AND download_used_at IS NULL'),
    setJob: db.prepare(`UPDATE print_jobs SET status = ?, spooler_job_id = COALESCE(?, spooler_job_id), error = ?, lease_expires_at = ?,
      printed_at = CASE WHEN ? = 'printed' THEN ? ELSE printed_at END, updated_at = ? WHERE id = ?`),
    extend: db.prepare(`UPDATE print_jobs SET lease_expires_at = ? WHERE id = ? AND agent_id = ? AND status IN ('leased','spooled')`),
    requeue: db.prepare(`UPDATE print_jobs SET status = 'queued', printer_id = NULL, agent_id = NULL, leased_at = NULL, lease_expires_at = NULL,
      download_token_hash = NULL, attempt = attempt + 1, updated_at = ? WHERE id = ? AND status = 'leased' AND download_used_at IS NULL`),
    expired: db.prepare(`SELECT * FROM print_jobs WHERE status IN ('leased','spooled') AND lease_expires_at <= ?`),
    cancelQueued: db.prepare(`UPDATE print_jobs SET status = 'cancelled', updated_at = ? WHERE order_id = ? AND status = 'queued'`),
    batchState: db.prepare(`SELECT status, COUNT(*) AS n FROM print_jobs WHERE order_id = ? AND batch = ? GROUP BY status`),
    jobsFor: db.prepare(`SELECT j.*, pr.display_name, pr.os_name FROM print_jobs j LEFT JOIN printers pr ON pr.id = j.printer_id
      WHERE j.order_id = ? ORDER BY j.batch, j.position`),
    paidWithoutJobs: db.prepare(`SELECT id FROM orders o WHERE status = 'paid'
      AND NOT EXISTS (SELECT 1 FROM print_jobs j WHERE j.order_id = o.id) ORDER BY paid_at LIMIT 100`).pluck(),
    setOrder: db.prepare(`UPDATE orders SET status = ?, updated_at = ?,
      printing_at = CASE WHEN ? = 'printing' THEN ? ELSE printing_at END,
      ready_at = CASE WHEN ? = 'ready' THEN ? ELSE ready_at END,
      needs_attention = CASE WHEN ? = 'print_attention' THEN ? WHEN ? = 'ready' THEN NULL ELSE needs_attention END
      WHERE id = ? AND status = ?`),
    event: db.prepare(`INSERT INTO order_events (id, order_id, from_status, to_status, actor, actor_id, reason, created_at)
      VALUES (?, ?, ?, ?, 'system', ?, ?, ?)`),
    audit: db.prepare(`INSERT INTO audit_logs (id, actor, actor_id, action, order_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
  };
  const audit = (actor, actorId, action, orderId, details) => q.audit.run(newId(), actor, actorId, action, orderId, JSON.stringify(details || {}), iso());

  /** System status change inside the caller's transaction. Returns true if it happened. */
  function moveOrder(orderId, to, { reason = null, attention = null, actorId = null } = {}) {
    const o = q.order.get(orderId);
    if (!o || o.status === to || !canTransition(o.status, to, 'system')) return false;
    const at = iso();
    if (!q.setOrder.run(to, at, to, at, to, at, to, attention, to, o.id, o.status).changes) return false;
    q.event.run(newId(), o.id, o.status, to, actorId, reason, at);
    return true;
  }

  const poke = () => { for (const fn of wake) fn(); };

  const jobView = (j) => ({ settings: { pages: j.page_ranges, color: !!j.color, duplex: !!j.duplex, copies: j.copies, paper: j.paper, sides: j.sides } });

  /* ---------- creating jobs ---------- */

  /**
   * Creates one job per part for the order (a new batch). Only when a usable printer setup exists
   * and the order has no open jobs. Returns the number of jobs created.
   */
  function startOrder(orderId, { reprint = false, adminId = null } = {}) {
    const enabled = agents.enabledPrinters();
    if (!enabled.length) return 0; // no print agent configured: the shop prints by hand
    let created = 0;
    let unprintable = false;
    db.transaction(() => {
      const o = q.order.get(orderId);
      if (!o || ![S.PAID, S.PRINTING].includes(o.status) || q.openJobs.get(orderId)) return;
      if (!reprint && q.anyJobs.get(orderId)) return; // first print already happened or is happening
      const parts = q.parts.all(orderId);
      if (!parts.length) return;
      const batch = q.maxBatch.get(orderId) + 1;
      const at = iso();
      parts.forEach((p, i) => {
        q.insertJob.run(newId(), orderId, p.id, p.document_id, reprint ? 1 : 0, batch, i, at, at);
        created += 1;
        if (!enabled.some((pr) => matches(pr, { color: !!p.color, duplex: !!p.duplex, paper: p.paper }))) unprintable = true;
      });
      if (reprint) audit('admin', adminId, 'reprint', orderId, { batch, jobs: created });
      if (unprintable) {
        q.cancelQueued.run(at, orderId);
        moveOrder(orderId, S.PRINT_ATTENTION, { reason: 'no_printer', attention: 'no_printer' });
        created = 0;
      }
    })();
    if (unprintable) notify(orderId);
    if (created) poke();
    return created;
  }

  /** Automatic mode: paid orders without jobs get them (on payment, unpause, switch to automatic, printer enabled). */
  function sweepAutomatic() {
    if (settings.paused() || settings.printMode() !== 'automatic') return 0;
    let n = 0;
    for (const id of q.paidWithoutJobs.all()) n += startOrder(id) ? 1 : 0;
    return n;
  }

  /** Called on every order event. */
  function onOrder(orderId) {
    const o = orderId && q.order.get(orderId);
    if (!o) return;
    if (o.status === S.PAID && !settings.paused() && settings.printMode() === 'automatic' && !q.anyJobs.get(o.id)) startOrder(o.id);
    // Order left the print path (ready by hand, refund, attention): drop jobs that have not started.
    if (![S.PAID, S.PRINTING].includes(o.status)) q.cancelQueued.run(iso(), o.id);
  }

  /* ---------- agent side ---------- */

  /** Leases the next job this agent can print, or returns null. One job at a time per agent. */
  function nextJob(agent) {
    if (settings.paused()) return null;
    if (q.agentBusy.get(agent.id)) return null;
    const mine = agents.usablePrinters().filter((p) => p.agentId === agent.id);
    if (!mine.length) return null;
    for (const j of q.queued.all()) {
      const want = { color: !!j.color, duplex: !!j.duplex, paper: j.paper };
      const sameAsBefore = q.orderPrinter.get(j.order_id, j.batch, agent.id);
      const printer = mine.find((p) => p.printerId === sameAsBefore && matches(p, want)) || mine.find((p) => matches(p, want));
      if (!printer) continue;
      const token = randomToken(32);
      const at = iso();
      const leased = db.transaction(() => {
        if (!q.lease.run(printer.printerId, agent.id, at, iso(now() + LEASE_MS), sha256(token), at, j.id).changes) return false;
        moveOrder(j.order_id, S.PRINTING, { reason: 'print_agent', actorId: agent.id });
        return true;
      })();
      if (!leased) continue;
      notify(j.order_id);
      const doc = db.prepare('SELECT sha256, pdf_sha256, storage_key FROM documents WHERE id = ?').get(j.document_id);
      return {
        jobId: j.id,
        orderId: j.order_id,
        printer: printer.osName,
        ...jobView(j),
        pdfUrl: `/api/agent/jobs/${j.id}/pdf`,
        downloadToken: token,
        sha256: doc?.pdf_sha256 || null,
        leaseMs: LEASE_MS
      };
    }
    return null;
  }

  /** Single-use download of the print PDF for a leased job. Returns the file path or null. */
  function download(agent, jobId, token) {
    const j = q.job.get(jobId);
    if (!j || j.agent_id !== agent.id || j.status !== 'leased' || !j.download_token_hash) return null;
    if (typeof token !== 'string' || !safeEqual(sha256(token), j.download_token_hash)) return null;
    if (!q.useDownload.run(iso(), iso(), j.id).changes) return null;
    const d = db.prepare('SELECT storage_key, conversion_status, purged_at FROM documents WHERE id = ?').get(j.document_id);
    if (!d || d.conversion_status !== 'ready' || d.purged_at) return null;
    return storage.pdfPath(d.storage_key);
  }

  function extend(agent, jobIds) {
    const until = iso(now() + LEASE_MS);
    for (const id of jobIds.slice(0, 20)) {
      const j = q.job.get(id);
      if (j && j.agent_id === agent.id) q.extend.run(j.status === 'spooled' ? iso(now() + SPOOLED_LEASE_MS) : until, id, agent.id);
    }
  }

  /**
   * Agent reports what happened. spooled -> waiting in Windows; printed -> done; failed/uncertain -> human decides.
   * Returns false if the job is not this agent's or already finished.
   */
  function result(agent, jobId, { status, spoolerJobId = null, error = null }) {
    let orderId = null;
    const ok = db.transaction(() => {
      const j = q.job.get(jobId);
      if (!j || j.agent_id !== agent.id || !['leased', 'spooled'].includes(j.status)) return false;
      if (status === 'spooled' && j.status !== 'leased') return false;
      const at = iso();
      const leaseUntil = status === 'spooled' ? iso(now() + SPOOLED_LEASE_MS) : null;
      q.setJob.run(status, spoolerJobId ? String(spoolerJobId).slice(0, 40) : null, error ? String(error).slice(0, 300) : null, leaseUntil, status, at, at, j.id);
      orderId = j.order_id;
      if (status === 'printed') {
        const counts = Object.fromEntries(q.batchState.all(j.order_id, j.batch).map((r) => [r.status, r.n]));
        const open = (counts.queued || 0) + (counts.leased || 0) + (counts.spooled || 0);
        const bad = (counts.failed || 0) + (counts.uncertain || 0);
        if (!open && !bad && counts.printed) moveOrder(j.order_id, S.READY, { reason: 'printed', actorId: agent.id });
      } else if (status === 'failed' || status === 'uncertain') {
        q.cancelQueued.run(at, j.order_id);
        const attention = status === 'failed' ? 'print_failed' : 'uncertain';
        moveOrder(j.order_id, S.PRINT_ATTENTION, { reason: attention, attention, actorId: agent.id });
        audit('agent', agent.id, `print_${status}`, j.order_id, { jobId: j.id, error });
      }
      return true;
    })();
    if (ok) { notify(orderId); if (status !== 'spooled') poke(); }
    return ok;
  }

  /** Expired leases: untouched -> back to the queue; possibly printed -> uncertain (never reprinted automatically). */
  function watchdog() {
    const summary = { requeued: 0, uncertain: 0 };
    for (const j of q.expired.all(iso())) {
      if (j.status === 'leased' && !j.download_used_at) {
        if (q.requeue.run(iso(), j.id).changes) summary.requeued += 1;
        continue;
      }
      db.transaction(() => {
        const at = iso();
        q.setJob.run('uncertain', null, 'lease expired: the agent stopped reporting', null, 'uncertain', at, at, j.id);
        q.cancelQueued.run(at, j.order_id);
        moveOrder(j.order_id, S.PRINT_ATTENTION, { reason: 'uncertain', attention: 'uncertain' });
        audit('system', null, 'print_uncertain', j.order_id, { jobId: j.id });
      })();
      summary.uncertain += 1;
      notify(j.order_id);
    }
    if (summary.requeued) poke();
    return summary;
  }

  const jobsFor = (orderId) => q.jobsFor.all(orderId).map((j) => ({
    jobId: j.id, batch: j.batch, reprint: !!j.is_reprint, status: j.status, printer: j.display_name || j.os_name || null,
    attempt: j.attempt, error: j.error, printedAt: j.printed_at
  }));

  let timer = null;
  return {
    startOrder, sweepAutomatic, onOrder, nextJob, paused: () => settings.paused(), download, extend, result, watchdog, jobsFor,
    onWork: (fn) => { wake.add(fn); return () => wake.delete(fn); },
    poke,
    start(intervalMs = 15000) {
      timer = setInterval(() => { try { watchdog(); } catch (err) { logger.error('print_watchdog_failed', { err: err.stack }); } }, intervalMs);
      timer.unref();
    },
    stop() { if (timer) clearInterval(timer); },
    LEASE_MS
  };
}

module.exports = { createDispatcher, matches, LEASE_MS, OPEN_JOB };
