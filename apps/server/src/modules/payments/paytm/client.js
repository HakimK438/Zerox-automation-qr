'use strict';
/* Paytm PG server-to-server client (JS Checkout / native APIs).
   Endpoints (per Paytm developer docs):
     POST /theia/api/v1/initiateTransaction?mid=&orderId=   -> body.txnToken
     POST /theia/api/v1/processTransaction?mid=&orderId=    (paymentMode UPI_INTENT) -> body.deepLinkInfo.deepLink
     POST /v3/order/status                                  -> body.resultInfo.resultStatus TXN_SUCCESS|TXN_FAILURE|PENDING
     POST /refund/apply, POST /v2/refund/status
   The merchant key never leaves the server and is never logged. */
const { generateSignature } = require('./checksum');

class PaytmError extends Error {
  constructor(message, details) { super(message); this.details = details; }
}

/** "12.50" <-> 1250 paise without floating point. */
function paiseToAmount(paise) {
  return `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, '0')}`;
}
function amountToPaise(value) {
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(String(value ?? '').trim());
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] || '0').padEnd(2, '0'));
}

function createPaytmClient({ mid, key, website, host, callbackUrl, timeoutMs = 10000, fetchImpl = fetch }) {
  async function post(path, payload) {
    let res;
    try {
      res = await fetchImpl(`${host}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (err) {
      throw new PaytmError('Payment service unreachable.', { path, reason: err.name });
    }
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.body) throw new PaytmError('Payment service error.', { path, status: res.status });
    return data.body;
  }

  const signed = (body) => ({ body, head: { signature: generateSignature(JSON.stringify(body), key) } });
  const q = (orderId) => `?mid=${encodeURIComponent(mid)}&orderId=${encodeURIComponent(orderId)}`;

  return {
    mid,

    /** @returns {Promise<string>} txnToken */
    async initiateTransaction({ orderId, amountPaise, custId }) {
      const body = await post(`/theia/api/v1/initiateTransaction${q(orderId)}`, signed({
        requestType: 'Payment',
        mid,
        websiteName: website,
        orderId,
        callbackUrl,
        txnAmount: { value: paiseToAmount(amountPaise), currency: 'INR' },
        userInfo: { custId }
      }));
      if (body.resultInfo?.resultStatus !== 'S' || !body.txnToken) {
        throw new PaytmError('Could not start the payment.', { code: body.resultInfo?.resultCode, msg: body.resultInfo?.resultMsg });
      }
      return body.txnToken;
    },

    /** UPI intent deep link (upi://pay?...), or null if UPI intent is not enabled for this MID. */
    async upiIntent({ orderId, txnToken }) {
      try {
        const body = await post(`/theia/api/v1/processTransaction${q(orderId)}`, {
          head: { version: 'v1', requestTimestamp: String(Date.now()), channelId: 'WEB', txnToken },
          body: { requestType: 'NATIVE', mid, orderId, paymentMode: 'UPI_INTENT' }
        });
        const link = body.deepLinkInfo?.deepLink;
        return body.resultInfo?.resultStatus === 'S' && typeof link === 'string' && link.startsWith('upi://') ? link : null;
      } catch {
        return null; // customer can still pay through JS Checkout
      }
    },

    /** Authoritative status. Never decide "paid" from anything else. */
    async transactionStatus(orderId) {
      return post('/v3/order/status', signed({ mid, orderId }));
    },

    async refund({ orderId, txnId, refId, amountPaise }) {
      return post('/refund/apply', signed({
        mid, txnType: 'REFUND', orderId, txnId, refId, refundAmount: paiseToAmount(amountPaise)
      }));
    },

    async refundStatus({ orderId, refId }) {
      return post('/v2/refund/status', signed({ mid, orderId, refId }));
    }
  };
}

/* iOS has no generic UPI app chooser: offer app-specific links built from Paytm's upi:// link.
   Schemes as published by the apps; re-verify on real devices before launch (plan C10). */
const IOS_APPS = [
  { app: 'gpay', label: 'Google Pay', prefix: 'gpay://upi/pay?' },
  { app: 'phonepe', label: 'PhonePe', prefix: 'phonepe://pay?' },
  { app: 'paytm', label: 'Paytm', prefix: 'paytmmp://pay?' },
  { app: 'bhim', label: 'BHIM', prefix: 'bhim://upi/pay?' }
];

function appLinks(deepLink) {
  if (typeof deepLink !== 'string' || !deepLink.startsWith('upi://pay?')) return [];
  const query = deepLink.slice('upi://pay?'.length);
  return IOS_APPS.map(({ app, label, prefix }) => ({ app, label, url: prefix + query }));
}

module.exports = { createPaytmClient, PaytmError, paiseToAmount, amountToPaise, appLinks };
