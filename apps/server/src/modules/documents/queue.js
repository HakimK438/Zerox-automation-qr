'use strict';
/* In-process conversion queue with two lanes (plan C9):
   - fast:   PDFs and images (sub-second), small concurrency
   - office: LibreOffice conversions (CPU heavy), concurrency 1 on a 2-OCPU VM
   Each job runs in its own worker thread so the event loop stays responsive. */
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { kindOfMime, EXT_FOR_MIME } = require('./sniff');

// sharp must be initialised on the main thread before it is used inside worker threads.
require('sharp');

const WORKER = path.join(__dirname, 'convertWorker.js');
const RECYCLE_AFTER = 200;
const GENERIC_FAILURE = 'This file could not be prepared for printing. Please try another file.';

function createConversionQueue({ db, storage, config, logger, onUpdate = () => {} }) {
  const makeLane = (concurrency) => ({
    concurrency,
    waiting: [],
    running: 0,
    slots: Array.from({ length: concurrency }, () => ({ worker: null, jobs: 0, busy: false, pending: null }))
  });
  const lanes = { fast: makeLane(config.fastConcurrency), office: makeLane(config.officeConcurrency) };
  const idleWaiters = [];
  let jobSeq = 0;

  const q = {
    get: db.prepare('SELECT * FROM documents WHERE id = ?'),
    start: db.prepare("UPDATE documents SET conversion_status = 'converting', error = NULL WHERE id = ? AND conversion_status = 'queued'"),
    done: db.prepare(`UPDATE documents SET conversion_status = 'ready', pdf_key = ?, pdf_sha256 = ?, page_count = ?, converted_at = ?
      WHERE id = ? AND conversion_status = 'converting'`),
    fail: db.prepare("UPDATE documents SET conversion_status = 'failed', error = ?, converted_at = ? WHERE id = ? AND conversion_status = 'converting'"),
    pending: db.prepare(`SELECT d.id, d.mime_detected FROM documents d JOIN orders o ON o.id = d.order_id
      WHERE d.conversion_status IN ('queued','converting') AND d.purged_at IS NULL AND o.status = 'draft'
      ORDER BY d.created_at`),
    requeue: db.prepare("UPDATE documents SET conversion_status = 'queued' WHERE id = ? AND conversion_status = 'converting'")
  };

  const laneOf = (mime) => (kindOfMime(mime) === 'office' ? lanes.office : lanes.fast);
  const isIdle = () => Object.values(lanes).every((l) => l.running === 0 && l.waiting.length === 0);
  const notifyIdle = () => { if (isIdle()) idleWaiters.splice(0).forEach((r) => r()); };

  /* Persistent workers, one per concurrency slot. A worker that hangs is terminated and replaced;
     every worker is recycled after RECYCLE_AFTER jobs to bound memory growth. */
  function spawn(slot) {
    const w = new Worker(WORKER, { resourceLimits: { maxOldGenerationSizeMb: 512 } });
    w.unref();
    w.on('message', (msg) => { if (slot.pending) slot.pending(msg); });
    w.on('error', () => { /* 'exit' follows and settles the job */ });
    w.on('exit', () => {
      if (slot.worker === w) slot.worker = null;
      if (slot.pending) slot.pending({ ok: false, userMessage: GENERIC_FAILURE, internal: 'worker exited' });
    });
    slot.worker = w;
    slot.jobs = 0;
  }

  function runOnSlot(slot, job) {
    if (!slot.worker) spawn(slot);
    const jobId = ++jobSeq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const w = slot.worker;
        slot.worker = null;
        settle({ ok: false, userMessage: 'This file took too long to prepare. Please try a smaller file.', internal: 'worker timeout' });
        if (w) w.terminate();
      }, config.convertTimeoutMs + 15000);
      function settle(msg) {
        if (msg.jobId !== undefined && msg.jobId !== jobId) return; // stale reply from a replaced job
        clearTimeout(timer);
        slot.pending = null;
        slot.jobs += 1;
        if (slot.worker && slot.jobs >= RECYCLE_AFTER) { slot.worker.terminate(); slot.worker = null; }
        resolve(msg);
      }
      slot.pending = settle;
      slot.worker.postMessage({ jobId, job });
    });
  }

  async function convertOne(slot, id) {
    const doc = q.get.get(id);
    if (!doc || q.start.run(id).changes === 0) return; // deleted or already handled
    onUpdate(q.get.get(id));

    const dst = storage.pdfPath(doc.storage_key);
    const result = await runOnSlot(slot, {
      kind: kindOfMime(doc.mime_detected),
      ext: EXT_FOR_MIME[doc.mime_detected],
      src: storage.origPath(doc.storage_key),
      dst,
      maxPages: config.maxPagesPerDoc,
      sofficePath: config.sofficePath,
      timeoutMs: config.convertTimeoutMs
    });

    const at = new Date().toISOString();
    if (result.ok) {
      // pdf_key equals storage_key; the PDF lives at storage.pdfPath(key)
      const changed = q.done.run(doc.storage_key, result.pdfSha256, result.pageCount, at, id).changes;
      if (!changed) await fsp.rm(dst, { force: true }); // document was deleted mid-conversion
    } else {
      await fsp.rm(dst, { force: true });
      q.fail.run(result.userMessage, at, id);
      logger.warn('conversion_failed', { documentId: id, mime: doc.mime_detected, reason: String(result.internal || '').slice(0, 300) });
    }
    const updated = q.get.get(id);
    if (updated) onUpdate(updated);
  }

  function pump(lane) {
    while (lane.running < lane.concurrency && lane.waiting.length) {
      const id = lane.waiting.shift();
      const slot = lane.slots.find((s) => !s.busy);
      slot.busy = true;
      lane.running += 1;
      convertOne(slot, id)
        .catch((err) => logger.error('conversion_crash', { documentId: id, err: err.stack }))
        .finally(() => { slot.busy = false; lane.running -= 1; pump(lane); notifyIdle(); });
    }
  }

  async function close() {
    const all = Object.values(lanes).flatMap((l) => l.slots);
    await Promise.all(all.map((s) => (s.worker ? s.worker.terminate() : null)));
    for (const s of all) s.worker = null;
  }

  return {
    enqueue(doc) {
      const lane = laneOf(doc.mime_detected);
      lane.waiting.push(doc.id);
      pump(lane);
    },
    /** 1-based position among documents still waiting in the same lane, or 0 if not waiting. */
    position(doc) {
      return laneOf(doc.mime_detected).waiting.indexOf(doc.id) + 1;
    },
    /** Re-queues work interrupted by a restart. */
    recover() {
      for (const row of q.pending.all()) {
        q.requeue.run(row.id);
        this.enqueue(row);
      }
    },
    idle: () => (isIdle() ? Promise.resolve() : new Promise((r) => idleWaiters.push(r))),
    close
  };
}

module.exports = { createConversionQueue };
