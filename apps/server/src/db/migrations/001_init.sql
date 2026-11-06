-- Quick Print initial schema (plan section B3).
-- Conventions: ids are UUID text; timestamps are ISO-8601 UTC text; money is INTEGER paise;
-- secrets/tokens are stored only as SHA-256 hashes (or scrypt for passwords).

-- ---------- shop configuration ----------
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,            -- JSON
  updated_at TEXT NOT NULL
);

CREATE TABLE price_tables (
  id            TEXT PRIMARY KEY,
  bw1_paise     INTEGER NOT NULL CHECK (bw1_paise >= 0),   -- B&W, one side, per printed side
  bw2_paise     INTEGER NOT NULL CHECK (bw2_paise >= 0),   -- B&W, both sides, per printed side
  col1_paise    INTEGER NOT NULL CHECK (col1_paise >= 0),
  col2_paise    INTEGER NOT NULL CHECK (col2_paise >= 0),
  a3_multiplier REAL    NOT NULL DEFAULT 2 CHECK (a3_multiplier >= 1),
  active        INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
  created_by    TEXT,
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX price_tables_one_active ON price_tables(active) WHERE active = 1;

-- ---------- anonymous customer sessions ----------
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);
CREATE INDEX sessions_expires ON sessions(expires_at);

-- ---------- orders ----------
CREATE TABLE orders (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL REFERENCES sessions(id),
  status              TEXT NOT NULL CHECK (status IN (
                        'draft','awaiting_payment','paid','printing','print_attention','ready',
                        'handed_over','cancelled','expired','refund_pending','refunded')),
  total_paise         INTEGER NOT NULL DEFAULT 0 CHECK (total_paise >= 0),
  price_table_id      TEXT REFERENCES price_tables(id),
  token_date          TEXT,                 -- IST calendar date the token belongs to (YYYY-MM-DD)
  token_no            INTEGER,              -- sequential per token_date
  recovery_pin_hash   TEXT,                 -- token + PIN lets the customer recover the order elsewhere
  print_mode_snapshot TEXT CHECK (print_mode_snapshot IN ('automatic','manual')),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  checkout_at         TEXT,
  paid_at             TEXT,
  ready_at            TEXT,
  handed_over_at      TEXT,
  cancelled_at        TEXT
);
CREATE UNIQUE INDEX orders_token ON orders(token_date, token_no) WHERE token_no IS NOT NULL;
CREATE INDEX orders_session ON orders(session_id);
CREATE INDEX orders_status ON orders(status, paid_at);

CREATE TABLE order_events (
  id          TEXT PRIMARY KEY,
  order_id    TEXT NOT NULL REFERENCES orders(id),
  from_status TEXT,
  to_status   TEXT NOT NULL,
  actor       TEXT NOT NULL CHECK (actor IN ('customer','admin','system','agent')),
  actor_id    TEXT,
  reason      TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX order_events_order ON order_events(order_id, created_at);

CREATE TABLE daily_counters (
  date       TEXT PRIMARY KEY,   -- IST date
  last_token INTEGER NOT NULL
);

-- ---------- documents ----------
CREATE TABLE documents (
  id                TEXT PRIMARY KEY,
  order_id          TEXT NOT NULL REFERENCES orders(id),
  original_name     TEXT NOT NULL,
  mime_detected     TEXT NOT NULL,
  size_bytes        INTEGER NOT NULL CHECK (size_bytes > 0),
  sha256            TEXT NOT NULL,
  storage_key       TEXT NOT NULL UNIQUE,     -- server-generated, never client-supplied
  pdf_key           TEXT UNIQUE,
  pdf_sha256        TEXT,
  page_count        INTEGER CHECK (page_count IS NULL OR page_count > 0),
  conversion_status TEXT NOT NULL DEFAULT 'queued'
                      CHECK (conversion_status IN ('queued','converting','ready','failed')),
  error             TEXT,
  position          INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  converted_at      TEXT,
  purged_at         TEXT                      -- files deleted by retention job
);
CREATE INDEX documents_order ON documents(order_id, position);

CREATE TABLE document_parts (
  id           TEXT PRIMARY KEY,
  document_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_ranges  TEXT NOT NULL,                 -- 'all' or '1-5,8'
  color        INTEGER NOT NULL CHECK (color IN (0, 1)),
  duplex       INTEGER NOT NULL CHECK (duplex IN (0, 1)),
  paper        TEXT NOT NULL DEFAULT 'A4' CHECK (paper IN ('A4','A3')),
  copies       INTEGER NOT NULL CHECK (copies BETWEEN 1 AND 500),
  -- computed by the server pricing module at quote/checkout time:
  pages        INTEGER,
  sides        INTEGER,
  sheets       INTEGER,
  amount_paise INTEGER,
  position     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX document_parts_doc ON document_parts(document_id, position);

-- ---------- payments (Paytm) ----------
CREATE TABLE payments (
  id           TEXT PRIMARY KEY,             -- used as Paytm ORDERID, unique per attempt
  order_id     TEXT NOT NULL REFERENCES orders(id),
  provider     TEXT NOT NULL DEFAULT 'paytm',
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  status       TEXT NOT NULL DEFAULT 'created'
                 CHECK (status IN ('created','pending','success','failed','expired')),
  txn_token    TEXT,
  txn_id       TEXT UNIQUE,                  -- Paytm TXNID; uniqueness blocks replay
  bank_txn_id  TEXT,
  payment_mode TEXT,
  raw_status   TEXT,                         -- last verified Status API payload (JSON)
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  paid_at      TEXT
);
CREATE INDEX payments_order ON payments(order_id);
CREATE INDEX payments_pending ON payments(status, created_at);

CREATE TABLE payment_events (
  id          TEXT PRIMARY KEY,
  payment_id  TEXT REFERENCES payments(id),
  source      TEXT NOT NULL CHECK (source IN ('callback','webhook','status_api','reconciler','refund')),
  checksum_ok INTEGER CHECK (checksum_ok IN (0, 1)),
  payload     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE refunds (
  id           TEXT PRIMARY KEY,
  payment_id   TEXT NOT NULL REFERENCES payments(id),
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  status       TEXT NOT NULL CHECK (status IN ('pending','success','failed')),
  provider_ref TEXT,
  reason       TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- ---------- print agent & printers ----------
CREATE TABLE agents (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  secret_hash  TEXT UNIQUE,
  pairing_hash TEXT UNIQUE,
  pairing_expires_at TEXT,
  last_seen_at TEXT,
  created_at   TEXT NOT NULL,
  revoked_at   TEXT
);

CREATE TABLE printers (
  id           TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL REFERENCES agents(id),
  os_name      TEXT NOT NULL,                -- name reported by Windows Get-Printer
  display_name TEXT,
  driver       TEXT,
  capabilities TEXT NOT NULL DEFAULT '{}',   -- JSON: color, duplex, paper sizes
  status       TEXT NOT NULL DEFAULT 'offline',
  enabled      INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  role         TEXT NOT NULL DEFAULT 'any' CHECK (role IN ('bw','color','any')),
  ppm_bw       INTEGER NOT NULL DEFAULT 20 CHECK (ppm_bw > 0),
  ppm_color    INTEGER NOT NULL DEFAULT 10 CHECK (ppm_color > 0),
  last_seen_at TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE (agent_id, os_name)
);

CREATE TABLE print_jobs (
  id               TEXT PRIMARY KEY,
  order_id         TEXT NOT NULL REFERENCES orders(id),
  part_id          TEXT NOT NULL REFERENCES document_parts(id),
  printer_id       TEXT REFERENCES printers(id),
  status           TEXT NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued','leased','spooled','printed','failed','uncertain','cancelled')),
  attempt          INTEGER NOT NULL DEFAULT 1,
  is_reprint       INTEGER NOT NULL DEFAULT 0 CHECK (is_reprint IN (0, 1)),
  lease_expires_at TEXT,
  download_token_hash TEXT UNIQUE,
  spooler_job_id   TEXT,
  error            TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  printed_at       TEXT
);
CREATE INDEX print_jobs_status ON print_jobs(status, created_at);
CREATE INDEX print_jobs_order ON print_jobs(order_id);

-- ---------- admin ----------
CREATE TABLE admin_users (
  id              TEXT PRIMARY KEY,
  username        TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,             -- scrypt
  totp_secret_enc TEXT,                      -- AES-GCM encrypted TOTP secret
  role            TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','staff')),
  failed_logins   INTEGER NOT NULL DEFAULT 0,
  locked_until    TEXT,
  created_at      TEXT NOT NULL,
  disabled_at     TEXT
);

CREATE TABLE admin_sessions (
  id            TEXT PRIMARY KEY,
  admin_user_id TEXT NOT NULL REFERENCES admin_users(id),
  token_hash    TEXT NOT NULL UNIQUE,
  csrf_hash     TEXT NOT NULL,
  ip            TEXT,
  user_agent    TEXT,
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);
CREATE INDEX admin_sessions_user ON admin_sessions(admin_user_id);

CREATE TABLE audit_logs (
  id         TEXT PRIMARY KEY,
  actor      TEXT NOT NULL CHECK (actor IN ('admin','system','agent')),
  actor_id   TEXT,
  action     TEXT NOT NULL,
  order_id   TEXT REFERENCES orders(id),
  details    TEXT NOT NULL DEFAULT '{}',     -- JSON
  ip         TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX audit_logs_created ON audit_logs(created_at);
CREATE INDEX audit_logs_order ON audit_logs(order_id);
