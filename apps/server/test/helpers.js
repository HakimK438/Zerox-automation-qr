'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../src/config/env');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/app');
const { createLogger } = require('../src/lib/logger');

/** Boots an isolated app (fresh temp data dir) on a random port. */
async function startTestApp(envOverrides = {}, { now } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-test-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    QP_DATA_DIR: dataDir,
    QP_PUBLIC_ORIGIN: 'http://localhost:3000',
    QP_ADMIN_ORIGIN: 'http://127.0.0.1:3001',
    ...envOverrides
  });
  fs.mkdirSync(config.filesDir, { recursive: true, mode: 0o700 });
  const db = openDatabase(config.dbPath);
  const app = createApp({ config, db, logger: createLogger({ level: 'silent' }), ...(now ? { now } : {}) });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = async () => {
    app.locals.closeStreams(); // end live streams first, or server.close() waits for them forever
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await app.locals.shutdown();
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  return { base, config, db, app, close };
}

module.exports = { startTestApp };
