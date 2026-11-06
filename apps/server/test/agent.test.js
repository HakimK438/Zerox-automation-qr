'use strict';
/* Phase 7: print agent pairing, auth, printer discovery, automatic/manual dispatch, leases, single-use
   downloads, results, the "never reprint by itself" rule, and ETA from real printers. */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { ADMIN_ORIGIN, PASSWORD, raw, adminLogin, setup } = require('./adminKit');
const { newCustomer, addPdf } = require('./fixtures');
const { printerState } = require('../src/modules/agent/service');

const PRINTERS = [
  { name: 'HP LaserJet M404', driver: 'HP Universal', status: 'Normal', color: false, duplex: true, paperSizes: ['A4'] },
  { name: 'Epson L3250', driver: 'EPSON', status: 'Normal', color: true, duplex: false, paperSizes: ['A4'] }
];

/** Agent HTTP client on the customer host (where /api/agent lives). */
function agentApi(ctx, secret) {
  return async (path, { method = 'GET', body, headers = {} } = {}) => {
    const r = await fetch(`${ctx.base}/api/agent${path}`, {
      method,
      headers: { ...(secret ? { authorization: `Bearer ${secret}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined
    });
    const buf = Buffer.from(await r.arrayBuffer());
    let json = null;
    try { json = JSON.parse(buf.toString()); } catch { /* binary */ }
    return { status: r.status, json, buf, headers: r.headers };
  };
}

/** Owner + paired agent reporting PRINTERS; `enable` lists printer names to switch on. */
async function withAgent(ctx, { enable = PRINTERS.map((p) => p.name), roles = {} } = {}) {
  const owner = await adminLogin(ctx);
  const pairing = (await owner.call('/api/admin/agents/pairing', { method: 'POST' })).json;
  const paired = await agentApi(ctx)('/pair', { method: 'POST', body: { code: pairing.code, name: 'Shop PC' } });
  assert.equal(paired.status, 201, JSON.stringify(paired.json));
  const agent = agentApi(ctx, paired.json.secret);
  assert.equal((await agent('/heartbeat', { method: 'POST', body: { printers: PRINTERS, version: '0.1.0' } })).status, 200);
  const overview = (await owner.call('/api/admin/printers')).json;
  for (const p of overview.printers) {
    if (!enable.includes(p.osName)) continue;
    const role = roles[p.osName] || (p.color ? 'color' : 'bw');
    const r = await owner.call(`/api/admin/printers/${p.printerId}`, { method: 'PUT', body: { enabled: true, role, ppmBw: 30, ppmColor: 12 } });
    assert.equal(r.status, 200, r.text);
  }
  return { owner, agent, secret: paired.json.secret, agentId: paired.json.agentId, pairing };
}

/** Paid order through the mock Paytm. `color`/`duplex` set the print settings before checkout. */
async function paid(ctx, { pages = 2, color = false, duplex = false } = {}) {
  const c = await newCustomer(ctx.base);
  const doc = await addPdf(ctx, c, pages);
  if (color || duplex) {
    const r = await c.call(`/api/orders/${c.orderId}/documents/${doc.documentId}/parts`, {
      method: 'PUT', body: { copies: 1, parts: [{ pages: 'all', color, duplex, paper: 'A4' }] }
    });
    assert.equal(r.status, 200);
  }
  await c.call(`/api/orders/${c.orderId}/checkout`, { method: 'POST' });
  const pay = await (await c.call(`/api/orders/${c.orderId}/payments`, { method: 'POST' })).json();
  ctx.mock.setStatus(pay.paymentId, 'TXN_SUCCESS');
  assert.equal((await ctx.app.locals.payments.verify(pay.paymentId, 'status_api')).outcome, 'paid');
  await new Promise((r) => setImmediate(r));
  const order = await (await c.call(`/api/orders/${c.orderId}`)).json();
  return { c, orderId: c.orderId, pin: order.pickupPin, token: order.token };
}

const orderStatus = (ctx, id) => ctx.db.prepare('SELECT status, needs_attention FROM orders WHERE id = ?').get(id);
const jobs = (ctx, id) => ctx.db.prepare('SELECT * FROM print_jobs WHERE order_id = ? ORDER BY batch, position').all(id);

test('printer status words map to ready / error / offline', () => {
  assert.equal(printerState('Normal'), 'ready');
  assert.equal(printerState('Printing'), 'ready');
  assert.equal(printerState('PaperOut'), 'error');
  assert.equal(printerState('Offline'), 'offline');
  assert.equal(printerState(''), 'offline');
});

test('pairing: owner only, code works once, expires after 10 minutes', async (t) => {
  let clock = Date.now();
  const ctx = await setup(t, { now: () => clock });
  const owner = await adminLogin(ctx);
  const staff = await adminLogin(ctx, { username: 'counter', role: 'staff' });
  assert.equal((await staff.call('/api/admin/agents/pairing', { method: 'POST' })).status, 403);
  const p = (await owner.call('/api/admin/agents/pairing', { method: 'POST' })).json;
  assert.match(p.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const pair = (code) => agentApi(ctx)('/pair', { method: 'POST', body: { code, name: 'Shop PC' } });
  assert.equal((await pair('AAAA-BBBB')).status, 400);
  const ok = await pair(p.code.toLowerCase().replace('-', ' ')); // forgiving about case and spaces
  assert.equal(ok.status, 201);
  assert.ok(ok.json.secret.length >= 40);
  assert.equal((await pair(p.code)).status, 400, 'single use');

  const p2 = (await owner.call('/api/admin/agents/pairing', { method: 'POST' })).json;
  clock += 11 * 60000;
  assert.equal((await pair(p2.code)).status, 400, 'expired');
  const stored = ctx.db.prepare('SELECT secret_hash FROM agents WHERE id = ?').pluck().get(ok.json.agentId);
  assert.notEqual(stored, ok.json.secret, 'only the hash is stored');
});

test('agent API: secret required, revocation cuts it off, and it does not exist on the admin host', async (t) => {
  const ctx = await setup(t);
  const { owner, agent, agentId, secret } = await withAgent(ctx);
  assert.equal((await agentApi(ctx)('/jobs/next', { method: 'POST' })).status, 401);
  assert.equal((await agentApi(ctx, 'x'.repeat(43))('/jobs/next', { method: 'POST' })).status, 401);
  assert.equal((await agent('/jobs/next', { method: 'POST' })).status, 200);
  const viaAdminHost = await raw(ctx.base, '/api/agent/jobs/next', { method: 'POST', headers: { authorization: `Bearer ${secret}`, origin: ADMIN_ORIGIN } });
  assert.equal(viaAdminHost.status, 404);
  assert.equal((await owner.call(`/api/admin/agents/${agentId}/revoke`, { method: 'POST', body: { password: 'nope' } })).status, 403);
  assert.equal((await owner.call(`/api/admin/agents/${agentId}/revoke`, { method: 'POST', body: { password: PASSWORD } })).status, 200);
  assert.equal((await agent('/jobs/next', { method: 'POST' })).status, 401, 'revoked');
  const overview = (await owner.call('/api/admin/printers')).json;
  assert.equal(overview.agents.length, 0);
});

test('heartbeat: printers appear disabled; missing printers go offline; admin enables them', async (t) => {
  const ctx = await setup(t);
  const { owner, agent } = await withAgent(ctx, { enable: [] });
  let o = (await owner.call('/api/admin/printers')).json;
  assert.equal(o.agents[0].online, true);
  assert.deepEqual(o.printers.map((p) => [p.osName, p.enabled, p.status, p.color]), [
    ['HP LaserJet M404', false, 'ready', false], ['Epson L3250', false, 'ready', true]
  ]);
  await agent('/heartbeat', { method: 'POST', body: { printers: [PRINTERS[0]] } });
  o = (await owner.call('/api/admin/printers')).json;
  assert.equal(o.printers.find((p) => p.osName === 'Epson L3250').status, 'offline');
  const staff = await adminLogin(ctx, { username: 'counter', role: 'staff' });
  assert.equal((await staff.call(`/api/admin/printers/${o.printers[0].printerId}`, { method: 'PUT', body: { enabled: true, role: 'bw', ppmBw: 30, ppmColor: 10 } })).status, 403);
});

test('automatic: payment -> job -> lease -> single-use download -> printed -> ready', async (t) => {
  const ctx = await setup(t);
  const { agent } = await withAgent(ctx);
  const p = await paid(ctx, { pages: 3 });
  assert.equal(jobs(ctx, p.orderId).length, 1, 'job created on payment');

  const next = (await agent('/jobs/next', { method: 'POST' })).json.job;
  assert.equal(next.orderId, p.orderId);
  assert.equal(next.printer, 'HP LaserJet M404', 'B&W goes to the B&W printer');
  assert.deepEqual(next.settings, { pages: 'all', color: false, duplex: false, copies: 1, paper: 'A4', sides: 3 });
  assert.equal(orderStatus(ctx, p.orderId).status, 'printing');
  assert.equal((await agent('/jobs/next', { method: 'POST' })).json.job, null, 'one job at a time');

  assert.equal((await agent(`/jobs/${next.jobId}/pdf`, { headers: { 'x-download-token': 'wrong' } })).status, 410);
  const pdf = await agent(`/jobs/${next.jobId}/pdf`, { headers: { 'x-download-token': next.downloadToken } });
  assert.equal(pdf.status, 200);
  assert.equal(crypto.createHash('sha256').update(pdf.buf).digest('hex'), next.sha256, 'agent can verify the file');
  assert.equal((await agent(`/jobs/${next.jobId}/pdf`, { headers: { 'x-download-token': next.downloadToken } })).status, 410, 'single use');

  assert.equal((await agent(`/jobs/${next.jobId}/result`, { method: 'POST', body: { status: 'spooled', spoolerJobId: 17 } })).status, 200);
  assert.equal((await agent(`/jobs/${next.jobId}/result`, { method: 'POST', body: { status: 'printed' } })).status, 200);
  assert.equal(orderStatus(ctx, p.orderId).status, 'ready');
  const customer = await (await p.c.call(`/api/orders/${p.orderId}`)).json();
  assert.equal(customer.status, 'ready', 'customer sees Ready for pickup');
  assert.equal((await agent(`/jobs/${next.jobId}/result`, { method: 'POST', body: { status: 'printed' } })).status, 409, 'no double report');
});

test('colour part goes to the colour printer; no matching printer -> Needs attention', async (t) => {
  const ctx = await setup(t);
  const { agent } = await withAgent(ctx);
  const col = await paid(ctx, { color: true });
  const job = (await agent('/jobs/next', { method: 'POST' })).json.job;
  assert.equal(job.printer, 'Epson L3250');
  assert.equal(job.orderId, col.orderId);
  const dup = await paid(ctx, { color: true, duplex: true }); // colour printer cannot do both sides
  assert.deepEqual(orderStatus(ctx, dup.orderId), { status: 'print_attention', needs_attention: 'no_printer' });
});

test('paused or manual: no automatic jobs; unpausing and "Start printing" create them', async (t) => {
  const ctx = await setup(t);
  const { owner, agent } = await withAgent(ctx);
  await owner.call('/api/admin/settings/paused', { method: 'PUT', body: { value: true } });
  const a = await paid(ctx);
  assert.equal(jobs(ctx, a.orderId).length, 0, 'paused: nothing sent');
  await owner.call('/api/admin/settings/print_mode', { method: 'PUT', body: { value: 'manual' } });
  await owner.call('/api/admin/settings/paused', { method: 'PUT', body: { value: false } });
  assert.equal(jobs(ctx, a.orderId).length, 0, 'manual: waits for the shop');
  await owner.call(`/api/admin/orders/${a.orderId}/status`, { method: 'POST', body: { to: 'printing' } });
  assert.equal(jobs(ctx, a.orderId).length, 1, 'Start printing hands it to the agent');
  assert.equal((await agent('/jobs/next', { method: 'POST' })).json.job.orderId, a.orderId);

  const b = await paid(ctx);
  await owner.call('/api/admin/settings/print_mode', { method: 'PUT', body: { value: 'automatic' } });
  assert.equal(jobs(ctx, b.orderId).length, 1, 'switching to automatic sends waiting orders');
  await owner.call('/api/admin/settings/paused', { method: 'PUT', body: { value: true } });
  assert.equal((await agent('/jobs/next', { method: 'POST' })).json.job, null, 'paused: no new leases');
});

test('failure -> Needs attention; reprint is a human decision with a new batch', async (t) => {
  const ctx = await setup(t);
  const { owner, agent } = await withAgent(ctx);
  const p = await paid(ctx);
  const job = (await agent('/jobs/next', { method: 'POST' })).json.job;
  await agent(`/jobs/${job.jobId}/pdf`, { headers: { 'x-download-token': job.downloadToken } });
  await agent(`/jobs/${job.jobId}/result`, { method: 'POST', body: { status: 'failed', error: 'Paper jam' } });
  assert.deepEqual(orderStatus(ctx, p.orderId), { status: 'print_attention', needs_attention: 'print_failed' });
  assert.equal((await agent('/jobs/next', { method: 'POST' })).json.job, null, 'nothing re-sent by itself');

  const r = await owner.call(`/api/admin/orders/${p.orderId}/status`, { method: 'POST', body: { to: 'printing' } });
  assert.equal(r.status, 200);
  const all = jobs(ctx, p.orderId);
  assert.deepEqual(all.map((j) => [j.batch, j.status, j.is_reprint]), [[1, 'failed', 0], [2, 'queued', 1]]);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) FROM audit_logs WHERE action = 'reprint'").pluck().get(), 1);
  const detail = (await owner.call(`/api/admin/orders/${p.orderId}`)).json;
  assert.equal(detail.printJobs.length, 2);
  assert.equal(detail.printJobs[0].error, 'Paper jam');
});

test('lease expiry: untouched job goes back to the queue; downloaded job becomes uncertain (never reprinted)', async (t) => {
  let clock = Date.now();
  const ctx = await setup(t, { now: () => clock });
  const { agent } = await withAgent(ctx);
  const a = await paid(ctx);
  const j1 = (await agent('/jobs/next', { method: 'POST' })).json.job;
  clock += 3 * 60000;
  assert.deepEqual(ctx.app.locals.dispatcher.watchdog(), { requeued: 1, uncertain: 0 });
  await agent('/heartbeat', { method: 'POST', body: { printers: PRINTERS } }); // agent still alive
  const j2 = (await agent('/jobs/next', { method: 'POST' })).json.job;
  assert.equal(j2.jobId, j1.jobId, 'same job leased again (it never left the server)');
  assert.equal(ctx.db.prepare('SELECT attempt FROM print_jobs WHERE id = ?').pluck().get(j1.jobId), 2);

  await agent(`/jobs/${j2.jobId}/pdf`, { headers: { 'x-download-token': j2.downloadToken } });
  clock += 3 * 60000;
  assert.deepEqual(ctx.app.locals.dispatcher.watchdog(), { requeued: 0, uncertain: 1 });
  assert.deepEqual(orderStatus(ctx, a.orderId), { status: 'print_attention', needs_attention: 'uncertain' });
  await agent('/heartbeat', { method: 'POST', body: { printers: PRINTERS } });
  assert.equal((await agent('/jobs/next', { method: 'POST' })).json.job, null);
  assert.equal((await agent(`/jobs/${j2.jobId}/result`, { method: 'POST', body: { status: 'printed' } })).status, 409, 'late report ignored');
});

test('heartbeat keeps a long print alive', async (t) => {
  let clock = Date.now();
  const ctx = await setup(t, { now: () => clock });
  const { agent } = await withAgent(ctx);
  await paid(ctx);
  const j = (await agent('/jobs/next', { method: 'POST' })).json.job;
  await agent(`/jobs/${j.jobId}/pdf`, { headers: { 'x-download-token': j.downloadToken } });
  for (let i = 0; i < 6; i += 1) {
    clock += 60000;
    await agent('/heartbeat', { method: 'POST', body: { printers: PRINTERS, activeJobs: [j.jobId] } });
    assert.deepEqual(ctx.app.locals.dispatcher.watchdog(), { requeued: 0, uncertain: 0 });
  }
});

test('ETA uses the real enabled printers instead of the virtual one', async (t) => {
  const ctx = await setup(t);
  await withAgent(ctx, { enable: [] });
  const before = await (await fetch(`${ctx.base}/api/queue/estimate?bw=60`)).json();
  const ctx2 = await setup(t);
  await withAgent(ctx2); // 2 printers at 30 ppm B&W (default virtual: 1 printer at 20 ppm)
  ctx2.app.locals.printQueue.invalidate();
  const after = await (await fetch(`${ctx2.base}/api/queue/estimate?bw=60`)).json();
  assert.ok(after.etaMinutes < before.etaMinutes, `${after.etaMinutes} < ${before.etaMinutes}`);
});

test('without a print agent nothing changes: the shop prints by hand', async (t) => {
  const ctx = await setup(t);
  const owner = await adminLogin(ctx);
  const p = await paid(ctx);
  assert.equal(jobs(ctx, p.orderId).length, 0);
  await owner.call(`/api/admin/orders/${p.orderId}/status`, { method: 'POST', body: { to: 'printing' } });
  assert.equal(jobs(ctx, p.orderId).length, 0);
  assert.equal(orderStatus(ctx, p.orderId).status, 'printing');
});
