'use strict';
/* Direct DB fixtures for states that later phases will create through the API
   (paid orders with tokens come from payment verification in phase 4). */
const { newId } = require('../src/lib/crypto');
const { hashRecoveryPin } = require('../src/modules/orders/recovery');
const { istDate } = require('../src/lib/token');

function insertOrder(db, { sessionId, status = 'paid', tokenNo = null, tokenDate = istDate(), pin = null, totalPaise = 1000 }) {
  const id = newId();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO orders (id, session_id, status, total_paise, token_date, token_no, recovery_pin_hash, created_at, updated_at, paid_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, sessionId, status, totalPaise, tokenNo == null ? null : tokenDate, tokenNo,
    pin ? hashRecoveryPin(id, pin) : null, now, now, status === 'draft' || status === 'awaiting_payment' ? null : now
  );
  return id;
}

/** Extracts "name=value" for the session cookie from a fetch Response. */
function sessionCookie(res) {
  const raw = res.headers.getSetCookie().find((c) => /^(__Host-)?qp_sid=/.test(c));
  return raw ? { header: raw, pair: raw.split(';')[0] } : null;
}

/** Fetch wrapper that sends JSON from our own origin. */
function api(base, { cookie } = {}) {
  return (path, { method = 'GET', body, headers = {} } = {}) => fetch(`${base}${path}`, {
    method,
    headers: {
      origin: 'http://localhost:3000',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

/** A real PDF with `pages` pages. */
async function makePdf(pages = 1) {
  const { PDFDocument } = require('pdf-lib');
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([595, 842]).drawText(`Page ${i + 1}`, { x: 50, y: 780 });
  return Buffer.from(await doc.save());
}

/** New browser: session + draft order. Returns { cookie, call, orderId }. */
async function newCustomer(base) {
  const res = await api(base)('/api/session', { method: 'POST' });
  const cookie = sessionCookie(res).pair;
  const call = api(base, { cookie });
  const order = await (await call('/api/orders', { method: 'POST' })).json();
  return { cookie, call, orderId: order.orderId };
}

function uploadFile(base, cookie, orderId, { name, type, bytes }) {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type }), name);
  return fetch(`${base}/api/orders/${orderId}/documents`, {
    method: 'POST', headers: { origin: 'http://localhost:3000', ...(cookie ? { cookie } : {}) }, body: fd
  });
}

/** Uploads a PDF with `pages` pages and waits for conversion. Returns the document JSON. */
async function addPdf(ctx, c, pages, name = `doc-${pages}p.pdf`) {
  const res = await uploadFile(ctx.base, c.cookie, c.orderId, { name, type: 'application/pdf', bytes: await makePdf(pages) });
  if (res.status !== 202) throw new Error(`upload failed: ${res.status} ${await res.text()}`);
  const { documentId } = await res.json();
  await ctx.app.locals.queue.idle();
  return (await c.call(`/api/orders/${c.orderId}/documents/${documentId}`)).json();
}

module.exports = { insertOrder, sessionCookie, api, makePdf, newCustomer, uploadFile, addPdf };
