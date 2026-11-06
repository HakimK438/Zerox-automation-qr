-- Phase 4: Paytm payments.
-- Pickup PIN: hash (recovery_pin_hash) for verification + AES-256-GCM ciphertext so the customer's
-- own order page can always show it at pickup.
ALTER TABLE orders ADD COLUMN pickup_pin_enc TEXT;
-- Set when a payment needs a manual refund (paid twice, or paid after the order changed).
ALTER TABLE orders ADD COLUMN needs_attention TEXT;

ALTER TABLE payments ADD COLUMN deep_link TEXT;          -- upi://pay?... from Process Transaction (UPI_INTENT)
ALTER TABLE payments ADD COLUMN expires_at TEXT;
ALTER TABLE payments ADD COLUMN status_checked_at TEXT;
ALTER TABLE payments ADD COLUMN result_code TEXT;
ALTER TABLE payments ADD COLUMN result_msg TEXT;
ALTER TABLE payments ADD COLUMN needs_refund INTEGER NOT NULL DEFAULT 0 CHECK (needs_refund IN (0, 1));

ALTER TABLE refunds ADD COLUMN order_id TEXT REFERENCES orders(id);
ALTER TABLE refunds ADD COLUMN status_checked_at TEXT;
CREATE INDEX refunds_pending ON refunds(status, created_at);
