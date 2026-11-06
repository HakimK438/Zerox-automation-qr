'use strict';
/* Live updates over Server-Sent Events (plan C5/C10).
   A customer's browser opens GET /api/me/events and receives only its own session's orders:
     event: order     full order view (status, token, PIN, queue position, ETA)  on any change
     event: document  conversion progress of one uploaded file
   Why SSE: one-way, works through Caddy and mobile networks, auto-reconnects, no extra library.
   Clients must still poll occasionally (iOS suspends background tabs); see apps/web/api.js. */
const { ACTIVE_ORDER_STATUSES } = require('../../../../../shared/constants');

function createRealtimeHub({ db, bus, queue, views, logger, maxPerSession = 4, maxTotal = 2000, heartbeatMs = 25000 }) {
  const clients = new Map(); // sessionId -> Set<res>
  let total = 0;
  const activeList = ACTIVE_ORDER_STATUSES.map(() => '?').join(',');
  const q = {
    order: db.prepare('SELECT * FROM orders WHERE id = ?'),
    sessionOrders: db.prepare(`SELECT * FROM orders WHERE session_id = ? AND status IN (${activeList}) ORDER BY created_at DESC LIMIT 10`),
    draft: db.prepare("SELECT * FROM orders WHERE session_id = ? AND status = 'draft' ORDER BY created_at DESC LIMIT 1")
  };

  const write = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const sendTo = (sessionId, event, data) => {
    const set = clients.get(sessionId);
    if (set) for (const res of set) write(res, event, data);
  };

  /* Coalesce bursts (a payment changes one order but every queued ETA) into one flush per tick. */
  let pendingOrders = new Set();
  let queueChanged = false;
  let flushScheduled = false;
  function scheduleFlush() {
    if (flushScheduled) return;
    flushScheduled = true;
    setImmediate(flush);
  }
  function flush() {
    flushScheduled = false;
    const ids = pendingOrders;
    pendingOrders = new Set();
    if (queueChanged) {
      queueChanged = false;
      for (const id of queue.queuedOrderIds()) ids.add(id); // everyone behind may have a new ETA
    }
    for (const id of ids) {
      const o = q.order.get(id);
      if (o && clients.has(o.session_id)) sendTo(o.session_id, 'order', views.order(o));
    }
  }

  bus.on('order', (orderId) => {
    queue.invalidate();
    pendingOrders.add(orderId);
    queueChanged = true;
    scheduleFlush();
  });
  // Settings changed (pause, speeds, mode): every queued customer gets a fresh ETA.
  bus.on('queue', () => {
    queue.invalidate();
    queueChanged = true;
    scheduleFlush();
  });
  bus.on('document', (doc) => {
    const o = q.order.get(doc.order_id);
    if (o && clients.has(o.session_id)) sendTo(o.session_id, 'document', { orderId: o.id, ...views.document(doc) });
  });

  const heartbeat = setInterval(() => {
    for (const set of clients.values()) for (const res of set) res.write(': hb\n\n');
  }, heartbeatMs);
  heartbeat.unref();

  /** Express handler for GET /api/me/events (session required). */
  function handler(req, res) {
    const sessionId = req.customer.sessionId;
    if (total >= maxTotal) return res.status(503).json({ error: { code: 'busy', message: 'Live updates are busy; the page will refresh by itself.' } });
    let set = clients.get(sessionId);
    if (!set) { set = new Set(); clients.set(sessionId, set); }
    if (set.size >= maxPerSession) { // a phone with many tabs: drop the oldest
      const oldest = set.values().next().value;
      oldest.end();
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 5000\n\n');
    set.add(res);
    total += 1;

    // Snapshot so a reconnecting page is immediately up to date.
    for (const o of q.sessionOrders.all(sessionId, ...ACTIVE_ORDER_STATUSES)) write(res, 'order', views.order(o));
    const draft = q.draft.get(sessionId);
    if (draft) write(res, 'order', views.order(draft));

    req.on('close', () => {
      if (set.delete(res)) total -= 1;
      if (set.size === 0) clients.delete(sessionId);
    });
  }

  function close() {
    clearInterval(heartbeat);
    for (const set of clients.values()) for (const res of set) res.end();
    clients.clear();
    total = 0;
  }

  return { handler, close, stats: () => ({ sessions: clients.size, connections: total }) };
}

module.exports = { createRealtimeHub };
