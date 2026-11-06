// End-to-end: real Chromium against the real server + mock Paytm (no real money, no internet).
// Setup once:  npx playwright-core install chromium
// Run:         npm run e2e        (screenshots go to $E2E_SHOTS or the OS temp dir)
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const SRV = path.resolve(__dirname, '..');
const { chromium, devices } = require('playwright-core');
const { loadConfig } = require(`${SRV}/src/config/env`);
const { openDatabase } = require(`${SRV}/src/db`);
const { createApp } = require(`${SRV}/src/app`);
const { createLogger } = require(`${SRV}/src/lib/logger`);
const { startPaytmMock } = require(`${SRV}/test/paytmMock`);
const { makePdf } = require(`${SRV}/test/fixtures`);
const SHOTS = process.env.E2E_SHOTS || path.join(os.tmpdir(), 'qp-e2e-shots');
fs.mkdirSync(SHOTS, { recursive: true });

const PORT = 3456, BASE = `http://127.0.0.1:${PORT}`;
const problems = [];
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch (e) { /* retry */ } await new Promise((r) => setTimeout(r, 100)); }
  return false;
}
const check = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) problems.push(msg); };

(async () => {
  const mock = await startPaytmMock();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-e2e-'));
  const config = loadConfig({ NODE_ENV: 'test', QP_DATA_DIR: dataDir, QP_PUBLIC_ORIGIN: BASE, QP_ADMIN_ORIGIN: 'http://localhost:3999',
    PAYTM_MID: mock.mid, PAYTM_MERCHANT_KEY: mock.key, PAYTM_HOST: mock.host, QP_RATE_LIMIT_PER_MIN: '1000' });
  fs.mkdirSync(config.filesDir, { recursive: true });
  const db = openDatabase(config.dbPath);
  const app = createApp({ config, db, logger: createLogger({ level: 'silent' }) });
  const server = await new Promise((r) => { const s = app.listen(PORT, '127.0.0.1', () => r(s)); });
  const pdfPath = path.join(dataDir, 'notes.pdf');
  fs.writeFileSync(pdfPath, await makePdf(3));

  const browser = await chromium.launch();
  const watchErrors = (page, label) => {
    page.on('pageerror', (e) => problems.push(`${label} page error: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`${label} console: ${m.text()}`); });
  };

  /* ---------- Android phone: full flow ---------- */
  const android = await browser.newContext({ ...devices['Pixel 7'] });
  const p = await android.newPage();
  watchErrors(p, 'android');
  await p.goto(BASE);
  check(await p.textContent('#navShop') === 'Quick Print Xerox', 'shop name from the server');
  await p.setInputFiles('#fileIn', pdfPath);
  await p.waitForSelector('.fcard .m', { timeout: 15000 });
  check((await p.textContent('.fcard .m')).includes('3 pages'), 'server page count shown (3 pages)');
  check(await until(async () => (await p.$('.fcard .thumb img')) !== null), 'thumbnail rendered by self-hosted pdf.js under the strict CSP');
  await p.click('.fcard [data-a="view"]');
  check(await until(async () => (await p.$$('#vpages canvas')).length >= 1), 'preview viewer renders the server PDF');
  check((await p.textContent('#vsub')) === '3 pages', 'viewer shows all 3 pages');
  await p.click('#vclose');
  await until(async () => (await p.textContent('#dockTotal')) === '₹9');
  check(await p.textContent('#dockTotal') === '₹9', `B&W one side: 3 x ₹3 = ₹9 (got ${await p.textContent('#dockTotal')})`);
  await p.click('.fcard [data-a="col"]');
  await p.click('.fcard [data-a="two"]');
  await until(async () => (await p.textContent('#dockTotal')) === '₹36');
  check(await p.textContent('#dockTotal') === '₹36', `colour both sides: 2 sheets x ₹18 = ₹36 (got ${await p.textContent('#dockTotal')})`);
  await p.screenshot({ path: path.join(SHOTS, '1-android-settings.png'), fullPage: true });

  await until(async () => p.isEnabled('#pay'));
  await p.click('#pay');
  await p.waitForSelector('#paySheet:not(.hide)', { timeout: 10000 });
  const upi = await p.getAttribute('#payOptions a.btn', 'href');
  check(/^upi:\/\/pay\?/.test(upi || ''), 'Android shows a single "any UPI app" intent link');
  check((await p.textContent('#sheetAmt')) === '₹36', 'pay sheet shows the frozen amount');
  await p.screenshot({ path: path.join(SHOTS, '2-android-pay.png') });

  // Customer pays in the UPI app; Paytm notifies the server.
  const payment = db.prepare('SELECT id FROM payments ORDER BY created_at DESC LIMIT 1').pluck().get();
  mock.setStatus(payment, 'TXN_SUCCESS');
  await fetch(`${BASE}/api/payments/paytm/webhook`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(mock.callbackParams(payment)) });
  await p.waitForSelector('#pOrder:not(.hide)', { timeout: 15000 });
  const token = (await p.textContent('#tk')).trim();
  const pin = (await p.textContent('#pin')).trim();
  check(token === 'XR-101', `token page shows XR-101 (got ${token})`);
  check(/^\d{4}$/.test(pin), 'pickup PIN shown');
  check((await p.textContent('#tAmount')) === '₹36', 'ticket total');
  check(/Estimated ready in about \d+ minute/.test(await p.textContent('#fTime')), `ETA shown: ${await p.textContent('#fTime')}`);
  await p.screenshot({ path: path.join(SHOTS, '3-android-ticket.png'), fullPage: true });

  // Tab closed / browser killed: come back to the site.
  await p.close();
  const back = await android.newPage();
  watchErrors(back, 'android-return');
  await back.goto(BASE);
  await back.waitForSelector('#pOrder:not(.hide)', { timeout: 10000 });
  check((await back.textContent('#tk')).trim() === token, 'returning visitor sees the same order');

  // Shop marks it ready: the page updates live.
  db.prepare("UPDATE orders SET status = 'ready', ready_at = ? WHERE token_no = 101").run(new Date().toISOString());
  app.locals.bus.emit('order', db.prepare('SELECT id FROM orders WHERE token_no = 101').pluck().get());
  await until(async () => /Ready for pickup/.test(await back.textContent('#fTime')), 10000);
  check(/Ready for pickup/.test(await back.textContent('#fTime')), 'live update: ready for pickup without reload');

  /* ---------- different browser: find my order ---------- */
  const other = await browser.newContext({ ...devices['iPhone 13'] });
  const o = await other.newPage();
  watchErrors(o, 'recover');
  await o.goto(BASE);
  await o.click('#findBtn');
  await o.fill('#findToken', token);
  await o.fill('#findPin', pin);
  await o.click('#findForm button[type=submit]');
  await o.waitForSelector('#pOrder:not(.hide)', { timeout: 10000 });
  check((await o.textContent('#tk')).trim() === token, 'token + PIN recovers the order in another browser');

  /* ---------- iPhone: app buttons ---------- */
  const iphone = await browser.newContext({ ...devices['iPhone 13'] });
  const ip = await iphone.newPage();
  watchErrors(ip, 'iphone');
  await ip.goto(BASE);
  await ip.setInputFiles('#fileIn', pdfPath);
  await ip.waitForSelector('.fcard .m', { timeout: 15000 });
  await until(async () => ip.isEnabled('#pay'));
  await ip.click('#pay');
  await ip.waitForSelector('#paySheet:not(.hide)', { timeout: 10000 });
  const apps = await ip.$$eval('#payOptions .appbtn', (as) => as.map((a) => [a.textContent, a.getAttribute('href').split('?')[0]]));
  check(apps.length === 4 && apps[0][1] === 'gpay://upi/pay', `iPhone shows UPI app buttons: ${apps.map((a) => a[0]).join(', ')}`);
  await ip.screenshot({ path: path.join(SHOTS, '4-iphone-pay.png') });
  // Change order: back to editing after Paytm confirms unpaid.
  await ip.click('#payEdit');
  await ip.waitForSelector('#paySheet.hide', { state: 'attached', timeout: 10000 });
  await ip.waitForSelector('.fcard .m', { timeout: 10000 });
  check(!(await ip.isHidden('#pPrint')), '"Change my order" returns to editing');

  /* ---------- desktop: QR ---------- */
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const dp = await desktop.newPage();
  watchErrors(dp, 'desktop');
  await dp.goto(BASE);
  await dp.setInputFiles('#fileIn', pdfPath);
  await dp.waitForSelector('.fcard .m', { timeout: 15000 });
  await until(async () => dp.isEnabled('#pay'));
  await dp.click('#pay');
  await dp.waitForSelector('#paySheet:not(.hide)', { timeout: 10000 });
  check(await dp.$('#payOptions .qrbox svg') !== null, 'desktop shows a UPI QR code');
  await dp.screenshot({ path: path.join(SHOTS, '5-desktop-pay.png') });

  /* ---------- preview renders with self-hosted pdf.js ---------- */
  await dp.click('#paySheet', { position: { x: 5, y: 5 } }).catch(() => {});
  await dp.click('#payEdit').catch(() => {});

  await browser.close();
  app.locals.hub.close(); server.closeAllConnections(); server.close();
  await app.locals.shutdown(); db.close(); await mock.close();
  console.log(problems.length ? `\n${problems.length} problem(s):\n- ${problems.join('\n- ')}` : '\nALL CHECKS PASSED');
  process.exit(problems.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
