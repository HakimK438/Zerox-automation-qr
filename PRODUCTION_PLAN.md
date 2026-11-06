# Quick Print — QR Xerox Automation: Analysis & Production Plan

## Context

A customer scans the shop's QR code, uploads documents (PDF/DOC/DOCX/PPT/PPTX/JPG/PNG), picks print settings and pays with Paytm PG (UPI intent). A verified payment gives them a token and an ETA, and the order appears on the admin dashboard. The admin prints manually or automatically to printers on the shop PC. Sessions are anonymous and survive a closed tab until handover. Target: Oracle Cloud free tier, about 100 concurrent requests with ~5 MB files, no data leakage and no revenue leakage.

Two code bases exist today:
- **Frontend**: github.com/HakimK438/Zerox-automation-qr. Vanilla HTML/JS: `index.html`, `customer.js`, `owner.html`, `owner.js`, `shared.js`, `style.css`. It is a **localStorage mock with no backend calls**. A near-identical older copy is in this folder.
- **Backend**: `backend/server.js`. One 2,616-line Express + `node:sqlite` file with 14 test files. It is a vertical-slice prototype with a demo payment flow, fake document conversion, no real printing, and several critical security holes.

Decisions confirmed with the user: **shop-PC print agent on Windows**, **SQLite (WAL) on one Oracle VM**, frontend taken from the GitHub repo.

---

## Part A — Current system map

### A1. Backend `backend/server.js`: how the pieces connect

**Bootstrap:** `initializeDatabase()` (L41) runs migrations v1–v4 and seeds the admin user from `QP_ADMIN_*`, defaulting to **admin/admin123**. Then CORS middleware (L262), `express.json`, `cookieParser`, `applyRateLimit` (L291, keyed by `getClientIp` (L282) via X-Forwarded-For), `validateRuntimeEnvironment()` (L386), and `app.listen` on 127.0.0.1 (L2604).

**Tables:** `anonymous_sessions`, `carts`, `cart_items`, `orders`, `order_status_history`, `order_files`, `payments`, `printers`, `printer_jobs`, `admin_users`, `admin_sessions`, `admin_audit_logs`, `schema_migrations`.

**Helper graph:**
- `getSessionFromRequest` → `getSessionFromToken` (deletes expired rows) → `anonymous_sessions`
- `requireAdminAuth` → `getAdminSessionFromRequest` (cookie **or Bearer**) → `admin_sessions`⋈`admin_users`. If that fails it falls back to `getSessionFromRequest` to choose 403 vs 401.
- `normalizeOrder` → `getOrderQueueMetrics` → `estimateOrderMinutes`, plus `printers` and `printer_jobs` reads. **There is an N+1 query per order**, and every dashboard row recomputes the whole queue (O(n²)).
- `calculateCartQuote` → `calculateItemQuote` → `validateDocumentSettings` → `parsePageSelection`
- `convertUploadedFile` → `getStorageFilePath`, `parsePdfPageCount` (regex), `createConvertedPdfBuffer` (pdf-lib; DOC/PPT become a **placeholder page**)
- `finalizePaymentConfirmation` → `ensureOrderCustomerUid` → `generateCustomerUid` (Math.random)
- `isValidOrderTransition` and `ORDER_STATUS_TRANSITIONS` (L1182): state machine shared by the admin and customer status routes
- `addAdminAuditEntry` is used only by the admin routes and the admin branches of `/api/orders/:id/status|handover`

**Routes, with the auth each one checks:**

| Route | Auth | Uses |
|---|---|---|
| POST /api/admin/login (L1204) | none | admin_users, sha256 compare; **returns sessionToken in body** |
| POST /api/admin/logout, GET /api/admin/session, /dashboard, /orders, /orders/:id | admin | normalizeOrder |
| PATCH /api/admin/orders/:id/status (L1332) | admin | state machine; **allows pending_payment→paid** |
| POST /api/admin/orders/:id/handover | admin | audit |
| GET /api/health, /api/ready | none | db, uploadRoot |
| POST /api/sessions/create, GET /api/sessions/current | cookie | anonymous_sessions |
| GET /api/sessions/:id (L1561) | **none** | leaks any session's metadata |
| GET/PUT /api/cart, GET /api/carts/:id, GET /api/cart/quote | customer | carts, cart_items, quote |
| POST /api/orders (L1711) | customer | **trusts client pageCount/totalAmount when no cart exists** |
| GET /api/orders/my, /:id, /:id/queue, /uid/:uid | customer+owner | normalizeOrder |
| PATCH /api/orders/:id/status (L1921) | customer or admin | **customer passes `actor:"admin"` in body → can set paid/ready/handed_over** |
| POST /api/orders/:id/handover (L2039) | customer or admin | **customer can self-handover** |
| POST /api/orders/:id/payments/create, /confirm (L2129, L2280) | customer | **demo: customer posts `status:"success"` → order paid** |
| POST /api/payments/webhook (L2294) | **none, no signature** | **anyone can mark any order paid** |
| POST /api/printers/register, GET /:id/jobs, POST /:id/jobs/assign | **none** | printers, printer_jobs |
| POST /api/orders/:id/files/upload-url, /files, GET /files | customer | storageKey is **client-supplied** in /files → can attach another order's file |
| POST /api/uploads/:storageKey (L2577) | **none** | `express.raw` buffers up to 50 MB **in memory**, writes any name to disk |

### A2. Frontend (GitHub repo): how the pieces connect

- `index.html` loads pdf.js, pdf-lib, jszip, docx-preview and html2canvas from CDNs, then `shared.js` and `customer.js`.
- `owner.html` loads qrcode-generator, pdf.js, `shared.js` and `owner.js`.
- **`shared.js` (`QP`)** is the whole data layer, in localStorage `qp_state_v2` and IndexedDB `qp_files`:
  - `load`, `save`, `update`, `onChange` (storage event plus a 3 s poll)
  - pricing: `countRange`, `price`, `sheets`, `orderPages`, rates `bw1/bw2/col1/col2` per printed page
  - queue: `queue`, `canStart`, `eta`
  - actions: `nextToken` (XR-101.., resets daily IST), `createOrder`, `markPaid`, `rateOrder`, `removeUnpaid`, `setStatus`, `setPaused`, `autoStep` (mock print agent), `getOrder`, `saveSettings`, `seedDemo`, `clearDemo`, `putFile`, `getFile`, `demoPdf`
  - formatting helpers
  - Its header says *"each function maps to one future API call; only this file changes"*.
- **`customer.js`** calls into `QP`:
  - `add()` handles file intake (PDF, DOCX via `docxToPdf` in the browser, JPG/PNG via pdf-lib). **DOC, PPT and PPTX are missing**, and the limit is 25 MB.
  - `parts`, `calc` and `card` handle per-document settings: all or custom ranges, with several "parts" per document, each with its own colour and duplex, plus paper and copies.
  - `totals` and `dock` handle price and ETA. `$('pay')` → `QP.createOrder` + `putFile`, then a test "Pay" → `QP.markPaid`.
  - `showOrder` and `fillOrder` render the token page, tracker, ETA and rating. `tick` runs every 30 s.
  - The order id is kept in localStorage `qp_my_order` and in `#order=`.
- **`owner.js`** calls into `QP`:
  - `paintHome`, `paintNow`, `rowAction` and `details` render the orders list. The buttons are **Mark as Paid**, Print now, Confirm pickup and Cancel.
  - Also: the stop/pause control, the auto/manual toggle, a printer select (hardcoded list), settings with a **client-side password "1234"**, the QR poster, and a document viewer.
  - `autoStep` runs every 1 s.
- **Status vocabularies don't match.** The frontend uses unpaid/waiting/printing/ready/collected/cancelled; the backend uses pending_payment/paid/queued/printing/ready/handed_over/cancelled.
- **Pricing models don't match.** The frontend charges per printed page with 4 rates, supports multi-part ranges and A3. The backend hardcodes ₹3 B&W / ₹8 colour per sheet.

### A3. Critical defects (must fix — revenue or data leakage)

1. **Customer can mark own order paid.** The `actor` field in the request body bypasses the check (L2003).
2. **Unauthenticated webhook marks any order paid** (L2294), and the demo `/payments/confirm` route accepts the client's word.
3. **The admin can set pending_payment→paid.** The UI has a "Mark as Paid" button, which is untracked revenue.
4. **Client-controlled price and page count.** The order total is trusted when there is no cart, `metadata.pageCount` comes from the client, and the PDF page count is a regex (`/Count`) that is easily forged.
5. **Unauthenticated upload endpoint** that writes any filename and buffers 50 MB in RAM. 100 parallel uploads could exhaust memory.
6. **Cross-order file theft.** `/orders/:id/files` accepts any `storageKey`.
7. **Printer endpoints are unauthenticated.** Anyone can register a printer or pull jobs.
8. **Weak admin security.** Default admin/admin123, unsalted SHA-256, token returned in JSON plus Bearer support, no login throttling, and the owner settings password lives in the browser.
9. **Rate limiting is bypassable** via a spoofed `X-Forwarded-For`. The CORS allow-list includes `'null'`, and the origin logic (L263) is wrong.
10. **Session tokens are stored in plain text.** `GET /api/sessions/:id` is public. `Math.random()` is used for IDs and UIDs.
11. **Money stored as REAL.** There are no DB transactions around multi-step writes. `node:sqlite` is experimental.
12. **No real conversion for DOC/DOCX/PPT/PPTX, and no real printing.** About 200 stray `.db` files and test uploads are committed to the folder.

---

## Part B — Target architecture

```
 Customer phone ──HTTPS──▶ Caddy (TLS, body limit, real-IP) ──▶ Node API (127.0.0.1:3000) ──▶ SQLite WAL
   (QR → web app)                    │                              │  ├─ files on block volume (private)
                                     │                              │  ├─ conversion queue → LibreOffice (sandboxed)
 Admin browser ──HTTPS──▶ admin.<domain> (separate origin)          │  ├─ SSE hub (customer + admin live updates)
                                                                    │  └─ Paytm client (initiate / status / refund)
 Paytm PG ──S2S callback (checksum)──▶ /api/payments/paytm/callback │
 Shop PC (Windows) print agent ──outbound WSS (device secret)───────┘   (no inbound ports at the shop)
        └─ Get-Printer discovery → SumatraPDF silent print → spooler status back to server
```

### B1. Repository layout (monorepo, plain JS/Node 22, no build step for the web apps)

```
quick-print/
├─ apps/
│  ├─ server/
│  │  ├─ src/
│  │  │  ├─ app.js                  # express wiring only
│  │  │  ├─ server.js               # listen, graceful shutdown, starts jobs
│  │  │  ├─ config/env.js           # validated env (fail fast; no default secrets)
│  │  │  ├─ db/{index.js, migrations/NNN_*.sql, tx.js}   # better-sqlite3, WAL, busy_timeout
│  │  │  ├─ middleware/{securityHeaders, cors, rateLimit, requestId, customerSession,
│  │  │  │              adminAuth, csrf, agentAuth, validate, errorHandler}.js
│  │  │  ├─ modules/
│  │  │  │  ├─ sessions/   (routes, service)
│  │  │  │  ├─ documents/  (upload routes, storage, fileSniff, convert queue, pageCount)
│  │  │  │  ├─ pricing/    (THE only price function; versioned price table)
│  │  │  │  ├─ orders/     (routes, service, stateMachine.js)
│  │  │  │  ├─ payments/   (paytm/{client,checksum,callback,status}.js, reconciler, refunds)
│  │  │  │  ├─ queue/      (token counter, ETA, dispatcher auto/manual/pause)
│  │  │  │  ├─ admin/      (auth+TOTP, dashboard, settings, printers, reports, audit)
│  │  │  │  ├─ agent/      (pairing, WSS gateway, job lease, file download tokens)
│  │  │  │  └─ realtime/   (SSE hub)
│  │  │  └─ jobs/{retentionCleanup, paymentReconciler, sessionExpiry, leaseWatchdog}.js
│  │  ├─ scripts/{admin-create.js, backup.sh}
│  │  └─ test/ (node:test; unit + supertest integration + security regression)
│  ├─ web/            # customer app (from GitHub repo): index.html, customer.js, style.css,
│  │                  #   api.js (replaces shared.js data layer), vendor/ (self-hosted pdf.js etc.)
│  ├─ admin/          # owner.html, owner.js, login.html, api.js, vendor/
│  └─ print-agent/    # Windows service: discovery, ws client, printer (SumatraPDF), spooler watch
├─ shared/constants.js   # status enums, labels, file types (imported by server; copied into web)
└─ deploy/ (Caddyfile, systemd units, oci-security-list.md, backup cron, k6 load test)
```

### B2. Order lifecycle (one state machine, server-owned)

`draft` (uploading/configuring) → `awaiting_payment` → `paid` (token assigned, enters queue) → `printing` → `ready` → `handed_over`

Side states: `cancelled` (before payment), `refund_pending` → `refunded`, `print_attention` (agent error or uncertain result), `expired` (unpaid > 30 min).

- **Only `payments/service.markPaidVerified()` can move an order to `paid`.** Customers and admins cannot.
- Customers can only cancel their own unpaid orders.
- Admin transitions: printing↔attention, ready, handed_over (requires the pickup PIN), and cancel-with-refund.
- Each transition runs in a DB transaction that writes `order_events` and an audit row.
- UI labels map 1:1 to the GitHub frontend's `LABEL` values (waiting = paid).

### B3. Data model (migrations rewritten fresh; money in **integer paise**)

- `settings`: shop info, hours, print mode (auto/manual), paused, retention, max copies, paper sizes. Versioned `price_tables(id, bw1, bw2, col1, col2, a3_multiplier, created_at)`.
- `sessions(id, token_hash UNIQUE, created_at, last_seen_at, expires_at, recovery_pin_hash)`
- `orders(id, session_id, status, total_paise, price_table_id, token_no, token_date, pickup_pin_hash, print_mode_snapshot, timestamps…)`
- `documents(id, order_id, original_name, mime_detected, size, sha256, storage_key, pdf_key, pdf_sha256, page_count, conversion_status, error)`
- `document_parts(id, document_id, page_ranges, color, duplex, paper, copies, pages, sides, sheets, amount_paise)`
- `payments(id = Paytm ORDERID, order_id, amount_paise, status, txn_id UNIQUE, bank_txn_id, payment_mode, raw_status JSON, created_at, updated_at)` plus `payment_events` (every callback or status-check payload)
- `daily_counters(date PK, last_token)`
- `agents(id, name, secret_hash, last_seen_at, revoked_at)`
- `printers(id, agent_id, os_name, driver, capabilities JSON, status, enabled, role[bw|color|any], ppm_bw, ppm_color)`
- `print_jobs(id, order_id, part_id, printer_id, status[queued|leased|spooled|printed|failed|uncertain], attempt, lease_expires_at, spooler_job_id, error)`
- `admin_users(username, scrypt_hash, totp_secret_enc)`, `admin_sessions(token_hash, csrf_secret, ip, ua, expires_at)`, `audit_logs`

**Existing code worth porting** from `backend/server.js`:
- the migration runner pattern (L41)
- `parsePageSelection` (L674) and `validateDocumentSettings` (L759), moved into pricing
- `ORDER_STATUS_TRANSITIONS` and `isValidOrderTransition` (L1182)
- the ETA idea in `getOrderQueueMetrics` (L536), rewritten to run once per request
- `normalize*` response shapers and `ALLOWED_UPLOAD_TYPES` (L962)
- the test structure in `backend/tests/*.test.js`, with the tests rewritten against the new API

---

## Part C — Feature design

### C1. Anonymous session that survives until handover
- `POST /api/session` sets cookie `__Host-qp_sid`: 256-bit random, HttpOnly, Secure, SameSite=Lax, Path=/, Max-Age 30 days. The DB stores only the SHA-256 hash.
- Sliding expiry. **The session never expires while it owns an order in paid…ready.** The expiry job only removes sessions whose orders are all terminal and older than 24 h.
- Returning visitors: the page calls `GET /api/me/orders` and opens any active order automatically, replacing localStorage `qp_my_order`.
- **One PIN for recovery and pickup** (implemented in phase 1): the 4-digit PIN on the token page both recovers the order in another browser and is checked at handover. It is stored as `orders.recovery_pin_hash`, and there is no separate pickup PIN. After 10 wrong PINs, recovery locks until the customer asks at the counter.
- **Recovery for a different browser.** QR scanners and UPI apps can open in-app webviews with separate cookie jars. The token page shows the token plus a 4-digit **recovery PIN**. "Find my order" (token + PIN, rate-limited at 5 tries per 15 min per IP and per token) re-binds the order to the current session.

### C2. Upload and conversion (server is the source of truth)
- **Upload:** `POST /api/orders/:id/documents` (multipart).
  - **busboy streams to disk** with no in-memory buffering, a 25 MB per-file cap (Caddy also caps the request) and a 10-file cap.
  - The server computes sha256 and assigns its own random storage key; the client never supplies a path.
- **Magic-byte sniffing** (`file-type`): the extension, MIME and content must all agree.
  - Reject macro formats (.docm/.pptm), encrypted PDFs, and anything over 500 pages.
- **Conversion queue** (concurrency 1 on 2 OCPU, 60 s timeout per job):
  - DOC/DOCX/PPT/PPTX: **LibreOffice headless** (`soffice --convert-to pdf`) under a separate low-privilege user with a temporary profile directory. Run it via `systemd-run` with MemoryMax and no network.
  - JPG/PNG: pdf-lib fit-to-A4 (reuse the logic in the frontend's `add()`).
  - PDF: normalise with `qpdf --linearize` and reject anything malformed.
- **Page count** comes from `pdf-lib` loading the converted PDF, never from the client and never from a regex.
- **Progress:** the client gets status over SSE (`converting` → `ready` with a preview URL). It previews the **server PDF** through an authenticated stream (`GET /api/documents/:id/preview`, owner session only). The browser-side DOCX conversion (`docxToPdf`) is removed.
- **Frontend changes:**
  - the `accept=` list adds `.doc,.ppt,.pptx`
  - an immediate local preview is still allowed for PDFs and images
  - the price shown is always `GET /api/orders/:id/quote`

### C3. Pricing and quote (server-only)
- `pricing.quote(order)` reads the documents' server page counts, each part's ranges/colour/duplex/paper/copies, and the active `price_table`. It returns line items and `total_paise`.
- The same function runs on quote, at checkout (locks the total), and again in the Paytm amount check.
- Prices are admin-configurable. Each order stores `price_table_id`, so a later price change never alters past orders.
- **Duplex basis** (implemented in phase 3): `price_tables.duplex_basis` is `sheet` (default; both-sides rates charged per sheet of paper) or `side` (per printed side). Overlapping page ranges between parts are rejected. Copies are per document.
- The order is **frozen at checkout**: no document or part edits are allowed after `awaiting_payment`.

### C4. Paytm PG with UPI Intent (zero-trust payment)
1. **Checkout:** `POST /api/orders/:id/checkout`.
   - Re-quote and freeze the order, then create a `payments` row whose id becomes the Paytm `ORDERID`, unique per attempt.
   - Call **Initiate Transaction API** with `txnAmount` taken from the DB and the body signed via `paytmchecksum` with the merchant key from env.
   - Then call **Process Transaction API with `paymentMode: UPI_INTENT`**, which returns `deepLinkInfo.deepLink` (upi://…).
   - The frontend picks the payment method per device (Android, iOS, desktop, in-app browser). **See C10.** Every route uses the same server-side order and verification, so no platform is trusted more than another.
   - *Prerequisite: Paytm must enable UPI Intent (including iOS app-specific intent) and JS Checkout on the MID; confirm during onboarding.*
2. **Callback** at `POST /api/payments/paytm/callback`, plus the S2S webhook URL configured in the Paytm dashboard.
   - Verify the checksum, log to `payment_events`, then **always call the Transaction Status API** (`/v3/order/status`, signed).
   - Accept only if: STATUS = TXN_SUCCESS, MID matches, ORDERID exists and is pending, TXNAMOUNT equals `amount_paise`, and TXNID has not been used before.
   - In one transaction: mark the payment paid, mark the order paid, assign the token (`daily_counters` row, IST date, e.g. `A-042`), generate the pickup PIN, enqueue the print job(s), and broadcast over SSE.
   - The whole step is idempotent.
3. **Reconciler job:** every 20 s, poll the Status API for payments pending between 20 s and 30 min, so a missed webhook still completes. Mark payments failed or expired after 30 min.
4. **Customer side:** after returning from the UPI app the page subscribes to SSE and polls `GET /api/orders/:id` as a fallback. The client never reports success.
5. **Refunds:** an admin cancel after payment calls the **Paytm Refund API**, which is audited. There is **no manual "Mark as Paid"**. If cash is ever needed, it is a separate audited `cash_paid` path that shows separately in reports; it is off by default.
6. **Daily reconciliation report:** paid orders vs Paytm transactions vs pages printed. This is the revenue-leak detector.

### C5. Token, queue and ETA
- The token is assigned atomically at payment: a sequential daily counter in IST, matching the frontend's `nextToken` UX (XR-101…).
- **ETA uses list scheduling across online, enabled printers.** Each job's minutes are `setup_s + sides / ppm(colour|bw)`, with duplex adding about 10%. The remaining time of the job currently printing comes from agent progress.
  - Manual mode adds the admin's rolling average start delay.
  - Pause shows "Printing paused" with no ETA.
  - The queue is computed **once per change** and cached in memory. It is not recomputed per row.
- Pushed over SSE to the customer's order page and the admin dashboard, replacing the 3 s, 30 s and 1 s polling in `shared.js`, `customer.js` and `owner.js`.

### C6. Print agent (Windows shop PC)
- **Stack:** Node 22, packaged as a single exe with Node SEA and installed as a Windows Service via WinSW/NSSM. Ships with portable **SumatraPDF**.
- **Pairing:** the admin clicks "Add print agent", which shows a one-time 10-minute code. The agent exchanges it for a device secret, stored with Windows DPAPI; the server stores only the hash. The admin can revoke it.
- **Discovery:**
  - every 15 s, `powershell Get-Printer | ConvertTo-Json` (name, status, driver, port)
  - `Get-PrintConfiguration` for colour and duplex capability
  - reported as a heartbeat over **outbound WSS**, so there are no inbound ports at the shop
  - the admin dashboard lists printers that are detected automatically; the admin enables them and assigns a role (B&W, colour or any) and ppm
- **Dispatch:**
  - Auto mode: the server's dispatcher leases the next job to an idle matching printer.
  - Manual mode: the admin clicks Print.
  - Pause blocks all dispatch.
- **Job execution:**
  1. The agent fetches the PDF with a single-use, 5-minute download token bound to the job lease, and verifies its sha256.
  2. It runs `SumatraPDF -print-to "<printer>" -print-settings "<ranges>,<duplexlong|simplex>,<color|monochrome>,<N>x,paper=<A4|A3>" -silent`.
  3. It watches `Get-PrintJob` until the spooler job completes or errors, reports `printed` or `failed`, then deletes the local file.
- **Never auto-reprint.** A lost lease or connection mid-print becomes `uncertain` → `print_attention`, and the admin decides whether to reprint. Every reprint is audited and flagged in reports, which prevents both double printing and waste.

### C7. Admin dashboard security
- **Separate origin:** `admin.<domain>`. It is not linked from the customer app, and the customer origin's CSP and CORS cannot call admin APIs.
- **Server-side gate:** `GET /` on the admin origin serves `login.html` unless there is a valid admin session. All `/api/admin/*` routes require `adminAuth`; `/api/agent/*` routes require `agentAuth`. They never fall back to each other.
- **Credentials:**
  - No default credentials; `node scripts/admin-create.js` bootstraps the first admin.
  - Passwords use **scrypt** (`node:crypto`) with a per-user salt.
  - **TOTP 2FA** is required.
  - Login throttling: 5 failures lock the account and IP for 15 minutes, with a timing-safe compare.
- **Admin session:** cookie `__Host-qp_admin`, HttpOnly, Secure, **SameSite=Strict**, 12 h absolute and 30 min idle. The token hash is stored, and the token is never returned in JSON. **CSRF token** required on every non-GET request. Logout everywhere is available.
- **Optional extra layer**, recommended: Caddy restricts `admin.<domain>` to the shop's IP or a Tailscale address, or puts it behind Cloudflare Access.
- **Audit log** of every admin action: status changes, reprints, refunds, price and settings changes, agent pairing.
- Settings move server-side (the password "1234" in `shared.js` is removed). Price changes require re-entering the password.

### C8. Platform security baseline
- **Caddy:** automatic TLS, HSTS, a 26 MB request body limit, and `X-Forwarded-For` set by Caddy only. Express uses `trust proxy = 'loopback'`.
- **Headers:** helmet with a strict CSP (`default-src 'self'`; vendor libraries **self-hosted** with SRI instead of unpkg/cdnjs; Paytm checkout domains explicitly allowed), `frame-ancestors 'none'`, nosniff, and Referrer-Policy `same-origin`.
- **CORS:** exact origins only, and never `null`.
- **Validation:** request schemas (zod) on every route, plus a JSON body limit of 100 KB.
- **Rate limits** per IP and per session, by route class: session create, upload, checkout, recovery and login each have their own limits.
- **IDs and secrets:**
  - All IDs and tokens come from `crypto.randomUUID()` or `randomBytes`; no `Math.random`.
  - Secrets come only from env or a root-only `/etc/quickprint/env`: Paytm MID and key, cookie secret, TOTP encryption key.
- **Data protection:**
  - Files live outside the web root on a block volume and are never statically served.
  - Retention job: originals and PDFs are deleted 2 h after handover (admin-configurable, matching the frontend's "cleanup" setting), unpaid drafts after 1 h, and the agent's local copies immediately after printing.
  - Logs carry no file names or contents, and requests are logged with a request id.
- **OS:**
  - OCI security list and iptables allow only 80/443; SSH is limited to your IP or the OCI Bastion.
  - Unattended upgrades and fail2ban.
  - Node runs as an unprivileged `quickprint` user under systemd with `ProtectSystem=strict`, `NoNewPrivileges` and `PrivateTmp`.

### C10. Works on every device (Android, iOS, desktop, in-app browsers)

**Payment: one checkout screen, best option first, every fallback always visible.**

| Device / browser | Primary | Fallbacks |
|---|---|---|
| Android (Chrome, Samsung Internet, Firefox, Edge) | Generic `upi://pay` intent from Paytm's `deepLink`. Android shows a chooser listing every installed UPI app. | App buttons; Paytm JS Checkout |
| iOS (Safari, Chrome iOS) | **App buttons**: GPay, PhonePe, Paytm, BHIM. iOS has no generic UPI chooser, so each button rewrites Paytm's deeplink to that app's scheme (`gpay://upi/pay?…`, `phonepe://pay?…`, `paytmmp://pay?…`, `bhim://upi/pay?…`). | Paytm JS Checkout (UPI ID/collect, cards, netbanking, wallet) |
| Desktop / laptop | **Dynamic UPI QR** rendered from the same deeplink (or Paytm's dynamic-QR API) for the customer to scan with their phone | Paytm JS Checkout |
| In-app webviews (Instagram, WhatsApp, Google Lens, Paytm scanner) | Detected from the user agent. Show a banner: "Open in Chrome/Safari" (Android uses an `intent://` link to Chrome) | QR plus JS Checkout. The recovery PIN (C1) covers a separate cookie jar. |

- **Detection:** check the user agent and the `navigator.userAgentData` platform, but **never hide options**. Detection only reorders the buttons, so a wrong guess still leaves a working path.
- **Returning from the UPI app:** iOS doesn't auto-return, so the customer switches back manually.
  - On `visibilitychange` or `focus`, the page re-checks status immediately and re-opens the SSE stream.
  - A "Payment done? Check status" button is always shown.
  - The server's status reconciler (C4.3) completes the order even if the page is never reopened.
- **Never mark paid from the client** on any platform. All paths end in the same signed callback plus Status API check.

**Rest of the app, cross-browser:**
- **Uploads:**
  - The file input `accept` lists exact MIME types and extensions.
  - iPhone photos (HEIC) are auto-converted to JPEG by iOS when HEIC isn't in `accept`. The server *also* accepts `.heic/.heif`, converting with `sharp` (libheif), for desktop uploads of iPhone files.
  - iOS "Files" and Android "Documents" pickers both work with a plain `<input type=file multiple>`. No drag-and-drop dependency on mobile.
- **Preview:** self-hosted **pdf.js legacy build** (supports Safari 14+ and older Android WebView). Office files preview only from the server-converted PDF.
- **Sessions:**
  - Server-set first-party HttpOnly cookies aren't subject to Safari ITP's 7-day cap on cookies set by JavaScript.
  - Private/incognito mode or cleared cookies fall back to the token + PIN recovery.
  - No reliance on localStorage for anything important.
- **Live updates:** use SSE with polling fallback, since some corporate proxies or old browsers break SSE. Reconnect on `online` or `visibilitychange`, because iOS suspends background tabs.
- **UI:**
  - Responsive layout down to 320 px, plus safe-area insets for the iPhone notch.
  - Tap targets of at least 44 px.
  - No `alert`/`confirm`; owner.js's `confirm()` is replaced with an in-page dialog.
  - `navigator.vibrate` stays optional, since iOS lacks it.
  - Fonts and libraries self-hosted, so slow 3G/4G networks don't block on CDNs.
- **Baseline support:** Android 8+ Chrome/Samsung Internet, iOS 15+ Safari/Chrome, the last 2 versions of desktop Chrome/Edge/Firefox/Safari. The page shows a friendly "update your browser" message below that.

### C9. Capacity on Oracle Always Free
- **VM:** Ampere A1, **2 OCPU / 12 GB** (the user's free-tier allowance), Ubuntu 24.04 arm64, plus a 100 GB block volume for `/var/lib/quickprint`. Add 4 GB of swap as a safety net.
- **100 concurrent 5 MB uploads ≈ 500 MB inbound.** This is network- and disk-bound, not CPU-bound. Streaming to disk keeps RAM under about 300 MB for Node.
- **Only office conversions are CPU-bound** (LibreOffice takes roughly 1–3 s and 300–500 MB per DOCX/PPTX on one core):
  - Queue them at **concurrency 1**. That leaves one core free for the API, so uploads and the dashboard stay responsive while a burst of DOCX files drains.
  - Keep a warm LibreOffice instance (unoserver) to avoid a 2–3 s cold start per file.
  - Show the customer a queue position while their file converts.
  - PDFs and images take a fast path of under 1 s and skip the queue.
- **Budget:** Node about 0.5 GB, LibreOffice at most 1 GB under `MemoryMax`, Caddy about 50 MB, page cache for SQLite and files from the rest. That leaves large headroom on 12 GB.
- **Escape hatch if DOCX bursts become the bottleneck:** move conversion to the Windows shop PC's print agent using Word/PowerPoint COM or LibreOffice. The cloud then handles only PDFs and images.
- **One Node process** with better-sqlite3 in WAL mode (`synchronous=NORMAL`, `busy_timeout=5000`) handles thousands of small queries per second, so SQLite is not the bottleneck.
- **Backups:** nightly `sqlite3 .backup`, encrypted, to OCI Object Storage (free 20 GB) with 14-day retention. Uploads are ephemeral and not backed up.
- **Idle reclamation:** Always Free instances with very low CPU can be reclaimed. Upgrade the tenancy to Pay-As-You-Go (it stays free within limits) to avoid this.
- **Load test (k6):** 100 virtual users each upload 5 MB, configure and check out. Target p95 under 3 s for upload acknowledgement and zero 5xx.

---

## Part D — Implementation phases (each is a vertical slice with tests)

0. **Cleanup and scaffold.** Create the monorepo layout, a `.gitignore` (db, uploads, env), and delete the ~200 stray `*.db` and test uploads. Move the GitHub frontend into `apps/web` and `apps/admin`. Add `env.js`, `db` with migrations, middleware, and the error handler.
1. **Sessions and recovery** (C1), including security regression tests: no public session lookup, hashed tokens.
2. **Documents:** streaming upload, sniffing, conversion queue, page count (C2). The frontend `add()` is wired to the API.
3. **Pricing and quote** (C3). The frontend `calc()` becomes display-only and reconciles with the server quote.
4. **Paytm checkout, callback, status, reconciler and refunds** (C4), using the Paytm staging MID, with the per-device payment picker (C10). The demo provider is **removed from the production build**.
5. **Token, queue, ETA and SSE** (C5). `customer.js` `fillOrder` and `tick` read from the API and SSE.
6. **Admin auth and dashboard** (C7). `owner.js` is wired to `/api/admin/*`; "Mark as Paid" is removed and a Refund action is added.
7. **Print agent:** pairing, discovery, dispatch in auto and manual modes with pause, spooler tracking (C6).
8. **Handover with pickup PIN, retention cleanup, reconciliation report.**
9. **Deploy:** Caddy, systemd, OCI networking, backups, monitoring (`/api/ready` plus uptime check), the k6 load test, and a security pass with `/security-review`.

`apps/web/api.js` keeps the **same function names as `QP`** in `shared.js` (createOrder, getOrder, onChange…), so `customer.js` and `owner.js` change as little as possible.

---

## Part E — Verification

- **Unit tests:** pricing (ranges, multi-part, duplex, A3, rounding in paise), the state machine (every illegal transition rejected), token counter rollover at IST midnight, ETA scheduling.
- **Integration tests (supertest):** the full flow session → upload → convert → quote → checkout → *signed mock Paytm callback plus mocked Status API* → paid → token → agent lease → printed → ready → handover with PIN.
- **Security regression tests,** one per defect in A3. Each must fail on the old server and pass on the new one:
  - the customer `actor:admin` trick
  - an unsigned or forged webhook
  - a callback whose amount doesn't match the Status API
  - a replayed TXNID
  - an admin trying to set paid
  - a cross-session order or file access
  - a client storageKey
  - an upload without a session
  - agent endpoints without a device secret
  - admin routes reached with a customer cookie
  - login brute force
  - a spoofed XFF
- **Paytm staging end-to-end on a device matrix:** real phones or BrowserStack real devices.
  - **Devices:** Android Chrome, Android Samsung Internet, iPhone Safari, iPhone Chrome, desktop Chrome/Safari (QR path), and the Instagram/WhatsApp in-app browsers.
  - **Each payment route** must succeed: Android chooser intent, every iOS app button (GPay/PhonePe/Paytm/BHIM), desktop QR, JS Checkout fallback.
  - **Each failure case** must recover: user cancels in the UPI app, app killed mid-payment, user never returns to the browser.
  - **Reconciler:** confirm it completes the order when the webhook is blocked.
- **Cross-device upload:** an iPhone camera photo (HEIC), a DOCX from the iOS Files app, a PPTX from Android Downloads, and a 25 MB PDF on a slow-3G throttle.
- **Print agent on the Windows shop PC:** printer discovery shows real printers, and each setting combination is checked on paper (range, duplex, colour/mono, copies, A3). Unplug the printer mid-job and expect `print_attention` with no auto-reprint.
- **Load:** run the k6 script against the OCI VM with 100 concurrent 5 MB uploads, and confirm RAM stays stable and there are no 5xx.
- **Manual:** close the tab or kill Chrome after paying, rescan the QR and confirm the order shows. Open in a different browser and recover with token + PIN.
