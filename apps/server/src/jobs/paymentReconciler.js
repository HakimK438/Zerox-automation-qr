'use strict';
/* Every 20 s: confirm payments whose callback never arrived, expire stale payments/orders,
   and follow up on refunds (plan C4.3). Runs one pass at a time. */

function createPaymentReconciler({ payments, logger, intervalMs = 20000 }) {
  let timer = null;
  let running = false;

  async function tick() {
    if (running) return null;
    running = true;
    try {
      const summary = await payments.reconcile();
      if (summary.checked || summary.expiredOrders || summary.refundsChecked) logger.info('payments_reconciled', summary);
      return summary;
    } catch (err) {
      logger.error('payment_reconcile_failed', { err: err.stack });
      return null;
    } finally {
      running = false;
    }
  }

  return {
    tick,
    start() { timer = setInterval(tick, intervalMs); timer.unref(); },
    stop() { if (timer) clearInterval(timer); }
  };
}

module.exports = { createPaymentReconciler };
