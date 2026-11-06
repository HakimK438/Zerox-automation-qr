'use strict';
/* Development only: gives you a working owner login and a dashboard with something on it.
     1. creates the test owner and saves the login in data/dev-login.json (data/ is not in git)
     2. fills the shop details with clearly fake sample values
     3. places three test orders through the normal API (upload, price, checkout, test payment)
   The login page fills itself from that file, on this computer only (see GET /api/admin/dev-login).
   Refuses to run in production. The dev server must be running. Usage: npm run dev:account */
if (process.env.NODE_ENV === 'production') {
  console.error('dev-test-account refuses to run with NODE_ENV=production.');
  process.exit(1);
}
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('../src/config/env');
const { openDatabase } = require('../src/db');
const { createSecretBox } = require('../src/lib/secretBox');
const { createAdminAuth } = require('../src/modules/admin/auth');
const { totp } = require('../src/lib/totp');
const { makePdf } = require('../test/fixtures');

const USERNAME = 'testowner';
const PASSWORD = '1234'; // test account on this computer only; real accounts need 12+ characters
const SHOP = { address: 'Sample Road, Test Nagar (test data)', phone: '00000 00000' };
const ORDERS = [
  { name: 'class-notes.pdf', pages: 4, color: false, duplex: false, copies: 1 },
  { name: 'project-report.pdf', pages: 6, color: true, duplex: true, copies: 2 },
  { name: 'id-proof.pdf', pages: 2, color: false, duplex: false, copies: 3 }
];

const config = loadConfig();
if (!config.testPayments) { console.error('Payments are not in test mode, so this script will not place orders.'); process.exit(1); }
const SHOP_URL = config.publicOrigin;
const ADMIN_URL = config.adminOrigin;

function saveAccount() {
  const file = path.join(config.dataDir, 'dev-login.json');
  fs.mkdirSync(config.dataDir, { recursive: true });
  const db = openDatabase(config.dbPath);
  const auth = createAdminAuth({ db, secretBox: createSecretBox(config.dataKey), dataKey: config.dataKey });
  const exists = db.prepare('SELECT 1 FROM admin_users WHERE username = ?').get(USERNAME);
  const secret = (exists ? auth.resetUser({ username: USERNAME, password: PASSWORD }) : auth.createUser({ username: USERNAME, password: PASSWORD, role: 'owner' })).totpSecret;
  db.close();
  fs.writeFileSync(file, JSON.stringify({ username: USERNAME, password: PASSWORD, totpSecret: secret }), { mode: 0o600 });
  return secret;
}

async function json(res, what) {
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${what}: ${res.status} ${body?.error?.message || ''}`);
  return body;
}

async function placeOrder(spec) {
  const started = await fetch(`${SHOP_URL}/api/session`, { method: 'POST' });
  const cookie = started.headers.getSetCookie()[0].split(';')[0];
  const call = (url, method = 'GET', body) => fetch(`${SHOP_URL}${url}`, {
    method,
    headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const { orderId } = await json(await call('/api/orders', 'POST'), 'start order');
  const form = new FormData();
  form.append('file', new Blob([await makePdf(spec.pages)], { type: 'application/pdf' }), spec.name);
  const up = await json(await fetch(`${SHOP_URL}/api/orders/${orderId}/documents`, { method: 'POST', headers: { cookie }, body: form }), 'upload');
  const docUrl = `/api/orders/${orderId}/documents/${up.documentId}`;
  for (let i = 0; ; i += 1) {
    const doc = await json(await call(docUrl), 'document');
    if (doc.status === 'ready') break;
    if (doc.status === 'failed' || i > 40) throw new Error(`file not ready: ${doc.error}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  await json(await call(`${docUrl}/parts`, 'PUT', { copies: spec.copies, parts: [{ pages: 'all', color: spec.color, duplex: spec.duplex, paper: 'A4' }] }), 'settings');
  await json(await call(`/api/orders/${orderId}/checkout`, 'POST'), 'checkout');
  await json(await call(`/api/orders/${orderId}/payments`, 'POST'), 'start payment');
  await json(await call(`/api/orders/${orderId}/test-payment`, 'POST', { result: 'success' }), 'test payment');
  return orderId;
}

async function main() {
  const secret = saveAccount();
  try { await fetch(`${SHOP_URL}/api/health`); } catch {
    console.log('Test owner saved, but the server is not running. Start it with: npm run dev, then run this again.');
    return;
  }

  const login = await fetch(`${ADMIN_URL}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD, otp: totp(secret) })
  });
  await json(login, 'login');
  const cookie = login.headers.getSetCookie()[0].split(';')[0];
  const { csrfToken } = await json(await fetch(`${ADMIN_URL}/api/admin/session`, { headers: { cookie } }), 'session');
  const admin = (url, method = 'GET', body) => fetch(`${ADMIN_URL}${url}`, {
    method,
    headers: { cookie, 'x-csrf-token': csrfToken, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });

  const settings = await json(await admin('/api/admin/settings'), 'settings');
  await json(await admin('/api/admin/settings/shop', 'PUT', { value: { ...settings.shop, ...SHOP } }), 'shop details');

  const { orders } = await json(await admin('/api/admin/orders?view=today'), 'orders');
  if (orders.length) console.log(`Today already has ${orders.length} order(s), so no new sample orders were added.`);
  else {
    for (const spec of ORDERS) await placeOrder(spec); // the demo printer prints them
    console.log(`Placed ${ORDERS.length} test orders.`);
  }
  console.log(`\nOpen ${ADMIN_URL} and press "Log in": the form fills itself.`);
  console.log(`  Username: ${USERNAME}\n  Password: ${PASSWORD}`);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
