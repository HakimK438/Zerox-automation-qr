# Quick Print – QR Xerox Ordering (front-end prototype)

Open `index.html` in a browser, or host it on any static host and point your shop QR code at the URL.

## 
Edit the `CONFIG` block at the top of the script in `index.html`: shop name, UPI ID, payee name,
file-size limit, per-side prices, double-sided per-sheet prices, additional charges.

## Not included yet (needs a backend)
- Secure file storage and server-side page counting
- Server-side price recalculation
- Payment verification via your payment provider's callback/API (amount + order ID check)
- Duplicate order/payment protection and order storage
- Notifying the shop's printing system

The "simulate verified payment" checkbox is a demo only.
The QR code library loads from cdnjs, so an internet connection is needed for the QR image.
