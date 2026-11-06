# Quick Print Production Audit

## 1. Confirmed repository facts

### Frontend entry points
- Root customer experience: [index.html](../index.html)
- Browser-side state and pricing logic: [shared.js](../shared.js)
- Customer order flow: [customer.js](../customer.js)
- Shop dashboard: [owner.html](../owner.html) and [owner.js](../owner.js)

### Backend entry point
- Express server: [backend/server.js](../backend/server.js)
- Backend package config: [backend/package.json](../backend/package.json)

### Current implemented backend slices
The current backend includes working anonymous-session, order, payment, printer, and handover behavior, plus tests covering these flows.

Verified status from the current suite:
- Session flow: implemented
- Order creation and ownership: implemented
- Upload URL + file-type validation: implemented
- Payment creation and confirmation: implemented
- Printer registration + queue assignment: implemented
- Ready-to-handover flow: implemented

### Current production-readiness findings
The current application is not production-ready yet. It is a working backend prototype with real API validation, but several production concerns remain unresolved:

1. Frontend/customer pages still rely on browser localStorage for demo behaviour in the original prototype.
2. The backend is not yet connected end-to-end to the browser UI for all flows.
3. There is no authenticated shopkeeper/admin layer.
4. There is no real payment provider integration beyond a demo success flow.
5. There is no secure file conversion pipeline for every supported document type.
6. Pricing is not yet server-owned and versioned in a production-safe way.
7. There is no full production data model for carts, cart items, print segments, jobs, audit actions, and retention cleanup.
8. Session and cart persistence is not yet hardened for production cookie and expiry policy.
9. Uploads are stored under the backend folder and are not yet outside the public web root.
10. No production logging, backup/restore, or operational health setup is documented or enforced.

## 2. Strict compliance against the production brief

### Met
- The project keeps the existing stack (Node.js + Express + SQLite + printer-agent style).
- The backend is implemented vertically in slices rather than as a monolithic rewrite.
- The current suite is being run as real verification, not weakened to a green pass.
- Database and tests are local and isolated per server instance to avoid stale state in repeated runs.

### Not yet met
- Admin auth and authorization.
- Real provider payment verification.
- Conversion pipeline for all eight supported formats.
- End-to-end frontend to backend integration.
- Stable production database path and migration discipline.
- Retention policy and cleanup automation.
- Secure cookie and session hardening for production.
- Print agent authentication, job leases, and uncertain-result handling.

## 3. Recommended next implementation order

Follow the brief in strict order.

### Immediate next phase
Phase 1: Persistent database and data model

Goals:
- define a stable DB path for production
- add schema migration discipline
- model carts, cart items, documents, print segments, payments, print jobs, printers, and event/audit records cleanly
- add transactional safety around multi-step state changes

### Then continue in order
1. Phase 2 — Anonymous session and cart persistence
2. Phase 3 — Upload and document conversion
3. Phase 4 — Per-document print configuration
4. Phase 5 — Cart and authoritative quote
5. Phase 6 — Payment verification and provider integration
6. Phase 7 — UID and order lifecycle
7. Phase 8 — Queue and ETA
8. Phase 9 — Shopkeeper dashboard auth
9. Phase 10 — Printer agent execution
10. Phase 11 — Handover, cleanup, expiry
11. Phase 12 — Production hardening and deployment

## 4. Current recommendation

The current codebase is now strong enough to move from vertical-slice backend validation into the production data-model phase. The next step should not be a UI rewrite; it should be a disciplined data-layer hardening pass so later phases build on a stable, production-safe foundation.
