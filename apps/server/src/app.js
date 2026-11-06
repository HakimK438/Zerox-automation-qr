'use strict';
/* Express wiring only. Feature modules are mounted here as each phase lands (plan Part D). */
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const express = require('express');
const cookieParser = require('cookie-parser');

const { requestId } = require('./middleware/requestId');
const { securityHeaders } = require('./middleware/securityHeaders');
const { originGuard } = require('./middleware/originGuard');
const { rateLimit } = require('./middleware/rateLimit');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { customerSession } = require('./middleware/customerSession');
const { createSessionService } = require('./modules/sessions/service');
const { createRecoveryService } = require('./modules/orders/recovery');
const { sessionRoutes } = require('./modules/sessions/routes');
const { orderRoutes } = require('./modules/orders/routes');
const { createStorage } = require('./modules/documents/storage');
const { createConversionQueue } = require('./modules/documents/queue');
const { createSettingsService } = require('./modules/settings/service');
const { createPricingService } = require('./modules/pricing/service');
const { createSecretBox } = require('./lib/secretBox');
const { createPaytmClient } = require('./modules/payments/paytm/client');
const { createPaymentService } = require('./modules/payments/service');
const { paymentRoutes } = require('./modules/payments/routes');
const { createQueueService } = require('./modules/queue/service');
const { createRealtimeHub } = require('./modules/realtime/hub');
const { shopRoutes } = require('./modules/shop/routes');
const { adminSession: createAdminSession } = require('./middleware/adminAuth');
const { createAdminAuth } = require('./modules/admin/auth');
const { createAdminService } = require('./modules/admin/service');
const { createAdminStream } = require('./modules/admin/stream');
const { adminRoutes } = require('./modules/admin/routes');
const { notFound, forbidden } = require('./lib/errors');
const { createAgentService } = require('./modules/agent/service');
const { createDispatcher } = require('./modules/agent/dispatcher');
const { agentRoutes } = require('./modules/agent/routes');
const { createRetentionJob } = require('./jobs/retention');

/**
 * @param {{ config: ReturnType<import('./config/env').loadConfig>, db: import('better-sqlite3').Database, logger: any }} deps
 */
function createApp({ config, db, logger, now = () => Date.now() }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.set('query parser', 'simple');

  app.use(requestId(logger));

  /* Two sites, one process (plan C7). Caddy forwards the Host header unchanged; the admin site and
     API answer only on the exact admin host, and the admin API does not exist on the customer host. */
  const adminHost = new URL(config.adminOrigin).host;
  app.use((req, res, next) => {
    req.isAdminHost = req.get('host') === adminHost;
    if (req.isAdminHost) res.setHeader('X-Robots-Tag', 'noindex, nofollow'); // never in search results
    next();
  });

  // Paytm JS Checkout loads a script and an iframe from the configured Paytm host only (customer site).
  const paytmHost = config.paytm ? [config.paytm.host] : [];
  const customerHeaders = securityHeaders({
    isProduction: config.isProduction,
    extraScriptSrc: paytmHost,
    extraConnectSrc: paytmHost,
    extraFrameSrc: paytmHost,
    extraStyleSrc: paytmHost,
    extraImgSrc: paytmHost,
    extraFormAction: paytmHost
  });
  const adminHeaders = securityHeaders({ isProduction: config.isProduction });
  app.use((req, res, next) => (req.isAdminHost ? adminHeaders(req, res, next) : customerHeaders(req, res, next)));
  app.use(originGuard({
    allowedOrigins: [config.publicOrigin, config.adminOrigin],
    exemptPrefixes: ['/api/payments/paytm/'] // checksum + Status API verified (phase 4)
  }));
  const globalLimit = rateLimit({ max: config.rateLimitPerMinute, name: 'global' });
  // Paytm's server-to-server webhooks come from a few gateway IPs and are verified by checksum +
  // Status API, so they are exempt from the per-IP limit (a rush hour must not throttle them).
  // The print agent shares the shop's internet connection with customers on the shop Wi-Fi: it has its
  // own per-agent limit instead (modules/agent/routes.js).
  app.use('/api', (req, res, next) => (req.path === '/payments/paytm/webhook' || req.path.startsWith('/agent/') ? next() : globalLimit(req, res, next)));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  // Liveness: no internals exposed.
  app.get('/api/health', (req, res) => res.json({ ok: true }));

  // Readiness: database answers and file storage is writable.
  app.get('/api/ready', (req, res) => {
    let database = false;
    let storage = false;
    try { database = db.prepare('SELECT 1 AS ok').get().ok === 1; } catch { database = false; }
    try { fs.accessSync(config.filesDir, fs.constants.W_OK); storage = true; } catch { storage = false; }
    const ok = database && storage;
    res.status(ok ? 200 : 503).json({ ok, database: database ? 'ok' : 'down', storage: storage ? 'ok' : 'down' });
  });

  // Host split for the API: admin host -> /api/admin/* only; customer host -> never /api/admin/*.
  app.use('/api', (req, res, next) => {
    if (req.path === '/health' || req.path === '/ready') return next();
    const adminPath = req.path === '/admin' || req.path.startsWith('/admin/');
    if (adminPath !== req.isAdminHost) return next(notFound('Not found.'));
    // Admin writes must come from the admin page itself (stricter than the shared origin guard).
    if (req.isAdminHost && !['GET', 'HEAD'].includes(req.method)) {
      const origin = req.get('origin');
      if (origin !== undefined && origin !== config.adminOrigin) return next(forbidden('Cross-origin request blocked.'));
    }
    return next();
  });

  // ---- customer API ----
  const sessions = createSessionService({ db, now });
  const recovery = createRecoveryService({ db, now });
  const session = customerSession({ sessions, config });
  const customerRouter = sessionRoutes({ db, sessions, recovery, session });
  app.use('/api', session.load, customerRouter);

  const bus = new EventEmitter();
  bus.setMaxListeners(50);
  const storage = createStorage(config.filesDir);
  const queue = createConversionQueue({ db, storage, config, logger, onUpdate: (doc) => bus.emit('document', doc) });
  const settings = createSettingsService({ db, now });
  const agents = createAgentService({ db, now });
  const pricing = createPricingService({ db, settings, now });
  const printQueue = createQueueService({ db, settings, now, printers: () => agents.usablePrinters() });
  const secretBox = createSecretBox(config.dataKey);
  const paytm = config.paytm ? createPaytmClient({
    ...config.paytm,
    callbackUrl: `${config.publicOrigin}/api/payments/paytm/callback`
  }) : null;
  const notify = (orderId) => bus.emit('order', orderId);
  // Session lifetime = until delivery: end it once its last order is handed over or refunded.
  bus.on('order', (orderId) => { if (orderId) sessions.endIfDelivered(orderId); });
  const payments = createPaymentService({ db, config, paytm, secretBox, logger, settings, notify, now });
  const dispatcher = createDispatcher({ db, agents, settings, storage, notify, logger, now });
  bus.on('order', (orderId) => dispatcher.onOrder(orderId));
  bus.on('queue', () => dispatcher.sweepAutomatic()); // unpaused, switched to automatic, printer enabled
  const ordersRouter = orderRoutes({ db, config, storage, queue, session, pricing, settings, pins: payments.pinFor, printQueue, bus });
  const paymentsRouter = paymentRoutes({ db, config, payments, session });
  const hub = createRealtimeHub({ db, bus, queue: printQueue, views: ordersRouter.views, logger });
  const shopRouter = shopRoutes({ settings, printQueue, hub, session });
  const agentRouter = agentRoutes({ agents, dispatcher, logger });
  const retention = createRetentionJob({ db, storage, settings, logger, notify, now });
  app.use('/api', ordersRouter, paymentsRouter, shopRouter, agentRouter);

  // ---- admin API (admin host only) ----
  const adminAuth = createAdminAuth({ db, secretBox, dataKey: config.dataKey, now });
  const adminSession = createAdminSession({ auth: adminAuth, config });
  const adminService = createAdminService({ db, printQueue, dispatcher, notify, now });
  const adminStream = createAdminStream({ db, bus, service: adminService, auth: adminAuth, logger });
  const adminRouter = adminRoutes({ config, auth: adminAuth, adminSession, service: adminService, settings, pricing, payments, storage, stream: adminStream, bus, agents, agentRouter });
  app.use('/api/admin', adminSession.load, adminRouter);


  app.use('/api', notFoundHandler);

  // Admin site: the dashboard page is only served to a logged-in admin; everyone else gets the login page.
  // (Its JS/CSS hold no data; every byte of shop data comes from /api/admin behind the session.)
  if (config.serveStatic) {
    const adminStatic = express.static(config.adminWebDir, {
      index: false,
      dotfiles: 'ignore',
      redirect: false,
      setHeaders(res, filePath) {
        res.setHeader('Cache-Control', filePath.includes(`${path.sep}vendor${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
      }
    });
    const page = (name) => (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(path.join(config.adminWebDir, name));
    };
    app.use((req, res, next) => {
      if (!req.isAdminHost) return next();
      if (req.method !== 'GET' && req.method !== 'HEAD') return next(notFound('Not found.'));
      if (req.path === '/' || req.path === '/index.html' || req.path === '/owner.html' || req.path === '/login.html') {
        adminSession.load(req, res, () => page(req.admin ? 'owner.html' : 'login.html')(req, res));
        return undefined;
      }
      return adminStatic(req, res, () => next(notFound('Not found.')));
    });
  }

  // Customer site (Caddy serves the same files in production; Node serves them in dev and as a fallback).
  if (config.serveStatic) {
    app.use(express.static(config.webDir, {
      index: 'index.html',
      dotfiles: 'ignore',
      redirect: false,
      setHeaders(res, filePath) {
        // HTML must revalidate (new deploys reach phones); vendor libraries are pinned and immutable.
        res.setHeader('Cache-Control', filePath.includes(`${path.sep}vendor${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
      }
    }));
  }
  app.use(errorHandler(logger));

  app.locals.storage = storage;
  app.locals.queue = queue;
  app.locals.pricing = pricing;
  app.locals.settings = settings;
  app.locals.payments = payments;
  app.locals.printQueue = printQueue;
  app.locals.bus = bus;
  app.locals.hub = hub;
  app.locals.adminAuth = adminAuth;
  app.locals.adminStream = adminStream;
  app.locals.agents = agents;
  app.locals.dispatcher = dispatcher;
  app.locals.retention = retention;
  app.locals.agentRouter = agentRouter;
  /** Ends every long-lived stream (customer, admin, agent) so server.close() can finish. */
  app.locals.closeStreams = () => { hub.close(); adminStream.close(); agentRouter.close(); };
  app.locals.shutdown = () => {
    globalLimit.stop(); customerRouter.stop(); ordersRouter.stop(); paymentsRouter.stop(); shopRouter.stop(); adminRouter.stop(); agentRouter.stop();
    hub.close(); adminStream.close(); agentRouter.close(); dispatcher.stop(); retention.stop();
    return queue.close();
  };
  return app;
}

module.exports = { createApp };
