'use strict';
/* Phase 8: retention (customer files deleted when no longer needed), reconciliation, problems list,
   CSV export, refunding a flagged extra payment, admin password change. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { ADMIN_ORIGIN, PASSWORD, raw, adminLogin, setup, paidOrder } = require('./adminKit');
const { newCustomer, addPdf } = require('./fixtures');
const { newId } = require('../src/lib/crypto');
const { totp } = require('../src/lib/totp');

const HOUR = 3600000;
const docsOf = (ctx, orderId) => ctx.db.prepare('SELECT * FROM documents WHERE order_id = ?').all(orderId);
const filesExist = (ctx, d) => fs.existsSync(ctx.app.locals.storage.origPath(d.storage_key)) || fs.existsSync(ctx.app.locals.storage.pdfPath(d.storage_key));

async function handedOver(ctx, staff) {
  const p = await paidOrder(ctx);
  await staff.call(`/api/admin/orders/${p.orderId}/status`, { method: 'POST', body: { to: 'ready' } });
  const r = await staff.call(`/api/admin/orders/${p.orderId}/handover`, { method: 'POST', body: { pin: p.pin } });
  assert.equal(r.status, 200);
  return p;
}

/* ---------- retention ---------- */

test('retention: files deleted 2 h after pickup; names replaced; records kept; active orders never touched', async (t) => {
  let clock = Date.now();
  const ctx = await setup(t, { now: () => clock });
  const staff = await adminLogin(ctx, { username: 'counter', role: 'staff' });
  const done = await handedOver(ctx, staff);
  const waiting = await paidOrder(ctx); // paid, not collected
  const job = ctx.app.locals.retention;

  clock += HOUR;
  assert.equal((await job.runOnce()).purged, 0, 'kept for 2 hours after pickup');
  assert.ok(filesExist(ctx, docsOf(ctx, done.orderId)[0]));

  clock += 1.5 * HOUR;
  assert.equal((await job.runOnce()).purged, 1);
  const d = docsOf(ctx, done.orderId)[0];
  assert.ok(d.purged_at);
  assert.equal(d.original_name, 'deleted.pdf', 'file name removed too');
  assert.equal(filesExist(ctx, d), false, 'files gone from disk');
  assert.equal(ctx.db.prepare('SELECT total_paise FROM orders WHERE id = ?').pluck().get(done.orderId), 600, 'order record kept for the accounts');

  clock += 30 * 24 * HOUR;
  await job.runOnce();
  const w = docsOf(ctx, waiting.orderId)[0];
  assert.equal(w.purged_at, null, 'an order still to be collected keeps its files, however long');
  assert.ok(filesExist(ctx, w));
});

test('retention: abandoned drafts are cancelled after 24 h, then their files go; settings change the timing', async (t) => {
  let clock = Date.now();
  const ctx = await setup(t, { now: () => clock });
  const c = await newCustomer(ctx.base);
  await addPdf(ctx, c, 1);
  const job = ctx.app.locals.retention;

  clock += 23 * HOUR;
  assert.equal((await job.runOnce()).draftsCancelled, 0);
  clock += 2 * HOUR;
  assert.equal((await job.runOnce()).draftsCancelled, 1);
  assert.equal(ctx.db.prepare('SELECT status FROM orders WHERE id = ?').pluck().get(c.orderId), 'cancelled');
  clock += 1.1 * HOUR;
  assert.equal((await job.runOnce()).purged, 1, 'cancelled draft files deleted 1 h later');

  const owner2 = await adminLogin(ctx, { username: 'owner2' }); // a day later: log in again
  const bad = await owner2.call('/api/admin/settings/retention', { method: 'PUT', body: { value: { afterHandoverHours: 0, abandonedDraftHours: 24, unpaidHours: 1 } } });
  assert.equal(bad.status, 400);
  const ok = await owner2.call('/api/admin/settings/retention', { method: 'PUT', body: { value: { afterHandoverHours: 6, abandonedDraftHours: 48, unpaidHours: 2 } } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.retention.afterHandoverHours, 6);
  const staff = await adminLogin(ctx, { username: 'counter', role: 'staff' });
  const p = await handedOver(ctx, staff);
  clock += 3 * HOUR;
  await job.runOnce();
  assert.equal(docsOf(ctx, p.orderId)[0].purged_at, null, 'owner chose 6 hours');
});

test('retention: customer and dashboard see "files deleted"; no preview or download afterwards', async (t) => {
  let clock = Date.now();
  const ctx = await setup(t, { now: () => clock });
  const owner = await adminLogin(ctx);
  const p = await paidOrder(ctx);
  await owner.call(`/api/admin/orders/${p.orderId}/status`, { method: 'POST', body: { to: 'ready' } });
  // the customer starts a new order, so the session stays alive past the 1 h grace
  await p.c.call('/api/orders', { method: 'POST' });
  await owner.call(`/api/admin/orders/${p.orderId}/handover`, { method: 'POST', body: { pin: p.pin } });
  const docId = docsOf(ctx, p.orderId)[0].id;
  clock += 3 * HOUR;
  await ctx.app.locals.retention.runOnce();
  const view = await (await p.c.call(`/api/orders/${p.orderId}`)).json();
  assert.equal(view.documents[0].filesDeleted, true);
  assert.equal(view.documents[0].previewUrl, null);
  assert.equal((await p.c.call(`/api/orders/${p.orderId}/documents/${docId}/preview`)).status, 409);
  const staff = await adminLogin(ctx, { username: 'counter', role: 'staff' });
  const detail = (await staff.call(`/api/admin/orders/${p.orderId}`)).json;
  assert.equal(detail.documents[0].pdfUrl, null);
  assert.equal(detail.documents[0].purged, true);
});

test('retention: raw Paytm payloads blanked after 90 days', async (t) => {
  let clock = Date.now();
  const ctx = await setup(t, { now: () => clock });
  await paidOrder(ctx);
  const count = () => ctx.db.prepare("SELECT COUNT(*) FROM payment_events WHERE payload <> '{}'").pluck().get();
  assert.ok(count() > 0);
  clock += 91 * 24 * HOUR;
  await ctx.app.locals.retention.runOnce();
  assert.equal(count(), 0);
});

/* ---------- money: reconciliation, problems, CSV, flagged payment refunds ---------- */

/** A second successful payment for an already paid order (double payment), as phase 4 flags it. */
function extraPayment(ctx, orderId, amountPaise = 600) {
  const id = newId();
  const at = new Date(ctx.clock ? ctx.clock() : Date.now()).toISOString();
  ctx.db.prepare(`INSERT INTO payments (id, order_id, amount_paise, status, txn_id, payment_mode, created_at, updated_at, paid_at, needs_refund)
    VALUES (?, ?, ?, 'success', ?, 'UPI', ?, ?, ?, 1)`).run(id, orderId, amountPaise, `DUP${id.slice(0, 8)}`, at, at, at);
  ctx.db.prepare("UPDATE orders SET needs_attention = 'payment_needs_refund' WHERE id = ?").run(orderId);
  return id;
}

test('flagged extra payment: owner refunds it alone; the order is untouched; problem disappears when Paytm confirms', async (t) => {
  const ctx = await setup(t);
  const owner = await adminLogin(ctx);
  const staff = await adminLogin(ctx, { username: 'counter', role: 'staff' });
  const p = await paidOrder(ctx);
  const extra = extraPayment(ctx, p.orderId);

  let problems = (await staff.call('/api/admin/reports/problems')).json.problems;
  assert.ok(problems.some((x) => x.kind === 'extra_payment' && x.paymentId === extra));
  const report = (await owner.call('/api/admin/reports/daily')).json;
  assert.equal(report.reconciliation.differencePaise, 600, 'Rs 6 more received than billed');

  const refund = (client, id, body) => client.call(`/api/admin/payments/${id}/refund`, { method: 'POST', body });
  assert.equal((await refund(staff, extra, { reason: 'paid twice', password: PASSWORD })).status, 403);
  assert.equal((await refund(owner, extra, { reason: 'paid twice', password: 'x' })).status, 403);
  const normal = ctx.db.prepare('SELECT id FROM payments WHERE order_id = ? AND needs_refund = 0').pluck().get(p.orderId);
  assert.equal((await refund(owner, normal, { reason: 'try', password: PASSWORD })).status, 409, 'only flagged payments');
  const r = await refund(owner, extra, { reason: 'paid twice', password: PASSWORD });
  assert.equal(r.status, 200, r.text);
  assert.equal((await refund(owner, extra, { reason: 'again', password: PASSWORD })).status, 409, 'no double refund');
  assert.equal(ctx.db.prepare('SELECT status FROM orders WHERE id = ?').pluck().get(p.orderId), 'paid', 'order keeps printing as normal');

  problems = (await staff.call('/api/admin/reports/problems')).json.problems;
  assert.equal(problems.find((x) => x.paymentId === extra).refundStatus, 'pending');
  // Paytm confirms the refund; the reconciler picks it up
  const refundRow = ctx.db.prepare('SELECT * FROM refunds WHERE payment_id = ?').get(extra);
  ctx.mock.refunds.get(refundRow.id).status = 'TXN_SUCCESS';
  await ctx.app.locals.payments.checkRefund(refundRow);
  problems = (await staff.call('/api/admin/reports/problems')).json.problems;
  assert.ok(!problems.some((x) => x.paymentId === extra), 'resolved');
  assert.equal(ctx.db.prepare('SELECT needs_attention FROM orders WHERE id = ?').pluck().get(p.orderId), null);
});

test('problems: paid but not printed after 2 h; ready but not collected after 3 days', async (t) => {
  let clock = Date.now();
  const ctx = await setup(t, { now: () => clock });
  const owner = await adminLogin(ctx);
  const a = await paidOrder(ctx);
  const b = await paidOrder(ctx);
  await owner.call(`/api/admin/orders/${b.orderId}/status`, { method: 'POST', body: { to: 'ready' } });
  clock += 3 * HOUR;
  const second = await adminLogin(ctx, { username: 'owner2' });
  let list = (await second.call('/api/admin/reports/problems')).json.problems;
  assert.deepEqual(list.map((x) => [x.kind, x.orderId]), [['not_printed', a.orderId]]);
  clock += 3 * 24 * HOUR;
  const third = await adminLogin(ctx, { username: 'owner3' });
  list = (await third.call('/api/admin/reports/problems')).json.problems;
  assert.ok(list.some((x) => x.kind === 'not_collected' && x.orderId === b.orderId));
});

test('CSV export: owner only, one line per paid order, spreadsheet formulas neutralised, audited', async (t) => {
  const ctx = await setup(t);
  const owner = await adminLogin(ctx);
  const staff = await adminLogin(ctx, { username: 'counter', role: 'staff' });
  const p = await paidOrder(ctx);
  ctx.db.prepare("UPDATE payments SET payment_mode = '=HYPERLINK(\"http://evil\")' WHERE order_id = ?").run(p.orderId);
  assert.equal((await staff.call('/api/admin/reports/daily.csv')).status, 403);
  const r = await owner.call('/api/admin/reports/daily.csv');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-disposition'], /attachment; filename="quick-print-\d{4}-\d{2}-\d{2}\.csv"/);
  const lines = r.text.trim().split('\r\n');
  assert.equal(lines[0].split(',')[1], 'token');
  assert.equal(lines.length, 2);
  assert.ok(lines[1].includes(p.token) && lines[1].includes('6.00'));
  assert.ok(lines[1].includes(`"'=HYPERLINK(""http://evil"")"`), lines[1]);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) FROM audit_logs WHERE action = 'report_exported'").pluck().get(), 1);
});

test('reconciliation: received = billed; printed / collected / refunded counts', async (t) => {
  const ctx = await setup(t);
  const owner = await adminLogin(ctx);
  const a = await paidOrder(ctx);
  const b = await paidOrder(ctx);
  await owner.call(`/api/admin/orders/${a.orderId}/status`, { method: 'POST', body: { to: 'ready' } });
  await owner.call(`/api/admin/orders/${a.orderId}/handover`, { method: 'POST', body: { pin: a.pin } });
  await owner.call(`/api/admin/orders/${b.orderId}/refund`, { method: 'POST', body: { reason: 'printer broken', password: PASSWORD } });
  const r = (await owner.call('/api/admin/reports/daily')).json.reconciliation;
  assert.equal(r.differencePaise, 0);
  assert.equal(r.paidOrders, 2);
  assert.equal(r.printedOrders, 1);
  assert.equal(r.collectedOrders, 1);
  assert.equal(r.refundedOrders, 1);
});

/* ---------- admin password ---------- */

test('password change: needs the current password, enforces rules, logs out other devices', async (t) => {
  const ctx = await setup(t);
  const a = await adminLogin(ctx);
  const other = await adminLogin(ctx, { create: false });
  const change = (body) => a.call('/api/admin/password', { method: 'POST', body });
  assert.equal((await change({ current: 'wrong', next: 'a brand new pass 99' })).status, 403);
  const weak = await change({ current: PASSWORD, next: 'short' });
  assert.equal(weak.status, 400);
  assert.match(weak.json.error.message, /12 characters/);
  assert.equal((await change({ current: PASSWORD, next: 'a brand new pass 99' })).status, 200);
  assert.equal((await a.call('/api/admin/session')).status, 200, 'this device stays logged in');
  assert.equal((await other.call('/api/admin/session')).status, 401, 'other devices logged out');
  const login = await raw(ctx.base, '/api/admin/login', {
    method: 'POST', headers: { origin: ADMIN_ORIGIN },
    body: { username: 'owner', password: 'a brand new pass 99', otp: totp(ctx.secrets.owner, Date.now() + 30000) }
  });
  assert.equal(login.status, 200, login.text);
});
