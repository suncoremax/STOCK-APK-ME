-- ═══════════════════════════════════════════════════════════════════
-- AXIION DMS — MANUAL (OWNER-ONLY) EDITION  ·  schema.sql
--
--   ONE file = the complete database. Run it ONCE in the Supabase SQL
--   editor on a brand-new, empty project. It creates:
--     tables · indexes · functions · triggers · security policies ·
--     the public "thumbs" photo bucket · the 35 starter products ·
--     the single Owner login (PIN 12345, must be changed at first login).
--
--   ⚠ It DROPS and re-creates every table it owns. It refuses to run
--     if the database already holds transactions, staff or shops, so
--     it can never wipe a live business by accident.
-- ═══════════════════════════════════════════════════════════════════
DO $$
DECLARE n BIGINT;
BEGIN
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

DROP TABLE IF EXISTS dayend_slips, due_collections, due_calendar, shops, exp_records, exp_cats,
  sr_payments, bonus, dmg_claims, transactions, srs, sr_display_seq, products, user_passwords,
  app_settings, important_contacts, audit_log, idempotency_keys CASCADE;
DROP SEQUENCE IF EXISTS shop_no_seq;
DROP SEQUENCE IF EXISTS slip_no_seq;
-- ───────────────────────── PRODUCTS ─────────────────────────
CREATE TABLE products (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
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
  name        TEXT        NOT NULL,
  phone       TEXT        DEFAULT '',
  area        TEXT        DEFAULT '',
  role        TEXT        DEFAULT 'dsr' CHECK (role IN ('dsr', 'so')),
  display_no  INTEGER,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_srs_role ON srs(role);
CREATE UNIQUE INDEX idx_srs_role_display_no ON srs(role, display_no);

CREATE TABLE sr_display_seq (
  role    TEXT    PRIMARY KEY,
  next_no INTEGER NOT NULL DEFAULT 1
);
INSERT INTO sr_display_seq (role, next_no) VALUES ('dsr', 1), ('so', 1);

CREATE OR REPLACE FUNCTION next_sr_display_no(p_role TEXT) RETURNS INTEGER AS $$
DECLARE v INTEGER;
BEGIN
  UPDATE sr_display_seq SET next_no = next_no + 1 WHERE role = p_role RETURNING next_no - 1 INTO v;
  IF v IS NULL THEN
    INSERT INTO sr_display_seq(role, next_no) VALUES (p_role, 2) RETURNING next_no - 1 INTO v;
  END IF;
  RETURN v;
END;
$$ LANGUAGE plpgsql;
GRANT EXECUTE ON FUNCTION next_sr_display_no(TEXT) TO service_role;

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
  sr_id          TEXT          NOT NULL,
  sr_name        TEXT          DEFAULT '',
  date           DATE          NOT NULL,
  amount         NUMERIC(14,4) DEFAULT 0,      -- cash + commission + discount + damage
  cash_amount    NUMERIC(14,4) DEFAULT 0,
  commission_amt NUMERIC(14,4) DEFAULT 0,
  discount_amt   NUMERIC(14,4) DEFAULT 0,
  damage_amt     NUMERIC(14,4) DEFAULT 0,
  note           TEXT          DEFAULT '',
  created_at     TIMESTAMPTZ   DEFAULT NOW()
);
CREATE INDEX idx_pay_sr      ON sr_payments(sr_id);
CREATE INDEX idx_pay_date    ON sr_payments(date);
CREATE INDEX idx_pay_sr_date ON sr_payments(sr_id, date);

-- ───────────────────────── DAY-END SLIPS (one per DSR per hand-in) ─────────────────────────
CREATE SEQUENCE slip_no_seq START 1;
CREATE TABLE dayend_slips (
  id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  slip_no        TEXT          NOT NULL UNIQUE,
  dsr_id         TEXT          NOT NULL,
  dsr_name       TEXT          DEFAULT '',
  date           DATE          NOT NULL,
  given_amt      NUMERIC(14,4) DEFAULT 0,      -- stock the DSR carried that day (at his price)
  return_amt     NUMERIC(14,4) DEFAULT 0,      -- unsold goods handed back
  damage_amt     NUMERIC(14,4) DEFAULT 0,      -- damaged goods handed in
  comm_amt       NUMERIC(14,4) DEFAULT 0,
  disc_amt       NUMERIC(14,4) DEFAULT 0,
  expected_cash  NUMERIC(14,4) DEFAULT 0,      -- given − return − damage − commission − discount
  cash_amt       NUMERIC(14,4) DEFAULT 0,      -- cash the owner actually received
  due_before     NUMERIC(14,4) DEFAULT 0,
  due_after      NUMERIC(14,4) DEFAULT 0,
  note           TEXT          DEFAULT '',
  return_tx_id   TEXT          DEFAULT '',
  damage_tx_id   TEXT          DEFAULT '',
  payment_id     TEXT          DEFAULT '',
  created_at     TIMESTAMPTZ   DEFAULT NOW()
);
CREATE INDEX idx_slips_dsr_date ON dayend_slips(dsr_id, date);
CREATE INDEX idx_slips_date     ON dayend_slips(date);

-- ───────────────────────── EXPENSES ─────────────────────────
CREATE TABLE exp_cats (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT        NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE exp_records (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id   TEXT          NOT NULL,
  category_name TEXT          DEFAULT '',
  date          DATE          NOT NULL,
  amount        NUMERIC(14,2) DEFAULT 0,
  note          TEXT          DEFAULT '',
  created_at    TIMESTAMPTZ   DEFAULT NOW()
);
CREATE INDEX idx_exp_date ON exp_records(date);

-- ───────────────────────── SHOPS ─────────────────────────
CREATE SEQUENCE shop_no_seq START 1;
CREATE OR REPLACE FUNCTION next_shop_no() RETURNS INTEGER AS $$
BEGIN RETURN nextval('shop_no_seq'); END;
$$ LANGUAGE plpgsql;
GRANT EXECUTE ON FUNCTION next_shop_no() TO service_role;

CREATE TABLE shops (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_no            TEXT        NOT NULL UNIQUE,      -- SHOP-0001
  name               TEXT        NOT NULL,
  keeper_name        TEXT        DEFAULT '',
  phone              TEXT        DEFAULT '',
  address            TEXT        DEFAULT '',
  assigned_dsr_id    TEXT        DEFAULT '',           -- optional: which DSR normally serves the shop
  assigned_dsr_name  TEXT        DEFAULT '',
  created_at         TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_shops_dsr        ON shops(assigned_dsr_id);
CREATE INDEX idx_shops_created    ON shops(created_at DESC);
CREATE INDEX idx_shops_name_trgm  ON shops USING gin (name        gin_trgm_ops);
CREATE INDEX idx_shops_phone_trgm ON shops USING gin (phone       gin_trgm_ops);
CREATE INDEX idx_shops_keeper_trgm ON shops USING gin (keeper_name gin_trgm_ops);

-- ───────────────────────── SHOP / CUSTOMER DUES ─────────────────────────
CREATE TABLE due_calendar (
  id           UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
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
  id                   INTEGER     PRIMARY KEY DEFAULT 1,
  shop_name            TEXT        NOT NULL DEFAULT '',
  shop_address         TEXT        DEFAULT '',
  shop_phone           TEXT        DEFAULT '',
  distributor_name     TEXT        DEFAULT '',
  logo_text            TEXT        DEFAULT '',
  block_negative_stock BOOLEAN     NOT NULL DEFAULT TRUE,
  set_by               TEXT        DEFAULT '',
  updated_at           TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT app_settings_single_row CHECK (id = 1)
);
INSERT INTO app_settings (id) VALUES (1);

CREATE TABLE important_contacts (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT        NOT NULL DEFAULT '',
  role         TEXT        NOT NULL DEFAULT '',
  phone_number TEXT        NOT NULL DEFAULT '',
  special_note TEXT        NOT NULL DEFAULT '',
  created_by   TEXT        NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE audit_log (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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

-- ───────── 35 starter products (stock 0 — record real stock with "কেনা") ─────────
INSERT INTO products (id,name,sku,case_size,unit_type,case_price,case_purchase_price,purchase_price,selling_price,bonus_free_units,bonus_cases_req,bonus_free_money,low_stock_alert,thumb,category,sort_order,current_stock) VALUES
  ('b8306428-3cfd-4dae-94b7-215a139a1022','স্পীড ২৫০ মিলি','597',24,'কেস',597.0000,558.4640,23.2693,24.8750,1.5000,1.00,0.0000,24000.00,'','',1,0),
  ('06964bc8-61fe-45ff-b4ca-17620962be3b','স্প্রীড ২০০ মিলি','493.84',24,'কেস',493.8400,470.7600,19.6150,20.5767,2.0000,1.00,0.0000,4800.00,'','',2,0),
  ('06995d74-8d0c-4b09-9549-59690bc996c8','মোজো ২০০০ মিলি','594',6,'কেস',594.0000,581.5380,96.9230,99.0000,0.0000,1.00,0.0000,600.00,'','',3,0),
  ('cd6b9e26-e997-40b2-9558-a35fd57c34ff','ক্লেমন ২০০০ মিলি','587',6,'কেস',587.0000,581.5380,96.9230,97.8333,0.0000,1.00,0.0000,300.00,'','',4,0),
  ('ade16f1a-19a6-4e59-98f0-b2d341a8e72b','আফি অরেঞ্জ ২৫০ মিলি','406',24,'কেস',406.0000,383.0760,15.9615,16.9167,2.0000,1.00,0.0000,600.00,'','',5,0),
  ('3162952c-7017-4fa5-84be-d3a233d654b3','ক্লিয়ার আপ ২৫০ মিলি','406',24,'কেস',406.0000,383.0760,15.9615,16.9167,2.0000,1.00,0.0000,1200.00,'','',6,0),
  ('cb7782a3-d78d-4247-b539-b4e5a2281a4d','লেমু ২৫০ মিলি','410',24,'কেস',410.0000,387.6920,16.1538,17.0833,2.0000,1.00,0.0000,600.00,'','',7,0),
  ('df14f162-9d22-4abe-8716-3c91a7c9e3f7','ফিজো ২৫০ মিলি','600',24,'কেস',600.0000,565.8460,23.5769,25.0000,2.0000,1.00,0.0000,600.00,'','',8,0),
  ('72f2c73d-25cf-475f-9bc0-5d1987c87db5','প্যাকেট জুস ১৮০ মিলি','748',48,'কেস',748.0000,706.0000,14.7083,15.5833,4.0000,1.00,0.0000,480.00,'','',9,0),
  ('73b12f3b-9b31-4ae8-a5af-de47d90e2261','আফি জুস ১৮০ মিলি','392',24,'কেস',392.0000,369.2300,15.3846,16.3333,2.0000,1.00,0.0000,240.00,'','',10,0),
  ('47bac1ed-2b93-4a6d-8a6b-ee5cfce0f352','আফি জুস ২৫০ মিলি','457',24,'কেস',457.0000,430.1880,17.9245,19.0417,2.5000,1.00,0.0000,600.00,'','',11,0),
  ('0e582280-af50-4d72-a80f-014c81dae6ae','আফি জুস ৫০০ মিলি','443',12,'কেস',443.0000,417.2300,34.7692,36.9167,1.0000,1.00,0.0000,120.00,'','',12,0),
  ('1a034f0d-6c3d-49ec-94ce-9a50c9094fdc','আফি জুস ১০০০ মিলি','420',6,'কেস',420.0000,496.0000,82.6667,70.0000,0.5000,1.00,0.0000,60.00,'','',13,0),
  ('90e5121d-5890-4431-928e-ecb91a250eae','স্পা ৩৩০ মিলি','170',24,'কেস',170.0000,158.0000,6.5833,7.0833,0.0000,1.00,0.0000,120.00,'','',14,0),
  ('faa00431-e1eb-42f8-9ce6-49e249267c5f','স্পা ৫০০ মিলি','220',24,'কেস',220.0000,206.0000,8.5833,9.1667,0.0000,1.00,0.0000,1200.00,'','',15,0),
  ('dfbbb78f-dd1a-4765-9e17-b1b4d2a563f8','স্পা ১০০০ মিলি','220',12,'কেস',220.0000,204.0000,17.0000,18.3333,1.0000,1.00,0.0000,600.00,'','',16,0),
  ('84fda4fe-3d3f-4428-8f3c-21ec5913ea32','স্পা ২০০০ মিলি','157',6,'কেস',157.0000,144.9230,24.1538,26.1667,0.5000,1.00,0.0000,300.00,'','',17,0),
  ('686921f3-ada3-4a30-bf5a-7cd767b7a89d','স্পা ৫০০০ মিলি','130',2,'কেস',130.0000,120.0000,60.0000,65.0000,0.0000,1.00,0.0000,20.00,'','',18,0),
  ('45c90f8c-00c9-4640-84d0-0d6ea29f1a51','মোজোরেলা চিপস','384',48,'পলি',384.0000,372.9230,7.7692,8.0000,4.0000,1.00,0.0000,720.00,'','',19,0),
  ('f04d48a7-ff2a-4c85-9f4d-6679a3350508','ও পটাটা চিপস','310',20,'পলি',310.0000,291.8180,14.5909,15.5000,2.0000,1.00,0.0000,100.00,'','',20,0),
  ('e8269625-67d3-4a5c-94dc-7a084346f387','সুইট টোস্ট','300',6,'কার্টুন',300.0000,288.0000,48.0000,50.0000,0.5000,1.00,0.0000,30.00,'','',21,0),
  ('e3bf2bd6-f5b0-4bde-9e8a-89603f17fb96','প্লেইন টোস্ট','276',6,'কার্টুন',276.0000,261.2300,43.5383,46.0000,0.5000,1.00,0.0000,30.00,'','',22,0),
  ('4e4b3a38-10af-41ac-b187-df8fd044dda6','আফি ম্যাংগো চাটনি','48',12,'ডজন',48.0000,46.0270,3.8356,4.0000,0.5000,1.00,0.0000,420.00,'','',23,0),
  ('9007f250-440d-45cf-a977-34487a00f7b7','আফি জলপাই চাটনি','48',12,'ডজন',48.0000,46.0270,3.8356,4.0000,0.5000,1.00,0.0000,840.00,'','',24,0),
  ('b179345d-d5c6-4214-9734-09592384eed3','আফি তেতুল চাটনি','48',12,'ডজন',48.0000,46.0270,3.8356,4.0000,0.5000,1.00,0.0000,840.00,'','',25,0),
  ('a3a4403d-5916-41be-b2b7-7d1779e5e330','আফি ম্যাঙ্গো বার','120',30,'কেস',120.0000,115.9090,3.8636,4.0000,3.0000,1.00,0.0000,1500.00,'','',26,0),
  ('a382406c-e2cc-42ce-8f28-7d115389d83a','আভি ডাল ভাজা','192',48,'কেস',192.0000,47.2500,0.9844,4.0000,0.0000,1.00,0.0000,384.00,'','',27,0),
  ('5848e8c6-dc19-4da0-86d0-41fc6bfb088f','আফি চানাচুর','752',96,'পলি',752.0000,710.7690,7.4038,7.8333,4.0000,1.00,0.0000,288.00,'','',28,0),
  ('d5734163-8e6e-4620-8646-1210f7bd54ba','মোজো ৩৩০ মিলি ক্যান','1152',24,'কেস',1152.0000,1089.2300,45.3846,48.0000,2.0000,1.00,0.0000,72.00,'','',29,0),
  ('3461f836-14af-4152-b8aa-d9e73bcd5a7c','ওয়াইল্ড ব্রু ২৫০ মিলি','1329',24,'কেস',1329.0000,1240.6150,51.6923,55.3750,2.0000,1.00,0.0000,72.00,'','',30,0),
  ('f508de87-672f-4395-ac4e-807c5a7580cb','ওয়াইল্ড ব্রু ৩৩০ মিলি','1883',24,'কেস',1883.0000,1772.3070,73.8461,78.4583,2.0000,1.00,0.0000,72.00,'','',31,0),
  ('566f8b93-31bc-4da7-8cf6-b7c5f9bb0e1c','ওয়াইল্ড ব্রু ৩৩০ মিলি পিচ মল্ট','1883',24,'কেস',1883.0000,1772.3070,73.8461,78.4583,2.0000,1.00,0.0000,72.00,'','',32,0),
  ('5c4b207c-3c7e-43b5-b031-210569a91287','ওয়াইল্ড ব্রু ৩৩০ মিলি অ্যাপেল মল্ড','1883',24,'কেস',1883.0000,1772.3070,73.8461,78.4583,2.0000,1.00,0.0000,72.00,'','',33,0),
  ('b20eb0f7-ebec-4fd5-9f60-115cbd37927e','গ্রীন অ্যাপেল ২৫০ মিলি','1190',24,'কেস',1190.0000,1130.7690,47.1154,49.5833,2.0000,1.00,0.0000,120.00,'','',34,0),
  ('898f20a4-20f0-4ae1-9690-b32d7dfce32b','জিন্জার ২৫০ মিলি','1190',24,'কেস',1190.0000,1130.7690,47.1154,49.5833,2.0000,1.00,0.0000,120.00,'','',35,0)
ON CONFLICT (id) DO NOTHING;

-- ═══════════════ STOCK: one trigger keeps products.current_stock exact ═══════════════
-- Outgoing movements can never push stock below zero (switch: app_settings.block_negative_stock).
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
    guard := COALESCE((SELECT block_negative_stock FROM app_settings WHERE id = 1), TRUE);
    IF delta < 0 AND guard THEN
      UPDATE products SET current_stock = current_stock + delta
        WHERE id::text = NEW.product_id AND current_stock + delta >= 0;
      IF NOT FOUND AND EXISTS (SELECT 1 FROM products WHERE id::text = NEW.product_id) THEN
        RAISE EXCEPTION 'STOCK_NEGATIVE: not enough stock for product %', NEW.product_id;
      END IF;
    ELSE
      UPDATE products SET current_stock = current_stock + delta WHERE id::text = NEW.product_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_apply_stock_delta
  AFTER INSERT ON transactions
  FOR EACH ROW EXECUTE FUNCTION apply_stock_delta();

-- ═══════════════ shared helper: insert transaction rows from JSON ═══════════════
CREATE OR REPLACE FUNCTION insert_tx_rows(p_rows JSONB) RETURNS VOID
LANGUAGE sql AS $$
  INSERT INTO transactions (tx_id, type, sr_id, sr_name, date, slip_no, product_id, product_name, sku,
      cases, pcs, total_units, purchase_price, selling_price, total_cost, total_revenue,
      commission_amt, discount_amt, shop_id, customer_id, note, created_at,
      rule_case_size, rule_bonus_cases_req, rule_bonus_free_units, rule_bonus_free_money)
  SELECT (r->>'tx_id')::uuid, r->>'type', COALESCE(r->>'sr_id',''), COALESCE(r->>'sr_name',''),
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
GRANT EXECUTE ON FUNCTION insert_tx_rows(JSONB) TO service_role;

-- ═══════════════ SHOP DUES ═══════════════
-- Apply money (or goods credit) to ONE shop's open dues, oldest first. Returns what was applied.
--   p_kind 'cash'   → the shop paid; 'return' → the shop handed goods back (no cash moves)
CREATE OR REPLACE FUNCTION shop_apply_payment(p_shop_id TEXT, p_amount NUMERIC, p_date DATE, p_kind TEXT, p_note TEXT)
RETURNS NUMERIC LANGUAGE plpgsql AS $$
DECLARE
  r        RECORD;
  v_left   NUMERIC := ROUND(COALESCE(p_amount, 0), 2);
  v_take   NUMERIC;
  v_applied NUMERIC := 0;
  v_paid   NUMERIC;
BEGIN
  FOR r IN SELECT * FROM due_calendar
            WHERE shop_id = p_shop_id AND status <> 'cleared' AND amount - paid_amount > 0.004
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
    INSERT INTO due_collections (due_id, shop_id, shop_name, date, amount, kind, note)
      VALUES (r.id::text, r.shop_id, r.shop_name, p_date, v_take, p_kind, COALESCE(p_note, ''));
    v_left := v_left - v_take;
    v_applied := v_applied + v_take;
  END LOOP;
  RETURN v_applied;
END;
$$;
GRANT EXECUTE ON FUNCTION shop_apply_payment(TEXT, NUMERIC, DATE, TEXT, TEXT) TO service_role;

-- Point sale to a shop / customer: goods out + the due row (always written, paid or not) in ONE transaction.
CREATE OR REPLACE FUNCTION create_shop_sale(p_rows JSONB, p_due JSONB)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_due due_calendar%ROWTYPE;
BEGIN
  PERFORM insert_tx_rows(p_rows);
  INSERT INTO due_calendar (id, tx_id, dsr_id, dsr_name, client_type, shop_id, shop_name, due_date, entry_date,
      amount, paid_amount, initial_paid, note, status, cleared_date, created_at)
  VALUES ((p_due->>'id')::uuid, p_due->>'tx_id', COALESCE(p_due->>'dsr_id',''), COALESCE(p_due->>'dsr_name',''),
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
GRANT EXECUTE ON FUNCTION create_shop_sale(JSONB, JSONB) TO service_role;

-- Goods handed back by a shop: stock +, and the shop's open due goes down by the value (oldest first).
CREATE OR REPLACE FUNCTION create_shop_return(p_rows JSONB, p_shop_id TEXT, p_credit NUMERIC, p_date DATE, p_note TEXT)
RETURNS NUMERIC LANGUAGE plpgsql AS $$
DECLARE v_applied NUMERIC;
BEGIN
  PERFORM insert_tx_rows(p_rows);
  v_applied := shop_apply_payment(p_shop_id, p_credit, p_date, 'return', p_note);
  RETURN v_applied;
END;
$$;
GRANT EXECUTE ON FUNCTION create_shop_return(JSONB, TEXT, NUMERIC, DATE, TEXT) TO service_role;

-- ═══════════════ DAY-END SLIP — everything the DSR handed in, saved in ONE transaction ═══════════════
--   p = { slip:{...}, returns:[tx rows], damages:[tx rows], claims:[dmg_claims rows], payment:{...}|null }
CREATE OR REPLACE FUNCTION save_day_end(p JSONB)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  v_slip  dayend_slips%ROWTYPE;
  s       JSONB := p->'slip';
  pay     JSONB := p->'payment';
  v_no    TEXT;
  v_pay   UUID := NULL;
BEGIN
  v_no := 'SL-' || LPAD(nextval('slip_no_seq')::text, 6, '0');

  IF jsonb_typeof(p->'returns') = 'array' AND jsonb_array_length(p->'returns') > 0 THEN
    PERFORM insert_tx_rows(p->'returns');
  END IF;
  IF jsonb_typeof(p->'damages') = 'array' AND jsonb_array_length(p->'damages') > 0 THEN
    PERFORM insert_tx_rows(p->'damages');
    INSERT INTO dmg_claims (tx_id, product_id, product_name, sku, total_units, purchase_price, total_cost,
                            date, sr_id, sr_name, status, created_at)
    SELECT c->>'tx_id', c->>'product_id', COALESCE(c->>'product_name',''), COALESCE(c->>'sku',''),
           COALESCE((c->>'total_units')::numeric,0), COALESCE((c->>'purchase_price')::numeric,0),
           COALESCE((c->>'total_cost')::numeric,0), (c->>'date')::date,
           COALESCE(c->>'sr_id',''), COALESCE(c->>'sr_name',''), 'pending', COALESCE((c->>'created_at')::timestamptz, NOW())
      FROM jsonb_array_elements(p->'claims') AS c;
  END IF;

  IF pay IS NOT NULL AND jsonb_typeof(pay) = 'object' THEN
    v_pay := gen_random_uuid();
    INSERT INTO sr_payments (id, sr_id, sr_name, date, amount, cash_amount, commission_amt, discount_amt, damage_amt, note, created_at)
    VALUES (v_pay, pay->>'sr_id', COALESCE(pay->>'sr_name',''), (pay->>'date')::date,
            COALESCE((pay->>'amount')::numeric,0), COALESCE((pay->>'cash_amount')::numeric,0),
            COALESCE((pay->>'commission_amt')::numeric,0), COALESCE((pay->>'discount_amt')::numeric,0),
            COALESCE((pay->>'damage_amt')::numeric,0), COALESCE(pay->>'note',''), COALESCE((pay->>'created_at')::timestamptz, NOW()));
  END IF;

  INSERT INTO dayend_slips (slip_no, dsr_id, dsr_name, date, given_amt, return_amt, damage_amt, comm_amt, disc_amt,
                            expected_cash, cash_amt, due_before, due_after, note, return_tx_id, damage_tx_id, payment_id, created_at)
  VALUES (v_no, s->>'dsr_id', COALESCE(s->>'dsr_name',''), (s->>'date')::date,
          COALESCE((s->>'given_amt')::numeric,0), COALESCE((s->>'return_amt')::numeric,0), COALESCE((s->>'damage_amt')::numeric,0),
          COALESCE((s->>'comm_amt')::numeric,0), COALESCE((s->>'disc_amt')::numeric,0),
          COALESCE((s->>'expected_cash')::numeric,0), COALESCE((s->>'cash_amt')::numeric,0),
          COALESCE((s->>'due_before')::numeric,0), COALESCE((s->>'due_after')::numeric,0),
          COALESCE(s->>'note',''), COALESCE(s->>'return_tx_id',''), COALESCE(s->>'damage_tx_id',''),
          COALESCE(v_pay::text,''), COALESCE((s->>'created_at')::timestamptz, NOW()))
  RETURNING * INTO v_slip;
  RETURN to_jsonb(v_slip);
END;
$$;
GRANT EXECUTE ON FUNCTION save_day_end(JSONB) TO service_role;

-- ═══════════════ TOTALS (summed inside Postgres, not in JavaScript) ═══════════════
-- DSR / SO due = (Σ give − Σ return) − Σ payments
CREATE OR REPLACE FUNCTION dsr_due_totals(p_sr_ids TEXT[] DEFAULT NULL)
RETURNS TABLE (sr_id TEXT, given_rev NUMERIC, return_rev NUMERIC, given_units NUMERIC, return_units NUMERIC, paid NUMERIC)
LANGUAGE sql STABLE AS $$
  WITH t AS (
    SELECT tx.sr_id,
           COALESCE(SUM(CASE WHEN tx.type = 'give'   THEN tx.total_revenue END), 0) AS given_rev,
           COALESCE(SUM(CASE WHEN tx.type = 'return' THEN tx.total_revenue END), 0) AS return_rev,
           COALESCE(SUM(CASE WHEN tx.type = 'give'   THEN tx.total_units   END), 0) AS given_units,
           COALESCE(SUM(CASE WHEN tx.type = 'return' THEN tx.total_units   END), 0) AS return_units
      FROM transactions tx
     WHERE tx.type IN ('give', 'return') AND tx.sr_id <> ''
       AND (p_sr_ids IS NULL OR tx.sr_id = ANY (p_sr_ids))
     GROUP BY tx.sr_id
  ), p AS (
    SELECT sp.sr_id, COALESCE(SUM(sp.amount), 0) AS paid
      FROM sr_payments sp
     WHERE sp.sr_id <> '' AND (p_sr_ids IS NULL OR sp.sr_id = ANY (p_sr_ids))
     GROUP BY sp.sr_id
  )
  SELECT COALESCE(t.sr_id, p.sr_id), COALESCE(t.given_rev, 0), COALESCE(t.return_rev, 0),
         COALESCE(t.given_units, 0), COALESCE(t.return_units, 0), COALESCE(p.paid, 0)
    FROM t FULL OUTER JOIN p ON p.sr_id = t.sr_id;
$$;
GRANT EXECUTE ON FUNCTION dsr_due_totals(TEXT[]) TO service_role;

-- sale = (give + point_sale) − (return + point return)
CREATE OR REPLACE FUNCTION sales_summary(p_from DATE, p_to DATE)
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
  WHERE t.date BETWEEN p_from AND p_to
    AND t.type IN ('give','return','point_sale','point_damage_return');
$$;
GRANT EXECUTE ON FUNCTION sales_summary(DATE, DATE) TO service_role;

-- the deductions shown beside NET profit (commission/discount = day-end slips + point-sale bills)
CREATE OR REPLACE FUNCTION profit_extras(p_from DATE, p_to DATE)
RETURNS TABLE (commission NUMERIC, discount NUMERIC, damage_loss NUMERIC, expenses NUMERIC)
LANGUAGE sql STABLE AS $$
  SELECT
    (SELECT COALESCE(SUM(p.commission_amt), 0) FROM sr_payments p WHERE p.date BETWEEN p_from AND p_to)
  + (SELECT COALESCE(SUM(t.commission_amt), 0) FROM transactions t WHERE t.type = 'point_sale' AND t.date BETWEEN p_from AND p_to),
    (SELECT COALESCE(SUM(p.discount_amt), 0) FROM sr_payments p WHERE p.date BETWEEN p_from AND p_to)
  + (SELECT COALESCE(SUM(t.discount_amt), 0) FROM transactions t WHERE t.type = 'point_sale' AND t.date BETWEEN p_from AND p_to),
    (SELECT COALESCE(SUM(c.total_cost),     0) FROM dmg_claims  c WHERE c.date BETWEEN p_from AND p_to),
    (SELECT COALESCE(SUM(e.amount),         0) FROM exp_records e WHERE e.date BETWEEN p_from AND p_to);
$$;
GRANT EXECUTE ON FUNCTION profit_extras(DATE, DATE) TO service_role;

-- net pieces per product + the bonus rule that was valid on each row
CREATE OR REPLACE FUNCTION bonus_net_units(p_from DATE, p_to DATE)
RETURNS TABLE (product_id TEXT, case_size NUMERIC, bonus_cases_req NUMERIC, bonus_free_units NUMERIC,
               bonus_free_money NUMERIC, net_units NUMERIC, out_units NUMERIC, out_cost NUMERIC)
LANGUAGE sql STABLE AS $$
  SELECT t.product_id, t.rule_case_size, t.rule_bonus_cases_req, t.rule_bonus_free_units, t.rule_bonus_free_money,
         SUM(CASE WHEN t.type IN ('give','point_sale') THEN t.total_units ELSE -t.total_units END),
         SUM(CASE WHEN t.type IN ('give','point_sale') THEN t.total_units ELSE 0 END),
         SUM(CASE WHEN t.type IN ('give','point_sale') THEN t.total_cost  ELSE 0 END)
    FROM transactions t
   WHERE t.date BETWEEN p_from AND p_to
     AND t.type IN ('give','return','point_sale','point_damage_return')
   GROUP BY 1, 2, 3, 4, 5;
$$;
GRANT EXECUTE ON FUNCTION bonus_net_units(DATE, DATE) TO service_role;

-- per DSR / SO totals for a date range
CREATE OR REPLACE FUNCTION sr_sales_totals(p_from DATE, p_to DATE)
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
  WHERE t.date BETWEEN p_from AND p_to AND t.sr_id <> '' AND t.type IN ('give','return','damage')
  GROUP BY t.sr_id;
$$;
GRANT EXECUTE ON FUNCTION sr_sales_totals(DATE, DATE) TO service_role;

-- net pieces per product for a date range
CREATE OR REPLACE FUNCTION product_sales_totals(p_from DATE, p_to DATE)
RETURNS TABLE (product_id TEXT, net_units NUMERIC)
LANGUAGE sql STABLE AS $$
  SELECT t.product_id,
         SUM(CASE WHEN t.type IN ('give','point_sale') THEN t.total_units ELSE -t.total_units END)
    FROM transactions t
   WHERE t.date BETWEEN p_from AND p_to
     AND t.type IN ('give','return','point_sale','point_damage_return')
   GROUP BY t.product_id;
$$;
GRANT EXECUTE ON FUNCTION product_sales_totals(DATE, DATE) TO service_role;

-- open due per shop
CREATE OR REPLACE FUNCTION shop_due_totals(p_shop_ids TEXT[] DEFAULT NULL)
RETURNS TABLE (shop_id TEXT, due NUMERIC)
LANGUAGE sql STABLE AS $$
  SELECT d.shop_id, SUM(GREATEST(0, d.amount - d.paid_amount))
    FROM due_calendar d
   WHERE d.status <> 'cleared' AND d.shop_id <> ''
     AND (p_shop_ids IS NULL OR d.shop_id = ANY (p_shop_ids))
   GROUP BY d.shop_id;
$$;
GRANT EXECUTE ON FUNCTION shop_due_totals(TEXT[]) TO service_role;

-- ═══════════════ SECURITY: only the server (service_role) may touch data ═══════════════
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['products','srs','sr_display_seq','transactions','dmg_claims','bonus','sr_payments','dayend_slips',
                           'exp_cats','exp_records','shops','due_calendar','due_collections','user_passwords','app_settings',
                           'important_contacts','audit_log','idempotency_keys']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO service_role USING (true) WITH CHECK (true)', 'srv_' || t, t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO anon USING (false)', 'anon_deny_' || t, t);
  END LOOP;
END
$$;

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
