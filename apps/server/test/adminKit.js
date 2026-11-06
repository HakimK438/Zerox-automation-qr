'use strict';
/* Shared helpers for admin and print-agent tests: admin-host HTTP client, logged-in admin, paid orders. */
const assert = require('node:assert/strict');
const http = require('node:http');
const { startTestApp } = require('./helpers');
const { startPaytmMock } = require('./paytmMock');
const { newCustomer, addPdf } = require('./fixtures');
const { totp, STEP_SEC } = require('../src/lib/totp');

const ADMIN_HOST = '127.0.0.1:3001'; // QP_ADMIN_ORIGIN in test/helpers.js
const ADMIN_ORIGIN = `http://${ADMIN_HOST}`;
const PASSWORD = 'correct horse battery staple';

/* fetch() cannot set Host, so admin requests go through node:http. */
function raw(base, path, { method = 'GET', body, headers = {}, host = ADMIN_HOST } = {}) {
  const url = new URL(path, base);
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname + url.search, method,
      headers: { host, ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...headers }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Logged-in admin client. A code can be used only once, so each login of the same user takes the
    next 30-second step inside the accepted window (-1, 0, +1). */
async function adminLogin(ctx, { username = 'owner', role = 'owner', create = true } = {}) {
  const auth = ctx.app.locals.adminAuth;
  ctx.secrets = ctx.secrets || {};
  ctx.logins = ctx.logins || {};
  if (create) ctx.secrets[username] = auth.createUser({ username, password: PASSWORD, role }).totpSecret;
  const n = ctx.logins[username] = (ctx.logins[username] ?? -2) + 1;
  const otp = totp(ctx.secrets[username], (ctx.clock ? ctx.clock() : Date.now()) + n * STEP_SEC * 1000);
  const r = await raw(ctx.base, '/api/admin/login', { method: 'POST', body: { username, password: PASSWORD, otp }, headers: { origin: ADMIN_ORIGIN } });
  assert.equal(r.status, 200, r.text);
  const cookie = r.headers['set-cookie'].find((c) => c.startsWith('qp_admin=')).split(';')[0];
  const csrf = r.json.csrfToken;
  const call = (path, opts = {}) => raw(ctx.base, path, {
    ...opts, headers: { cookie, ...(opts.method && opts.method !== 'GET' ? { 'x-csrf-token': csrf, origin: ADMIN_ORIGIN } : {}), ...(opts.headers || {}) }
  });
  return { cookie, csrf, call, login: r };
}

async function setup(t, { env = {}, now } = {}) {
  const mock = await startPaytmMock();
  const ctx = await startTestApp({ PAYTM_MID: mock.mid, PAYTM_MERCHANT_KEY: mock.key, PAYTM_HOST: mock.host, ...env }, now ? { now } : {});
  t.after(async () => { await ctx.close(); await mock.close(); });
  ctx.mock = mock;
  ctx.clock = now;
  return ctx;
}

/** A customer order paid through the (mock) Paytm flow. Returns the customer, PIN and order id. */
async function paidOrder(ctx, pages = 2) {
  const c = await newCustomer(ctx.base);
  await addPdf(ctx, c, pages);
  await c.call(`/api/orders/${c.orderId}/checkout`, { method: 'POST' });
  const pay = await (await c.call(`/api/orders/${c.orderId}/payments`, { method: 'POST' })).json();
  ctx.mock.setStatus(pay.paymentId, 'TXN_SUCCESS');
  const v = await ctx.app.locals.payments.verify(pay.paymentId, 'status_api');
  assert.equal(v.outcome, 'paid');
  const order = await (await c.call(`/api/orders/${c.orderId}`)).json();
  return { c, orderId: c.orderId, pin: order.pickupPin, token: order.token };
}

module.exports = { ADMIN_HOST, ADMIN_ORIGIN, PASSWORD, raw, adminLogin, setup, paidOrder };
