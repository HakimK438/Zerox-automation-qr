'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers');

test('health and readiness', async (t) => {
  const app = await startTestApp();
  t.after(app.close);
  const h = await fetch(`${app.base}/api/health`);
  assert.equal(h.status, 200);
  assert.deepEqual(await h.json(), { ok: true });
  const r = await fetch(`${app.base}/api/ready`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, database: 'ok', storage: 'ok' });
});

test('security headers on API responses', async (t) => {
  const app = await startTestApp();
  t.after(app.close);
  const res = await fetch(`${app.base}/api/health`);
  assert.equal(res.headers.get('x-powered-by'), null);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('referrer-policy'), 'same-origin');
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.ok(res.headers.get('x-request-id'));
  assert.equal(res.headers.get('access-control-allow-origin'), null, 'no CORS granted');
});

test('unknown API routes return JSON 404', async (t) => {
  const app = await startTestApp();
  t.after(app.close);
  const res = await fetch(`${app.base}/api/sessions/some-id`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.code, 'not_found');
});

test('origin guard blocks cross-site state changes, allows our own origins', async (t) => {
  const app = await startTestApp();
  t.after(app.close);
  const post = (headers) => fetch(`${app.base}/api/anything`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });

  assert.equal((await post({ origin: 'https://evil.example' })).status, 403);
  assert.equal((await post({ origin: 'null' })).status, 403, "the 'null' origin is never trusted");
  assert.equal((await post({ 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await post({ origin: 'http://localhost:3000' })).status, 404, 'public origin passes the guard');
  assert.equal((await post({ origin: 'http://127.0.0.1:3001' })).status, 404, 'admin origin passes the guard');
  // Paytm posts the customer back cross-site; that path is verified by checksum instead.
  const paytm = await fetch(`${app.base}/api/payments/paytm/callback`, { method: 'POST', headers: { origin: 'https://securegw.paytm.in' }, redirect: 'manual' });
  assert.equal(paytm.status, 303, 'reaches the handler (which verifies by checksum + Status API)');
});

async function hit(base, n, xff) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const res = await fetch(`${base}/api/health`, { headers: { 'x-forwarded-for': xff(i) } });
    out.push(res.status);
  }
  return out;
}

test('rate limit: spoofed X-Forwarded-For is ignored when no proxy is trusted', async (t) => {
  const app = await startTestApp({ QP_RATE_LIMIT_PER_MIN: '5', QP_TRUST_PROXY: 'false' });
  t.after(app.close);
  const statuses = await hit(app.base, 8, (i) => `203.0.113.${i}`);
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429, 429, 429]);
});

test('rate limit: behind the local proxy only the hop the proxy saw counts', async (t) => {
  // The test client connects from loopback, i.e. it plays the role of Caddy. Caddy appends the
  // real client address as the right-most XFF entry; anything to its left is client-forged.
  const app = await startTestApp({ QP_RATE_LIMIT_PER_MIN: '5', QP_TRUST_PROXY: 'loopback' });
  t.after(app.close);
  const statuses = await hit(app.base, 8, (i) => `203.0.113.${i}, 198.51.100.7`);
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429, 429, 429]);
});

test('config: trusting every proxy is refused', () => {
  const { loadConfig } = require('../src/config/env');
  assert.throws(() => loadConfig({ QP_TRUST_PROXY: 'true' }), /spoof/);
});

test('body limits and malformed JSON', async (t) => {
  const app = await startTestApp();
  t.after(app.close);
  const headers = { 'content-type': 'application/json', origin: 'http://localhost:3000' };
  const bad = await fetch(`${app.base}/api/x`, { method: 'POST', headers, body: '{not json' });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, 'bad_request');
  const big = await fetch(`${app.base}/api/x`, { method: 'POST', headers, body: JSON.stringify({ a: 'x'.repeat(200 * 1024) }) });
  assert.equal(big.status, 413);
});
