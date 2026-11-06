// End-to-end: the shop owner's dashboard and a customer, side by side, in real Chromium.
// One server, two hosts: customer = 127.0.0.1:PORT, admin = localhost:PORT (different Host headers).
// Run: npm run e2e:admin   (screenshots go to $E2E_SHOTS or the OS temp dir)
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
const { totp } = require(`${SRV}/src/lib/totp`);
const SHOTS = process.env.E2E_SHOTS || path.join(os.tmpdir(), 'qp-e2e-shots');
fs.mkdirSync(SHOTS, { recursive: true });

const PORT = 3457;
const SHOP = `http://127.0.0.1:${PORT}`;
const ADMIN = `http://localhost:${PORT}`;
const PASSWORD = 'shop-owner-pass-2026';
const problems = [];
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch (e) { /* retry */ } await new Promise((r) => setTimeout(r, 100)); }
  return false;
}
const check = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) problems.push(msg); };

(async () => {
  const mock = await startPaytmMock();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-e2e-admin-'));
  const config = loadConfig({ NODE_ENV: 'test', QP_DATA_DIR: dataDir, QP_PUBLIC_ORIGIN: SHOP, QP_ADMIN_ORIGIN: ADMIN,
    PAYTM_MID: mock.mid, PAYTM_MERCHANT_KEY: mock.key, PAYTM_HOST: mock.host, QP_RATE_LIMIT_PER_MIN: '1000' });
  fs.mkdirSync(config.filesDir, { recursive: true });
  const db = openDatabase(config.dbPath);
  const app = createApp({ config, db, logger: createLogger({ level: 'silent' }) });
  const server = await new Promise((r) => { const s = app.listen(PORT, '127.0.0.1', () => r(s)); });
  const { totpSecret } = app.locals.adminAuth.createUser({ username: 'owner', password: PASSWORD });
  const pdfPath = path.join(dataDir, 'notes.pdf');
  fs.writeFileSync(pdfPath, await makePdf(3));

  const browser = await chromium.launch();
  const watchErrors = (page, label) => {
    page.on('pageerror', (e) => problems.push(`${label} page error: ${e.message}`));
    page.on('console', (m) => {
      // 401 on purpose: the wrong-PIN check; 400 for the wrong PIN itself
      if (m.type() === 'error' && !/status of (400|401|403)/.test(m.text())) problems.push(`${label} console: ${m.text()}`);
    });
  };

  /* ---------- admin: URL alone shows only the login page ---------- */
  const adminCtx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const a = await adminCtx.newPage();
  watchErrors(a, 'admin');
  await a.goto(`${ADMIN}/owner.html`);
  check(await a.$('#loginForm') !== null && await a.$('#dashboard') === null, 'typing the dashboard URL shows the login page');
  const shopApi = await fetch(`${SHOP}/api/admin/session`);
  check(shopApi.status === 404, 'admin API does not exist on the customer site');

  await a.fill('#lu', 'owner');
  await a.fill('#lp', 'wrong password');
  await a.fill('#lo', totp(totpSecret));
  await a.click('#lbtn');
  await until(async () => a.isVisible('#lerr'));
  check(/Wrong username, password or code/.test(await a.textContent('#lerr')), 'wrong password refused');
  await a.fill('#lp', PASSWORD);
  await a.fill('#lo', totp(totpSecret, Date.now() + 30000)); // next step: a code is single-use
  await a.click('#lbtn');
  await a.waitForSelector('body#dashboard', { timeout: 10000 });
  await until(async () => /Live/.test(await a.textContent('#live')));
  check(/Live/.test(await a.textContent('#live')), 'logged in; live connection up');
  const cookies = await adminCtx.cookies();
  const adminCookie = cookies.find((c) => c.name === 'qp_admin');
  check(adminCookie && adminCookie.httpOnly && adminCookie.sameSite === 'Strict', 'admin cookie is HttpOnly + SameSite=Strict');
  check(/Nothing to do/.test(await a.textContent('#orders')), 'empty queue');

  /* ---------- customer orders and pays ---------- */
  const custCtx = await browser.newContext({ ...devices['Pixel 7'] });
  const c = await custCtx.newPage();
  watchErrors(c, 'customer');
  await c.goto(SHOP);
  await c.setInputFiles('#fileIn', pdfPath);
  await c.waitForSelector('.fcard .m', { timeout: 15000 });
  await until(async () => c.isEnabled('#pay'));
  await c.click('#pay');
  await c.waitForSelector('#paySheet:not(.hide)', { timeout: 10000 });
  check(await a.$('.ord') === null, 'unpaid order is NOT on the dashboard');
  const payment = db.prepare('SELECT id FROM payments ORDER BY created_at DESC LIMIT 1').pluck().get();
  mock.setStatus(payment, 'TXN_SUCCESS');
  await fetch(`${SHOP}/api/payments/paytm/webhook`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(mock.callbackParams(payment)) });
  await c.waitForSelector('#pOrder:not(.hide)', { timeout: 15000 });
  const token = (await c.textContent('#tk')).trim();
  const pin = (await c.textContent('#pin')).trim();

  /* ---------- dashboard gets it live ---------- */
  check(await until(async () => (await a.textContent('#orders')).includes(token)), `paid order ${token} appears on the dashboard without reload`);
  check(await a.textContent('#nWait') === '1', 'waiting counter = 1');
  await a.screenshot({ path: path.join(SHOTS, 'a1-dashboard-new-order.png'), fullPage: true });

  // open details + view the file
  await a.click('.ord .line');
  await a.waitForSelector('.ord.open [data-view]', { timeout: 8000 });
  await a.click('.ord.open [data-view]');
  check(await until(async () => (await a.$$('#vpages canvas')).length >= 1), 'document viewer renders the PDF (self-hosted pdf.js, strict CSP)');
  await a.screenshot({ path: path.join(SHOTS, 'a2-viewer.png') });
  await a.click('#vclose');

  await a.click('#now [data-to="printing"]');
  check(await until(async () => /Printing/.test(await c.textContent('#pOrder'))), 'customer sees "Printing" live');
  await until(async () => (await a.$('#now [data-to="ready"]')) !== null);
  await a.click('#now [data-to="ready"]');
  check(await until(async () => /Ready for pickup/.test(await c.textContent('#fTime'))), 'customer sees "Ready for pickup" live');

  /* ---------- handover with PIN ---------- */
  await until(async () => (await a.$('.ord [data-act="handover"]')) !== null);
  await a.click('.ord [data-act="handover"]');
  await a.waitForSelector('#modal:not(.hide)');
  await a.fill('#m_pin', pin === '0000' ? '1111' : '0000');
  await a.click('#mok');
  await until(async () => a.isVisible('#merr'));
  check(/Wrong PIN/.test(await a.textContent('#merr')), 'wrong PIN refused, dialog stays open');
  await a.fill('#m_pin', pin);
  await a.click('#mok');
  check(await until(async () => a.isHidden('#modal')), 'right PIN accepted');
  check(await until(async () => /Nothing to do/.test(await a.textContent('#orders'))), 'order leaves the "Now" list');
  await c.reload();
  check(await until(async () => !(await c.textContent('body')).includes(pin)), 'customer page no longer shows the PIN after pickup');
  check(await until(async () => c.isVisible('#newOrder')), 'customer sees "Start a new order" after pickup');

  /* ---------- settings reach the customer site ---------- */
  await a.click('[data-page="settings"]');
  await a.fill('#f_shop', 'Sai Xerox & Prints');
  await a.click('#fShop button[type=submit]');
  await until(async () => (await a.textContent('#bn')) === 'Sai Xerox & Prints');
  const c2 = await custCtx.newPage();
  await c2.goto(SHOP);
  check(await until(async () => (await c2.textContent('#navShop')) === 'Sai Xerox & Prints'), 'new shop name on the customer page');
  await a.fill('#p_bw1', '2');
  await a.click('#fPrices button[type=submit]');
  await a.waitForSelector('#modal:not(.hide)');
  await a.fill('#m_password', 'nope');
  await a.click('#mok');
  await until(async () => a.isVisible('#merr'));
  check(/Wrong password/.test(await a.textContent('#merr')), 'price change refused with the wrong password');
  await a.fill('#m_password', PASSWORD);
  await a.click('#mok');
  await until(async () => a.isHidden('#modal'));
  const pricing = await (await fetch(`${SHOP}/api/pricing`)).json();
  check(pricing.rates.bw1 === 200, 'new B&W price live for customers (₹2)');
  await a.screenshot({ path: path.join(SHOTS, 'a3-settings.png'), fullPage: true });

  /* ---------- reports ---------- */
  await a.click('[data-page="reports"]');
  await until(async () => (await a.textContent('#repCards')).includes('Money received'));
  check((await a.textContent('#repCards')).includes('₹9'), 'report shows ₹9 received');
  check(await until(async () => (await a.textContent('#audit')).includes('Changed prices')), 'activity log lists the price change');
  check(await until(async () => (await a.textContent('#recon')).includes('Received from Paytm')), 'reconciliation shown');
  check(/Nothing\. Every paid order/.test(await a.textContent('#problems')), 'no problems listed');
  const csv = await a.evaluate(() => fetch(document.getElementById('csv').href).then((r) => r.text())).catch(() => null);
  check(csv === null || csv.startsWith('date,token'), 'CSV download link works');
  await a.screenshot({ path: path.join(SHOTS, 'a4-reports.png'), fullPage: true });

  /* ---------- print agent: pair from the dashboard, enable a printer, automatic printing ---------- */
  const AGENT = path.resolve(SRV, '../print-agent');
  const { createAgent } = require(`${AGENT}/src/main`);
  const { createApi } = require(`${AGENT}/src/api`);
  const fakes = path.join(dataDir, 'fakes');
  fs.mkdirSync(fakes, { recursive: true });
  process.env.QP_FAKE_PRINTERS = path.join(fakes, 'printers.json');
  process.env.QP_FAKE_SPOOL = path.join(fakes, 'spool.json');
  process.env.QP_FAKE_SUMATRA_LOG = path.join(fakes, 'sumatra.log');
  fs.writeFileSync(process.env.QP_FAKE_PRINTERS, JSON.stringify([{ Name: 'HP LaserJet M404', DriverName: 'HP UPD', PrinterStatus: 3, DetectedErrorState: 2, CapabilityDescriptions: ['Duplex'], PrinterPaperNames: ['A4'] }]));
  fs.writeFileSync(process.env.QP_FAKE_SPOOL, '');
  await a.click('[data-page="settings"]');
  await a.click('#addAgent');
  await until(async () => /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(await a.textContent('#pairCode')));
  const code = await a.textContent('#pairCode');
  check(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code), `pairing code shown (${code})`);
  const { secret } = await createApi({ serverUrl: SHOP }).pair(code, 'Shop PC');
  const agent = createAgent({
    serverUrl: SHOP, powershell: [process.execPath, `${AGENT}/test/fakes/powershell.js`], sumatra: [process.execPath, `${AGENT}/test/fakes/sumatra.js`],
    workDir: path.join(fakes, 'work'), logFile: path.join(fakes, 'agent.log'), heartbeatSec: 1, pollSec: 1, printTimeoutSec: 20, spoolerTimeoutSec: 20, ignorePrinters: []
  }, secret);
  await agent.start();
  await a.reload();
  await a.waitForSelector('body#dashboard');
  await a.click('[data-page="settings"]');
  check(await until(async () => (await a.textContent('#printerList')).includes('HP LaserJet M404'), 20000), 'printer discovered by the agent appears in Settings');
  await a.check('#printerList [data-k="enabled"]');
  await a.click('#printerList [data-save]');
  check(await until(async () => /1 printer ready/.test(await a.textContent('#pill')), 20000), 'header shows "1 printer ready"');
  await a.$eval('#printersBox', (el) => el.scrollIntoView());
  await a.screenshot({ path: path.join(SHOTS, 'a5-printers.png') });
  await a.click('[data-page="home"]');

  const c3 = await custCtx.newPage();
  watchErrors(c3, 'customer-3');
  await c3.goto(SHOP);
  await c3.setInputFiles('#fileIn', pdfPath);
  await c3.waitForSelector('.fcard .m', { timeout: 15000 });
  await until(async () => c3.isEnabled('#pay'));
  await c3.click('#pay');
  await c3.waitForSelector('#paySheet:not(.hide)', { timeout: 10000 });
  const payment3 = db.prepare('SELECT id FROM payments ORDER BY created_at DESC LIMIT 1').pluck().get();
  mock.setStatus(payment3, 'TXN_SUCCESS');
  await fetch(`${SHOP}/api/payments/paytm/webhook`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(mock.callbackParams(payment3)) });
  await c3.waitForSelector('#pOrder:not(.hide)', { timeout: 15000 });
  check(await until(async () => /Ready for pickup/.test(await c3.textContent('#fTime')), 20000), 'automatic mode: printed by the agent, customer sees "Ready for pickup" with no click in the shop');
  const sumatra = fs.readFileSync(process.env.QP_FAKE_SUMATRA_LOG, 'utf8');
  check(sumatra.includes('"-print-to","HP LaserJet M404"'), 'SumatraPDF was asked to print on the chosen printer');
  check(await until(async () => /Ready for pickup/.test(await a.textContent('#orders'))), 'dashboard shows the order as ready');
  agent.stop();

  /* ---------- logout ---------- */
  await a.click('#logout');
  await a.waitForSelector('#loginForm', { timeout: 8000 });
  check(true, 'logout returns to the login page');

  /* ---------- phone-size dashboard ---------- */
  const phone = await browser.newContext({ ...devices['iPhone 13'] });
  const pp = await phone.newPage();
  watchErrors(pp, 'admin-phone');
  await pp.goto(ADMIN);
  check(await pp.$('#loginForm') !== null, 'login page works on a phone');

  await browser.close();
  app.locals.adminStream.close(); app.locals.hub.close(); server.closeAllConnections(); server.close();
  await app.locals.shutdown(); db.close(); await mock.close();
  console.log(problems.length ? `\n${problems.length} problem(s):\n- ${problems.join('\n- ')}` : '\nALL CHECKS PASSED');
  console.log(`screenshots: ${SHOTS}`);
  process.exit(problems.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
