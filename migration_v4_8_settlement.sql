-- AXIION DMS 4.8.0 — end-of-day settlement, due collection, damage collection.
-- Run ONCE in the Supabase SQL editor on an EXISTING deployment.
-- (A fresh install already gets all of this from schema.sql.)
-- Safe to re-run: every statement is IF NOT EXISTS / idempotent.

-- 1) Due collected by a DSR from a shop (one row per collection event)
CREATE TABLE IF NOT EXISTS due_collections (
  id          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  due_id      TEXT          NOT NULL,
  shop_id     TEXT          DEFAULT '',
  shop_name   TEXT          DEFAULT '',
  dsr_id      TEXT          NOT NULL,
  dsr_name    TEXT          DEFAULT '',
  date        DATE          NOT NULL,
  amount      NUMERIC(14,4) NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ   DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_duecol_dsr_date ON due_collections(dsr_id, date);
CREATE INDEX IF NOT EXISTS idx_duecol_due      ON due_collections(due_id);
ALTER TABLE due_collections ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "srv_due_collections" ON due_collections FOR ALL TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "anon_deny_due_collections" ON due_collections FOR ALL TO anon USING (false);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2) Damaged goods a DSR collected back from a shop (money refund OR exchange)
CREATE TABLE IF NOT EXISTS damage_collections (
  id                 UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  col_id             TEXT          NOT NULL,            -- groups the lines of one submission
  dsr_id             TEXT          NOT NULL,
  dsr_name           TEXT          DEFAULT '',
  shop_id            TEXT          DEFAULT '',
  shop_name          TEXT          DEFAULT '',
  date               DATE          NOT NULL,
  product_id         TEXT          NOT NULL,
  product_name       TEXT          DEFAULT '',
  sku                TEXT          DEFAULT '',
  units              NUMERIC(14,4) DEFAULT 0,
  selling_price      NUMERIC(14,4) DEFAULT 0,
  purchase_price     NUMERIC(14,4) DEFAULT 0,
  damaged_value      NUMERIC(14,4) DEFAULT 0,           -- units * selling_price
  resolution         TEXT          NOT NULL CHECK (resolution IN ('money','exchange')),
  refund_amt         NUMERIC(14,4) DEFAULT 0,           -- cash the DSR paid the shop (money)
  exch_product_id    TEXT          DEFAULT '',
  exch_product_name  TEXT          DEFAULT '',
  exch_units         NUMERIC(14,4) DEFAULT 0,
  exch_value         NUMERIC(14,4) DEFAULT 0,           -- replacement value at selling price
  note               TEXT          DEFAULT '',
  created_at         TIMESTAMPTZ   DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dmgcol_dsr_date ON damage_collections(dsr_id, date);
ALTER TABLE damage_collections ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "srv_damage_collections" ON damage_collections FOR ALL TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "anon_deny_damage_collections" ON damage_collections FOR ALL TO anon USING (false);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 3) One row per end-of-day settlement press. `token` is UNIQUE so a
--    double tap / retry can never apply the same calculation twice.
CREATE TABLE IF NOT EXISTS dsr_settlements (
  id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  token          TEXT          NOT NULL UNIQUE,
  dsr_id         TEXT          NOT NULL,
  dsr_name       TEXT          DEFAULT '',
  date           DATE          NOT NULL,
  comm_amt       NUMERIC(14,4) DEFAULT 0,
  disc_amt       NUMERIC(14,4) DEFAULT 0,
  dmg_amt        NUMERIC(14,4) DEFAULT 0,
  return_amt     NUMERIC(14,4) DEFAULT 0,
  cash_expected  NUMERIC(14,4) DEFAULT 0,
  cash_received  NUMERIC(14,4) DEFAULT 0,
  note           TEXT          DEFAULT '',
  created_by     TEXT          DEFAULT '',
  created_at     TIMESTAMPTZ   DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_settle_dsr_date ON dsr_settlements(dsr_id, date);
ALTER TABLE dsr_settlements ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "srv_dsr_settlements" ON dsr_settlements FOR ALL TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "anon_deny_dsr_settlements" ON dsr_settlements FOR ALL TO anon USING (false);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 4) Manager settlements go through the Owner approval queue
ALTER TABLE manager_pending_approvals DROP CONSTRAINT IF EXISTS manager_pending_approvals_input_type_check;
ALTER TABLE manager_pending_approvals ADD CONSTRAINT manager_pending_approvals_input_type_check
  CHECK (input_type IN ('transaction','payment','expense','settlement'));
