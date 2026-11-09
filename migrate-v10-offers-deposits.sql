-- ═══════════════════════════════════════════════════════════════════
-- AXIION DMS — v10 migration  (run ONCE in the Supabase SQL editor on an EXISTING v7 / v8 / v9 multi-business database)
--
--   • company_receipts  — bonus / free-offer money and damage claims stay a "receivable" until you tap "পেয়েছি";
--                         only then do they move into the profit.
--   • company_deposits  — the daily deposit you make to the company (online / bank / cash), one row per day.
--   • one entry per day — a DSR / SO gets ONE load, ONE return and ONE day-end slip per day (double-tap proof).
--
-- Nothing is deleted or changed in your existing data. Safe to run twice.
-- (A brand-new database made from schema.sql already contains all of this — do NOT run it there.)
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS company_receipts (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   UUID          NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind          TEXT          NOT NULL CHECK (kind IN ('bonus','damage')),
  period        TEXT          NOT NULL,
  from_date     DATE          NOT NULL,
  to_date       DATE          NOT NULL,
  amount        NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  received_date DATE          NOT NULL,
  note          TEXT          DEFAULT '',
  created_at    TIMESTAMPTZ   DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rcpt_biz_date   ON company_receipts(business_id, received_date);
CREATE INDEX IF NOT EXISTS idx_rcpt_biz_period ON company_receipts(business_id, kind, period);

CREATE TABLE IF NOT EXISTS company_deposits (
  id          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID          NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  date        DATE          NOT NULL,
  online_amt  NUMERIC(14,2) NOT NULL DEFAULT 0,
  bank_amt    NUMERIC(14,2) NOT NULL DEFAULT 0,
  cash_amt    NUMERIC(14,2) NOT NULL DEFAULT 0,
  note        TEXT          DEFAULT '',
  created_at  TIMESTAMPTZ   DEFAULT NOW(),
  updated_at  TIMESTAMPTZ   DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dep_biz_date ON company_deposits(business_id, date);

-- security: only the server (service_role) may touch the new tables
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['company_receipts','company_deposits']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', 'srv_' || t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', 'anon_deny_' || t, t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO service_role USING (true) WITH CHECK (true)', 'srv_' || t, t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO anon USING (false)', 'anon_deny_' || t, t);
  END LOOP;
END
$$;

-- ONE entry per day (database-level guard). If your old data already contains a duplicate the index is skipped with a
-- NOTICE — the app still blocks new duplicates by itself, so nothing breaks.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM transactions WHERE type = 'give' GROUP BY business_id, sr_id, date, product_id HAVING count(*) > 1) THEN
    RAISE NOTICE 'idx_tx_one_give_per_day skipped: old data already has the same product given twice to one DSR on one day';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_one_give_per_day ON transactions(business_id, sr_id, date, product_id) WHERE type = 'give';
  END IF;

  IF EXISTS (SELECT 1 FROM transactions WHERE type = 'return' GROUP BY business_id, sr_id, date, product_id HAVING count(*) > 1) THEN
    RAISE NOTICE 'idx_tx_one_return_per_day skipped: old data already has the same product returned twice by one DSR on one day';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_one_return_per_day ON transactions(business_id, sr_id, date, product_id) WHERE type = 'return';
  END IF;

  IF EXISTS (SELECT 1 FROM dayend_slips GROUP BY business_id, dsr_id, date HAVING count(*) > 1) THEN
    RAISE NOTICE 'idx_slips_one_per_day skipped: old data already has two day-end slips for one DSR on one day';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS idx_slips_one_per_day ON dayend_slips(business_id, dsr_id, date);
  END IF;
END
$$;
