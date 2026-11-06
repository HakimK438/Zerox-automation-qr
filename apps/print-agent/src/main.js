'use strict';
/* Quick Print agent for the shop's Windows PC.
     node src/main.js --pair ABCD-EFGH     pair once with the code from Dashboard -> Settings -> Printers
     node src/main.js                      run (normally as a Windows service, see windows/README.md)
   Loop: heartbeat (printers) every 15 s; on "work" (or every 10 s) lease ONE job, download it, check its
   SHA-256, print with SumatraPDF, follow the Windows spooler, report the result, delete the file.
   Anything unclear is reported as failed/uncertain; this program never retries a print by itself. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadConfig, saveSecret, loadSecret } = require('./config');
const { createApi } = require('./api');
const { discover } = require('./discover');
const { runSumatra, waitForSpooler } = require('./print');

const VERSION = require('../package.json').version;

function createLogger(file) {
  return (level, msg, data = {}) => {
    const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...data });
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, `${file}.1`);
      fs.appendFileSync(file, `${line}\n`);
    } catch { /* logging must never stop printing */ }
    if (process.stdout.isTTY || process.env.QP_AGENT_STDOUT) console.log(line);
  };
}

function createAgent(config, secret, { log = createLogger(config.logFile) } = {}) {
  const api = createApi({ serverUrl: config.serverUrl, secret });
  fs.mkdirSync(config.workDir, { recursive: true });
  // Leftovers from a crash: never print them again (the server already marked them uncertain).
  for (const f of fs.readdirSync(config.workDir)) if (f.startsWith('qp-')) fs.rmSync(path.join(config.workDir, f), { force: true });

  let printers = [];
  let busy = false;
  let again = false;
  let stopped = false;
  const active = new Set();
  const timers = [];
  const abort = new AbortController();

  async function heartbeat() {
    try { printers = await discover(config); } catch (err) { log('warn', 'discover_failed', { err: err.message }); }
    try {
      await api.heartbeat({ printers, version: VERSION, activeJobs: [...active] });
    } catch (err) {
      log('warn', 'heartbeat_failed', { err: err.message });
      if (err.status === 401) { log('error', 'revoked_or_unpaired'); stop(); }
    }
  }

  async function printOne(job) {
    const file = path.join(config.workDir, `qp-${job.jobId}.pdf`);
    active.add(job.jobId);
    let spooled = false;
    try {
      const pdf = await api.download(job);
      const hash = crypto.createHash('sha256').update(pdf).digest('hex');
      if (job.sha256 && hash !== job.sha256) throw Object.assign(new Error('file checksum mismatch'), { before: true });
      fs.writeFileSync(file, pdf, { mode: 0o600 });
      try {
        await runSumatra(config, job.printer, job.settings, file);
      } catch (err) { err.before = true; throw err; }
      spooled = true;
      await api.result(job.jobId, { status: 'spooled' });
      let spoolId = null;
      await waitForSpooler(config, job.printer, file, { onSpoolId: (id) => { spoolId = id; } });
      await api.result(job.jobId, { status: 'printed', spoolerJobId: spoolId });
      log('info', 'printed', { jobId: job.jobId, printer: job.printer });
    } catch (err) {
      // Before anything reached the printer -> failed; afterwards pages may be out -> uncertain.
      const status = spooled ? 'uncertain' : 'failed';
      log('warn', `print_${status}`, { jobId: job.jobId, err: err.message });
      try { await api.result(job.jobId, { status, error: err.message.slice(0, 300) }); } catch (e) { log('warn', 'result_failed', { err: e.message }); }
    } finally {
      active.delete(job.jobId);
      fs.rmSync(file, { force: true });
    }
  }

  async function work() {
    if (busy) { again = true; return; }
    busy = true;
    try {
      do {
        again = false;
        while (!stopped) {
          const job = await api.next();
          if (!job) break;
          await printOne(job);
        }
      } while (again && !stopped);
    } catch (err) {
      log('warn', 'work_failed', { err: err.message });
    } finally { busy = false; }
  }

  async function listen() {
    let delay = 1000;
    while (!stopped) {
      try {
        await api.events((ev) => {
          if (ev === 'work') work();
          if (ev === 'revoked') { log('error', 'revoked'); stop(); }
        }, abort.signal);
        delay = 1000;
      } catch (err) {
        if (stopped) return;
        if (err.status === 401) { log('error', 'revoked_or_unpaired'); stop(); return; }
        delay = Math.min(delay * 2, 30000);
      }
      if (!stopped) await new Promise((r) => setTimeout(r, delay));
    }
  }

  function stop() {
    stopped = true;
    abort.abort();
    timers.forEach(clearInterval);
  }

  return {
    async start() {
      log('info', 'agent_start', { version: VERSION, server: config.serverUrl });
      await heartbeat();
      timers.push(setInterval(heartbeat, config.heartbeatSec * 1000));
      timers.push(setInterval(work, config.pollSec * 1000));
      listen();
      work();
    },
    stop,
    heartbeat,
    work,
    idle: () => !busy
  };
}

async function main(argv = process.argv.slice(2)) {
  const config = loadConfig();
  if (!config.serverUrl) throw new Error('Set "serverUrl" in config.json (your shop site, e.g. https://print.example.com).');
  const i = argv.indexOf('--pair');
  if (i >= 0) {
    const code = argv[i + 1];
    if (!code) throw new Error('Usage: --pair ABCD-EFGH');
    const r = await createApi({ serverUrl: config.serverUrl }).pair(code, config.agentName);
    await saveSecret(config, r.secret);
    console.log(`Paired as "${config.agentName}". Start the service now (see windows/README.md).`);
    return null;
  }
  const secret = await loadSecret(config);
  if (!secret) throw new Error('Not paired yet. Run with --pair CODE (create the code in the dashboard).');
  const agent = createAgent(config, secret);
  await agent.start();
  const quit = () => { agent.stop(); setTimeout(() => process.exit(0), 200); };
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
  return agent;
}

if (require.main === module) main().catch((err) => { console.error(err.message); process.exit(1); });

module.exports = { createAgent, main, VERSION };
