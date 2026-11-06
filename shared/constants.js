'use strict';
/* Single source of truth for order states, transitions and accepted file types.
   Imported by the server; the web apps get the labels via the API. */

const ORDER_STATUS = Object.freeze({
  DRAFT: 'draft',                       // uploading / configuring
  AWAITING_PAYMENT: 'awaiting_payment', // quote frozen, Paytm txn started
  PAID: 'paid',                         // verified by Paytm, token assigned, in queue
  PRINTING: 'printing',
  PRINT_ATTENTION: 'print_attention',   // agent error or uncertain result, admin must decide
  READY: 'ready',
  HANDED_OVER: 'handed_over',
  CANCELLED: 'cancelled',               // before payment
  EXPIRED: 'expired',                   // unpaid too long
  REFUND_PENDING: 'refund_pending',
  REFUNDED: 'refunded'
});

const S = ORDER_STATUS;

/* Who may perform each transition.
   'system'   = server internals (payment verification, expiry job, print agent results)
   'admin'    = authenticated shop admin
   'customer' = session that owns the order
   NOTE: nobody but 'system' (payment verification) can ever move an order to PAID. */
const TRANSITIONS = Object.freeze({
  [S.DRAFT]: { [S.AWAITING_PAYMENT]: ['customer'], [S.CANCELLED]: ['customer', 'system'], [S.EXPIRED]: ['system'] },
  [S.AWAITING_PAYMENT]: { [S.PAID]: ['system'], [S.DRAFT]: ['system'], [S.CANCELLED]: ['customer', 'system'], [S.EXPIRED]: ['system'] },
  [S.PAID]: { [S.PRINTING]: ['admin', 'system'], [S.READY]: ['admin'], [S.REFUND_PENDING]: ['admin'], [S.PRINT_ATTENTION]: ['system'] },
  [S.PRINTING]: { [S.READY]: ['admin', 'system'], [S.PRINT_ATTENTION]: ['system', 'admin'] },
  [S.PRINT_ATTENTION]: { [S.PRINTING]: ['admin'], [S.READY]: ['admin'], [S.REFUND_PENDING]: ['admin'] },
  [S.READY]: { [S.HANDED_OVER]: ['admin'], [S.PRINTING]: ['admin'] },
  [S.REFUND_PENDING]: { [S.REFUNDED]: ['system'], [S.PRINT_ATTENTION]: ['system'] },
  [S.HANDED_OVER]: {},
  [S.CANCELLED]: {},
  // Late success: Paytm confirmed after the payment window closed. The money was taken, so honour it.
  [S.EXPIRED]: { [S.PAID]: ['system'] },
  [S.REFUNDED]: {}
});

/** @returns {boolean} whether `actor` may move an order from `from` to `to`. */
function canTransition(from, to, actor) {
  const allowed = TRANSITIONS[from] && TRANSITIONS[from][to];
  return Array.isArray(allowed) && allowed.includes(actor);
}

/* Orders in these states keep the customer's session alive (plan C1). */
const ACTIVE_ORDER_STATUSES = Object.freeze([S.AWAITING_PAYMENT, S.PAID, S.PRINTING, S.PRINT_ATTENTION, S.READY, S.REFUND_PENDING]);
/* Orders in these states are in the print queue (plan C5). */
const QUEUE_STATUSES = Object.freeze([S.PAID, S.PRINTING, S.PRINT_ATTENTION]);

/* Customer-facing labels, matching the GitHub frontend's QP.LABEL wording. */
const STATUS_LABEL = Object.freeze({
  [S.DRAFT]: 'Not submitted',
  [S.AWAITING_PAYMENT]: 'Payment Not Received',
  [S.PAID]: 'Order received',
  [S.PRINTING]: 'Printing',
  [S.PRINT_ATTENTION]: 'Printing',
  [S.READY]: 'Ready for pickup',
  [S.HANDED_OVER]: 'Collected',
  [S.CANCELLED]: 'Cancelled',
  [S.EXPIRED]: 'Expired',
  [S.REFUND_PENDING]: 'Refund in progress',
  [S.REFUNDED]: 'Refunded'
});

/* Accepted uploads: extension -> allowed declared MIME types. Content is also magic-byte sniffed (plan C2).
   Phones and some PCs label Office files as plain zip or with older names, so those are listed too. */
const WORD_OLD = ['application/msword', 'application/vnd.ms-word', 'application/doc', 'application/vnd.ms-office', 'application/x-msword'];
const WORD_NEW = ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip', 'application/x-zip-compressed'];
const PPT_OLD = ['application/vnd.ms-powerpoint', 'application/mspowerpoint', 'application/vnd.ms-office'];
const PPT_NEW = ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/zip', 'application/x-zip-compressed'];

const UPLOAD_TYPES = Object.freeze({
  '.pdf': ['application/pdf'],
  '.jpg': ['image/jpeg'],
  '.jpeg': ['image/jpeg'],
  '.png': ['image/png'],
  '.heic': ['image/heic', 'image/heif'],
  '.heif': ['image/heif', 'image/heic'],
  '.doc': [...WORD_OLD, ...WORD_NEW],
  '.docx': [...WORD_NEW, ...WORD_OLD],
  '.ppt': [...PPT_OLD, ...PPT_NEW],
  '.pptx': [...PPT_NEW, ...PPT_OLD]
});

const PAPER_SIZES = Object.freeze(['A4', 'A3']);

module.exports = {
  ORDER_STATUS,
  TRANSITIONS,
  canTransition,
  ACTIVE_ORDER_STATUSES,
  QUEUE_STATUSES,
  STATUS_LABEL,
  UPLOAD_TYPES,
  PAPER_SIZES
};
