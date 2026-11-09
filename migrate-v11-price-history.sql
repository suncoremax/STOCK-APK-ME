-- ═══════════════════════════════════════════════════════════════════
-- AXIION DMS — v11 OPTIONAL migration (price-change safety).  The app works WITHOUT this file.
--   • product_price_history : a proper table for the dated price / buy price / pieces-per-case / offer change log
--                             (without it the same entries are kept in audit_log).
--   • transactions.legacy / frozen_at : lets the "পুরনো হিসাব ফ্রিজ" mark each frozen old line.
-- Safe to run twice. Nothing existing is changed or deleted.
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS product_price_history (
  id           UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID          NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  product_id   TEXT          NOT NULL,
  product_name TEXT          DEFAULT '',
  field        TEXT          NOT NULL,
  old_value    NUMERIC(14,4),
  new_value    NUMERIC(14,4),
  changed_at   TIMESTAMPTZ   DEFAULT NOW(),
  changed_by   TEXT          DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_pph_biz_prod ON product_price_history(business_id, product_id, changed_at);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS legacy    BOOLEAN;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS frozen_at TIMESTAMPTZ;
ALTER TABLE product_price_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS srv_product_price_history ON product_price_history;
DROP POLICY IF EXISTS anon_deny_product_price_history ON product_price_history;
CREATE POLICY srv_product_price_history ON product_price_history FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY anon_deny_product_price_history ON product_price_history FOR ALL TO anon USING (false);
