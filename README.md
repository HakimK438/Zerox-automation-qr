# Quick Print — QR Xerox Automation

Customers scan the shop QR code, upload documents, choose print settings, pay with Paytm UPI, and get a
token with a live ETA. The shop admin prints automatically or manually through a Windows print agent.

The full design, defect analysis and phased roadmap are in [PRODUCTION_PLAN.md](PRODUCTION_PLAN.md).
**Current progress, decisions, conventions and the next phase's spec are in [PROGRESS.md](PROGRESS.md).**

## Layout

| Path | What |
|---|---|
| `apps/server` | Node 22 + Express 5 API, SQLite (WAL) via better-sqlite3 |
| `apps/web` | Customer site (from the Zerox-automation-qr repo; still the localStorage mock until phases 1–5 wire it) |
| `apps/admin` | Admin dashboard (same source; wired in phase 6) |
| `apps/print-agent` | Windows print agent (phase 7) |
| `shared/constants.js` | Order states, allowed transitions, labels, upload types |
| `deploy/` | Caddy, systemd, backups (phase 9) |
| `legacy/` | Old prototype backend and frontend, kept for reference only |
| `docs/` | Concept PDF and earlier planning notes |

## Development

```bash
npm install
npm test          # server test suite
npm run dev       # shop on http://localhost:3000, owner dashboard on http://localhost:3001 (data in ./data)
npm run dev:account   # test owner + sample shop details + 3 test orders (never in production)
npm run demo          # plays one full order on screen: upload, pay, print, handover (never in production)
```

Without Paytm keys, `npm run dev` uses **test payments**: a "Payment successful" and a "Payment failed" button
replace UPI, no money moves, and production refuses this mode. Word and PowerPoint uploads need LibreOffice.

Configuration is validated at startup; see `.env.example`. Production refuses plain-HTTP origins,
insecure cookies, a shared customer/admin origin, and `QP_TRUST_PROXY=true`.

## Status

- [x] Phase 0 — scaffold, config, database schema, security middleware, tests
- [x] Phase 1 — anonymous sessions + recovery (API + `apps/web/api.js`; page wiring lands with the order page in phase 5)
- [x] Phase 2 — document upload + conversion (API + `apps/web/api.js`; LibreOffice needed for Word/PowerPoint — `sudo apt install libreoffice-writer-nogui libreoffice-impress-nogui`)
- [x] Phase 3 — pricing + quote + checkout freeze (API + `apps/web/api.js`)
- [x] Phase 4 — Paytm payment, verification, reconciler, refunds (server; tested against a mock Paytm — needs real staging credentials to verify)
- [x] Phase 5 — queue + ETA, live updates, customer site wired end to end (`npm run e2e` for the browser test)
- [x] Phase 6 — admin auth (password + authenticator code) + live dashboard (`npm run admin:create`, `npm run dev:fakepay`, `npm run e2e:admin`)
- [x] Phase 7 — Windows print agent (`apps/print-agent`, install guide in `apps/print-agent/windows/README.md`; needs a real shop-PC test)
- [x] Phase 8 — file retention, reconciliation, problems list, CSV, extra-payment refunds, password change
- [ ] Phase 9 — deployment on Oracle Cloud
