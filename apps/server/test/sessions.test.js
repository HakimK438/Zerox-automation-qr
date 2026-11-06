'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers');
const { insertOrder, sessionCookie, api } = require('./fixtures');
const { createSessionService } = require('../src/modules/sessions/service');
const { createRecoveryService, MAX_RECOVERY_FAILURES } = require('../src/modules/orders/recovery');
const { createSessionExpiryJob } = require('../src/jobs/sessionExpiry');
const { sha256 } = require('../src/lib/crypto');
const { openDatabase } = require('../src/db');
const { parseToken, formatToken } = require('../src/lib/token');

const DAY = 86400000;

async function newSession(base) {
  const res = await api(base)('/api/session', { method: 'POST' });
  const c = sessionCookie(res);
  return { res, cookie: c && c.pair, setCookie: c && c.header };
}

test('session: created with a hardened cookie; only the hash is stored', async (t) => {
  const app = await startTestApp();
  t.after(app.close);
  const { res, cookie, setCookie } = await newSession(app.base);
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.created, true);
  assert.ok(Date.parse(body.expiresAt) > Date.now() + 29 * DAY);
  assert.ok(!('token' in body) && !('sessionId' in body), 'secrets never in JSON');

  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);
  assert.match(setCookie, /Path=\//);
  const token = decodeURIComponent(cookie.split('=')[1]);
  assert.ok(token.length >= 43, '256-bit token');
  const rows = app.db.prepare('SELECT token_hash FROM sessions').pluck().all();
  assert.deepEqual(rows, [sha256(token)]);
});

test('session: reused on reload instead of creating a new one', async (t) => {
  const app = await startTestApp();
  t.after(app.close);
  const { cookie } = await newSession(app.base);
  const again = await api(app.base, { cookie })('/api/session', { method: 'POST' });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).created, false);
  assert.equal(app.db.prepare('SELECT COUNT(*) FROM sessions').pluck().get(), 1);
  assert.equal((await api(app.base, { cookie })('/api/session')).status, 200);
});

test('session: production cookie uses the __Host- prefix and Secure', async (t) => {
  const app = await startTestApp({ QP_COOKIE_SECURE: 'true' });
  t.after(app.close);
  const { setCookie } = await newSession(app.base);
  assert.match(setCookie, /^__Host-qp_sid=/);
  assert.match(setCookie, /Secure/);
  assert.doesNotMatch(setCookie, /Domain=/i);
});

test('session: missing, forged or oversized cookies are rejected', async (t) => {
  const app = await startTestApp();
  t.after(app.close);
  assert.equal((await api(app.base)('/api/session')).status, 401);
  assert.equal((await api(app.base, { cookie: 'qp_sid=forged' })('/api/session')).status, 401);
  assert.equal((await api(app.base, { cookie: `qp_sid=${'a'.repeat(5000)}` })('/api/session')).status, 401);
  assert.equal((await api(app.base)('/api/me/orders')).status, 401);
});

test('session: the old public session lookup no longer exists', async (t) => {
  const app = await startTestApp();
  t.after(app.close);
  await newSession(app.base);
  const id = app.db.prepare('SELECT id FROM sessions').pluck().get();
  assert.equal((await api(app.base)(`/api/sessions/${id}`)).status, 404);
});

test('session: expires when idle with no active order, but never while an order is active', () => {
  const db = openDatabase(':memory:');
  let clock = Date.now();
  const sessions = createSessionService({ db, now: () => clock });

  const idle = sessions.create();
  const busy = sessions.create();
  insertOrder(db, { sessionId: busy.id, status: 'ready', tokenNo: 101, pin: '1234' });
  const done = sessions.create();
  insertOrder(db, { sessionId: done.id, status: 'handed_over', tokenNo: 102, pin: '5678' });

  clock += 31 * DAY;
  assert.equal(sessions.resolve(idle.token), null, 'idle session expired');
  assert.equal(sessions.resolve(done.token), null, 'finished orders do not keep a session alive');
  const alive = sessions.resolve(busy.token);
  assert.ok(alive, 'session with a ready order survives');
  assert.equal(alive.refreshed, true, 'cookie re-issued');
  assert.ok(Date.parse(alive.expiresAt) > clock + 29 * DAY, 'expiry extended');
  db.close();
});

test('session: sliding expiry refreshes at most hourly', () => {
  const db = openDatabase(':memory:');
  let clock = Date.now();
  const sessions = createSessionService({ db, now: () => clock });
  const s = sessions.create();
  assert.equal(sessions.resolve(s.token).refreshed, false);
  clock += 30 * 60 * 1000;
  assert.equal(sessions.resolve(s.token).refreshed, false);
  clock += 31 * 60 * 1000;
  assert.equal(sessions.resolve(s.token).refreshed, true);
  db.close();
});

test('my orders: returns only this browser\'s orders, newest first, and the active one', async (t) => {
  const app = await startTestApp();
  t.after(app.close);
  const a = await newSession(app.base);
  const b = await newSession(app.base);
  const [sidA, sidB] = app.db.prepare('SELECT id FROM sessions ORDER BY created_at').pluck().all();

  insertOrder(app.db, { sessionId: sidA, status: 'handed_over', tokenNo: 101, pin: '1111' });
  const active = insertOrder(app.db, { sessionId: sidA, status: 'printing', tokenNo: 104, pin: '2222' });
  insertOrder(app.db, { sessionId: sidA, status: 'draft' });
  insertOrder(app.db, { sessionId: sidB, status: 'paid', tokenNo: 105, pin: '3333' });

  const res = await api(app.base, { cookie: a.cookie })('/api/me/orders');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.orders.length, 2, 'drafts hidden, other sessions hidden');
  assert.equal(body.activeOrderId, active);
  const printing = body.orders.find((o) => o.orderId === active);
  assert.equal(printing.token, 'XR-104');
  assert.equal(printing.statusLabel, 'Printing');
  assert.ok(!JSON.stringify(body).includes('recovery'), 'no PIN material leaks');

  const other = await (await api(app.base, { cookie: b.cookie })('/api/me/orders')).json();
  assert.deepEqual(other.orders.map((o) => o.token), ['XR-105']);
});

test('recovery: token + PIN moves the order to the new browser', async (t) => {
  const app = await startTestApp();
  t.after(app.close);
  const original = await newSession(app.base);
  const sidOriginal = app.db.prepare('SELECT id FROM sessions').pluck().get();
  const orderId = insertOrder(app.db, { sessionId: sidOriginal, status: 'paid', tokenNo: 107, pin: '4821' });

  // A different browser with no cookie at all (e.g. the UPI app's webview).
  const res = await api(app.base)('/api/orders/recover', { method: 'POST', body: { token: 'xr 107', pin: '4821' } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { orderId });
  const fresh = sessionCookie(res);
  assert.ok(fresh, 'a session is created for the recovering browser');

  const mine = await (await api(app.base, { cookie: fresh.pair })('/api/me/orders')).json();
  assert.equal(mine.activeOrderId, orderId);
  const old = await (await api(app.base, { cookie: original.cookie })('/api/me/orders')).json();
  assert.equal(old.orders.length, 0, 'the order left the old browser');

  const audit = app.db.prepare("SELECT action, order_id FROM audit_logs").all();
  assert.deepEqual(audit, [{ action: 'order_recovered', order_id: orderId }]);
});

test('recovery: wrong PIN and unknown token look identical; finished orders cannot be recovered', async (t) => {
  const app = await startTestApp();
  t.after(app.close);
  await newSession(app.base);
  const sid = app.db.prepare('SELECT id FROM sessions').pluck().get();
  insertOrder(app.db, { sessionId: sid, status: 'paid', tokenNo: 110, pin: '1234' });
  insertOrder(app.db, { sessionId: sid, status: 'handed_over', tokenNo: 111, pin: '1234' });
  const call = (body) => api(app.base, { headers: {} })('/api/orders/recover', { method: 'POST', body });

  const wrongPin = await call({ token: 'XR-110', pin: '9999' });
  const unknown = await call({ token: 'XR-999', pin: '1234' });
  const finished = await call({ token: 'XR-111', pin: '1234' });
  for (const r of [wrongPin, unknown, finished]) assert.equal(r.status, 404);
  const [a, b] = [await wrongPin.json(), await unknown.json()];
  assert.equal(a.error.message, b.error.message);

  const bad = await call({ token: 'XR-110', pin: '12' });
  assert.equal(bad.status, 400);
});

test('recovery: rate limited per IP', async (t) => {
  const app = await startTestApp();
  t.after(app.close);
  const statuses = [];
  for (let i = 0; i < 7; i++) {
    const r = await api(app.base)('/api/orders/recover', { method: 'POST', body: { token: `XR-${200 + i}`, pin: '0000' } });
    statuses.push(r.status);
  }
  assert.deepEqual(statuses.slice(5), [429, 429]);
});

test('recovery: rate limited per token even when the IP changes', async (t) => {
  const app = await startTestApp({ QP_TRUST_PROXY: 'loopback' });
  t.after(app.close);
  const statuses = [];
  for (let i = 0; i < 7; i++) {
    const r = await api(app.base)('/api/orders/recover', {
      method: 'POST', body: { token: 'XR-300', pin: String(1000 + i) }, headers: { 'x-forwarded-for': `198.51.100.${i}` }
    });
    statuses.push(r.status);
  }
  assert.deepEqual(statuses.slice(0, 5), [404, 404, 404, 404, 404]);
  assert.deepEqual(statuses.slice(5), [429, 429]);
});

test('recovery: locks the order after repeated wrong PINs, even with the right PIN afterwards', () => {
  const db = openDatabase(':memory:');
  const sessions = createSessionService({ db });
  const recovery = createRecoveryService({ db });
  const owner = sessions.create();
  const attacker = sessions.create();
  const orderId = insertOrder(db, { sessionId: owner.id, status: 'paid', tokenNo: 120, pin: '7777' });

  for (let i = 0; i < MAX_RECOVERY_FAILURES; i++) {
    assert.equal(recovery.recover({ tokenNo: 120, pin: String(1000 + i), sessionId: attacker.id }).ok, false);
  }
  const after = recovery.recover({ tokenNo: 120, pin: '7777', sessionId: attacker.id });
  assert.deepEqual(after, { ok: false, reason: 'locked' });
  assert.equal(db.prepare('SELECT session_id FROM orders WHERE id = ?').pluck().get(orderId), owner.id);
  db.close();
});

test('recovery: a token number reused on another day finds the right order', () => {
  const db = openDatabase(':memory:');
  const sessions = createSessionService({ db });
  const recovery = createRecoveryService({ db });
  const s1 = sessions.create();
  const s2 = sessions.create();
  const me = sessions.create();
  const yesterday = new Date(Date.now() - DAY).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const old = insertOrder(db, { sessionId: s1.id, status: 'ready', tokenNo: 130, tokenDate: yesterday, pin: '1111' });
  const today = insertOrder(db, { sessionId: s2.id, status: 'paid', tokenNo: 130, pin: '2222' });
  assert.deepEqual(recovery.recover({ tokenNo: 130, pin: '1111', sessionId: me.id }), { ok: true, orderId: old });
  assert.deepEqual(recovery.recover({ tokenNo: 130, pin: '2222', sessionId: me.id }), { ok: true, orderId: today });
  db.close();
});

test('expiry job: removes only expired sessions that never ordered', () => {
  const db = openDatabase(':memory:');
  let clock = Date.now();
  const sessions = createSessionService({ db, now: () => clock });
  const job = createSessionExpiryJob({ db, logger: { info() {} }, now: () => clock });
  sessions.create();
  const withOrder = sessions.create();
  insertOrder(db, { sessionId: withOrder.id, status: 'handed_over', tokenNo: 140, pin: '1234' });
  const fresh = () => sessions.create();
  assert.equal(job.runOnce(), 0);
  clock += 31 * DAY;
  fresh();
  assert.equal(job.runOnce(), 1);
  assert.equal(db.prepare('SELECT COUNT(*) FROM sessions').pluck().get(), 2);
  db.close();
});

test('token helpers', () => {
  assert.equal(parseToken('XR-105'), 105);
  assert.equal(parseToken(' xr 7 '), 7);
  assert.equal(parseToken('105'), 105);
  assert.equal(parseToken('XR-1e5'), null);
  assert.equal(parseToken('DROP TABLE'), null);
  assert.equal(parseToken(105), null);
  assert.equal(formatToken(42), 'XR-42');
  assert.equal(formatToken(null), null);
});
