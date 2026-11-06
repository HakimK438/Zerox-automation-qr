'use strict';
/* Shop dashboard data and actions (plan C7). Every change runs in one DB transaction that writes the
   order event and an audit row; the realtime bus is notified after commit.
   Nothing here can move an order to "paid": canTransition(..., 'admin') forbids it. */
const { newId, safeEqual } = require('../../lib/crypto');
const { formatToken, parseToken, istDate } = require('../../lib/token');
const { conflict, notFound, badRequest, HttpError } = require('../../lib/errors');
const { hashRecoveryPin } = require('../orders/recovery');
const { ORDER_STATUS: S, STATUS_LABEL, canTransition } = require('../../../../../shared/constants');

const MAX_HANDOVER_FAILURES = 5;
const ADMIN_SETTABLE = new Set([S.PRINTING, S.READY, S.PRINT_ATTENTION]);
/* Orders that need the shop's hands (the "Now" screen). */
const WORK_STATUSES = [S.PAID, S.PRINTING, S.PRINT_ATTENTION, S.READY, S.REFUND_PENDING];

function createAdminService({ db, printQueue, dispatcher = null, notify = () => {}, now = () => Date.now() }) {
  const iso = () => new Date(now()).toISOString();
  const list = (arr) => arr.map(() => '?').join(',');
  const q = {
    order: db.prepare('SELECT * FROM orders WHERE id = ?'),
    work: db.prepare(`SELECT * FROM orders WHERE status IN (${list(WORK_STATUSES)}) ORDER BY paid_at, id`),
    byDate: db.prepare('SELECT * FROM orders WHERE token_date = ? AND paid_at IS NOT NULL ORDER BY token_no DESC LIMIT 1000'),
    attention: db.prepare(`SELECT * FROM orders WHERE paid_at IS NOT NULL AND (needs_attention IS NOT NULL
        OR status IN ('print_attention','refund_pending')
        OR id IN (SELECT order_id FROM payments WHERE needs_refund = 1))
      ORDER BY paid_at DESC LIMIT 200`),
    byToken: db.prepare('SELECT * FROM orders WHERE token_no = ? AND token_date >= ? ORDER BY token_date DESC LIMIT 10'),
    summaries: db.prepare(`SELECT d.order_id AS orderId, COUNT(DISTINCT d.id) AS docs, SUM(p.sides * 1) AS sides, SUM(p.sheets) AS sheets,
        MAX(p.color) AS anyColor, MIN(p.color) AS allColor, MAX(p.duplex) AS anyDuplex, MAX(p.paper = 'A3') AS anyA3, MAX(p.copies) AS copies
      FROM documents d LEFT JOIN document_parts p ON p.document_id = d.id
      WHERE d.order_id IN (SELECT value FROM json_each(?)) GROUP BY d.order_id`),
    docs: db.prepare('SELECT * FROM documents WHERE order_id = ? ORDER BY position, created_at'),
    doc: db.prepare('SELECT * FROM documents WHERE id = ? AND order_id = ?'),
    parts: db.prepare('SELECT * FROM document_parts WHERE document_id = ? ORDER BY position'),
    payments: db.prepare('SELECT * FROM payments WHERE order_id = ? ORDER BY created_at'),
    refunds: db.prepare('SELECT * FROM refunds WHERE order_id = ? ORDER BY created_at'),
    events: db.prepare('SELECT * FROM order_events WHERE order_id = ? ORDER BY created_at, rowid LIMIT 200'),
    setStatus: db.prepare(`UPDATE orders SET status = ?, updated_at = ?,
        printing_at = CASE WHEN ? = 'printing' THEN ? ELSE printing_at END,
        ready_at = CASE WHEN ? = 'ready' THEN ? ELSE ready_at END,
        needs_attention = CASE WHEN ? IN ('printing','ready') THEN NULL ELSE needs_attention END
      WHERE id = ? AND status = ?`),
    handover: db.prepare(`UPDATE orders SET status = 'handed_over', handed_over_at = ?, updated_at = ?, needs_attention = NULL
      WHERE id = ? AND status = 'ready'`),
    pinFail: db.prepare('UPDATE orders SET handover_failures = handover_failures + 1 WHERE id = ?'),
    event: db.prepare(`INSERT INTO order_events (id, order_id, from_status, to_status, actor, actor_id, reason, created_at)
      VALUES (?, ?, ?, ?, 'admin', ?, ?, ?)`),
    audit: db.prepare(`INSERT INTO audit_logs (id, actor, actor_id, action, order_id, details, ip, created_at)
      VALUES (?, 'admin', ?, ?, ?, ?, ?, ?)`),
    auditList: db.prepare(`SELECT a.*, u.username FROM audit_logs a LEFT JOIN admin_users u ON u.id = a.actor_id
      WHERE (? IS NULL OR a.created_at < ?) ORDER BY a.created_at DESC, a.rowid DESC LIMIT ?`),
    flaggedPayments: db.prepare(`SELECT p.*, o.token_no, o.token_date, o.status AS order_status,
        (SELECT r.status FROM refunds r WHERE r.payment_id = p.id ORDER BY r.created_at DESC LIMIT 1) AS refund_status
      FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.needs_refund = 1
        AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.payment_id = p.id AND r.status = 'success')
      ORDER BY p.updated_at DESC LIMIT 100`)
  };

  const audit = (adminId, action, orderId, details, ip) =>
    q.audit.run(newId(), adminId, action, orderId || null, JSON.stringify(details || {}), ip || null, iso());

  /* ---------- views ---------- */

  function summariesFor(orders) {
    const map = new Map();
    if (!orders.length) return map;
    for (const s of q.summaries.all(JSON.stringify(orders.map((o) => o.id)))) map.set(s.orderId, s);
    return map;
  }

  function orderSummary(o, s) {
    return {
      orderId: o.id,
      token: formatToken(o.token_no),
      tokenDate: o.token_date,
      status: o.status,
      statusLabel: STATUS_LABEL[o.status],
      totalPaise: o.total_paise,
      paidAt: o.paid_at,
      printingAt: o.printing_at,
      readyAt: o.ready_at,
      handedOverAt: o.handed_over_at,
      needsAttention: o.needs_attention,
      printMode: o.print_mode_snapshot,
      rating: o.rating,
      pinLocked: o.handover_failures >= MAX_HANDOVER_FAILURES,
      docs: s?.docs ?? 0,
      sides: s?.sides ?? 0,
      sheets: s?.sheets ?? 0,
      color: s ? (s.allColor ? 'color' : (s.anyColor ? 'mixed' : 'bw')) : 'bw',
      duplex: !!s?.anyDuplex,
      a3: !!s?.anyA3,
      copies: s?.copies ?? 1,
      queue: printQueue.infoFor(o.id)
    };
  }

  const summarize = (orders) => {
    const sums = summariesFor(orders);
    return orders.map((o) => orderSummary(o, sums.get(o.id)));
  };

  function listOrders({ view, date, token }) {
    if (token) {
      const n = parseToken(token);
      if (n === null) return [];
      return summarize(q.byToken.all(n, istDate(now(), -7)));
    }
    if (view === 'today') return summarize(q.byDate.all(istDate(now())));
    if (view === 'history') return summarize(q.byDate.all(date || istDate(now())));
    if (view === 'attention') return summarize(q.attention.all());
    return summarize(q.work.all(...WORK_STATUSES));
  }

  function counts() {
    const work = q.work.all(...WORK_STATUSES);
    const by = (st) => work.filter((o) => o.status === st).length;
    return {
      waiting: by(S.PAID),
      printing: by(S.PRINTING),
      attention: q.attention.all().length,
      ready: by(S.READY),
      today: db.prepare("SELECT COUNT(*) FROM orders WHERE token_date = ? AND paid_at IS NOT NULL").pluck().get(istDate(now()))
    };
  }

  function orderDetail(orderId) {
    const o = q.order.get(orderId);
    if (!o || !o.paid_at) return null; // unpaid drafts are the customer's business only
    const [summary] = summarize([o]);
    return {
      ...summary,
      createdAt: o.created_at,
      handoverFailures: o.handover_failures,
      documents: q.docs.all(o.id).map((d) => ({
        documentId: d.id,
        name: d.original_name,
        sizeBytes: d.size_bytes,
        pageCount: d.page_count,
        status: d.conversion_status,
        purged: !!d.purged_at,
        purgedAt: d.purged_at,
        pdfUrl: d.conversion_status === 'ready' && !d.purged_at ? `/api/admin/orders/${o.id}/documents/${d.id}/pdf` : null,
        parts: q.parts.all(d.id).map((p) => ({
          pages: p.page_ranges, color: !!p.color, duplex: !!p.duplex, paper: p.paper, copies: p.copies,
          sides: p.sides, sheets: p.sheets, ratePaise: p.rate_paise, amountPaise: p.amount_paise
        }))
      })),
      payments: q.payments.all(o.id).map((p) => ({
        paymentId: p.id, status: p.status, amountPaise: p.amount_paise, txnId: p.txn_id, bankTxnId: p.bank_txn_id,
        mode: p.payment_mode, paidAt: p.paid_at, needsRefund: !!p.needs_refund, resultMsg: p.result_msg
      })),
      refunds: q.refunds.all(o.id).map((r) => ({
        refundId: r.id, paymentId: r.payment_id, status: r.status, amountPaise: r.amount_paise, reason: r.reason, createdAt: r.created_at, providerRef: r.provider_ref
      })),
      printJobs: dispatcher ? dispatcher.jobsFor(o.id) : [],
      events: q.events.all(o.id).map((e) => ({ from: e.from_status, to: e.to_status, actor: e.actor, reason: e.reason, at: e.created_at }))
    };
  }

  const document = (orderId, documentId) => {
    const o = q.order.get(orderId);
    return o && o.paid_at ? q.doc.get(documentId, orderId) : null;
  };

  /* ---------- actions ---------- */

  function setStatus({ orderId, to, reason, admin, ip }) {
    if (!ADMIN_SETTABLE.has(to)) throw badRequest('This status cannot be set from the dashboard.');
    let from = null;
    const updated = db.transaction(() => {
      const o = q.order.get(orderId);
      if (!o || !o.paid_at) throw notFound('Order not found.');
      from = o.status;
      if (o.status === to) return o; // double click: nothing to do
      if (!canTransition(o.status, to, 'admin')) throw conflict(`Cannot change "${STATUS_LABEL[o.status]}" to "${STATUS_LABEL[to]}".`);
      const at = iso();
      q.setStatus.run(to, at, to, at, to, at, to, o.id, o.status);
      const why = reason ? String(reason).slice(0, 200) : (o.status === S.READY && to === S.PRINTING ? 'reprint' : null);
      q.event.run(newId(), o.id, o.status, to, admin.userId, why, at);
      audit(admin.userId, 'order_status', o.id, { from: o.status, to, reason: why }, ip);
      return q.order.get(o.id);
    })();
    // Hand the order to the print agent (if one is set up). From ready/attention this is a reprint.
    if (to === S.PRINTING && dispatcher && from !== S.PRINTING) {
      dispatcher.startOrder(orderId, { reprint: from !== S.PAID, adminId: admin.userId });
    }
    notify(orderId);
    return q.order.get(orderId);
  }

  /**
   * Handover at the counter. Normal path: the customer's 4-digit PIN.
   * Fallback (lost phone, or PIN locked after 5 wrong tries): the owner's password plus a reason, audited.
   */
  function handover({ orderId, pin, override, admin, ip }) {
    const result = db.transaction(() => {
      const o = q.order.get(orderId);
      if (!o || !o.paid_at) throw notFound('Order not found.');
      if (o.status === S.HANDED_OVER) return { order: o };
      if (!canTransition(o.status, S.HANDED_OVER, 'admin')) throw conflict('Mark the order as ready before handing it over.');

      let method;
      if (override) {
        method = 'override';
      } else {
        if (o.handover_failures >= MAX_HANDOVER_FAILURES) {
          throw new HttpError(423, 'pin_locked', 'Too many wrong PINs. Use "Hand over without PIN" with the owner password.');
        }
        if (!o.recovery_pin_hash || !safeEqual(hashRecoveryPin(o.id, pin), o.recovery_pin_hash)) {
          q.pinFail.run(o.id);
          audit(admin.userId, 'handover_wrong_pin', o.id, { failures: o.handover_failures + 1 }, ip);
          return { wrongPin: true, left: Math.max(0, MAX_HANDOVER_FAILURES - o.handover_failures - 1) };
        }
        method = 'pin';
      }
      const at = iso();
      q.handover.run(at, at, o.id);
      q.event.run(newId(), o.id, o.status, S.HANDED_OVER, admin.userId, method === 'override' ? `override: ${override.reason}` : 'pin', at);
      audit(admin.userId, 'handover', o.id, { method, ...(override ? { reason: override.reason } : {}) }, ip);
      return { order: q.order.get(o.id) };
    })();
    if (result.wrongPin) {
      throw new HttpError(400, 'wrong_pin', result.left ? `Wrong PIN. ${result.left} tries left.` : 'Wrong PIN. The PIN is now locked for this order.');
    }
    notify(orderId);
    return result.order;
  }

  /* ---------- reports & audit ---------- */

  /** One IST day: what was sold, refunded and printed. Base of the reconciliation report (phase 8). */
  function dailyReport(date) {
    const d = date || istDate(now());
    const one = (sql, ...args) => db.prepare(sql).get(...args);
    const orders = one(`SELECT COUNT(*) AS n, COALESCE(SUM(total_paise), 0) AS billed, AVG(rating) AS rating, COUNT(rating) AS ratings
      FROM orders WHERE token_date = ? AND paid_at IS NOT NULL`, d);
    const byStatus = Object.fromEntries(db.prepare(`SELECT status, COUNT(*) AS n FROM orders
      WHERE token_date = ? AND paid_at IS NOT NULL GROUP BY status`).all(d).map((r) => [r.status, r.n]));
    const received = one(`SELECT COUNT(*) AS n, COALESCE(SUM(p.amount_paise), 0) AS paise FROM payments p
      JOIN orders o ON o.id = p.order_id WHERE p.status = 'success' AND o.token_date = ?`, d);
    const refunded = one(`SELECT COUNT(*) AS n, COALESCE(SUM(r.amount_paise), 0) AS paise FROM refunds r
      JOIN orders o ON o.id = r.order_id WHERE r.status = 'success' AND o.token_date = ?`, d);
    const refundPending = one(`SELECT COUNT(*) AS n, COALESCE(SUM(r.amount_paise), 0) AS paise FROM refunds r
      JOIN orders o ON o.id = r.order_id WHERE r.status = 'pending' AND o.token_date = ?`, d);
    const printed = one(`SELECT COALESCE(SUM(CASE WHEN p.color = 0 THEN p.sides END), 0) AS bwSides,
        COALESCE(SUM(CASE WHEN p.color = 1 THEN p.sides END), 0) AS colorSides, COALESCE(SUM(p.sheets), 0) AS sheets
      FROM document_parts p JOIN documents doc ON doc.id = p.document_id JOIN orders o ON o.id = doc.order_id
      WHERE o.token_date = ? AND o.status IN ('printing','ready','handed_over')`, d);
    const flagged = q.flaggedPayments.all();
    return {
      date: d,
      orders: orders.n,
      byStatus,
      billedPaise: orders.billed,
      receivedPaise: received.paise,
      payments: received.n,
      refundedPaise: refunded.paise,
      refunds: refunded.n,
      refundPendingPaise: refundPending.paise,
      netPaise: received.paise - refunded.paise,
      printed,
      rating: orders.ratings ? Math.round(orders.rating * 10) / 10 : null,
      ratings: orders.ratings,
      // Money taken without a matching order (paid after expiry/cancel): must be refunded or explained.
      flaggedPayments: flagged.map((p) => ({ paymentId: p.id, orderId: p.order_id, token: formatToken(p.token_no), tokenDate: p.token_date,
        orderStatus: p.order_status, amountPaise: p.amount_paise, txnId: p.txn_id, at: p.updated_at, refundStatus: p.refund_status })),
      reconciliation: reconcile(d, received.paise, orders.billed)
    };
  }

  /* Money in vs orders vs work done, for one day. Every rupee received must belong to a paid order,
     and every paid order should end up printed and collected (or refunded). */
  function reconcile(d, receivedPaise, billedPaise) {
    const one = (sql, ...a) => db.prepare(sql).pluck().get(...a);
    return {
      receivedPaise,
      billedPaise,
      differencePaise: receivedPaise - billedPaise, // > 0: extra money taken (see flagged payments)
      paidOrders: one("SELECT COUNT(*) FROM orders WHERE token_date = ? AND paid_at IS NOT NULL", d),
      printedOrders: one(`SELECT COUNT(*) FROM orders WHERE token_date = ? AND paid_at IS NOT NULL AND (printing_at IS NOT NULL OR ready_at IS NOT NULL)`, d),
      collectedOrders: one("SELECT COUNT(*) FROM orders WHERE token_date = ? AND status = 'handed_over'", d),
      refundedOrders: one("SELECT COUNT(*) FROM orders WHERE token_date = ? AND status IN ('refund_pending','refunded')", d),
      reprintedJobs: one("SELECT COUNT(*) FROM print_jobs j JOIN orders o ON o.id = j.order_id WHERE o.token_date = ? AND j.is_reprint = 1", d),
      failedJobs: one("SELECT COUNT(*) FROM print_jobs j JOIN orders o ON o.id = j.order_id WHERE o.token_date = ? AND j.status IN ('failed','uncertain')", d)
    };
  }

  /** Things the owner should look at now, across all days. */
  function problems() {
    const t = now();
    const ago = (h) => new Date(t - h * 3600000).toISOString();
    const rows = (sql, ...a) => db.prepare(sql).all(...a);
    const item = (kind, o, text) => ({ kind, orderId: o.id, token: formatToken(o.token_no), tokenDate: o.token_date, status: o.status, totalPaise: o.total_paise, text });
    const out = [];
    for (const o of rows("SELECT * FROM orders WHERE status = 'paid' AND paid_at <= ? ORDER BY paid_at LIMIT 50", ago(2))) {
      out.push(item('not_printed', o, 'Paid over 2 hours ago and not printed yet'));
    }
    for (const o of rows("SELECT * FROM orders WHERE status = 'ready' AND ready_at <= ? ORDER BY ready_at LIMIT 50", ago(72))) {
      out.push(item('not_collected', o, 'Ready for over 3 days and not collected'));
    }
    for (const o of rows("SELECT * FROM orders WHERE status = 'print_attention' ORDER BY updated_at LIMIT 50")) {
      out.push(item('attention', o, 'Needs attention'));
    }
    for (const o of rows(`SELECT o.* FROM orders o JOIN refunds r ON r.order_id = o.id
        WHERE r.status = 'pending' AND r.created_at <= ? GROUP BY o.id LIMIT 50`, ago(24))) {
      out.push(item('refund_slow', o, 'Refund pending for over 24 hours: check Paytm'));
    }
    for (const p of q.flaggedPayments.all()) {
      out.push({ kind: 'extra_payment', orderId: p.order_id, paymentId: p.id, token: formatToken(p.token_no), tokenDate: p.token_date, status: p.order_status,
        totalPaise: p.amount_paise, refundStatus: p.refund_status, text: p.refund_status === 'pending' ? 'Extra payment: refund in progress' : 'Extra payment received: refund it' });
    }
    return out;
  }

  /** One line per paid order of the day, for the accountant. Cells are made safe for spreadsheets. */
  function dailyCsv(date) {
    const d = date || istDate(now());
    const cell = (v) => {
      let s = v == null ? '' : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // no formulas when opened in Excel
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rowsData = db.prepare(`SELECT o.*, p.txn_id, p.payment_mode, p.amount_paise AS paid_paise,
        (SELECT COALESCE(SUM(amount_paise), 0) FROM refunds r WHERE r.order_id = o.id AND r.status = 'success') AS refunded_paise,
        (SELECT COALESCE(SUM(CASE WHEN dp.color = 0 THEN dp.sides END), 0) FROM document_parts dp JOIN documents dd ON dd.id = dp.document_id WHERE dd.order_id = o.id) AS bw_sides,
        (SELECT COALESCE(SUM(CASE WHEN dp.color = 1 THEN dp.sides END), 0) FROM document_parts dp JOIN documents dd ON dd.id = dp.document_id WHERE dd.order_id = o.id) AS color_sides
      FROM orders o LEFT JOIN payments p ON p.order_id = o.id AND p.status = 'success' AND p.needs_refund = 0
      WHERE o.token_date = ? AND o.paid_at IS NOT NULL ORDER BY o.token_no`).all(d);
    const rupees = (p) => (p / 100).toFixed(2);
    const lines = [['date', 'token', 'paid_at', 'status', 'amount_inr', 'refunded_inr', 'paytm_txn_id', 'payment_mode', 'bw_pages', 'colour_pages', 'collected_at'].join(',')];
    for (const r of rowsData) {
      lines.push([d, formatToken(r.token_no), r.paid_at, r.status, rupees(r.total_paise), rupees(r.refunded_paise), r.txn_id, r.payment_mode, r.bw_sides, r.color_sides, r.handed_over_at].map(cell).join(','));
    }
    return `${lines.join('\r\n')}\r\n`;
  }

  function auditLog({ limit = 100, before = null }) {
    return q.auditList.all(before, before, Math.min(500, limit)).map((a) => {
      let details = {};
      try { details = JSON.parse(a.details); } catch { /* keep {} */ }
      return { at: a.created_at, actor: a.actor, user: a.username || null, action: a.action, orderId: a.order_id, details, ip: a.ip };
    });
  }

  return { listOrders, counts, orderDetail, problems, dailyCsv, orderSummary: (o) => summarize([o])[0], document, setStatus, handover, dailyReport, auditLog, audit };
}

module.exports = { createAdminService, MAX_HANDOVER_FAILURES, WORK_STATUSES };
