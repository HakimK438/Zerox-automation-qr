'use strict';
/* /api/admin/* (plan C7). Mounted only on the admin host (app.js). Every route except login needs an
   admin session; every write also needs the CSRF header; money and price changes need the password again. */
const fs = require('node:fs');
const express = require('express');
const { z } = require('zod');
const { validate } = require('../../middleware/validate');
const { rateLimit } = require('../../middleware/rateLimit');
const { HttpError, notFound, forbidden } = require('../../lib/errors');
const { UUID_RE } = require('../orders/ownership');
const { PAPER_SIZES } = require('../../../../../shared/constants');

const loginBody = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(200),
  otp: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app.')
}).strict();

const password = z.string().min(1).max(200);
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour).');

/* Every editable setting, validated. Unknown fields are rejected. */
const SETTING_SCHEMAS = {
  shop: z.object({
    name: z.string().trim().min(1).max(60),
    address: z.string().trim().max(200),
    phone: z.string().trim().regex(/^[0-9+\-\s()]{0,20}$/, 'Phone may contain digits, spaces, + - ( ).'),
    open: hhmm,
    close: hhmm
  }).strict(),
  print_options: z.object({
    maxCopies: z.number().int().min(1).max(500),
    paperSizes: z.array(z.enum(PAPER_SIZES)).min(1).max(PAPER_SIZES.length)
      .refine((a) => a.includes('A4'), 'A4 must stay available.').transform((a) => [...new Set(a)]),
    allowRanges: z.boolean(),
    maxPartsPerDocument: z.number().int().min(1).max(20)
  }).strict(),
  queue: z.object({
    ppmBw: z.number().int().min(1).max(300),
    ppmColor: z.number().int().min(1).max(300),
    setupSec: z.number().int().min(0).max(600),
    printers: z.number().int().min(1).max(20),
    manualDelayMin: z.number().int().min(0).max(120)
  }).strict(),
  retention: z.object({
    afterHandoverHours: z.number().int().min(1).max(168),
    abandonedDraftHours: z.number().int().min(1).max(168),
    unpaidHours: z.number().int().min(1).max(48)
  }).strict(),
  print_mode: z.enum(['automatic', 'manual']),
  paused: z.boolean()
};
const STAFF_SETTINGS = new Set(['print_mode', 'paused']); // counter staff may pause / switch mode

const paise = z.number().int().min(0).max(100000); // up to Rs 1000 per page
const pricesBody = z.object({
  bw1Paise: paise, bw2Paise: paise, col1Paise: paise, col2Paise: paise,
  a3Multiplier: z.number().min(1).max(10),
  duplexBasis: z.enum(['sheet', 'side']),
  password
}).strict();

const statusBody = z.object({ to: z.enum(['printing', 'ready', 'print_attention']), reason: z.string().trim().max(200).optional() }).strict();
const handoverBody = z.union([
  z.object({ pin: z.string().regex(/^\d{4}$/, 'The PIN has 4 digits.') }).strict(),
  z.object({ password, reason: z.string().trim().min(3).max(200) }).strict()
]);
const refundBody = z.object({ reason: z.string().trim().min(3).max(500), password }).strict();
const ordersQuery = z.object({
  view: z.enum(['queue', 'today', 'history', 'attention']).default('queue'),
  date: dateStr.optional(),
  token: z.string().trim().max(12).optional()
});

function adminRoutes({ config, auth, adminSession, service, settings, pricing, payments, storage, stream, bus, agents, agentRouter }) {
  const router = express.Router();
  const limiters = [];
  const limit = (opts) => { const l = rateLimit(opts); limiters.push(l); return l; };
  const { required, owner } = adminSession;
  const ip = (req) => req.ip;

  const needPassword = (req) => {
    if (!auth.confirmPassword(req.admin.userId, req.valid.body.password)) {
      service.audit(req.admin.userId, 'reauth_failed', null, { path: req.path }, ip(req));
      throw new HttpError(403, 'wrong_password', 'Wrong password.');
    }
  };

  /* ---------- auth ---------- */

  // 10 attempts / 15 min per IP, on top of the 5-failure account lock.
  router.post('/login', limit({ name: 'admin_login', windowMs: 15 * 60000, max: 10 }), validate(loginBody), (req, res) => {
    const { username, password: pw, otp } = req.valid.body;
    const r = auth.login({ username, password: pw, otp, ip: ip(req), userAgent: req.get('user-agent') });
    if (!r.ok) throw new HttpError(401, 'login_failed', 'Wrong username, password or code. After 5 wrong tries the account is locked for 15 minutes.');
    adminSession.issue(res, r.token);
    res.json({ user: r.user, csrfToken: r.csrf });
  });

  router.get('/session', required, (req, res) => {
    res.json({
      user: { id: req.admin.userId, username: req.admin.username, role: req.admin.role },
      csrfToken: req.admin.csrf,
      expiresAt: req.admin.expiresAt,
      publicOrigin: config.publicOrigin,
      paymentsEnabled: !!config.paytm
    });
  });

  router.post('/logout', required, (req, res) => {
    auth.logout(req.admin.sessionId);
    adminSession.clear(res);
    res.json({ ok: true });
  });

  router.post('/password', required, limit({ name: 'admin_password', windowMs: 15 * 60000, max: 10 }),
    validate(z.object({ current: password, next: z.string().min(1).max(200) }).strict()), (req, res) => {
      const r = auth.changePassword(req.admin, req.valid.body.current, req.valid.body.next);
      if (!r.ok && r.reason === 'wrong_password') {
        service.audit(req.admin.userId, 'reauth_failed', null, { path: req.path }, ip(req));
        throw new HttpError(403, 'wrong_password', 'Current password is wrong.');
      }
      if (!r.ok) throw new HttpError(400, 'weak_password', r.message);
      service.audit(req.admin.userId, 'password_changed', null, {}, ip(req));
      res.json({ ok: true });
    });

  router.post('/logout-all', required, (req, res) => {
    auth.logoutAll(req.admin.userId);
    service.audit(req.admin.userId, 'logout_all', null, {}, ip(req));
    adminSession.clear(res);
    res.json({ ok: true });
  });

  /* ---------- orders ---------- */

  const findOrder = (req, res, next) => {
    if (!UUID_RE.test(req.params.orderId)) return next(notFound('Order not found.'));
    return next();
  };

  router.get('/orders', required, validate(ordersQuery, 'query'), (req, res) => {
    res.json({ orders: service.listOrders(req.valid.query), counts: service.counts() });
  });

  router.get('/orders/:orderId', required, findOrder, (req, res) => {
    const detail = service.orderDetail(req.params.orderId);
    if (!detail) throw notFound('Order not found.');
    res.json(detail);
  });

  // Print-ready PDF for the dashboard viewer (and manual printing). Sandboxed, never cached.
  router.get('/orders/:orderId/documents/:documentId/pdf', required, findOrder, (req, res, next) => {
    const d = UUID_RE.test(req.params.documentId) ? service.document(req.params.orderId, req.params.documentId) : null;
    if (!d) return next(notFound('Document not found.'));
    if (d.conversion_status !== 'ready' || d.purged_at) return next(new HttpError(409, 'not_ready', 'This file is not available.'));
    const file = storage.pdfPath(d.storage_key);
    return fs.stat(file, (err, st) => {
      if (err) return next(notFound('Document not found.'));
      res.set({
        'Content-Type': 'application/pdf',
        'Content-Length': String(st.size),
        // ?download=1: save and print from the shop PC's PDF reader (until the print agent, phase 7).
        'Content-Disposition': req.query.download === '1'
          ? `attachment; filename="${(d.original_name.replace(/\.[^.]+$/, '') || 'document').replace(/[^\w.\- ]+/g, '_').slice(0, 80)}.pdf"`
          : 'inline; filename="document.pdf"',
        'Content-Security-Policy': 'sandbox',
        'Cache-Control': 'private, no-store'
      });
      if (req.query.download === '1') service.audit(req.admin.userId, 'document_downloaded', d.order_id, { documentId: d.id }, ip(req));
      return fs.createReadStream(file).on('error', next).pipe(res);
    });
  });

  router.post('/orders/:orderId/status', required, findOrder, validate(statusBody), (req, res) => {
    const o = service.setStatus({ orderId: req.params.orderId, ...req.valid.body, admin: req.admin, ip: ip(req) });
    res.json(service.orderSummary(o));
  });

  router.post('/orders/:orderId/handover', required, findOrder, limit({ name: 'admin_handover', max: 30 }), validate(handoverBody), (req, res) => {
    const body = req.valid.body;
    let override = null;
    if (body.password !== undefined) {
      if (req.admin.role !== 'owner') throw forbidden('Only the shop owner can hand over without the PIN.');
      needPassword(req);
      override = { reason: body.reason };
    }
    const o = service.handover({ orderId: req.params.orderId, pin: body.pin, override, admin: req.admin, ip: ip(req) });
    res.json(service.orderSummary(o));
  });

  router.post('/orders/:orderId/refund', required, owner, findOrder, limit({ name: 'admin_refund', max: 10 }), validate(refundBody), async (req, res) => {
    needPassword(req);
    const refund = await payments.requestRefund({ orderId: req.params.orderId, reason: req.valid.body.reason, adminId: req.admin.userId });
    res.json({ refundId: refund.id, status: refund.status, amountPaise: refund.amount_paise, order: service.orderDetail(req.params.orderId) });
  });

  /* ---------- live updates ---------- */

  router.get('/events', required, (req, res) => stream.handler(req, res, req.cookies[adminSession.cookieName]));

  /* ---------- settings & prices ---------- */

  function allSettings() {
    const t = pricing.activeTable();
    return {
      shop: settings.shop(),
      print_options: settings.printOptions(),
      queue: settings.queue(),
      retention: settings.retention(),
      print_mode: settings.printMode(),
      paused: settings.paused(),
      prices: {
        id: t.id, bw1Paise: t.bw1_paise, bw2Paise: t.bw2_paise, col1Paise: t.col1_paise, col2Paise: t.col2_paise,
        a3Multiplier: t.a3_multiplier, duplexBasis: t.duplex_basis, createdAt: t.created_at
      },
      publicOrigin: config.publicOrigin
    };
  }

  router.get('/settings', required, (req, res) => res.json(allSettings()));

  router.put('/settings/:key', required, (req, res) => {
    const key = req.params.key;
    const schema = Object.hasOwn(SETTING_SCHEMAS, key) ? SETTING_SCHEMAS[key] : null;
    if (!schema) throw notFound('Unknown setting.');
    if (!STAFF_SETTINGS.has(key) && req.admin.role !== 'owner') throw forbidden('Only the shop owner can do this.');
    const parsed = schema.safeParse(req.body?.value);
    if (!parsed.success) {
      throw new HttpError(400, 'bad_request', 'Invalid value.', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    }
    const before = settings.get(key);
    settings.set(key, parsed.data);
    service.audit(req.admin.userId, 'setting_changed', null, { key, before, after: parsed.data }, ip(req));
    bus.emit('queue', null); // customers' ETAs / pause banner and the dashboard counters refresh
    res.json(allSettings());
  });

  router.put('/prices', required, owner, limit({ name: 'admin_prices', max: 10 }), validate(pricesBody), (req, res) => {
    needPassword(req);
    const { password: _pw, ...p } = req.valid.body;
    const before = pricing.activeTable();
    const t = pricing.setPriceTable(p, req.admin.userId);
    service.audit(req.admin.userId, 'prices_changed', null, {
      before: { bw1Paise: before.bw1_paise, bw2Paise: before.bw2_paise, col1Paise: before.col1_paise, col2Paise: before.col2_paise, a3Multiplier: before.a3_multiplier, duplexBasis: before.duplex_basis },
      after: p, priceTableId: t.id
    }, ip(req));
    res.json(allSettings());
  });

  /* ---------- print agent & printers ---------- */

  router.get('/printers', required, (req, res) => res.json(agents.overview()));

  router.post('/agents/pairing', required, owner, limit({ name: 'admin_pairing', max: 10 }), (req, res) => {
    res.status(201).json(agents.createPairing(req.admin.userId, ip(req)));
  });

  router.post('/agents/:agentId/revoke', required, owner, validate(z.object({ password }).strict()), (req, res) => {
    if (!UUID_RE.test(req.params.agentId)) throw notFound('Agent not found.');
    needPassword(req);
    if (!agents.revoke(req.params.agentId, req.admin.userId, ip(req))) throw notFound('Agent not found.');
    agentRouter.disconnect(req.params.agentId);
    bus.emit('queue', null);
    res.json(agents.overview());
  });

  router.put('/printers/:printerId', required, owner, validate(z.object({
    enabled: z.boolean(),
    role: z.enum(['bw', 'color', 'any']),
    ppmBw: z.number().int().min(1).max(300),
    ppmColor: z.number().int().min(1).max(300),
    displayName: z.string().trim().max(60).optional()
  }).strict()), (req, res) => {
    if (!UUID_RE.test(req.params.printerId)) throw notFound('Printer not found.');
    if (!agents.updatePrinter(req.params.printerId, req.valid.body, req.admin.userId, ip(req))) throw notFound('Printer not found.');
    bus.emit('queue', null); // ETAs + automatic dispatch may change
    res.json(agents.overview());
  });

  /* ---------- reports & audit ---------- */

  router.get('/reports/daily', required, owner, validate(z.object({ date: dateStr.optional() }), 'query'), (req, res) => {
    res.json(service.dailyReport(req.valid.query.date));
  });

  router.get('/reports/problems', required, (req, res) => res.json({ problems: service.problems() }));

  router.get('/reports/daily.csv', required, owner, validate(z.object({ date: dateStr.optional() }), 'query'), (req, res) => {
    const date = req.valid.query.date || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    service.audit(req.admin.userId, 'report_exported', null, { date }, ip(req));
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="quick-print-${date}.csv"` });
    res.send(service.dailyCsv(date));
  });

  router.post('/payments/:paymentId/refund', required, owner, limit({ name: 'admin_refund_payment', max: 10 }), validate(refundBody), async (req, res) => {
    if (!UUID_RE.test(req.params.paymentId)) throw notFound('Payment not found.');
    needPassword(req);
    const r = await payments.refundPayment({ paymentId: req.params.paymentId, reason: req.valid.body.reason, adminId: req.admin.userId });
    res.json({ refundId: r.id, status: r.status, amountPaise: r.amount_paise });
  });

  router.get('/audit', required, owner, validate(z.object({
    limit: z.coerce.number().int().min(1).max(500).default(100),
    before: z.string().max(40).optional()
  }), 'query'), (req, res) => res.json({ entries: service.auditLog(req.valid.query) }));

  router.stop = () => limiters.forEach((l) => l.stop());
  return router;
}

module.exports = { adminRoutes, SETTING_SCHEMAS };
