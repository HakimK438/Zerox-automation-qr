'use strict';
const { notFound } = require('../../lib/errors');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ORDER_NOT_FOUND = notFound('Order not found.');

/* Loads :orderId and checks it belongs to the caller's session (req.customer). Unknown and
   foreign orders are indistinguishable (404) so order ids cannot be probed. Sets req.order. */
function createOwnedOrder(db) {
  const byId = db.prepare('SELECT * FROM orders WHERE id = ?');
  return function ownedOrder(req, res, next) {
    const id = req.params.orderId;
    const order = UUID_RE.test(id) ? byId.get(id) : null;
    if (!order || !req.customer || order.session_id !== req.customer.sessionId) return next(ORDER_NOT_FOUND);
    req.order = order;
    return next();
  };
}

module.exports = { createOwnedOrder, UUID_RE };
