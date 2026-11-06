'use strict';
/* Phase 3 over HTTP: print settings, authoritative quote, checkout freeze, and revenue-leak guards. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers');
const { api, newCustomer, addPdf, makePdf, uploadFile } = require('./fixtures');

const setParts = (c, documentId, body) =>
  c.call(`/api/orders/${c.orderId}/documents/${documentId}/parts`, { method: 'PUT', body });
const quote = async (c) => (await c.call(`/api/orders/${c.orderId}/quote`)).json();
const checkout = (c) => c.call(`/api/orders/${c.orderId}/checkout`, { method: 'POST' });

test('public pricing shows rates and options without a session', async (t) => {
  const ctx = await startTestApp();
  t.after(ctx.close);
  const res = await api(ctx.base)('/api/pricing');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    currency: 'INR',
    rates: { bw1: 300, bw2: 500, col1: 1000, col2: 1800 }, // default rate card (migration 005), editable by the owner
    duplexBasis: 'sheet',
    a3Multiplier: 2,
    options: { maxCopies: 50, paperSizes: ['A4'], allowRanges: true, maxPartsPerDocument: 10 }
  });
});

test('new uploads get default settings and a live quote from the server page count', async (t) => {
  const ctx = await startTestApp();
  t.after(ctx.close);
  const c = await newCustomer(ctx.base);
  const doc = await addPdf(ctx, c, 6);
  assert.equal(doc.copies, 1);
  assert.deepEqual(doc.parts.map(({ partId, ...p }) => p), [{ pages: 'all', color: false, duplex: false, paper: 'A4' }]);

  const q = await quote(c);
  assert.equal(q.ready, true);
  assert.equal(q.frozen, false);
  assert.equal(q.totalPaise, 6 * 300);
  assert.equal(q.documents[0].parts[0].pageCount, 6);
});

test('changing settings re-prices on the server', async (t) => {
  const ctx = await startTestApp();
  t.after(ctx.close);
  const c = await newCustomer(ctx.base);
  const a = await addPdf(ctx, c, 10);
  const b = await addPdf(ctx, c, 3);

  const res = await setParts(c, a.documentId, {
    copies: 2,
    parts: [
      { pages: '1-4', color: true, duplex: false, paper: 'A4' },
      { pages: '5-10', color: false, duplex: true, paper: 'A4' }
    ]
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.priced.amountPaise, 4 * 2 * 1000 + 3 * 2 * 500);
  assert.equal(body.totalPaise, 11000 + 3 * 300, 'includes the other document');
  assert.equal(body.document.copies, 2);
  assert.equal(body.document.parts.length, 2);

  const q = await quote(c);
  assert.equal(q.totalPaise, 11900);
  assert.equal(q.documents.find((d) => d.documentId === b.documentId).amountPaise, 900);
});

test('the browser cannot send prices or page counts', async (t) => {
  const ctx = await startTestApp();
  t.after(ctx.close);
  const c = await newCustomer(ctx.base);
  const doc = await addPdf(ctx, c, 5);
  const p = { pages: 'all', color: false, duplex: false, paper: 'A4' };
  const attempts = [
    { copies: 1, parts: [p], totalPaise: 1 },
    { copies: 1, parts: [{ ...p, amountPaise: 1 }] },
    { copies: 1, parts: [{ ...p, pageCount: 1 }] },
    { copies: 1, parts: [{ ...p, ratePaise: 1 }] },
    { copies: 0, parts: [p] },
    { copies: 1.5, parts: [p] },
    { copies: 1, parts: [] },
    { copies: 1, parts: [{ ...p, paper: 'Letter' }] },
    { copies: 1, parts: [{ ...p, color: 'yes' }] }
  ];
  for (const body of attempts) {
    assert.equal((await setParts(c, doc.documentId, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await quote(c)).totalPaise, 5 * 300, 'price unchanged');
});

test('shop options are enforced: max copies and paper sizes', async (t) => {
  const ctx = await startTestApp();
  t.after(ctx.close);
  ctx.app.locals.settings.set('print_options', { maxCopies: 5, paperSizes: ['A4', 'A3'], allowRanges: true, maxPartsPerDocument: 2 });
  const c = await newCustomer(ctx.base);
  const doc = await addPdf(ctx, c, 4);
  const p = { pages: 'all', color: false, duplex: false, paper: 'A3' };

  assert.equal((await setParts(c, doc.documentId, { copies: 6, parts: [p] })).status, 400);
  const three = [{ ...p, pages: '1' }, { ...p, pages: '2' }, { ...p, pages: '3' }];
  assert.equal((await setParts(c, doc.documentId, { copies: 1, parts: three })).status, 400);
  assert.equal((await setParts(c, doc.documentId, { copies: 5, parts: [p] })).status, 200);
  assert.equal((await quote(c)).totalPaise, 4 * 5 * 600, 'A3 doubles the rate');
});

test('invalid ranges are saved but block checkout with a clear message', async (t) => {
  const ctx = await startTestApp();
  t.after(ctx.close);
  const c = await newCustomer(ctx.base);
  const doc = await addPdf(ctx, c, 3);
  const res = await setParts(c, doc.documentId, { copies: 1, parts: [{ pages: '2-9', color: false, duplex: false, paper: 'A4' }] });
  assert.equal(res.status, 200, 'the customer may still be typing');
  const q = await quote(c);
  assert.equal(q.ready, false);
  assert.match(q.documents[0].parts[0].error, /1 to 3/);

  const co = await checkout(c);
  assert.equal(co.status, 409);
  const err = (await co.json()).error;
  assert.equal(err.code, 'not_ready');
  assert.match(err.message, /1 to 3/);
});

test('checkout is blocked with no documents, a converting document, or a failed one', async (t) => {
  const ctx = await startTestApp();
  t.after(ctx.close);
  const c = await newCustomer(ctx.base);
  assert.equal((await checkout(c)).status, 409, 'empty order');

  const doc = await addPdf(ctx, c, 2);
  ctx.db.prepare("UPDATE documents SET conversion_status = 'converting' WHERE id = ?").run(doc.documentId);
  assert.equal((await quote(c)).ready, false);
  assert.equal((await checkout(c)).status, 409, 'still converting');

  ctx.db.prepare("UPDATE documents SET conversion_status = 'failed', error = 'damaged' WHERE id = ?").run(doc.documentId);
  const q = await quote(c);
  assert.equal(q.ready, false);
  assert.equal(q.errors[0].message, 'damaged');
  assert.equal((await checkout(c)).status, 409, 'failed document');
  const order = ctx.db.prepare('SELECT status, total_paise FROM orders WHERE id = ?').get(c.orderId);
  assert.deepEqual(order, { status: 'draft', total_paise: 0 });
});

test('checkout freezes the price; later price changes cannot touch it', async (t) => {
  const ctx = await startTestApp();
  t.after(ctx.close);
  const c = await newCustomer(ctx.base);
  const doc = await addPdf(ctx, c, 8);
  await setParts(c, doc.documentId, { copies: 2, parts: [{ pages: 'all', color: false, duplex: true, paper: 'A4' }] });

  const res = await checkout(c);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.order.status, 'awaiting_payment');
  assert.equal(body.order.totalPaise, 4 * 2 * 500);
  assert.equal(body.quote.frozen, true);

  const row = ctx.db.prepare('SELECT total_paise, price_table_id, checkout_at FROM orders WHERE id = ?').get(c.orderId);
  assert.equal(row.total_paise, 4000);
  assert.ok(row.price_table_id && row.checkout_at);
  const part = ctx.db.prepare('SELECT pages, sides, sheets, rate_paise, amount_paise FROM document_parts').get();
  assert.deepEqual(part, { pages: 8, sides: 16, sheets: 8, rate_paise: 500, amount_paise: 4000 });
  const ev = ctx.db.prepare("SELECT from_status, to_status, actor FROM order_events WHERE order_id = ? AND to_status = 'awaiting_payment'").get(c.orderId);
  assert.deepEqual(ev, { from_status: 'draft', to_status: 'awaiting_payment', actor: 'customer' });

  // Owner raises prices afterwards.
  ctx.app.locals.pricing.setPriceTable({ bw1Paise: 900, bw2Paise: 900, col1Paise: 2000, col2Paise: 2000 }, 'test');
  const q = await quote(c);
  assert.equal(q.frozen, true);
  assert.equal(q.totalPaise, 4000, 'customer pays what they were quoted');
  assert.equal(q.documents[0].parts[0].ratePaise, 500);

  // A new order uses the new prices.
  const other = await newCustomer(ctx.base);
  await addPdf(ctx, other, 1);
  assert.equal((await quote(other)).totalPaise, 900);
});

test('after checkout the order is locked; checkout retry is idempotent', async (t) => {
  const ctx = await startTestApp();
  t.after(ctx.close);
  const c = await newCustomer(ctx.base);
  const doc = await addPdf(ctx, c, 2);
  assert.equal((await checkout(c)).status, 200);

  const again = await checkout(c);
  assert.equal(again.status, 200, 'network retry returns the same frozen order');
  assert.equal((await again.json()).order.totalPaise, 600);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) FROM order_events WHERE to_status = 'awaiting_payment'").pluck().get(), 1);

  const p = { pages: 'all', color: true, duplex: false, paper: 'A4' };
  assert.equal((await setParts(c, doc.documentId, { copies: 9, parts: [p] })).status, 409);
  assert.equal((await uploadFile(ctx.base, c.cookie, c.orderId, { name: 'x.pdf', type: 'application/pdf', bytes: await makePdf(1) })).status, 409);
  assert.equal((await c.call(`/api/orders/${c.orderId}/documents/${doc.documentId}`, { method: 'DELETE' })).status, 409);
  assert.equal((await quote(c)).totalPaise, 600);

  // A fresh draft can be started for the next order.
  const next = await (await c.call('/api/orders', { method: 'POST' })).json();
  assert.notEqual(next.orderId, c.orderId);
  assert.equal(next.status, 'draft');
});

test('another browser cannot quote, change or check out my order', async (t) => {
  const ctx = await startTestApp();
  t.after(ctx.close);
  const me = await newCustomer(ctx.base);
  const other = await newCustomer(ctx.base);
  const doc = await addPdf(ctx, me, 2);
  const p = { pages: 'all', color: false, duplex: false, paper: 'A4' };
  const as = (c) => ({ ...c, orderId: me.orderId });
  assert.equal((await other.call(`/api/orders/${me.orderId}/quote`)).status, 404);
  assert.equal((await setParts(as(other), doc.documentId, { copies: 1, parts: [p] })).status, 404);
  assert.equal((await checkout(as(other))).status, 404);
  assert.equal((await api(ctx.base)(`/api/orders/${me.orderId}/quote`)).status, 401);
  assert.equal(ctx.db.prepare('SELECT status FROM orders WHERE id = ?').pluck().get(me.orderId), 'draft');
});

test('deleting a document removes its settings', async (t) => {
  const ctx = await startTestApp();
  t.after(ctx.close);
  const c = await newCustomer(ctx.base);
  const doc = await addPdf(ctx, c, 2);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) FROM document_parts').pluck().get(), 1);
  await c.call(`/api/orders/${c.orderId}/documents/${doc.documentId}`, { method: 'DELETE' });
  assert.equal(ctx.db.prepare('SELECT COUNT(*) FROM document_parts').pluck().get(), 0);
});
