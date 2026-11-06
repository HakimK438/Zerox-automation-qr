/* Quick Print API client (customer site).
   Replaces the localStorage mock in shared.js step by step; each phase adds its calls here.
   Same-origin only: the session lives in an HttpOnly cookie that this script can never read. */
const QPApi = (() => {
  class ApiError extends Error {
    constructor(status, code, message) { super(QPI18n.server(message)); this.status = status; this.code = code; }
  }

  async function request(path, { method = 'GET', body } = {}) {
    let res;
    try {
      res = await fetch(path, {
        method,
        credentials: 'same-origin',
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (e) {
      throw new ApiError(0, 'offline', 'No internet connection. Please check your network and try again.');
    }
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) {
      const err = data && data.error;
      throw new ApiError(res.status, err?.code || 'error', err?.message || 'Something went wrong. Please try again.');
    }
    return data;
  }

  /* ---------- phase 1: session + recovery ---------- */

  /** Call on every page load: creates the anonymous session or reuses the existing one. */
  const ensureSession = () => request('/api/session', { method: 'POST' });

  /** This browser's orders; `activeOrderId` is the one to reopen after the tab was closed. */
  const myOrders = () => request('/api/me/orders');

  /** Token (e.g. "XR-105") + 4-digit PIN from the token page. Moves the order to this browser. */
  const recoverOrder = (token, pin) => request('/api/orders/recover', { method: 'POST', body: { token, pin } });

  /**
   * Startup helper: ensures a session, then tells the page what to reopen.
   * @returns {{ orderId: string|null, draftOrderId: string|null }} orderId = submitted order to show
   *          (an explicit #order= link wins if it belongs to this browser); draftOrderId = unfinished upload.
   */
  async function restore(hashOrderId) {
    await ensureSession();
    const { orders, activeOrderId, draftOrderId } = await myOrders();
    const linked = hashOrderId && orders.some((o) => o.orderId === hashOrderId) ? hashOrderId : null;
    return { orderId: linked || activeOrderId, draftOrderId };
  }

  /* ---------- phase 2: draft order + documents ---------- */

  /** Starts this browser's draft order, or returns the existing one. */
  const startOrder = () => request('/api/orders', { method: 'POST' });
  const getOrder = (orderId) => request(`/api/orders/${encodeURIComponent(orderId)}`);
  const getDocument = (orderId, documentId) =>
    request(`/api/orders/${encodeURIComponent(orderId)}/documents/${encodeURIComponent(documentId)}`);
  const deleteDocument = (orderId, documentId) =>
    request(`/api/orders/${encodeURIComponent(orderId)}/documents/${encodeURIComponent(documentId)}`, { method: 'DELETE' });

  /**
   * Uploads one file with progress. XHR (not fetch) because fetch has no upload progress events.
   * Resolves to the document ({ documentId, status: 'queued', ... }); conversion continues on the server.
   * @param {(fraction: number) => void} [onProgress]
   * @returns {{ promise: Promise<object>, cancel: () => void }}
   */
  function uploadDocument(orderId, file, onProgress) {
    const xhr = new XMLHttpRequest();
    const promise = new Promise((resolve, reject) => {
      xhr.open('POST', `/api/orders/${encodeURIComponent(orderId)}/documents`);
      xhr.withCredentials = true;
      xhr.responseType = 'json';
      xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
      xhr.onload = () => {
        const data = xhr.response;
        if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
        const err = data && data.error;
        return reject(new ApiError(xhr.status, err?.code || 'error', err?.message || 'Upload failed. Please try again.'));
      };
      xhr.onerror = () => reject(new ApiError(0, 'offline', 'Upload failed. Please check your network and try again.'));
      xhr.onabort = () => reject(new ApiError(0, 'aborted', 'Upload cancelled.'));
      const form = new FormData();
      form.append('file', file, file.name);
      xhr.send(form);
    });
    return { promise, cancel: () => xhr.abort() };
  }

  /**
   * Polls a document until conversion finishes (live updates replace this in phase 5).
   * Resolves with the final document ({ status: 'ready' | 'failed', pageCount, error, previewUrl }).
   */
  async function waitForDocument(orderId, documentId, { onUpdate, intervalMs = 1000, timeoutMs = 180000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const doc = await getDocument(orderId, documentId);
      if (onUpdate) onUpdate(doc);
      if (doc.status === 'ready' || doc.status === 'failed') return doc;
      if (Date.now() > deadline) throw new ApiError(0, 'timeout', 'This file is taking too long. Please try again.');
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  /* File picker accept list: extensions + MIME types.
     HEIC is deliberately NOT listed: when the page doesn't accept HEIC, iPhone Safari converts camera
     photos to JPEG before upload (the most reliable path). The server still accepts .heic/.heif. */
  const ACCEPT = [
    '.pdf', 'application/pdf',
    '.doc', 'application/msword',
    '.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.ppt', 'application/vnd.ms-powerpoint',
    '.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.jpg', '.jpeg', 'image/jpeg',
    '.png', 'image/png'
  ].join(',');

  /* ---------- phase 3: print settings, quote, checkout ---------- */

  /** Current rates (paise) and options: { rates:{bw1,bw2,col1,col2}, duplexBasis, a3Multiplier, options }. */
  const getPricing = () => request('/api/pricing');

  /**
   * Saves one document's print settings. The server re-prices; never send prices or page counts.
   * @param {{ copies: number, parts: Array<{ pages: string, color: boolean, duplex: boolean, paper: 'A4'|'A3' }> }} settings
   *        pages is "all" or e.g. "1-5, 8"
   * @returns {Promise<{ document, priced: { amountPaise, error, parts:[{ error, amountPaise, ... }] }, totalPaise, ready }>}
   */
  const setParts = (orderId, documentId, settings) =>
    request(`/api/orders/${encodeURIComponent(orderId)}/documents/${encodeURIComponent(documentId)}/parts`, { method: 'PUT', body: settings });

  /** Authoritative quote: { ready, frozen, totalPaise, sides, sheets, documents:[...], errors:[...] }. */
  const getQuote = (orderId) => request(`/api/orders/${encodeURIComponent(orderId)}/quote`);

  /**
   * Freezes the price and submits the order for payment. 409 `not_ready` (err.message says why)
   * when a file is still converting, failed, or has invalid page numbers. Safe to retry.
   */
  const checkout = (orderId) => request(`/api/orders/${encodeURIComponent(orderId)}/checkout`, { method: 'POST' });

  /** Paise -> "₹12.50" / "₹12" for display only. */
  const money = (paise) => '₹' + (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 });

  /* ---------- phase 4: payment ---------- */

  /**
   * Starts (or resumes) payment for a checked-out order. Returns
   * { paymentId, status, amount, amountPaise, expiresAt, mid, txnToken, host, checkoutJsUrl,
   *   deepLink (upi://… or null), appLinks:[{ app, label, url }] (iOS: GPay/PhonePe/Paytm/BHIM) }.
   * The page decides how to present it per device (plan C10). It never marks anything paid itself.
   */
  const startPayment = (orderId) => request(`/api/orders/${encodeURIComponent(orderId)}/payments`, { method: 'POST' });

  /** Test mode only: pretend the customer paid ('success') or the payment failed ('fail'). */
  const testPayment = (orderId, result) => request(`/api/orders/${encodeURIComponent(orderId)}/test-payment`, { method: 'POST', body: { result } });

  /** { orderStatus, paid, payment }. Poll this after returning from the UPI app (server asks Paytm). */
  const paymentStatus = (orderId) => request(`/api/orders/${encodeURIComponent(orderId)}/payment-status`);

  /** Back to editing. The server first confirms with Paytm that nothing was paid (409 if it was). */
  const reopenOrder = (orderId) => request(`/api/orders/${encodeURIComponent(orderId)}/reopen`, { method: 'POST' });

  /**
   * Waits for a verified payment: polls now, on focus/visibility return (iOS doesn't auto-return
   * from the UPI app) and every few seconds. Resolves with the final status; call stop() to cancel.
   */
  function watchPayment(orderId, { onUpdate, intervalMs = 4000, timeoutMs = 20 * 60000 } = {}) {
    let stopped = false;
    let timer = null;
    const deadline = Date.now() + timeoutMs;
    let resolveDone;
    const done = new Promise((r) => { resolveDone = r; });
    const finish = (s) => { if (!stopped) { stop(); resolveDone(s); } };
    async function check() {
      if (stopped) return;
      try {
        const s = await paymentStatus(orderId);
        if (onUpdate) onUpdate(s);
        if (s.paid || ['expired', 'cancelled', 'draft'].includes(s.orderStatus)) return finish(s);
      } catch (e) { /* offline: keep trying */ }
      if (Date.now() > deadline) return finish(null);
      clearTimeout(timer);
      timer = setTimeout(check, intervalMs);
    }
    const onVisible = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', check);
    function stop() {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', check);
    }
    check();
    return { done, stop, checkNow: check };
  }

  /* ---------- phase 5: shop, queue, live updates, rating ---------- */

  const getShop = () => request('/api/shop');
  /** "Ready in about N minutes" for a not-yet-placed order. */
  const estimate = ({ bw = 0, color = 0, duplex = false }) =>
    request(`/api/queue/estimate?bw=${bw | 0}&color=${color | 0}&duplex=${duplex ? 1 : 0}`);
  const rateOrder = (orderId, stars) => request(`/api/orders/${encodeURIComponent(orderId)}/rating`, { method: 'POST', body: { stars } });

  /**
   * Live updates for this browser's orders. Calls onOrder(order) / onDocument(doc) as the server
   * pushes them; falls back to calling onPoll() every pollMs when the stream is down (old browsers,
   * proxies, iOS background). Returns { close, connected() }.
   */
  function live({ onOrder, onDocument, onPoll, pollMs = 15000 }) {
    let es = null;
    let ok = false;
    let pollTimer = null;
    const poll = () => { if (!ok && onPoll) onPoll(); };
    if (window.EventSource) {
      es = new EventSource('/api/me/events');
      es.onopen = () => { ok = true; };
      es.onerror = () => { ok = false; };
      es.addEventListener('order', (e) => { try { onOrder && onOrder(JSON.parse(e.data)); } catch (x) { /* ignore */ } });
      es.addEventListener('document', (e) => { try { onDocument && onDocument(JSON.parse(e.data)); } catch (x) { /* ignore */ } });
    }
    pollTimer = setInterval(poll, pollMs);
    const onVisible = () => { if (document.visibilityState === 'visible' && onPoll) onPoll(); };
    document.addEventListener('visibilitychange', onVisible);
    return {
      connected: () => ok,
      close() { if (es) es.close(); clearInterval(pollTimer); document.removeEventListener('visibilitychange', onVisible); }
    };
  }

  return {
    ApiError, request, ensureSession, myOrders, recoverOrder, restore,
    getShop, estimate, rateOrder, live,
    startOrder, getOrder, getDocument, deleteDocument, uploadDocument, waitForDocument, ACCEPT,
    getPricing, setParts, getQuote, checkout, money,
    startPayment, testPayment, paymentStatus, reopenOrder, watchPayment
  };
})();
