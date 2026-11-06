'use strict';
/* Payment endpoints.
   Customer (owner session): start/resume payment, poll status, reopen to edit.
   Paytm: browser callback (form POST back from Paytm) and server-to-server webhook. Both are only
   hints: the checksum is verified and then the Transaction Status API decides. */
const express = require('express');
const { z } = require('zod');
const { rateLimit } = require('../../middleware/rateLimit');
const { validate } = require('../../middleware/validate');
const { createOwnedOrder } = require('../orders/ownership');
const { verifySignature } = require('./paytm/checksum');

function paymentRoutes({ db, config, payments, session }) {
  const router = express.Router();
  const limiters = [];
  const limit = (opts) => { const l = rateLimit(opts); limiters.push(l); return l; };
  const ownedOrder = createOwnedOrder(db);
  const bySession = (req) => req.customer.sessionId;

  router.post('/orders/:orderId/payments', session.required,
    limit({ name: 'pay_start', max: 10, keyFn: bySession }), ownedOrder,
    async (req, res) => res.json(await payments.start(req.order, req.customer.sessionId)));

  router.get('/orders/:orderId/payment-status', session.required,
    limit({ name: 'pay_status', max: 40, keyFn: bySession }), ownedOrder,
    async (req, res) => res.json(await payments.statusFor(req.order)));

  router.post('/orders/:orderId/reopen', session.required,
    limit({ name: 'pay_reopen', max: 10, keyFn: bySession }), ownedOrder,
    async (req, res) => {
      const order = await payments.reopen(req.order);
      res.json({ orderId: order.id, status: order.status });
    });

  // Test payment mode only. In live mode this route does not exist.
  if (config.testPayments) {
    const testBody = z.object({ result: z.enum(['success', 'fail']) }).strict();
    router.post('/orders/:orderId/test-payment', session.required,
      limit({ name: 'pay_test', max: 30, keyFn: bySession }), validate(testBody), ownedOrder,
      async (req, res) => res.json(await payments.settleTest(req.order, req.valid.body.result)));
  }

  /* ---------- Paytm → us ---------- */
  const form = express.urlencoded({ extended: false, limit: '20kb', parameterLimit: 60 });
  const flat = (body) => Object.fromEntries(Object.entries(body || {}).filter(([, v]) => typeof v === 'string'));
  const checksumOk = (params) => Boolean(config.paytm) && verifySignature(params, config.paytm.key, params.CHECKSUMHASH);

  // Customer's browser returns here after paying (JS Checkout / redirect flow).
  router.post('/payments/paytm/callback', limit({ name: 'paytm_cb', max: 30 }), form, async (req, res) => {
    const params = flat(req.body);
    const result = await payments.handleNotification(params, checksumOk(params), 'callback');
    const target = result.payment ? `${config.publicOrigin}/#order=${encodeURIComponent(result.payment.order_id)}` : `${config.publicOrigin}/`;
    res.redirect(303, target);
  });

  // Server-to-server payment notification configured in the Paytm dashboard.
  router.post('/payments/paytm/webhook', form, async (req, res) => {
    const params = flat(req.body);
    const ok = checksumOk(params);
    const result = await payments.handleNotification(params, ok, 'webhook');
    res.status(ok ? 200 : 400).json({ received: ok, outcome: result.outcome });
  });

  router.stop = () => limiters.forEach((l) => l.stop());
  return router;
}

module.exports = { paymentRoutes };
