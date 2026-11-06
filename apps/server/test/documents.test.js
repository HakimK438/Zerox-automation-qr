'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { PDFDocument } = require('pdf-lib');
const sharp = require('sharp');
const yazl = require('yazl');
const { startTestApp } = require('./helpers');
const { sessionCookie, api } = require('./fixtures');
const { cleanFileName } = require('../src/modules/documents/receive');

const HAS_SOFFICE = (() => { try { execFileSync('which', ['soffice'], { stdio: 'ignore' }); return true; } catch { return false; } })();

/* ---------- file builders ---------- */
async function makePdf(pages = 1, { encrypted = false } = {}) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([595, 842]).drawText(`Page ${i + 1}`, { x: 50, y: 780 });
  let bytes = Buffer.from(await doc.save({ useObjectStreams: false }));
  if (encrypted) {
    bytes = Buffer.from(bytes.toString('latin1').replace('trailer\n<<', 'trailer\n<<\n/Encrypt 1 0 R'), 'latin1');
  }
  return bytes;
}
const makePng = () => sharp({ create: { width: 300, height: 120, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } }).png().toBuffer();
// 300x120 landscape pixels, but EXIF says "rotate 90°": the photo is really portrait.
const makeRotatedJpeg = () => sharp({ create: { width: 300, height: 120, channels: 3, background: '#3366cc' } })
  .jpeg().withMetadata({ orientation: 6 }).toBuffer();

function makeZip(entries) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const [name, content] of Object.entries(entries)) zip.addBuffer(Buffer.from(content), name);
    zip.end();
    const chunks = [];
    zip.outputStream.on('data', (c) => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks))).on('error', reject);
  });
}
const DOCX_ENTRIES = {
  '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello print shop</w:t></w:r></w:p></w:body></w:document>'
};
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/* ---------- API helpers ---------- */
async function customer(base) {
  const res = await api(base)('/api/session', { method: 'POST' });
  const cookie = sessionCookie(res).pair;
  const call = api(base, { cookie });
  const order = await (await call('/api/orders', { method: 'POST' })).json();
  return { cookie, call, orderId: order.orderId };
}

function upload(base, cookie, orderId, { name, type, bytes }) {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type }), name);
  return fetch(`${base}/api/orders/${orderId}/documents`, { method: 'POST', headers: { origin: 'http://localhost:3000', ...(cookie ? { cookie } : {}) }, body: fd });
}

async function uploadAndConvert(t, ctx, c, file) {
  const res = await upload(ctx.base, c.cookie, c.orderId, file);
  const body = await res.json();
  assert.equal(res.status, 202, JSON.stringify(body));
  await ctx.app.locals.queue.idle();
  return (await c.call(`/api/orders/${c.orderId}/documents/${body.documentId}`)).json();
}

const listDir = (ctx, sub) => fs.readdirSync(path.join(ctx.config.filesDir, sub));

/* ---------- tests ---------- */

test('draft order: one per browser, reused on reload, needs a session', async (t) => {
  const ctx = await startTestApp();
  t.after(ctx.close);
  const c = await customer(ctx.base);
  const again = await (await c.call('/api/orders', { method: 'POST' })).json();
  assert.equal(again.orderId, c.orderId);
  assert.equal(again.status, 'draft');
  assert.equal((await api(ctx.base)('/api/orders', { method: 'POST' })).status, 401);
});

test('PDF upload: streamed, converted, real page count, private preview', async (t) => {
  const ctx = await startTestApp();
  t.after(ctx.close);
  const c = await customer(ctx.base);
  const bytes = await makePdf(3);
  const doc = await uploadAndConvert(t, ctx, c, { name: 'notes.pdf', type: 'application/pdf', bytes });
  assert.equal(doc.status, 'ready');
  assert.equal(doc.pageCount, 3, 'page count comes from the server, not the client');
  assert.equal(doc.name, 'notes.pdf');

  const prev = await c.call(doc.previewUrl);
  assert.equal(prev.status, 200);
  assert.equal(prev.headers.get('content-type'), 'application/pdf');
  assert.equal(prev.headers.get('content-security-policy'), 'sandbox');
  assert.match(prev.headers.get('cache-control'), /no-store/);
  assert.deepEqual(Buffer.from(await prev.arrayBuffer()), bytes);

  // Storage uses server-generated keys only.
  for (const f of listDir(ctx, 'orig')) assert.match(f, /^[0-9a-f-]{36}$/);
  assert.deepEqual(listDir(ctx, 'tmp'), []);
});

test('images: EXIF rotation applied, transparent PNG accepted, one A4 page each', async (t) => {
  const ctx = await startTestApp();
  t.after(ctx.close);
  const c = await customer(ctx.base);

  const photo = await uploadAndConvert(t, ctx, c, { name: 'IMG_0001.jpg', type: 'image/jpeg', bytes: await makeRotatedJpeg() });
  assert.equal(photo.status, 'ready', photo.error);
  const pdf = await PDFDocument.load(Buffer.from(await (await c.call(photo.previewUrl)).arrayBuffer()));
  const { width, height } = pdf.getPage(0).getSize();
  assert.ok(height > width, 'rotated photo prints portrait');
  assert.equal(Math.round(Math.min(width, height)), 595);

  const png = await uploadAndConvert(t, ctx, c, { name: 'scan.png', type: 'image/png', bytes: await makePng() });
  assert.equal(png.status, 'ready', png.error);
  assert.equal(png.pageCount, 1);
});

test('rejects files whose content does not match their type', async (t) => {
  const ctx = await startTestApp();
  t.after(ctx.close);
  const c = await customer(ctx.base);
  const png = await makePng();
  const cases = [
    { name: 'invoice.pdf', type: 'application/pdf', bytes: png },                        // PNG renamed .pdf
    { name: 'report.docx', type: DOCX, bytes: Buffer.from('MZ\x90\x00 fake executable') }, // exe renamed .docx
    { name: 'report.docx', type: DOCX, bytes: await makeZip({ 'hello.txt': 'hi' }) },    // a zip, not a docx
    { name: 'page.pdf', type: 'text/html', bytes: await makePdf(1) },                    // declared type contradicts
    { name: 'setup.exe', type: 'application/octet-stream', bytes: Buffer.from('MZ') },   // unsupported type
    { name: 'noext', type: 'application/pdf', bytes: await makePdf(1) }
  ];
  for (const file of cases) {
    const res = await upload(ctx.base, c.cookie, c.orderId, file);
    assert.equal(res.status, 400, `${file.name} (${file.type})`);
  }
  assert.deepEqual(listDir(ctx, 'tmp'), [], 'rejected uploads leave nothing behind');
  assert.deepEqual(listDir(ctx, 'orig'), []);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) FROM documents').pluck().get(), 0);
});

test('rejects macro documents disguised as .docx', async (t) => {
  const ctx = await startTestApp();
  t.after(ctx.close);
  const c = await customer(ctx.base);
  const docm = await makeZip({ ...DOCX_ENTRIES, 'word/vbaProject.bin': 'macro' });
  const res = await upload(ctx.base, c.cookie, c.orderId, { name: 'invoice.docx', type: DOCX, bytes: docm });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /macros/);
});

test('Word conversion: real PDF with LibreOffice, polite failure without it', async (t) => {
  const ctx = await startTestApp({ QP_SOFFICE_PATH: HAS_SOFFICE ? 'soffice' : '/nonexistent/soffice' });
  t.after(ctx.close);
  const c = await customer(ctx.base);
  const doc = await uploadAndConvert(t, ctx, c, { name: 'letter.docx', type: DOCX, bytes: await makeZip(DOCX_ENTRIES) });
  if (HAS_SOFFICE) {
    assert.equal(doc.status, 'ready', doc.error);
    assert.ok(doc.pageCount >= 1);
  } else {
    assert.equal(doc.status, 'failed');
    assert.match(doc.error, /Please upload a PDF instead/);
    assert.equal(doc.previewUrl, null);
  }
});

test('broken, encrypted and over-long PDFs fail with a helpful message', async (t) => {
  const ctx = await startTestApp({ QP_MAX_PAGES_PER_DOC: '3' });
  t.after(ctx.close);
  const c = await customer(ctx.base);
  const enc = await uploadAndConvert(t, ctx, c, { name: 'locked.pdf', type: 'application/pdf', bytes: await makePdf(1, { encrypted: true }) });
  assert.equal(enc.status, 'failed');
  assert.match(enc.error, /password-protected/);

  const long = await uploadAndConvert(t, ctx, c, { name: 'book.pdf', type: 'application/pdf', bytes: await makePdf(5) });
  assert.equal(long.status, 'failed');
  assert.match(long.error, /5 pages; the limit is 3/);

  const junk = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2000, 0x41)]);
  const broken = await uploadAndConvert(t, ctx, c, { name: 'broken.pdf', type: 'application/pdf', bytes: junk });
  assert.equal(broken.status, 'failed');
  assert.match(broken.error, /damaged|could not/i);
  assert.deepEqual(listDir(ctx, 'pdf'), [], 'no PDF kept for failed conversions');
});

test('size limit: oversized upload rejected with 413 and nothing kept', async (t) => {
  const ctx = await startTestApp({ QP_MAX_UPLOAD_MB: '1' });
  t.after(ctx.close);
  const c = await customer(ctx.base);
  const big = Buffer.concat([await makePdf(1), Buffer.alloc(1.5 * 1024 * 1024, 0x20)]);
  const res = await upload(ctx.base, c.cookie, c.orderId, { name: 'big.pdf', type: 'application/pdf', bytes: big });
  assert.equal(res.status, 413);
  assert.deepEqual(listDir(ctx, 'tmp'), []);
  assert.deepEqual(listDir(ctx, 'orig'), []);
});

test('limits: files per order, and no changes after checkout', async (t) => {
  const ctx = await startTestApp({ QP_MAX_DOCS_PER_ORDER: '2' });
  t.after(ctx.close);
  const c = await customer(ctx.base);
  const pdf = await makePdf(1);
  const statuses = [];
  for (let i = 0; i < 3; i++) statuses.push((await upload(ctx.base, c.cookie, c.orderId, { name: `f${i}.pdf`, type: 'application/pdf', bytes: pdf })).status);
  assert.deepEqual(statuses, [202, 202, 409]);
  await ctx.app.locals.queue.idle();

  const docId = ctx.db.prepare('SELECT id FROM documents LIMIT 1').pluck().get();
  ctx.db.prepare("UPDATE orders SET status = 'awaiting_payment' WHERE id = ?").run(c.orderId);
  assert.equal((await upload(ctx.base, c.cookie, c.orderId, { name: 'late.pdf', type: 'application/pdf', bytes: pdf })).status, 409);
  assert.equal((await c.call(`/api/orders/${c.orderId}/documents/${docId}`, { method: 'DELETE' })).status, 409);
});

test('isolation: another browser cannot see, preview, change or upload to my order', async (t) => {
  const ctx = await startTestApp();
  t.after(ctx.close);
  const me = await customer(ctx.base);
  const other = await customer(ctx.base);
  const doc = await uploadAndConvert(t, ctx, me, { name: 'private.pdf', type: 'application/pdf', bytes: await makePdf(1) });

  assert.equal((await other.call(`/api/orders/${me.orderId}`)).status, 404);
  assert.equal((await other.call(`/api/orders/${me.orderId}/documents/${doc.documentId}`)).status, 404);
  assert.equal((await other.call(doc.previewUrl)).status, 404);
  assert.equal((await other.call(`/api/orders/${me.orderId}/documents/${doc.documentId}`, { method: 'DELETE' })).status, 404);
  assert.equal((await upload(ctx.base, other.cookie, me.orderId, { name: 'x.pdf', type: 'application/pdf', bytes: await makePdf(1) })).status, 404);
  // my document under someone else's order id
  assert.equal((await other.call(`/api/orders/${other.orderId}/documents/${doc.documentId}`)).status, 404);
  // no session at all
  assert.equal((await api(ctx.base)(doc.previewUrl)).status, 401);
  assert.equal((await upload(ctx.base, null, me.orderId, { name: 'x.pdf', type: 'application/pdf', bytes: await makePdf(1) })).status, 401);
  assert.equal((await me.call('/api/orders/not-a-uuid')).status, 404);
});

test('delete removes the record and both files', async (t) => {
  const ctx = await startTestApp();
  t.after(ctx.close);
  const c = await customer(ctx.base);
  const doc = await uploadAndConvert(t, ctx, c, { name: 'a.pdf', type: 'application/pdf', bytes: await makePdf(2) });
  assert.equal(listDir(ctx, 'orig').length, 1);
  assert.equal(listDir(ctx, 'pdf').length, 1);
  assert.equal((await c.call(`/api/orders/${c.orderId}/documents/${doc.documentId}`, { method: 'DELETE' })).status, 204);
  assert.deepEqual(listDir(ctx, 'orig'), []);
  assert.deepEqual(listDir(ctx, 'pdf'), []);
  const order = await (await c.call(`/api/orders/${c.orderId}`)).json();
  assert.deepEqual(order.documents, []);
});

test('conversion resumes after a restart', async (t) => {
  const ctx = await startTestApp();
  t.after(ctx.close);
  const c = await customer(ctx.base);
  const doc = await uploadAndConvert(t, ctx, c, { name: 'r.pdf', type: 'application/pdf', bytes: await makePdf(4) });
  // Simulate a crash mid-conversion.
  ctx.db.prepare("UPDATE documents SET conversion_status = 'converting', page_count = NULL WHERE id = ?").run(doc.documentId);
  ctx.app.locals.queue.recover();
  await ctx.app.locals.queue.idle();
  const after = await (await c.call(`/api/orders/${c.orderId}/documents/${doc.documentId}`)).json();
  assert.equal(after.status, 'ready');
  assert.equal(after.pageCount, 4);
});

test('file names are display-only and sanitised', async (t) => {
  assert.equal(cleanFileName('../../etc/passwd.pdf'), 'passwd.pdf');
  assert.equal(cleanFileName('C:\\Users\\me\\Desktop\\cv.pdf'), 'cv.pdf');
  assert.equal(cleanFileName('inv\u202Efdp.exe'), 'invfdp.exe', 'bidi override removed');
  assert.equal(cleanFileName('a\u0000b.pdf'), 'ab.pdf');
  assert.equal(cleanFileName(''), 'document');
  const long = cleanFileName(`${'x'.repeat(300)}.docx`);
  assert.equal(long.length, 150);
  assert.ok(long.endsWith('.docx'));

  const ctx = await startTestApp();
  t.after(ctx.close);
  const c = await customer(ctx.base);
  const doc = await uploadAndConvert(t, ctx, c, { name: '../../secret.pdf', type: 'application/pdf', bytes: await makePdf(1) });
  assert.equal(doc.name, 'secret.pdf');
});

test('upload endpoint rejects non-multipart bodies', async (t) => {
  const ctx = await startTestApp();
  t.after(ctx.close);
  const c = await customer(ctx.base);
  const res = await fetch(`${ctx.base}/api/orders/${c.orderId}/documents`, {
    method: 'POST', headers: { origin: 'http://localhost:3000', cookie: c.cookie, 'content-type': 'application/pdf' }, body: await makePdf(1)
  });
  assert.equal(res.status, 400);
});
