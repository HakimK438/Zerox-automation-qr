'use strict';
/* THE price function (plan C3). Prices are computed only here, only from server-measured page
   counts and the active versioned price table. The browser never sends a price or a page count.

   Rates (paise): bw1/col1 = one side, per printed page; bw2/col2 = both sides, charged per sheet or
   per printed side depending on price_tables.duplex_basis. A3 multiplies the rate. */
const { parseRanges, RangeError } = require('./ranges');
const { newId } = require('../../lib/crypto');
const { ORDER_STATUS, canTransition } = require('../../../../../shared/constants');

function rateFor(table, { color, duplex, paper }) {
  const base = color ? (duplex ? table.col2_paise : table.col1_paise) : (duplex ? table.bw2_paise : table.bw1_paise);
  return paper === 'A3' ? Math.round(base * table.a3_multiplier) : base;
}

/**
 * Pure pricing of one document's parts. Never throws for customer mistakes: errors are returned
 * per part so the UI can show them next to the right input.
 * @param {Array<{pages:string,color:boolean,duplex:boolean,paper:string,copies:number}>} parts
 * @param {number} pageCount server-measured page count of the converted PDF
 * @param {object} table price_tables row
 * @param {{maxCopies:number,paperSizes:string[],allowRanges:boolean}} options
 */
function priceDocument(parts, pageCount, table, options) {
  const seen = new Set();
  let amountPaise = 0;
  let sides = 0;
  let sheets = 0;
  let error = null;

  const lines = parts.map((part) => {
    const line = { ...part, pageCount: 0, sides: 0, sheets: 0, ratePaise: 0, amountPaise: 0, error: null };
    try {
      if (!options.paperSizes.includes(part.paper)) throw new RangeError(`${part.paper} paper is not available.`);
      if (!Number.isInteger(part.copies) || part.copies < 1 || part.copies > options.maxCopies) {
        throw new RangeError(`Copies must be between 1 and ${options.maxCopies}.`);
      }
      if (!options.allowRanges && String(part.pages).trim().toLowerCase() !== 'all') {
        throw new RangeError('This shop prints whole documents only.');
      }
      const pages = parseRanges(part.pages, pageCount);
      const dup = pages.find((p) => seen.has(p));
      if (dup !== undefined) throw new RangeError(`Page ${dup} is in more than one part.`);
      pages.forEach((p) => seen.add(p));
      if (part.duplex && pages.length < 2) throw new RangeError('Both sides needs at least 2 pages.');

      const n = pages.length;
      const sheetsPerCopy = part.duplex ? Math.ceil(n / 2) : n;
      line.pageCount = n;
      line.sides = n * part.copies;
      line.sheets = sheetsPerCopy * part.copies;
      line.ratePaise = rateFor(table, part);
      const units = part.duplex && table.duplex_basis === 'sheet' ? sheetsPerCopy : n;
      line.amountPaise = units * part.copies * line.ratePaise;
    } catch (err) {
      if (!(err instanceof RangeError)) throw err;
      line.error = err.message;
      error = error || err.message;
    }
    amountPaise += line.amountPaise;
    sides += line.sides;
    sheets += line.sheets;
    return line;
  });

  if (parts.length === 0) error = 'Choose which pages to print.';
  return { parts: lines, amountPaise, sides, sheets, error };
}

function createPricingService({ db, settings, now = () => Date.now() }) {
  const q = {
    active: db.prepare('SELECT * FROM price_tables WHERE active = 1'),
    table: db.prepare('SELECT * FROM price_tables WHERE id = ?'),
    deactivate: db.prepare('UPDATE price_tables SET active = 0 WHERE active = 1'),
    insertTable: db.prepare(`INSERT INTO price_tables (id, bw1_paise, bw2_paise, col1_paise, col2_paise, a3_multiplier, duplex_basis, active, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`),
    docs: db.prepare('SELECT * FROM documents WHERE order_id = ? ORDER BY position, created_at'),
    parts: db.prepare('SELECT * FROM document_parts WHERE document_id = ? ORDER BY position'),
    freezePart: db.prepare('UPDATE document_parts SET pages = ?, sides = ?, sheets = ?, rate_paise = ?, amount_paise = ? WHERE id = ?'),
    freezeOrder: db.prepare(`UPDATE orders SET status = ?, total_paise = ?, price_table_id = ?, checkout_at = ?, updated_at = ?
      WHERE id = ? AND status = 'draft'`),
    event: db.prepare(`INSERT INTO order_events (id, order_id, from_status, to_status, actor, actor_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
  };

  function activeTable() {
    const t = q.active.get();
    if (!t) throw new Error('No active price table.');
    return t;
  }

  /** Creates a new price version and makes it active. Old orders keep their frozen prices. */
  const setPriceTable = db.transaction(({ bw1Paise, bw2Paise, col1Paise, col2Paise, a3Multiplier = 2, duplexBasis = 'sheet' }, createdBy) => {
    const id = newId();
    q.deactivate.run();
    q.insertTable.run(id, bw1Paise, bw2Paise, col1Paise, col2Paise, a3Multiplier, duplexBasis, createdBy, new Date(now()).toISOString());
    return q.table.get(id);
  });

  function publicPricing() {
    const t = activeTable();
    const options = settings.printOptions();
    return {
      currency: 'INR',
      rates: { bw1: t.bw1_paise, bw2: t.bw2_paise, col1: t.col1_paise, col2: t.col2_paise },
      duplexBasis: t.duplex_basis,
      a3Multiplier: t.a3_multiplier,
      options: { maxCopies: options.maxCopies, paperSizes: options.paperSizes, allowRanges: options.allowRanges, maxPartsPerDocument: options.maxPartsPerDocument }
    };
  }

  const partInput = (row) => ({ partId: row.id, pages: row.page_ranges, color: !!row.color, duplex: !!row.duplex, paper: row.paper, copies: row.copies });

  /** Live quote of a draft order, computed from current prices. */
  function liveQuote(order) {
    const table = activeTable();
    const options = settings.printOptions();
    const errors = [];
    let ready = true;
    let totalPaise = 0;
    let sides = 0;
    let sheets = 0;

    const documents = q.docs.all(order.id).map((d) => {
      const partRows = q.parts.all(d.id);
      const doc = { documentId: d.id, name: d.original_name, status: d.conversion_status, pageCount: d.page_count, parts: [], amountPaise: 0, error: null };
      if (d.conversion_status !== 'ready') {
        ready = false;
        doc.parts = partRows.map((r) => ({ ...partInput(r), pageCount: 0, sides: 0, sheets: 0, ratePaise: 0, amountPaise: 0, error: null }));
        doc.error = d.conversion_status === 'failed' ? (d.error || 'This file could not be prepared. Please remove it.') : null;
        if (doc.error) errors.push({ documentId: d.id, message: doc.error });
        return doc;
      }
      const priced = priceDocument(partRows.map(partInput), d.page_count, table, options);
      doc.parts = priced.parts;
      doc.amountPaise = priced.amountPaise;
      doc.error = priced.error;
      if (priced.error) { ready = false; errors.push({ documentId: d.id, message: priced.error }); }
      totalPaise += priced.amountPaise;
      sides += priced.sides;
      sheets += priced.sheets;
      return doc;
    });

    if (documents.length === 0) { ready = false; errors.push({ documentId: null, message: 'Add at least one document.' }); }
    return { orderId: order.id, frozen: false, ready, currency: 'INR', priceTableId: table.id, totalPaise, sides, sheets, documents, errors };
  }

  /** Quote stored at checkout: never recomputed, so later price changes cannot affect it. */
  function frozenQuote(order) {
    let sides = 0;
    let sheets = 0;
    const documents = q.docs.all(order.id).map((d) => {
      const parts = q.parts.all(d.id).map((r) => {
        sides += r.sides || 0;
        sheets += r.sheets || 0;
        return { ...partInput(r), pageCount: r.pages, sides: r.sides, sheets: r.sheets, ratePaise: r.rate_paise, amountPaise: r.amount_paise, error: null };
      });
      return { documentId: d.id, name: d.original_name, status: d.conversion_status, pageCount: d.page_count, parts,
        amountPaise: parts.reduce((s, p) => s + (p.amountPaise || 0), 0), error: null };
    });
    return { orderId: order.id, frozen: true, ready: true, currency: 'INR', priceTableId: order.price_table_id,
      totalPaise: order.total_paise, sides, sheets, documents, errors: [] };
  }

  const quote = (order) => (order.status === ORDER_STATUS.DRAFT ? liveQuote(order) : frozenQuote(order));

  /**
   * Freezes the live quote onto the order and moves it draft -> awaiting_payment, atomically.
   * @returns {{ ok: true, quote } | { ok: false, quote }}
   */
  const checkout = db.transaction((order, { actor = 'customer', actorId = null } = {}) => {
    if (!canTransition(order.status, ORDER_STATUS.AWAITING_PAYMENT, actor)) throw new Error(`checkout not allowed from ${order.status} by ${actor}`);
    const live = liveQuote(order);
    if (!live.ready || live.totalPaise <= 0) return { ok: false, quote: live };
    const at = new Date(now()).toISOString();
    for (const d of live.documents) {
      for (const p of d.parts) q.freezePart.run(p.pageCount, p.sides, p.sheets, p.ratePaise, p.amountPaise, p.partId);
    }
    const changed = q.freezeOrder.run(ORDER_STATUS.AWAITING_PAYMENT, live.totalPaise, live.priceTableId, at, at, order.id).changes;
    if (!changed) return { ok: false, quote: live }; // status changed concurrently
    q.event.run(newId(), order.id, ORDER_STATUS.DRAFT, ORDER_STATUS.AWAITING_PAYMENT, actor, actorId, at);
    return { ok: true, quote: { ...live, frozen: true } };
  });

  return { activeTable, setPriceTable, publicPricing, quote, checkout };
}

module.exports = { createPricingService, priceDocument, rateFor };
