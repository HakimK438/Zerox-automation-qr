'use strict';
const express = require('express');
const { z } = require('zod');
const { validate } = require('../../middleware/validate');
const { rateLimit } = require('../../middleware/rateLimit');
const { HttpError } = require('../../lib/errors');
const { formatToken, parseToken } = require('../../lib/token');
const { STATUS_LABEL, ACTIVE_ORDER_STATUSES } = require('../../../../../shared/constants');

const recoverBody = z.object({
  token: z.string().trim().min(1).max(20),
  pin: z.string().regex(/^\d{4}$/, 'PIN must be 4 digits.')
}).strict();

const NO_MATCH = new HttpError(404, 'not_found', 'No active order matches that token and PIN.');
const LOCKED = new HttpError(423, 'locked', 'Too many wrong PINs for this token. Please ask at the counter.');

function sessionRoutes({ db, sessions, recovery, session }) {
  const router = express.Router();
  const limiters = [];
  const limit = (opts) => { const l = rateLimit(opts); limiters.push(l); return l; };

  const myOrders = db.prepare(`
    SELECT id, status, total_paise, token_no, token_date, created_at, paid_at, ready_at, handed_over_at
    FROM orders WHERE session_id = ? AND status <> 'draft'
    ORDER BY created_at DESC LIMIT 50`);

  const draftOf = db.prepare("SELECT id FROM orders WHERE session_id = ? AND status = 'draft' ORDER BY created_at DESC LIMIT 1");

  const toSummary = (r) => ({
    orderId: r.id,
    status: r.status,
    statusLabel: STATUS_LABEL[r.status],
    active: ACTIVE_ORDER_STATUSES.includes(r.status),
    token: formatToken(r.token_no),
    tokenDate: r.token_date,
    totalPaise: r.total_paise,
    createdAt: r.created_at,
    paidAt: r.paid_at,
    readyAt: r.ready_at,
    handedOverAt: r.handed_over_at
  });

  // Create, or reuse the caller's existing session. Called on every page load.
  router.post('/session', limit({ name: 'session_create', max: 20 }), (req, res) => {
    if (req.customer) {
      return res.json({ expiresAt: req.customer.expiresAt, created: false });
    }
    const s = sessions.create();
    session.issue(res, s.token);
    return res.status(201).json({ expiresAt: s.expiresAt, created: true });
  });

  router.get('/session', session.required, (req, res) => {
    res.json({ expiresAt: req.customer.expiresAt });
  });

  // Returning visitors: list this browser's orders so the page can reopen an active one.
  router.get('/me/orders', session.required, (req, res) => {
    const orders = myOrders.all(req.customer.sessionId).map(toSummary);
    // An unfinished draft (files uploaded, not yet submitted) is restored too, without creating one per visit.
    const draft = draftOf.get(req.customer.sessionId);
    res.json({ orders, activeOrderId: orders.find((o) => o.active)?.orderId ?? null, draftOrderId: draft ? draft.id : null });
  });

  // Token + PIN recovery. Limited per IP and per token number (so rotating IPs doesn't help),
  // with a durable lockout per order inside the service.
  router.post(
    '/orders/recover',
    limit({ name: 'recover_ip', max: 5, windowMs: 15 * 60 * 1000 }),
    validate(recoverBody),
    limit({ name: 'recover_token', max: 5, windowMs: 15 * 60 * 1000, keyFn: (req) => String(parseToken(req.valid.body.token)) }),
    (req, res, next) => {
      const tokenNo = parseToken(req.valid.body.token);
      if (tokenNo === null) return next(NO_MATCH);

      let sessionId = req.customer?.sessionId;
      if (!sessionId) {
        const s = sessions.create();
        session.issue(res, s.token);
        sessionId = s.id;
      }
      const result = recovery.recover({ tokenNo, pin: req.valid.body.pin, sessionId, ip: req.ip });
      if (!result.ok) return next(result.reason === 'locked' ? LOCKED : NO_MATCH);
      return res.json({ orderId: result.orderId });
    }
  );

  router.stop = () => limiters.forEach((l) => l.stop());
  return router;
}

module.exports = { sessionRoutes };
