# Quick Print – QR Xerox Ordering

Open `index.html` in a browser for the front-end prototype, or run the backend in `backend/server.js` for the real session/cart/order flow.

## Backend setup

From the `backend` folder, start the API server:

```bash
npm install
PORT=4000 NODE_ENV=development node server.js
```

For production-like security, set:

```bash
NODE_ENV=production
QP_COOKIE_SECURE=true
QP_DB_PATH=/absolute/path/to/quickprint.db
```

The app uses an HTTP-only session cookie and keeps the session token server-side. In production mode, the session cookie is marked `Secure` and `HttpOnly`.

## Shop settings
Edit the `CONFIG` block at the top of the script in `index.html`: shop name, UPI ID, payee name,
file-size limit, per-side prices, double-sided per-sheet prices, additional charges.

## Backend features now included
- Anonymous customer sessions with cookie-based persistence
- Cart persistence tied to each anonymous session
- Order, upload, payment and printer flows with session ownership checks
- SQLite-backed persistence with a stable default path

## Not included yet (needs a backend hardening phase)
- Real payment provider integration with verified callbacks/webhooks
- Real document conversion pipeline for print-ready PDFs
- Production deployment, monitoring, backups and admin authentication
