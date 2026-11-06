-- Phase 6: admin dashboard.
-- Last accepted TOTP time-step per admin: the same 6-digit code can never be used twice.
ALTER TABLE admin_users ADD COLUMN totp_last_step INTEGER NOT NULL DEFAULT 0;
ALTER TABLE admin_users ADD COLUMN password_changed_at TEXT;
-- Wrong pickup PINs typed at the counter; after 5 only an owner password override can hand over.
ALTER TABLE orders ADD COLUMN handover_failures INTEGER NOT NULL DEFAULT 0;
CREATE INDEX admin_sessions_expires ON admin_sessions(expires_at);
CREATE INDEX orders_token_date ON orders(token_date, token_no);
CREATE INDEX orders_paid ON orders(paid_at);
