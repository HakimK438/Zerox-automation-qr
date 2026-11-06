const express = require('express');
const cookieParser = require('cookie-parser');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { PDFDocument, StandardFonts } = require('pdf-lib');

const app = express();
const PORT = process.env.PORT || 3000;
const FRONTEND_ALLOWED_ORIGINS = new Set([
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
  'null'
]);
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE_NAME = 'quick_print_session';
const ADMIN_SESSION_COOKIE_NAME = 'quick_print_admin_session';
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_ADMIN_USERNAME = process.env.QP_ADMIN_USERNAME || 'admin';
const DEFAULT_ADMIN_PASSWORD = process.env.QP_ADMIN_PASSWORD || 'admin123';
const DB_PATH = process.env.QP_DB_PATH || path.join(__dirname, 'quickprint.db');
const isProductionEnvironment = process.env.NODE_ENV === 'production';
const COOKIE_SECURE = process.env.QP_COOKIE_SECURE ? process.env.QP_COOKIE_SECURE === 'true' : isProductionEnvironment;
const UPLOAD_LIMIT_MB = Number(process.env.QP_MAX_UPLOAD_MB || 50);
const MAX_UPLOAD_SIZE_BYTES = Number.isFinite(UPLOAD_LIMIT_MB) && UPLOAD_LIMIT_MB > 0 ? Math.floor(UPLOAD_LIMIT_MB * 1024 * 1024) : 50 * 1024 * 1024;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_REQUESTS_PER_MINUTE = Number(process.env.QP_RATE_LIMIT_PER_MINUTE || 120);
const RATE_LIMIT_BUCKETS = new Map();
const SCHEMA_VERSION = 3;
const DEFAULT_PRINT_PPM = Number(process.env.QP_PRINT_PPM || 20);
const ENABLED_PAYMENT_PROVIDERS = new Set(['demo']);
if (String(process.env.QP_ENABLE_PAYTM || '').toLowerCase() === 'true') {
  ENABLED_PAYMENT_PROVIDERS.add('paytm');
}

const db = new DatabaseSync(DB_PATH);

function initializeDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedVersions = new Set(
    db.prepare(`SELECT version FROM schema_migrations`).all().map((row) => row.version)
  );

  const migrations = [
    {
      version: 1,
      sql: `
        CREATE TABLE IF NOT EXISTS anonymous_sessions (
          id TEXT PRIMARY KEY,
          session_token TEXT UNIQUE NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          user_agent TEXT,
          device_hash TEXT
        );

        CREATE TABLE IF NOT EXISTS carts (
          id TEXT PRIMARY KEY,
          session_id TEXT UNIQUE NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_activity_at TEXT NOT NULL,
          metadata TEXT,
          FOREIGN KEY(session_id) REFERENCES anonymous_sessions(id)
        );

        CREATE TABLE IF NOT EXISTS cart_items (
          id TEXT PRIMARY KEY,
          cart_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          item_key TEXT NOT NULL,
          file_name TEXT,
          page_selection TEXT,
          color TEXT,
          duplex INTEGER NOT NULL DEFAULT 0,
          copies INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL DEFAULT 'draft',
          metadata TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(cart_id) REFERENCES carts(id),
          FOREIGN KEY(session_id) REFERENCES anonymous_sessions(id)
        );

        CREATE TABLE IF NOT EXISTS orders (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          order_number TEXT UNIQUE NOT NULL,
          document_name TEXT NOT NULL,
          page_count INTEGER NOT NULL,
          copies INTEGER NOT NULL,
          color TEXT NOT NULL,
          print_mode TEXT NOT NULL,
          total_amount REAL NOT NULL,
          currency TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending_payment',
          note TEXT,
          pickup_code TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          paid_at TEXT,
          ready_at TEXT,
          handed_over_at TEXT,
          FOREIGN KEY(session_id) REFERENCES anonymous_sessions(id)
        );

        CREATE TABLE IF NOT EXISTS order_status_history (
          id TEXT PRIMARY KEY,
          order_id TEXT NOT NULL,
          previous_status TEXT,
          new_status TEXT NOT NULL,
          changed_at TEXT NOT NULL,
          FOREIGN KEY(order_id) REFERENCES orders(id)
        );

        CREATE TABLE IF NOT EXISTS order_files (
          id TEXT PRIMARY KEY,
          order_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          file_name TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          storage_key TEXT UNIQUE NOT NULL,
          size_bytes INTEGER NOT NULL,
          uploaded_at TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'uploaded',
          FOREIGN KEY(order_id) REFERENCES orders(id),
          FOREIGN KEY(session_id) REFERENCES anonymous_sessions(id)
        );

        CREATE TABLE IF NOT EXISTS payments (
          id TEXT PRIMARY KEY,
          order_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          amount REAL NOT NULL,
          currency TEXT NOT NULL,
          provider TEXT NOT NULL DEFAULT 'demo',
          status TEXT NOT NULL DEFAULT 'pending',
          gateway_reference TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          paid_at TEXT,
          FOREIGN KEY(order_id) REFERENCES orders(id),
          FOREIGN KEY(session_id) REFERENCES anonymous_sessions(id)
        );

        CREATE TABLE IF NOT EXISTS printers (
          id TEXT PRIMARY KEY,
          printer_id TEXT UNIQUE NOT NULL,
          name TEXT NOT NULL,
          location TEXT NOT NULL,
          supported_formats TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'online',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS printer_jobs (
          id TEXT PRIMARY KEY,
          printer_id TEXT NOT NULL,
          order_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued',
          assigned_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          FOREIGN KEY(printer_id) REFERENCES printers(id),
          FOREIGN KEY(order_id) REFERENCES orders(id)
        );
      `
    },
    {
      version: 2,
      sql: `
        ALTER TABLE order_files ADD COLUMN conversion_status TEXT NOT NULL DEFAULT 'uploaded';
        ALTER TABLE order_files ADD COLUMN converted_pdf_storage_key TEXT;
        ALTER TABLE order_files ADD COLUMN converted_page_count INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE order_files ADD COLUMN conversion_error TEXT;
        ALTER TABLE order_files ADD COLUMN converted_at TEXT;
      `
    },
    {
      version: 3,
      sql: `
        ALTER TABLE orders ADD COLUMN customer_uid TEXT;
      `
    },
    {
      version: 4,
      sql: `
        CREATE TABLE IF NOT EXISTS admin_users (
          id TEXT PRIMARY KEY,
          username TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'admin',
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS admin_sessions (
          id TEXT PRIMARY KEY,
          admin_user_id TEXT NOT NULL,
          session_token TEXT UNIQUE NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          FOREIGN KEY(admin_user_id) REFERENCES admin_users(id)
        );

        CREATE TABLE IF NOT EXISTS admin_audit_logs (
          id TEXT PRIMARY KEY,
          admin_user_id TEXT NOT NULL,
          actor TEXT NOT NULL,
          action TEXT NOT NULL,
          order_id TEXT,
          details TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY(admin_user_id) REFERENCES admin_users(id),
          FOREIGN KEY(order_id) REFERENCES orders(id)
        );
      `
    }
  ];

  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) {
      continue;
    }

    db.exec(migration.sql);
    db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`).run(
      migration.version,
      nowIso()
    );
  }

  const adminUserRow = db.prepare(`SELECT * FROM admin_users WHERE username = ?`).get(DEFAULT_ADMIN_USERNAME);
  if (!adminUserRow) {
    const adminUserId = randomUUID();
    const passwordHash = hashSecret(DEFAULT_ADMIN_PASSWORD);
    db.prepare(`
      INSERT INTO admin_users (id, username, password_hash, role, created_at)
      VALUES (?, ?, ?, 'admin', ?)
    `).run(adminUserId, DEFAULT_ADMIN_USERNAME, passwordHash, nowIso());
  }
}

initializeDatabase();

app.use((req, res, next) => {
  const origin = req.headers.origin || req.headers.host ? `http://${req.headers.host}` : null;
  const requestOrigin = origin && FRONTEND_ALLOWED_ORIGINS.has(origin) ? origin : req.headers.origin;
  if (requestOrigin && FRONTEND_ALLOWED_ORIGINS.has(requestOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', requestOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  return next();
});

app.use(express.json());
app.use(cookieParser());

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }

  return req.socket?.remoteAddress || 'unknown';
}

function applyRateLimit(req, res, next) {
  const ip = getClientIp(req);
  const now = Date.now();
  const bucket = RATE_LIMIT_BUCKETS.get(ip) || { windowStart: now, count: 0 };

  if (now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
    bucket.windowStart = now;
    bucket.count = 0;
  }

  bucket.count += 1;
  RATE_LIMIT_BUCKETS.set(ip, bucket);

  if (bucket.count > RATE_LIMIT_REQUESTS_PER_MINUTE) {
    return res.status(429).json({
      error: 'Too many requests. Please wait a moment and try again.'
    });
  }

  return next();
}

app.use(applyRateLimit);

function nowIso() {
  return new Date().toISOString();
}

function getSessionFromToken(token) {
  if (!token) return null;

  const row = db.prepare(`
    SELECT * FROM anonymous_sessions WHERE session_token = ?
  `).get(token);

  if (!row) return null;

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    db.prepare(`DELETE FROM anonymous_sessions WHERE id = ?`).run(row.id);
    return null;
  }

  return row;
}

function getCookieOptions(expiresAt) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: COOKIE_SECURE,
    path: '/',
    maxAge: Math.max(0, new Date(expiresAt).getTime() - Date.now())
  };
}

function setSessionCookie(res, token, expiresAt) {
  res.cookie(SESSION_COOKIE_NAME, token, getCookieOptions(expiresAt));
}

function generateCustomerUid() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const segment = Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  const candidate = `XR-${segment}`;
  const existing = db.prepare(`SELECT 1 FROM orders WHERE customer_uid = ?`).get(candidate);
  if (!existing) {
    return candidate;
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const fallback = `XR-${Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('')}`;
    const fallbackRow = db.prepare(`SELECT 1 FROM orders WHERE customer_uid = ?`).get(fallback);
    if (!fallbackRow) {
      return fallback;
    }
  }

  return `XR-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function ensureOrderCustomerUid(orderId) {
  const orderRow = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(orderId);
  if (!orderRow) {
    return null;
  }

  if (orderRow.customer_uid) {
    return orderRow;
  }

  const customerUid = generateCustomerUid();
  db.prepare(`UPDATE orders SET customer_uid = ? WHERE id = ?`).run(customerUid, orderId);

  return db.prepare(`SELECT * FROM orders WHERE id = ?`).get(orderId);
}

function validateRuntimeEnvironment() {
  const errors = [];
  const portValue = Number(process.env.PORT || PORT);

  if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65535) {
    errors.push('PORT must be an integer between 1 and 65535.');
  }

  if (process.env.QP_DB_PATH && !process.env.QP_DB_PATH.trim()) {
    errors.push('QP_DB_PATH cannot be empty when provided.');
  }

  if (!Number.isFinite(RATE_LIMIT_REQUESTS_PER_MINUTE) || RATE_LIMIT_REQUESTS_PER_MINUTE <= 0) {
    errors.push('QP_RATE_LIMIT_PER_MINUTE must be a positive number.');
  }

  if (!Number.isFinite(UPLOAD_LIMIT_MB) || UPLOAD_LIMIT_MB <= 0) {
    errors.push('QP_MAX_UPLOAD_MB must be a positive number.');
  }

  if (isProductionEnvironment && !COOKIE_SECURE) {
    errors.push('Production mode requires secure cookies. Set NODE_ENV=production and allow secure cookies or QP_COOKIE_SECURE=true.');
  }

  return {
    ok: errors.length === 0,
    errors
  };
}

function hashSecret(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function getSessionFromRequest(req) {
  const token = req.cookies?.[SESSION_COOKIE_NAME];
  return getSessionFromToken(token);
}

function getAdminSessionFromRequest(req) {
  const cookieToken = req.cookies?.[ADMIN_SESSION_COOKIE_NAME];
  const authHeader = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const token = cookieToken || bearerToken;

  if (!token) {
    return null;
  }

  const row = db.prepare(`
    SELECT s.*, u.username, u.role
    FROM admin_sessions s
    JOIN admin_users u ON u.id = s.admin_user_id
    WHERE s.session_token = ?
  `).get(token);

  if (!row) {
    return null;
  }

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    db.prepare(`DELETE FROM admin_sessions WHERE id = ?`).run(row.id);
    return null;
  }

  return row;
}

function requireAdminAuth(req, res, next) {
  const adminSession = getAdminSessionFromRequest(req);
  if (!adminSession) {
    const customerSession = getSessionFromRequest(req);
    if (customerSession) {
      return res.status(403).json({ error: 'Customer sessions are not allowed to access the admin dashboard.' });
    }

    return res.status(401).json({ error: 'Admin session required.' });
  }

  db.prepare(`UPDATE admin_sessions SET last_seen_at = ?, updated_at = ? WHERE id = ?`).run(
    nowIso(),
    nowIso(),
    adminSession.id
  );

  req.admin = {
    id: adminSession.admin_user_id,
    username: adminSession.username,
    role: adminSession.role
  };

  return next();
}

function addAdminAuditEntry({ adminUserId, actor, action, orderId, details }) {
  const auditId = randomUUID();
  const createdAt = nowIso();

  db.prepare(`
    INSERT INTO admin_audit_logs (id, admin_user_id, actor, action, order_id, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(auditId, adminUserId, actor, action, orderId || null, JSON.stringify(details || {}), createdAt);

  return {
    auditId,
    createdAt
  };
}

function normalizeOrder(row) {
  if (!row) {
    return null;
  }

  const queueMetrics = getOrderQueueMetrics(row);
  return {
    orderId: row.id,
    sessionId: row.session_id,
    orderNumber: row.order_number,
    customerUid: row.customer_uid || null,
    uid: row.customer_uid || null,
    documentName: row.document_name,
    pageCount: row.page_count,
    copies: row.copies,
    color: row.color,
    printMode: row.print_mode,
    totalAmount: Number(row.total_amount),
    currency: row.currency,
    status: row.status,
    note: row.note,
    pickupCode: row.pickup_code,
    queuePosition: queueMetrics.queuePosition,
    queueLength: queueMetrics.queueLength,
    etaMinutes: queueMetrics.etaMinutes,
    estimatedReadyAt: queueMetrics.estimatedReadyAt,
    queueStatus: queueMetrics.queueStatus,
    printerStatus: queueMetrics.printerStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    paidAt: row.paid_at,
    readyAt: row.ready_at,
    handedOverAt: row.handed_over_at
  };
}

function estimateOrderMinutes(order) {
  const totalPages = Math.max(1, Number(order.page_count || 0) * Number(order.copies || 1));
  return Math.max(2, Math.ceil(totalPages / Math.max(1, Number(DEFAULT_PRINT_PPM || 20))) + 1);
}

function getOrderQueueMetrics(order) {
  const printers = db.prepare(`SELECT * FROM printers`).all();
  const printerCount = printers.length;
  const onlinePrinterCount = printers.filter((printer) => String(printer.status || 'online').toLowerCase() === 'online').length;

  if (!order) {
    return {
      queuePosition: null,
      queueLength: 0,
      etaMinutes: null,
      estimatedReadyAt: null,
      queueStatus: 'not_found',
      printerStatus: printerCount === 0 ? 'unavailable' : (onlinePrinterCount > 0 ? 'online' : 'offline'),
      printerCount
    };
  }

  if (['cancelled', 'handed_over'].includes(order.status)) {
    return {
      queuePosition: null,
      queueLength: 0,
      etaMinutes: 0,
      estimatedReadyAt: null,
      queueStatus: order.status,
      printerStatus: printerCount === 0 ? 'unavailable' : (onlinePrinterCount > 0 ? 'online' : 'offline'),
      printerCount
    };
  }

  if (order.status === 'pending_payment') {
    return {
      queuePosition: null,
      queueLength: 0,
      etaMinutes: null,
      estimatedReadyAt: null,
      queueStatus: 'waiting_for_payment',
      printerStatus: printerCount === 0 ? 'unavailable' : (onlinePrinterCount > 0 ? 'online' : 'offline'),
      printerCount
    };
  }

  const queueOrders = db.prepare(`
    SELECT * FROM orders
    WHERE status IN ('paid', 'queued', 'printing', 'ready')
    ORDER BY COALESCE(paid_at, created_at) ASC, created_at ASC
  `).all();

  const queueCandidates = queueOrders.filter((row) => ['paid', 'queued', 'printing', 'ready'].includes(row.status));
  const queuePosition = queueCandidates.findIndex((row) => row.id === order.id) + 1;
  const queueLength = queueCandidates.length;

  if (order.status === 'ready') {
    return {
      queuePosition: Math.max(1, queuePosition),
      queueLength,
      etaMinutes: 0,
      estimatedReadyAt: order.ready_at || nowIso(),
      queueStatus: 'ready',
      printerStatus: printerCount === 0 ? 'unavailable' : (onlinePrinterCount > 0 ? 'online' : 'offline'),
      printerCount
    };
  }

  if (printerCount === 0 || onlinePrinterCount === 0) {
    return {
      queuePosition: queuePosition || null,
      queueLength,
      etaMinutes: null,
      estimatedReadyAt: null,
      queueStatus: 'awaiting_printer',
      printerStatus: printerCount === 0 ? 'unavailable' : 'offline',
      printerCount
    };
  }

  let etaMinutes = 0;
  for (const priorOrder of queueCandidates) {
    if (priorOrder.id === order.id) {
      break;
    }

    let priorMinutes = estimateOrderMinutes(priorOrder);
    const job = db.prepare(`
      SELECT * FROM printer_jobs WHERE order_id = ? AND status IN ('queued', 'printing', 'completed')
      ORDER BY assigned_at DESC, started_at DESC
      LIMIT 1
    `).get(priorOrder.id);

    if (priorOrder.status === 'printing' && job && job.started_at) {
      const elapsedMs = Date.now() - new Date(job.started_at).getTime();
      priorMinutes = Math.max(0, priorMinutes - Math.floor(elapsedMs / 60000));
    }

    etaMinutes += priorMinutes;
  }

  const ownMinutes = order.status === 'printing' ? (() => {
    const job = db.prepare(`
      SELECT * FROM printer_jobs WHERE order_id = ? AND status IN ('queued', 'printing', 'completed')
      ORDER BY assigned_at DESC, started_at DESC
      LIMIT 1
    `).get(order.id);
    const baseMinutes = estimateOrderMinutes(order);
    if (!job || !job.started_at) {
      return baseMinutes;
    }
    const elapsedMs = Date.now() - new Date(job.started_at).getTime();
    return Math.max(2, baseMinutes - Math.floor(elapsedMs / 60000));
  })() : estimateOrderMinutes(order);

  etaMinutes += ownMinutes;

  return {
    queuePosition: queuePosition || null,
    queueLength,
    etaMinutes: Math.max(0, etaMinutes),
    estimatedReadyAt: new Date(Date.now() + etaMinutes * 60000).toISOString(),
    queueStatus: order.status,
    printerStatus: onlinePrinterCount > 0 ? 'online' : 'offline',
    printerCount
  };
}

function normalizeCartItem(row) {
  return row ? {
    itemId: row.item_key,
    fileName: row.file_name,
    pageSelection: row.page_selection,
    color: row.color,
    duplex: Boolean(row.duplex),
    copies: Number(row.copies),
    status: row.status,
    metadata: row.metadata ? JSON.parse(row.metadata) : {},
    createdAt: row.created_at,
    updatedAt: row.updated_at
  } : null;
}

function parsePageSelection(pageSelection, totalPages) {
  if (!pageSelection || typeof pageSelection !== 'string') {
    if (!Number.isFinite(totalPages) || totalPages <= 0) {
      return [];
    }

    const defaultPages = [];
    for (let page = 1; page <= totalPages; page += 1) {
      defaultPages.push(page);
    }
    return defaultPages;
  }

  const normalized = pageSelection.trim();
  if (!normalized) {
    if (!Number.isFinite(totalPages) || totalPages <= 0) {
      return [];
    }

    const defaultPages = [];
    for (let page = 1; page <= totalPages; page += 1) {
      defaultPages.push(page);
    }
    return defaultPages;
  }

  if (normalized.toLowerCase() === 'all') {
    if (!Number.isFinite(totalPages) || totalPages <= 0) {
      return [1];
    }

    const pages = [];
    for (let page = 1; page <= totalPages; page += 1) {
      pages.push(page);
    }
    return pages;
  }

  const selectedPages = new Set();
  const tokens = normalized.split(',');

  for (const token of tokens) {
    const trimmedToken = token.trim();
    if (!trimmedToken) {
      throw new Error('Page selection contains an empty value.');
    }

    if (trimmedToken.includes('-')) {
      const [startRaw, endRaw] = trimmedToken.split('-');
      const start = Number(startRaw);
      const end = Number(endRaw);

      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < 1 || start > end) {
        throw new Error(`Invalid page range: ${trimmedToken}`);
      }

      for (let page = start; page <= end; page += 1) {
        selectedPages.add(page);
      }
      continue;
    }

    const pageNumber = Number(trimmedToken);
    if (!Number.isInteger(pageNumber) || pageNumber < 1) {
      throw new Error(`Invalid page number: ${trimmedToken}`);
    }
    selectedPages.add(pageNumber);
  }

  const orderedPages = [...selectedPages].sort((a, b) => a - b);
  if (orderedPages.length === 0) {
    throw new Error('Page selection did not resolve to any valid pages.');
  }

  if (Number.isFinite(totalPages)) {
    for (const pageNumber of orderedPages) {
      if (pageNumber > totalPages) {
        throw new Error(`Page ${pageNumber} is outside the document range of 1 to ${totalPages}.`);
      }
    }
  }

  return orderedPages;
}

function validateDocumentSettings(item, itemIndex) {
  if (!item || typeof item !== 'object') {
    throw new Error(`Cart item ${itemIndex + 1} is invalid.`);
  }

  const color = typeof item.color === 'string' ? item.color : '';
  if (color !== 'black-and-white' && color !== 'color' && color !== 'colour') {
    throw new Error(`Cart item ${itemIndex + 1} has an invalid color mode.`);
  }

  const copies = Number(item.copies);
  if (!Number.isFinite(copies) || copies <= 0) {
    throw new Error(`Cart item ${itemIndex + 1} must have a positive copy count.`);
  }

  const metadata = item.metadata && typeof item.metadata === 'object' ? item.metadata : {};
  const totalPagesRaw = metadata.pageCount ?? metadata.totalPages ?? item.pageCount ?? item.totalPages ?? null;
  const totalPages = totalPagesRaw === null || totalPagesRaw === undefined ? null : Number(totalPagesRaw);

  if (totalPages !== null && (!Number.isFinite(totalPages) || totalPages <= 0)) {
    throw new Error(`Cart item ${itemIndex + 1} requires a valid page count.`);
  }

  const selectedPages = parsePageSelection(item.pageSelection, totalPages);
  const selectedPageCount = selectedPages.length;

  if (item.duplex && typeof item.pageSelection === 'string' && item.pageSelection.trim() && selectedPageCount <= 1) {
    throw new Error('Double-sided printing is not allowed when only one page is selected.');
  }

  if (item.duplex && totalPages !== null && totalPages <= 1) {
    throw new Error('Double-sided printing is not allowed when only one page is selected.');
  }

  if (item.pageSelection && typeof item.pageSelection === 'string' && item.pageSelection.trim() && selectedPageCount === 0) {
    throw new Error(`Cart item ${itemIndex + 1} has an empty page selection.`);
  }

  return {
    color,
    copies,
    totalPages,
    selectedPages
  };
}

function calculateItemQuote(item, index = 0) {
  const validated = validateDocumentSettings(item, index);
  const normalizedColor = validated.color === 'colour' ? 'color' : validated.color;
  const pricePerPage = normalizedColor === 'color' ? 8 : 3;
  const copies = Number(item.copies) || 1;
  const pageSelectionLength = validated.selectedPages.length;
  const effectiveSheets = item.duplex ? Math.ceil(pageSelectionLength / 2) : pageSelectionLength;
  const totalAmount = effectiveSheets * copies * pricePerPage;

  return {
    itemId: typeof item.itemId === 'string' ? item.itemId : null,
    fileName: typeof item.fileName === 'string' ? item.fileName : null,
    pageSelection: typeof item.pageSelection === 'string' ? item.pageSelection : null,
    color: normalizedColor,
    duplex: Boolean(item.duplex),
    copies,
    selectedPages: validated.selectedPages,
    pageCount: pageSelectionLength,
    sheets: effectiveSheets,
    unitRate: pricePerPage,
    totalAmount
  };
}

function calculateCartQuote(items) {
  if (!Array.isArray(items)) {
    return { currency: 'INR', totalAmount: 0, lineItems: [] };
  }

  const lineItems = [];
  let totalAmount = 0;

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item || typeof item !== 'object') {
      continue;
    }

    const quote = calculateItemQuote(item, index);
    totalAmount += quote.totalAmount;
    lineItems.push(quote);
  }

  return {
    currency: 'INR',
    totalAmount,
    lineItems
  };
}

function normalizeCart(row, items) {
  return row ? {
    id: row.id,
    sessionId: row.session_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at,
    items: (items || []).map(normalizeCartItem)
  } : null;
}

function normalizeFileRecord(row) {
  return row ? {
    fileId: row.id,
    orderId: row.order_id,
    sessionId: row.session_id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    storageKey: row.storage_key,
    sizeBytes: Number(row.size_bytes),
    uploadedAt: row.uploaded_at,
    status: row.status,
    conversionStatus: row.conversion_status || row.status || 'uploaded',
    convertedPdfStorageKey: row.converted_pdf_storage_key || null,
    pageCount: Number(row.converted_page_count || 0),
    conversionError: row.conversion_error || null,
    convertedAt: row.converted_at || null
  } : null;
}

function normalizePayment(row, order) {
  return row ? {
    paymentId: row.id,
    orderId: row.order_id,
    sessionId: row.session_id,
    amount: Number(row.amount),
    currency: row.currency,
    provider: row.provider,
    status: row.status,
    gatewayReference: row.gateway_reference,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    paidAt: row.paid_at,
    order: order ? normalizeOrder(order) : null
  } : null;
}

function normalizePaymentProvider(provider) {
  const normalized = typeof provider === 'string' ? provider.trim().toLowerCase() : '';
  if (!normalized) {
    throw new Error('provider is required.');
  }

  if (!ENABLED_PAYMENT_PROVIDERS.has(normalized)) {
    if (normalized === 'paytm') {
      throw Object.assign(new Error('Paytm integration is not enabled in this environment yet.'), { statusCode: 501 });
    }

    throw Object.assign(new Error('Unsupported payment provider.'), { statusCode: 400 });
  }

  return normalized;
}

function assertPaymentPayloadMatches(order, payment, payload) {
  const expectedAmount = Number(order.total_amount);
  const providedAmount = Number(payload?.amount ?? payment.amount ?? 0);
  const providedCurrency = typeof payload?.currency === 'string' ? payload.currency.toUpperCase() : String(payment.currency || '').toUpperCase();
  const provider = typeof payload?.provider === 'string' ? payload.provider.toLowerCase() : payment.provider;

  if (!Number.isFinite(providedAmount) || providedAmount <= 0) {
    throw Object.assign(new Error('amount must be a positive number.'), { statusCode: 400 });
  }

  if (Math.abs(providedAmount - expectedAmount) > 0.01) {
    throw Object.assign(new Error('Payment amount does not match order total.'), { statusCode: 400 });
  }

  if (providedCurrency !== String(order.currency || payment.currency || '').toUpperCase()) {
    throw Object.assign(new Error('Payment currency does not match the order currency.'), { statusCode: 400 });
  }

  if (provider !== payment.provider) {
    throw Object.assign(new Error('Payment provider does not match the original payment record.'), { statusCode: 400 });
  }

  return {
    provider,
    amount: providedAmount,
    currency: providedCurrency
  };
}

function normalizePrinter(row) {
  return row ? {
    printerId: row.printer_id,
    name: row.name,
    location: row.location,
    supportedFormats: JSON.parse(row.supported_formats || '[]'),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at
  } : null;
}

const ALLOWED_UPLOAD_TYPES = new Map([
  ['.pdf', ['application/pdf']],
  ['.png', ['image/png']],
  ['.jpg', ['image/jpeg', 'image/jpg']],
  ['.jpeg', ['image/jpeg', 'image/jpg']],
  ['.doc', ['application/msword', 'application/vnd.ms-word']],
  ['.docx', ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-word.document.macroenabled.12']],
  ['.ppt', ['application/vnd.ms-powerpoint', 'application/powerpoint']],
  ['.pptx', ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/vnd.ms-powerpoint.presentation.macroenabled.12']]
]);

function getFileExtension(fileName) {
  if (!fileName || typeof fileName !== 'string') return '';
  const lastDot = fileName.lastIndexOf('.');
  return lastDot >= 0 ? fileName.slice(lastDot).toLowerCase() : '';
}

function isAllowedUploadType(fileName, mimeType) {
  const ext = getFileExtension(fileName);
  const normalizedMime = typeof mimeType === 'string' ? mimeType.toLowerCase() : '';
  const allowedMimeTypes = ALLOWED_UPLOAD_TYPES.get(ext) || [];
  return allowedMimeTypes.includes(normalizedMime);
}

function getStorageFilePath(storageKey) {
  const rawStorageKey = decodeURIComponent(storageKey);
  return path.join(uploadRoot, rawStorageKey.replace(/^orders\//, '').replace(/\//g, '_'));
}

function parsePdfPageCount(pdfBuffer) {
  try {
    const pdfText = pdfBuffer.toString('latin1');
    const explicitCountMatches = [...pdfText.matchAll(/\/Count\s+(\d+)/g)];
    if (explicitCountMatches.length > 0) {
      const count = Number(explicitCountMatches[explicitCountMatches.length - 1][1]);
      return Number.isFinite(count) && count > 0 ? count : 1;
    }

    const pageMatches = pdfText.match(/\/Type\s*\/Page\b/g) || [];
    if (pageMatches.length > 0) {
      return pageMatches.length;
    }
  } catch (error) {
    return 1;
  }

  return 1;
}

async function createConvertedPdfBuffer(fileName, mimeType, rawBuffer) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([600, 760]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  page.drawText(`Converted document: ${fileName}`, {
    x: 48,
    y: 700,
    size: 18,
    font
  });

  page.drawText(`Original type: ${mimeType || 'unknown'}`, {
    x: 48,
    y: 670,
    size: 12,
    font
  });

  const ext = getFileExtension(fileName);
  if (ext === '.png') {
    const image = await pdfDoc.embedPng(rawBuffer);
    const scale = Math.min(1, 480 / image.width, 620 / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    const x = (page.getSize().width - width) / 2;
    const y = (page.getSize().height - height) / 2;
    page.drawImage(image, { x, y, width, height });
    return { buffer: Buffer.from(await pdfDoc.save()), pageCount: 1 };
  }

  if (ext === '.jpg' || ext === '.jpeg') {
    const image = await pdfDoc.embedJpg(rawBuffer);
    const scale = Math.min(1, 480 / image.width, 620 / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    const x = (page.getSize().width - width) / 2;
    const y = (page.getSize().height - height) / 2;
    page.drawImage(image, { x, y, width, height });
    return { buffer: Buffer.from(await pdfDoc.save()), pageCount: 1 };
  }

  page.drawText('This file was converted to a print-ready PDF for processing.', {
    x: 48,
    y: 640,
    size: 12,
    font
  });

  return { buffer: Buffer.from(await pdfDoc.save()), pageCount: 1 };
}

async function convertUploadedFile(orderId, fileId, sessionId, fileName, mimeType, storageKey, sizeBytes, uploadedAt) {
  const storedPath = getStorageFilePath(storageKey);
  if (!fs.existsSync(storedPath)) {
    return {
      fileId,
      orderId,
      sessionId,
      fileName,
      mimeType,
      storageKey,
      sizeBytes,
      uploadedAt,
      status: 'uploaded',
      conversionStatus: 'uploaded',
      convertedPdfStorageKey: null,
      pageCount: 0,
      conversionError: null,
      convertedAt: null
    };
  }

  const originalBuffer = fs.readFileSync(storedPath);
  const ext = getFileExtension(fileName);
  let convertedPdfStorageKey = null;
  let pageCount = 1;
  let conversionStatus = 'converted';
  let conversionError = null;

  try {
    let convertedBuffer = originalBuffer;

    if (ext === '.pdf') {
      pageCount = parsePdfPageCount(originalBuffer);
      convertedPdfStorageKey = `orders/${orderId}/converted/${Date.now()}-${randomUUID()}-${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const targetPath = getStorageFilePath(convertedPdfStorageKey);
      const targetDir = path.dirname(targetPath);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
      fs.writeFileSync(targetPath, originalBuffer);
      convertedPdfStorageKey = convertedPdfStorageKey.endsWith('.pdf') ? convertedPdfStorageKey : `${convertedPdfStorageKey}.pdf`;
      fs.writeFileSync(getStorageFilePath(convertedPdfStorageKey), originalBuffer);
    } else {
      const converted = await createConvertedPdfBuffer(fileName, mimeType, originalBuffer);
      convertedBuffer = converted.buffer;
      pageCount = converted.pageCount;
      convertedPdfStorageKey = `orders/${orderId}/converted/${Date.now()}-${randomUUID()}-${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}.pdf`;
      const targetPath = getStorageFilePath(convertedPdfStorageKey);
      const targetDir = path.dirname(targetPath);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
      fs.writeFileSync(targetPath, convertedBuffer);
    }

    db.prepare(`
      UPDATE order_files
      SET conversion_status = ?, converted_pdf_storage_key = ?, converted_page_count = ?, conversion_error = ?, converted_at = ?, status = ?
      WHERE id = ?
    `).run(conversionStatus, convertedPdfStorageKey, pageCount, conversionError, nowIso(), 'converted', fileId);

    return {
      fileId,
      orderId: orderId,
      sessionId,
      fileName,
      mimeType,
      storageKey,
      sizeBytes,
      uploadedAt,
      status: 'converted',
      conversionStatus,
      convertedPdfStorageKey,
      pageCount,
      conversionError,
      convertedAt: nowIso()
    };
  } catch (error) {
    conversionStatus = 'failed';
    conversionError = error && error.message ? error.message : 'Unknown conversion failure.';
    db.prepare(`
      UPDATE order_files
      SET conversion_status = ?, converted_pdf_storage_key = ?, converted_page_count = ?, conversion_error = ?, converted_at = ?, status = ?
      WHERE id = ?
    `).run(conversionStatus, null, 0, conversionError, nowIso(), 'failed', fileId);
    throw new Error(conversionError);
  }
}

function requireOrderOwnership(req, res, next) {
  const session = getSessionFromRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'No active anonymous session found.' });
  }

  const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(req.params.id);
  if (!order) {
    return res.status(404).json({ error: 'Order not found.' });
  }

  if (order.session_id !== session.id) {
    return res.status(403).json({ error: 'Order does not belong to this session.' });
  }

  req.order = order;
  req.session = session;
  return next();
}

const VALID_ORDER_STATUSES = new Set([
  'pending_payment',
  'paid',
  'queued',
  'printing',
  'ready',
  'handed_over',
  'cancelled'
]);

const ORDER_STATUS_TRANSITIONS = {
  pending_payment: new Set(['paid', 'cancelled']),
  paid: new Set(['queued', 'printing', 'ready', 'cancelled']),
  queued: new Set(['printing', 'ready', 'cancelled']),
  printing: new Set(['ready', 'cancelled']),
  ready: new Set(['handed_over', 'cancelled']),
  handed_over: new Set(),
  cancelled: new Set()
};

function isValidOrderTransition(previousStatus, nextStatus) {
  if (!previousStatus || !nextStatus || !VALID_ORDER_STATUSES.has(nextStatus)) {
    return false;
  }

  if (previousStatus === nextStatus) {
    return true;
  }

  return Boolean(ORDER_STATUS_TRANSITIONS[previousStatus] && ORDER_STATUS_TRANSITIONS[previousStatus].has(nextStatus));
}

app.post('/api/admin/login', (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';

  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required.' });
  }

  const user = db.prepare(`SELECT * FROM admin_users WHERE username = ?`).get(username);
  if (!user) {
    return res.status(401).json({ error: 'Invalid admin credentials.' });
  }

  if (user.password_hash !== hashSecret(password)) {
    return res.status(401).json({ error: 'Invalid admin credentials.' });
  }

  const sessionId = randomUUID();
  const sessionToken = randomUUID();
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + ADMIN_SESSION_TTL_MS).toISOString();

  db.prepare(`
    INSERT INTO admin_sessions (id, admin_user_id, session_token, created_at, updated_at, expires_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(sessionId, user.id, sessionToken, createdAt, createdAt, expiresAt, createdAt);

  res.cookie(ADMIN_SESSION_COOKIE_NAME, sessionToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: COOKIE_SECURE,
    path: '/',
    maxAge: Math.max(0, new Date(expiresAt).getTime() - Date.now())
  });

  return res.json({
    ok: true,
    admin: {
      id: user.id,
      username: user.username,
      role: user.role
    },
    sessionToken,
    expiresAt,
    message: 'Admin authenticated.'
  });
});

app.post('/api/admin/logout', requireAdminAuth, (req, res) => {
  const adminSession = getAdminSessionFromRequest(req);
  if (adminSession) {
    db.prepare(`DELETE FROM admin_sessions WHERE id = ?`).run(adminSession.id);
  }

  res.clearCookie(ADMIN_SESSION_COOKIE_NAME, { path: '/' });
  return res.json({ ok: true, message: 'Admin session cleared.' });
});

app.get('/api/admin/session', requireAdminAuth, (req, res) => {
  return res.json({
    ok: true,
    admin: {
      id: req.admin.id,
      username: req.admin.username,
      role: req.admin.role
    },
    authenticatedAt: nowIso()
  });
});

app.get('/api/admin/dashboard', requireAdminAuth, (req, res) => {
  const orders = db.prepare(`SELECT * FROM orders ORDER BY created_at DESC`).all();
  const queuedOrders = db.prepare(`
    SELECT * FROM orders
    WHERE status IN ('paid', 'queued', 'printing', 'ready')
    ORDER BY COALESCE(paid_at, created_at) ASC, created_at ASC
  `).all();

  const queue = queuedOrders.map(normalizeOrder);
  const orderSummaries = orders.map(normalizeOrder);

  return res.json({
    ok: true,
    admin: {
      id: req.admin.id,
      username: req.admin.username,
      role: req.admin.role
    },
    metrics: {
      totalOrders: orderSummaries.length,
      pendingPayment: orderSummaries.filter((order) => order.status === 'pending_payment').length,
      paid: orderSummaries.filter((order) => order.status === 'paid').length,
      queued: orderSummaries.filter((order) => order.status === 'queued').length,
      ready: orderSummaries.filter((order) => order.status === 'ready').length,
      handedOver: orderSummaries.filter((order) => order.status === 'handed_over').length,
      cancelled: orderSummaries.filter((order) => order.status === 'cancelled').length
    },
    orders: orderSummaries,
    queue
  });
});

app.get('/api/admin/orders', requireAdminAuth, (req, res) => {
  const statusFilter = typeof req.query.status === 'string' ? req.query.status.trim() : '';
  const rows = statusFilter
    ? db.prepare(`SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC`).all(statusFilter)
    : db.prepare(`SELECT * FROM orders ORDER BY created_at DESC`).all();

  return res.json({
    ok: true,
    orders: rows.map(normalizeOrder),
    count: rows.length,
    status: statusFilter || null
  });
});

app.get('/api/admin/orders/:id', requireAdminAuth, (req, res) => {
  const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(req.params.id);
  if (!order) {
    return res.status(404).json({ error: 'Order not found.' });
  }

  return res.json({
    ok: true,
    order: normalizeOrder(order)
  });
});

app.patch('/api/admin/orders/:id/status', requireAdminAuth, (req, res) => {
  const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(req.params.id);
  if (!order) {
    return res.status(404).json({ error: 'Order not found.' });
  }

  const nextStatus = typeof req.body?.status === 'string' ? req.body.status.trim() : '';
  if (!nextStatus) {
    return res.status(400).json({ error: 'status is required.' });
  }

  if (!VALID_ORDER_STATUSES.has(nextStatus)) {
    return res.status(400).json({ error: 'status is not supported.' });
  }

  if (!isValidOrderTransition(order.status, nextStatus)) {
    return res.status(409).json({
      error: `Invalid status transition from ${order.status} to ${nextStatus}.`,
      allowedStatuses: ORDER_STATUS_TRANSITIONS[order.status] ? Array.from(ORDER_STATUS_TRANSITIONS[order.status]) : []
    });
  }

  const previousStatus = order.status;
  const changedAt = nowIso();

  db.prepare(`
    UPDATE orders
    SET status = ?, updated_at = ?, paid_at = COALESCE(paid_at, CASE WHEN ? = 'paid' THEN ? ELSE paid_at END), ready_at = COALESCE(ready_at, CASE WHEN ? = 'ready' THEN ? ELSE ready_at END), handed_over_at = COALESCE(handed_over_at, CASE WHEN ? = 'handed_over' THEN ? ELSE handed_over_at END)
    WHERE id = ?
  `).run(nextStatus, changedAt, nextStatus, changedAt, nextStatus, changedAt, nextStatus, changedAt, order.id);

  db.prepare(`
    INSERT INTO order_status_history (id, order_id, previous_status, new_status, changed_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(randomUUID(), order.id, previousStatus, nextStatus, changedAt);

  const audit = addAdminAuditEntry({
    adminUserId: req.admin.id,
    actor: 'admin',
    action: 'status_changed',
    orderId: order.id,
    details: {
      previousStatus,
      nextStatus,
      changedAt
    }
  });

  const updatedOrder = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(order.id);

  return res.json({
    ok: true,
    actor: 'admin',
    auditId: audit.auditId,
    order: normalizeOrder(updatedOrder)
  });
});

app.post('/api/admin/orders/:id/handover', requireAdminAuth, (req, res) => {
  const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(req.params.id);
  if (!order) {
    return res.status(404).json({ error: 'Order not found.' });
  }

  if (order.status !== 'ready') {
    return res.status(409).json({ error: 'Order must be marked ready before handover can be confirmed.' });
  }

  const confirmation = typeof req.body?.confirmation === 'string' ? req.body.confirmation : 'customer';
  const changedAt = nowIso();
  const pickupCode = order.pickup_code || `QP-${String(order.order_number).slice(-6)}`;

  db.prepare(`
    UPDATE orders
    SET status = 'handed_over', updated_at = ?, handed_over_at = COALESCE(handed_over_at, ?), pickup_code = COALESCE(pickup_code, ?)
    WHERE id = ?
  `).run(changedAt, changedAt, pickupCode, order.id);

  db.prepare(`
    INSERT INTO order_status_history (id, order_id, previous_status, new_status, changed_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(randomUUID(), order.id, order.status, 'handed_over', changedAt);

  const audit = addAdminAuditEntry({
    adminUserId: req.admin.id,
    actor: 'admin',
    action: 'handover_confirmed',
    orderId: order.id,
    details: { confirmation, pickupCode, changedAt }
  });

  const updatedOrder = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(order.id);

  return res.json({
    ok: true,
    actor: 'admin',
    auditId: audit.auditId,
    pickupCode,
    order: normalizeOrder(updatedOrder)
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'quick-print-session-slice',
    environment: isProductionEnvironment ? 'production' : 'development',
    timestamp: nowIso()
  });
});

app.get('/api/ready', (req, res) => {
  const storageAvailable = fs.existsSync(uploadRoot);
  const dbHealthy = (() => {
    try {
      const row = db.prepare(`SELECT 1 as ok`).get();
      return row && row.ok === 1;
    } catch (error) {
      return false;
    }
  })();

  const ready = dbHealthy && storageAvailable;

  return res.status(ready ? 200 : 503).json({
    ok: ready,
    database: dbHealthy ? 'ok' : 'unavailable',
    storage: storageAvailable ? 'ok' : 'unavailable',
    environment: isProductionEnvironment ? 'production' : 'development',
    timestamp: nowIso()
  });
});

app.post('/api/sessions/create', (req, res) => {
  const existingToken = req.cookies?.[SESSION_COOKIE_NAME];
  const existingSession = getSessionFromToken(existingToken);

  if (existingSession) {
    db.prepare(`
      UPDATE anonymous_sessions
      SET last_seen_at = ?, updated_at = ?
      WHERE id = ?
    `).run(nowIso(), nowIso(), existingSession.id);

    const refreshed = db.prepare(`
      SELECT * FROM anonymous_sessions WHERE id = ?
    `).get(existingSession.id);

    setSessionCookie(res, refreshed.session_token, refreshed.expires_at);

    return res.status(200).json({
      sessionId: refreshed.id,
      createdAt: refreshed.created_at,
      expiresAt: refreshed.expires_at,
      status: refreshed.status,
      message: 'Existing anonymous session reused.'
    });
  }

  const sessionId = randomUUID();
  const sessionToken = randomUUID();
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

  db.prepare(`
    INSERT INTO anonymous_sessions (
      id,
      session_token,
      created_at,
      updated_at,
      expires_at,
      last_seen_at,
      status,
      user_agent,
      device_hash
    ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
  `).run(
    sessionId,
    sessionToken,
    createdAt,
    createdAt,
    expiresAt,
    createdAt,
    req.headers['user-agent'] || null,
    req.headers['x-device-hash'] || null
  );

  setSessionCookie(res, sessionToken, expiresAt);

  res.status(201).json({
    sessionId,
    createdAt,
    expiresAt,
    status: 'active'
  });
});

app.get('/api/sessions/current', (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE_NAME];
  const session = getSessionFromToken(token);

  if (!session) {
    return res.status(404).json({
      error: 'No active anonymous session found.'
    });
  }

  const updatedAt = nowIso();
  db.prepare(`
    UPDATE anonymous_sessions
    SET last_seen_at = ?, updated_at = ?
    WHERE id = ?
  `).run(updatedAt, updatedAt, session.id);

  const refreshed = db.prepare(`
    SELECT * FROM anonymous_sessions WHERE id = ?
  `).get(session.id);

  setSessionCookie(res, refreshed.session_token, refreshed.expires_at);

  return res.json({
    sessionId: refreshed.id,
    createdAt: refreshed.created_at,
    expiresAt: refreshed.expires_at,
    lastSeenAt: refreshed.last_seen_at,
    status: refreshed.status
  });
});

app.get('/api/sessions/:id', (req, res) => {
  const row = db.prepare(`SELECT * FROM anonymous_sessions WHERE id = ?`).get(req.params.id);

  if (!row) {
    return res.status(404).json({ error: 'Session not found.' });
  }

  return res.json({
    sessionId: row.id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at,
    status: row.status
  });
});

app.get('/api/cart', (req, res) => {
  const session = getSessionFromRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'No active anonymous session found.' });
  }

  const cart = db.prepare(`SELECT * FROM carts WHERE session_id = ?`).get(session.id);
  const cartItems = cart ? db.prepare(`SELECT * FROM cart_items WHERE cart_id = ? ORDER BY created_at ASC`).all(cart.id) : [];

  return res.json({ cart: normalizeCart(cart || { id: null, session_id: session.id, status: 'active', created_at: nowIso(), updated_at: nowIso(), last_activity_at: nowIso() }, cartItems) });
});

app.put('/api/cart', (req, res) => {
  const session = getSessionFromRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'No active anonymous session found.' });
  }

  const payload = req.body || {};
  const items = Array.isArray(payload.items) ? payload.items : [];
  const updatedAt = nowIso();

  try {
    for (let index = 0; index < items.length; index += 1) {
      validateDocumentSettings(items[index], index);
    }
  } catch (error) {
    return res.status(400).json({ error: error && error.message ? error.message : 'Invalid document settings.' });
  }

  let cart = db.prepare(`SELECT * FROM carts WHERE session_id = ?`).get(session.id);
  if (!cart) {
    cart = {
      id: randomUUID(),
      session_id: session.id,
      status: 'active',
      created_at: updatedAt,
      updated_at: updatedAt,
      last_activity_at: updatedAt,
      metadata: null
    };

    db.prepare(`
      INSERT INTO carts (id, session_id, status, created_at, updated_at, last_activity_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(cart.id, cart.session_id, cart.status, cart.created_at, cart.updated_at, cart.last_activity_at, cart.metadata);
  } else {
    db.prepare(`
      UPDATE carts
      SET status = ?, updated_at = ?, last_activity_at = ?
      WHERE id = ?
    `).run(cart.status || 'active', updatedAt, updatedAt, cart.id);
    cart.updated_at = updatedAt;
    cart.last_activity_at = updatedAt;
  }

  db.prepare(`DELETE FROM cart_items WHERE cart_id = ?`).run(cart.id);

  for (const item of items) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const itemKey = typeof item.itemId === 'string' && item.itemId ? item.itemId : randomUUID();
    const fileName = typeof item.fileName === 'string' ? item.fileName : null;
    const pageSelection = typeof item.pageSelection === 'string' ? item.pageSelection : null;
    const color = typeof item.color === 'string' ? item.color : null;
    const duplex = Boolean(item.duplex);
    const copies = Number(item.copies) || 1;
    const status = typeof item.status === 'string' ? item.status : 'draft';
    const metadata = item.metadata && typeof item.metadata === 'object' ? JSON.stringify(item.metadata) : item.metadata ? JSON.stringify({ value: item.metadata }) : null;
    const itemId = randomUUID();

    db.prepare(`
      INSERT INTO cart_items (id, cart_id, session_id, item_key, file_name, page_selection, color, duplex, copies, status, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(itemId, cart.id, session.id, itemKey, fileName, pageSelection, color, duplex ? 1 : 0, copies, status, metadata, updatedAt, updatedAt);
  }

  const savedCart = db.prepare(`SELECT * FROM carts WHERE id = ?`).get(cart.id);
  const savedItems = db.prepare(`SELECT * FROM cart_items WHERE cart_id = ? ORDER BY created_at ASC`).all(cart.id);

  return res.json({ cart: normalizeCart(savedCart, savedItems) });
});

app.get('/api/carts/:id', (req, res) => {
  const session = getSessionFromRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'No active anonymous session found.' });
  }

  const cart = db.prepare(`SELECT * FROM carts WHERE id = ?`).get(req.params.id);
  if (!cart) {
    return res.status(404).json({ error: 'Cart not found.' });
  }

  if (cart.session_id !== session.id) {
    return res.status(403).json({ error: 'Cart does not belong to this session.' });
  }

  const items = db.prepare(`SELECT * FROM cart_items WHERE cart_id = ? ORDER BY created_at ASC`).all(cart.id);
  return res.json({ cart: normalizeCart(cart, items) });
});

app.get('/api/cart/quote', (req, res) => {
  const session = getSessionFromRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'No active anonymous session found.' });
  }

  const cart = db.prepare(`SELECT * FROM carts WHERE session_id = ?`).get(session.id);
  if (!cart) {
    return res.json({ currency: 'INR', totalAmount: 0, lineItems: [] });
  }

  const items = db.prepare(`SELECT * FROM cart_items WHERE cart_id = ? ORDER BY created_at ASC`).all(cart.id);
  const quote = calculateCartQuote(items.map((row) => ({
    itemId: row.item_key,
    fileName: row.file_name,
    pageSelection: row.page_selection,
    color: row.color,
    duplex: Boolean(row.duplex),
    copies: Number(row.copies),
    status: row.status,
    metadata: row.metadata ? JSON.parse(row.metadata) : {}
  })));

  return res.json({
    currency: quote.currency,
    totalAmount: quote.totalAmount,
    lineItems: quote.lineItems
  });
});

app.post('/api/orders', (req, res) => {
  const session = getSessionFromRequest(req);

  if (!session) {
    return res.status(401).json({ error: 'No active anonymous session found.' });
  }

  const payload = req.body || {};

  if (!payload.documentName || typeof payload.documentName !== 'string') {
    return res.status(400).json({ error: 'documentName is required.' });
  }

  const pageCount = Number(payload.pageCount);
  const copies = Number(payload.copies);
  const totalAmount = Number(payload.totalAmount);

  if (!Number.isFinite(pageCount) || pageCount <= 0) {
    return res.status(400).json({ error: 'pageCount must be a positive number.' });
  }

  if (!Number.isFinite(copies) || copies <= 0) {
    return res.status(400).json({ error: 'copies must be a positive number.' });
  }

  if (!payload.color || !payload.printMode) {
    return res.status(400).json({ error: 'color and printMode are required.' });
  }

  if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
    return res.status(400).json({ error: 'totalAmount must be a positive number.' });
  }

  if (!payload.currency || typeof payload.currency !== 'string') {
    return res.status(400).json({ error: 'currency is required.' });
  }

  const cart = db.prepare(`SELECT * FROM carts WHERE session_id = ?`).get(session.id);
  if (cart) {
    const cartItems = db.prepare(`SELECT * FROM cart_items WHERE cart_id = ? ORDER BY created_at ASC`).all(cart.id);
    const cartQuote = calculateCartQuote(cartItems.map((row) => ({
      itemId: row.item_key,
      fileName: row.file_name,
      pageSelection: row.page_selection,
      color: row.color,
      duplex: Boolean(row.duplex),
      copies: Number(row.copies),
      status: row.status,
      metadata: row.metadata ? JSON.parse(row.metadata) : {}
    })));

    if (cartQuote.totalAmount > 0 && Number(totalAmount) !== cartQuote.totalAmount) {
      return res.status(400).json({
        error: 'Order total does not match the server-calculated cart quote.',
        expectedTotalAmount: cartQuote.totalAmount,
        receivedTotalAmount: Number(totalAmount),
        currency: cartQuote.currency
      });
    }
  }

  const orderId = randomUUID();
  const orderNumber = `QP-${Date.now().toString().slice(-6)}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  const createdAt = nowIso();

  db.prepare(`
    INSERT INTO orders (
      id,
      session_id,
      order_number,
      document_name,
      page_count,
      copies,
      color,
      print_mode,
      total_amount,
      currency,
      status,
      note,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_payment', ?, ?, ?)
  `).run(
    orderId,
    session.id,
    orderNumber,
    payload.documentName,
    pageCount,
    copies,
    payload.color,
    payload.printMode,
    totalAmount,
    payload.currency,
    payload.note || null,
    createdAt,
    createdAt
  );

  const historyId = randomUUID();
  db.prepare(`
    INSERT INTO order_status_history (id, order_id, previous_status, new_status, changed_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(historyId, orderId, null, 'pending_payment', createdAt);

  const createdOrder = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(orderId);

  return res.status(201).json({
    orderId: createdOrder.id,
    sessionId: createdOrder.session_id,
    orderNumber: createdOrder.order_number,
    status: createdOrder.status,
    totalAmount: Number(createdOrder.total_amount),
    currency: createdOrder.currency,
    createdAt: createdOrder.created_at
  });
});

app.get('/api/orders/my', (req, res) => {
  const session = getSessionFromRequest(req);

  if (!session) {
    return res.status(401).json({ error: 'No active anonymous session found.' });
  }

  const rows = db.prepare(`
    SELECT * FROM orders
    WHERE session_id = ?
    ORDER BY created_at DESC
  `).all(session.id);

  return res.json({
    orders: rows.map(normalizeOrder)
  });
});

app.get('/api/orders/:id', (req, res) => {
  const session = getSessionFromRequest(req);

  if (!session) {
    return res.status(401).json({ error: 'No active anonymous session found.' });
  }

  const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(req.params.id);

  if (!order) {
    return res.status(404).json({ error: 'Order not found.' });
  }

  if (order.session_id !== session.id) {
    return res.status(403).json({ error: 'Order does not belong to this session.' });
  }

  return res.json({ order: normalizeOrder(order) });
});

app.get('/api/orders/:id/queue', (req, res) => {
  const session = getSessionFromRequest(req);

  if (!session) {
    return res.status(401).json({ error: 'No active anonymous session found.' });
  }

  const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(req.params.id);
  if (!order) {
    return res.status(404).json({ error: 'Order not found.' });
  }

  if (order.session_id !== session.id) {
    return res.status(403).json({ error: 'Order does not belong to this session.' });
  }

  const snapshot = getOrderQueueMetrics(order);
  return res.json({
    orderId: order.id,
    customerUid: order.customer_uid || null,
    queuePosition: snapshot.queuePosition,
    queueLength: snapshot.queueLength,
    etaMinutes: snapshot.etaMinutes,
    estimatedReadyAt: snapshot.estimatedReadyAt,
    queueStatus: snapshot.queueStatus,
    printerStatus: snapshot.printerStatus,
    printerCount: snapshot.printerCount,
    status: order.status
  });
});

app.get('/api/orders/uid/:uid', (req, res) => {
  const session = getSessionFromRequest(req);

  if (!session) {
    return res.status(401).json({ error: 'No active anonymous session found.' });
  }

  const customerUid = typeof req.params.uid === 'string' ? req.params.uid.trim() : '';
  if (!customerUid) {
    return res.status(400).json({ error: 'uid is required.' });
  }

  const order = db.prepare(`SELECT * FROM orders WHERE customer_uid = ?`).get(customerUid);
  if (!order) {
    return res.status(404).json({ error: 'Order not found.' });
  }

  if (order.session_id !== session.id) {
    return res.status(403).json({ error: 'Order does not belong to this session.' });
  }

  return res.json({ order: normalizeOrder(order) });
});

app.patch('/api/orders/:id/status', (req, res) => {
  const adminSession = getAdminSessionFromRequest(req);
  const session = getSessionFromRequest(req);

  if (adminSession) {
    const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(req.params.id);

    if (!order) {
      return res.status(404).json({ error: 'Order not found.' });
    }

    const nextStatus = typeof req.body?.status === 'string' ? req.body.status.trim() : '';

    if (!nextStatus) {
      return res.status(400).json({ error: 'status is required.' });
    }

    if (!VALID_ORDER_STATUSES.has(nextStatus)) {
      return res.status(400).json({ error: 'status is not supported.' });
    }

    if (!isValidOrderTransition(order.status, nextStatus)) {
      return res.status(409).json({
        error: `Invalid status transition from ${order.status} to ${nextStatus}.`,
        allowedStatuses: ORDER_STATUS_TRANSITIONS[order.status] ? Array.from(ORDER_STATUS_TRANSITIONS[order.status]) : []
      });
    }

    const previousStatus = order.status;
    const changedAt = nowIso();

    db.prepare(`
      UPDATE orders
      SET status = ?, updated_at = ?, paid_at = COALESCE(paid_at, CASE WHEN ? = 'paid' THEN ? ELSE paid_at END), ready_at = COALESCE(ready_at, CASE WHEN ? = 'ready' THEN ? ELSE ready_at END), handed_over_at = COALESCE(handed_over_at, CASE WHEN ? = 'handed_over' THEN ? ELSE handed_over_at END)
      WHERE id = ?
    `).run(nextStatus, changedAt, nextStatus, changedAt, nextStatus, changedAt, nextStatus, changedAt, order.id);

    db.prepare(`
      INSERT INTO order_status_history (id, order_id, previous_status, new_status, changed_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(randomUUID(), order.id, previousStatus, nextStatus, changedAt);

    const audit = addAdminAuditEntry({
      adminUserId: adminSession.admin_user_id,
      actor: 'admin',
      action: 'status_changed',
      orderId: order.id,
      details: { previousStatus, nextStatus, changedAt }
    });

    const updatedOrder = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(order.id);
    return res.json({
      actor: 'admin',
      auditId: audit.auditId,
      order: normalizeOrder(updatedOrder)
    });
  }

  if (!session) {
    return res.status(401).json({ error: 'No active anonymous session found.' });
  }

  const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(req.params.id);

  if (!order) {
    return res.status(404).json({ error: 'Order not found.' });
  }

  if (order.session_id !== session.id) {
    return res.status(403).json({ error: 'Order does not belong to this session.' });
  }

  const nextStatus = req.body?.status;

  if (!nextStatus || typeof nextStatus !== 'string') {
    return res.status(400).json({ error: 'status is required.' });
  }

  if (!VALID_ORDER_STATUSES.has(nextStatus)) {
    return res.status(400).json({ error: 'status is not supported.' });
  }

  const actor = typeof req.body?.actor === 'string' ? req.body.actor.trim().toLowerCase() : (typeof req.headers['x-actor'] === 'string' ? req.headers['x-actor'].trim().toLowerCase() : 'customer');

  if (actor !== 'admin' && ['paid', 'printing', 'ready', 'handed_over'].includes(nextStatus)) {
    return res.status(403).json({
      error: 'Customer status updates are limited to queue and cancellation states. Payment and handover are controlled by the backend.'
    });
  }

  if (!isValidOrderTransition(order.status, nextStatus)) {
    return res.status(409).json({
      error: `Invalid status transition from ${order.status} to ${nextStatus}.`,
      allowedStatuses: ORDER_STATUS_TRANSITIONS[order.status] ? Array.from(ORDER_STATUS_TRANSITIONS[order.status]) : []
    });
  }

  const previousStatus = order.status;
  const changedAt = nowIso();

  db.prepare(`
    UPDATE orders
    SET status = ?, updated_at = ?, paid_at = COALESCE(paid_at, CASE WHEN ? = 'paid' THEN ? ELSE paid_at END), ready_at = COALESCE(ready_at, CASE WHEN ? = 'ready' THEN ? ELSE ready_at END), handed_over_at = COALESCE(handed_over_at, CASE WHEN ? = 'handed_over' THEN ? ELSE handed_over_at END)
    WHERE id = ?
  `).run(nextStatus, changedAt, nextStatus, changedAt, nextStatus, changedAt, nextStatus, changedAt, order.id);

  db.prepare(`
    INSERT INTO order_status_history (id, order_id, previous_status, new_status, changed_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(randomUUID(), order.id, previousStatus, nextStatus, changedAt);

  const updatedOrder = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(order.id);

  return res.json({
    order: normalizeOrder(updatedOrder)
  });
});

app.post('/api/orders/:id/handover', (req, res) => {
  const adminSession = getAdminSessionFromRequest(req);
  const session = getSessionFromRequest(req);

  if (adminSession) {
    const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(req.params.id);
    if (!order) {
      return res.status(404).json({ error: 'Order not found.' });
    }

    if (order.status !== 'ready') {
      return res.status(409).json({ error: 'Order must be marked ready before handover can be confirmed.' });
    }

    const confirmation = typeof req.body?.confirmation === 'string' ? req.body.confirmation : 'customer';
    const changedAt = nowIso();
    const pickupCode = order.pickup_code || `QP-${String(order.order_number).slice(-6)}`;

    db.prepare(`
      UPDATE orders
      SET status = 'handed_over', updated_at = ?, handed_over_at = COALESCE(handed_over_at, ?), pickup_code = COALESCE(pickup_code, ?)
      WHERE id = ?
    `).run(changedAt, changedAt, pickupCode, order.id);

    db.prepare(`
      INSERT INTO order_status_history (id, order_id, previous_status, new_status, changed_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(randomUUID(), order.id, order.status, 'handed_over', changedAt);

    const audit = addAdminAuditEntry({
      adminUserId: adminSession.admin_user_id,
      actor: 'admin',
      action: 'handover_confirmed',
      orderId: order.id,
      details: { confirmation, pickupCode, changedAt }
    });

    const updatedOrder = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(order.id);
    return res.json({
      actor: 'admin',
      auditId: audit.auditId,
      pickupCode,
      order: normalizeOrder(updatedOrder)
    });
  }

  if (!session) {
    return res.status(401).json({ error: 'No active anonymous session found.' });
  }

  const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(req.params.id);
  if (!order) {
    return res.status(404).json({ error: 'Order not found.' });
  }

  if (order.session_id !== session.id) {
    return res.status(403).json({ error: 'Order does not belong to this session.' });
  }

  if (order.status !== 'ready') {
    return res.status(409).json({ error: 'Order must be marked ready before handover can be confirmed.' });
  }

  const confirmation = req.body?.confirmation;
  if (confirmation && typeof confirmation !== 'string') {
    return res.status(400).json({ error: 'confirmation must be a string.' });
  }

  const changedAt = nowIso();
  const pickupCode = order.pickup_code || `QP-${String(order.order_number).slice(-6)}`;

  db.prepare(`
    UPDATE orders
    SET status = 'handed_over', updated_at = ?, handed_over_at = COALESCE(handed_over_at, ?), pickup_code = COALESCE(pickup_code, ?)
    WHERE id = ?
  `).run(changedAt, changedAt, pickupCode, order.id);

  db.prepare(`
    INSERT INTO order_status_history (id, order_id, previous_status, new_status, changed_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(randomUUID(), order.id, order.status, 'handed_over', changedAt);

  const updatedOrder = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(order.id);

  return res.json({
    pickupCode,
    order: normalizeOrder(updatedOrder)
  });
});

app.post('/api/orders/:id/payments/create', (req, res) => {
  const session = getSessionFromRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'No active anonymous session found.' });
  }

  const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(req.params.id);
  if (!order) {
    return res.status(404).json({ error: 'Order not found.' });
  }

  if (order.session_id !== session.id) {
    return res.status(403).json({ error: 'Order does not belong to this session.' });
  }

  if (order.status === 'paid') {
    return res.status(409).json({ error: 'Order already paid.' });
  }

  const amount = Number(req.body?.amount ?? 0);
  const currency = req.body?.currency;
  let provider;

  try {
    provider = normalizePaymentProvider(req.body?.gateway || 'demo');
  } catch (error) {
    return res.status(error && error.statusCode ? error.statusCode : 400).json({ error: error.message || 'Unsupported payment provider.' });
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number.' });
  }

  if (!currency || typeof currency !== 'string') {
    return res.status(400).json({ error: 'currency is required.' });
  }

  if (Math.abs(amount - Number(order.total_amount)) > 0.01) {
    return res.status(400).json({ error: 'Payment amount does not match order total.' });
  }

  const upperCurrency = currency.toUpperCase();
  if (upperCurrency !== String(order.currency || '').toUpperCase()) {
    return res.status(400).json({ error: 'Payment currency does not match the order currency.' });
  }

  const paymentId = randomUUID();
  const createdAt = nowIso();
  const providerReference = `provider_${provider}_${Date.now()}`;

  db.prepare(`
    INSERT INTO payments (id, order_id, session_id, amount, currency, provider, status, gateway_reference, created_at, updated_at, paid_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, NULL)
  `).run(paymentId, order.id, session.id, amount, upperCurrency, provider, providerReference, createdAt, createdAt);

  const payment = db.prepare(`SELECT * FROM payments WHERE id = ?`).get(paymentId);

  return res.status(201).json({
    paymentId: payment.id,
    orderId: payment.order_id,
    sessionId: payment.session_id,
    amount: Number(payment.amount),
    currency: payment.currency,
    provider: payment.provider,
    status: payment.status,
    gatewayReference: payment.gateway_reference,
    createdAt: payment.created_at
  });
});

function finalizePaymentConfirmation({ session, order, payment, payload }) {
  const status = String(payload?.status || '').toLowerCase();
  const provider = typeof payload?.provider === 'string' ? payload.provider.trim().toLowerCase() : payment.provider;
  const reference = payload?.reference || payment.gateway_reference || `demo_${Date.now()}`;
  const providedAmount = Number(payload?.amount ?? payment.amount ?? 0);
  const providedCurrency = typeof payload?.currency === 'string' ? payload.currency.toUpperCase() : String(payment.currency || '').toUpperCase();

  if (!session) {
    throw Object.assign(new Error('No active anonymous session found.'), { statusCode: 401 });
  }

  if (!order) {
    throw Object.assign(new Error('Order not found.'), { statusCode: 404 });
  }

  if (order.session_id !== session.id) {
    throw Object.assign(new Error('Order does not belong to this session.'), { statusCode: 403 });
  }

  if (!payment || payment.order_id !== order.id) {
    throw Object.assign(new Error('Payment not found for this order.'), { statusCode: 404 });
  }

  if (payment.provider !== provider) {
    throw Object.assign(new Error('Payment provider does not match the original payment record.'), { statusCode: 400 });
  }

  if (payment.status === 'paid') {
    throw Object.assign(new Error('Payment already confirmed.'), { statusCode: 409 });
  }

  if (status !== 'success') {
    throw Object.assign(new Error('Only successful payment confirmation is supported in the demo gateway.'), { statusCode: 400 });
  }

  if (!Number.isFinite(providedAmount) || providedAmount <= 0) {
    throw Object.assign(new Error('amount must be a positive number.'), { statusCode: 400 });
  }

  if (Math.abs(providedAmount - Number(payment.amount)) > 0.01) {
    throw Object.assign(new Error('Payment amount does not match the stored payment amount.'), { statusCode: 400 });
  }

  if (providedCurrency !== String(payment.currency || '').toUpperCase()) {
    throw Object.assign(new Error('Payment currency does not match the stored payment currency.'), { statusCode: 400 });
  }

  const existingReference = db.prepare(`SELECT * FROM payments WHERE gateway_reference = ? AND provider = ? AND id != ?`).get(reference, provider, payment.id);
  if (existingReference) {
    throw Object.assign(new Error('Payment confirmation already processed for this provider reference.'), { statusCode: 409 });
  }

  const updatedAt = nowIso();

  db.prepare(`
    UPDATE payments
    SET status = 'paid', gateway_reference = ?, updated_at = ?, paid_at = ?
    WHERE id = ?
  `).run(reference, updatedAt, updatedAt, payment.id);

  db.prepare(`
    UPDATE orders
    SET status = 'paid', updated_at = ?, paid_at = ?
    WHERE id = ?
  `).run(updatedAt, updatedAt, order.id);

  const updatedOrder = ensureOrderCustomerUid(order.id);
  const updatedPayment = db.prepare(`SELECT * FROM payments WHERE id = ?`).get(payment.id);

  return {
    paymentId: updatedPayment.id,
    orderId: updatedPayment.order_id,
    status: updatedPayment.status,
    amount: Number(updatedPayment.amount),
    currency: updatedPayment.currency,
    gatewayReference: updatedPayment.gateway_reference,
    paidAt: updatedPayment.paid_at,
    order: normalizeOrder(updatedOrder)
  };
}

app.post('/api/orders/:id/payments/confirm', (req, res) => {
  const session = getSessionFromRequest(req);
  const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(req.params.id);
  const payment = order ? db.prepare(`SELECT * FROM payments WHERE id = ? AND order_id = ?`).get(req.body?.paymentId, order.id) : null;

  try {
    const result = finalizePaymentConfirmation({ session, order, payment, payload: req.body || {} });
    return res.json(result);
  } catch (error) {
    const status = error && error.statusCode ? error.statusCode : 400;
    return res.status(status).json({ error: error.message || 'Unable to confirm payment.' });
  }
});

app.post('/api/payments/webhook', (req, res) => {
  const payload = req.body || {};
  const provider = typeof payload.provider === 'string' ? payload.provider.trim().toLowerCase() : '';

  try {
    normalizePaymentProvider(provider || 'demo');
  } catch (error) {
    return res.status(error && error.statusCode ? error.statusCode : 400).json({ error: error.message || 'Unsupported payment provider.' });
  }

  const orderId = typeof payload.orderId === 'string' ? payload.orderId : (typeof payload.order_id === 'string' ? payload.order_id : null);
  const paymentId = typeof payload.paymentId === 'string' ? payload.paymentId : null;

  if (!orderId) {
    return res.status(400).json({ error: 'orderId is required for provider callbacks.' });
  }

  const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(orderId);
  const payment = order ? db.prepare(`SELECT * FROM payments WHERE id = ? AND order_id = ?`).get(paymentId, order.id) : null;

  try {
    const result = finalizePaymentConfirmation({
      session: { id: order?.session_id || null },
      order,
      payment,
      payload: {
        ...payload,
        provider: provider || payment?.provider || 'demo',
        paymentId: paymentId || payment?.id,
        amount: payload.amount ?? payment?.amount,
        currency: payload.currency ?? payment?.currency,
        status: payload.status,
        reference: payload.reference || payment?.gateway_reference
      }
    });
    return res.json({ status: 'accepted', ...result });
  } catch (error) {
    const status = error && error.statusCode ? error.statusCode : 400;
    return res.status(status).json({ error: error.message || 'Unable to process payment callback.' });
  }
});

app.post('/api/printers/register', (req, res) => {
  const { printerId, name, location, supportedFormats, status } = req.body || {};

  if (!printerId || typeof printerId !== 'string') {
    return res.status(400).json({ error: 'printerId is required.' });
  }

  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'name is required.' });
  }

  if (!location || typeof location !== 'string') {
    return res.status(400).json({ error: 'location is required.' });
  }

  const formats = Array.isArray(supportedFormats) ? supportedFormats : [];
  if (!formats.length) {
    return res.status(400).json({ error: 'supportedFormats must include at least one format.' });
  }

  const now = nowIso();
  const existing = db.prepare(`SELECT * FROM printers WHERE printer_id = ?`).get(printerId);

  if (existing) {
    db.prepare(`
      UPDATE printers
      SET name = ?, location = ?, supported_formats = ?, status = ?, updated_at = ?, last_seen_at = ?
      WHERE printer_id = ?
    `).run(name, location, JSON.stringify(formats), status || 'online', now, now, printerId);

    const updated = db.prepare(`SELECT * FROM printers WHERE printer_id = ?`).get(printerId);
    return res.status(200).json(normalizePrinter(updated));
  }

  const printerPrimaryId = randomUUID();
  db.prepare(`
    INSERT INTO printers (id, printer_id, name, location, supported_formats, status, created_at, updated_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(printerPrimaryId, printerId, name, location, JSON.stringify(formats), status || 'online', now, now, now);

  const stored = db.prepare(`SELECT * FROM printers WHERE printer_id = ?`).get(printerId);
  return res.status(201).json(normalizePrinter(stored));
});

app.get('/api/printers/:printerId/jobs', (req, res) => {
  const printer = db.prepare(`SELECT * FROM printers WHERE printer_id = ?`).get(req.params.printerId);
  if (!printer) {
    return res.status(404).json({ error: 'Printer not found.' });
  }

  const rows = db.prepare(`
    SELECT * FROM printer_jobs WHERE printer_id = ? ORDER BY assigned_at DESC
  `).all(printer.id);

  return res.json({
    printerId: printer.printer_id,
    jobs: rows.map((row) => ({
      jobId: row.id,
      printerId: row.printer_id,
      orderId: row.order_id,
      status: row.status,
      assignedAt: row.assigned_at,
      startedAt: row.started_at,
      completedAt: row.completed_at
    }))
  });
});

app.post('/api/printers/:printerId/jobs/assign', (req, res) => {
  const printer = db.prepare(`SELECT * FROM printers WHERE printer_id = ?`).get(req.params.printerId);
  if (!printer) {
    return res.status(404).json({ error: 'Printer not found.' });
  }

  const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(req.body?.orderId);
  if (!order) {
    return res.status(404).json({ error: 'Order not found.' });
  }

  if (order.status !== 'paid') {
    return res.status(409).json({ error: 'Only paid orders can be assigned to a printer.' });
  }

  const jobId = randomUUID();
  const assignedAt = nowIso();

  db.prepare(`
    INSERT INTO printer_jobs (id, printer_id, order_id, status, assigned_at, started_at, completed_at)
    VALUES (?, ?, ?, 'queued', ?, NULL, NULL)
  `).run(jobId, printer.id, order.id, assignedAt);

  return res.status(201).json({
    jobId,
    printerId: printer.printer_id,
    orderId: order.id,
    status: 'queued',
    assignedAt
  });
});

app.post('/api/orders/:id/files/upload-url', (req, res) => {
  const session = getSessionFromRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'No active anonymous session found.' });
  }

  const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(req.params.id);
  if (!order) {
    return res.status(404).json({ error: 'Order not found.' });
  }

  if (order.session_id !== session.id) {
    return res.status(403).json({ error: 'Order does not belong to this session.' });
  }

  const { fileName, mimeType, fileSize } = req.body || {};
  if (!fileName || typeof fileName !== 'string') {
    return res.status(400).json({ error: 'fileName is required.' });
  }

  if (!mimeType || typeof mimeType !== 'string' || !isAllowedUploadType(fileName, mimeType)) {
    return res.status(400).json({
      error: 'Unsupported file type. Allowed types: PDF, JPG/JPEG, PNG, DOC/DOCX, PPT/PPTX.'
    });
  }

  const size = Number(fileSize || 0);
  if (!Number.isFinite(size) || size <= 0) {
    return res.status(400).json({ error: 'fileSize must be a positive number.' });
  }

  const storageKey = `orders/${order.id}/${Date.now()}-${encodeURIComponent(fileName)}`;
  const uploadUrl = `http://localhost:${PORT}/api/uploads/${encodeURIComponent(storageKey)}`;

  return res.json({
    uploadUrl,
    storageKey,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
  });
});

app.post('/api/orders/:id/files', async (req, res) => {
  const session = getSessionFromRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'No active anonymous session found.' });
  }

  const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(req.params.id);
  if (!order) {
    return res.status(404).json({ error: 'Order not found.' });
  }

  if (order.session_id !== session.id) {
    return res.status(403).json({ error: 'Order does not belong to this session.' });
  }

  const { fileName, mimeType, sizeBytes, storageKey } = req.body || {};

  if (!fileName || typeof fileName !== 'string') {
    return res.status(400).json({ error: 'fileName is required.' });
  }

  if (!mimeType || typeof mimeType !== 'string' || !isAllowedUploadType(fileName, mimeType)) {
    return res.status(400).json({
      error: 'Unsupported file type. Allowed types: PDF, JPG/JPEG, PNG, DOC/DOCX, PPT/PPTX.'
    });
  }

  const size = Number(sizeBytes || 0);
  if (!Number.isFinite(size) || size <= 0) {
    return res.status(400).json({ error: 'sizeBytes must be a positive number.' });
  }

  if (!storageKey || typeof storageKey !== 'string') {
    return res.status(400).json({ error: 'storageKey is required.' });
  }

  const fileId = randomUUID();
  const uploadedAt = nowIso();

  try {
    const conversionResult = await convertUploadedFile(order.id, fileId, session.id, fileName, mimeType, storageKey, size, uploadedAt);

    db.prepare(`
      INSERT INTO order_files (id, order_id, session_id, file_name, mime_type, storage_key, size_bytes, uploaded_at, status, conversion_status, converted_pdf_storage_key, converted_page_count, conversion_error, converted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(fileId, order.id, session.id, fileName, mimeType, storageKey, size, uploadedAt, conversionResult.status, conversionResult.conversionStatus, conversionResult.convertedPdfStorageKey, conversionResult.pageCount, conversionResult.conversionError, conversionResult.convertedAt);

    return res.status(201).json({
      fileId,
      fileName,
      mimeType,
      storageKey,
      sizeBytes: size,
      uploadedAt,
      status: conversionResult.status,
      conversionStatus: conversionResult.conversionStatus,
      convertedPdfStorageKey: conversionResult.convertedPdfStorageKey,
      pageCount: conversionResult.pageCount,
      conversionError: conversionResult.conversionError,
      convertedAt: conversionResult.convertedAt,
      orderId: order.id,
      sessionId: session.id
    });
  } catch (error) {
    return res.status(400).json({
      error: 'Uploaded file could not be converted into a print-ready PDF.',
      detail: error && error.message ? error.message : 'Unknown conversion failure.'
    });
  }
});

app.get('/api/orders/:id/files', (req, res) => {
  const session = getSessionFromRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'No active anonymous session found.' });
  }

  const order = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(req.params.id);
  if (!order) {
    return res.status(404).json({ error: 'Order not found.' });
  }

  if (order.session_id !== session.id) {
    return res.status(403).json({ error: 'Order does not belong to this session.' });
  }

  const rows = db.prepare(`SELECT * FROM order_files WHERE order_id = ? ORDER BY uploaded_at DESC`).all(order.id);

  return res.json({
    files: rows.map(normalizeFileRecord),
    orderId: order.id,
    sessionId: session.id
  });
});

const uploadRoot = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadRoot)) {
  fs.mkdirSync(uploadRoot, { recursive: true });
}

app.post('/api/uploads/:storageKey', express.raw({ type: '*/*', limit: MAX_UPLOAD_SIZE_BYTES }), (req, res) => {
  if (req.body && req.body.length > MAX_UPLOAD_SIZE_BYTES) {
    return res.status(413).json({ error: 'Upload exceeds the configured file size limit.' });
  }

  const rawStorageKey = decodeURIComponent(req.params.storageKey);
  const targetPath = path.join(uploadRoot, rawStorageKey.replace(/^orders\//, '').replace(/\//g, '_'));
  const targetDir = path.dirname(targetPath);

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  fs.writeFileSync(targetPath, req.body || Buffer.alloc(0));
  return res.json({ ok: true, storageKey: rawStorageKey, savedTo: targetPath });
});

const runtimeValidation = validateRuntimeEnvironment();
if (!runtimeValidation.ok) {
  console.error('Quick Print backend configuration error:');
  for (const error of runtimeValidation.errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

if (require.main === module) {
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`Quick Print backend running on http://localhost:${PORT}`);
  });
}

module.exports = {
  app,
  validateRuntimeEnvironment,
  getCookieOptions,
  SESSION_COOKIE_NAME,
  DB_PATH,
  isProductionEnvironment
};
