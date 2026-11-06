'use strict';
/* Phase 5: queue + ETA, live updates (SSE), rating, shop info, and the customer site's static files. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startTestApp } = require('./helpers');
const { api, newCustomer, addPdf, insertOrder } = require('./fixtures');
const { schedule, workMinutes } = require('../src/modules/queue/service');

/* ---------- pure scheduler ---------- */

const CFG = { ppmBw: 20, ppmColor: 10, setupSec: 30, printers: 1, manualDelayMin: 3 };
const OPTS = { printers: 1, paused: false, manual: false, manualDelayMin: 3 };

test('work time: setup + sides / speed, colour slower, duplex ~10% slower', () => {
  assert.equal(workMinutes([], CFG), 0.5);
  assert.equal(workMinutes([{ color: false, duplex: false, sides: 20 }], CFG), 1.5);
  assert.equal(workMinutes([{ color: true, duplex: false, sides: 20 }], CFG), 2.5);
  assert.ok(Math.abs(workMinutes([{ color: false, duplex: true, sides: 20 }], CFG) - 1.6) < 1e-9);
});

test('schedule: first paid first served; ETA accumulates; printing order has used part of its time', () => {
  const now = Date.parse('2026-11-06T10:00:00Z');
  const jobs = [
    { id: 'a', status: 'printing', work: 4, startedAt: now - 3 * 60000 }, // 1 minute left
    { id: 'b', status: 'paid', work: 2 },
    { id: 'c', status: 'paid', work: 5 }
  ];
  const r = schedule(jobs, OPTS, now);
  assert.deepEqual([...r.values()].map((e) => [e.position, e.ahead, e.etaMinutes]), [[1, 0, 1], [2, 1, 3], [3, 2, 8]]);
  assert.equal(r.get('c').readyAt, new Date(now + 8 * 60000).toISOString());
});

test('schedule: two printers share the queue; pause hides ETA; manual mode adds a start delay', () => {
  const now = Date.now();
  const jobs = [{ id: 'a', status: 'paid', work: 10 }, { id: 'b', status: 'paid', work: 2 }, { id: 'c', status: 'paid', work: 3 }];
  const two = schedule(jobs, { ...OPTS, printers: 2 }, now);
  assert.deepEqual(['a', 'b', 'c'].map((id) => two.get(id).etaMinutes), [10, 2, 5], 'c goes to the printer that frees up first');
  const paused = schedule(jobs, { ...OPTS, paused: true }, now);
  assert.equal(paused.get('a').etaMinutes, null);
  assert.equal(paused.get('c').ahead, 2, 'position still shown while paused');
  const manual = schedule(jobs, { ...OPTS, manual: true }, now);
  assert.equal(manual.get('a').etaMinutes, 13);
});

/* ---------- queue over HTTP ---------- */

async function paidOrder(ctx, { pages = 2, paidAt }) {
  const c = await newCustomer(ctx.base);
  await addPdf(ctx, c, pages);
  await c.call(`/api/orders/${c.orderId}/checkout`, { method: 'POST' });
  ctx.db.prepare("UPDATE orders SET status = 'paid', paid_at = ?, token_no = ?, token_date = '2026-11-06' WHERE id = ?")
    .run(paidAt, 100 + Math.floor(Math.random() * 1000), c.orderId);
  ctx.app.locals.printQueue.invalidate();
  return c;
}

test('order view shows queue position and ETA; paused and manual are reflected', async (t) => {
  const ctx = await startTestApp();
  t.after(ctx.close);
  const first = await paidOrder(ctx, { pages: 100, paidAt: '2026-11-06T10:00:00.000Z' }); // ~5.3 min at 20 ppm
  const second = await paidOrder(ctx, { pages: 40, paidAt: '2026-11-06T10:01:00.000Z' });  // starts after it

  const o1 = await (await first.call(`/api/orders/${first.orderId}`)).json();
  const o2 = await (await second.call(`/api/orders/${second.orderId}`)).json();
  assert.equal(o1.queue.position, 1);
  assert.equal(o2.queue.ahead, 1);
  assert.ok(o2.queue.etaMinutes > o1.queue.etaMinutes, 'later order finishes later');
  assert.equal(o2.queue.paused, false);

  ctx.app.locals.settings.set('paused', true);
  const p = await (await second.call(`/api/orders/${second.orderId}`)).json();
  assert.equal(p.queue.paused, true);
  assert.equal(p.queue.etaMinutes, null);

  ctx.app.locals.settings.set('paused', false);
  ctx.app.locals.settings.set('print_mode', 'manual');
  const m = await (await second.call(`/api/orders/${second.orderId}`)).json();
  assert.equal(m.queue.printMode, 'manual');
  assert.ok(m.queue.etaMinutes > o2.queue.etaMinutes);
});

test('estimate for a new order includes everyone already waiting', async (t) => {
  const ctx = await startTestApp();
  t.after(ctx.close);
  const empty = await (await api(ctx.base)('/api/queue/estimate?bw=20')).json();
  await paidOrder(ctx, { pages: 60, paidAt: '2026-11-06T10:00:00.000Z' });
  const busy = await (await api(ctx.base)('/api/queue/estimate?bw=20')).json();
  assert.equal(busy.ahead, 1);
  assert.ok(busy.etaMinutes > empty.etaMinutes);
  assert.equal((await api(ctx.base)('/api/queue/estimate?bw=-5')).status, 400);
  assert.equal((await api(ctx.base)('/api/queue/estimate?bw=1&evil=1')).status, 400);
});

/* ---------- SSE ---------- */

/** Opens the event stream and collects parsed events. */
async function openStream(base, cookie) {
  const ac = new AbortController();
  const res = await fetch(`${base}/api/me/events`, { headers: { cookie }, signal: ac.signal });
  const events = [];
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block); const data = /^data: (.+)$/m.exec(block);
          if (ev && data) events.push({ event: ev[1], data: JSON.parse(data[1]) });
        }
      }
    } catch { /* aborted */ }
  })();
  const waitFor = async (pred, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const e = events.find(pred); if (e) return e; await new Promise((r) => setTimeout(r, 20)); }
    return null;
  };
  return { res, events, waitFor, close: () => ac.abort() };
}

test('live updates: snapshot, document conversion and checkout events, only for my own orders', async (t) => {
  const ctx = await startTestApp();
  t.after(ctx.close);
  const me = await newCustomer(ctx.base);
  const other = await newCustomer(ctx.base);
  const mine = await openStream(ctx.base, me.cookie);
  const theirs = await openStream(ctx.base, other.cookie);
  t.after(() => { mine.close(); theirs.close(); });

  assert.equal(mine.res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  assert.equal(mine.res.headers.get('cache-control'), 'no-store');
  assert.ok(await mine.waitFor((e) => e.event === 'order' && e.data.orderId === me.orderId), 'draft snapshot');

  const doc = await addPdf(ctx, me, 3);
  const ready = await mine.waitFor((e) => e.event === 'document' && e.data.documentId === doc.documentId && e.data.status === 'ready');
  assert.ok(ready, 'conversion finished pushed live');
  assert.equal(ready.data.pageCount, 3);

  await me.call(`/api/orders/${me.orderId}/checkout`, { method: 'POST' });
  assert.ok(await mine.waitFor((e) => e.event === 'order' && e.data.status === 'awaiting_payment'));

  await new Promise((r) => setTimeout(r, 100));
  const leaked = theirs.events.filter((e) => e.data.orderId === me.orderId || e.data.documentId === doc.documentId);
  assert.deepEqual(leaked, [], 'another browser never sees my order');
});

test('live updates need a session and are capped per browser', async (t) => {
  const ctx = await startTestApp();
  t.after(ctx.close);
  assert.equal((await fetch(`${ctx.base}/api/me/events`)).status, 401);
  const c = await newCustomer(ctx.base);
  const streams = [];
  for (let i = 0; i < 6; i++) streams.push(await openStream(ctx.base, c.cookie));
  t.after(() => streams.forEach((s) => s.close()));
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(ctx.app.locals.hub.stats().connections <= 4, 'oldest tabs dropped');
});

test('a paid order pushes its token, PIN and position to the customer', async (t) => {
  const ctx = await startTestApp();
  t.after(ctx.close);
  const c = await newCustomer(ctx.base);
  await addPdf(ctx, c, 2);
  await c.call(`/api/orders/${c.orderId}/checkout`, { method: 'POST' });
  const s = await openStream(ctx.base, c.cookie);
  t.after(s.close);
  ctx.db.prepare("UPDATE orders SET status = 'paid', paid_at = ?, token_no = 101, token_date = '2026-11-06' WHERE id = ?").run(new Date().toISOString(), c.orderId);
  ctx.app.locals.bus.emit('order', c.orderId);
  const e = await s.waitFor((x) => x.event === 'order' && x.data.status === 'paid');
  assert.equal(e.data.token, 'XR-101');
  assert.equal(e.data.queue.position, 1);
});

/* ---------- rating, shop, draft restore ---------- */

test('rating: once, 1-5, only after paying', async (t) => {
  const ctx = await startTestApp();
  t.after(ctx.close);
  const c = await newCustomer(ctx.base);
  const rate = (stars) => c.call(`/api/orders/${c.orderId}/rating`, { method: 'POST', body: { stars } });
  assert.equal((await rate(5)).status, 409, 'draft cannot be rated');
  ctx.db.prepare("UPDATE orders SET status = 'ready' WHERE id = ?").run(c.orderId);
  assert.equal((await rate(6)).status, 400);
  assert.equal((await rate(4)).status, 200);
  assert.equal((await rate(5)).status, 409, 'only once');
  assert.equal((await (await c.call(`/api/orders/${c.orderId}`)).json()).rating, 4);
  const other = await newCustomer(ctx.base);
  assert.equal((await other.call(`/api/orders/${c.orderId}/rating`, { method: 'POST', body: { stars: 1 } })).status, 404);
});

test('shop info is public and editable; my-orders reports an unfinished draft', async (t) => {
  const ctx = await startTestApp();
  t.after(ctx.close);
  const shop = await (await api(ctx.base)('/api/shop')).json();
  assert.equal(shop.name, 'Quick Print Xerox');
  ctx.app.locals.settings.set('shop', { name: 'Sharma Xerox', phone: '+91 90000 00000' });
  const updated = await (await api(ctx.base)('/api/shop')).json();
  assert.equal(updated.name, 'Sharma Xerox');
  assert.equal(updated.open, '09:00', 'unset fields keep their defaults');

  const c = await newCustomer(ctx.base);
  const mine = await (await c.call('/api/me/orders')).json();
  assert.equal(mine.draftOrderId, c.orderId);
  assert.equal(mine.activeOrderId, null);
});

test('default rate card is a new price version and stays editable', async (t) => {
  const ctx = await startTestApp();
  t.after(ctx.close);
  const versions = ctx.db.prepare('SELECT bw1_paise, bw2_paise, col1_paise, col2_paise, active FROM price_tables ORDER BY id').all();
  assert.equal(versions.length, 2);
  assert.deepEqual(versions[1], { bw1_paise: 300, bw2_paise: 500, col1_paise: 1000, col2_paise: 1800, active: 1 });
  ctx.app.locals.pricing.setPriceTable({ bw1Paise: 200, bw2Paise: 300, col1Paise: 800, col2Paise: 1500 }, 'owner');
  assert.equal((await (await api(ctx.base)('/api/pricing')).json()).rates.bw1, 200);
});

/* ---------- customer site ---------- */

const WEB = path.resolve(__dirname, '../../web');

test('customer site is served with the strict CSP and only local scripts', async (t) => {
  const ctx = await startTestApp();
  t.after(ctx.close);
  const res = await fetch(`${ctx.base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'(;|$)/);
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  const html = await res.text();
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, 'no inline scripts');
  assert.doesNotMatch(html, /<style/i, 'no inline style blocks');
  assert.doesNotMatch(html, /\son[a-z]+=/i, 'no inline event handlers');
  for (const [, src] of html.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g)) {
    assert.doesNotMatch(src, /^(https?:)?\/\//, `external resource: ${src}`);
    assert.ok(fs.existsSync(path.join(WEB, src)), `missing file: ${src}`);
  }

  const mod = await fetch(`${ctx.base}/vendor/pdfjs/pdf.min.mjs`);
  assert.equal(mod.status, 200);
  assert.match(mod.headers.get('content-type'), /javascript/, 'module scripts need a JS MIME type');
  assert.match(mod.headers.get('cache-control'), /immutable/);
  await mod.arrayBuffer();

  assert.equal((await fetch(`${ctx.base}/shared.js`)).status, 404, 'the old localStorage mock is gone');
  assert.equal((await fetch(`${ctx.base}/api/nope`)).status, 404);
  assert.match((await (await fetch(`${ctx.base}/api/nope`)).headers.get('content-type')), /json/, 'API 404s stay JSON');
});

test('vendored libraries match their pinned checksums', () => {
  const crypto = require('node:crypto');
  const sums = fs.readFileSync(path.join(WEB, 'vendor/SHA256SUMS'), 'utf8').trim().split('\n');
  for (const line of sums) {
    const [hash, file] = line.split(/\s+/);
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(WEB, 'vendor', file))).digest('hex');
    assert.equal(actual, hash, file);
  }
});

test('customer page script has no remaining mock calls', () => {
  const js = fs.readFileSync(path.join(WEB, 'customer.js'), 'utf8');
  assert.doesNotMatch(js, /\bQP\./, 'no QP.* (localStorage mock) calls');
  assert.doesNotMatch(js, /localStorage/, 'nothing important kept in the browser');
  assert.doesNotMatch(js, /markPaid/);
});
