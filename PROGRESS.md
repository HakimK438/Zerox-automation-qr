# Quick Print — Progress & Handoff

> **Start every new conversation by reading this file, then [PRODUCTION_PLAN.md](PRODUCTION_PLAN.md).**
> Update this file at the end of every phase. Keep it in sync with the code.

_Last updated: 2026-11-06 (end of Phase 8, plus UI, Hindi, test payments and Word fixes)_

---

## 1. Where we are

| # | Phase | Status | Plan section |
|---|---|---|---|
| 0 | Cleanup + scaffold (config, DB schema, security middleware) | ✅ Done | Part D |
| 1 | Anonymous sessions + token/PIN recovery | ✅ Done (API) | C1 |
| 2 | Document upload + conversion | ✅ Done (API) | C2, C9 |
| 3 | Pricing + quote + checkout freeze (server-only) | ✅ Done (API) | C3 |
| 4 | Paytm payment + verification + reconciler + refunds (server; tested against a mock Paytm) | ✅ Done (API) | C4, C10 |
| 5 | Queue + ETA, live updates (SSE), customer page wired to the API (per-device payment UI) | ✅ Done | C5, C10 |
| 6 | Admin auth (scrypt + TOTP) + dashboard wired to the API | ✅ Done | C7 |
| 7 | Windows print agent (built + tested with fake Windows tools; needs a real shop PC test) | ✅ Done | C6 |
| 8 | Retention cleanup, reconciliation, flagged-payment refunds, password change | ✅ Done | Part D |
| 9 | **Oracle Cloud deployment, load test, security review** | ⏭️ **NEXT** | C8, C9 |

**Tests:**
- 161 server + 5 print-agent tests passing (`npm test` runs both).
- **19 real-browser customer checks** (`npm run e2e`).
- **33 real-browser admin checks** (`npm run e2e:admin`: owner and customer side by side). This includes pairing the real agent from the dashboard and automatic printing through fake PowerShell/SumatraPDF.
- All run in Chromium against the real server plus mock Paytm. `npm audit`: 0 vulnerabilities.

**Frontend status:**
- **Customer site (`apps/web`) is fully wired to the API.**
- **Admin site (`apps/admin`) is fully wired to the API.** It is served only on the admin host:
  - login (password + authenticator code)
  - live orders: start printing → mark ready → hand over with the customer's PIN
  - refund, document viewer, settings, prices, QR poster, reports and activity log

**Quickest way to try it locally:** `npm run dev`, then in a second terminal `npm run dev:account`. Open http://localhost:3001 and press Log in: the form fills itself (test owner `testowner`, saved in `data/dev-login.json`). The shop is on http://localhost:3000, with test payment buttons instead of UPI.

**Or with a real owner account and a fake Paytm:**
1. `npm run admin:create`: create the owner. Scan the QR code with Google Authenticator or Microsoft Authenticator.
2. `npm run dev:fakepay`: starts the shop with a **fake Paytm**.
   - Customer site: http://localhost:3000
   - Admin: http://localhost:3001
   - Fake-Paytm control page, where you click "Approve" for a payment: http://127.0.0.1:3099
3. `npm run dev` without Paytm keys runs **test payments** (see §2).

---

## 2. Decisions made (do not re-litigate)

- **Stack:** Node 22, Express 5, better-sqlite3 (WAL), zod 4, helmet, busboy, sharp 0.35.5, pdf-lib, heic-convert, yauzl. CommonJS. No build step for web apps.
- **Hosting:** one Oracle Always Free VM, **2 OCPU / 12 GB** (user's allowance), Caddy in front, Node on 127.0.0.1.
- **Printing:** Windows shop PC runs a print agent with an outbound WebSocket and SumatraPDF. The cloud never reaches into the shop.
- **Database:** SQLite only. Money is integer **paise**. Only token **hashes** are stored.
- **Only payment verification (`system` actor) can move an order to `paid`.** Admins and customers cannot (see `shared/constants.js`). There is no "Mark as Paid".
- **One 4-digit PIN** serves both recovery in another browser and pickup at handover (`orders.recovery_pin_hash`). There is no separate pickup PIN.
- **Customer and admin are separate origins** (`QP_PUBLIC_ORIGIN` ≠ `QP_ADMIN_ORIGIN`, enforced in production).
- **No CORS.** The app is same-origin. `originGuard` blocks cross-site state changes. `/api/payments/paytm/*` is exempt and must verify the checksum + Status API instead.
- **Conversion** runs in **persistent worker threads**: fast lane (PDF/images, concurrency 2) and office lane (LibreOffice, concurrency 1). Do not go back to one worker per job (it cost ~0.5 s CPU each).
- **HEIC is not in the browser `accept` list**, so iPhones send JPEG. The server still accepts HEIC.
- **qpdf dropped.** pdf-lib validates PDFs and counts pages.
- **The plan's C9 says 2 OCPU / 12 GB.** It was corrected from 4/24 by the user.
- **Pricing (phase 3):** 4 rates in paise: `bw1`/`col1` (one side, per printed page) and `bw2`/`col2` (both sides).
  - `price_tables.duplex_basis` decides how both-sides rates are charged. Default is `'sheet'` (per sheet of paper). `'side'` (per printed side) is the original frontend code's behaviour, which made duplex dearer than single-sided; its README said per sheet. **The user has not confirmed yet; the admin can switch it in phase 6.**
  - A3 = rate × `a3_multiplier` (default 2), rounded to whole paise.
  - Placeholder prices are ₹3 / ₹5 / ₹10 / ₹10 (the frontend defaults) until the user sends real ones.
  - Every price change is a **new `price_tables` row**. Old orders keep their frozen numbers.
- **Copies are per document** (UI), stored on every part. **Overlapping page ranges** between parts of the same document are **rejected**, not charged twice.
- **Every upload gets a default part:** all pages, B&W, one side, first allowed paper, 1 copy.
- **Payments (phase 4):**
  - Only `payments/service.applyStatus()` can mark an order paid, and only from a **Transaction Status API** response this server fetched itself. Callbacks and webhooks are hints: their checksum is verified, then the Status API is asked.
  - It accepts only if STATUS=TXN_SUCCESS, MID matches, ORDERID = our payment id, amount (paise, parsed without floats) equals the frozen total, and the TXNID was never used before.
  - Each attempt is a `payments` row whose UUID is Paytm's ORDERID, with a 15-minute TTL. A pending attempt is reused.
  - **Late success** (Paytm confirms after the order expired) → the order still becomes paid (`expired → paid`, system-only, audited `payment_verified_late`).
  - **Money arriving for an order that can't take it** (paid twice, or reopened to draft) → the payment is flagged `needs_refund` and `orders.needs_attention='payment_needs_refund'`. The order itself is untouched.
  - **Reopen** (`awaiting_payment → draft`, so the customer can edit) is only allowed after the Status API confirms no attempt succeeded. If Paytm is unreachable it answers 503, never "probably fine".
  - **Reconciler** (every 20 s): re-checks payments pending for more than 20 s, expires attempts past their TTL, expires orders past `QP_ORDER_PAYMENT_WINDOW_MIN` (30), and follows up refunds.
  - **Token:** `daily_counters` row per IST date, starting at 101 (XR-101), assigned atomically at payment.
  - **PIN:** `randomPin(4)` at payment. The hash is in `recovery_pin_hash` (recovery + pickup check). An AES-256-GCM copy (`QP_DATA_KEY`) is in `pickup_pin_enc`, so the owner's order page can show it (`pickupPin` in `GET /api/orders/:id` while paid…ready).
  - **Refunds:** `payments.requestRefund({orderId, reason, adminId})` → `refund_pending` → `refunded` (or `print_attention` + `needs_attention='refund_failed'`). There's no route yet; the admin UI comes in phase 6.
  - **CSP** allows exactly `PAYTM_HOST` for script/frame/connect. `/api/payments/paytm/webhook` is exempt from the per-IP global rate limit.
  - The payment row stores `deep_link`. The iOS app links (GPay/PhonePe/Paytm/BHIM) are derived from it in `paytm/client.js appLinks()`.
- **Defaults chosen without user input (phase 5).** All are editable `settings` keys; the admin UI comes in phase 6:
  - `shop` = {name "Quick Print Xerox", address "", phone "", open 09:00, close 21:00}
  - `queue` = {ppmBw 20, ppmColor 10, setupSec 20, printers 1, manualDelayMin 3}
  - `print_mode` = "automatic", `paused` = false
  - Rate card (new price version, migration 005): B&W ₹3/page one side, ₹5/sheet both sides; colour ₹10/page, ₹18/sheet; A3 ×2; duplex per sheet.
- **Customer session lifetime = until delivery** (user clarification, 2026-11-06):
  - While the browser has an active order (awaiting payment → paid → printing → ready, or a refund in progress), the session **never expires**, however long pickup takes. The cookie is set for 400 days (the browser maximum), and the server decides validity.
  - When its last order is **handed over** (or refunded), `sessions.ended_at` is set (migration 007, `sessions.endIfDelivered` on every order event).
    - For 1 h the page still shows "Collected" and can take a rating.
    - After that the session stops resolving, and the next visit starts fresh.
  - Starting a new order within that hour keeps the session going.
  - Sessions with only a draft: sliding 30 days.
  - Another browser can still find an active order with token + PIN.
- **Retention & money checks (phase 8)**, defaults chosen without user input, editable in Settings → Customer Files (`settings.retention`):
  - **Files** (original + print PDF) are deleted **2 h after handover/refund**.
  - **Drafts:** untouched for **24 h** → cancelled (system, `abandoned`), then files go 1 h later.
  - **Expired/cancelled orders:** files go **1 h** later.
  - On deletion the stored file name becomes `deleted.<ext>` (names can be personal).
  - Orders, parts, payments, events and print jobs are **kept** for the accounts.
  - Paid orders that are not yet collected are **never** touched.
  - Raw Paytm payloads in `payment_events` are blanked after 90 days.
  - `jobs/retention.js` runs every 10 min (`app.locals.retention.runOnce()` in tests).
  - **Customers do not see past orders:** the session ends 1 h after delivery. The ticket shows "Start a new order".
  - **Reports:**
    - **Problems** (`GET /api/admin/reports/problems`, any admin): paid >2 h and not printed; ready >3 days and not collected; Needs attention; refund pending >24 h; extra payments.
    - **Reconciliation** inside the daily report: received vs billed (difference = extra money taken), paid / printed / collected / refunded orders, reprints, failed jobs.
    - **CSV** (`daily.csv`, owner, audited): cells starting with `= + - @` get a `'` prefix (spreadsheet formula injection).
  - **Extra payment refund:** `POST /api/admin/payments/:id/refund` (owner + password). Only `needs_refund` payments; one refund per payment. The order is untouched, and `needs_attention` is cleared when nothing more is owed.
  - **Password change:** `POST /api/admin/password {current, next}`, using the same rules as the CLI (`passwordProblem`: ≥12 characters, not containing the username, not trivial). Other sessions are logged out.
- **Print agent (phase 7)**, chosen defaults, changeable:
  - **Transport:** HTTPS only. The agent opens an outbound SSE stream (`GET /api/agent/events`, "work"/"revoked") and polls every 10 s. Heartbeats and results are plain POSTs. No WebSocket library.
  - **Runtime:** plain **Node 22 + WinSW service** (`C:\QuickPrint`), not a Node SEA single exe. That avoids a bundler and makes updates a file copy. SEA can come later.
  - **Auth:** `Authorization: Bearer <device secret>` (hash in `agents.secret_hash`).
    - The secret is obtained once with an 8-character pairing code (10 min, single use, owner only).
    - **Customer host only** (404 on the admin host).
    - Exempt from the global per-IP limit (the shop Wi-Fi shares an IP with customers); 600/min per agent instead.
    - Revoke ends it immediately (password required).
    - On Windows the secret is stored with **DPAPI LocalMachine** + an Administrators/SYSTEM-only ACL.
  - **Discovery:** `Get-CimInstance Win32_Printer`, giving status, `CapabilityDescriptions` (Color/Duplex) and `PrinterPaperNames`.
    - Virtual printers (PDF/XPS/OneNote/Fax) are ignored.
    - Reported every 15 s. Missing printers become offline.
    - **New printers are disabled until the owner switches them on** and chooses a role (any/bw/color) and ppm.
  - **Jobs:**
    - One job per document part. An order's jobs are a `batch` (2+ = reprint).
    - **Automatic + not paused:** jobs are created on payment, and swept on unpause, on a switch to automatic, on a printer change and on each agent heartbeat.
    - **Manual:** jobs are created by "Start printing".
    - **No enabled printer at all:** no jobs; the shop prints by hand as in phase 6.
    - **No enabled printer that can print the settings** (e.g. colour + both sides): the order goes to print_attention `no_printer`. `paid → print_attention` was added as a system transition for this.
  - **Lease:**
    - One job at a time per agent, for 2 min, extended by heartbeat `activeJobs` (15 min once spooled).
    - The download is **single use** (`X-Download-Token`), and the agent checks the SHA-256.
    - The first lease moves the order paid → printing. All jobs printed moves it printing → ready (system).
  - **Never prints twice by itself:**
    - A lease that expires **before** the download goes back to the queue (nothing could have printed).
    - A lease that expires **after** the download → `uncertain` → Needs attention.
    - Agent errors before spooling → `failed`; after spooling → `uncertain`.
    - Reprint only via "Print again" (new batch, audited `reprint`). Leftover files are deleted on agent start.
  - **Printing:** SumatraPDF `-print-to <printer> -print-settings "<ranges>,<simplex|duplexlong>,<color|monochrome>,<N>x,paper=<A4|A3>,fit" -silent -exit-on-print`. The Windows spooler is followed with `Get-PrintJob`, matching the document name `qp-<jobId>.pdf`.
  - **ETA:** when enabled + ready printers exist, the queue uses their count and average ppm instead of `settings.queue`.
- **Admin (phase 6):**
  - **No default admin, ever.** Accounts come from `npm run admin:create` (`--staff` for counter staff, `--reset` for a new password and code). The password is typed at a hidden prompt (never in argv), at least 12 characters, and must not contain the username.
  - Login needs **password (scrypt) + TOTP** (RFC 6238, `lib/totp.js`, ±1 step). Each code can be used only once (`admin_users.totp_last_step`).
  - **Lockout:** 5 failures lock the account for 15 min, plus 10 attempts per 15 min per IP. Unknown user, wrong password, wrong code and locked all get the same answer, with dummy-hash timing.
  - **Session:** cookie `__Host-qp_admin` (prod) / `qp_admin` (dev). HttpOnly, SameSite=**Strict**, 12 h absolute, 30 min idle. The DB stores only the token hash.
  - **CSRF:** the token is HMAC(`QP_DATA_KEY`, token hash). It is returned by login and `GET /api/admin/session`, and required as `X-CSRF-Token` on every write. The Origin must equal `QP_ADMIN_ORIGIN`.
  - **Host split** (`app.js`): `req.isAdminHost` = Host header equals the admin origin's host.
    - The admin host serves only `/api/admin/*` and `/api/health|ready`. Everything else on the API there is 404.
    - The customer host returns 404 for `/api/admin/*`.
    - Customer sessions are never loaded on the admin host.
    - The admin `/` serves `login.html` without a session and `owner.html` with one. `owner.html` typed directly also gives the login page.
    - Dev: `server.js` also listens on the admin origin's port (3001). Prod: Caddy sends both domains to one port with the Host header unchanged.
    - Admin responses carry `X-Robots-Tag: noindex`.
  - **Roles:**
    - `owner`: everything.
    - `staff`: orders, handover with PIN, pause and print mode only. No refunds, prices, settings or reports (403).
  - **Re-authentication with the password** is required for refunds, price changes and handover without a PIN (owner only, needs a reason).
  - **Handover** needs the customer's 4-digit PIN (`recovery_pin_hash`). 5 wrong tries lock it (`orders.handover_failures`). After that only the owner override works.
  - **Admin-settable statuses:** printing, ready, print_attention (`canTransition(...,'admin')`). Ready → printing is a "reprint". **Paid can never be set.**
  - **Every admin write** produces an `audit_logs` row (including the before/after of settings and prices). Order changes also add `order_events`.
  - **Dashboard** sees only orders with `paid_at` (drafts and unpaid orders never appear). The PIN is never sent to the dashboard.
  - **Admin SSE** `GET /api/admin/events` sends `order` (summary) and `counts`. It re-validates the session on every heartbeat.
  - **Settings changes** emit `bus 'queue'`, so customers' ETAs and pause state update live.
  - **PDF for the shop:**
    - `GET /api/admin/orders/:id/documents/:docId/pdf` is the viewer (`CSP: sandbox`).
    - `?download=1` returns an attachment so the shop PC can print until the agent exists. The download is audited.
  - **Frontend:**
    - `apps/admin`: `login.html`/`login.js`, `owner.html`, `owner.js`, `api.js` (`QA`), `dashboard.css` (moved out of inline), `style.css` (Google Fonts removed), `pdf-loader.js`, `vendor/` (same pinned pdf.js and qrcode as the customer site).
    - No `alert`/`confirm`/`prompt`: in-page dialog. The QR poster prints via a print stylesheet (no `window.open` with inline script).
    - The old `shared.js` demo, the client-side password "1234", "Mark as Paid", the Razorpay settings and the localStorage state are all removed.
  - **Dev fake Paytm:** `npm run dev:fakepay` (`scripts/dev-fake-paytm.js`, refuses `NODE_ENV=production`). It runs `test/paytmMock.js` on :3099 with an Approve/Fail page, and posts a signed webhook to the app on approval. Its UPI deep link uses a fake VPA (`fake.devmock@invalid`), so a real UPI app cannot pay it.
- **Test payment mode (2026-11-06):** `QP_PAYMENT_MODE=paytm|test`.
  - Default is `test` only when `NODE_ENV=development` and no Paytm keys are set. **Production refuses `test`** at start-up: the button would give anyone free orders.
  - `payments/testGateway.js` has the same methods as the Paytm client. `POST /api/orders/:id/test-payment {result}` exists only in this mode, is owner-only, sets the gateway's answer, then calls the normal `verify()` → `applyStatus()`. So token, PIN, queue, dashboard and refund all run the real code, and "only verification can mark paid" still holds. `payments.payment_mode` is `TEST`. Customer and dashboard show a "Test mode" banner.
  - **Test login:** `npm run dev:account` (`scripts/dev-test-account.js`, refuses production) creates `testowner`, writes `data/dev-login.json`, fills fake shop details and places 3 orders through the API. `GET /api/admin/dev-login` fills the login form from that file. It answers 204 unless test mode is on, not production, and the caller is on this computer. Its code is the next 30-second step's, because a code works only once.
- **Demo printer (test mode only):** `agent/demoPrinter.js` registers as a normal agent named "Demo printer" and uses the real `nextJob` / `download` / `result`, so an order goes paid → printing → ready through the real queue. Only the paper is pretend. It starts with the server in test mode. `GET/POST /api/admin/demo-printer` exist only in test mode. Switching off mid-job reports `failed`, so the order shows under Problems.
- **`npm run demo`** (`scripts/demo-show.js`, refuses production) plays upload → pay → print → handover in two windows with captions, on Microsoft Edge or `CHROME`.
- **Test owner password is `1234`** (`scripts/dev-test-account.js`, local test account only). Re-running the script resets it and logs that account out. The 12-character rule still applies to real accounts and the dashboard's Change password form. **Never use this account on a public link.**
- **Dashboard zoom:** A- / percent / A+ in the side menu, 60% to 200% in 10% steps, kept in `localStorage` (`qp_zoom`). The order table switches to cards with a rem-based container query, so it follows the zoom.
- **"Place a test order"** links to `/#new`, which opens the upload page even if this browser has an active order.
- **Dashboard simplified (2026-11-06):** base text 14 pt (`apps/admin/style.css`); cards are a word and a number; order rows are token + time, files, amount, status, action. Reports page removed from the UI, including the activity log and CSV button. Their API routes and tests remain. The extra-payment refund moved into the order details. The owner sees "Today: ₹ from N orders" under the title.
- **English / Hindi (2026-11-06):** `i18n-core.js` (identical in `apps/web` and `apps/admin`; a test checks this) + `i18n-hi.js` per site. **The English text is the key**; missing Hindi shows English.
  - Static pages are translated by walking the DOM. Code uses `t('...', vars)`. Fixed text in tables uses the no-op marker `N('...')`, so tests can find it. Server messages stay in English and go through `QPI18n.server()` (exact match, then `QP_HI_PATTERNS`); `ApiError` does this for all API errors.
  - The choice is kept in `localStorage` (`qp_lang`), a per-viewer convenience. Default follows the browser language.
  - **New text must be added to `i18n-hi.js`:** `improvements.test.js` fails otherwise. Don't name a local variable `t` in `customer.js` or `owner.js`.
- **Text size (2026-11-06):** root font is 17px (`html{font-size:106.25%}`) and no text is smaller than `.9rem`.
- **Word/PowerPoint (2026-11-06):** still LibreOffice: free, keeps layout best, and the customer previews the result before paying. No paid API.
  - Works on Windows too: `findSoffice` looks in Program Files for `soffice.com` at each job (no restart after installing), `taskkill /T` for timeouts, and the system variables LibreOffice needs. The server logs `office_converter_missing` at start-up if it can't be found.
  - One reused profile per conversion slot in `<data>/tmp/lo-profile-N` skips the first-run set-up on every file. It holds settings only. Deleted on timeout.
  - Timeout raised to 120 s. Concurrency stays 1 (fits 2 OCPU; raise `QP_OFFICE_CONCURRENCY` to 2 only if files queue up).
  - `.doc`/`.docx` and `.ppt`/`.pptx` that were renamed are accepted by their real content. `application/zip` and older Office MIME names are allowed as declared types, because phones send them.
- **Queue/ETA (phase 5):**
  - Queue = paid/printing/print_attention orders by `paid_at`.
  - Work = setup + sides/ppm, with colour using `ppmColor` and duplex ×1.1.
  - ETA uses list scheduling over `queue.printers` virtual printers. Phase 7 swaps in real printers.
  - `paused` → no ETA. `manual` → plus `manualDelayMin`.
  - Cached; invalidated on any order event or settings change, and refreshed at least every 30 s.
  - `orders.printing_at` (set by admin/agent) shortens the running job.
- **Live updates:**
  - In-process `EventEmitter` bus: `order` (orderId) and `document` (row).
  - SSE hub at `GET /api/me/events`: own session only, snapshot on connect, 25 s heartbeat, max 4 streams per browser (oldest dropped), 2000 total.
  - Shutdown ends the streams **before** `server.close()`, which otherwise waits forever.
  - The client falls back to polling every 15 s and re-checks on `visibilitychange`.
- **Customer page:**
  - Drafts are created lazily on the first upload. `GET /api/me/orders` returns `draftOrderId`, so an unfinished upload is restored after a reload.
  - Settings changes are debounced 400 ms, then `PUT …/parts`. Prices are displayed only from server responses.
  - Payment picker: Android shows one `upi://` link (the system app chooser); iOS shows GPay/PhonePe/Paytm/BHIM buttons; desktop shows a QR. Paytm JS Checkout ("Other ways to pay") is available on every device. In-app browsers get an "Open in Chrome/Safari" banner.
- **Vendored libraries:**
  - pdf.js **4.10.38 legacy** (patched for CVE-2024-4367), always opened with `isEvalSupported:false`.
  - qrcode-generator 1.4.4.
  - Integrity was verified against the npm registry, and files are pinned in `apps/web/vendor/SHA256SUMS` (a test checks them).
  - Removed from the old frontend: Google Fonts, jszip, docx-preview, html2canvas, pdf-lib CDN and `shared.js`.
- **CSP** allows the Paytm host for script/style/img/connect/frame/form-action, and nothing else external.
- **Testing note:** Playwright's `page.waitForFunction` evaluates a string in the page, which our CSP (correctly) blocks. The e2e script polls from Node instead. Don't "fix" this by adding `unsafe-eval`.
- **Checkout** (`draft → awaiting_payment`) freezes `pages/sides/sheets/rate_paise/amount_paise` on each part plus `orders.total_paise` and `price_table_id`. Quotes for non-draft orders are read from these frozen columns, never recomputed. Checkout is idempotent. Write routes re-check "still draft" **inside** their transaction.

---

## 3. Code map

```
apps/server/src/
  app.js                    createApp({config, db, logger, now}) — wiring only; mounts routers
  server.js                 boot, startup recovery (cleanTmp + queue.recover), session expiry job, graceful shutdown
  config/env.js             zod-validated env; production guards; parseTrustProxy
  db/index.js               openDatabase (WAL, FK on) + migration runner (NNN_name.sql, each in a tx)
  db/migrations/001_init.sql   full schema (settings, price_tables, sessions, orders, order_events, daily_counters,
                               documents, document_parts, payments, payment_events, refunds, agents, printers,
                               print_jobs, admin_users, admin_sessions, audit_logs)
  db/migrations/002_order_recovery.sql   orders.recovery_failures, recovery_locked_at
  db/migrations/003_pricing_defaults.sql price_tables.duplex_basis, document_parts.rate_paise,
                                         seed price table + settings.print_options
  db/migrations/004_payments.sql         orders.pickup_pin_enc, needs_attention; payments.deep_link, expires_at,
                                         status_checked_at, result_code/msg, needs_refund; refunds.order_id
  db/migrations/005_queue_shop.sql       orders.printing_at, rating, rated_at; settings shop/queue/print_mode/paused;
                                         default rate card as price version 2
  lib/crypto.js             randomToken, newId, randomPin, sha256, safeEqual, hashPassword/verifyPassword (scrypt)
  lib/errors.js             HttpError + helpers (badRequest, notFound, conflict, tooMany …)
  lib/logger.js             JSON-lines logger (never log tokens/PINs/file names)
  lib/token.js              formatToken ("XR-105"), parseToken, istDate (Asia/Kolkata)
  lib/secretBox.js          AES-256-GCM seal/open (pickup PIN)
  middleware/               requestId, securityHeaders (CSP, no-store on /api), originGuard, rateLimit
                            (fixed window, req.ip), validate (zod → req.valid[part]), errorHandler, customerSession
  modules/sessions/         service.js (create/resolve, sliding 30 d, never expires with active order), routes.js
  modules/orders/           recovery.js (token+PIN, lockout after 10),
                            routes.js (draft order, documents, parts, quote, checkout, public /pricing)
  modules/pricing/          ranges.js (parseRanges), service.js (priceDocument pure fn, rateFor, quote live/frozen,
                            checkout tx, setPriceTable, publicPricing)
  modules/settings/         service.js (JSON settings with defaults; printOptions()); key 'print_mode' read at payment
  modules/orders/ownership.js  createOwnedOrder(db) — shared 404 ownership check
  modules/payments/         paytm/checksum.js (Paytm algorithm), paytm/client.js (initiate, UPI intent, status, refund,
                            appLinks, paise<->amount), service.js (start, applyStatus, verify, handleNotification,
                            statusFor, reopen, reconcile, requestRefund, pinFor), routes.js
  jobs/paymentReconciler.js every 20 s payments.reconcile()
  modules/queue/service.js  workMinutes, schedule (pure), infoFor(orderId), estimate(), invalidate(), queuedOrderIds()
  modules/realtime/hub.js   SSE hub fed by the event bus (app.locals.bus); views = ordersRouter.views
  modules/shop/routes.js    GET /api/shop, GET /api/queue/estimate, GET /api/me/events
apps/web/                   index.html (no inline JS/CSS), page.css + style.css, customer.js (UI), api.js (client),
                            pdf-loader.js (ES module → window.pdfjsLib), vendor/{pdfjs,qrcode}, vendor/SHA256SUMS
apps/server/e2e/customer.e2e.js   real-browser flow (npm run e2e; one-time: npx playwright-core install chromium)
  modules/documents/        receive.js (busboy → disk), sniff.js (magic bytes, zip check, macros),
                            storage.js (tmp/orig/pdf, UUID keys), converters.js, convertWorker.js, queue.js (pool)
  jobs/sessionExpiry.js     hourly purge of expired sessions that never ordered
shared/constants.js         ORDER_STATUS, TRANSITIONS + canTransition(from,to,actor), ACTIVE/QUEUE statuses,
                            STATUS_LABEL, UPLOAD_TYPES, PAPER_SIZES
apps/web/api.js             browser client: ensureSession, myOrders, recoverOrder, restore, startOrder, getOrder,
                            uploadDocument (XHR progress), waitForDocument (polling), deleteDocument, ACCEPT,
                            getPricing, setParts, getQuote, checkout, money(paise),
                            startPayment, paymentStatus, reopenOrder, watchPayment (poll + focus/visibility re-check),
                            getShop, estimate, rateOrder, live (SSE + polling fallback); restore() → {orderId, draftOrderId}
apps/server/test/           helpers.js (startTestApp(env, {now}) → {base, config, db, app, close}),
                            fixtures.js (insertOrder, sessionCookie, api, makePdf, newCustomer, uploadFile, addPdf),
                            paytmMock.js (local fake Paytm: signed-request checks, setStatus, signed callback params),
                            *.test.js (foundation, http, sessions, documents, pricing, quote, payments, live)
  modules/admin/auth.js     createAdminAuth: createUser/resetUser (CLI), login (scrypt+TOTP+lockout), resolve (idle/absolute),
                            checkCsrf, confirmPassword, logout/logoutAll
  modules/admin/service.js  listOrders(view queue|today|history|attention, token search), counts, orderDetail, document,
                            setStatus, handover (PIN / owner override), dailyReport, auditLog, audit
  modules/admin/stream.js   admin SSE (order summaries + counts), session re-check per heartbeat
  modules/admin/routes.js   /api/admin/* (see API table); SETTING_SCHEMAS (zod per settings key)
  middleware/adminAuth.js   adminSession: cookie, load/required (CSRF + origin on writes)/owner, issue/clear
  lib/totp.js               base32, hotp, totp, verifyTotp (returns matched step), generateSecret, otpauthUri
  db/migrations/006_admin.sql  admin_users.totp_last_step, password_changed_at; orders.handover_failures; indexes
  jobs/retention.js         delete files of finished/abandoned orders, cancel stale drafts, blank old Paytm payloads
  modules/agent/service.js  pairing (createPairing/pair), authenticate, revoke, heartbeat (printer upsert), overview,
                            usablePrinters/enabledPrinters, updatePrinter, printerState
  modules/agent/dispatcher.js  startOrder (batch per order), sweepAutomatic, onOrder (bus), nextJob (lease + match),
                            download (single use), extend, result, watchdog (requeue untouched / uncertain), jobsFor
  modules/agent/routes.js   /api/agent/* (pair, heartbeat, events SSE, jobs/next, jobs/:id/pdf, jobs/:id/result)
  middleware/agentAuth.js   Bearer device secret
  db/migrations/007_session_end.sql  sessions.ended_at (session ends after delivery)
  db/migrations/008_print_agent.sql  agents.version/created_by; print_jobs.document_id/agent_id/leased_at/download_used_at/batch/position
apps/print-agent/           Windows agent (Node 22, no dependencies): src/main.js (loop, --pair), api.js (HTTPS + SSE),
                            discover.js (Win32_Printer), print.js (SumatraPDF args, spooler watch), config.js (config.json,
                            DPAPI secret); windows/install.ps1, QuickPrintAgent.xml (WinSW), README.md (shop install guide);
                            test/ (units + real agent vs real server with fakes/powershell.js, fakes/sumatra.js)
scripts/admin-create.js     (apps/server) create/reset admin; terminal QR for the authenticator app
scripts/dev-fake-paytm.js   (apps/server) dev only: shop + fake Paytm control page on :3099
apps/admin/                 login.html/js, owner.html, owner.js (Home/Reports/Settings, viewer, dialogs), api.js (QA),
                            dashboard.css, style.css, pdf-loader.js, vendor/
apps/server/e2e/admin.e2e.js  owner + customer in real Chromium (npm run e2e:admin)
legacy/                     old prototype backend + local frontend copy (reference only, not used)
```

### API implemented so far

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | /api/health, /api/ready | none | liveness / db+storage readiness |
| POST | /api/session | — | create or reuse anonymous session (cookie `__Host-qp_sid` in prod, `qp_sid` in dev) |
| GET | /api/session | session | |
| GET | /api/me/orders | session | this browser's non-draft orders + `activeOrderId` |
| POST | /api/orders/recover | — | `{token:"XR-105", pin:"1234"}`; limited per IP + per token; 404 no match, 423 locked |
| POST | /api/orders | session | create or return this browser's draft order |
| GET | /api/orders/:orderId | owner | order + documents |
| POST | /api/orders/:orderId/documents | owner, draft | multipart field `file`; 202, conversion runs in background |
| GET | /api/orders/:orderId/documents/:documentId | owner | status queued/converting/ready/failed, pageCount, error, queuePosition |
| DELETE | /api/orders/:orderId/documents/:documentId | owner, draft | removes row + files |
| GET | /api/orders/:orderId/documents/:documentId/preview | owner | PDF, `CSP: sandbox`, no-store |
| GET | /api/pricing | none | rates (paise), duplexBasis, a3Multiplier, options {maxCopies, paperSizes, allowRanges, maxPartsPerDocument} |
| PUT | /api/orders/:orderId/documents/:documentId/parts | owner, draft | `{copies, parts:[{pages, color, duplex, paper}]}` (strict: no prices/page counts); returns re-priced doc + total |
| GET | /api/orders/:orderId/quote | owner | live while draft, frozen after checkout; `ready`, `errors`, per-part errors |
| POST | /api/orders/:orderId/checkout | owner | freeze + `draft → awaiting_payment`; 409 `not_ready` with message; idempotent |
| POST | /api/orders/:orderId/payments | owner | start/resume Paytm attempt → txnToken, deepLink, appLinks, checkoutJsUrl; 503 if Paytm not configured |
| GET | /api/orders/:orderId/payment-status | owner | `{orderStatus, paid, payment}`; may trigger one Status API check (≤ every 10 s) |
| POST | /api/orders/:orderId/reopen | owner | `awaiting_payment → draft` after Paytm confirms unpaid; 409 if it was paid; 503 if unsure |
| POST | /api/payments/paytm/callback | Paytm checksum | form POST from the browser; verify → Status API → 303 to `/#order=<id>` |
| POST | /api/payments/paytm/webhook | Paytm checksum | S2S; verify → Status API; 400 on bad checksum |
| GET | /api/shop | none | name, address, phone, open, close |
| GET | /api/queue/estimate?bw=&color=&duplex= | none | ETA for a not-yet-placed order |
| GET | /api/me/events | session | SSE: `order` and `document` events for this browser only |
| POST | /api/orders/:orderId/rating | owner | `{stars:1..5}`, once, after payment |
| GET | / and static files | none | customer site from `apps/web` (`QP_SERVE_STATIC`, `QP_WEB_DIR`) |

**Admin API.** It exists only on the admin host. Every route except login needs the admin cookie, and every write needs `X-CSRF-Token`.

| Method | Path | Role | Notes |
|---|---|---|---|
| POST | /api/admin/login | — | `{username, password, otp}` → `{user, csrfToken}` + cookie; 401 identical for every failure |
| GET | /api/admin/session | any | user, csrfToken, expiresAt, publicOrigin, paymentsEnabled |
| POST | /api/admin/logout, /logout-all | any | |
| GET | /api/admin/orders?view=queue\|today\|history\|attention&date=&token= | any | summaries + counts |
| GET | /api/admin/orders/:id | any | parts, payments, refunds, events (no PIN) |
| GET | /api/admin/orders/:id/documents/:docId/pdf[?download=1] | any | sandboxed PDF / audited download |
| POST | /api/admin/orders/:id/status | any | `{to: printing\|ready\|print_attention, reason?}` |
| POST | /api/admin/orders/:id/handover | any / owner | `{pin}`; or `{password, reason}` (owner override); 400 wrong PIN, 423 locked |
| POST | /api/admin/orders/:id/refund | owner | `{reason, password}` → Paytm refund → refund_pending |
| GET | /api/admin/events | any | SSE: `order`, `counts` |
| GET | /api/admin/settings | any | shop, print_options, queue, print_mode, paused, prices, publicOrigin |
| PUT | /api/admin/settings/:key | owner (staff: print_mode, paused) | `{value}` validated per key |
| PUT | /api/admin/prices | owner | `{bw1Paise, bw2Paise, col1Paise, col2Paise, a3Multiplier, duplexBasis, password}` → new price version |
| GET | /api/admin/reports/daily?date= | owner | orders, received, refunded, net, printed sides, rating, flagged payments |
| GET | /api/admin/audit?limit=&before= | owner | activity log |
| GET | /api/admin/reports/problems | any | things to look at now (not printed, not collected, attention, slow refunds, extra payments) |
| GET | /api/admin/reports/daily.csv?date= | owner | one line per paid order; audited |
| POST | /api/admin/payments/:id/refund | owner | `{reason, password}`; flagged extra payment only |
| POST | /api/admin/password | any | `{current, next}`; logs out other devices |
| GET | /api/admin/printers | any | agents (online, version) + printers (status, caps, enabled, role, ppm) |
| POST | /api/admin/agents/pairing | owner | → `{code, expiresAt}` (10 min, single use) |
| POST | /api/admin/agents/:id/revoke | owner | `{password}`; ends its stream |
| PUT | /api/admin/printers/:id | owner | `{enabled, role, ppmBw, ppmColor, displayName?}` |

`GET /api/admin/orders/:id` also returns `printJobs` (batch, status, printer, error).

**Agent API.** Customer host only, `Authorization: Bearer <secret>` (except pair).

| Method | Path | Notes |
|---|---|---|
| POST | /api/agent/pair | `{code, name}` → `{agentId, secret}` (10 per 15 min per IP) |
| POST | /api/agent/heartbeat | `{printers:[{name, driver, status, color, duplex, paperSizes}], version, activeJobs}` |
| GET | /api/agent/events | SSE `work` / `revoked` |
| POST | /api/agent/jobs/next | `{job: {jobId, orderId, printer, settings{pages,color,duplex,copies,paper,sides}, pdfUrl, downloadToken, sha256}}` or `{job:null}` |
| GET | /api/agent/jobs/:id/pdf | header `X-Download-Token`; single use; 410 after |
| POST | /api/agent/jobs/:id/result | `{status: spooled\|printed\|failed\|uncertain, spoolerJobId?, error?}`; 409 if not leased to this agent |

`GET /api/orders/:orderId` now also returns `queue {position, ahead, etaMinutes, readyAt, paused, printMode}`, `rating` and `readyAt`. `GET /api/me/orders` returns `draftOrderId`.

Foreign or unknown ids always return **404** (no probing).

---

## 4. Conventions for new phases

1. **Vertical slice:** migration (if needed) → service → routes → wire in `app.js` → tests → `apps/web/api.js` client → update this file.
2. **Migrations:** add `apps/server/src/db/migrations/00N_name.sql`. Never edit an applied migration.
3. **Validation:** every route body/query goes through `validate(zodSchema)`. Handlers read `req.valid.*` only.
4. **Ownership:** customer routes use `session.required` + an owned-order check returning 404.
5. **State changes:** use `canTransition(from, to, actor)`. Write `order_events` (and `audit_logs` for admin/system) in the **same DB transaction**.
6. **Money:** integers in paise everywhere; format only in the UI.
7. **Rate limits:** `rateLimit({name, max, windowMs, keyFn})`. Remember to `.stop()` them in the router's `stop()`.
8. **Tests:** `node:test` + real HTTP via `startTestApp`. Add a security regression test for every rule. Tests must not need internet.
9. **Run:** `npm test` from the repo root. Dev server: `npm run dev` (port 3000, data in `./data`).
10. **Packages:** after any install, run `npm audit`. We upgraded zod (3→4) and sharp (0.34→0.35.5) for advisories.

---

## 5. Known gaps / caveats

- **LibreOffice:** real DOCX conversion checked on the Windows dev machine on 2026-11-06 (LibreOffice 26.8.2): direct converter run and an upload through the running server, including Hindi text. PPT/PPTX and real customer files are not tested yet. Measured on Windows: 730 MB installed, 218 MB peak memory per conversion, 6.7 to 14 s per small file (25 s for the very first). Re-measure on the Linux VM. Server install: `sudo apt install libreoffice-writer-nogui libreoffice-impress-nogui fonts-noto-core fonts-liberation2 fonts-crosextra-carlito fonts-crosextra-caladea`. The fonts matter: without Noto, Hindi Word files will not print correctly on Linux; Carlito/Caladea/Liberation match Calibri/Cambria/Times/Arial widths, so page counts stay close to Word's.
- **The HEIC conversion path is untested** (no sample file can be generated here). It needs one real iPhone `.heic` file.
- **Load test:** 100 parallel 5 MB uploads gave 100/100 success, 291 MB peak RSS, conversions done ~4 s after uploads. Upload p95 was ~19 s on this 2-CPU sandbox, where the clients shared the same CPUs. It must be re-measured on the OCI VM with remote clients (phase 9, target p95 < 3 s). Server CPU is ~100 ms per 5 MB upload.
- **The LibreOffice sandbox** (separate user, `systemd-run` with MemoryMax and no network) is deferred to phase 9 deployment. For now soffice runs with a stripped env, a temp profile and a hard timeout that kills the process group.
- **Prices and shop details are placeholders.** The owner now changes them in Admin → Settings: prices (password), shop, options, speeds.
- **Paytm integration is tested only against our mock.** Before go-live, with the staging MID:
  - Verify the **checksum port** against Paytm's (sign one request and confirm Paytm accepts it; verify one real callback). Ported from Paytm's official library from memory; no official test vector is in the repo.
  - Confirm the exact field names in the Status API v3 response (`txnAmount`, `txnId`, `mid`, `orderId`, `resultInfo.resultStatus`).
  - Confirm that UPI Intent (`processTransaction` with `UPI_INTENT`) is enabled on the MID.
  - Verify the **iOS app URL schemes** on real iPhones.
  - Configure the **webhook URL** in the Paytm dashboard.
- Status API **response signatures are not verified** (we rely on TLS to the configured `PAYTM_HOST`). Optionally verify `head.signature` against the raw response body later.
- **Orders flagged `needs_attention`** appear under "Needs attention" on the dashboard, and flagged payments in Reports.
  - **A payment that needs a refund but has no valid order state** (paid after reopen) can't be refunded from the UI yet: `requestRefund` works on orders in paid/print_attention.
  - This should be handled in phase 8 reconciliation (refund a single flagged payment by payment id).
- **Print agent: tested only with fake PowerShell/SumatraPDF on Linux.** On the real shop PC, check:
  - `Win32_Printer` capability detection for colour and duplex (some drivers don't report them). The owner can still pick the role by hand.
  - SumatraPDF `-print-settings` on each printer: ranges, duplexlong, monochrome, copies, A3.
  - That `Get-PrintJob` sees the job named `qp-<id>.pdf`.
  - Unplugging the printer mid-job → Needs attention, no reprint.
- **"Printed" means the Windows spooler finished**, not that paper physically came out. That's the best Windows reports.
- **The agent runs as LocalSystem** (WinSW default). Network printers that need a user login might not be visible to SYSTEM. If so, set a service account in `QuickPrintAgent.xml`; the DPAPI LocalMachine scope still works.
- **Admin idle timeout:** the open dashboard refreshes every 60 s, so it stays logged in while open (up to the 12 h absolute limit). A closed laptop logs out after 30 min.
- **A new authenticator code** (lost phone) still needs the server: `npm run admin:create -- --reset`. Password change is in the dashboard.
- **Staff accounts** are created with the CLI (`--staff`). There's no UI for adding users.
- In dev without `PAYTM_*`, payment routes answer 503 (expected).
- **Paytm JS Checkout ("Other ways to pay")** is wired, but its exact config shape and the styles/frames it injects can only be verified with real staging credentials. The CSP already allows the Paytm host.
- **The UI is checked on emulated devices** (Playwright Pixel 7 / iPhone 13 / desktop), not real phones. Real-device testing of UPI intents is still required (plan Part E).
- The customer page uses system fonts (Google Fonts removed for CSP/privacy). Self-host Inter later if desired.
- Phase 0 cleanup backup (old test DBs and uploads) is at `/tmp/claude-1000/-home-alikhan-quick-print--1-/e2994e7e-226d-42e5-9a05-c24cf7aef462/scratchpad/phase0-junk-backup.tgz`. This is a temp location and may be gone.

### Waiting on the user (external)
- [ ] Paytm PG merchant account: staging MID + key, with UPI Intent (incl. iOS) and JS Checkout enabled. **The code is ready; needed to verify against real Paytm (see gaps).**
- [ ] Domain name (HTTPS required for Paytm callbacks). **Needed for phases 4 and 9.**
- [ ] Oracle Cloud account + 2 OCPU / 12 GB Ampere VM. **Needed for phase 9.**
- [ ] Real shop prices, duplex basis, shop name/address/phone/hours and printer speed. **Reasonable defaults are in use (see §2).** The owner enters them in Admin → Settings.
- [ ] Windows shop PC + printers available for testing. **Needed for phase 7.**

---

## 6. Next phase — Phase 9: deployment on Oracle Cloud (plan C8, C9)

**Needs the user:** an OCI account with the Always Free Ampere VM (2 OCPU / 12 GB, Ubuntu 24.04 arm64), a **domain** with two names (e.g. `print.<domain>` and `admin.<domain>`) pointing to the VM, and Paytm **staging** credentials. Everything below can be prepared before then.

1. **`deploy/` folder:**
   - **Caddyfile:**
     - two sites, one upstream `127.0.0.1:3000`
     - automatic HTTPS, HSTS, `request_body max_size 26MB`
     - Host header passed unchanged; `X-Forwarded-For` set by Caddy only
     - static files may stay in Node (`QP_SERVE_STATIC=true`)
     - optional admin IP allow-list snippet
   - **systemd `quickprint.service`:**
     - user `quickprint`
     - `ProtectSystem=strict`, `ReadWritePaths=/var/lib/quickprint`, `NoNewPrivileges`, `PrivateTmp`
     - `MemoryMax=3G`, `EnvironmentFile=/etc/quickprint/env` (root:quickprint 0640)
     - `Restart=on-failure`
   - **LibreOffice:**
     - install `libreoffice-writer-nogui libreoffice-impress-nogui`, and HEIC support (libheif) if sharp needs it on arm64
     - run soffice as a separate low-privilege user via a small wrapper (`QP_SOFFICE_PATH`), with `systemd-run --scope -p MemoryMax=1G` and no network if feasible
   - **`setup.sh`** (idempotent):
     - packages, users, directories, firewall (ufw / iptables: 22 from your IP, 80/443)
     - unattended-upgrades, fail2ban, 4 GB swap
     - Node 22 from NodeSource, `npm ci --omit=dev`
     - generate `QP_DATA_KEY`
   - **`backup.sh`** + timer:
     - nightly `sqlite3 .backup`, encrypted with age/gpg (key not on the VM), uploaded to OCI Object Storage, 14-day retention
     - **restore guide**
   - **`oci-network.md`:** VCN security list (80/443 only; SSH from your IP or OCI Bastion), and upgrading to Pay-As-You-Go to avoid idle reclamation.
2. **Health & monitoring:**
   - `/api/ready` is checked by an external free uptime monitor.
   - Logs in journald (JSON lines). Optional: daily email of the Problems list.
3. **Load test:** a script (k6 or autocannon) with 100 concurrent 5 MB uploads plus checkout against the VM from outside. Targets: p95 upload acknowledgement < 3 s, no 5xx, stable RSS. Record the results here.
4. **Security pass:**
   - run `/security-review`
   - re-check headers with securityheaders.com and the TLS rating
   - try the admin host from the customer domain, CSRF, rate limits through Caddy (real client IP), and the agent from outside
5. **Go-live checklist:**
   - **Paytm:** staging → live (`PAYTM_WEBSITE=DEFAULT`, `PAYTM_HOST=https://securegw.paytm.in`), configure the webhook URL in the Paytm dashboard, then a real ₹1 order on Android + iPhone
   - **Shop setup:** create the owner with `admin:create`; real prices and shop details in Settings; install the print agent on the shop PC; print the QR poster

---

## 7. After Phase 9
- After go-live: watch the Problems list daily for the first week. Re-measure the load on the real VM. Collect real prices and the duplex basis from the owner.
