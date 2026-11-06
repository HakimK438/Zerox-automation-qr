'use strict';
/* Development only: plays one full order on screen, in two windows side by side.
   Left: the customer's phone. Right: the shop dashboard. Each step has a caption. It clicks the same
   buttons a person would, against your running dev server, in test mode (no money, no paper).
   Needs: npm run dev (running) and npm run dev:account (once). Usage: npm run demo
   Uses Microsoft Edge, or the browser in the CHROME environment variable. */
if (process.env.NODE_ENV === 'production') {
  console.error('demo-show refuses to run with NODE_ENV=production.');
  process.exit(1);
}
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yazl = require('yazl');
const { chromium, devices } = require('playwright-core');
const { loadConfig } = require('../src/config/env');

const config = loadConfig();
const SHOP = config.publicOrigin;
const ADMIN = config.adminOrigin;
const SHOTS = process.env.DEMO_SHOTS || null;
const STEP_MS = Number(process.env.DEMO_STEP_MS || 2500);
const FINISH_OPEN_MS = Number(process.env.DEMO_KEEP_OPEN_MS || 10 * 60000);

const pause = (ms = STEP_MS) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await fn()) return true; } catch { /* page still changing */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('The demo waited too long for the next step.');
}

/** A small real Word file: three pages. */
function sampleWordFile() {
  const para = (text, newPage) => `<w:p>${newPage ? '<w:r><w:br w:type="page"/></w:r>' : ''}<w:r><w:t>${text}</w:t></w:r></w:p>`;
  const body = [para('Class notes'), para('This is a test document for the shop demo.'), para('Page two', true), para('Page three', true)].join('');
  const files = {
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`
  };
  return new Promise((resolve) => {
    const zip = new yazl.ZipFile();
    const chunks = [];
    for (const [name, text] of Object.entries(files)) zip.addBuffer(Buffer.from(text), name);
    zip.outputStream.on('data', (d) => chunks.push(d));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.end();
  });
}

const say = (page, text) => page.evaluate((t) => {
  let el = document.getElementById('demoCaption');
  if (!el) {
    el = document.createElement('div');
    el.id = 'demoCaption';
    Object.assign(el.style, {
      position: 'fixed', left: '12px', right: '12px', bottom: '12px', zIndex: 99, padding: '12px 16px', borderRadius: '12px',
      background: '#111827', color: '#fff', fontSize: '18px', fontWeight: '600', textAlign: 'center', pointerEvents: 'none'
    });
    document.body.append(el);
  }
  el.textContent = t;
}, text);

async function openBrowser(x, width, height) {
  const options = { headless: false, args: [`--window-position=${x},0`, `--window-size=${width},${height}`] };
  if (process.env.CHROME) return chromium.launch({ ...options, executablePath: process.env.CHROME });
  return chromium.launch({ ...options, channel: 'msedge' });
}

async function main() {
  await fetch(`${SHOP}/api/health`).catch(() => { throw new Error('The server is not running. Start it with: npm run dev'); });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-demo-'));
  const wordFile = path.join(dir, 'class-notes.docx');
  fs.writeFileSync(wordFile, await sampleWordFile());
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  let shotNo = 0;
  const snap = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${String(++shotNo).padStart(2, '0')}-${name}.png`) }); };

  const ownerBrowser = await openBrowser(470, 1060, 900);
  const customerBrowser = await openBrowser(0, 470, 900);

  /* owner logs in first, so the order can be watched arriving */
  const owner = await (await ownerBrowser.newContext({ viewport: null })).newPage();
  await owner.goto(ADMIN);
  await until(async () => (await owner.inputValue('#lo')).length === 6, 8000)
    .catch(() => { throw new Error('No test account found. Run: npm run dev:account'); });
  await say(owner, 'The shop owner logs in');
  await pause();
  await owner.click('#lbtn');
  await owner.waitForSelector('body#dashboard', { timeout: 15000 });
  await until(async () => owner.isVisible('#demoBox'));
  if (!(await owner.isChecked('#modeToggle'))) await owner.click('.head .autosw');
  if (!(await owner.isChecked('#demoToggle'))) await owner.click('.dact .autosw');
  await say(owner, 'Test mode is on. The demo printer is ready.');
  await snap(owner, 'owner-ready');

  /* customer */
  const customer = await (await customerBrowser.newContext({ ...devices['Pixel 7'], viewport: { width: 412, height: 780 } })).newPage();
  await customer.goto(SHOP);
  await say(customer, 'Step 1: The customer scans the QR code');
  await pause();
  await say(customer, 'Step 2: The customer uploads a Word file');
  await customer.setInputFiles('#fileIn', wordFile);
  await customer.waitForSelector('.fcard .m', { timeout: 120000 });
  await say(customer, 'The file is ready. The price is calculated.');
  await snap(customer, 'customer-file');
  await pause();
  await say(customer, 'Step 3: The customer chooses colour');
  await customer.click('.fcard [data-a="col"]');
  await pause(1500);
  await customer.click('.fcard [data-a="plus"]');
  await say(customer, 'Step 3: ...and 2 copies');
  await until(async () => customer.isEnabled('#pay'));
  await snap(customer, 'customer-settings');
  await pause();
  await customer.click('#pay');
  await customer.waitForSelector('#paySheet:not(.hide)', { timeout: 15000 });
  await say(customer, 'Step 4: The customer pays (test payment)');
  await snap(customer, 'customer-pay');
  await pause();
  await customer.click('[data-test-pay="success"]');
  await customer.waitForSelector('#pOrder:not(.hide)', { timeout: 20000 });
  const token = (await customer.textContent('#tk')).trim();
  const pin = (await customer.textContent('#pin')).trim();
  await say(customer, `Paid. Token ${token} and a PIN are shown.`);
  await snap(customer, 'customer-ticket');

  /* the shop */
  await say(owner, `Step 5: Order ${token} arrives and prints by itself`);
  await until(async () => (await owner.textContent('#dTitle')).includes(token), 30000);
  await pause(1500);
  await snap(owner, 'owner-printing');
  const row = owner.locator('.ord', { has: owner.locator(`.tk:text-is("${token}")`) });
  const handover = row.locator('[data-act="handover"]');
  await until(async () => (await handover.count()) > 0, 120000);
  await say(owner, `Printing is done. ${token} is ready.`);
  await until(async () => /Ready for pickup/.test(await customer.textContent('#fTime')), 20000);
  await say(customer, 'The customer sees "Ready" without refreshing');
  await snap(owner, 'owner-ready-order');
  await snap(customer, 'customer-ready');
  await pause();
  await say(owner, 'Step 6: The customer shows the PIN and collects the prints');
  await handover.click();
  await owner.waitForSelector('#modal:not(.hide)');
  await owner.locator('#m_pin').pressSequentially(pin, { delay: 300 });
  await snap(owner, 'owner-pin');
  await pause(1500);
  await owner.click('#mok');
  await until(async () => owner.isHidden('#modal'));
  await pause(1500);
  await say(owner, 'Done. The order is finished.');
  await say(customer, 'Done. Collected. Thank you!');
  await snap(owner, 'owner-done');
  await snap(customer, 'customer-done');
  console.log(`Demo finished: order ${token}. Close the windows when you are done.`);

  await Promise.race([pause(FINISH_OPEN_MS), new Promise((r) => { ownerBrowser.on('disconnected', r); customerBrowser.on('disconnected', r); })]);
  await ownerBrowser.close().catch(() => {});
  await customerBrowser.close().catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
}

main().then(() => process.exit(0)).catch((err) => { console.error(err.message); process.exit(1); });
