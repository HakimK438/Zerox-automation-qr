-- Phase 5: queue/ETA, live order page, rating, shop details.
-- All defaults below are placeholders chosen to be reasonable for a small Indian xerox shop;
-- the owner changes them from the admin dashboard (phase 6). Nothing here is hard-coded in code.

ALTER TABLE orders ADD COLUMN printing_at TEXT;   -- set when printing starts (admin/agent), drives the ETA
ALTER TABLE orders ADD COLUMN rating INTEGER CHECK (rating IS NULL OR rating BETWEEN 1 AND 5);
ALTER TABLE orders ADD COLUMN rated_at TEXT;
CREATE INDEX orders_queue ON orders(status, paid_at) WHERE status IN ('paid','printing','print_attention');

INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
  ('shop', '{"name":"Quick Print Xerox","address":"Shop address not set yet","phone":"","open":"09:00","close":"21:00"}', '2026-11-06T00:00:00.000Z'),
  -- Virtual printer until real printers report in (phase 7): typical small laser printer speeds.
  ('queue', '{"ppmBw":20,"ppmColor":10,"setupSec":20,"printers":1,"manualDelayMin":3}', '2026-11-06T00:00:00.000Z'),
  ('print_mode', '"automatic"', '2026-11-06T00:00:00.000Z'),
  ('paused', 'false', '2026-11-06T00:00:00.000Z');

-- Replace the frontend's placeholder prices with a typical rate card, as a new price version
-- (only if the shop is still on the untouched seed). B&W Rs 3/page one side, Rs 5/sheet both sides;
-- colour Rs 10/page one side, Rs 18/sheet both sides; A3 x2.
UPDATE price_tables SET active = 0
WHERE id = '00000000-0000-4000-8000-000000000001' AND active = 1 AND created_by = 'seed';
INSERT INTO price_tables (id, bw1_paise, bw2_paise, col1_paise, col2_paise, a3_multiplier, duplex_basis, active, created_by, created_at)
SELECT '00000000-0000-4000-8000-000000000002', 300, 500, 1000, 1800, 2, 'sheet', 1, 'seed', '2026-11-06T00:00:00.000Z'
WHERE NOT EXISTS (SELECT 1 FROM price_tables WHERE active = 1);
