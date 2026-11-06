-- Phase 3: pricing basis + default prices and print options.
-- duplex_basis decides how the "both sides" rates (bw2/col2) are charged:
--   'sheet' = per sheet of paper (2 printed sides)   <- default, usual shop practice
--   'side'  = per printed side
ALTER TABLE price_tables ADD COLUMN duplex_basis TEXT NOT NULL DEFAULT 'sheet' CHECK (duplex_basis IN ('sheet', 'side'));

-- Frozen at checkout together with pages/sides/sheets/amount_paise, so later price changes
-- never alter an order the customer has already been quoted.
ALTER TABLE document_parts ADD COLUMN rate_paise INTEGER;

-- Placeholder prices from the original frontend (Rs 3 / 5 / 10 / 10). The shop owner replaces
-- them from the admin dashboard (phase 6); each change creates a new version.
INSERT INTO price_tables (id, bw1_paise, bw2_paise, col1_paise, col2_paise, a3_multiplier, active, created_by, created_at, duplex_basis)
SELECT '00000000-0000-4000-8000-000000000001', 300, 500, 1000, 1000, 2, 1, 'seed', '2026-11-06T00:00:00.000Z', 'sheet'
WHERE NOT EXISTS (SELECT 1 FROM price_tables WHERE active = 1);

INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
  ('print_options', '{"maxCopies":50,"paperSizes":["A4"],"allowRanges":true,"maxPartsPerDocument":10}', '2026-11-06T00:00:00.000Z');
