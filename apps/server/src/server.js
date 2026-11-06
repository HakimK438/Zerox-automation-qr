'use strict';
const fs = require('node:fs');
const { loadConfig } = require('./config/env');
const { openDatabase } = require('./db');
const { createApp } = require('./app');
const { createLogger } = require('./lib/logger');
const { createSessionExpiryJob } = require('./jobs/sessionExpiry');
const { createPaymentReconciler } = require('./jobs/paymentReconciler');

function main() {
  const logger = createLogger({ level: process.env.QP_LOG_LEVEL || 'info' });
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    logger.error('config_invalid', { err: err.message });
    process.exit(1);
  }

  // Private storage: owner-only permissions, never inside a web root.
  fs.mkdirSync(config.filesDir, { recursive: true, mode: 0o700 });
  const db = openDatabase(config.dbPath);
  const app = createApp({ config, db, logger });
  const sessionExpiry = createSessionExpiryJob({ db, logger });
  sessionExpiry.start();
  const reconciler = createPaymentReconciler({ payments: app.locals.payments, logger });
  reconciler.start();
  app.locals.dispatcher.start(); // print lease watchdog
  app.locals.retention.start();  // delete customer files when no longer needed
  if (!config.paytm) logger.warn('payments_disabled', { reason: 'PAYTM_MID / PAYTM_MERCHANT_KEY not set' });
  // Crash recovery: drop half-written uploads, resume interrupted conversions.
  app.locals.storage.cleanTmp()
    .then(() => app.locals.queue.recover())
    .catch((err) => logger.error('startup_recovery_failed', { err: err.stack }));

  // Bind to loopback only: Caddy terminates TLS and is the single public entry point.
  const server = app.listen(config.port, config.host, () => {
    logger.info('listening', { host: config.host, port: config.port, env: config.env });
  });
  server.requestTimeout = 120000; // uploads on slow mobile networks
  server.headersTimeout = 30000;

  // Development convenience: also listen on the admin origin's port (e.g. localhost:3001) so the two
  // sites have different Host headers. In production Caddy sends both domains to config.port.
  const extra = [];
  const adminUrl = new URL(config.adminOrigin);
  if (!config.isProduction && ['localhost', '127.0.0.1'].includes(adminUrl.hostname) && adminUrl.port && Number(adminUrl.port) !== config.port) {
    const adminServer = app.listen(Number(adminUrl.port), config.host, () => logger.info('admin_listening', { origin: config.adminOrigin }));
    adminServer.on('error', (err) => logger.warn('admin_listen_failed', { err: err.message }));
    extra.push(adminServer);
  }

  const shutdown = (signal) => {
    logger.info('shutting_down', { signal });
    app.locals.closeStreams(); // live streams never end by themselves; browsers reconnect to the new process
    for (const s of extra) { s.close(); s.closeAllConnections(); }
    server.close(async () => {
      sessionExpiry.stop();
      reconciler.stop();
      await app.locals.shutdown();
      db.close();
      process.exit(0);
    });
    server.closeIdleConnections();
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) main();

module.exports = { main };
