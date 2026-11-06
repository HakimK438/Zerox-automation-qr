'use strict';
/* Validated runtime configuration. Fails fast on bad config; never ships default secrets. */
const fs = require('node:fs');
const path = require('node:path');
const { z } = require('zod');

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  // Directory holding the SQLite database and private file storage (block volume in production).
  QP_DATA_DIR: z.string().min(1).default(path.resolve(__dirname, '../../../../data')),
  // Exact public origins (scheme://host[:port]); used for CORS, CSP and cookie decisions.
  QP_PUBLIC_ORIGIN: z.url().default('http://localhost:3000'),
  QP_ADMIN_ORIGIN: z.url().default('http://localhost:3001'),
  // Express "trust proxy" setting. Caddy runs on the same host, so trust only loopback.
  QP_TRUST_PROXY: z.string().default('loopback'),
  QP_MAX_UPLOAD_MB: z.coerce.number().positive().max(100).default(25),
  QP_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(120),
  QP_MAX_DOCS_PER_ORDER: z.coerce.number().int().min(1).max(50).default(10),
  QP_MAX_PAGES_PER_DOC: z.coerce.number().int().min(1).max(5000).default(500),
  // LibreOffice binary for DOC/DOCX/PPT/PPTX -> PDF. Missing binary = office uploads fail politely.
  QP_SOFFICE_PATH: z.string().min(1).default('soffice'),
  QP_CONVERT_TIMEOUT_MS: z.coerce.number().int().min(5000).max(600000).default(120000),
  QP_OFFICE_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
  QP_FAST_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  QP_COOKIE_SECURE: bool.optional(),
  // 32-byte key (base64) encrypting the pickup PIN at rest. Required in production.
  QP_DATA_KEY: z.string().optional(),
  // Paytm PG. Required in production; without them payments answer 503 in dev.
  PAYTM_MID: z.string().regex(/^[A-Za-z0-9]{1,40}$/).optional(),
  PAYTM_MERCHANT_KEY: z.string().length(16, 'PAYTM_MERCHANT_KEY must be the 16-character merchant key').optional(),
  PAYTM_WEBSITE: z.string().min(1).default('WEBSTAGING'),
  PAYTM_HOST: z.url().default('https://securegw-stage.paytm.in'),
  // 'test' = built-in test payments (no money, no Paytm account). Refused in production.
  // Default: test in development when no Paytm keys are set, otherwise paytm.
  QP_PAYMENT_MODE: z.enum(['paytm', 'test']).optional(),
  QP_PAYMENT_TTL_MIN: z.coerce.number().int().min(5).max(60).default(15),
  QP_ORDER_PAYMENT_WINDOW_MIN: z.coerce.number().int().min(10).max(240).default(30),
  // Serve the customer site from Node (dev, tests, fallback). Caddy serves it in production.
  QP_SERVE_STATIC: bool.default('true'),
  QP_WEB_DIR: z.string().min(1).default(path.resolve(__dirname, '../../../web')),
  QP_ADMIN_WEB_DIR: z.string().min(1).default(path.resolve(__dirname, '../../../admin'))
});

// Dev/test-only key so local runs work without setup. Production refuses to start without QP_DATA_KEY.
const DEV_DATA_KEY = Buffer.alloc(32, 7).toString('base64');

/* 'false' -> no proxy trusted (direct exposure); a number -> hop count; otherwise an Express
   trust list such as 'loopback'. 'true' (trust everything) is refused: it lets clients forge their IP. */
function parseTrustProxy(value) {
  const v = value.trim();
  if (v === 'false') return false;
  if (v === 'true') throw new Error('Invalid configuration:\n- QP_TRUST_PROXY=true would let clients spoof their IP.');
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

/* The installer on Windows does not add LibreOffice to PATH, so look in its usual folders.
   soffice.com (not .exe) is the console launcher: it stays open until the conversion has finished. */
function findSoffice(configured, platform = process.platform) {
  if (configured !== 'soffice' || platform !== 'win32') return configured;
  for (const dir of ['C:\\Program Files\\LibreOffice\\program', 'C:\\Program Files (x86)\\LibreOffice\\program']) {
    const file = path.join(dir, 'soffice.com');
    if (fs.existsSync(file)) return file;
  }
  return configured;
}

function loadConfig(env = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `- ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const c = parsed.data;
  const isProduction = c.NODE_ENV === 'production';
  const cookieSecure = c.QP_COOKIE_SECURE ?? isProduction;

  const hasPaytmKeys = Boolean(c.PAYTM_MID && c.PAYTM_MERCHANT_KEY);
  const paymentMode = c.QP_PAYMENT_MODE ?? (c.NODE_ENV === 'development' && !hasPaytmKeys ? 'test' : 'paytm');

  const errors = [];
  if (isProduction) {
    if (!c.QP_PUBLIC_ORIGIN.startsWith('https://')) errors.push('QP_PUBLIC_ORIGIN must be https in production.');
    if (!c.QP_ADMIN_ORIGIN.startsWith('https://')) errors.push('QP_ADMIN_ORIGIN must be https in production.');
    if (c.QP_PUBLIC_ORIGIN === c.QP_ADMIN_ORIGIN) errors.push('Admin must be served from a separate origin.');
    if (!cookieSecure) errors.push('Secure cookies are mandatory in production.');
    // Test payments give free orders to anyone who presses the button, so they can never go live.
    if (paymentMode === 'test') errors.push('QP_PAYMENT_MODE=test is not allowed in production.');
    if (!c.QP_DATA_KEY) errors.push('QP_DATA_KEY is required in production (32 random bytes, base64).');
    if (!c.PAYTM_MID || !c.PAYTM_MERCHANT_KEY) errors.push('PAYTM_MID and PAYTM_MERCHANT_KEY are required in production.');
    if (!c.PAYTM_HOST.startsWith('https://')) errors.push('PAYTM_HOST must be https in production.');
  }
  const dataKey = Buffer.from(c.QP_DATA_KEY || DEV_DATA_KEY, 'base64');
  if (dataKey.length !== 32) errors.push('QP_DATA_KEY must decode to exactly 32 bytes.');
  if (errors.length) throw new Error(`Invalid configuration:\n${errors.map((e) => `- ${e}`).join('\n')}`);

  const dataDir = path.resolve(c.QP_DATA_DIR);
  return Object.freeze({
    env: c.NODE_ENV,
    isProduction,
    host: c.HOST,
    port: c.PORT,
    dataDir,
    dbPath: path.join(dataDir, 'quickprint.db'),
    filesDir: path.join(dataDir, 'files'),
    publicOrigin: new URL(c.QP_PUBLIC_ORIGIN).origin,
    adminOrigin: new URL(c.QP_ADMIN_ORIGIN).origin,
    trustProxy: parseTrustProxy(c.QP_TRUST_PROXY),
    maxUploadBytes: Math.floor(c.QP_MAX_UPLOAD_MB * 1024 * 1024),
    rateLimitPerMinute: c.QP_RATE_LIMIT_PER_MIN,
    maxDocsPerOrder: c.QP_MAX_DOCS_PER_ORDER,
    maxPagesPerDoc: c.QP_MAX_PAGES_PER_DOC,
    sofficePath: findSoffice(c.QP_SOFFICE_PATH),
    convertTimeoutMs: c.QP_CONVERT_TIMEOUT_MS,
    officeConcurrency: c.QP_OFFICE_CONCURRENCY,
    fastConcurrency: c.QP_FAST_CONCURRENCY,
    cookieSecure,
    dataKey,
    testPayments: paymentMode === 'test',
    paytm: hasPaytmKeys ? Object.freeze({
      mid: c.PAYTM_MID,
      key: c.PAYTM_MERCHANT_KEY,
      website: c.PAYTM_WEBSITE,
      host: new URL(c.PAYTM_HOST).origin
    }) : null,
    paymentTtlMs: c.QP_PAYMENT_TTL_MIN * 60000,
    orderPaymentWindowMs: c.QP_ORDER_PAYMENT_WINDOW_MIN * 60000,
    serveStatic: c.QP_SERVE_STATIC,
    webDir: path.resolve(c.QP_WEB_DIR),
    adminWebDir: path.resolve(c.QP_ADMIN_WEB_DIR),
    adminHost: new URL(c.QP_ADMIN_ORIGIN).host
  });
}

module.exports = { loadConfig, findSoffice };
