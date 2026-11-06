'use strict';
/* Phase 6: admin login (password + TOTP), sessions, CSRF, host split, dashboard actions, settings,
   prices, refunds, reports, audit and the live admin stream. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { newCustomer, addPdf } = require('./fixtures');
const { totp } = require('../src/lib/totp');

const { ADMIN_HOST, ADMIN_ORIGIN, PASSWORD, raw, adminLogin, setup, paidOrder } = require('./adminKit');

/* ---------- login & sessions ---------- */

test('no admin exists by default; login needs password AND a fresh TOTP code', async (t) => {
  const ctx = await setup(t);
  assert.equal(ctx.app.locals.adminAuth.userCount(), 0, 'no default admin account');
  const { totpSecret } = ctx.app.locals.adminAuth.createUser({ username: 'owner', password: PASSWORD });
  const login = (body) => raw(ctx.base, '/api/admin/login', { method: 'POST', body, headers: { origin: ADMIN_ORIGIN } });

  const wrongPw = await login({ username: 'owner', password: 'nope', otp: totp(totpSecret) });
  const wrongOtp = await login({ username: 'owner', password: PASSWORD, otp: '000000' });
  const noUser = await login({ username: 'ghost', password: PASSWORD, otp: totp(totpSecret) });
  for (const r of [wrongPw, wrongOtp, noUser]) assert.equal(r.status, 401);
  assert.equal(wrongPw.json.error.message, noUser.json.error.message, 'same answer for unknown user and wrong password');

  const ok = await login({ username: 'owner', password: PASSWORD, otp: totp(totpSecret) });
  assert.equal(ok.status, 200);
  assert.ok(ok.json.csrfToken);
  assert.ok(!JSON.stringify(ok.json).includes(ok.headers['set-cookie'][0].split(';')[0].split('=')[1]), 'session token is never in the body');
  const cookie = ok.headers['set-cookie'][0];
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);

  const replay = await login({ username: 'owner', password: PASSWORD, otp: totp(totpSecret) });
  assert.equal(replay.status, 401, 'the same 6-digit code cannot be used twice');
});

test('5 failed logins lock the account for 15 minutes, even with the right password', async (t) => {
  let clock = Date.now();
  const ctx = await setup(t, { now: () => clock });
  const { totpSecret } = ctx.app.locals.adminAuth.createUser({ username: 'owner', password: PASSWORD });
  const login = (body) => raw(ctx.base, '/api/admin/login', { method: 'POST', body, headers: { origin: ADMIN_ORIGIN } });
  for (let i = 0; i < 5; i += 1) assert.equal((await login({ username: 'owner', password: 'wrong', otp: '123456' })).status, 401);
  assert.equal((await login({ username: 'owner', password: PASSWORD, otp: totp(totpSecret, clock) })).status, 401, 'locked');
  clock += 16 * 60000;
  assert.equal((await login({ username: 'owner', password: PASSWORD, otp: totp(totpSecret, clock) })).status, 200, 'unlocked after 15 min');
  const fails = ctx.db.prepare("SELECT COUNT(*) FROM audit_logs WHERE action = 'login_failed'").pluck().get();
  assert.equal(fails, 6);
});

test('production-style cookies: __Host- prefix and Secure', async (t) => {
  const ctx = await setup(t, { env: { QP_COOKIE_SECURE: 'true' } });
  const { totpSecret } = ctx.app.locals.adminAuth.createUser({ username: 'owner', password: PASSWORD });
  const r = await raw(ctx.base, '/api/admin/login', { method: 'POST', body: { username: 'owner', password: PASSWORD, otp: totp(totpSecret) }, headers: { origin: ADMIN_ORIGIN } });
  assert.match(r.headers['set-cookie'][0], /^__Host-qp_admin=.*; Path=\/; .*HttpOnly; Secure; SameSite=Strict/);
});

test('session: idle 30 min or 12 h absolute ends it; logout and logout-all work', async (t) => {
  let clock = Date.now();
  const ctx = await setup(t, { now: () => clock });
  const a = await adminLogin(ctx);
  assert.equal((await a.call('/api/admin/session')).status, 200);
  clock += 31 * 60000;
  assert.equal((await a.call('/api/admin/session')).status, 401, 'idle timeout');

  const b = await adminLogin(ctx, { create: false });
  const b2 = await adminLogin(ctx, { create: false });
  assert.equal((await b.call('/api/admin/logout', { method: 'POST' })).status, 200);
  assert.equal((await b.call('/api/admin/session')).status, 401);
  assert.equal((await b2.call('/api/admin/session')).status, 200, 'other device still logged in');
  assert.equal((await b2.call('/api/admin/logout-all', { method: 'POST' })).status, 200);
  assert.equal((await b2.call('/api/admin/session')).status, 401);
});

/* ---------- the walls around the dashboard ---------- */

test('every admin route answers 401 without a session', async (t) => {
  const ctx = await setup(t);
  const id = '00000000-0000-4000-8000-000000000000';
  const routes = [
    ['GET', '/api/admin/session'], ['POST', '/api/admin/logout'], ['POST', '/api/admin/logout-all'],
    ['GET', '/api/admin/orders'], ['GET', `/api/admin/orders/${id}`], ['GET', `/api/admin/orders/${id}/documents/${id}/pdf`],
    ['POST', `/api/admin/orders/${id}/status`], ['POST', `/api/admin/orders/${id}/handover`], ['POST', `/api/admin/orders/${id}/refund`],
    ['GET', '/api/admin/events'], ['GET', '/api/admin/settings'], ['PUT', '/api/admin/settings/shop'], ['PUT', '/api/admin/prices'],
    ['GET', '/api/admin/reports/daily'], ['GET', '/api/admin/audit'],
    ['GET', '/api/admin/printers'], ['POST', '/api/admin/agents/pairing'], ['POST', `/api/admin/agents/${id}/revoke`], ['PUT', `/api/admin/printers/${id}`]
  ];
  for (const [method, path] of routes) {
    const r = await raw(ctx.base, path, { method, body: method === 'GET' ? undefined : {}, headers: { origin: ADMIN_ORIGIN } });
    assert.equal(r.status, 401, `${method} ${path}`);
  }
});

test('host split: admin API only on the admin host, customer API never on it', async (t) => {
  const ctx = await setup(t);
  const a = await adminLogin(ctx);
  // admin API from the customer host (cookie and CSRF are valid!) -> does not exist there
  const viaPublic = await raw(ctx.base, '/api/admin/orders', { host: '127.0.0.1:3000', headers: { cookie: a.cookie } });
  assert.equal(viaPublic.status, 404);
  const viaFetch = await fetch(`${ctx.base}/api/admin/session`, { headers: { cookie: a.cookie } });
  assert.equal(viaFetch.status, 404);
  // customer API on the admin host -> not there either
  assert.equal((await raw(ctx.base, '/api/session', { method: 'POST', headers: { origin: ADMIN_ORIGIN } })).status, 404);
  assert.equal((await raw(ctx.base, '/api/pricing')).status, 404);
  assert.equal((await raw(ctx.base, '/api/health')).status, 200);
});

test('a customer session cookie never opens the admin API', async (t) => {
  const ctx = await setup(t);
  const c = await newCustomer(ctx.base);
  const r = await raw(ctx.base, '/api/admin/orders', { headers: { cookie: c.cookie } });
  assert.equal(r.status, 401);
  const forged = await raw(ctx.base, '/api/admin/orders', { headers: { cookie: c.cookie.replace(/^qp_sid/, 'qp_admin') } });
  assert.equal(forged.status, 401, 'a customer token renamed to the admin cookie is not an admin session');
});

test('writes need the CSRF header and the admin origin', async (t) => {
  const ctx = await setup(t);
  const a = await adminLogin(ctx);
  const body = { value: true };
  const noCsrf = await raw(ctx.base, '/api/admin/settings/paused', { method: 'PUT', body, headers: { cookie: a.cookie, origin: ADMIN_ORIGIN } });
  assert.equal(noCsrf.status, 403);
  const badCsrf = await raw(ctx.base, '/api/admin/settings/paused', { method: 'PUT', body, headers: { cookie: a.cookie, origin: ADMIN_ORIGIN, 'x-csrf-token': 'x'.repeat(43) } });
  assert.equal(badCsrf.status, 403);
  const fromShopSite = await raw(ctx.base, '/api/admin/settings/paused', { method: 'PUT', body, headers: { cookie: a.cookie, origin: 'http://localhost:3000', 'x-csrf-token': a.csrf } });
  assert.equal(fromShopSite.status, 403, 'even our own customer origin cannot write to the admin API');
  const ok = await a.call('/api/admin/settings/paused', { method: 'PUT', body });
  assert.equal(ok.status, 200);
  assert.equal(ctx.app.locals.settings.paused(), true);
});

test('admin site: login page without a session, dashboard with one; customer site unaffected', async (t) => {
  const ctx = await setup(t);
  const anon = await raw(ctx.base, '/');
  assert.equal(anon.status, 200);
  assert.match(anon.text, /id="loginForm"/);
  const direct = await raw(ctx.base, '/owner.html');
  assert.match(direct.text, /id="loginForm"/, 'typing the dashboard URL still shows the login page');
  const a = await adminLogin(ctx);
  const dash = await raw(ctx.base, '/', { headers: { cookie: a.cookie } });
  assert.match(dash.text, /id="dashboard"/);
  assert.match(dash.headers['content-security-policy'], /script-src 'self'(;|$)/);
  const shop = await (await fetch(`${ctx.base}/`)).text();
  assert.match(shop, /id="fileIn"/, 'customer host still serves the customer site');
});

/* ---------- orders ---------- */

test('dashboard sees only paid orders; status moves through printing -> ready; paid cannot be set', async (t) => {
  const ctx = await setup(t);
  const a = await adminLogin(ctx);
  const draft = await newCustomer(ctx.base);
  const p = await paidOrder(ctx, 3);

  const list = (await a.call('/api/admin/orders')).json;
  assert.deepEqual(list.orders.map((o) => o.orderId), [p.orderId], 'drafts never appear');
  assert.equal(list.orders[0].token, p.token);
  assert.equal(list.orders[0].sides, 3);
  assert.equal(list.counts.waiting, 1);
  assert.equal((await a.call(`/api/admin/orders/${draft.orderId}`)).status, 404);

  const detail = (await a.call(`/api/admin/orders/${p.orderId}`)).json;
  assert.equal(detail.payments[0].status, 'success');
  assert.ok(!JSON.stringify(detail).includes(p.pin), 'the dashboard never sees the pickup PIN');
  const pdf = await a.call(detail.documents[0].pdfUrl);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers['content-security-policy'], 'sandbox');

  const set = (to) => a.call(`/api/admin/orders/${p.orderId}/status`, { method: 'POST', body: { to } });
  assert.equal((await set('paid')).status, 400, 'paid is not settable');
  assert.equal((await set('handed_over')).status, 400, 'handover needs the PIN route');
  const printing = await set('printing');
  assert.equal(printing.json.status, 'printing');
  assert.ok(printing.json.printingAt);
  assert.equal((await set('ready')).json.status, 'ready');
  const customer = await (await p.c.call(`/api/orders/${p.orderId}`)).json();
  assert.equal(customer.status, 'ready', 'customer sees it');

  const events = ctx.db.prepare("SELECT to_status FROM order_events WHERE order_id = ? AND actor = 'admin' ORDER BY rowid").pluck().all(p.orderId);
  assert.deepEqual(events, ['printing', 'ready']);
  const audits = ctx.db.prepare("SELECT COUNT(*) FROM audit_logs WHERE action = 'order_status' AND order_id = ?").pluck().get(p.orderId);
  assert.equal(audits, 2);
});

test('handover needs the customer PIN; wrong PINs lock; owner can override with password', async (t) => {
  const ctx = await setup(t);
  const a = await adminLogin(ctx);
  const staff = await adminLogin(ctx, { username: 'counter', role: 'staff' });
  const p = await paidOrder(ctx);
  const hand = (client, body) => client.call(`/api/admin/orders/${p.orderId}/handover`, { method: 'POST', body });

  assert.equal((await hand(a, { pin: p.pin })).status, 409, 'not ready yet');
  await a.call(`/api/admin/orders/${p.orderId}/status`, { method: 'POST', body: { to: 'ready' } });
  const wrong = p.pin === '0000' ? '1111' : '0000';
  const first = await hand(staff, { pin: wrong });
  assert.equal(first.status, 400);
  assert.match(first.json.error.message, /4 tries left/);
  for (let i = 0; i < 4; i += 1) await hand(staff, { pin: wrong });
  const locked = await hand(staff, { pin: p.pin });
  assert.equal(locked.status, 423, 'locked even with the right PIN');
  assert.equal((await hand(staff, { password: PASSWORD, reason: 'customer lost phone' })).status, 403, 'staff cannot override');
  assert.equal((await hand(a, { password: 'wrong', reason: 'customer lost phone' })).status, 403);
  const ok = await hand(a, { password: PASSWORD, reason: 'customer lost phone' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.status, 'handed_over');
  const customer = await (await p.c.call(`/api/orders/${p.orderId}`)).json();
  assert.equal(customer.pickupPin, null, 'PIN no longer shown after handover');
});

test('handover with the right PIN', async (t) => {
  const ctx = await setup(t);
  const staff = await adminLogin(ctx, { username: 'counter', role: 'staff' });
  const p = await paidOrder(ctx);
  await staff.call(`/api/admin/orders/${p.orderId}/status`, { method: 'POST', body: { to: 'ready' } });
  const r = await staff.call(`/api/admin/orders/${p.orderId}/handover`, { method: 'POST', body: { pin: p.pin } });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'handed_over');
  assert.equal(ctx.db.prepare("SELECT details FROM audit_logs WHERE action = 'handover'").pluck().get(), '{"method":"pin"}');
});

test('refund: owner only, password required, goes through Paytm and is audited', async (t) => {
  const ctx = await setup(t);
  const a = await adminLogin(ctx);
  const staff = await adminLogin(ctx, { username: 'counter', role: 'staff' });
  const p = await paidOrder(ctx);
  const refund = (client, body) => client.call(`/api/admin/orders/${p.orderId}/refund`, { method: 'POST', body });
  assert.equal((await refund(staff, { reason: 'printer broken', password: PASSWORD })).status, 403);
  assert.equal((await refund(a, { reason: 'printer broken', password: 'nope' })).status, 403);
  assert.equal((await refund(a, { reason: 'printer broken' })).status, 400);
  const ok = await refund(a, { reason: 'printer broken', password: PASSWORD });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.order.status, 'refund_pending');
  assert.equal(ctx.mock.refunds.size, 1, 'refund sent to Paytm');
  assert.equal(ctx.db.prepare("SELECT COUNT(*) FROM audit_logs WHERE action = 'refund_requested'").pluck().get(), 1);
  assert.equal((await refund(a, { reason: 'again', password: PASSWORD })).status, 409, 'no double refund');
});

/* ---------- settings & prices ---------- */

test('settings are validated, saved, audited and reach the customer site', async (t) => {
  const ctx = await setup(t);
  const a = await adminLogin(ctx);
  const staff = await adminLogin(ctx, { username: 'counter', role: 'staff' });
  const shop = { name: 'Sai Xerox', address: 'Near Bus Stand', phone: '+91 98765 43210', open: '08:30', close: '22:00' };
  assert.equal((await a.call('/api/admin/settings/shop', { method: 'PUT', body: { value: { ...shop, open: '25:00' } } })).status, 400);
  assert.equal((await a.call('/api/admin/settings/shop', { method: 'PUT', body: { value: { ...shop, evil: 1 } } })).status, 400);
  assert.equal((await a.call('/api/admin/settings/nope', { method: 'PUT', body: { value: 1 } })).status, 404);
  assert.equal((await staff.call('/api/admin/settings/shop', { method: 'PUT', body: { value: shop } })).status, 403);
  assert.equal((await staff.call('/api/admin/settings/print_mode', { method: 'PUT', body: { value: 'manual' } })).status, 200, 'staff can switch mode');
  const r = await a.call('/api/admin/settings/shop', { method: 'PUT', body: { value: shop } });
  assert.equal(r.status, 200);
  assert.equal(r.json.shop.name, 'Sai Xerox');
  const pub = await (await fetch(`${ctx.base}/api/shop`)).json();
  assert.equal(pub.name ?? pub.shop?.name, 'Sai Xerox');
  const opts = await a.call('/api/admin/settings/print_options', { method: 'PUT', body: { value: { maxCopies: 20, paperSizes: ['A4', 'A3'], allowRanges: true, maxPartsPerDocument: 5 } } });
  assert.equal(opts.status, 200);
  assert.deepEqual((await (await fetch(`${ctx.base}/api/pricing`)).json()).options.paperSizes, ['A4', 'A3']);
  const audit = (await a.call('/api/admin/audit')).json.entries;
  assert.ok(audit.some((e) => e.action === 'setting_changed' && e.details.key === 'shop' && e.user === 'owner'));
});

test('price change: password required, new version, paid orders keep their price', async (t) => {
  const ctx = await setup(t);
  const a = await adminLogin(ctx);
  const p = await paidOrder(ctx, 2);
  const before = (await a.call(`/api/admin/orders/${p.orderId}`)).json.totalPaise;
  const prices = { bw1Paise: 200, bw2Paise: 300, col1Paise: 800, col2Paise: 1500, a3Multiplier: 2, duplexBasis: 'sheet' };
  assert.equal((await a.call('/api/admin/prices', { method: 'PUT', body: prices })).status, 400);
  assert.equal((await a.call('/api/admin/prices', { method: 'PUT', body: { ...prices, password: 'x' } })).status, 403);
  assert.equal((await a.call('/api/admin/prices', { method: 'PUT', body: { ...prices, bw1Paise: -1, password: PASSWORD } })).status, 400);
  const r = await a.call('/api/admin/prices', { method: 'PUT', body: { ...prices, password: PASSWORD } });
  assert.equal(r.status, 200);
  assert.equal(r.json.prices.bw1Paise, 200);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) FROM price_tables').pluck().get() >= 2, true);
  assert.equal((await (await fetch(`${ctx.base}/api/pricing`)).json()).rates.bw1, 200);
  assert.equal((await a.call(`/api/admin/orders/${p.orderId}`)).json.totalPaise, before, 'paid order unchanged');
  const quote = await (await p.c.call(`/api/orders/${p.orderId}/quote`)).json();
  assert.equal(quote.totalPaise, before, 'customer quote frozen too');
  assert.ok(!JSON.stringify((await a.call('/api/admin/audit')).json).includes(PASSWORD), 'password never logged');
});

/* ---------- reports & live ---------- */

test('daily report: money received, refunded and printed', async (t) => {
  const ctx = await setup(t);
  const a = await adminLogin(ctx);
  const p1 = await paidOrder(ctx, 2);
  await paidOrder(ctx, 3);
  await a.call(`/api/admin/orders/${p1.orderId}/status`, { method: 'POST', body: { to: 'printing' } });
  const r = (await a.call('/api/admin/reports/daily')).json;
  assert.equal(r.orders, 2);
  assert.equal(r.receivedPaise, 600 + 900);
  assert.equal(r.netPaise, 1500);
  assert.equal(r.printed.bwSides, 2, 'only orders that went to print count as printed');
  const staff = await adminLogin(ctx, { username: 'counter', role: 'staff' });
  assert.equal((await staff.call('/api/admin/reports/daily')).status, 403, 'money reports are owner only');
});

test('live: the dashboard stream receives a newly paid order', async (t) => {
  const ctx = await setup(t);
  const a = await adminLogin(ctx);
  const events = [];
  const req = http.get({ hostname: '127.0.0.1', port: new URL(ctx.base).port, path: '/api/admin/events', headers: { host: ADMIN_HOST, cookie: a.cookie } }, (res) => {
    assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8');
    res.setEncoding('utf8');
    res.on('data', (chunk) => events.push(chunk));
  });
  t.after(() => req.destroy());
  await new Promise((r) => setTimeout(r, 100));
  const p = await paidOrder(ctx);
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !events.join('').includes(p.orderId)) await new Promise((r) => setTimeout(r, 30));
  const all = events.join('');
  assert.match(all, /event: counts/);
  assert.ok(all.includes(`"token":"${p.token}"`), 'paid order pushed with its token');
});

/* ---------- session lifetime = until delivery ---------- */

test('customer session: never expires before delivery, ends ~1 h after handover', async (t) => {
  let clock = Date.now();
  const ctx = await setup(t, { now: () => clock });
  const staff = await adminLogin(ctx, { username: 'counter', role: 'staff' });
  const p = await paidOrder(ctx);
  const issued = (await fetch(`${ctx.base}/api/session`, { method: 'POST', headers: { origin: 'http://localhost:3000' } })).headers.get('set-cookie');
  assert.match(issued, /Max-Age=(\d+)/);
  assert.ok(Number(issued.match(/Max-Age=(\d+)/)[1]) >= 399 * 86400, 'browser keeps the cookie for 400 days');

  clock += 100 * 86400000; // customer comes back 100 days later, order still not collected
  const later = await p.c.call(`/api/orders/${p.orderId}`);
  assert.equal(later.status, 200, 'session alive while the order waits for pickup');

  const staffNow = await adminLogin(ctx, { username: 'counter', create: false }); // the shop logs in again that day
  await staffNow.call(`/api/admin/orders/${p.orderId}/status`, { method: 'POST', body: { to: 'ready' } });
  const ho = await staffNow.call(`/api/admin/orders/${p.orderId}/handover`, { method: 'POST', body: { pin: p.pin } });
  assert.equal(ho.status, 200);
  await new Promise((r) => setImmediate(r));

  clock += 10 * 60000;
  const grace = await (await p.c.call(`/api/orders/${p.orderId}`)).json();
  assert.equal(grace.status, 'handed_over', 'still sees "Collected" right after pickup');

  clock += 61 * 60000;
  assert.equal((await p.c.call('/api/session')).status, 401, 'session ended after delivery');
  assert.equal((await p.c.call(`/api/orders/${p.orderId}`)).status, 401);
});

test('customer session: not ended while another order is active; a new order in the grace period keeps it', async (t) => {
  let clock = Date.now();
  const ctx = await setup(t, { now: () => clock });
  const staff = await adminLogin(ctx, { username: 'counter', role: 'staff' });
  const p = await paidOrder(ctx);
  const sessionId = ctx.db.prepare('SELECT session_id FROM orders WHERE id = ?').pluck().get(p.orderId);
  // second paid order in the same browser
  const second = (await (await p.c.call('/api/orders', { method: 'POST' })).json()).orderId;
  await addPdf(ctx, { ...p.c, orderId: second }, 1);
  ctx.db.prepare("UPDATE orders SET status = 'paid', paid_at = ? WHERE id = ?").run(new Date(clock).toISOString(), second);

  await staff.call(`/api/admin/orders/${p.orderId}/status`, { method: 'POST', body: { to: 'ready' } });
  await staff.call(`/api/admin/orders/${p.orderId}/handover`, { method: 'POST', body: { pin: p.pin } });
  await new Promise((r) => setImmediate(r));
  assert.equal(ctx.db.prepare('SELECT ended_at FROM sessions WHERE id = ?').pluck().get(sessionId), null, 'other order still to collect');

  // finish the second one too -> session ends
  ctx.db.prepare("UPDATE orders SET status = 'handed_over' WHERE id = ?").run(second);
  ctx.app.locals.bus.emit('order', second);
  assert.ok(ctx.db.prepare('SELECT ended_at FROM sessions WHERE id = ?').pluck().get(sessionId));

  // within the grace period the customer starts a new order: the session continues
  clock += 5 * 60000;
  assert.equal((await p.c.call('/api/orders', { method: 'POST' })).status, 201);
  clock += 2 * 3600000;
  assert.equal((await p.c.call('/api/session')).status, 200, 'new draft keeps the session alive');
});
