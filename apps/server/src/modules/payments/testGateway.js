'use strict';
/* Test payment mode: a stand-in for the Paytm client that lives inside the server.
   No money moves and nothing leaves this machine. The customer page shows two buttons (payment
   successful / failed); they set the state here, and the normal verification code (service.verify ->
   applyStatus) then reads it exactly as it reads Paytm's Status API. So a test order walks the same
   path as a real one: token, PIN, queue, dashboard, print agent, refund.
   Refused in production by config/env.js. */
const { paiseToAmount } = require('./paytm/client');

const MID = 'TESTMODE';

function createTestGateway() {
  const txns = new Map();    // orderId (our payment id) -> { amountPaise, status, txnId }
  const refunds = new Map(); // refId -> refund id
  let seq = 0;

  const remember = (orderId, amountPaise) => {
    if (!txns.has(orderId)) txns.set(orderId, { amountPaise, status: 'PENDING', txnId: `TEST${Date.now()}${++seq}` });
    return txns.get(orderId);
  };
  const CODES = { TXN_SUCCESS: ['01', 'Test payment successful'], TXN_FAILURE: ['227', 'Test payment failed'], PENDING: ['402', 'Test payment waiting'] };

  return {
    isTest: true,
    mid: MID,

    async initiateTransaction({ orderId, amountPaise }) {
      remember(orderId, amountPaise);
      return `test-${orderId}`;
    },

    async upiIntent() { return null; },

    /** Same shape as Paytm's /v3/order/status body. A restart forgets waiting payments: they stay pending. */
    async transactionStatus(orderId) {
      const t = txns.get(orderId);
      if (!t) return { resultInfo: { resultStatus: 'PENDING', resultCode: CODES.PENDING[0], resultMsg: CODES.PENDING[1] } };
      const [resultCode, resultMsg] = CODES[t.status];
      return {
        resultInfo: { resultStatus: t.status, resultCode, resultMsg },
        mid: MID,
        orderId,
        txnId: t.txnId,
        bankTxnId: `BANK${t.txnId}`,
        txnAmount: paiseToAmount(t.amountPaise),
        paymentMode: 'TEST'
      };
    },

    async refund({ refId }) {
      refunds.set(refId, `TESTREFUND${++seq}`);
      return { resultInfo: { resultStatus: 'PENDING', resultCode: '601', resultMsg: 'Test refund started' }, refundId: refunds.get(refId) };
    },

    async refundStatus({ refId }) {
      const refundId = refunds.get(refId);
      return refundId
        ? { resultInfo: { resultStatus: 'TXN_SUCCESS', resultCode: '10', resultMsg: 'Test refund done' }, refundId }
        : { resultInfo: { resultStatus: 'PENDING', resultCode: '601', resultMsg: 'Test refund waiting' } };
    },

    /** Called by the test buttons. `status` is TXN_SUCCESS or TXN_FAILURE. */
    settle(orderId, amountPaise, status) {
      remember(orderId, amountPaise).status = status;
    }
  };
}

module.exports = { createTestGateway };
