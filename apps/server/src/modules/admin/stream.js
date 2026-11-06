'use strict';
/* Live dashboard updates over SSE: GET /api/admin/events.
     event: order   order summary (only orders that were paid; drafts never reach the shop)
     event: counts  header counters (waiting / printing / attention / ready / today)
   Each stream re-validates its admin session on every heartbeat, so logout or expiry cuts it off. */

function createAdminStream({ db, bus, service, auth, logger, maxStreams = 20, heartbeatMs = 25000 }) {
  const clients = new Set(); // { res, token }
  const orderById = db.prepare('SELECT * FROM orders WHERE id = ?');
  const write = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  let pending = new Set();
  let scheduled = false;
  function flush() {
    scheduled = false;
    const ids = pending;
    pending = new Set();
    if (!clients.size) return;
    const payloads = [];
    for (const id of ids) {
      const o = id && orderById.get(id);
      if (o && o.paid_at) payloads.push(service.orderSummary(o));
    }
    const counts = service.counts();
    for (const c of clients) {
      for (const p of payloads) write(c.res, 'order', p);
      write(c.res, 'counts', counts);
    }
  }
  const onOrder = (orderId) => {
    pending.add(orderId);
    if (!scheduled) { scheduled = true; setImmediate(flush); }
  };
  bus.on('order', onOrder);
  bus.on('queue', onOrder);

  const heartbeat = setInterval(() => {
    for (const c of clients) {
      if (!auth.resolve(c.token)) { c.res.end(); clients.delete(c); continue; }
      c.res.write(': hb\n\n');
    }
  }, heartbeatMs);
  heartbeat.unref();

  function handler(req, res, token) {
    if (clients.size >= maxStreams) {
      const oldest = clients.values().next().value;
      oldest.res.end();
      clients.delete(oldest);
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 3000\n\n');
    const c = { res, token };
    clients.add(c);
    write(res, 'counts', service.counts());
    req.on('close', () => clients.delete(c));
    logger.debug?.('admin_stream_open', { streams: clients.size });
  }

  function close() {
    clearInterval(heartbeat);
    bus.off('order', onOrder);
    bus.off('queue', onOrder);
    for (const c of clients) c.res.end();
    clients.clear();
  }

  return { handler, close, size: () => clients.size };
}

module.exports = { createAdminStream };
