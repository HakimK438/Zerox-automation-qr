-- A customer session lasts until its orders are delivered (handed over) or refunded, then ends.
-- ended_at: when the last active order finished; the session stays readable for a short grace period
-- (to show "Collected" and take a rating) and then stops resolving. A new order clears it.
ALTER TABLE sessions ADD COLUMN ended_at TEXT;
