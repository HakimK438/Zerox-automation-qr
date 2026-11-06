'use strict';
/* Customer order endpoints: draft order, documents (phase 2), print settings, quote and checkout (phase 3). */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const express = require('express');
const { z } = require('zod');
const { validate } = require('../../middleware/validate');
const { rateLimit } = require('../../middleware/rateLimit');
const { HttpError, notFound, conflict, badRequest } = require('../../lib/errors');
const { newId } = require('../../lib/crypto');
const { formatToken } = require('../../lib/token');
const { STATUS_LABEL, ORDER_STATUS, PAPER_SIZES } = require('../../../../../shared/constants');
const { receiveSingleFile, cleanFileName } = require('../documents/receive');
const { sniffUpload } = require('../documents/sniff');

const { createOwnedOrder, UUID_RE } = require('./ownership');
const DOC_NOT_FOUND = notFound('Document not found.');

/* Print settings for one document. The browser sends choices only, never pages counts or prices
   (.strict() rejects any extra field such as amountPaise or pageCount). */
const partsBody = z.object({
  copies: z.number().int().min(1).max(500),
  parts: z.array(z.object({
    pages: z.string().trim().min(1).max(200),
    color: z.boolean(),
    duplex: z.boolean(),
    paper: z.enum(PAPER_SIZES)
  }).strict()).min(1).max(20)
}).strict();

const PIN_VISIBLE = new Set([ORDER_STATUS.PAID, ORDER_STATUS.PRINTING, ORDER_STATUS.PRINT_ATTENTION, ORDER_STATUS.READY]);

function orderRoutes({ db, config, storage, queue, session, pricing, settings, pins, printQueue, bus }) {
  const notify = (orderId) => { if (bus) bus.emit('order', orderId); };
  const router = express.Router();
  const limiters = [];
  const limit = (opts) => { const l = rateLimit(opts); limiters.push(l); return l; };

  const q = {
    order: db.prepare('SELECT * FROM orders WHERE id = ?'),
    draftOf: db.prepare("SELECT * FROM orders WHERE session_id = ? AND status = 'draft' ORDER BY created_at DESC LIMIT 1"),
    insertOrder: db.prepare(`INSERT INTO orders (id, session_id, status, created_at, updated_at) VALUES (?, ?, 'draft', ?, ?)`),
    insertEvent: db.prepare(`INSERT INTO order_events (id, order_id, from_status, to_status, actor, actor_id, created_at)
      VALUES (?, ?, NULL, 'draft', 'customer', ?, ?)`),
    docs: db.prepare('SELECT * FROM documents WHERE order_id = ? ORDER BY position, created_at'),
    doc: db.prepare('SELECT * FROM documents WHERE id = ? AND order_id = ?'),
    docCount: db.prepare('SELECT COUNT(*) FROM documents WHERE order_id = ?').pluck(),
    maxPos: db.prepare('SELECT COALESCE(MAX(position), -1) FROM documents WHERE order_id = ?').pluck(),
    insertDoc: db.prepare(`INSERT INTO documents (id, order_id, original_name, mime_detected, size_bytes, sha256, storage_key, conversion_status, position, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`),
    deleteDoc: db.prepare('DELETE FROM documents WHERE id = ?'),
    parts: db.prepare('SELECT * FROM document_parts WHERE document_id = ? ORDER BY position'),
    deleteParts: db.prepare('DELETE FROM document_parts WHERE document_id = ?'),
    insertPart: db.prepare(`INSERT INTO document_parts (id, document_id, page_ranges, color, duplex, paper, copies, position)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    touchOrder: db.prepare('UPDATE orders SET updated_at = ? WHERE id = ?')
  };

  const toDocument = (d) => ({
    documentId: d.id,
    name: d.original_name,
    sizeBytes: d.size_bytes,
    status: d.conversion_status,
    queuePosition: d.conversion_status === 'queued' ? queue.position(d) : 0,
    pageCount: d.page_count,
    filesDeleted: !!d.purged_at,
    error: d.conversion_status === 'failed' ? d.error : null,
    previewUrl: d.conversion_status === 'ready' && !d.purged_at ? `/api/orders/${d.order_id}/documents/${d.id}/preview` : null,
    ...partsOf(d.id)
  });

  function partsOf(documentId) {
    const rows = q.parts.all(documentId);
    return {
      copies: rows[0]?.copies ?? 1,
      parts: rows.map((p) => ({ partId: p.id, pages: p.page_ranges, color: !!p.color, duplex: !!p.duplex, paper: p.paper }))
    };
  }

  const toOrder = (o) => ({
    orderId: o.id,
    status: o.status,
    statusLabel: STATUS_LABEL[o.status],
    token: formatToken(o.token_no),
    // Shown only to the owner's browser, only while the order can still be collected.
    pickupPin: PIN_VISIBLE.has(o.status) && pins ? pins(o) : null,
    totalPaise: o.total_paise,
    createdAt: o.created_at,
    paidAt: o.paid_at,
    readyAt: o.ready_at,
    // Position, ETA and pause/manual state while the order is waiting or printing.
    queue: printQueue ? printQueue.infoFor(o.id) : null,
    rating: o.rating,
    documents: q.docs.all(o.id).map(toDocument)
  });

  const ownedOrder = createOwnedOrder(db);

  function ownedDocument(req, res, next) {
    const doc = UUID_RE.test(req.params.documentId) ? q.doc.get(req.params.documentId, req.order.id) : null;
    if (!doc) return next(DOC_NOT_FOUND);
    req.document = doc;
    return next();
  }

  /* Re-checked inside write transactions: a checkout may have frozen the order since requireDraft ran. */
  function assertStillDraft(orderId) {
    if (q.order.get(orderId).status !== ORDER_STATUS.DRAFT) throw conflict('This order is already submitted and can no longer be changed.');
  }

  const requireDraft = (req, res, next) =>
    req.order.status === ORDER_STATUS.DRAFT ? next() : next(conflict('This order is already submitted and can no longer be changed.'));

  // Public: current rates and options, so the page can show "Rs 3 per page" before any upload.
  router.get('/pricing', (req, res) => res.json(pricing.publicPricing()));

  // Start (or continue) this browser's draft order.
  router.post('/orders', session.required, limit({ name: 'order_create', max: 20 }), (req, res) => {
    const existing = q.draftOf.get(req.customer.sessionId);
    if (existing) return res.json(toOrder(existing));
    const id = newId();
    const at = new Date().toISOString();
    db.transaction(() => {
      q.insertOrder.run(id, req.customer.sessionId, at, at);
      q.insertEvent.run(newId(), id, req.customer.sessionId, at);
    })();
    return res.status(201).json(toOrder(q.order.get(id)));
  });

  router.get('/orders/:orderId', session.required, ownedOrder, (req, res) => res.json(toOrder(req.order)));

  // Upload one file (multipart field "file"). Returns 202: conversion continues in the background.
  router.post(
    '/orders/:orderId/documents',
    session.required,
    limit({ name: 'upload_ip', max: 60, windowMs: 10 * 60 * 1000 }),
    limit({ name: 'upload_session', max: 30, windowMs: 10 * 60 * 1000, keyFn: (req) => req.customer.sessionId }),
    ownedOrder,
    requireDraft,
    async (req, res, next) => {
      if (q.docCount.get(req.order.id) >= config.maxDocsPerOrder) {
        return next(conflict(`You can add up to ${config.maxDocsPerOrder} files per order.`));
      }
      let upload;
      try {
        upload = await receiveSingleFile(req, { maxBytes: config.maxUploadBytes, newTmpPath: storage.newTmpPath });
      } catch (err) {
        res.set('Connection', 'close'); // stop reading an oversized or broken body
        return next(err);
      }

      let key = null;
      try {
        const type = await sniffUpload(upload.tmpPath, upload.filename, upload.mimeType);
        key = await storage.adopt(upload.tmpPath);
        const docId = newId();
        const at = new Date().toISOString();
        // Re-check limits and order state atomically: parallel uploads race on the count.
        db.transaction(() => {
          const order = q.order.get(req.order.id);
          if (order.status !== ORDER_STATUS.DRAFT) throw conflict('This order is already submitted and can no longer be changed.');
          if (q.docCount.get(order.id) >= config.maxDocsPerOrder) throw conflict(`You can add up to ${config.maxDocsPerOrder} files per order.`);
          q.insertDoc.run(docId, order.id, cleanFileName(upload.filename), type.mime, upload.size, upload.sha256, key,
            q.maxPos.get(order.id) + 1, at);
          // Default settings: whole document, black & white, one side, first allowed paper, 1 copy.
          q.insertPart.run(newId(), docId, 'all', 0, 0, settings.printOptions().paperSizes[0] || 'A4', 1, 0);
          q.touchOrder.run(at, order.id);
        })();
        const doc = q.doc.get(docId, req.order.id);
        queue.enqueue(doc);
        return res.status(202).json(toDocument(q.doc.get(docId, req.order.id)));
      } catch (err) {
        await fsp.rm(upload.tmpPath, { force: true });
        if (key) await storage.remove(key);
        return next(err);
      }
    }
  );

  router.get('/orders/:orderId/documents/:documentId', session.required, ownedOrder, ownedDocument,
    (req, res) => res.json(toDocument(req.document)));

  router.delete('/orders/:orderId/documents/:documentId', session.required, ownedOrder, requireDraft, ownedDocument,
    async (req, res) => {
      db.transaction(() => { assertStillDraft(req.order.id); q.deleteDoc.run(req.document.id); })();
      await storage.remove(req.document.storage_key);
      res.status(204).end();
    });

  // Replace a document's print settings. Prices are recalculated by GET /quote, never sent by the client.
  router.put('/orders/:orderId/documents/:documentId/parts', session.required, ownedOrder, requireDraft, ownedDocument,
    validate(partsBody), (req, res, next) => {
      const { copies, parts } = req.valid.body;
      const options = settings.printOptions();
      if (copies > options.maxCopies) return next(badRequest(`Copies must be between 1 and ${options.maxCopies}.`));
      if (parts.length > options.maxPartsPerDocument) return next(badRequest(`You can split a document into at most ${options.maxPartsPerDocument} parts.`));
      const at = new Date().toISOString();
      db.transaction(() => {
        assertStillDraft(req.order.id);
        q.deleteParts.run(req.document.id);
        parts.forEach((p, i) => q.insertPart.run(newId(), req.document.id, p.pages, p.color ? 1 : 0, p.duplex ? 1 : 0, p.paper, copies, i));
        q.touchOrder.run(at, req.order.id);
      })();
      // Return the document's fresh price so the UI can update in one round trip.
      const quote = pricing.quote(q.order.get(req.order.id));
      return res.json({ document: toDocument(req.document), priced: quote.documents.find((d) => d.documentId === req.document.id), totalPaise: quote.totalPaise, ready: quote.ready });
    });

  // Authoritative quote. Live (current prices) while draft; frozen after checkout.
  router.get('/orders/:orderId/quote', session.required, ownedOrder, (req, res) => res.json(pricing.quote(req.order)));

  // Freeze the price and submit the order for payment (payment itself is phase 4).
  router.post('/orders/:orderId/checkout', session.required, limit({ name: 'checkout', max: 20 }), ownedOrder, (req, res, next) => {
    if (req.order.status === ORDER_STATUS.AWAITING_PAYMENT) {
      return res.json({ order: toOrder(req.order), quote: pricing.quote(req.order) }); // idempotent retry
    }
    if (req.order.status !== ORDER_STATUS.DRAFT) return next(conflict('This order is already submitted.'));
    const result = pricing.checkout(req.order, { actor: 'customer', actorId: req.customer.sessionId });
    if (!result.ok) {
      return next(new HttpError(409, 'not_ready', result.quote.errors[0]?.message || 'Your order is not ready yet.', { quote: result.quote }));
    }
    notify(req.order.id);
    const order = q.order.get(req.order.id);
    return res.json({ order: toOrder(order), quote: pricing.quote(order) });
  });

  // The print-ready PDF, for the customer's preview. Owner session only; never cached; sandboxed.
  router.get('/orders/:orderId/documents/:documentId/preview', session.required, ownedOrder, ownedDocument,
    (req, res, next) => {
      const d = req.document;
      if (d.conversion_status !== 'ready' || d.purged_at) return next(new HttpError(409, 'not_ready', 'This document is not ready yet.'));
      const file = storage.pdfPath(d.storage_key);
      fs.stat(file, (err, st) => {
        if (err) return next(DOC_NOT_FOUND);
        res.set({
          'Content-Type': 'application/pdf',
          'Content-Length': String(st.size),
          'Content-Disposition': 'inline; filename="document.pdf"',
          'Content-Security-Policy': 'sandbox',
          'Cache-Control': 'private, no-store'
        });
        return fs.createReadStream(file).on('error', next).pipe(res);
      });
    });

  // Customer rating, once, after the order was paid (the original frontend's star rating).
  const RATABLE = new Set([ORDER_STATUS.PAID, ORDER_STATUS.PRINTING, ORDER_STATUS.PRINT_ATTENTION, ORDER_STATUS.READY, ORDER_STATUS.HANDED_OVER]);
  const ratingBody = z.object({ stars: z.number().int().min(1).max(5) }).strict();
  const rate = db.prepare('UPDATE orders SET rating = ?, rated_at = ? WHERE id = ? AND rating IS NULL');
  router.post('/orders/:orderId/rating', session.required, ownedOrder, validate(ratingBody), (req, res, next) => {
    if (!RATABLE.has(req.order.status)) return next(conflict('You can rate an order after paying for it.'));
    if (!rate.run(req.valid.body.stars, new Date().toISOString(), req.order.id).changes) return next(conflict('This order is already rated.'));
    return res.json({ rating: req.valid.body.stars });
  });

  router.views = { order: toOrder, document: toDocument };
  router.stop = () => limiters.forEach((l) => l.stop());
  return router;
}

module.exports = { orderRoutes };
