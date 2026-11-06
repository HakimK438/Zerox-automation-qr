'use strict';
/* Demo printer (test mode only): stands in for the print agent on the shop PC so the whole journey can
   be watched without a real printer. It uses the real queue: it registers as a normal agent, takes jobs
   from dispatcher.nextJob, downloads the file once, and reports spooled then printed. Only the paper is
   pretend. Created only when config.testPayments is on, which production refuses. */
const { formatToken } = require('../../lib/token');

const NAME = 'Demo printer';
const MS_PER_SIDE = 1500;
const MAX_JOB_MS = 25000;
const HEARTBEAT_MS = 15000;
const POLL_MS = 2000;

const PRINTER = { name: NAME, driver: 'Demo', status: 'Normal', color: true, duplex: true, paperSizes: ['A4', 'A3'] };

function createDemoPrinter({ db, agents, dispatcher, bus, logger, msPerSide = MS_PER_SIDE }) {
  let agent = null;
  let beat = null;
  let poll = null;
  let unsubscribe = null;
  let busy = false;
  let current = null;  // the job being printed
  let lastDone = null;
  let speed = msPerSide;

  const find = () => db.prepare('SELECT * FROM agents WHERE name = ? AND revoked_at IS NULL AND secret_hash IS NOT NULL').get(NAME);
  const jobInfo = db.prepare(`SELECT o.token_no, d.original_name FROM print_jobs j JOIN orders o ON o.id = j.order_id
    JOIN documents d ON d.id = j.document_id WHERE j.id = ?`);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const heartbeat = () => agents.heartbeat(agent, { printers: [PRINTER], version: 'demo' });

  function finish(status, error) {
    const job = current;
    current = null;
    if (job && agent) dispatcher.result(agent, job.jobId, { status, error });
    return job;
  }

  async function print(job) {
    const info = jobInfo.get(job.jobId) || {};
    const { color, duplex, sides, copies } = job.settings;
    const pages = Math.max(1, sides || 1);
    const step = Math.min(speed, MAX_JOB_MS / pages);
    current = { jobId: job.jobId, token: formatToken(info.token_no), file: info.original_name, color, duplex, copies, page: 0, pages };
    if (!dispatcher.download(agent, job.jobId, job.downloadToken)) return finish('failed', 'The file could not be downloaded.');
    dispatcher.result(agent, job.jobId, { status: 'spooled' });
    for (let page = 1; page <= pages; page += 1) {
      if (!current) return null; // switched off while printing: already reported
      current.page = page;
      await sleep(step);
    }
    if (!current) return null;
    const done = finish('printed');
    lastDone = { token: done.token, at: Date.now() };
    return done;
  }

  function tick() {
    if (!agent || busy) return;
    const job = dispatcher.nextJob(agent);
    if (!job) return;
    busy = true;
    print(job)
      .catch((err) => logger.error('demo_printer_failed', { err: err.stack }))
      .finally(() => { busy = false; setImmediate(tick); });
  }

  function clearTimers() {
    clearInterval(beat);
    clearInterval(poll);
    if (unsubscribe) unsubscribe();
    beat = poll = unsubscribe = null;
  }

  /** Stops work. A job in progress is reported as failed, so it shows on the dashboard and is never lost. */
  function halt() {
    clearTimers();
    finish('failed', 'The demo printer was switched off.');
    agent = null;
  }

  function on() {
    if (agent) return state();
    agent = find();
    if (!agent) {
      const { code } = agents.createPairing(null);
      agents.pair({ code, name: NAME });
      agent = find();
    }
    heartbeat();
    const printer = agents.overview().printers.find((p) => p.agentId === agent.id);
    if (!printer.enabled) agents.updatePrinter(printer.printerId, { ...printer, enabled: true, role: 'any' }, null);
    beat = setInterval(heartbeat, HEARTBEAT_MS);
    poll = setInterval(tick, POLL_MS);
    beat.unref(); poll.unref();
    unsubscribe = dispatcher.onWork(tick);
    bus.emit('queue'); // paid orders waiting for a printer can start now
    tick();
    return state();
  }

  function off() {
    const id = agent?.id;
    halt();
    if (id) agents.revoke(id, null);
    return state();
  }

  const state = () => ({
    on: !!agent,
    printing: current ? { token: current.token, file: current.file, color: current.color, duplex: current.duplex, page: current.page, pages: current.pages } : null,
    lastDone: lastDone?.token || null
  });

  return { on, off, stop: halt, state, setSpeed: (ms) => { speed = ms; } };
}

module.exports = { createDemoPrinter, NAME };
