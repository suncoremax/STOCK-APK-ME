-- OPTIONAL — for a database created BEFORE this version. Safe to run any time, any number of times.
-- Makes history lists and the home screen faster. (A brand-new install already gets these from schema.sql.)
-- SPEED: history lists read newest-first; the home screen counts "old lines not yet frozen" (partial index = empty once frozen → instant)
CREATE INDEX IF NOT EXISTS idx_tx_biz_created  ON transactions(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tx_biz_legacy   ON transactions(business_id) WHERE rule_case_size IS NULL;
CREATE INDEX IF NOT EXISTS idx_slips_biz_created ON dayend_slips(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pay_biz_created   ON sr_payments(business_id, created_at DESC);
