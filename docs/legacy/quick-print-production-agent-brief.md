# Quick Print --- Production Readiness Implementation Brief

**Purpose:** Give this document to the coding agent working on the
existing Quick Print project. The goal is to turn the current project
into a reliable production application while preserving its existing
technology stack and useful existing UI.

**Project archive reviewed:** `quick-print.zip`

------------------------------------------------------------------------

## 1. Instructions to the coding agent

You are the implementation agent for this existing Quick Print
application.

Your job is to make the existing application production-ready against
the requirements in this document. Work in the existing repository. Do
not replace the project with a new application and do not change the
technology stack without explicit approval.

### Non-negotiable rules

1.  **Keep the existing technology stack.** Retain the current frontend
    approach, Node.js, Express, SQLite and the existing printer-agent
    approach unless the repository itself proves a specific component is
    unusable. Do not migrate to Java, Spring Boot, PostgreSQL, React,
    Redis, another framework, or another database just because you
    prefer it.
2.  **Inspect before editing.** Read the repository, identify the actual
    entry points, routes, database schema, frontend pages/scripts,
    tests, configuration and deployment setup. Confirm each finding in
    the current source before changing it. The audit below is a starting
    point, not permission to assume every line is still unchanged.
3.  **Do not rewrite the application blindly.** Preserve working
    behaviour and existing design unless a change is required by the
    requirements or a confirmed defect.
4.  **Build vertically, feature by feature.** Complete one feature
    across the entire application: user interface, frontend logic, API,
    backend rules, database/storage, error handling, and automated
    tests. Do not build all frontend screens first and leave backend
    integration for later.
5.  **Test each vertical feature before moving on.** Run relevant unit,
    integration and end-to-end tests. Fix the implementation, not the
    tests, when a real requirement fails.
6.  **Never weaken tests to make them pass.** Do not delete tests, skip
    tests, reduce assertions, remove edge cases, loosen validation, mock
    away the behaviour under test, or change expected results merely to
    get a green test run. If a test is genuinely incorrect or obsolete,
    explain why and ask for approval before changing it. Add regression
    tests for every confirmed bug.
7.  **Do not claim a feature is complete because its UI works.** A
    feature is complete only when its real backend behaviour,
    persistence, security checks, failure cases and tests work together.
8.  **Ask before important decisions.** Before choosing behaviour that
    is not specified, affects money, privacy, data retention, customer
    experience, printer behaviour, security, deployment cost or
    irreversible data changes, stop and ask the project owner. Ask one
    focused set of questions for that feature and explain the options in
    simple language, their consequences, and your recommendation. Do not
    silently guess.
9.  **Explain technical terms in plain language.** The project owner is
    still learning software engineering. Use simple explanations,
    concrete examples and short definitions. Do not hide important
    decisions behind jargon.
10. **Keep documentation current.** Update relevant README/setup
    instructions, environment-variable examples, API documentation,
    database notes and operational instructions as features change.
11. **Do not expose secrets.** Never commit real credentials, payment
    keys, session tokens, private URLs or customer documents. Use
    environment variables and safe example values.
12. **Do not deploy or run destructive production operations without
    explicit approval.**

### Required workflow for every feature

For each feature, follow this sequence:

1.  **Inspect:** Identify the relevant existing code and how the current
    implementation works.
2.  **Explain:** State what is currently implemented, what is missing or
    broken, and what will change.
3.  **Clarify:** Ask the owner about any important unspecified decision.
    Wait for the answer before implementing that decision.
4.  **Plan:** List the exact files/components likely to change, database
    changes, API changes, risks and tests.
5.  **Implement one vertical slice:** Finish the complete feature from
    user action through backend and persistence to the resulting UI.
6.  **Test:** Add or update meaningful tests without weakening existing
    coverage. Run the relevant test suites.
7.  **Review:** Check security, failure cases, data consistency, logs
    and backward compatibility.
8.  **Report:** Summarise what changed, tests actually run and
    passed/failed, decisions still needed, and the next feature. Do not
    say "all tests pass" unless they were actually run.

Do not start the next feature until the current feature's acceptance
criteria and tests pass, unless the owner explicitly approves a
dependency-driven exception.

------------------------------------------------------------------------

## 2. Product goal and expected customer journey

Quick Print is a walk-in print-shop ordering application. Customers
should not need to create an account or log in.

### Customer journey

1.  A customer opens the website.
2.  The server creates an anonymous customer session, or restores the
    customer's existing session.
3.  The customer uploads one or more documents.
4.  The application validates each document and determines its real
    printable page count.
5.  For each document, the customer chooses either:
    -   Print all pages; or
    -   Print selected/custom pages, such as `1-2,5,8-10`.
6.  The customer chooses:
    -   Black & white or colour;
    -   Single-sided or double-sided;
    -   Number of copies, if supported by the shop's confirmed pricing
        rules.
7.  Double-sided must be unavailable when only one page is selected.
8.  The customer can add another document. Each document keeps its own
    settings.
9.  The server calculates the authoritative price. The customer sees the
    quote and pays.
10. The server verifies the payment with the payment provider. A browser
    message alone must never count as proof of payment.
11. Once payment is verified, the order receives a customer-facing UID
    such as `XR-1001` and enters the print queue.
12. The customer sees an estimated waiting time based on the real queue
    and printer state.
13. The shopkeeper sees the order in the dashboard, identified by its
    UID.
14. The printer agent processes the print job and reports
    progress/failure.
15. The shopkeeper marks the order ready and then confirms **Handed
    Over** when the printed documents are physically given to the
    customer.
16. The relevant anonymous session is closed according to the agreed
    lifecycle. Temporary customer files are deleted according to the
    approved retention policy.

### Important distinction

A **session**, a **cart**, an **order**, a **payment**, and a **print
job** are different things:

-   **Session:** Identifies the anonymous browser/customer visit without
    requiring login.
-   **Cart:** Documents and print settings not yet submitted as a final
    order.
-   **Order:** The submitted purchase, which can contain multiple
    documents.
-   **Payment:** The payment attempt and its verified result.
-   **Print job:** Work sent to a printer. One order may require one or
    more print jobs.

Do not treat these as one database record or one status field.

------------------------------------------------------------------------

## 3. Existing project audit --- verify before changing

The previous review of `quick-print.zip` found the following. Re-open
the current source and confirm each item before implementation. If the
code has changed, update this document's findings in the project
documentation rather than blindly applying an old observation.

### 3.1 Frontend/backend integration

-   The customer UI and shopkeeper UI appear to use browser
    `localStorage`/`sessionStorage` for demo state.
-   The backend has session, order, payment and printer-related routes,
    but the full customer and shopkeeper journey is not connected end to
    end.
-   Replace demo-only state with real API calls and server-persisted
    data.
-   Browser storage may be used only for non-sensitive presentation
    preferences or as a temporary aid. It must not be the source of
    truth for orders, payment, queue or printer state.

### 3.2 Document upload and processing

-   The customer upload UI was observed to accept PDF only.
-   The backend appeared to recognise a wider list of extensions, but
    extension/MIME acceptance is not the same as being able to safely
    convert and print a document.
-   Required customer formats: PDF, JPG, JPEG, PNG, PPT, PPTX, DOC and
    DOCX.
-   Build a complete validation and conversion path for every supported
    format.
-   Convert accepted documents to a consistent print-ready PDF
    representation before page selection/printing, where technically
    appropriate.
-   Confirm conversion tools, fonts, resource limits and deployment
    requirements before selecting/installing dependencies.

### 3.3 Cart and print settings

-   The frontend appeared to support all-pages/custom-page selection and
    multiple print-setting segments.
-   The backend order model appeared too limited to persist multiple
    documents with independent page selections and print settings.
-   Implement a proper cart/document/order structure. Do not flatten
    different documents or setting segments into one ambiguous field.
-   Validate all page ranges on the server using the converted
    document's actual page count.

### 3.4 Pricing

-   The previous review found that the frontend supplied a total amount
    and the backend did not independently derive the full amount from
    trusted document and print configuration.
-   The backend must calculate the quote using server-owned pricing
    rules.
-   Never trust a price, page count, sheet count, discount or payment
    amount supplied by the browser.
-   Store money as integer minor units (for INR, paise) or use a safe
    decimal representation. Do not use floating-point arithmetic for
    money.
-   Ask the owner to confirm the actual price list and pricing rules
    before implementing them. Do not invent rates.

### 3.5 Payment

-   The previous review found a demo payment flow that could accept a
    client-supplied success status.
-   Keep demo payment isolated to a clearly identified development/test
    mode.
-   Production payment success must be established by a verified
    provider response/webhook, not by a customer request or a success
    screen.
-   Validate provider signature, order reference, amount, currency and
    payment reference.
-   Make webhook handling idempotent: the same event delivered more than
    once must not create duplicate paid transitions or print jobs.
-   Ask the owner to confirm the provider, merchant-account status,
    supported payment flow, test credentials and production credentials
    process before real integration.

### 3.6 Sessions and customer access

-   The previous review found session creation/current-session routes
    and an HTTP-only cookie approach, but the frontend did not appear to
    use the complete flow.
-   The previous review also found a session lookup route that may
    expose session tokens. Confirm and remove/protect any
    token-disclosure route.
-   The customer should not need an account.
-   A session credential must be high-entropy, secret and stored safely.
    Do not use the public UID as a credential.
-   Prefer storing only a hash of a bearer session token server-side
    where practical.
-   Use secure cookie settings in production: HTTPS, `HttpOnly`, an
    appropriate `SameSite` policy and `Secure`.
-   Configure cookie domain/path and cross-origin behaviour
    deliberately. Do not weaken browser security just to make local
    development work.
-   Restore the same cart after closing/reopening the tab or browser,
    provided the browser still has the session cookie and the session
    remains valid.
-   Define what happens if the customer clears cookies, uses private
    browsing, changes device or has multiple tabs open. Ask the owner if
    the desired behaviour is unclear.

### 3.7 UID

-   The previous review found a generated reference format different
    from the requested `XR-1001` style.
-   Implement a server-generated, unique, customer-facing UID in the
    agreed format.
-   Keep an internal random/UUID database identifier separate from the
    public UID.
-   Do not use the public UID to authorize access.
-   Do not generate IDs in the browser.
-   Use a concurrency-safe database sequence/counter or equivalent
    transaction-safe mechanism. Concurrent orders must not receive the
    same UID.
-   Ask the owner whether IDs should be globally increasing forever or
    reset with a date prefix. Recommended default: never reuse an ID.

### 3.8 Queue and waiting time

-   The previous review found queue/ETA calculations in browser-side
    demo logic rather than a server-authoritative queue.
-   Move queue state and ETA calculation to the backend.
-   The estimate must use real pending work, print settings, copies,
    printer availability and known printer speed where available.
-   Show an estimate/range, not a guaranteed completion time.
-   Recalculate when queue position, printer state, job progress or
    failures change.
-   Ask the owner how many printers exist, whether they can print
    simultaneously, and how the shop handles manual priority/urgent
    orders.

### 3.9 Shopkeeper dashboard and authorization

-   The previous review found a dashboard relying on browser storage and
    frontend-only password/session protection.
-   Frontend-only protection is not security. Every administrative API
    must enforce authentication and authorization on the server.
-   Remove any public/customer ability to set an order to paid, ready,
    printed or handed over.
-   Define roles only if needed; do not add complex role systems without
    approval.
-   Protect dashboard routes, order actions, pricing changes, printer
    controls and operational endpoints.
-   Record who performed important administrative actions and when.

### 3.10 Printer agent

-   The previous review found printer registration/job-related API
    scaffolding, but not a complete authenticated print-execution
    lifecycle.
-   The printer agent must authenticate to the backend.
-   It must poll/request work or receive work through an approved secure
    mechanism.
-   It must acknowledge a job, download the correct print-ready file,
    execute the print, and report progress, success or failure.
-   Add heartbeat/health reporting so the dashboard can show whether the
    agent is online.
-   Prevent two agents from accidentally processing the same job.
-   Use job leases/locking and idempotent state transitions.
-   Handle a computer restart, printer offline state, paper-out/error
    state, agent crash and network loss.
-   Do not automatically reprint a job if the system cannot determine
    whether the printer already printed it. That can create duplicate
    physical copies. Ask the owner how uncertain print outcomes should
    be handled; the safe default is to stop and request shopkeeper
    review.

### 3.11 Database persistence and schema management

-   The previous review found a default SQLite database filename that
    included the current time/random value. If still present, this can
    cause the app to use a new database file after restart.
-   Use one stable, explicitly configured database path for persistent
    environments.
-   Keep SQLite as the database. Do not migrate to PostgreSQL without
    approval.
-   Add a proper schema migration mechanism compatible with the existing
    stack, or improve the existing one if already present.
-   Back up the database and test restoring it.
-   Use transactions for operations that must succeed or fail together,
    especially order creation, payment confirmation, UID allocation and
    job creation.
-   Do not store database files in ephemeral deployment storage unless
    persistence is guaranteed.

### 3.12 File storage and cleanup

-   Confirm whether uploads are stored locally or in another storage
    service. Keep the current approach if it can meet the requirements
    safely and reliably.
-   Use generated storage names, not user-supplied paths.
-   Keep original filename only as display metadata after sanitisation.
-   Store files outside the public web root.
-   Enforce upload size, count, type, signature and processing limits.
-   Protect download routes with ownership/authorization checks and
    short-lived access where appropriate.
-   Delete both original and converted files, temporary conversion
    files, extracted page files and printer-agent temporary copies
    according to the approved retention policy.
-   Cleanup must be retryable and observable. A failed file deletion
    must not be silently treated as success.

### 3.13 Security and operational gaps to verify

Inspect and address, as applicable:

-   Customer ownership checks on every customer API.
-   Admin authentication and authorization.
-   Printer-agent authentication.
-   Upload path traversal and malicious file risks.
-   File signature validation, not only extension/MIME checks.
-   Rate limiting and abuse protection.
-   Request body size limits.
-   CORS and cookie configuration.
-   CSRF protection where relevant to cookie-authenticated
    state-changing routes.
-   SQL injection protection through parameterised queries.
-   Safe error messages that do not expose stack traces, tokens or
    filesystem paths.
-   Structured logs without passwords, session tokens, payment secrets
    or document contents.
-   Health/readiness checks.
-   Production environment validation at startup.
-   Dependency vulnerability review.
-   Backup and restore procedure.
-   Monitoring and alerting for payment, conversion, printer and cleanup
    failures.

------------------------------------------------------------------------

## 4. Required business rules

Implement these rules consistently in both frontend behaviour and
backend validation. The backend is authoritative.

### 4.1 Supported file types

The customer may upload:

-   `.pdf`
-   `.jpg`
-   `.jpeg`
-   `.png`
-   `.ppt`
-   `.pptx`
-   `.doc`
-   `.docx`

For each file:

1.  Check extension and claimed MIME type.
2.  Check the actual file signature/content where possible.
3.  Reject corrupt, encrypted or unsupported files with a clear message.
4.  Apply configured file-size and total-cart limits.
5.  Scan or safely process files according to the approved security
    approach.
6.  Convert to the print-ready representation.
7.  Determine actual page count after conversion.
8.  Show processing errors without losing other valid cart items.

**Decision required from owner:** Maximum size per file, maximum number
of files, maximum total cart size, whether password-protected PDFs are
rejected, and what to do with files that cannot be converted.

### 4.2 All pages and custom pages

-   "All pages" selects every page in that document.
-   "Custom pages" accepts page numbers and ranges, for example
    `1-2,5,8-10`.
-   Validate syntax, bounds and duplicates.
-   Reject page zero, negative pages, pages beyond the document count,
    malformed ranges and empty selection.
-   Decide whether overlapping ranges such as `1-3,3-5` are rejected or
    normalised. Ask the owner; recommended behaviour is normalise to
    unique pages and show the final selection.
-   Keep page selections separate for every document.

### 4.3 Colour and sides

-   Each document/print segment has a colour choice: B&W or colour.
-   Each document/print segment has a side choice: single-sided or
    double-sided.
-   If the selected page count is one, disable double-sided in the UI
    and reject it on the backend.
-   If multiple page ranges have different settings, preserve them as
    separate print segments.
-   Confirm paper size, orientation, scaling/fit-to-page, margins and
    whether mixed paper sizes are supported before adding these options.

### 4.4 Copies and physical sheets

-   Confirm whether the application supports copies and the allowed
    range.
-   Calculate physical sheets correctly for each print segment and copy
    count.
-   For a simple segment with `P` selected pages: single-sided sheets =
    `P`; double-sided sheets = ceiling(`P / 2`). Confirm any special
    handling for mixed segments, blank backs, separators, booklet mode
    or printer-specific constraints before implementation.
-   Do not assume a page equals a sheet in double-sided printing.

### 4.5 Cart

-   One cart can contain multiple documents.
-   Every cart item retains its own page selection, colour, sides and
    copies.
-   Customer can remove a document or edit its settings before checkout.
-   Recalculate the quote whenever any relevant setting changes.
-   A cart must be associated with the anonymous session on the server.
-   Do not trust a cart ID alone; verify session ownership.

### 4.6 Payment and order creation

-   The backend calculates and stores a price quote.
-   The quote must be tied to the exact cart configuration and pricing
    version.
-   If cart settings change, the old quote must no longer be payable.
-   A payment success must be verified server-side.
-   Only verified payment can move an order into the paid/print-queue
    state.
-   Handle pending, failed, cancelled, expired, refunded and duplicate
    payment events explicitly where supported.
-   Never create a second print job because a webhook was retried.

### 4.7 UID and order identification

-   Generate UID on the backend.
-   Format: `XR-1001`, `XR-1002`, and so on, subject to the owner's
    decision on reset policy.
-   UID is for human identification only.
-   Customer access is controlled by the anonymous session credential.
-   Shopkeeper access is controlled by authenticated admin access.

### 4.8 Queue and ETA

-   Queue order and job status live on the backend.
-   The customer can see their own order status and estimate.
-   The shopkeeper can see the full queue.
-   Do not expose other customers' documents or private order details to
    a customer.
-   ETA must be recalculated as real conditions change.
-   If printer status is unknown/offline, communicate that the estimate
    is unavailable or delayed rather than inventing a precise time.

### 4.9 Handover and session closure

-   "Ready" and "Handed Over" are different states.
-   Only an authorised shopkeeper can confirm handover.
-   Handover must be recorded with timestamp and actor.
-   If a session has multiple orders, do not close the session while
    another associated order is still active unless the owner explicitly
    chooses a different rule.
-   Closing a session must not accidentally erase a paid order that has
    not been handed over.

### 4.10 Seven-day expiry and deletion

The requested rule is that abandoned session/customer data should be
removed after seven days. Define precisely what "seven days" means:

-   Seven days after last activity, or
-   Seven days after session creation.

Recommended starting point: seven days after last meaningful activity
for an unpaid/abandoned session.

Do not automatically delete a paid, queued, printing or ready order
before handover. Ask the owner to approve the retention policy for
completed order metadata and any payment/accounting records that must be
retained.

The cleanup process must: 1. Find eligible expired
sessions/carts/orders. 2. Confirm no paid active order is being deleted.
3. Delete original uploads. 4. Delete converted PDFs and temporary
files. 5. Delete or expire printer-agent copies where reachable. 6.
Delete associated database records in a safe order. 7. Record successes
and failures. 8. Retry failures safely. 9. Be tested with an accelerated
test clock or test timestamps; do not wait seven real days in tests.

------------------------------------------------------------------------

## 5. Recommended vertical implementation order

Work in the order below. Each phase must be a complete end-to-end
feature, not a frontend-only task.

### Phase 0 --- Repository discovery and baseline

**Do first; do not change business behaviour yet.**

-   Inspect all folders and source files.
-   Identify the actual frontend entry point, backend entry point,
    routes, database, tests and printer-agent code.
-   Map every UI action to its current API or local-storage operation.
-   Run the existing test suite exactly as it is.
-   Record test count and failures.
-   Start the app locally and record the current working flows.
-   Identify environment variables and deployment assumptions.
-   Create/update a technical audit document with confirmed facts, not
    guesses.

**Deliverable:** `docs/production-audit.md` or an equivalent project
document.

**Acceptance:** Owner can understand the current state and the proposed
implementation sequence. No tests have been weakened.

### Phase 1 --- Persistent database and data model

Complete database persistence before building dependent flows.

-   Fix unstable/default database path behaviour.
-   Keep SQLite.
-   Add migrations for schema changes.
-   Model sessions, carts, cart items/documents, orders, order
    documents, print segments, payments, print jobs, printers and audit
    events as appropriate.
-   Add foreign keys, unique constraints, indexes and safe deletion
    rules.
-   Add transactions for multi-step state changes.
-   Add backup/restore instructions.

**End-to-end test:** Create data, restart the server, and prove the same
data remains available. Test migration from the existing database
without losing existing data.

**Ask before implementation:** Confirm whether existing demo data must
be retained, exported or discarded.

### Phase 2 --- Anonymous session and cart persistence

Complete this feature from website open through server persistence and
browser restoration.

-   Create or restore anonymous session through backend.
-   Use a secure HTTP-only cookie in production.
-   Store a hash of the session token if applicable.
-   Restore cart after tab/browser closure and reopening.
-   Verify session ownership on every customer endpoint.
-   Prevent session token disclosure.
-   Implement inactivity tracking and expiry rules.
-   Handle multiple tabs and concurrent updates safely.

**End-to-end tests:** - New browser creates a session. - Refresh retains
session. - Close and reopen browser retains session when cookie
remains. - Another browser cannot read the cart. - Expired session
cannot access old cart. - Server restart does not lose session/cart. -
Clearing cookies behaves according to the agreed policy.

**Ask before implementation:** Confirm cookie lifetime, inactivity
definition, private browsing/device-change behaviour and whether
multiple active carts per session are allowed.

### Phase 3 --- Upload and document conversion

Complete upload through validation, storage, conversion, page count and
UI preview.

-   Add all eight requested formats.
-   Validate actual content, not only file extension.
-   Add file-size and cart limits.
-   Use safe generated storage keys.
-   Keep files private.
-   Convert Office files to PDF with a controlled conversion service.
-   Process images into printable PDF pages using agreed page
    sizing/orientation.
-   Determine actual page count.
-   Handle corrupt, encrypted, unsupported and conversion-timeout cases.
-   Clean up partial files when processing fails.
-   Show per-file processing status and useful error messages.

**End-to-end tests:** One valid file of each supported format; renamed
executable or invalid file; corrupt file; zero-byte file; oversized
file; conversion timeout; missing font; multiple uploads; duplicate
filename; failed upload cleanup; server restart during/after upload.

**Ask before implementation:** Maximum sizes/counts, PDF encryption
policy, image page sizing (A4 or another size), image orientation/fit
rules, Office conversion rules and acceptable conversion time.

### Phase 4 --- Per-document print configuration

Complete the customer UI and backend validation for each uploaded
document.

-   All pages/custom pages.
-   Parse and validate page ranges.
-   B&W/colour.
-   Single/double-sided.
-   Disable double-sided for one selected page.
-   Copies if approved.
-   Preserve independent settings for each document.
-   Revalidate all settings on the backend.
-   Show clear validation errors next to the relevant document.

**End-to-end tests:** All pages; one page; custom ranges; first/last
page; invalid syntax; out-of-range page; duplicate/overlapping range;
one selected page with duplex request; multiple documents with different
settings; edit settings after upload.

**Ask before implementation:** Range normalisation rules, copies limits,
paper size, orientation, fit/scaling and whether different segments of
one document may use different settings.

### Phase 5 --- Cart and authoritative quote

Complete adding/editing/removing documents through a backend-calculated
quote.

-   Persist cart items and their print settings.
-   Add/remove/update documents.
-   Calculate page count, sheets, copies and price on the server.
-   Return a quote breakdown the frontend can display.
-   Version or expire quotes when cart/pricing changes.
-   Store prices in safe monetary units.
-   Never accept browser total as authoritative.

**End-to-end tests:** Add multiple files; edit one without changing
another; remove an item; change pages/colour/sides/copies; verify
totals; tamper with browser price; submit stale quote; concurrent cart
updates.

**Ask before implementation:** Exact price list, per-page/per-sheet
rates, colour pricing, duplex pricing, copy pricing, minimum charge,
discounts, tax treatment, rounding and whether pricing varies by paper
size or document type.

### Phase 6 --- Payment

Complete quote checkout, payment provider interaction, verification and
paid-order creation.

-   Keep demo payment only in development/test mode.
-   Implement the selected real provider only after the owner confirms
    account and integration details.
-   Create payment from backend quote.
-   Verify provider webhook/signature.
-   Verify amount, currency, provider order reference and payment
    reference.
-   Make webhook handling idempotent.
-   Use safe payment/order state transitions.
-   Do not expose secrets in frontend.
-   Add reconciliation/logging for payments whose final result is
    uncertain.

**End-to-end tests:** Successful payment; failed payment; cancelled
payment; pending payment; invalid signature; wrong amount; wrong
currency; unknown order; duplicate webhook; delayed webhook; webhook
before browser return; browser return without webhook; backend restart
during payment.

**Ask before implementation:** Payment provider, merchant account
availability, UPI intent/QR/other methods, refund/cancellation policy,
webhook configuration and test credentials. Never ask the owner to paste
live secret keys into source code or chat.

### Phase 7 --- UID, order lifecycle and customer status

Complete verified payment through UID creation and customer-visible
status.

-   Generate unique `XR-...` UID on backend.
-   Keep internal ID separate.
-   Make generation concurrency-safe.
-   Define legal order state transitions.
-   Customer can see only their own order.
-   Customer cannot mark paid, printing, ready or handed over.
-   Record state-change timestamps.

**End-to-end tests:** Concurrent paid orders; UID uniqueness; customer A
attempts to read customer B's order; customer attempts forbidden status
update; invalid transition; repeated request; order reload after browser
restart.

**Ask before implementation:** UID reset policy and exact
statuses/labels shown to customers.

### Phase 8 --- Queue and waiting-time estimate

Complete paid order through queue position and ETA.

-   Persist queue in backend.
-   Use real print-job workload and printer availability.
-   Support printer offline/paused/error states.
-   Update customer and dashboard when queue changes.
-   Prevent queue position from being calculated independently in each
    browser.
-   Show uncertainty honestly.

**End-to-end tests:** Empty queue; one job; multiple jobs; two printers
if supported; printer goes offline; job fails; job pauses; job
completes; queue order changes; server restart.

**Ask before implementation:** Number/model of printers, whether they
operate simultaneously, print speed, manual priority rules, shop opening
hours and whether the estimate should show minutes or a time range.

### Phase 9 --- Secure shopkeeper dashboard

Complete authenticated shopkeeper login through every administrative
action.

-   Add server-side authentication.
-   Protect every admin API.
-   Protect dashboard pages as appropriate.
-   Fetch orders/queue from backend.
-   Show UID, documents, print settings, payment status and job status.
-   Add authorised actions for cancellation, ready and handover as
    approved.
-   Record admin actions.
-   Avoid exposing document download links to unauthorised users.

**End-to-end tests:** Unauthenticated request; invalid credentials;
expired admin session; customer calling admin API; authorised order
view; unauthorised order update; handover of wrong state; concurrent
shopkeeper actions.

**Ask before implementation:** Number of shopkeeper/admin users, login
method, password reset, roles and whether multiple shopkeepers can work
at the same time.

### Phase 10 --- Printer agent and actual printing

Complete paid queue item through physical printer execution and
confirmed result.

-   Authenticate printer agent.
-   Register/identify approved printer.
-   Heartbeat and online/offline state.
-   Securely claim a job.
-   Use a lease/lock to prevent duplicate assignment.
-   Download the exact print-ready file through authorised access.
-   Apply selected pages, copies, colour and sides correctly.
-   Report accepted, printing, completed or failed.
-   Handle agent/printer/network restart.
-   Prevent unsafe automatic duplicate printing after an uncertain
    result.
-   Show errors for shopkeeper intervention.

**End-to-end tests:** Agent online/offline; invalid agent credential;
two agents claim concurrently; printer unavailable; file download fails;
print command fails; agent crashes before print; agent crashes during
print; network drops after print; duplicate completion report; uncertain
print result; manual recovery.

**Ask before implementation:** Operating system, printer make/model,
driver/protocol, supported colour/duplex settings, connection type
(USB/network), number of printers and who resolves uncertain/failed
prints.

### Phase 11 --- Handover, session closure and data cleanup

Complete ready order through shopkeeper handover and verified deletion.

-   Keep ready separate from handed over.
-   Only authorised shopkeeper can confirm handover.
-   Record actor and timestamp.
-   Close session only under agreed multi-order rules.
-   Apply seven-day inactivity expiry to eligible abandoned sessions.
-   Do not delete paid active orders before handover.
-   Delete originals, converted files, temporary files and agent copies
    according to policy.
-   Make cleanup retryable and auditable.

**End-to-end tests:** Handover one order; session with multiple orders;
paid order not handed over; abandoned unpaid cart; exactly-at-expiry
boundary; cleanup retry; file missing; storage deletion failure;
database deletion failure; repeated cleanup; completed-order metadata
retention.

**Ask before implementation:** Seven days from creation or last
activity, treatment of paid orders, completed-order metadata retention,
payment/accounting retention and whether a customer can place another
order after handover.

### Phase 12 --- Production hardening and deployment

Only after the complete business flow works.

-   Validate production environment variables at startup.
-   Use HTTPS.
-   Configure secure cookies and CORS.
-   Add rate limits and upload limits.
-   Add safe structured logging.
-   Add health/readiness checks.
-   Add backup and restore procedure.
-   Add dependency/security checks.
-   Add monitoring for conversion, payment, printer and cleanup
    failures.
-   Ensure persistent database and file storage.
-   Document deployment, update, rollback and recovery procedures.
-   Test a production-like deployment before public launch.

**Ask before implementation:** Hosting provider, domain/DNS, expected
daily orders, expected concurrent uploads, budget, backup frequency and
acceptable downtime.

------------------------------------------------------------------------

## 6. Testing policy --- strict and mandatory

Testing is part of implementation, not a final optional activity.

### Never do these things

-   Do not remove a failing test to make the test suite green.
-   Do not use `.skip`, `.only`, disabled test blocks or equivalent to
    hide failures.
-   Do not reduce assertion count or remove meaningful assertions.
-   Do not replace a real integration test with a mock merely because
    the real integration is failing.
-   Do not weaken validation or security checks to satisfy an old test.
-   Do not catch and ignore errors just to make a request return
    success.
-   Do not mark a test as passed if it was not executed.
-   Do not claim end-to-end success after testing only one API or one UI
    screen.
-   Do not alter a requirement silently because it is difficult to
    implement.

If an existing test conflicts with an approved new requirement, explain
the conflict, propose the smallest justified test update, and ask for
approval. Preserve the old test's useful coverage through a replacement
regression test.

### Required testing layers

1.  **Unit tests:** Small individual rules, such as page-range parsing,
    sheet calculation, pricing and state-transition validation.
2.  **Integration tests:** Real interaction between routes, database,
    storage and service components. Use isolated test data and clean it
    up.
3.  **End-to-end tests:** Simulate a customer/shopkeeper using the
    application from the UI, through the backend, to the resulting
    persisted state.
4.  **Security/negative tests:** Try unauthorised access, invalid
    inputs, tampered prices, forged payment status, invalid file content
    and cross-customer access.
5.  **Failure/recovery tests:** Restart services, interrupt network,
    fail conversion, fail payment callbacks, disconnect printers and
    retry operations.
6.  **Regression tests:** Every fixed bug gets a test that would have
    failed before the fix.

Use the repository's existing test framework where practical. Add
tooling only when a clear gap exists; explain and ask before a
substantial tooling change.

### Required test evidence per feature

For each feature report:

-   Tests added/updated.
-   Exact commands run.
-   Number passed, failed and skipped.
-   Any test not run and why.
-   Manual scenarios tested.
-   Defects discovered and fixed.
-   Remaining known risks.

A feature is not complete while required tests fail.

------------------------------------------------------------------------

## 7. Final integrated end-to-end test campaign

After all vertical features are implemented, perform a full integrated
test campaign. Test the whole flow in realistic combinations, not only
the happy path.

### A. Main successful journey

1.  New customer opens website.
2.  Anonymous session is created.
3.  Customer uploads a PDF.
4.  Customer selects all pages.
5.  Customer chooses B&W and single-sided.
6.  Customer adds a second document.
7.  Customer selects custom pages on the second document.
8.  Customer chooses colour and duplex where valid.
9.  Customer reviews server-calculated total.
10. Customer pays through the approved test payment flow.
11. Backend verifies payment.
12. Backend creates exactly one order and UID.
13. Customer sees queue position/ETA.
14. Shopkeeper sees the same UID and correct document settings.
15. Printer agent claims the correct job.
16. Printer reports completion.
17. Shopkeeper marks ready.
18. Shopkeeper confirms handover.
19. Session lifecycle is updated.
20. Temporary files are deleted according to policy.

Verify every step in the UI, API, database and storage where applicable.

### B. Document-format matrix

Run a successful upload/convert/preview/print test for each:

-   PDF
-   JPG
-   JPEG
-   PNG
-   DOC
-   DOCX
-   PPT
-   PPTX

Also test invalid content disguised with each allowed extension, corrupt
files, zero-byte files, oversized files, duplicate filenames and
conversion failures.

### C. Page-selection matrix

Test:

-   All pages.
-   One custom page.
-   First page.
-   Last page.
-   `1-2`.
-   `1-2,5`.
-   Multiple ranges.
-   Whitespace around commas/dashes.
-   Duplicate pages.
-   Overlapping ranges.
-   Reversed range.
-   Page zero.
-   Negative page.
-   Page beyond document count.
-   Empty input.
-   Malformed separators.
-   One selected page with duplex requested.
-   Multiple selected pages with duplex.

Confirm both frontend behaviour and backend rejection/acceptance.

### D. Cart and pricing matrix

Test:

-   One document.
-   Multiple documents.
-   Different settings for each document.
-   Remove a document.
-   Edit a document.
-   Different copy counts if supported.
-   All B&W.
-   All colour.
-   Mixed colour/B&W.
-   Single-sided.
-   Double-sided.
-   Mixed single/duplex segments.
-   Price tampering in browser tools.
-   Stale quote after cart change.
-   Concurrent cart updates.
-   Duplicate checkout request.

Verify every total against an independently calculated expected result.

### E. Session and privacy matrix

Test:

-   Refresh page.
-   Close tab.
-   Close browser and reopen.
-   Restart backend.
-   Expired session.
-   Cleared cookies.
-   Two separate browsers.
-   Two customers with simultaneous sessions.
-   Customer A tries customer B's cart/order/document URL.
-   Multiple tabs update the same cart.
-   Handover with one order.
-   Handover with multiple active orders.

No customer may access another customer's documents or order details.

### F. Payment matrix

Test:

-   Successful verified payment.
-   Failed payment.
-   Cancelled payment.
-   Pending payment.
-   Invalid webhook signature.
-   Wrong amount.
-   Wrong currency.
-   Wrong provider reference.
-   Duplicate webhook.
-   Delayed webhook.
-   Browser says success but provider has not verified.
-   Provider verifies payment while customer browser is closed.
-   Server restart during payment processing.
-   Payment confirmed but job creation fails and is recovered safely.

There must never be a paid order without a consistent payment record, or
multiple print jobs caused by duplicate payment events.

### G. Queue and printer matrix

Test:

-   No jobs.
-   One job.
-   Many jobs.
-   Multiple printers if supported.
-   Printer agent offline.
-   Printer goes offline during a job.
-   Printer error.
-   Paper/ink/toner problem where detectable.
-   Agent restart.
-   Backend restart.
-   Network interruption.
-   Duplicate job claim.
-   Duplicate completion report.
-   Uncertain physical print outcome.
-   Manual recovery by shopkeeper.

Do not claim exactly-once physical printing unless the printer and agent
can genuinely guarantee it. Physical printing can have uncertain
outcomes after a crash or network failure.

### H. Admin and handover matrix

Test:

-   Unauthenticated dashboard access.
-   Invalid admin credentials.
-   Customer calling admin endpoints.
-   Admin viewing an order.
-   Admin cancelling an eligible order.
-   Admin marking ready.
-   Admin handing over a ready order.
-   Admin trying to hand over an unpaid/printing order.
-   Two admins changing the same order concurrently.
-   Audit record contains the correct actor and time.

### I. Cleanup and retention matrix

Use test timestamps or a controllable clock.

Test:

-   Active session is not deleted.
-   Recently active session is not deleted.
-   Expired unpaid session is deleted.
-   Paid order awaiting handover is preserved.
-   Handed-over files are deleted according to policy.
-   Original and converted files are both deleted.
-   Temporary conversion files are deleted.
-   Printer-agent temporary copies are handled.
-   Storage deletion failure is retried.
-   Repeated cleanup is safe.
-   Database references do not become orphaned.
-   Required payment/business records are retained according to the
    approved policy.

### J. Concurrency and load matrix

Test realistic simultaneous activity:

-   Multiple customers upload at once.
-   Multiple customers check out at once.
-   Concurrent UID generation.
-   Two requests update the same cart.
-   Duplicate payment callbacks arrive together.
-   Two printer agents request work together.
-   Shopkeeper and printer agent update the same job around the same
    time.
-   Queue changes while customers are viewing ETA.

Use a reasonable load profile approved for the expected shop traffic. Do
not invent capacity claims without measurement.

### K. Deployment/recovery matrix

Test in a production-like environment:

-   Fresh installation.
-   Existing database migration.
-   Application restart.
-   Machine restart.
-   Database backup.
-   Database restore.
-   Missing/invalid environment variables.
-   Storage unavailable.
-   Conversion tool unavailable.
-   Payment provider unavailable.
-   Printer agent unavailable.
-   Log inspection and recovery instructions.

------------------------------------------------------------------------

## 8. Definition of production-ready

Do not call the application production-ready until all of the following
are true:

-   All approved customer requirements work through the real backend.
-   All eight file formats have successful and failure-path tests.
-   Multiple documents with independent settings work.
-   Page-range and duplex rules are enforced server-side.
-   Price is calculated by the backend.
-   Payment is verified securely.
-   Customer sessions survive browser closure and backend restart within
    the agreed policy.
-   Customers cannot access one another's data.
-   UID is unique and server-generated.
-   Queue and ETA are server-authoritative.
-   Shopkeeper actions require server-side authentication and
    authorization.
-   Printer agent is authenticated and real print execution is tested.
-   Printer failures and uncertain outcomes have safe handling.
-   Handover is recorded correctly.
-   Seven-day expiry and file deletion work without deleting paid active
    orders.
-   Database and file storage persist across restarts.
-   Backups and restore have been tested.
-   Required automated tests pass without weakened coverage.
-   Full integrated end-to-end scenarios pass.
-   Known limitations and operational procedures are documented.

If any requirement is not complete, label it clearly as **Not
implemented**, **Partially implemented**, or **Blocked**. Do not hide it
behind a "production-ready" label.

------------------------------------------------------------------------

## 9. How to communicate with the project owner

The owner is not expected to know every technical term. You must guide
decisions rather than silently making them.

For each feature:

-   Explain the problem in ordinary language.
-   Give a concrete example of what the customer/shopkeeper will
    experience.
-   Explain the available choices and their trade-offs.
-   Give your recommended option and why.
-   Ask only the decisions needed for that feature.
-   Wait for the owner's answer when the decision materially affects
    implementation.
-   Do not ask the owner to choose internal coding details that do not
    affect product behaviour; make sensible engineering choices and
    explain them.
-   Do not ask the same question again if it has already been answered
    in the conversation or project documentation.
-   Record approved decisions in `docs/decisions.md` (or the
    repository's existing decision log).

### Example of the expected question style

**Decision needed --- What should happen to a paid order if the customer
does not collect it?**

-   Option A: Keep the order and files until the shopkeeper manually
    resolves it.
-   Option B: Automatically delete the files after a chosen period.
-   Recommendation: Keep the order visible and do not delete print files
    until the shopkeeper resolves the order, because the customer has
    already paid.

**Please choose A or B, or describe a different rule.**

Do not proceed with the unresolved behaviour until the owner decides.

------------------------------------------------------------------------

## 10. First instruction: start with discovery, not coding

Begin by doing **Phase 0 only**.

1.  Inspect the complete repository.
2.  Confirm the audit findings against the current code.
3.  Run the existing tests without changing them.
4.  Map the customer and shopkeeper UI actions to backend routes and
    database tables.
5.  List missing, disconnected, insecure and demo-only behaviour.
6.  Identify dependencies and deployment requirements for the requested
    document formats and printer agent.
7.  Produce a prioritised implementation plan with vertical slices and
    dependencies.
8.  Ask the owner the important decisions needed for Phase 1 and Phase
    2.
9.  Stop and wait for approval.

**Do not start implementing all phases at once. Do not generate a large
batch of code before the owner reviews the plan.**

The objective is a working, secure, testable Quick Print
application---not merely a successful build or a green test count.
