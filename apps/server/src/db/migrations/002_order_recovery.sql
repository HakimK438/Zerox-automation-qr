-- Phase 1: durable brute-force protection for token + PIN recovery.
-- After too many wrong PINs the order can only be recovered at the counter.
ALTER TABLE orders ADD COLUMN recovery_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN recovery_locked_at TEXT;
CREATE INDEX orders_token_lookup ON orders(token_no, token_date);
