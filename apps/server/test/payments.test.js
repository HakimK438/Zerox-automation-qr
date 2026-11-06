'use strict';
/* Phase 4: Paytm payments against a local mock gateway. Every revenue rule has a test here. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers');
const { startPaytmMock } = require('./paytmMock');
const { api, newCustomer, addPdf } = require('./fixtures');
const { generateSignature, verifySignature, stringForParams } = require('../src/modules/payments/paytm/checksum');
const { amountToPaise, paiseToAmount, appLinks } = require('../src/modules/payments/paytm/client');
const { createSecretBox } = require('../src/lib/secretBox');

/* ---------- harness ---------- */

async function setup(t, { clock, env = {} } = {}) {
  const mock = await startPaytmMock();
  const ctx = await startTestApp(
    { PAYTM_MID: mock.mid, PAYTM_MERCHANT_KEY: mock.key, PAYTM_HOST: mock.host, ...env },
    clock ? { now: () => clock.t } : {}
  );
  t.after(async () => { await ctx.close(); await mock.close(); });
  return { ctx, mock, payments: ctx.app.locals.payments };
}

/** Browser with a 2-page B&W order checked out (Rs 6.00). */
async function checkedOut(ctx, pages = 2) {
  const c = await newCustomer(ctx.base);
  await addPdf(ctx, c, pages);
  const r = await c.call(`/api/orders/${c.orderId}/checkout`, { method: 'POST' });
  assert.equal(r.status, 200);
  return c;
}

const startPay = async (c) => {
  const r = await c.call(`/api/orders/${c.orderId}/payments`, { method: 'POST' });
  return { status: r.status, body: await r.json() };
};
const orderOf = async (c) => (await c.call(`/api/orders/${c.orderId}`)).json();
const dbOrder = (ctx, id) => ctx.db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
const postForm = (ctx, path, params) => fetch(`${ctx.base}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://securegw-stage.paytm.in' },
  body: new URLSearchParams(params),
  redirect: 'manual'
});
const callback = (ctx, params) => postForm(ctx, '/api/payments/paytm/callback', params);
const webhook = (ctx, params) => postForm(ctx, '/api/payments/paytm/webhook', params);

/** Starts a payment and makes Paytm report success; returns the payment id. */
async function paySuccessfully(ctx, mock, c) {
  const { body } = await startPay(c);
  mock.setStatus(body.paymentId, 'TXN_SUCCESS');
  const r = await callback(ctx, mock.callbackParams(body.paymentId));
  assert.equal(r.status, 303);
  return body.paymentId;
}

/* ---------- unit: checksum, amounts, links, PIN box ---------- */

test('checksum: Paytm algorithm round-trips and rejects tampering', () => {
  const key = 'abcdefghijklmnop';
  const body = JSON.stringify({ mid: 'M1', orderId: 'o1' });
  const sig = generateSignature(body, key);
  assert.equal(verifySignature(body, key, sig), true);
  assert.equal(verifySignature(body.replace('o1', 'o2'), key, sig), false, 'changed body');
  assert.equal(verifySignature(body, 'ponmlkjihgfedcba', sig), false, 'other key');
  assert.equal(verifySignature(body, key, 'garbage=='), false);
  assert.equal(verifySignature(body, key, ''), false);
  assert.equal(verifySignature(body, key, undefined), false);
  assert.notEqual(generateSignature(body, key), sig, 'salted: two signatures differ');

  const params = { TXNAMOUNT: '6.00', ORDERID: 'o1', STATUS: 'TXN_SUCCESS', BANKNAME: 'null' };
  // keys sorted (BANKNAME, ORDERID, STATUS, TXNAMOUNT); "null" -> empty; CHECKSUMHASH excluded
  assert.equal(stringForParams({ ...params, CHECKSUMHASH: 'x' }), '|o1|TXN_SUCCESS|6.00');
  const p = { ...params, CHECKSUMHASH: generateSignature(params, key) };
  assert.equal(verifySignature(p, key, p.CHECKSUMHASH), true);
  assert.equal(verifySignature({ ...p, TXNAMOUNT: '600.00' }, key, p.CHECKSUMHASH), false, 'amount tampered');
});

test('amounts convert without floating point; iOS app links derive from the UPI link', () => {
  assert.equal(paiseToAmount(600), '6.00');
  assert.equal(paiseToAmount(1205), '12.05');
  assert.equal(paiseToAmount(99), '0.99');
  assert.equal(amountToPaise('6.00'), 600);
  assert.equal(amountToPaise('12.5'), 1250);
  assert.equal(amountToPaise('0.1'), 10);
  assert.equal(amountToPaise('7'), 700);
  for (const bad of ['6.001', '-1', '1e3', '', null, 'abc']) assert.equal(amountToPaise(bad), null, String(bad));

  const links = appLinks('upi://pay?pa=shop@paytm&am=6.00&tr=x');
  assert.deepEqual(links.map((l) => l.app), ['gpay', 'phonepe', 'paytm', 'bhim']);
  assert.equal(links[0].url, 'gpay://upi/pay?pa=shop@paytm&am=6.00&tr=x');
  assert.equal(links[1].url, 'phonepe://pay?pa=shop@paytm&am=6.00&tr=x');
  assert.deepEqual(appLinks('javascript:alert(1)'), [], 'only real UPI links');
  assert.deepEqual(appLinks(null), []);
});

test('secretBox: PIN encryption is authenticated', () => {
  const box = createSecretBox(Buffer.alloc(32, 9));
  const sealed = box.seal('4821');
  assert.equal(box.open(sealed), '4821');
  assert.notEqual(box.seal('4821'), sealed, 'random IV');
  assert.equal(createSecretBox(Buffer.alloc(32, 8)).open(sealed), null, 'wrong key');
  const raw = Buffer.from(sealed.slice(3), 'base64url'); raw[raw.length - 1] ^= 1;
  assert.equal(box.open(`v1:${raw.toString('base64url')}`), null, 'tampered');
  assert.equal(box.open('nope'), null);
});

/* ---------- start / resume ---------- */

test('payments answer 503 when Paytm is not configured', async (t) => {
  const ctx = await startTestApp();
  t.after(ctx.close);
  const c = await checkedOut(ctx);
  const r = await startPay(c);
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, 'payments_unavailable');
});

test('start payment: signed request with the frozen amount; UPI intent + iOS links; resumable', async (t) => {
  const { ctx, mock } = await setup(t);
  const c = await checkedOut(ctx, 2);
  const { status, body } = await startPay(c);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.status, 'pending');
  assert.equal(body.amount, '6.00');
  assert.equal(body.amountPaise, 600);
  assert.equal(body.mid, mock.mid);
  assert.equal(body.txnToken, `tok-${body.paymentId}`);
  assert.match(body.deepLink, /^upi:\/\/pay\?/);
  assert.equal(body.appLinks.length, 4);
  assert.equal(body.checkoutJsUrl, `${mock.host}/merchantpgpui/checkoutjs/merchants/${mock.mid}.js`);

  const init = mock.requests.find((r) => r.path === '/theia/api/v1/initiateTransaction');
  assert.equal(init.signedOk, true, 'request signed with the merchant key');
  assert.equal(init.payload.body.txnAmount.value, '6.00', 'amount from the frozen order, not the browser');
  assert.equal(init.payload.body.callbackUrl, 'http://localhost:3000/api/payments/paytm/callback');
  assert.doesNotMatch(JSON.stringify(init.payload), /mockMerchantKey1/, 'key never sent');

  const again = await startPay(c);
  assert.equal(again.body.paymentId, body.paymentId, 'retry resumes the same attempt');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) FROM payments').pluck().get(), 1);
});

test('start payment refuses drafts and works without UPI intent (JS Checkout only)', async (t) => {
  const { ctx, mock } = await setup(t);
  const draft = await newCustomer(ctx.base);
  await addPdf(ctx, draft, 1);
  assert.equal((await startPay(draft)).status, 409);

  mock.flags.upiIntent = false;
  const c = await checkedOut(ctx);
  const { status, body } = await startPay(c);
  assert.equal(status, 200);
  assert.equal(body.deepLink, null);
  assert.deepEqual(body.appLinks, []);
  assert.ok(body.txnToken, 'JS Checkout still possible');
});

test('gateway failure to start is reported, and a new attempt is made next time', async (t) => {
  const { ctx, mock } = await setup(t);
  const c = await checkedOut(ctx);
  mock.flags.failInitiate = true;
  const r = await startPay(c);
  assert.equal(r.status, 502);
  mock.flags.failInitiate = false;
  const ok = await startPay(c);
  assert.equal(ok.status, 200);
  assert.deepEqual(ctx.db.prepare('SELECT status FROM payments ORDER BY created_at').pluck().all(), ['failed', 'pending']);
});

/* ---------- the only way to "paid" ---------- */

test('happy path: verified payment -> paid, token XR-101, pickup PIN that recovers the order', async (t) => {
  const { ctx, mock } = await setup(t);
  const c = await checkedOut(ctx);
  const { body } = await startPay(c);
  mock.setStatus(body.paymentId, 'TXN_SUCCESS');

  const r = await callback(ctx, mock.callbackParams(body.paymentId));
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), `http://localhost:3000/#order=${c.orderId}`);

  const order = await orderOf(c);
  assert.equal(order.status, 'paid');
  assert.equal(order.token, 'XR-101');
  assert.match(order.pickupPin, /^\d{4}$/);
  const row = dbOrder(ctx, c.orderId);
  assert.ok(row.paid_at);
  assert.doesNotMatch(row.pickup_pin_enc, new RegExp(order.pickupPin), 'PIN encrypted at rest');
  assert.equal(row.print_mode_snapshot, 'automatic');

  const status = await (await c.call(`/api/orders/${c.orderId}/payment-status`)).json();
  assert.equal(status.paid, true);
  assert.equal(status.payment.status, 'success');
  assert.equal(status.payment.txnToken, undefined, 'no gateway details after completion');

  const pay = ctx.db.prepare('SELECT status, txn_id, payment_mode FROM payments').get();
  assert.deepEqual(pay, { status: 'success', txn_id: 'MOCKTXN1', payment_mode: 'UPI' });
  assert.deepEqual(ctx.db.prepare("SELECT action FROM audit_logs WHERE order_id = ?").pluck().all(c.orderId), ['payment_verified']);
  const ev = ctx.db.prepare("SELECT from_status, actor, reason FROM order_events WHERE order_id = ? AND to_status = 'paid'").get(c.orderId);
  assert.deepEqual(ev, { from_status: 'awaiting_payment', actor: 'system', reason: 'payment_verified' });

  // The PIN recovers the order in another browser.
  const rec = await api(ctx.base)('/api/orders/recover', { method: 'POST', body: { token: 'XR-101', pin: order.pickupPin } });
  assert.equal(rec.status, 200);
});

test('a callback alone never pays: bad checksum, or Status API still pending', async (t) => {
  const { ctx, mock } = await setup(t);
  const c = await checkedOut(ctx);
  const { body } = await startPay(c);

  // Forged: signed with the wrong key.
  const forged = mock.callbackParams(body.paymentId, {}, 'wrongwrongwrong1');
  assert.equal((await callback(ctx, forged)).status, 303);
  assert.equal(dbOrder(ctx, c.orderId).status, 'awaiting_payment');
  assert.equal(ctx.db.prepare("SELECT checksum_ok FROM payment_events WHERE source = 'callback'").pluck().get(), 0);
  assert.equal(mock.requests.filter((r) => r.path === '/v3/order/status').length, 0, 'forged hint does not even trigger a check');

  // Correctly signed "success" callback, but Paytm's Status API says PENDING.
  await callback(ctx, mock.callbackParams(body.paymentId, { STATUS: 'TXN_SUCCESS' }));
  assert.equal(dbOrder(ctx, c.orderId).status, 'awaiting_payment');
  assert.equal(ctx.db.prepare('SELECT status FROM payments').pluck().get(), 'pending');
});

test('Status API answers that do not match the order are refused', async (t) => {
  const { ctx, mock } = await setup(t);
  for (const [overrides, problem] of [
    [{ txnAmount: '1.00' }, 'amount'],
    [{ mid: 'SOMEONEELSE' }, 'mid'],
    [{ txnId: '' }, 'txnId']
  ]) {
    const c = await checkedOut(ctx);
    const { body } = await startPay(c);
    mock.setStatus(body.paymentId, 'TXN_SUCCESS', overrides);
    await callback(ctx, mock.callbackParams(body.paymentId));
    assert.equal(dbOrder(ctx, c.orderId).status, 'awaiting_payment', problem);
    const audit = ctx.db.prepare("SELECT details FROM audit_logs WHERE order_id = ? AND action = 'payment_verification_mismatch'").pluck().get(c.orderId);
    assert.ok(JSON.parse(audit).problems.includes(problem), problem);
  }
});

test('a Paytm transaction id cannot pay for two orders', async (t) => {
  const { ctx, mock } = await setup(t);
  const a = await checkedOut(ctx);
  const payA = await paySuccessfully(ctx, mock, a);
  const b = await checkedOut(ctx);
  const { body } = await startPay(b);
  mock.setStatus(body.paymentId, 'TXN_SUCCESS', { txnId: mock.orders.get(payA).txnId });
  await webhook(ctx, mock.callbackParams(body.paymentId));
  assert.equal(dbOrder(ctx, a.orderId).status, 'paid');
  assert.equal(dbOrder(ctx, b.orderId).status, 'awaiting_payment');
});

test('callback + webhook at the same time: paid exactly once, one token', async (t) => {
  const { ctx, mock } = await setup(t);
  const c = await checkedOut(ctx);
  const { body } = await startPay(c);
  mock.setStatus(body.paymentId, 'TXN_SUCCESS');
  const params = mock.callbackParams(body.paymentId);
  const results = await Promise.all([callback(ctx, params), webhook(ctx, params), webhook(ctx, params), callback(ctx, params)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 200, 303, 303]);
  assert.equal(dbOrder(ctx, c.orderId).token_no, 101);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) FROM order_events WHERE to_status = 'paid'").pluck().get(), 1);
  assert.equal(ctx.db.prepare('SELECT last_token FROM daily_counters').pluck().get(), 101);

  const next = await checkedOut(ctx);
  await paySuccessfully(ctx, mock, next);
  assert.equal((await orderOf(next)).token, 'XR-102');
});

test('webhook with a bad checksum is rejected', async (t) => {
  const { ctx, mock } = await setup(t);
  const c = await checkedOut(ctx);
  const { body } = await startPay(c);
  mock.setStatus(body.paymentId, 'TXN_SUCCESS');
  const params = { ...mock.callbackParams(body.paymentId), CHECKSUMHASH: 'AAAA' };
  const r = await webhook(ctx, params);
  assert.equal(r.status, 400);
  assert.equal(dbOrder(ctx, c.orderId).status, 'awaiting_payment');
});

/* ---------- reconciler, expiry, late payments ---------- */

test('reconciler pays an order whose callback never arrived', async (t) => {
  const clock = { t: Date.now() };
  const { ctx, mock, payments } = await setup(t, { clock });
  const c = await checkedOut(ctx);
  const { body } = await startPay(c);
  mock.setStatus(body.paymentId, 'TXN_SUCCESS'); // customer paid, then closed the browser

  assert.equal((await payments.reconcile()).checked, 0, 'too early: give the callback a chance');
  clock.t += 30000;
  const summary = await payments.reconcile();
  assert.equal(summary.paid, 1);
  assert.equal(dbOrder(ctx, c.orderId).status, 'paid');
});

test('the customer polling status triggers a check with Paytm', async (t) => {
  const clock = { t: Date.now() };
  const { ctx, mock } = await setup(t, { clock });
  const c = await checkedOut(ctx);
  const { body } = await startPay(c);
  mock.setStatus(body.paymentId, 'TXN_SUCCESS');
  clock.t += 6000;
  const s = await (await c.call(`/api/orders/${c.orderId}/payment-status`)).json();
  assert.equal(s.paid, true);
  assert.equal(s.orderStatus, 'paid');
});

test('failed payment: customer can try again with a new attempt', async (t) => {
  const clock = { t: Date.now() };
  const { ctx, mock, payments } = await setup(t, { clock });
  const c = await checkedOut(ctx);
  const first = (await startPay(c)).body;
  mock.setStatus(first.paymentId, 'TXN_FAILURE');
  clock.t += 30000;
  await payments.reconcile();
  assert.equal(ctx.db.prepare('SELECT status FROM payments WHERE id = ?').pluck().get(first.paymentId), 'failed');
  const second = (await startPay(c)).body;
  assert.notEqual(second.paymentId, first.paymentId);
  assert.equal(dbOrder(ctx, c.orderId).status, 'awaiting_payment');
});

test('unpaid orders expire; a late verified payment is still honoured and flagged', async (t) => {
  const clock = { t: Date.now() };
  const { ctx, mock, payments } = await setup(t, { clock });
  const c = await checkedOut(ctx);
  const { body } = await startPay(c);

  clock.t += 16 * 60000; // past the 15-minute payment TTL, Paytm still pending
  const s1 = await payments.reconcile();
  assert.equal(s1.expiredPayments, 1);
  assert.equal(dbOrder(ctx, c.orderId).status, 'awaiting_payment');
  clock.t += 15 * 60000; // past the 30-minute order window
  const s2 = await payments.reconcile();
  assert.equal(s2.expiredOrders, 1);
  assert.equal(dbOrder(ctx, c.orderId).status, 'expired');
  assert.equal((await startPay(c)).status, 409);

  // The UPI app finally completes: money was taken, so the order is paid.
  mock.setStatus(body.paymentId, 'TXN_SUCCESS');
  assert.equal((await webhook(ctx, mock.callbackParams(body.paymentId))).status, 200);
  const o = dbOrder(ctx, c.orderId);
  assert.equal(o.status, 'paid');
  assert.equal(o.token_no, 101);
  assert.equal(ctx.db.prepare("SELECT action FROM audit_logs WHERE order_id = ?").pluck().get(c.orderId), 'payment_verified_late');
});

test('token numbers restart at midnight India time', async (t) => {
  const clock = { t: Date.parse('2026-11-06T18:20:00Z') }; // 23:50 IST
  const { ctx, mock } = await setup(t, { clock });
  const a = await checkedOut(ctx);
  await paySuccessfully(ctx, mock, a);
  clock.t = Date.parse('2026-11-06T18:40:00Z'); // 00:10 IST next day
  const b = await checkedOut(ctx);
  await paySuccessfully(ctx, mock, b);
  const c = await checkedOut(ctx);
  await paySuccessfully(ctx, mock, c);
  assert.deepEqual([a, b, c].map((x) => [dbOrder(ctx, x.orderId).token_date, dbOrder(ctx, x.orderId).token_no]), [
    ['2026-11-06', 101], ['2026-11-07', 101], ['2026-11-07', 102]
  ]);
});

/* ---------- reopen to edit ---------- */

test('reopen: back to draft only after Paytm confirms nothing was paid', async (t) => {
  const { ctx, mock } = await setup(t);
  const c = await checkedOut(ctx);
  const { body } = await startPay(c);

  mock.flags.statusDown = true;
  assert.equal((await c.call(`/api/orders/${c.orderId}/reopen`, { method: 'POST' })).status, 503, 'unsure -> no reopen');
  mock.flags.statusDown = false;

  const r = await c.call(`/api/orders/${c.orderId}/reopen`, { method: 'POST' });
  assert.equal(r.status, 200);
  assert.equal(dbOrder(ctx, c.orderId).status, 'draft');
  assert.equal(ctx.db.prepare('SELECT status FROM payments WHERE id = ?').pluck().get(body.paymentId), 'expired');

  // The customer completes the old UPI request anyway: money is flagged for refund, order untouched.
  mock.setStatus(body.paymentId, 'TXN_SUCCESS');
  await webhook(ctx, mock.callbackParams(body.paymentId));
  const o = dbOrder(ctx, c.orderId);
  assert.equal(o.status, 'draft');
  assert.equal(o.needs_attention, 'payment_needs_refund');
  assert.equal(ctx.db.prepare('SELECT needs_refund FROM payments WHERE id = ?').pluck().get(body.paymentId), 1);
});

test('reopen when the customer actually paid: the order becomes paid instead', async (t) => {
  const { ctx, mock } = await setup(t);
  const c = await checkedOut(ctx);
  const { body } = await startPay(c);
  mock.setStatus(body.paymentId, 'TXN_SUCCESS');
  const r = await c.call(`/api/orders/${c.orderId}/reopen`, { method: 'POST' });
  assert.equal(r.status, 409);
  assert.equal(dbOrder(ctx, c.orderId).status, 'paid');
});

/* ---------- isolation and abuse ---------- */

test('another browser cannot pay, poll or reopen my order', async (t) => {
  const { ctx } = await setup(t);
  const me = await checkedOut(ctx);
  const other = await newCustomer(ctx.base);
  for (const [method, path] of [['POST', 'payments'], ['GET', 'payment-status'], ['POST', 'reopen']]) {
    assert.equal((await other.call(`/api/orders/${me.orderId}/${path}`, { method })).status, 404, path);
    assert.equal((await api(ctx.base)(`/api/orders/${me.orderId}/${path}`, { method })).status, 401, path);
  }
  assert.equal(ctx.db.prepare('SELECT COUNT(*) FROM payments').pluck().get(), 0);
});

test('there is no route a customer can use to mark an order paid', async (t) => {
  const { ctx } = await setup(t);
  const c = await checkedOut(ctx);
  const attempts = [
    ['POST', `/api/orders/${c.orderId}/payments/confirm`, { status: 'success', amount: 6 }],
    ['PATCH', `/api/orders/${c.orderId}/status`, { status: 'paid', actor: 'admin' }],
    ['POST', '/api/payments/webhook', { orderId: c.orderId, status: 'success', provider: 'demo' }],
    ['POST', `/api/orders/${c.orderId}/handover`, {}]
  ];
  for (const [method, path, body] of attempts) {
    const r = await c.call(path, { method, body });
    assert.equal(r.status, 404, `${method} ${path}`);
  }
  // A JSON "callback" without Paytm's checksum does nothing.
  const fake = await fetch(`${ctx.base}/api/payments/paytm/callback`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/json', cookie: c.cookie },
    body: JSON.stringify({ ORDERID: c.orderId, STATUS: 'TXN_SUCCESS' })
  });
  assert.equal(fake.status, 303);
  assert.equal(dbOrder(ctx, c.orderId).status, 'awaiting_payment');
});

/* ---------- refunds (admin UI comes in phase 6) ---------- */

test('refund: paid -> refund_pending -> refunded once Paytm confirms', async (t) => {
  const clock = { t: Date.now() };
  const { ctx, mock, payments } = await setup(t, { clock });
  const c = await checkedOut(ctx);
  const paymentId = await paySuccessfully(ctx, mock, c);

  const refund = await payments.requestRefund({ orderId: c.orderId, reason: 'Printer jam, customer left', adminId: 'admin-1' });
  assert.equal(refund.status, 'pending');
  assert.equal(dbOrder(ctx, c.orderId).status, 'refund_pending');
  const sent = mock.refunds.get(refund.id).body;
  assert.equal(sent.orderId, paymentId);
  assert.equal(sent.refundAmount, '6.00');

  mock.refunds.get(refund.id).status = 'TXN_SUCCESS';
  clock.t += 61000;
  await payments.reconcile();
  assert.equal(dbOrder(ctx, c.orderId).status, 'refunded');
  await assert.rejects(payments.requestRefund({ orderId: c.orderId, reason: 'again', adminId: 'admin-1' }), /cannot be refunded/);
});

test('refund failure sends the order to the admin for attention', async (t) => {
  const clock = { t: Date.now() };
  const { ctx, mock, payments } = await setup(t, { clock });
  const c = await checkedOut(ctx);
  await paySuccessfully(ctx, mock, c);
  const refund = await payments.requestRefund({ orderId: c.orderId, reason: 'test', adminId: 'admin-1' });
  mock.refunds.get(refund.id).status = 'TXN_FAILURE';
  clock.t += 61000;
  await payments.reconcile();
  const o = dbOrder(ctx, c.orderId);
  assert.equal(o.status, 'print_attention');
  assert.equal(o.needs_attention, 'refund_failed');
});

test('CSP allows exactly the Paytm host; webhooks are not throttled by the per-IP limit', async (t) => {
  const { ctx, mock } = await setup(t, { env: { QP_RATE_LIMIT_PER_MIN: '3' } });
  const csp = (await fetch(`${ctx.base}/api/health`)).headers.get('content-security-policy');
  assert.match(csp, new RegExp(`script-src 'self' ${mock.host.replace(/[.:/]/g, '\\$&')}`));
  assert.match(csp, new RegExp(`frame-src ${mock.host.replace(/[.:/]/g, '\\$&')}`));
  const statuses = [];
  for (let i = 0; i < 6; i++) statuses.push((await webhook(ctx, mock.callbackParams('unknown-payment'))).status);
  assert.ok(!statuses.includes(429), `webhook statuses: ${statuses}`);
});
