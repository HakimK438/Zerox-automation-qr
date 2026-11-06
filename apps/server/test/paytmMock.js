'use strict';
/* Local stand-in for Paytm PG used by the tests (no internet, no real money).
   It verifies that our requests are correctly signed, and lets tests decide what the
   Transaction Status API answers. */
const http = require('node:http');
const { generateSignature, verifySignature } = require('../src/modules/payments/paytm/checksum');

async function startPaytmMock({ mid = 'QPTEST00000000000001', key = 'mockMerchantKey1', port = 0, webhookUrl = null } = {}) {
  const orders = new Map();   // orderId -> { amount, status, txnId, overrides }
  const refunds = new Map();  // refId -> { status }
  const requests = [];
  const flags = { upiIntent: true, failInitiate: false, statusDown: false };
  let txnSeq = 0;

  const send = (res, body) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ head: { responseTimestamp: String(Date.now()) }, body }));
  };

  // Dev control page (scripts/dev-fake-paytm.js): approve/fail pending payments by hand, then
  // notify the app the way Paytm's server-to-server webhook would.
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const controlPage = (res) => {
    const rows = [...orders].reverse().map(([id, o]) => `<tr><td>${esc(id)}</td><td>&#8377;${esc(o.amount)}</td><td>${esc(o.status)}</td><td>${o.status === 'PENDING'
      ? `<form method="post" action="/__set"><input type="hidden" name="id" value="${esc(id)}"><button name="s" value="TXN_SUCCESS">Approve</button> <button name="s" value="TXN_FAILURE">Fail</button></form>` : ''}</td></tr>`).join('');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'" });
    res.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>Fake Paytm</title><style>body{font:15px system-ui;margin:16px}td,th{padding:6px 10px;border-bottom:1px solid #ddd;text-align:left}button{padding:6px 12px}</style>
<h2>Fake Paytm (development only)</h2><p>No real money. Approve a payment, then go back to the shop page.</p><p><a href="/">Refresh</a></p>
<table><tr><th>Payment</th><th>Amount</th><th>Status</th><th></th></tr>${rows || '<tr><td colspan="4">No payments yet</td></tr>'}</table>`);
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://mock');
      if (req.method === 'GET' && url.pathname === '/') return controlPage(res);
      if (req.method === 'POST' && url.pathname === '/__set') {
        const f = new URLSearchParams(raw);
        const o = orders.get(f.get('id'));
        if (o && ['TXN_SUCCESS', 'TXN_FAILURE'].includes(f.get('s'))) {
          o.status = f.get('s');
          if (webhookUrl) {
            fetch(webhookUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(api.callbackParams(f.get('id'))) })
              .catch(() => { /* the app's reconciler still picks it up */ });
          }
        }
        res.writeHead(303, { location: '/' });
        return res.end();
      }
      let payload = {};
      try { payload = JSON.parse(raw || '{}'); } catch { /* ignore */ }
      const signedOk = payload.head?.signature ? verifySignature(JSON.stringify(payload.body), key, payload.head.signature) : null;
      requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), payload, signedOk });

      if (url.pathname === '/theia/api/v1/initiateTransaction') {
        if (flags.failInitiate || !signedOk) return send(res, { resultInfo: { resultStatus: 'F', resultCode: '2007', resultMsg: 'Invalid checksum' } });
        const b = payload.body;
        orders.set(b.orderId, { amount: b.txnAmount.value, status: 'PENDING', txnId: `MOCKTXN${++txnSeq}`, overrides: {} });
        return send(res, { resultInfo: { resultStatus: 'S', resultCode: '0000', resultMsg: 'Success' }, txnToken: `tok-${b.orderId}` });
      }
      if (url.pathname === '/theia/api/v1/processTransaction') {
        const o = orders.get(url.searchParams.get('orderId'));
        if (!flags.upiIntent || !o) return send(res, { resultInfo: { resultStatus: 'F', resultCode: '1006', resultMsg: 'UPI intent not enabled' } });
        return send(res, {
          resultInfo: { resultStatus: 'S', resultCode: '0000', resultMsg: 'Success' },
          deepLinkInfo: { deepLink: `upi://pay?pa=fake.devmock@invalid&pn=FAKE%20TEST%20ONLY&tr=${url.searchParams.get('orderId')}&am=${o.amount}&cu=INR` }
        });
      }
      if (url.pathname === '/v3/order/status') {
        if (flags.statusDown) { res.writeHead(503); return res.end('down'); }
        if (!signedOk) return send(res, { resultInfo: { resultStatus: 'F', resultCode: '2005', resultMsg: 'Checksum invalid' } });
        const id = payload.body.orderId;
        const o = orders.get(id);
        if (!o) return send(res, { resultInfo: { resultStatus: 'TXN_FAILURE', resultCode: '334', resultMsg: 'Invalid Order Id' } });
        const codes = { TXN_SUCCESS: ['01', 'Txn Success'], TXN_FAILURE: ['227', 'Payment failed'], PENDING: ['402', 'Pending'] };
        return send(res, {
          resultInfo: { resultStatus: o.status, resultCode: codes[o.status][0], resultMsg: codes[o.status][1] },
          txnId: o.overrides.txnId ?? o.txnId,
          bankTxnId: `BANK${o.txnId}`,
          orderId: id,
          txnAmount: o.overrides.txnAmount ?? o.amount,
          txnType: 'SALE',
          gatewayName: 'UPI',
          mid: o.overrides.mid ?? mid,
          paymentMode: 'UPI',
          txnDate: new Date().toISOString()
        });
      }
      if (url.pathname === '/refund/apply') {
        refunds.set(payload.body.refId, { status: 'PENDING', body: payload.body });
        return send(res, { resultInfo: { resultStatus: 'PENDING', resultCode: '601', resultMsg: 'Refund request accepted' }, refundId: `RF${payload.body.refId.slice(0, 8)}` });
      }
      if (url.pathname === '/v2/refund/status') {
        const r = refunds.get(payload.body.refId);
        return send(res, { resultInfo: { resultStatus: r ? r.status : 'TXN_FAILURE', resultCode: '10', resultMsg: 'ok' }, refundId: 'RF1' });
      }
      res.writeHead(404); res.end();
    });
  });

  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const host = `http://127.0.0.1:${server.address().port}`;

  const api = {
    host, mid, key, flags, orders, refunds, requests,
    /** Decide what the Status API says for a payment (orderId = our payment id). */
    setStatus(orderId, status, overrides = {}) {
      const o = orders.get(orderId);
      if (!o) throw new Error(`mock: unknown order ${orderId}`);
      o.status = status;
      o.overrides = { ...o.overrides, ...overrides };
      return o;
    },
    /** Form fields Paytm posts to the callback/webhook, signed like Paytm does. */
    callbackParams(orderId, overrides = {}, signWith = key) {
      const o = orders.get(orderId) || { amount: '1.00', txnId: 'X', status: 'TXN_SUCCESS' };
      const params = {
        ORDERID: orderId, MID: mid, TXNID: o.txnId, TXNAMOUNT: o.amount, PAYMENTMODE: 'UPI', CURRENCY: 'INR',
        TXNDATE: '2026-11-06 10:00:00.0', STATUS: o.status === 'PENDING' ? 'TXN_SUCCESS' : o.status,
        RESPCODE: '01', RESPMSG: 'Txn Success', GATEWAYNAME: 'UPI', BANKTXNID: `BANK${o.txnId}`, BANKNAME: '', ...overrides
      };
      params.CHECKSUMHASH = generateSignature(params, signWith);
      return params;
    },
    close: () => new Promise((r) => server.close(r))
  };
  return api;
}

module.exports = { startPaytmMock };
