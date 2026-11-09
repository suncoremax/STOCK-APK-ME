-- ═══════════════════════════════════════════════════════════════════
-- AXIION DMS — MULTI-BUSINESS EDITION  ·  schema.sql
--
--   ONE file = the complete database (all migrations v6 / v7 / v10 / v11 are already merged in). Run it ONCE in the Supabase SQL
--   editor on a brand-new, empty project. It creates:
--     tables · indexes · functions · triggers · security policies ·
--     the public "thumbs" photo bucket (no products — you add your own) ·
--     the single Owner login (PIN 12345, must be changed at first login).
--   One owner can run MANY businesses: every table carries business_id, so each business's
--   data (stock, DSR/SO, shops, dues, reports, settings, numbering) is completely separate.
--   No business exists after this script — the owner adds them from the app (সংযোজন: ব্যবসা যোগ করুন).
--
--   ⚠ It DROPS and re-creates every table it owns. It refuses to run
--     if the database already holds transactions, staff or shops, so
--     it can never wipe a live business by accident.
-- ═══════════════════════════════════════════════════════════════════
DO $$
DECLARE n BIGINT;
BEGIN
  IF to_regclass('public.businesses') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.businesses' INTO n;
    IF n > 0 THEN RAISE EXCEPTION 'STOP: this database already has businesses. Use migrate-v7-multi-business.sql only on an older single-business database; schema.sql would erase everything.'; END IF;
  END IF;
  IF to_regclass('public.transactions') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.transactions' INTO n;
    IF n > 0 THEN RAISE EXCEPTION 'STOP: this database already contains transactions. schema.sql would erase everything.'; END IF;
  END IF;
  IF to_regclass('public.srs') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.srs' INTO n;
    IF n > 0 THEN RAISE EXCEPTION 'STOP: this database already contains staff (srs). schema.sql would erase everything.'; END IF;
  END IF;
  IF to_regclass('public.shops') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.shops' INTO n;
    IF n > 0 THEN RAISE EXCEPTION 'STOP: this database already contains shops. schema.sql would erase everything.'; END IF;
  END IF;
END
$$;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

DROP TABLE IF EXISTS biz_counters, businesses, dayend_slips, due_collections, due_calendar, shops, exp_records, exp_cats,
  sr_payments, bonus, dmg_claims, transactions, srs, sr_display_seq, products, user_passwords,
  app_settings, important_contacts, audit_log, idempotency_keys, company_receipts, company_deposits CASCADE;
DROP SEQUENCE IF EXISTS shop_no_seq;
DROP SEQUENCE IF EXISTS slip_no_seq;

-- ───────────────────────── BUSINESSES (one owner, many businesses) ─────────────────────────
CREATE TABLE businesses (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT        NOT NULL,
  cycle_start_day INTEGER     CHECK (cycle_start_day BETWEEN 1 AND 28),   -- month cycle: the month starts on this day (26 → 26th…25th, 1 → calendar month). Set by the owner when the business is created.
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
-- running numbers per business: DSR-1 / SO-1, SHOP-0001, SL-000001 … each business counts from 1
CREATE TABLE biz_counters (
  business_id UUID    NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  key         TEXT    NOT NULL,
  next_no     INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (business_id, key)
);

-- ───────────────────────── PRODUCTS ─────────────────────────
CREATE TABLE products (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id          UUID          NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name                TEXT          NOT NULL,
  sku                 TEXT          NOT NULL,
  case_size           INTEGER       DEFAULT 1,
  unit_type           TEXT          DEFAULT 'কেস',
  case_price          NUMERIC(14,4) DEFAULT 0,
  case_purchase_price NUMERIC(14,4) DEFAULT 0,
  purchase_price      NUMERIC(14,4) DEFAULT 0,
  selling_price       NUMERIC(14,4) DEFAULT 0,
  bonus_free_units    NUMERIC(14,4) DEFAULT 0,
  bonus_cases_req     NUMERIC(10,2) DEFAULT 1,
  bonus_free_money    NUMERIC(14,4) DEFAULT 0,
  low_stock_alert     NUMERIC(10,2) DEFAULT 0,
  thumb               TEXT          DEFAULT '',
  category            TEXT          DEFAULT '',
  sort_order          INTEGER       DEFAULT 0,
  current_stock       NUMERIC(14,4) DEFAULT 0,
  created_at          TIMESTAMPTZ   DEFAULT NOW()
);
CREATE INDEX idx_products_category   ON products(category);
CREATE INDEX idx_products_sort_order ON products(sort_order);

-- ───────────────── DSR / SO  (names only — nobody logs in) ─────────────────
CREATE TABLE srs (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id          UUID          NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  phone       TEXT        DEFAULT '',
  area        TEXT        DEFAULT '',
  role        TEXT        DEFAULT 'dsr' CHECK (role IN ('dsr', 'so')),
  display_no  INTEGER,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_srs_role ON srs(role);
CREATE UNIQUE INDEX idx_srs_role_display_no ON srs(business_id, role, display_no);


-- ───────────────────────── TRANSACTIONS ─────────────────────────
--   buy                 company → warehouse                (+stock)
--   give                warehouse → DSR/SO                 (−stock)
--   return              DSR/SO → warehouse (unsold)        (+stock)
--   damage              damaged goods the DSR/SO brings    (no stock change; opens a company claim)
--   point_sale          warehouse → shop / walk-in         (−stock)
--   point_damage_return shop hands goods back              (+stock)
--   return_company      warehouse → company                (−stock)
CREATE TABLE transactions (
  id                    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id          UUID          NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  tx_id                 UUID          NOT NULL,
  type                  TEXT          NOT NULL CHECK (type IN ('give','return','damage','buy','point_sale','point_damage_return','return_company')),
  sr_id                 TEXT          DEFAULT '',
  sr_name               TEXT          DEFAULT '',
  date                  DATE          NOT NULL,
  slip_no               TEXT          DEFAULT '',
  product_id            TEXT          NOT NULL,
  product_name          TEXT          DEFAULT '',
  sku                   TEXT          DEFAULT '',
  cases                 NUMERIC(10,2) DEFAULT 0,
  pcs                   NUMERIC(10,2) DEFAULT 0,
  total_units           NUMERIC(14,4) DEFAULT 0,
  purchase_price        NUMERIC(14,4) DEFAULT 0,
  selling_price         NUMERIC(14,4) DEFAULT 0,
  total_cost            NUMERIC(14,4) DEFAULT 0,
  total_revenue         NUMERIC(14,4) DEFAULT 0,
  commission_amt        NUMERIC(14,4) DEFAULT 0,
  discount_amt          NUMERIC(14,4) DEFAULT 0,
  shop_id               TEXT          DEFAULT '',
  customer_id           TEXT          DEFAULT '',
  note                  TEXT          DEFAULT '',
  created_at            TIMESTAMPTZ   DEFAULT NOW(),
  -- the bonus rule that was valid on the day of the sale (editing a product later never rewrites old bonus)
  rule_case_size        NUMERIC(10,2),
  rule_bonus_cases_req  NUMERIC(10,2),
  rule_bonus_free_units NUMERIC(14,4),
  rule_bonus_free_money NUMERIC(14,4)
);
CREATE INDEX idx_tx_type          ON transactions(type);
CREATE INDEX idx_tx_date          ON transactions(date);
CREATE INDEX idx_tx_sr_id         ON transactions(sr_id);
CREATE INDEX idx_tx_shop_id       ON transactions(shop_id);
CREATE INDEX idx_tx_txid          ON transactions(tx_id);
CREATE INDEX idx_tx_sr_type_date  ON transactions(sr_id, type, date);
CREATE INDEX idx_tx_date_type     ON transactions(date, type);
CREATE INDEX idx_tx_created       ON transactions(created_at);

-- ───────────────────────── DAMAGE CLAIMS (to the company) ─────────────────────────
CREATE TABLE dmg_claims (
  id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id          UUID          NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  tx_id          TEXT          DEFAULT '',
  product_id     TEXT          NOT NULL,
  product_name   TEXT          DEFAULT '',
  sku            TEXT          DEFAULT '',
  total_units    NUMERIC(12,2) DEFAULT 0,
  purchase_price NUMERIC(12,2) DEFAULT 0,
  total_cost     NUMERIC(14,2) DEFAULT 0,
  date           DATE,
  sr_id          TEXT          DEFAULT '',
  sr_name        TEXT          DEFAULT '',
  status         TEXT          DEFAULT 'pending' CHECK (status IN ('pending','cleared')),
  cleared_date   DATE,
  created_at     TIMESTAMPTZ   DEFAULT NOW()
);
CREATE INDEX idx_dmg_product ON dmg_claims(product_id);
CREATE INDEX idx_dmg_status  ON dmg_claims(status);
CREATE INDEX idx_dmg_sr_id   ON dmg_claims(sr_id);
CREATE INDEX idx_dmg_date    ON dmg_claims(date);

-- ───────────────────────── BONUS / FREE (record of cleared periods) ─────────────────────────
CREATE TABLE bonus (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id          UUID          NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  product_id    TEXT          NOT NULL,
  product_name  TEXT          DEFAULT '',
  sku           TEXT          DEFAULT '',
  from_date     DATE,
  to_date       DATE,
  given_units   NUMERIC(12,2) DEFAULT 0,
  bonus_amount  NUMERIC(14,2) DEFAULT 0,
  status        TEXT          DEFAULT 'cleared',
  cleared_date  DATE,
  note          TEXT          DEFAULT '',
  created_at    TIMESTAMPTZ   DEFAULT NOW()
);

-- ───────────────────────── DSR / SO PAYMENTS (hand-entered) ─────────────────────────
CREATE TABLE sr_payments (
  id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id          UUID          NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  sr_id          TEXT          NOT NULL,
  sr_name        TEXT          DEFAULT '',
  date           DATE          NOT NULL,
  amount         NUMERIC(14,4) DEFAULT 0,      -- cash + commission + discount + damage
  cash_amount    NUMERIC(14,4) DEFAULT 0,
  commission_amt NUMERIC(14,4) DEFAULT 0,
  discount_amt   NUMERIC(14,4) DEFAULT 0,
  damage_amt     NUMERIC(14,4) DEFAULT 0,
  bonus_amt      NUMERIC(14,4) DEFAULT 0,      -- bonus / free goods the DSR gave to shops
  other_amt      NUMERIC(14,4) DEFAULT 0,      -- other day-end deductions
  note           TEXT          DEFAULT '',
  created_at     TIMESTAMPTZ   DEFAULT NOW()
);
CREATE INDEX idx_pay_sr      ON sr_payments(sr_id);
CREATE INDEX idx_pay_date    ON sr_payments(date);
CREATE INDEX idx_pay_sr_date ON sr_payments(sr_id, date);

-- ───────────────────────── DAY-END SLIPS (one per DSR per hand-in) ─────────────────────────
CREATE TABLE dayend_slips (
  id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id          UUID          NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  slip_no        TEXT          NOT NULL,                 -- unique inside one business (idx_slips_biz_no)
  dsr_id         TEXT          NOT NULL,
  dsr_name       TEXT          DEFAULT '',
  date           DATE          NOT NULL,
  given_amt      NUMERIC(14,4) DEFAULT 0,      -- stock the DSR carried that day (at his price)
  return_amt     NUMERIC(14,4) DEFAULT 0,      -- unsold goods handed back
  damage_amt     NUMERIC(14,4) DEFAULT 0,      -- damaged goods handed in
  comm_amt       NUMERIC(14,4) DEFAULT 0,
  disc_amt       NUMERIC(14,4) DEFAULT 0,
  bonus_amt      NUMERIC(14,4) DEFAULT 0,      -- bonus / free goods the DSR gave to shops that day
  other_amt      NUMERIC(14,4) DEFAULT 0,      -- other deductions
  details        JSONB         DEFAULT '{}'::jsonb,   -- the itemised entries of each tab (commission / discount / bonus / other)
  expected_cash  NUMERIC(14,4) DEFAULT 0,      -- given − return − damage − commission − discount − bonus − other
  cash_amt       NUMERIC(14,4) DEFAULT 0,      -- cash the owner actually received
  due_before     NUMERIC(14,4) DEFAULT 0,
  due_after      NUMERIC(14,4) DEFAULT 0,
  note           TEXT          DEFAULT '',
  return_tx_id   TEXT          DEFAULT '',
  damage_tx_id   TEXT          DEFAULT '',
  payment_id     TEXT          DEFAULT '',
  created_at     TIMESTAMPTZ   DEFAULT NOW()
);
CREATE UNIQUE INDEX idx_slips_biz_no ON dayend_slips(business_id, slip_no);
CREATE INDEX idx_slips_dsr_date ON dayend_slips(dsr_id, date);
CREATE INDEX idx_slips_date     ON dayend_slips(date);

-- ───────────────────────── EXPENSES ─────────────────────────
CREATE TABLE exp_cats (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id          UUID          NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name       TEXT        NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE exp_records (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id          UUID          NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  category_id   TEXT          NOT NULL,
  category_name TEXT          DEFAULT '',
  date          DATE          NOT NULL,
  amount        NUMERIC(14,2) DEFAULT 0,
  note          TEXT          DEFAULT '',
  created_at    TIMESTAMPTZ   DEFAULT NOW()
);
CREATE INDEX idx_exp_date ON exp_records(date);

-- ───────────────────────── SHOPS ─────────────────────────
CREATE TABLE shops (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id          UUID          NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  shop_no            TEXT        NOT NULL,             -- SHOP-0001 (unique inside one business)
  name               TEXT        NOT NULL,
  keeper_name        TEXT        DEFAULT '',
  phone              TEXT        DEFAULT '',
  address            TEXT        DEFAULT '',
  assigned_dsr_id    TEXT        DEFAULT '',           -- optional: which DSR normally serves the shop
  assigned_dsr_name  TEXT        DEFAULT '',
  created_at         TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX idx_shops_biz_no ON shops(business_id, shop_no);
CREATE INDEX idx_shops_dsr        ON shops(assigned_dsr_id);
CREATE INDEX idx_shops_created    ON shops(created_at DESC);
CREATE INDEX idx_shops_name_trgm  ON shops USING gin (name        gin_trgm_ops);
CREATE INDEX idx_shops_phone_trgm ON shops USING gin (phone       gin_trgm_ops);
CREATE INDEX idx_shops_keeper_trgm ON shops USING gin (keeper_name gin_trgm_ops);

-- ───────────────────────── SHOP / CUSTOMER DUES ─────────────────────────
CREATE TABLE due_calendar (
  id           UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id          UUID          NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  dsr_id       TEXT          DEFAULT '',
  dsr_name     TEXT          DEFAULT '',
  client_type  TEXT          DEFAULT 'shop',        -- 'shop' | 'custom'
  shop_id      TEXT          DEFAULT '',
  shop_name    TEXT          DEFAULT '',
  due_date     DATE          NOT NULL,
  amount       NUMERIC(14,4) DEFAULT 0,
  paid_amount  NUMERIC(14,4) DEFAULT 0,
  note         TEXT          DEFAULT '',
  status       TEXT          DEFAULT 'pending' CHECK (status IN ('pending','partial','cleared')),
  cleared_date DATE,
  tx_id        TEXT          DEFAULT '',            -- the point-sale this due came from (feeds the shop ledger)
  entry_date   DATE,                                -- the day the sale / due was written
  initial_paid NUMERIC(14,4) DEFAULT 0,             -- cash the shop handed over AT the sale (before any later collection)
  created_at   TIMESTAMPTZ   DEFAULT NOW()
);
CREATE INDEX idx_due_date        ON due_calendar(due_date);
CREATE INDEX idx_due_status      ON due_calendar(status);
CREATE INDEX idx_due_shop_id     ON due_calendar(shop_id);
CREATE INDEX idx_due_tx          ON due_calendar(tx_id);
CREATE INDEX idx_due_open        ON due_calendar(due_date) WHERE status <> 'cleared';
CREATE INDEX idx_due_open_shop   ON due_calendar(shop_id)  WHERE status <> 'cleared';

CREATE TABLE due_collections (
  id         UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id          UUID          NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  due_id     TEXT          NOT NULL,
  shop_id    TEXT          DEFAULT '',
  shop_name  TEXT          DEFAULT '',
  date       DATE          NOT NULL,
  amount     NUMERIC(14,4) NOT NULL DEFAULT 0,
  kind       TEXT          NOT NULL DEFAULT 'cash' CHECK (kind IN ('cash','return')),   -- 'return' = due reduced by goods handed back (no cash)
  note       TEXT          DEFAULT '',
  created_at TIMESTAMPTZ   DEFAULT NOW()
);
CREATE INDEX idx_duecol_due  ON due_collections(due_id);
CREATE INDEX idx_duecol_shop ON due_collections(shop_id, created_at);
CREATE INDEX idx_duecol_date ON due_collections(date);

-- ───────────────────────── LOGIN (the Owner only) ─────────────────────────
CREATE TABLE user_passwords (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_key       TEXT        NOT NULL UNIQUE,
  user_name      TEXT        DEFAULT '',
  role           TEXT        NOT NULL DEFAULT 'owner' CHECK (role = 'owner'),
  password       TEXT        NOT NULL,                -- sha-256 of  'axiion:' || PIN  (never the PIN itself)
  must_change_pw BOOLEAN     NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ───────────────────────── SETTINGS / CONTACTS / SAFETY NETS ─────────────────────────
CREATE TABLE app_settings (
  business_id          UUID        PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  id                   INTEGER     NOT NULL DEFAULT 1,
  shop_name            TEXT        NOT NULL DEFAULT '',
  shop_address         TEXT        DEFAULT '',
  shop_phone           TEXT        DEFAULT '',
  distributor_name     TEXT        DEFAULT '',
  logo_text            TEXT        DEFAULT '',
  block_negative_stock BOOLEAN     NOT NULL DEFAULT TRUE,
  set_by               TEXT        DEFAULT '',
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE important_contacts (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id          UUID          NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name         TEXT        NOT NULL DEFAULT '',
  role         TEXT        NOT NULL DEFAULT '',
  phone_number TEXT        NOT NULL DEFAULT '',
  special_note TEXT        NOT NULL DEFAULT '',
  created_by   TEXT        NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE audit_log (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id          UUID          NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  at         TIMESTAMPTZ DEFAULT NOW(),
  actor_id   TEXT DEFAULT '',
  actor_role TEXT DEFAULT '',
  action     TEXT DEFAULT '',
  table_name TEXT DEFAULT '',
  row_id     TEXT DEFAULT '',
  old_data   JSONB,
  new_data   JSONB
);
CREATE INDEX idx_audit_at  ON audit_log(at DESC);
CREATE INDEX idx_audit_row ON audit_log(table_name, row_id);

-- double-tap / retry protection: a request id is answered once, never written twice
CREATE TABLE idempotency_keys (
  key        TEXT PRIMARY KEY,
  response   JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_idem_created ON idempotency_keys(created_at);



-- ───────────────────────── COMPANY RECEIPTS (v10) ─────────────────────────
-- Bonus / free-offer money and damage claims are only a "receivable" until the company really pays.
-- When the owner taps "পেয়েছি" a row is written here; ONLY then does the amount move into the profit.
--   kind   'bonus' | 'damage'          period  the month-cycle label 'YYYY-MM' the money was earned in
CREATE TABLE company_receipts (
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
CREATE INDEX idx_rcpt_biz_date   ON company_receipts(business_id, received_date);
CREATE INDEX idx_rcpt_biz_period ON company_receipts(business_id, kind, period);

-- ───────────────────────── DAILY DEPOSIT TO THE COMPANY (v10) ─────────────────────────
-- ONE row per business per day. Amount split by method; a day with nothing deposited is saved as 0.
CREATE TABLE company_deposits (
  id         UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID         NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  date       DATE          NOT NULL,
  online_amt NUMERIC(14,2) NOT NULL DEFAULT 0,      -- bKash / Nagad / Rocket / online
  bank_amt   NUMERIC(14,2) NOT NULL DEFAULT 0,      -- bank transfer / deposit
  cash_amt   NUMERIC(14,2) NOT NULL DEFAULT 0,      -- cash handed over
  note       TEXT          DEFAULT '',
  created_at TIMESTAMPTZ   DEFAULT NOW(),
  updated_at TIMESTAMPTZ   DEFAULT NOW()
);
CREATE UNIQUE INDEX idx_dep_biz_date ON company_deposits(business_id, date);

-- ───────────────────────── ONE ENTRY PER DAY (v10) ─────────────────────────
-- A DSR / SO gets ONE load and hands back ONE return and ONE day-end slip per day. These indexes make a
-- double tap / retry physically impossible to write twice (the app checks first, the database has the last word).
CREATE UNIQUE INDEX idx_tx_one_give_per_day   ON transactions(business_id, sr_id, date, product_id) WHERE type = 'give';
CREATE UNIQUE INDEX idx_tx_one_return_per_day ON transactions(business_id, sr_id, date, product_id) WHERE type = 'return';
CREATE UNIQUE INDEX idx_slips_one_per_day     ON dayend_slips(business_id, dsr_id, date);


-- per-business lookups (every query filters on business_id)
CREATE INDEX idx_products_biz     ON products(business_id, sort_order);
CREATE INDEX idx_srs_biz          ON srs(business_id, role);
CREATE INDEX idx_tx_biz_date_type ON transactions(business_id, date, type);
CREATE INDEX idx_tx_biz_txid      ON transactions(business_id, tx_id);
CREATE INDEX idx_tx_biz_sr        ON transactions(business_id, sr_id, type, date);
CREATE INDEX idx_dmg_biz_date     ON dmg_claims(business_id, date);
CREATE INDEX idx_bonus_biz        ON bonus(business_id);
CREATE INDEX idx_pay_biz_date     ON sr_payments(business_id, date);
CREATE INDEX idx_slips_biz_date   ON dayend_slips(business_id, date);
CREATE INDEX idx_expc_biz         ON exp_cats(business_id);
CREATE INDEX idx_exp_biz_date     ON exp_records(business_id, date);
CREATE INDEX idx_shops_biz        ON shops(business_id, created_at DESC);
CREATE INDEX idx_due_biz_shop     ON due_calendar(business_id, shop_id);
CREATE INDEX idx_due_biz_date     ON due_calendar(business_id, entry_date);
CREATE INDEX idx_duecol_biz_date  ON due_collections(business_id, date);
CREATE INDEX idx_contacts_biz     ON important_contacts(business_id);
-- SPEED: history lists read newest-first; the home screen counts "old lines not yet frozen" (partial index = empty once frozen → instant)
CREATE INDEX IF NOT EXISTS idx_tx_biz_created  ON transactions(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tx_biz_legacy   ON transactions(business_id) WHERE rule_case_size IS NULL;
CREATE INDEX IF NOT EXISTS idx_slips_biz_created ON dayend_slips(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pay_biz_created   ON sr_payments(business_id, created_at DESC);
CREATE INDEX idx_audit_biz        ON audit_log(business_id, at DESC);

-- ═══════════════════════════════════════════════════════════════════
--  FUNCTIONS (multi-business: every function takes the business id p_biz first — the server passes it)
-- ═══════════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS next_sr_display_no(TEXT);
DROP FUNCTION IF EXISTS next_shop_no();
DROP FUNCTION IF EXISTS insert_tx_rows(JSONB);
DROP FUNCTION IF EXISTS shop_apply_payment(TEXT, NUMERIC, DATE, TEXT, TEXT);
DROP FUNCTION IF EXISTS create_shop_sale(JSONB, JSONB);
DROP FUNCTION IF EXISTS create_shop_return(JSONB, TEXT, NUMERIC, DATE, TEXT);
DROP FUNCTION IF EXISTS save_day_end(JSONB);
DROP FUNCTION IF EXISTS dsr_due_totals(TEXT[]);
DROP FUNCTION IF EXISTS sales_summary(DATE, DATE);
DROP FUNCTION IF EXISTS profit_extras(DATE, DATE);
DROP FUNCTION IF EXISTS bonus_net_units(DATE, DATE);
DROP FUNCTION IF EXISTS sr_sales_totals(DATE, DATE);
DROP FUNCTION IF EXISTS product_sales_totals(DATE, DATE);
DROP FUNCTION IF EXISTS shop_due_totals(TEXT[]);
DROP FUNCTION IF EXISTS next_counter(UUID, TEXT);
DROP FUNCTION IF EXISTS next_sr_display_no(UUID, TEXT);
DROP FUNCTION IF EXISTS next_shop_no(UUID);
DROP FUNCTION IF EXISTS insert_tx_rows(UUID, JSONB);
DROP FUNCTION IF EXISTS shop_apply_payment(UUID, TEXT, NUMERIC, DATE, TEXT, TEXT);
DROP FUNCTION IF EXISTS create_shop_sale(UUID, JSONB, JSONB);
DROP FUNCTION IF EXISTS create_shop_return(UUID, JSONB, TEXT, NUMERIC, DATE, TEXT);
DROP FUNCTION IF EXISTS save_day_end(UUID, JSONB);
DROP FUNCTION IF EXISTS dsr_due_totals(UUID, TEXT[]);
DROP FUNCTION IF EXISTS sales_summary(UUID, DATE, DATE);
DROP FUNCTION IF EXISTS profit_extras(UUID, DATE, DATE);
DROP FUNCTION IF EXISTS bonus_net_units(UUID, DATE, DATE);
DROP FUNCTION IF EXISTS sr_sales_totals(UUID, DATE, DATE);
DROP FUNCTION IF EXISTS product_sales_totals(UUID, DATE, DATE);
DROP FUNCTION IF EXISTS shop_due_totals(UUID, TEXT[]);

-- one numbering counter per business (DSR-1, SO-1, SHOP-0001, SL-000001 each start from 1 in every business)
CREATE OR REPLACE FUNCTION next_counter(p_biz UUID, p_key TEXT) RETURNS INTEGER AS $$
DECLARE v INTEGER;
BEGIN
  INSERT INTO biz_counters (business_id, key, next_no) VALUES (p_biz, p_key, 2)
  ON CONFLICT (business_id, key) DO UPDATE SET next_no = biz_counters.next_no + 1
  RETURNING next_no - 1 INTO v;
  RETURN v;
END;
$$ LANGUAGE plpgsql;
GRANT EXECUTE ON FUNCTION next_counter(UUID, TEXT) TO service_role;

CREATE OR REPLACE FUNCTION next_sr_display_no(p_biz UUID, p_role TEXT) RETURNS INTEGER AS $$
BEGIN RETURN next_counter(p_biz, 'sr:' || p_role); END;
$$ LANGUAGE plpgsql;
GRANT EXECUTE ON FUNCTION next_sr_display_no(UUID, TEXT) TO service_role;

CREATE OR REPLACE FUNCTION next_shop_no(p_biz UUID) RETURNS INTEGER AS $$
BEGIN RETURN next_counter(p_biz, 'shop'); END;
$$ LANGUAGE plpgsql;
GRANT EXECUTE ON FUNCTION next_shop_no(UUID) TO service_role;

-- ═══════════════ STOCK: one trigger keeps products.current_stock exact ═══════════════
-- Outgoing movements can never push stock below zero (switch: app_settings.block_negative_stock, per business).
CREATE OR REPLACE FUNCTION apply_stock_delta() RETURNS TRIGGER AS $$
DECLARE
  delta NUMERIC(14,4);
  guard BOOLEAN;
BEGIN
  delta := CASE NEW.type
    WHEN 'buy'                  THEN  NEW.total_units
    WHEN 'give'                 THEN -NEW.total_units
    WHEN 'return'               THEN  NEW.total_units
    WHEN 'point_sale'           THEN -NEW.total_units
    WHEN 'point_damage_return'  THEN  NEW.total_units
    WHEN 'return_company'       THEN -NEW.total_units
    ELSE 0
  END;
  IF delta <> 0 AND NEW.product_id IS NOT NULL AND NEW.product_id <> '' THEN
    guard := COALESCE((SELECT block_negative_stock FROM app_settings WHERE business_id = NEW.business_id), TRUE);
    IF delta < 0 AND guard THEN
      UPDATE products SET current_stock = current_stock + delta
        WHERE id::text = NEW.product_id AND business_id = NEW.business_id AND current_stock + delta >= 0;
      IF NOT FOUND AND EXISTS (SELECT 1 FROM products WHERE id::text = NEW.product_id AND business_id = NEW.business_id) THEN
        RAISE EXCEPTION 'STOCK_NEGATIVE: not enough stock for product %', NEW.product_id;
      END IF;
    ELSE
      UPDATE products SET current_stock = current_stock + delta WHERE id::text = NEW.product_id AND business_id = NEW.business_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_apply_stock_delta ON transactions;
CREATE TRIGGER trg_apply_stock_delta
  AFTER INSERT ON transactions
  FOR EACH ROW EXECUTE FUNCTION apply_stock_delta();

-- ═══════════════ shared helper: insert transaction rows from JSON ═══════════════
CREATE OR REPLACE FUNCTION insert_tx_rows(p_biz UUID, p_rows JSONB) RETURNS VOID
LANGUAGE sql AS $$
  INSERT INTO transactions (business_id, tx_id, type, sr_id, sr_name, date, slip_no, product_id, product_name, sku,
      cases, pcs, total_units, purchase_price, selling_price, total_cost, total_revenue,
      commission_amt, discount_amt, shop_id, customer_id, note, created_at,
      rule_case_size, rule_bonus_cases_req, rule_bonus_free_units, rule_bonus_free_money)
  SELECT p_biz, (r->>'tx_id')::uuid, r->>'type', COALESCE(r->>'sr_id',''), COALESCE(r->>'sr_name',''),
         (r->>'date')::date, COALESCE(r->>'slip_no',''), r->>'product_id', COALESCE(r->>'product_name',''), COALESCE(r->>'sku',''),
         COALESCE((r->>'cases')::numeric,0), COALESCE((r->>'pcs')::numeric,0), COALESCE((r->>'total_units')::numeric,0),
         COALESCE((r->>'purchase_price')::numeric,0), COALESCE((r->>'selling_price')::numeric,0),
         COALESCE((r->>'total_cost')::numeric,0), COALESCE((r->>'total_revenue')::numeric,0),
         COALESCE((r->>'commission_amt')::numeric,0), COALESCE((r->>'discount_amt')::numeric,0),
         COALESCE(r->>'shop_id',''), COALESCE(r->>'customer_id',''), COALESCE(r->>'note',''),
         COALESCE((r->>'created_at')::timestamptz, NOW()),
         (r->>'rule_case_size')::numeric, (r->>'rule_bonus_cases_req')::numeric,
         (r->>'rule_bonus_free_units')::numeric, (r->>'rule_bonus_free_money')::numeric
    FROM jsonb_array_elements(p_rows) AS r;
$$;
GRANT EXECUTE ON FUNCTION insert_tx_rows(UUID, JSONB) TO service_role;

-- ═══════════════ SHOP DUES ═══════════════
-- Apply money (or goods credit) to ONE shop's open dues, oldest first. Returns what was applied.
--   p_kind 'cash'   → the shop paid; 'return' → the shop handed goods back (no cash moves)
CREATE OR REPLACE FUNCTION shop_apply_payment(p_biz UUID, p_shop_id TEXT, p_amount NUMERIC, p_date DATE, p_kind TEXT, p_note TEXT)
RETURNS NUMERIC LANGUAGE plpgsql AS $$
DECLARE
  r        RECORD;
  v_left   NUMERIC := ROUND(COALESCE(p_amount, 0), 2);
  v_take   NUMERIC;
  v_applied NUMERIC := 0;
  v_paid   NUMERIC;
BEGIN
  FOR r IN SELECT * FROM due_calendar
            WHERE business_id = p_biz AND shop_id = p_shop_id AND status <> 'cleared' AND amount - paid_amount > 0.004
            ORDER BY due_date, created_at, id FOR UPDATE
  LOOP
    EXIT WHEN v_left <= 0.004;
    v_take := LEAST(v_left, ROUND(r.amount - r.paid_amount, 2));
    v_paid := ROUND(r.paid_amount + v_take, 4);
    UPDATE due_calendar
       SET paid_amount = v_paid,
           status = CASE WHEN r.amount - v_paid <= 0.004 THEN 'cleared' ELSE 'partial' END,
           cleared_date = CASE WHEN r.amount - v_paid <= 0.004 THEN p_date ELSE NULL END
     WHERE id = r.id;
    INSERT INTO due_collections (business_id, due_id, shop_id, shop_name, date, amount, kind, note)
      VALUES (p_biz, r.id::text, r.shop_id, r.shop_name, p_date, v_take, p_kind, COALESCE(p_note, ''));
    v_left := v_left - v_take;
    v_applied := v_applied + v_take;
  END LOOP;
  RETURN v_applied;
END;
$$;
GRANT EXECUTE ON FUNCTION shop_apply_payment(UUID, TEXT, NUMERIC, DATE, TEXT, TEXT) TO service_role;

-- Point sale to a shop / customer: goods out + the due row (always written, paid or not) in ONE transaction.
CREATE OR REPLACE FUNCTION create_shop_sale(p_biz UUID, p_rows JSONB, p_due JSONB)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_due due_calendar%ROWTYPE;
BEGIN
  PERFORM insert_tx_rows(p_biz, p_rows);
  INSERT INTO due_calendar (business_id, id, tx_id, dsr_id, dsr_name, client_type, shop_id, shop_name, due_date, entry_date,
      amount, paid_amount, initial_paid, note, status, cleared_date, created_at)
  VALUES (p_biz, (p_due->>'id')::uuid, p_due->>'tx_id', COALESCE(p_due->>'dsr_id',''), COALESCE(p_due->>'dsr_name',''),
      COALESCE(p_due->>'client_type','shop'), COALESCE(p_due->>'shop_id',''), COALESCE(p_due->>'shop_name',''),
      (p_due->>'due_date')::date, (p_due->>'entry_date')::date,
      COALESCE((p_due->>'amount')::numeric,0), COALESCE((p_due->>'paid_amount')::numeric,0),
      COALESCE((p_due->>'paid_amount')::numeric,0),
      COALESCE(p_due->>'note',''), COALESCE(p_due->>'status','pending'),
      (p_due->>'cleared_date')::date, COALESCE((p_due->>'created_at')::timestamptz, NOW()))
  RETURNING * INTO v_due;
  RETURN to_jsonb(v_due);
END;
$$;
GRANT EXECUTE ON FUNCTION create_shop_sale(UUID, JSONB, JSONB) TO service_role;

-- Goods handed back by a shop: stock +, and the shop's open due goes down by the value (oldest first).
CREATE OR REPLACE FUNCTION create_shop_return(p_biz UUID, p_rows JSONB, p_shop_id TEXT, p_credit NUMERIC, p_date DATE, p_note TEXT)
RETURNS NUMERIC LANGUAGE plpgsql AS $$
DECLARE v_applied NUMERIC;
BEGIN
  PERFORM insert_tx_rows(p_biz, p_rows);
  v_applied := shop_apply_payment(p_biz, p_shop_id, p_credit, p_date, 'return', p_note);
  RETURN v_applied;
END;
$$;
GRANT EXECUTE ON FUNCTION create_shop_return(UUID, JSONB, TEXT, NUMERIC, DATE, TEXT) TO service_role;

-- ═══════════════ DAY-END SLIP — everything the DSR handed in, saved in ONE transaction ═══════════════
--   p = { slip:{...}, returns:[tx rows], damages:[tx rows], claims:[dmg_claims rows], payment:{...}|null }
CREATE OR REPLACE FUNCTION save_day_end(p_biz UUID, p JSONB)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  v_slip  dayend_slips%ROWTYPE;
  s       JSONB := p->'slip';
  pay     JSONB := p->'payment';
  v_no    TEXT;
  v_pay   UUID := NULL;
BEGIN
  v_no := 'SL-' || LPAD(next_counter(p_biz, 'slip')::text, 6, '0');

  IF jsonb_typeof(p->'returns') = 'array' AND jsonb_array_length(p->'returns') > 0 THEN
    PERFORM insert_tx_rows(p_biz, p->'returns');
  END IF;
  IF jsonb_typeof(p->'damages') = 'array' AND jsonb_array_length(p->'damages') > 0 THEN
    PERFORM insert_tx_rows(p_biz, p->'damages');
    INSERT INTO dmg_claims (business_id, tx_id, product_id, product_name, sku, total_units, purchase_price, total_cost,
                            date, sr_id, sr_name, status, created_at)
    SELECT p_biz, c->>'tx_id', c->>'product_id', COALESCE(c->>'product_name',''), COALESCE(c->>'sku',''),
           COALESCE((c->>'total_units')::numeric,0), COALESCE((c->>'purchase_price')::numeric,0),
           COALESCE((c->>'total_cost')::numeric,0), (c->>'date')::date,
           COALESCE(c->>'sr_id',''), COALESCE(c->>'sr_name',''), 'pending', COALESCE((c->>'created_at')::timestamptz, NOW())
      FROM jsonb_array_elements(p->'claims') AS c;
  END IF;

  IF pay IS NOT NULL AND jsonb_typeof(pay) = 'object' THEN
    v_pay := gen_random_uuid();
    INSERT INTO sr_payments (business_id, id, sr_id, sr_name, date, amount, cash_amount, commission_amt, discount_amt, damage_amt, bonus_amt, other_amt, note, created_at)
    VALUES (p_biz, v_pay, pay->>'sr_id', COALESCE(pay->>'sr_name',''), (pay->>'date')::date,
            COALESCE((pay->>'amount')::numeric,0), COALESCE((pay->>'cash_amount')::numeric,0),
            COALESCE((pay->>'commission_amt')::numeric,0), COALESCE((pay->>'discount_amt')::numeric,0),
            COALESCE((pay->>'damage_amt')::numeric,0), COALESCE((pay->>'bonus_amt')::numeric,0), COALESCE((pay->>'other_amt')::numeric,0),
            COALESCE(pay->>'note',''), COALESCE((pay->>'created_at')::timestamptz, NOW()));
  END IF;

  INSERT INTO dayend_slips (business_id, slip_no, dsr_id, dsr_name, date, given_amt, return_amt, damage_amt, comm_amt, disc_amt, bonus_amt, other_amt, details,
                            expected_cash, cash_amt, due_before, due_after, note, return_tx_id, damage_tx_id, payment_id, created_at)
  VALUES (p_biz, v_no, s->>'dsr_id', COALESCE(s->>'dsr_name',''), (s->>'date')::date,
          COALESCE((s->>'given_amt')::numeric,0), COALESCE((s->>'return_amt')::numeric,0), COALESCE((s->>'damage_amt')::numeric,0),
          COALESCE((s->>'comm_amt')::numeric,0), COALESCE((s->>'disc_amt')::numeric,0),
          COALESCE((s->>'bonus_amt')::numeric,0), COALESCE((s->>'other_amt')::numeric,0), COALESCE(s->'details','{}'::jsonb),
          COALESCE((s->>'expected_cash')::numeric,0), COALESCE((s->>'cash_amt')::numeric,0),
          COALESCE((s->>'due_before')::numeric,0), COALESCE((s->>'due_after')::numeric,0),
          COALESCE(s->>'note',''), COALESCE(s->>'return_tx_id',''), COALESCE(s->>'damage_tx_id',''),
          COALESCE(v_pay::text,''), COALESCE((s->>'created_at')::timestamptz, NOW()))
  RETURNING * INTO v_slip;
  RETURN to_jsonb(v_slip);
END;
$$;
GRANT EXECUTE ON FUNCTION save_day_end(UUID, JSONB) TO service_role;

-- ═══════════════ TOTALS (summed inside Postgres, per business) ═══════════════
-- DSR / SO due = (Σ give − Σ return) − Σ payments
CREATE OR REPLACE FUNCTION dsr_due_totals(p_biz UUID, p_sr_ids TEXT[] DEFAULT NULL)
RETURNS TABLE (sr_id TEXT, given_rev NUMERIC, return_rev NUMERIC, given_units NUMERIC, return_units NUMERIC, paid NUMERIC)
LANGUAGE sql STABLE AS $$
  WITH t AS (
    SELECT tx.sr_id,
           COALESCE(SUM(CASE WHEN tx.type = 'give'   THEN tx.total_revenue END), 0) AS given_rev,
           COALESCE(SUM(CASE WHEN tx.type = 'return' THEN tx.total_revenue END), 0) AS return_rev,
           COALESCE(SUM(CASE WHEN tx.type = 'give'   THEN tx.total_units   END), 0) AS given_units,
           COALESCE(SUM(CASE WHEN tx.type = 'return' THEN tx.total_units   END), 0) AS return_units
      FROM transactions tx
     WHERE tx.business_id = p_biz AND tx.type IN ('give', 'return') AND tx.sr_id <> ''
       AND (p_sr_ids IS NULL OR tx.sr_id = ANY (p_sr_ids))
     GROUP BY tx.sr_id
  ), p AS (
    SELECT sp.sr_id, COALESCE(SUM(sp.amount), 0) AS paid
      FROM sr_payments sp
     WHERE sp.business_id = p_biz AND sp.sr_id <> '' AND (p_sr_ids IS NULL OR sp.sr_id = ANY (p_sr_ids))
     GROUP BY sp.sr_id
  )
  SELECT COALESCE(t.sr_id, p.sr_id), COALESCE(t.given_rev, 0), COALESCE(t.return_rev, 0),
         COALESCE(t.given_units, 0), COALESCE(t.return_units, 0), COALESCE(p.paid, 0)
    FROM t FULL OUTER JOIN p ON p.sr_id = t.sr_id;
$$;
GRANT EXECUTE ON FUNCTION dsr_due_totals(UUID, TEXT[]) TO service_role;

-- sale = (give + point_sale) − (return + point return)
CREATE OR REPLACE FUNCTION sales_summary(p_biz UUID, p_from DATE, p_to DATE)
RETURNS TABLE (out_rev NUMERIC, in_rev NUMERIC, out_cost NUMERIC, in_cost NUMERIC, out_units NUMERIC, in_units NUMERIC)
LANGUAGE sql STABLE AS $$
  SELECT
    COALESCE(SUM(CASE WHEN t.type IN ('give','point_sale') THEN t.total_revenue END), 0),
    COALESCE(SUM(CASE WHEN t.type IN ('return','point_damage_return') THEN t.total_revenue END), 0),
    COALESCE(SUM(CASE WHEN t.type IN ('give','point_sale') THEN t.total_cost END), 0),
    COALESCE(SUM(CASE WHEN t.type IN ('return','point_damage_return') THEN t.total_cost END), 0),
    COALESCE(SUM(CASE WHEN t.type IN ('give','point_sale') THEN t.total_units END), 0),
    COALESCE(SUM(CASE WHEN t.type IN ('return','point_damage_return') THEN t.total_units END), 0)
  FROM transactions t
  WHERE t.business_id = p_biz AND t.date BETWEEN p_from AND p_to
    AND t.type IN ('give','return','point_sale','point_damage_return');
$$;
GRANT EXECUTE ON FUNCTION sales_summary(UUID, DATE, DATE) TO service_role;

-- the deductions shown beside NET profit (commission/discount = day-end slips + point-sale bills)
CREATE OR REPLACE FUNCTION profit_extras(p_biz UUID, p_from DATE, p_to DATE)
RETURNS TABLE (commission NUMERIC, discount NUMERIC, damage_loss NUMERIC, expenses NUMERIC)
LANGUAGE sql STABLE AS $$
  SELECT
    (SELECT COALESCE(SUM(p.commission_amt), 0) FROM sr_payments p WHERE p.business_id = p_biz AND p.date BETWEEN p_from AND p_to)
  + (SELECT COALESCE(SUM(t.commission_amt), 0) FROM transactions t WHERE t.business_id = p_biz AND t.type = 'point_sale' AND t.date BETWEEN p_from AND p_to),
    (SELECT COALESCE(SUM(p.discount_amt + p.bonus_amt + p.other_amt), 0) FROM sr_payments p WHERE p.business_id = p_biz AND p.date BETWEEN p_from AND p_to)
  + (SELECT COALESCE(SUM(t.discount_amt), 0) FROM transactions t WHERE t.business_id = p_biz AND t.type = 'point_sale' AND t.date BETWEEN p_from AND p_to),
    (SELECT COALESCE(SUM(c.total_cost),     0) FROM dmg_claims  c WHERE c.business_id = p_biz AND c.date BETWEEN p_from AND p_to),
    (SELECT COALESCE(SUM(e.amount),         0) FROM exp_records e WHERE e.business_id = p_biz AND e.date BETWEEN p_from AND p_to);
$$;
GRANT EXECUTE ON FUNCTION profit_extras(UUID, DATE, DATE) TO service_role;

-- net pieces per product + the bonus rule that was valid on each row
CREATE OR REPLACE FUNCTION bonus_net_units(p_biz UUID, p_from DATE, p_to DATE)
RETURNS TABLE (product_id TEXT, case_size NUMERIC, bonus_cases_req NUMERIC, bonus_free_units NUMERIC,
               bonus_free_money NUMERIC, net_units NUMERIC, out_units NUMERIC, out_cost NUMERIC)
LANGUAGE sql STABLE AS $$
  SELECT t.product_id, t.rule_case_size, t.rule_bonus_cases_req, t.rule_bonus_free_units, t.rule_bonus_free_money,
         SUM(CASE WHEN t.type IN ('give','point_sale') THEN t.total_units ELSE -t.total_units END),
         SUM(CASE WHEN t.type IN ('give','point_sale') THEN t.total_units ELSE 0 END),
         SUM(CASE WHEN t.type IN ('give','point_sale') THEN t.total_cost  ELSE 0 END)
    FROM transactions t
   WHERE t.business_id = p_biz AND t.date BETWEEN p_from AND p_to
     AND t.type IN ('give','return','point_sale','point_damage_return')
   GROUP BY 1, 2, 3, 4, 5;
$$;
GRANT EXECUTE ON FUNCTION bonus_net_units(UUID, DATE, DATE) TO service_role;

-- per DSR / SO totals for a date range
CREATE OR REPLACE FUNCTION sr_sales_totals(p_biz UUID, p_from DATE, p_to DATE)
RETURNS TABLE (sr_id TEXT, give_rev NUMERIC, give_units NUMERIC, ret_rev NUMERIC, ret_units NUMERIC, dmg_rev NUMERIC, dmg_units NUMERIC)
LANGUAGE sql STABLE AS $$
  SELECT t.sr_id,
    COALESCE(SUM(CASE WHEN t.type = 'give'   THEN t.total_revenue END), 0),
    COALESCE(SUM(CASE WHEN t.type = 'give'   THEN t.total_units   END), 0),
    COALESCE(SUM(CASE WHEN t.type = 'return' THEN t.total_revenue END), 0),
    COALESCE(SUM(CASE WHEN t.type = 'return' THEN t.total_units   END), 0),
    COALESCE(SUM(CASE WHEN t.type = 'damage' THEN t.total_revenue END), 0),
    COALESCE(SUM(CASE WHEN t.type = 'damage' THEN t.total_units   END), 0)
  FROM transactions t
  WHERE t.business_id = p_biz AND t.date BETWEEN p_from AND p_to AND t.sr_id <> '' AND t.type IN ('give','return','damage')
  GROUP BY t.sr_id;
$$;
GRANT EXECUTE ON FUNCTION sr_sales_totals(UUID, DATE, DATE) TO service_role;

-- net pieces per product for a date range
CREATE OR REPLACE FUNCTION product_sales_totals(p_biz UUID, p_from DATE, p_to DATE)
RETURNS TABLE (product_id TEXT, net_units NUMERIC)
LANGUAGE sql STABLE AS $$
  SELECT t.product_id,
         SUM(CASE WHEN t.type IN ('give','point_sale') THEN t.total_units ELSE -t.total_units END)
    FROM transactions t
   WHERE t.business_id = p_biz AND t.date BETWEEN p_from AND p_to
     AND t.type IN ('give','return','point_sale','point_damage_return')
   GROUP BY t.product_id;
$$;
GRANT EXECUTE ON FUNCTION product_sales_totals(UUID, DATE, DATE) TO service_role;

-- open due per shop
CREATE OR REPLACE FUNCTION shop_due_totals(p_biz UUID, p_shop_ids TEXT[] DEFAULT NULL)
RETURNS TABLE (shop_id TEXT, due NUMERIC)
LANGUAGE sql STABLE AS $$
  SELECT d.shop_id, SUM(GREATEST(0, d.amount - d.paid_amount))
    FROM due_calendar d
   WHERE d.business_id = p_biz AND d.status <> 'cleared' AND d.shop_id <> ''
     AND (p_shop_ids IS NULL OR d.shop_id = ANY (p_shop_ids))
   GROUP BY d.shop_id;
$$;
GRANT EXECUTE ON FUNCTION shop_due_totals(UUID, TEXT[]) TO service_role;

-- ═══════════════ SECURITY: only the server (service_role) may touch data ═══════════════
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['businesses','biz_counters','products','srs','transactions','dmg_claims','bonus','sr_payments','dayend_slips',
                           'exp_cats','exp_records','shops','due_calendar','due_collections','user_passwords','app_settings',
                           'important_contacts','audit_log','idempotency_keys','company_receipts','company_deposits']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO service_role USING (true) WITH CHECK (true)', 'srv_' || t, t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO anon USING (false)', 'anon_deny_' || t, t);
  END LOOP;
END
$$;

-- ═══════════════ PRICE HISTORY + FREEZE MARKERS (merged from v11) ═══════════════
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

-- ═══════════════ PHOTO BUCKET (public, name must be "thumbs") ═══════════════
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (id, name, public) VALUES ('thumbs', 'thumbs', true)
      ON CONFLICT (id) DO UPDATE SET public = true;
  END IF;
END
$$;

-- ═══════════════ THE ONE OWNER LOGIN  (PIN 12345 → forced change at first login) ═══════════════
INSERT INTO user_passwords (user_key, user_name, role, password, must_change_pw)
VALUES ('owner', 'Owner', 'owner', encode(sha256(convert_to('axiion:12345', 'UTF8')), 'hex'), true)
ON CONFLICT (user_key) DO UPDATE SET password = EXCLUDED.password, must_change_pw = true;
