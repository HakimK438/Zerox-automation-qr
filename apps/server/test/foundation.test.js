'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config/env');
const { openDatabase, migrate } = require('../src/db');
const qc = require('../src/lib/crypto');
const { ORDER_STATUS: S, TRANSITIONS, canTransition } = require('../../../shared/constants');

test('config: production refuses insecure or shared origins', () => {
  const base = { NODE_ENV: 'production', QP_DATA_DIR: '/tmp/qp' };
  assert.throws(() => loadConfig({ ...base, QP_PUBLIC_ORIGIN: 'http://shop.example', QP_ADMIN_ORIGIN: 'https://admin.example' }), /https/);
  assert.throws(() => loadConfig({ ...base, QP_PUBLIC_ORIGIN: 'https://a.example', QP_ADMIN_ORIGIN: 'https://a.example' }), /separate origin/);
  assert.throws(() => loadConfig({ ...base, QP_PUBLIC_ORIGIN: 'https://a.example', QP_ADMIN_ORIGIN: 'https://b.example', QP_COOKIE_SECURE: 'false' }), /Secure cookies/);
  const secrets = { QP_DATA_KEY: Buffer.alloc(32, 1).toString('base64'), PAYTM_MID: 'TESTMID123', PAYTM_MERCHANT_KEY: 'abcdefghijklmnop' };
  const origins = { QP_PUBLIC_ORIGIN: 'https://a.example/', QP_ADMIN_ORIGIN: 'https://b.example' };
  assert.throws(() => loadConfig({ ...base, ...origins, ...secrets, QP_DATA_KEY: undefined }), /QP_DATA_KEY is required/);
  assert.throws(() => loadConfig({ ...base, ...origins, ...secrets, PAYTM_MID: undefined }), /PAYTM_MID/);
  assert.throws(() => loadConfig({ ...base, ...origins, ...secrets, QP_DATA_KEY: 'c2hvcnQ=' }), /32 bytes/);
  assert.throws(() => loadConfig({ ...base, ...origins, ...secrets, PAYTM_HOST: 'http://securegw.paytm.in' }), /PAYTM_HOST must be https/);
  const ok = loadConfig({ ...base, ...origins, ...secrets });
  assert.equal(ok.paytm.mid, 'TESTMID123');
  assert.equal(ok.publicOrigin, 'https://a.example');
  assert.equal(ok.cookieSecure, true);
});

test('config: rejects invalid values', () => {
  assert.throws(() => loadConfig({ PORT: '99999' }), /PORT/);
  assert.throws(() => loadConfig({ QP_MAX_UPLOAD_MB: '-1' }), /QP_MAX_UPLOAD_MB/);
});

test('crypto: scrypt password hashing, tokens and PINs', () => {
  const h = qc.hashPassword('correct horse');
  assert.match(h, /^scrypt\$/);
  assert.notEqual(h, qc.hashPassword('correct horse'), 'salted');
  assert.equal(qc.verifyPassword('correct horse', h), true);
  assert.equal(qc.verifyPassword('wrong', h), false);
  assert.equal(qc.verifyPassword('x', 'garbage'), false);
  assert.ok(qc.randomToken().length >= 43);
  for (let i = 0; i < 50; i++) assert.match(qc.randomPin(4), /^\d{4}$/);
  assert.equal(qc.safeEqual('abc', 'abc'), true);
  assert.equal(qc.safeEqual('abc', 'abd'), false);
  assert.equal(qc.safeEqual('abc', 'abcd'), false);
});

test('state machine: only payment verification (system) can mark an order paid', () => {
  for (const from of Object.keys(TRANSITIONS)) {
    assert.equal(canTransition(from, S.PAID, 'customer'), false, `customer ${from}->paid`);
    assert.equal(canTransition(from, S.PAID, 'admin'), false, `admin ${from}->paid`);
  }
  assert.equal(canTransition(S.AWAITING_PAYMENT, S.PAID, 'system'), true);
  assert.equal(canTransition(S.DRAFT, S.PAID, 'system'), false, 'cannot skip checkout');
});

test('state machine: customers cannot advance print states; terminal states are final', () => {
  for (const to of [S.PRINTING, S.READY, S.HANDED_OVER]) {
    for (const from of Object.keys(TRANSITIONS)) assert.equal(canTransition(from, to, 'customer'), false);
  }
  assert.equal(canTransition(S.READY, S.HANDED_OVER, 'admin'), true);
  for (const t of [S.HANDED_OVER, S.CANCELLED, S.REFUNDED]) {
    assert.deepEqual(Object.keys(TRANSITIONS[t]), []);
  }
  // an expired order can only be revived by a verified late payment
  assert.deepEqual(Object.keys(TRANSITIONS[S.EXPIRED]), [S.PAID]);
  assert.equal(canTransition(S.EXPIRED, S.PAID, 'system'), true);
  assert.equal(canTransition(S.EXPIRED, S.PAID, 'admin'), false);
  // paid orders can only leave the money flow through a refund, never a silent cancel
  assert.equal(canTransition(S.PAID, S.CANCELLED, 'admin'), false);
});

test('db: migrations are idempotent and constraints hold', () => {
  const db = openDatabase(':memory:');
  migrate(db); // second run is a no-op
  const files = require('node:fs').readdirSync(require('node:path').join(__dirname, '../src/db/migrations')).filter((f) => f.endsWith('.sql'));
  assert.equal(db.prepare('SELECT COUNT(*) FROM schema_migrations').pluck().get(), files.length, 'each migration applied exactly once');

  const now = new Date().toISOString();
  db.prepare('INSERT INTO sessions (id, token_hash, created_at, last_seen_at, expires_at) VALUES (?,?,?,?,?)').run('s1', 'h1', now, now, now);
  const insertOrder = db.prepare(`INSERT INTO orders (id, session_id, status, token_date, token_no, created_at, updated_at)
    VALUES (?, 's1', ?, ?, ?, ?, ?)`);
  insertOrder.run('o1', 'paid', '2026-11-05', 101, now, now);
  assert.throws(() => insertOrder.run('o2', 'bogus', null, null, now, now), /CHECK/);
  assert.throws(() => insertOrder.run('o3', 'paid', '2026-11-05', 101, now, now), /UNIQUE/, 'token unique per day');
  assert.throws(() => db.prepare(
    "INSERT INTO orders (id, session_id, status, created_at, updated_at) VALUES ('o5', 'no-such-session', 'draft', ?, ?)"
  ).run(now, now), /FOREIGN KEY/, 'orders must belong to a real session');

  const pay = db.prepare(`INSERT INTO payments (id, order_id, amount_paise, status, txn_id, created_at, updated_at) VALUES (?, 'o1', ?, 'success', ?, ?, ?)`);
  pay.run('p1', 500, 'TXN1', now, now);
  assert.throws(() => pay.run('p2', 500, 'TXN1', now, now), /UNIQUE/, 'Paytm TXNID cannot be replayed');
  assert.throws(() => pay.run('p3', 0, 'TXN3', now, now), /CHECK/, 'amount must be positive');
  db.close();
});
