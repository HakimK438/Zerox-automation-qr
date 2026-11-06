'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { printSettings, sumatraArgs, waitForSpooler } = require('../src/print');
const { parsePrinters } = require('../src/discover');
const { createAgent } = require('../src/main');
const { createApi } = require('../src/api');
const { loadConfig } = require('../src/config');

const FAKE_PS = [process.execPath, path.join(__dirname, 'fakes', 'powershell.js')];
const FAKE_SUMATRA = [process.execPath, path.join(__dirname, 'fakes', 'sumatra.js')];

/* ---------- units ---------- */

test('SumatraPDF settings: ranges, sides, colour, copies, paper, fit', () => {
  assert.equal(printSettings({ pages: 'all', color: false, duplex: false, copies: 1, paper: 'A4' }), 'simplex,monochrome,1x,paper=A4,fit');
  assert.equal(printSettings({ pages: '1-3, 5', color: true, duplex: true, copies: 3, paper: 'A3' }), '1-3,5,duplexlong,color,3x,paper=A3,fit');
  assert.deepEqual(sumatraArgs('HP', { pages: 'all', copies: 1 }, 'C:\\w\\qp-1.pdf').slice(0, 2), ['-print-to', 'HP']);
});

test('WMI printer rows -> heartbeat format; virtual printers ignored', () => {
  const rows = [
    { Name: 'HP LaserJet', DriverName: 'HP UPD', PrinterStatus: 3, WorkOffline: false, DetectedErrorState: 2, CapabilityDescriptions: ['Copies', 'Duplex', 'Collate'], PrinterPaperNames: ['A4', 'Letter'] },
    { Name: 'Epson L3250', DriverName: 'EPSON', PrinterStatus: 3, DetectedErrorState: 0, CapabilityDescriptions: ['Copies', 'Color'], PrinterPaperNames: ['A4 210 x 297 mm', 'A3'] },
    { Name: 'Canon Jammed', PrinterStatus: 3, DetectedErrorState: 8, CapabilityDescriptions: [] },
    { Name: 'Old one', PrinterStatus: 7 },
    { Name: 'Microsoft Print to PDF', PrinterStatus: 3 }
  ];
  const out = parsePrinters(JSON.stringify(rows), ['Microsoft Print to PDF']);
  assert.deepEqual(out.map((p) => [p.name, p.status, p.color, p.duplex, p.paperSizes.join('+')]), [
    ['HP LaserJet', 'Normal', false, true, 'A4'],
    ['Epson L3250', 'Normal', true, false, 'A4+A3'],
    ['Canon Jammed', 'Error 8', false, false, 'A4'],
    ['Old one', 'Offline', false, false, 'A4']
  ]);
  assert.deepEqual(parsePrinters(JSON.stringify(rows[0])).length, 1, 'single object (one printer) handled');
});

test('spooler: waits while the job is queued, fails on a printer error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-spool-'));
  process.env.QP_FAKE_SPOOL = path.join(dir, 'spool.json');
  const config = { powershell: FAKE_PS, spoolerTimeoutSec: 5 };
  let polls = 0;
  fs.writeFileSync(process.env.QP_FAKE_SPOOL, JSON.stringify({ Id: 7, JobStatus: 'Printing' }));
  const done = await waitForSpooler(config, 'HP', 'qp-x.pdf', {
    intervalMs: 1,
    sleep: async () => { polls += 1; if (polls === 2) fs.writeFileSync(process.env.QP_FAKE_SPOOL, ''); }
  });
  assert.equal(done, 'printed');
  fs.writeFileSync(process.env.QP_FAKE_SPOOL, JSON.stringify([{ Id: 8, JobStatus: 'Error, PaperOut' }]));
  await assert.rejects(waitForSpooler(config, 'HP', 'qp-x.pdf', { intervalMs: 1, sleep: async () => {} }), /PaperOut/);
  fs.writeFileSync(process.env.QP_FAKE_SPOOL, '');
});

test('config: refuses plain http to a remote server', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-cfg-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ serverUrl: 'http://print.example.com' }));
  assert.throws(() => loadConfig(dir, path.join(dir, 'config.json')), /https/);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ serverUrl: 'https://print.example.com/some/path' }));
  assert.equal(loadConfig(dir, path.join(dir, 'config.json')).serverUrl, 'https://print.example.com');
});

/* ---------- the real agent against the real server (fake Windows tools) ---------- */

const SERVER_TEST = path.resolve(__dirname, '../../server/test');
const { setup, adminLogin } = require(path.join(SERVER_TEST, 'adminKit'));
const { newCustomer, addPdf } = require(path.join(SERVER_TEST, 'fixtures'));

async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return false;
}

async function paidOrder(ctx) {
  const c = await newCustomer(ctx.base);
  await addPdf(ctx, c, 2);
  await c.call(`/api/orders/${c.orderId}/checkout`, { method: 'POST' });
  const pay = await (await c.call(`/api/orders/${c.orderId}/payments`, { method: 'POST' })).json();
  ctx.mock.setStatus(pay.paymentId, 'TXN_SUCCESS');
  await ctx.app.locals.payments.verify(pay.paymentId, 'status_api');
  return c;
}

test('agent end to end: pairs, reports printers, prints a paid order, order becomes ready; failure -> attention', async (t) => {
  const ctx = await setup(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-agent-'));
  process.env.QP_FAKE_PRINTERS = path.join(dir, 'printers.json');
  process.env.QP_FAKE_SPOOL = path.join(dir, 'spool.json');
  process.env.QP_FAKE_SUMATRA_LOG = path.join(dir, 'sumatra.log');
  fs.writeFileSync(process.env.QP_FAKE_PRINTERS, JSON.stringify([
    { Name: 'HP LaserJet', DriverName: 'HP UPD', PrinterStatus: 3, DetectedErrorState: 2, CapabilityDescriptions: ['Duplex'], PrinterPaperNames: ['A4'] }
  ]));
  fs.writeFileSync(process.env.QP_FAKE_SPOOL, '');

  const owner = await adminLogin(ctx);
  const { code } = (await owner.call('/api/admin/agents/pairing', { method: 'POST' })).json;
  const { secret } = await createApi({ serverUrl: ctx.base }).pair(code, 'Shop PC');
  const config = {
    serverUrl: ctx.base, powershell: FAKE_PS, sumatra: FAKE_SUMATRA, workDir: path.join(dir, 'work'), logFile: path.join(dir, 'agent.log'),
    heartbeatSec: 1, pollSec: 1, printTimeoutSec: 20, spoolerTimeoutSec: 20, ignorePrinters: []
  };
  const agent = createAgent(config, secret);
  t.after(() => agent.stop());
  await agent.start();

  const printers = (await owner.call('/api/admin/printers')).json.printers;
  assert.equal(printers.length, 1);
  assert.equal(printers[0].duplex, true);
  await owner.call(`/api/admin/printers/${printers[0].printerId}`, { method: 'PUT', body: { enabled: true, role: 'bw', ppmBw: 30, ppmColor: 10 } });

  const c = await paidOrder(ctx);
  const status = () => ctx.db.prepare('SELECT status, needs_attention FROM orders WHERE id = ?').get(c.orderId);
  assert.ok(await until(() => status().status === 'ready'), `order should be ready, is ${JSON.stringify(status())}`);
  const call = JSON.parse(fs.readFileSync(process.env.QP_FAKE_SUMATRA_LOG, 'utf8').trim().split('\n')[0]);
  assert.deepEqual(call.args.slice(0, 4), ['-print-to', 'HP LaserJet', '-print-settings', 'simplex,monochrome,1x,paper=A4,fit']);
  assert.ok(call.fileExists && call.bytes > 100, 'printed the downloaded PDF');
  assert.ok(await until(() => fs.readdirSync(config.workDir).length === 0), 'file deleted after printing');
  const customer = await (await c.call(`/api/orders/${c.orderId}`)).json();
  assert.equal(customer.status, 'ready');

  process.env.QP_FAKE_SUMATRA_EXIT = '1';
  const c2 = await paidOrder(ctx);
  const s2 = () => ctx.db.prepare('SELECT status, needs_attention FROM orders WHERE id = ?').get(c2.orderId);
  assert.ok(await until(() => s2().status === 'print_attention'), JSON.stringify(s2()));
  assert.equal(s2().needs_attention, 'print_failed');
  delete process.env.QP_FAKE_SUMATRA_EXIT;
  const log = fs.readFileSync(config.logFile, 'utf8');
  assert.ok(!log.includes(secret), 'secret never logged');
});
