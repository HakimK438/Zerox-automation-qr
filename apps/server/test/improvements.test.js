'use strict';
/* Test payment mode, the dev login helper, English/Hindi text, and Office upload handling. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { startTestApp } = require('./helpers');
const { api, newCustomer, addPdf } = require('./fixtures');
const { loadConfig, findSoffice } = require('../src/config/env');
const { totp, verifyTotp } = require('../src/lib/totp');
const { officeConverterAvailable } = require('../src/modules/documents/converters');
const { sniffUpload } = require('../src/modules/documents/sniff');

const REPO = path.resolve(__dirname, '../../..');
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const PROD = {
  NODE_ENV: 'production', QP_PUBLIC_ORIGIN: 'https://print.example.com', QP_ADMIN_ORIGIN: 'https://admin.example.com',
  QP_DATA_KEY: Buffer.alloc(32, 1).toString('base64'), PAYTM_MID: 'MID1', PAYTM_MERCHANT_KEY: '1234567890123456'
};

async function testShop(t) {
  const ctx = await startTestApp({ QP_PAYMENT_MODE: 'test' });
  t.after(() => ctx.close());
  const c = await newCustomer(ctx.base);
  await addPdf(ctx, c, 2);
  assert.equal((await c.call(`/api/orders/${c.orderId}/checkout`, { method: 'POST' })).status, 200);
  const started = await (await c.call(`/api/orders/${c.orderId}/payments`, { method: 'POST' })).json();
  const press = (result) => c.call(`/api/orders/${c.orderId}/test-payment`, { method: 'POST', body: { result } });
  return { ctx, c, started, press };
}

/* ---------- test payment mode ---------- */

test('test payments can never be switched on in production', () => {
  assert.throws(() => loadConfig({ ...PROD, QP_PAYMENT_MODE: 'test' }), /not allowed in production/);
  assert.equal(loadConfig(PROD).testPayments, false);
});

test('test mode is the default only in development without Paytm keys', () => {
  assert.equal(loadConfig({ NODE_ENV: 'development' }).testPayments, true);
  assert.equal(loadConfig({ NODE_ENV: 'development', PAYTM_MID: 'MID1', PAYTM_MERCHANT_KEY: '1234567890123456' }).testPayments, false);
  assert.equal(loadConfig({ NODE_ENV: 'test' }).testPayments, false);
});

test('the test-payment route does not exist outside test mode', async (t) => {
  const ctx = await startTestApp();
  t.after(() => ctx.close());
  const c = await newCustomer(ctx.base);
  const r = await c.call(`/api/orders/${c.orderId}/test-payment`, { method: 'POST', body: { result: 'success' } });
  assert.equal(r.status, 404);
  assert.equal((await (await api(ctx.base)('/api/shop')).json()).testPayments, undefined);
});

test('successful test payment goes through normal verification: token, PIN, marked TEST', async (t) => {
  const { ctx, c, started, press } = await testShop(t);
  assert.equal(started.testMode, true);
  assert.equal(started.deepLink, undefined);
  assert.equal(started.txnToken, undefined);
  assert.equal((await (await api(ctx.base)('/api/shop')).json()).testPayments, true);

  const r = await press('success');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).outcome, 'paid');
  const order = await (await c.call(`/api/orders/${c.orderId}`)).json();
  assert.equal(order.status, 'paid');
  assert.match(order.token, /^XR-\d+$/);
  assert.match(order.pickupPin, /^\d{4}$/);
  const pay = ctx.db.prepare('SELECT status, payment_mode, amount_paise FROM payments').get();
  assert.deepEqual({ ...pay }, { status: 'success', payment_mode: 'TEST', amount_paise: 600 });
  const event = ctx.db.prepare("SELECT reason FROM order_events WHERE to_status = 'paid'").get();
  assert.equal(event.reason, 'payment_verified');
  assert.equal((await press('success')).status, 409, 'a used payment cannot be pressed again');
});

test('failed test payment leaves the order unpaid and a new attempt can succeed', async (t) => {
  const { c, press } = await testShop(t);
  assert.equal((await (await press('fail')).json()).outcome, 'failed');
  assert.equal((await (await c.call(`/api/orders/${c.orderId}`)).json()).status, 'awaiting_payment');
  assert.equal((await press('success')).status, 409, 'nothing is waiting until a new attempt starts');
  await c.call(`/api/orders/${c.orderId}/payments`, { method: 'POST' });
  assert.equal((await (await press('success')).json()).outcome, 'paid');
});

test('another browser cannot press the test button on my order', async (t) => {
  const { ctx, c } = await testShop(t);
  const stranger = await newCustomer(ctx.base);
  const r = await stranger.call(`/api/orders/${c.orderId}/test-payment`, { method: 'POST', body: { result: 'success' } });
  assert.equal(r.status, 404);
  assert.equal(ctx.db.prepare('SELECT status FROM orders WHERE id = ?').pluck().get(c.orderId), 'awaiting_payment');
});

test('test refund finishes through the reconciler', async (t) => {
  const { ctx, c, press } = await testShop(t);
  await press('success');
  const { payments, adminAuth } = ctx.app.locals;
  const { id } = adminAuth.createUser({ username: 'owner1', password: 'long-enough-password', role: 'owner' });
  await payments.requestRefund({ orderId: c.orderId, reason: 'test', adminId: id });
  await payments.reconcile();
  assert.equal(ctx.db.prepare('SELECT status FROM orders WHERE id = ?').pluck().get(c.orderId), 'refunded');
});

/* ---------- demo printer ---------- */

test('demo printer prints a paid order through the real queue and the order becomes ready', async (t) => {
  const { ctx, c, press } = await testShop(t);
  const demo = ctx.app.locals.demoPrinter;
  demo.setSpeed(5);
  assert.equal(demo.on().on, true);
  await press('success');
  let status;
  for (let i = 0; i < 100; i += 1) {
    status = ctx.db.prepare('SELECT status FROM orders WHERE id = ?').pluck().get(c.orderId);
    if (status === 'ready') break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(status, 'ready');
  const job = ctx.db.prepare('SELECT status, download_used_at FROM print_jobs WHERE order_id = ?').get(c.orderId);
  assert.equal(job.status, 'printed');
  assert.ok(job.download_used_at, 'the file was fetched once, like a real agent');
  assert.match(demo.state().lastDone, /^XR-/);
  assert.equal(demo.off().on, false);
  assert.equal(ctx.app.locals.agents.usablePrinters().length, 0, 'off means no printer is available');
});

test('switching the demo printer off mid-job shows a problem instead of losing the order', async (t) => {
  const { ctx, c, press } = await testShop(t);
  const demo = ctx.app.locals.demoPrinter;
  demo.setSpeed(5000);
  demo.on();
  await press('success');
  for (let i = 0; i < 100 && !demo.state().printing; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.ok(demo.state().printing);
  demo.off();
  assert.equal(ctx.db.prepare('SELECT status FROM orders WHERE id = ?').pluck().get(c.orderId), 'print_attention');
});

test('live mode has no demo printer at all', async (t) => {
  const ctx = await startTestApp();
  t.after(() => ctx.close());
  assert.equal(ctx.app.locals.demoPrinter, null);
});

/* ---------- dev login helper ---------- */

test('dev login answers only in test mode, from the file, with a usable code', async (t) => {
  const hostHeader = { headers: { host: '127.0.0.1:3001' } };
  const off = await startTestApp({ QP_ADMIN_ORIGIN: 'http://127.0.0.1:3001' });
  t.after(() => off.close());
  fs.writeFileSync(path.join(off.config.dataDir, 'dev-login.json'), '{"username":"u","password":"p","totpSecret":"JBSWY3DPEHPK3PXP"}');
  const adminFetch = (ctx) => new Promise((resolve, reject) => {
    const { port } = new URL(ctx.base);
    require('node:http').get({ port, host: '127.0.0.1', path: '/api/admin/dev-login', ...hostHeader }, (res) => {
      let body = ''; res.on('data', (d) => { body += d; }); res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
  assert.equal((await adminFetch(off)).status, 204, 'live payment mode: silent');

  const on = await startTestApp({ QP_PAYMENT_MODE: 'test' });
  t.after(() => on.close());
  assert.equal((await adminFetch(on)).status, 204, 'no file: silent');
  fs.writeFileSync(path.join(on.config.dataDir, 'dev-login.json'), '{"username":"u","password":"p","totpSecret":"JBSWY3DPEHPK3PXP"}');
  const r = await adminFetch(on);
  const login = JSON.parse(r.body);
  assert.equal(r.status, 200);
  assert.equal(login.username, 'u');
  assert.ok(verifyTotp('JBSWY3DPEHPK3PXP', login.otp, { afterStep: Math.floor(Date.now() / 30000) }), 'the code is still unused after the current step');
  assert.notEqual(login.otp, totp('JBSWY3DPEHPK3PXP'));
});

test('the test account and demo scripts refuse production', () => {
  for (const f of ['dev-test-account.js', 'demo-show.js']) {
    assert.match(read(`apps/server/scripts/${f}`), /NODE_ENV === 'production'[\s\S]{0,120}process\.exit\(1\)/, f);
  }
});

/* ---------- Word and PowerPoint ---------- */

test('LibreOffice is found in its Windows folder; other settings are left alone', () => {
  assert.equal(findSoffice('soffice', 'linux'), 'soffice');
  assert.equal(findSoffice('/opt/lo/soffice', 'win32'), '/opt/lo/soffice');
  assert.equal(officeConverterAvailable('/nonexistent/soffice'), false);
  assert.equal(officeConverterAvailable('soffice', { PATH: '' }), false);
});

test('renamed Office files are read by their content; other files are still refused', async (t) => {
  const yazl = require('yazl');
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'qp-sniff-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const zip = await new Promise((resolve) => {
    const z = new yazl.ZipFile(); const out = [];
    z.addBuffer(Buffer.from('<x/>'), 'word/document.xml');
    z.outputStream.on('data', (d) => out.push(d)); z.outputStream.on('end', () => resolve(Buffer.concat(out)));
    z.end();
  });
  const docxBytes = path.join(dir, 'a'); fs.writeFileSync(docxBytes, zip);
  const docBytes = path.join(dir, 'b'); fs.writeFileSync(docBytes, Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(600)]));
  const fake = path.join(dir, 'c'); fs.writeFileSync(fake, 'MZ not a document');
  const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  assert.equal((await sniffUpload(docxBytes, 'letter.doc', 'application/msword')).mime, DOCX);
  assert.equal((await sniffUpload(docBytes, 'letter.docx', DOCX)).mime, 'application/msword');
  assert.equal((await sniffUpload(docxBytes, 'letter.docx', 'application/zip')).mime, DOCX, 'phones may call a .docx a zip');
  await assert.rejects(sniffUpload(fake, 'letter.docx', DOCX), /doesn't match/);
  await assert.rejects(sniffUpload(docxBytes, 'letter.docx', 'text/plain'), /doesn't match/);
});

/* ---------- English and Hindi ---------- */

function loadHindi(app) {
  const window = {};
  vm.runInNewContext(read(`apps/${app}/i18n-hi.js`), { window });
  return window;
}
const hindi = { web: loadHindi('web'), admin: loadHindi('admin') };

/** Every English sentence written in code: t('...') and N('...'). */
function codeStrings(file) {
  const out = new Set();
  for (const m of read(file).matchAll(/\b[tN]\(\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g)) out.add(vm.runInNewContext(m[1]));
  for (const m of read(file).matchAll(/\bt\(([^()]*\?[^()]*:[^()]*)\)/g)) { // t(a ? 'x' : 'y')
    for (const s of m[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)) if (!['sheet', 'manual', 'ready', 'color', 'mixed', 'owner', 'attention', 'queue'].includes(s[1])) out.add(s[1]);
  }
  return [...out];
}

/** Visible text and attributes in a static page. */
function htmlStrings(file) {
  const body = read(file).split('<body')[1].replace(/<script[\s\S]*?<\/script>/g, '').replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<code>[\s\S]*?<\/code>/g, '<x>');
  const out = new Set();
  for (const m of body.matchAll(/>([^<>]+)</g)) {
    const s = m[1].trim().replace(/&amp;/g, '&').replace(/&#\d+;/g, '');
    if (/[A-Za-z]{3}/.test(s)) out.add(s);
  }
  for (const m of body.matchAll(/\s(?:placeholder|aria-label|title)="([^"]+)"/g)) if (/[A-Za-z]{3}/.test(m[1])) out.add(m[1].replace(/&amp;/g, '&'));
  return [...out];
}

const LEAVE_ENGLISH = new Set(['DOC / DOCX', 'PPT / PPTX', 'JPG / PNG', 'XR-105', 'PDF', 'Xerox Center', 'Xerox Print System']);

for (const [app, files] of [['web', ['apps/web/customer.js', 'apps/web/index.html']], ['admin', ['apps/admin/owner.js', 'apps/admin/login.js', 'apps/admin/owner.html', 'apps/admin/login.html']]]) {
  test(`every ${app} sentence has a Hindi line`, () => {
    const missing = [];
    for (const f of files) {
      for (const s of f.endsWith('.html') ? htmlStrings(f) : codeStrings(f)) {
        if (!LEAVE_ENGLISH.has(s) && hindi[app].QP_HI[s] === undefined) missing.push(`${f}: ${s}`);
      }
    }
    assert.deepEqual(missing, []);
  });
}

test('counting words used by plural() have Hindi lines', () => {
  for (const w of ['page', 'pages', 'file', 'files', 'copy', 'copies', 'order', 'orders', 'minute', 'minutes']) assert.ok(hindi.web.QP_HI[`{n} ${w}`], w);
  for (const w of ['page', 'pages', 'file', 'files', 'copy', 'copies', 'order', 'orders']) assert.ok(hindi.admin.QP_HI[`{n} ${w}`], w);
});

test('fixed messages from the server have Hindi lines', () => {
  const dirs = ['documents', 'orders', 'payments', 'sessions', 'pricing'].map((d) => `apps/server/src/modules/${d}`);
  const files = [...dirs.flatMap((d) => fs.readdirSync(path.join(REPO, d)).filter((f) => f.endsWith('.js')).map((f) => `${d}/${f}`)), 'apps/server/src/middleware/customerSession.js', 'apps/server/src/middleware/errorHandler.js'];
  const missing = [];
  const call = /(?:\b(?:ConversionError|RangeError_|badRequest|conflict|notFound|tooMany|unauthorized)\(|HttpError\(\d+, '\w+',)\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;
  const named = /(?:UNSUPPORTED|MISMATCH|GENERIC_FAILURE) = ('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;
  for (const f of files) {
    const src = read(f);
    for (const m of [...src.matchAll(call), ...src.matchAll(named)]) {
      const s = vm.runInNewContext(m[1]);
      if (hindi.web.QP_HI[s] === undefined && hindi.admin.QP_HI[s] === undefined) missing.push(`${f}: ${s}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('order status labels and messages with numbers are translated', () => {
  const { STATUS_LABEL } = require('../../../shared/constants');
  for (const label of Object.values(STATUS_LABEL)) assert.ok(hindi.web.QP_HI[label], label);
  const samples = [
    'File is larger than 25 MB.', 'You can add up to 10 files per order.', 'Copies must be between 1 and 50.',
    'You can split a document into at most 5 parts.', 'This document has 900 pages; the limit is 500. Please split it into smaller files.',
    'This document has 1 page; use page numbers from 1 to 1.', '"abc" is not a page number or range.', '"5-2" goes backwards. Write it as 2-5.'
  ];
  for (const s of samples) assert.ok(hindi.web.QP_HI_PATTERNS.some(([re]) => re.test(s)), s);
});

test('both sites use the same language code, and Hindi lines keep their {placeholders}', () => {
  assert.equal(read('apps/web/i18n-core.js').replace(/\r\n/g, '\n'), read('apps/admin/i18n-core.js').replace(/\r\n/g, '\n'));
  for (const { QP_HI } of Object.values(hindi)) {
    for (const [en, hi] of Object.entries(QP_HI)) {
      const need = (en.match(/\{\w+\}/g) || []).sort().join();
      assert.equal((hi.match(/\{\w+\}/g) || []).sort().join(), need, en);
    }
  }
});
