'use strict';
/* Payments (plan C4). The ONLY code path that marks an order paid is applyStatus(), and it only acts
   on a Paytm Transaction Status API response fetched by this server. Callbacks and webhooks are just
   hints that trigger a status check; their bodies are never trusted for money. */
const { newId, randomPin, sha256 } = require('../../lib/crypto');
const { HttpError, conflict } = require('../../lib/errors');
const { istDate } = require('../../lib/token');
const { hashRecoveryPin } = require('../orders/recovery');
const { ORDER_STATUS: S, canTransition } = require('../../../../../shared/constants');
const { amountToPaise, paiseToAmount, appLinks } = require('./paytm/client');

const MAX_ATTEMPTS_PER_ORDER = 10;
const FIRST_TOKEN = 101; // matches the original frontend (XR-101, XR-102, ...)

const unavailable = () => new HttpError(503, 'payments_unavailable', 'Online payment is not available right now. Please pay at the counter or try again later.');

function createPaymentService({ db, config, paytm, secretBox, logger, settings, notify = () => {}, now = () => Date.now() }) {
  const iso = () => new Date(now()).toISOString();
  const q = {
    order: db.prepare('SELECT * FROM orders WHERE id = ?'),
    payment: db.prepare('SELECT * FROM payments WHERE id = ?'),
    latest: db.prepare('SELECT * FROM payments WHERE order_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1'),
    reusable: db.prepare(`SELECT * FROM payments WHERE order_id = ? AND status = 'pending' AND expires_at > ?
      ORDER BY created_at DESC LIMIT 1`),
    attempts: db.prepare('SELECT COUNT(*) FROM payments WHERE order_id = ?').pluck(),
    open: db.prepare("SELECT * FROM payments WHERE order_id = ? AND status IN ('created','pending')"),
    insert: db.prepare(`INSERT INTO payments (id, order_id, provider, amount_paise, status, created_at, updated_at, expires_at)
      VALUES (?, ?, 'paytm', ?, 'created', ?, ?, ?)`),
    started: db.prepare("UPDATE payments SET status = 'pending', txn_token = ?, deep_link = ?, updated_at = ? WHERE id = ?"),
    startFailed: db.prepare("UPDATE payments SET status = 'failed', result_msg = ?, updated_at = ? WHERE id = ?"),
    checked: db.prepare('UPDATE payments SET status_checked_at = ? WHERE id = ?'),
    success: db.prepare(`UPDATE payments SET status = 'success', txn_id = ?, bank_txn_id = ?, payment_mode = ?, raw_status = ?,
      result_code = ?, result_msg = ?, paid_at = ?, updated_at = ? WHERE id = ? AND status <> 'success'`),
    failed: db.prepare(`UPDATE payments SET status = 'failed', raw_status = ?, result_code = ?, result_msg = ?, updated_at = ?
      WHERE id = ? AND status IN ('created','pending','expired')`),
    expirePayment: db.prepare("UPDATE payments SET status = 'expired', updated_at = ? WHERE id = ? AND status IN ('created','pending')"),
    flagRefund: db.prepare('UPDATE payments SET needs_refund = 1 WHERE id = ?'),
    txnUsed: db.prepare('SELECT id FROM payments WHERE txn_id = ? AND id <> ?').pluck(),
    event: db.prepare('INSERT INTO payment_events (id, payment_id, source, checksum_ok, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    nextToken: db.prepare(`INSERT INTO daily_counters (date, last_token) VALUES (?, ?)
      ON CONFLICT(date) DO UPDATE SET last_token = last_token + 1 RETURNING last_token`).pluck(),
    markPaid: db.prepare(`UPDATE orders SET status = 'paid', paid_at = ?, updated_at = ?, token_date = ?, token_no = ?,
      recovery_pin_hash = ?, pickup_pin_enc = ?, recovery_failures = 0, recovery_locked_at = NULL, print_mode_snapshot = ?
      WHERE id = ? AND status IN ('awaiting_payment','expired')`),
    setStatus: db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ? AND status = ?'),
    attention: db.prepare('UPDATE orders SET needs_attention = ?, updated_at = ? WHERE id = ?'),
    orderEvent: db.prepare(`INSERT INTO order_events (id, order_id, from_status, to_status, actor, actor_id, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    audit: db.prepare(`INSERT INTO audit_logs (id, actor, actor_id, action, order_id, details, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`),
    pendingPayments: db.prepare(`SELECT * FROM payments WHERE status IN ('created','pending') AND created_at <= ?
      AND (status_checked_at IS NULL OR status_checked_at <= ?) ORDER BY created_at LIMIT ?`),
    staleOrders: db.prepare(`SELECT o.* FROM orders o WHERE o.status = 'awaiting_payment' AND o.checkout_at <= ?
      AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.status IN ('created','pending'))`),
    successFor: db.prepare("SELECT * FROM payments WHERE order_id = ? AND status = 'success' AND needs_refund = 0 ORDER BY paid_at DESC LIMIT 1"),
    insertRefund: db.prepare(`INSERT INTO refunds (id, payment_id, order_id, amount_paise, status, reason, requested_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`),
    refund: db.prepare('SELECT * FROM refunds WHERE id = ?'),
    refundDone: db.prepare('UPDATE refunds SET status = ?, provider_ref = COALESCE(?, provider_ref), updated_at = ?, status_checked_at = ? WHERE id = ? AND status = \'pending\''),
    refundChecked: db.prepare('UPDATE refunds SET status_checked_at = ? WHERE id = ?'),
    pendingRefunds: db.prepare("SELECT * FROM refunds WHERE status = 'pending' AND (status_checked_at IS NULL OR status_checked_at <= ?) LIMIT ?")
  };

  const logEvent = (paymentId, source, checksumOk, payload) =>
    q.event.run(newId(), paymentId, source, checksumOk == null ? null : (checksumOk ? 1 : 0), JSON.stringify(payload ?? {}), iso());
  const orderEvent = (orderId, from, to, actor, actorId, reason) => q.orderEvent.run(newId(), orderId, from, to, actor, actorId, reason || null, iso());
  const audit = (actor, actorId, action, orderId, details) => q.audit.run(newId(), actor, actorId, action, orderId, JSON.stringify(details || {}), iso());

  /* ---------- view ---------- */

  function view(p) {
    if (!p) return null;
    const live = p.status === 'pending';
    return {
      paymentId: p.id,
      status: p.status,
      amountPaise: p.amount_paise,
      amount: paiseToAmount(p.amount_paise),
      expiresAt: p.expires_at,
      ...(live && paytm?.isTest ? { testMode: true } : {}),
      ...(live && paytm && !paytm.isTest ? {
        mid: paytm.mid,
        txnToken: p.txn_token,
        host: config.paytm.host,
        checkoutJsUrl: `${config.paytm.host}/merchantpgpui/checkoutjs/merchants/${paytm.mid}.js`,
        deepLink: p.deep_link,
        appLinks: appLinks(p.deep_link)
      } : {})
    };
  }

  /* ---------- start / resume ---------- */

  async function start(order, sessionId) {
    if (!paytm) throw unavailable();
    if ([S.PAID, S.PRINTING, S.PRINT_ATTENTION, S.READY, S.HANDED_OVER].includes(order.status)) throw conflict('This order is already paid.');
    if (order.status !== S.AWAITING_PAYMENT) throw conflict('Please review your order before paying.');

    const reusable = q.reusable.get(order.id, iso());
    if (reusable) return view(reusable);
    if (q.attempts.get(order.id) >= MAX_ATTEMPTS_PER_ORDER) {
      throw new HttpError(429, 'too_many_attempts', 'Too many payment attempts for this order. Please ask at the counter.');
    }

    const id = newId();
    const at = iso();
    q.insert.run(id, order.id, order.total_paise, at, at, new Date(now() + config.paymentTtlMs).toISOString());
    let txnToken;
    try {
      // custId: stable per browser, no personal data.
      txnToken = await paytm.initiateTransaction({ orderId: id, amountPaise: order.total_paise, custId: `C${sha256(sessionId).slice(0, 20)}` });
    } catch (err) {
      q.startFailed.run(String(err.message).slice(0, 200), iso(), id);
      logger.warn('paytm_initiate_failed', { paymentId: id, details: err.details });
      throw new HttpError(502, 'payment_start_failed', 'Could not start the payment. Please try again.');
    }
    const deepLink = await paytm.upiIntent({ orderId: id, txnToken });
    q.started.run(txnToken, deepLink, iso(), id);
    return view(q.payment.get(id));
  }

  /* ---------- verification (the only way to "paid") ---------- */

  function assignToken() {
    return q.nextToken.get(istDate(now()), FIRST_TOKEN);
  }

  /** Applies a Transaction Status API body to a payment. Pure DB, one transaction, idempotent. */
  const applyStatus = db.transaction((paymentId, body) => {
    const p = q.payment.get(paymentId);
    if (!p) return { outcome: 'unknown_payment' };
    const result = body?.resultInfo?.resultStatus;
    const at = iso();

    if (result === 'TXN_SUCCESS') {
      const paise = amountToPaise(body.txnAmount);
      const txnId = typeof body.txnId === 'string' ? body.txnId.trim() : '';
      const problems = [];
      if (body.mid !== paytm.mid) problems.push('mid');
      if (body.orderId !== p.id) problems.push('orderId');
      if (paise !== p.amount_paise) problems.push('amount');
      if (!txnId || txnId.length > 100) problems.push('txnId');
      if (txnId && q.txnUsed.get(txnId, p.id)) problems.push('txnId_reused');
      if (problems.length) {
        audit('system', null, 'payment_verification_mismatch', p.order_id, { paymentId: p.id, problems });
        logger.warn('payment_verification_mismatch', { paymentId: p.id, problems });
        return { outcome: 'mismatch', problems };
      }
      if (p.status === 'success') return { outcome: 'already_paid' };

      q.success.run(txnId, body.bankTxnId || null, body.paymentMode || null, JSON.stringify(body),
        body.resultInfo.resultCode || null, body.resultInfo.resultMsg || null, at, at, p.id);

      const order = q.order.get(p.order_id);
      if (canTransition(order.status, S.PAID, 'system')) {
        const late = order.status === S.EXPIRED;
        const tokenNo = assignToken();
        const pin = randomPin(4);
        const printMode = settings.printMode();
        q.markPaid.run(at, at, istDate(now()), tokenNo, hashRecoveryPin(order.id, pin), secretBox.seal(pin), printMode, order.id);
        orderEvent(order.id, order.status, S.PAID, 'system', p.id, late ? 'late_payment' : 'payment_verified');
        audit('system', null, late ? 'payment_verified_late' : 'payment_verified', order.id,
          { paymentId: p.id, amountPaise: p.amount_paise, txnId, mode: body.paymentMode || null });
        return { outcome: 'paid', tokenNo, late };
      }
      // Money taken but the order can't accept it (already paid by another attempt, or edited/cancelled).
      q.flagRefund.run(p.id);
      q.attention.run('payment_needs_refund', at, order.id);
      audit('system', null, 'payment_needs_refund', order.id, { paymentId: p.id, orderStatus: order.status, amountPaise: p.amount_paise });
      logger.warn('payment_needs_refund', { paymentId: p.id, orderStatus: order.status });
      return { outcome: 'needs_refund' };
    }

    if (result === 'TXN_FAILURE') {
      q.failed.run(JSON.stringify(body), body.resultInfo.resultCode || null, body.resultInfo.resultMsg || null, at, p.id);
      return { outcome: 'failed' };
    }
    return { outcome: 'pending' };
  });

  /** Asks Paytm for the truth about one payment and applies it. */
  async function verify(paymentId, source) {
    if (!paytm) throw unavailable();
    let body;
    try {
      body = await paytm.transactionStatus(paymentId);
    } catch (err) {
      logger.warn('paytm_status_failed', { paymentId, source, details: err.details });
      return { outcome: 'unreachable' };
    }
    q.checked.run(iso(), paymentId);
    logEvent(paymentId, 'status_api', null, body);
    const result = applyStatus(paymentId, body);
    if (result.outcome === 'paid' || result.outcome === 'needs_refund') notify(q.payment.get(paymentId).order_id);
    return result;
  }

  /** Callback / webhook entry: log the hint, then verify with the Status API. */
  async function handleNotification(params, checksumOk, source) {
    const p = typeof params.ORDERID === 'string' ? q.payment.get(params.ORDERID) : null;
    logEvent(p ? p.id : null, source, checksumOk, params);
    if (!p) return { outcome: 'unknown_payment', payment: null };
    if (!checksumOk) {
      logger.warn('paytm_bad_checksum', { paymentId: p.id, source });
      return { outcome: 'bad_checksum', payment: p };
    }
    return { ...(await verify(p.id, source)), payment: p };
  }

  /** Test mode: the test buttons set the gateway's answer, then the normal verification reads it. */
  async function settleTest(order, result) {
    if (!paytm?.isTest) throw unavailable();
    const p = q.latest.get(order.id);
    if (!p || p.status !== 'pending') throw conflict('There is no payment waiting. Please start again.');
    paytm.settle(p.id, p.amount_paise, result === 'success' ? 'TXN_SUCCESS' : 'TXN_FAILURE');
    const { outcome } = await verify(p.id, 'status_api');
    return { outcome };
  }

  /* ---------- customer status / reopen ---------- */

  async function statusFor(order) {
    let p = q.latest.get(order.id);
    // Customer is waiting on the page: check with Paytm at most every 10 s.
    if (p && paytm && p.status === 'pending' && now() - Date.parse(p.created_at) > 5000 &&
        (!p.status_checked_at || now() - Date.parse(p.status_checked_at) > 10000)) {
      await verify(p.id, 'status_api');
      p = q.payment.get(p.id);
    }
    const fresh = q.order.get(order.id);
    return { orderStatus: fresh.status, paid: ![S.DRAFT, S.AWAITING_PAYMENT, S.EXPIRED, S.CANCELLED].includes(fresh.status), payment: view(p) };
  }

  /** awaiting_payment -> draft so the customer can edit, but only once Paytm confirms nothing was paid. */
  async function reopen(order) {
    if (order.status !== S.AWAITING_PAYMENT) throw conflict('Only orders waiting for payment can be changed.');
    if (paytm) {
      for (const p of q.open.all(order.id)) {
        const r = await verify(p.id, 'status_api');
        if (r.outcome === 'unreachable') {
          throw new HttpError(503, 'status_unknown', 'We could not confirm your payment status. Please try again in a moment.');
        }
      }
    }
    const reopened = db.transaction(() => {
      const fresh = q.order.get(order.id);
      if (fresh.status !== S.AWAITING_PAYMENT) throw conflict('This order is already paid.');
      for (const p of q.open.all(order.id)) q.expirePayment.run(iso(), p.id);
      if (!canTransition(fresh.status, S.DRAFT, 'system')) throw conflict('This order can no longer be changed.');
      q.setStatus.run(S.DRAFT, iso(), order.id, S.AWAITING_PAYMENT);
      orderEvent(order.id, S.AWAITING_PAYMENT, S.DRAFT, 'system', null, 'customer_reopen');
      return q.order.get(order.id);
    })();
    notify(order.id);
    return reopened;
  }

  /* ---------- reconciler (missed callbacks, expiry, refunds) ---------- */

  async function reconcile({ batch = 25 } = {}) {
    const summary = { checked: 0, paid: 0, expiredPayments: 0, expiredOrders: 0, refundsChecked: 0 };
    if (paytm) {
      const due = q.pendingPayments.all(new Date(now() - 20000).toISOString(), new Date(now() - 15000).toISOString(), batch);
      for (const p of due) {
        const r = await verify(p.id, 'reconciler');
        summary.checked += 1;
        if (r.outcome === 'paid') summary.paid += 1;
        // Still pending after its window: stop offering it. A later success is still honoured.
        if (r.outcome === 'pending' && Date.parse(p.expires_at) <= now()) {
          summary.expiredPayments += q.expirePayment.run(iso(), p.id).changes;
        }
      }
    } else {
      for (const p of db.prepare("SELECT * FROM payments WHERE status IN ('created','pending') AND expires_at <= ?").all(iso())) {
        summary.expiredPayments += q.expirePayment.run(iso(), p.id).changes;
      }
    }

    // Orders whose payment window closed with no attempt still open.
    for (const o of q.staleOrders.all(new Date(now() - config.orderPaymentWindowMs).toISOString())) {
      db.transaction(() => {
        if (q.setStatus.run(S.EXPIRED, iso(), o.id, S.AWAITING_PAYMENT).changes) {
          orderEvent(o.id, S.AWAITING_PAYMENT, S.EXPIRED, 'system', null, 'payment_window_closed');
          summary.expiredOrders += 1;
        }
      })();
      notify(o.id);
    }

    if (paytm) {
      for (const r of q.pendingRefunds.all(new Date(now() - 60000).toISOString(), batch)) {
        await checkRefund(r);
        summary.refundsChecked += 1;
      }
    }
    return summary;
  }

  /* ---------- refunds (triggered by the admin in phase 6) ---------- */

  async function requestRefund({ orderId, reason, adminId }) {
    if (!paytm) throw unavailable();
    const created = db.transaction(() => {
      const order = q.order.get(orderId);
      if (!order || !canTransition(order.status, S.REFUND_PENDING, 'admin')) throw conflict('This order cannot be refunded in its current state.');
      const pay = q.successFor.get(orderId);
      if (!pay) throw conflict('No completed payment found for this order.');
      const refundId = newId();
      const at = iso();
      q.insertRefund.run(refundId, pay.id, orderId, pay.amount_paise, String(reason).slice(0, 500), adminId, at, at);
      q.setStatus.run(S.REFUND_PENDING, at, orderId, order.status);
      orderEvent(orderId, order.status, S.REFUND_PENDING, 'admin', adminId, 'refund_requested');
      audit('admin', adminId, 'refund_requested', orderId, { refundId, paymentId: pay.id, amountPaise: pay.amount_paise, reason });
      return { refundId, payment: pay };
    })();
    notify(orderId);

    try {
      const body = await paytm.refund({ orderId: created.payment.id, txnId: created.payment.txn_id, refId: created.refundId, amountPaise: created.payment.amount_paise });
      logEvent(created.payment.id, 'refund', null, body);
      if (body?.resultInfo?.resultStatus === 'TXN_FAILURE') finishRefundAndNotify(created.refundId, 'failed', body.refundId);
    } catch (err) {
      logger.warn('paytm_refund_failed', { refundId: created.refundId, details: err.details }); // reconciler re-checks
    }
    return q.refund.get(created.refundId);
  }

  /**
   * Refund ONE flagged payment (money taken that no order can use: paid twice, or paid after the order was
   * reopened). The order itself is not changed. Only payments marked needs_refund qualify.
   */
  async function refundPayment({ paymentId, reason, adminId }) {
    if (!paytm) throw unavailable();
    const created = db.transaction(() => {
      const pay = q.payment.get(paymentId);
      if (!pay || pay.status !== 'success' || !pay.needs_refund) throw conflict('Only payments flagged "needs refund" can be refunded here.');
      if (db.prepare("SELECT 1 FROM refunds WHERE payment_id = ? AND status IN ('pending','success')").get(pay.id)) throw conflict('A refund for this payment already exists.');
      const refundId = newId();
      const at = iso();
      q.insertRefund.run(refundId, pay.id, pay.order_id, pay.amount_paise, String(reason).slice(0, 500), adminId, at, at);
      audit('admin', adminId, 'refund_requested', pay.order_id, { refundId, paymentId: pay.id, amountPaise: pay.amount_paise, reason, flaggedPayment: true });
      return { refundId, payment: pay };
    })();
    try {
      const body = await paytm.refund({ orderId: created.payment.id, txnId: created.payment.txn_id, refId: created.refundId, amountPaise: created.payment.amount_paise });
      logEvent(created.payment.id, 'refund', null, body);
      if (body?.resultInfo?.resultStatus === 'TXN_FAILURE') finishRefundAndNotify(created.refundId, 'failed', body.refundId);
    } catch (err) {
      logger.warn('paytm_refund_failed', { refundId: created.refundId, details: err.details });
    }
    notify(created.payment.order_id);
    return q.refund.get(created.refundId);
  }

  const finishRefund = db.transaction((refundId, status, providerRef) => {
    const r = q.refund.get(refundId);
    if (!r || r.status !== 'pending') return;
    const at = iso();
    q.refundDone.run(status, providerRef || null, at, at, refundId);
    const flagged = q.payment.get(r.payment_id)?.needs_refund === 1;
    if (flagged) {
      // Extra payment refunded: the order keeps its own state; clear the flag once nothing else is owed.
      if (status === 'success') {
        const owed = db.prepare(`SELECT COUNT(*) FROM payments p WHERE p.order_id = ? AND p.needs_refund = 1
          AND NOT EXISTS (SELECT 1 FROM refunds x WHERE x.payment_id = p.id AND x.status = 'success')`).pluck().get(r.order_id);
        if (!owed) db.prepare("UPDATE orders SET needs_attention = NULL WHERE id = ? AND needs_attention = 'payment_needs_refund'").run(r.order_id);
      }
      audit('system', null, status === 'success' ? 'refund_completed' : 'refund_failed', r.order_id, { refundId, flaggedPayment: true });
      afterCommit.push(r.order_id);
      return;
    }
    const to = status === 'success' ? S.REFUNDED : S.PRINT_ATTENTION;
    if (q.setStatus.run(to, at, r.order_id, S.REFUND_PENDING).changes) {
      orderEvent(r.order_id, S.REFUND_PENDING, to, 'system', refundId, status === 'success' ? 'refund_completed' : 'refund_failed');
      if (status !== 'success') q.attention.run('refund_failed', at, r.order_id);
      audit('system', null, status === 'success' ? 'refund_completed' : 'refund_failed', r.order_id, { refundId });
    }
    afterCommit.push(r.order_id);
  });
  const afterCommit = [];
  const finishRefundAndNotify = (...args) => { finishRefund(...args); while (afterCommit.length) notify(afterCommit.shift()); };

  async function checkRefund(r) {
    q.refundChecked.run(iso(), r.id);
    let body;
    try { body = await paytm.refundStatus({ orderId: r.payment_id, refId: r.id }); } catch { return; }
    logEvent(r.payment_id, 'refund', null, body);
    const s = body?.resultInfo?.resultStatus;
    if (s === 'TXN_SUCCESS') finishRefundAndNotify(r.id, 'success', body.refundId);
    else if (s === 'TXN_FAILURE') finishRefundAndNotify(r.id, 'failed', body.refundId);
  }

  /** Pickup PIN for the order owner's page (decrypted on demand, never logged). */
  const pinFor = (order) => (order.pickup_pin_enc ? secretBox.open(order.pickup_pin_enc) : null);

  return { start, settleTest, verify, applyStatus, handleNotification, statusFor, reopen, reconcile, requestRefund, refundPayment, checkRefund, pinFor, view };
}

module.exports = { createPaymentService, FIRST_TOKEN };
