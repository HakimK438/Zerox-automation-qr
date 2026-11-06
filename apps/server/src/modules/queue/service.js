'use strict';
/* Print queue and ETA (plan C5).
   - Queue = orders in paid / printing / print_attention, first paid first served.
   - Each order's work = setup + printed sides / speed (colour and B&W speeds differ; duplex ~10% slower).
   - ETA by list scheduling: jobs are placed, in queue order, on whichever printer frees up first.
     The order currently printing has already used part of its time.
   - Computed once per change and cached (the old backend recomputed the whole queue for every row).
   Until real printers report in (phase 7) the shop's "virtual printer" settings are used. */
const { ORDER_STATUS: S, QUEUE_STATUSES } = require('../../../../../shared/constants');

const DUPLEX_FACTOR = 1.1;

/** Minutes of printer time for one order's parts. */
function workMinutes(parts, cfg) {
  let min = cfg.setupSec / 60;
  for (const p of parts) {
    const ppm = p.color ? cfg.ppmColor : cfg.ppmBw;
    min += (p.sides / Math.max(1, ppm)) * (p.duplex ? DUPLEX_FACTOR : 1);
  }
  return min;
}

/**
 * Pure scheduler.
 * @param {Array<{id, status, work, startedAt?: number}>} jobs in queue order
 * @param {{ printers: number, paused: boolean, manual: boolean, manualDelayMin: number }} opts
 * @param {number} nowMs
 * @returns {Map<id, { position, ahead, etaMinutes, readyAt }>}
 */
function schedule(jobs, opts, nowMs) {
  const result = new Map();
  const free = Array.from({ length: Math.max(1, opts.printers) }, () => 0); // minutes from now
  let waitingSeen = 0;
  jobs.forEach((job, i) => {
    let remaining = job.work;
    if (job.status === S.PRINTING && job.startedAt) {
      remaining = Math.max(0.5, job.work - (nowMs - job.startedAt) / 60000);
    }
    const k = free.indexOf(Math.min(...free));
    let start = free[k];
    // Manual mode: the owner starts each waiting order by hand, which takes a little while.
    if (opts.manual && job.status === S.PAID) start += opts.manualDelayMin;
    const end = start + remaining;
    free[k] = end;
    const entry = {
      position: i + 1,
      ahead: i,
      etaMinutes: opts.paused ? null : Math.max(1, Math.ceil(end)),
      readyAt: opts.paused ? null : new Date(nowMs + end * 60000).toISOString()
    };
    if (job.status === S.PAID) waitingSeen += 1;
    result.set(job.id, entry);
  });
  return result;
}

function createQueueService({ db, settings, now = () => Date.now(), printers = () => [] }) {
  const statusList = QUEUE_STATUSES.map(() => '?').join(',');
  const q = {
    queue: db.prepare(`SELECT id, status, paid_at, printing_at FROM orders WHERE status IN (${statusList})
      ORDER BY paid_at, id`),
    parts: db.prepare(`SELECT d.order_id, p.color, p.duplex, p.sides FROM document_parts p
      JOIN documents d ON d.id = p.document_id
      JOIN orders o ON o.id = d.order_id
      WHERE o.status IN (${statusList})`)
  };

  let cache = null;
  const invalidate = () => { cache = null; };
  settings.onChange((key) => { if (key === 'queue' || key === 'paused' || key === 'print_mode') invalidate(); });

  function options() {
    let cfg = settings.queue();
    let count = Math.max(1, Number(cfg.printers) || 1);
    // Real printers reported by the print agent (enabled + ready) replace the virtual ones.
    const real = printers();
    if (real.length) {
      const avg = (k) => Math.round(real.reduce((a, p) => a + p[k], 0) / real.length);
      cfg = { ...cfg, ppmBw: avg('ppmBw'), ppmColor: avg('ppmColor') };
      count = real.length;
    }
    return {
      cfg,
      printers: count,
      paused: settings.paused(),
      manual: settings.printMode() === 'manual',
      manualDelayMin: Number(cfg.manualDelayMin) || 0
    };
  }

  function compute() {
    const t = now();
    if (cache && t - cache.at < 30000) return cache; // ETAs drift with time: refresh at least every 30 s
    const opts = options();
    const partsByOrder = new Map();
    for (const p of q.parts.all(...QUEUE_STATUSES)) {
      if (!partsByOrder.has(p.order_id)) partsByOrder.set(p.order_id, []);
      partsByOrder.get(p.order_id).push({ color: !!p.color, duplex: !!p.duplex, sides: p.sides || 0 });
    }
    const jobs = q.queue.all(...QUEUE_STATUSES).map((o) => ({
      id: o.id,
      status: o.status,
      work: workMinutes(partsByOrder.get(o.id) || [], opts.cfg),
      startedAt: o.printing_at ? Date.parse(o.printing_at) : null
    }));
    cache = { at: t, opts, jobs, entries: schedule(jobs, opts, t) };
    return cache;
  }

  /** Queue info for one order, or null when it is not in the queue. */
  function infoFor(orderId) {
    const c = compute();
    const e = c.entries.get(orderId);
    if (!e) return null;
    return { ...e, length: c.jobs.length, paused: c.opts.paused, printMode: c.opts.manual ? 'manual' : 'automatic' };
  }

  /** ETA for a not-yet-paid order of `sides` printed sides (dock estimate on the upload page). */
  function estimate({ bwSides = 0, colorSides = 0, duplex = false }) {
    const c = compute();
    const parts = [];
    if (bwSides) parts.push({ color: false, duplex, sides: bwSides });
    if (colorSides) parts.push({ color: true, duplex, sides: colorSides });
    const jobs = [...c.jobs, { id: '__new__', status: S.PAID, work: workMinutes(parts, c.opts.cfg) }];
    const e = schedule(jobs, c.opts, now()).get('__new__');
    return { etaMinutes: e.etaMinutes, ahead: e.ahead, paused: c.opts.paused, printMode: c.opts.manual ? 'manual' : 'automatic' };
  }

  /** Ids of every order currently in the queue (their ETAs change when the queue changes). */
  const queuedOrderIds = () => compute().jobs.map((j) => j.id);

  return { infoFor, estimate, invalidate, queuedOrderIds };
}

module.exports = { createQueueService, schedule, workMinutes };
