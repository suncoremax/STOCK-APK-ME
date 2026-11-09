-- ═══════════════════════════════════════════════════════════════════
-- AXIION DMS — migrate-v7-multi-business.sql
--
--   Run ONCE in the Supabase SQL editor on an EXISTING single-business database (the previous version)
--   BEFORE deploying the new code. Nothing is deleted: all your current data becomes the FIRST business
--   ("আমার ব্যবসা", or the name from Settings) with your existing month cycle (26 → 25 if none was chosen) — you can rename it and
--   change its cycle inside the app (সেটিং → মাসের সাইকেল). Then add more businesses from the business screen.
--
--   A brand-new database does NOT need this file — schema.sql already includes everything.
--   Safe to re-run: it stops if the database is already migrated.
-- ═══════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF to_regclass('public.businesses') IS NOT NULL THEN
    RAISE EXCEPTION 'STOP: this database is already migrated to multi-business (table businesses exists).';
  END IF;
  IF to_regclass('public.products') IS NULL THEN
    RAISE EXCEPTION 'STOP: no old tables found — this is an empty database. Run schema.sql instead.';
  END IF;
END
$$;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE businesses (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT        NOT NULL,
  cycle_start_day INTEGER     CHECK (cycle_start_day BETWEEN 1 AND 28),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE biz_counters (
  business_id UUID    NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  key         TEXT    NOT NULL,
  next_no     INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (business_id, key)
);

-- the first business receives every existing row
-- if the old database already has a month cycle the owner chose (single-business v8), the business keeps it; otherwise 26 → 25
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS cycle_start_day INTEGER;
INSERT INTO businesses (name, cycle_start_day)
SELECT COALESCE(NULLIF((SELECT shop_name FROM app_settings WHERE id = 1), ''), 'আমার ব্যবসা'),
       COALESCE((SELECT cycle_start_day FROM app_settings WHERE id = 1), 26);

DO $$
DECLARE t TEXT; b UUID;
BEGIN
  SELECT id INTO b FROM businesses ORDER BY created_at LIMIT 1;
  FOREACH t IN ARRAY ARRAY['products','srs','transactions','dmg_claims','bonus','sr_payments','dayend_slips','exp_cats',
                           'exp_records','shops','due_calendar','due_collections','important_contacts','audit_log']
  LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN business_id UUID', t);
    EXECUTE format('UPDATE %I SET business_id = %L', t, b);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN business_id SET NOT NULL', t);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE', t, t || '_business_fk');
  END LOOP;

  -- settings: one row PER business (was a single id = 1 row)
  ALTER TABLE app_settings ADD COLUMN business_id UUID;
  UPDATE app_settings SET business_id = b;
  INSERT INTO app_settings (business_id, id) SELECT b, 1 WHERE NOT EXISTS (SELECT 1 FROM app_settings);
  ALTER TABLE app_settings DROP CONSTRAINT IF EXISTS app_settings_single_row;
  ALTER TABLE app_settings DROP CONSTRAINT IF EXISTS app_settings_pkey;
  ALTER TABLE app_settings ALTER COLUMN business_id SET NOT NULL;
  ALTER TABLE app_settings ALTER COLUMN id SET DEFAULT 1;
  ALTER TABLE app_settings ADD PRIMARY KEY (business_id);
  ALTER TABLE app_settings ADD CONSTRAINT app_settings_business_fk FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE;

  -- running numbers continue exactly where they were
  INSERT INTO biz_counters (business_id, key, next_no)
    SELECT b, 'sr:' || role, next_no FROM sr_display_seq;
  INSERT INTO biz_counters (business_id, key, next_no)
    SELECT b, 'sr:' || r, COALESCE((SELECT MAX(display_no) FROM srs WHERE role = r), 0) + 1
      FROM unnest(ARRAY['dsr','so']) AS r
    ON CONFLICT (business_id, key) DO UPDATE SET next_no = GREATEST(biz_counters.next_no, EXCLUDED.next_no);
  INSERT INTO biz_counters (business_id, key, next_no)
    SELECT b, 'shop', CASE WHEN is_called THEN last_value + 1 ELSE last_value END FROM shop_no_seq;
  INSERT INTO biz_counters (business_id, key, next_no)
    SELECT b, 'slip', CASE WHEN is_called THEN last_value + 1 ELSE last_value END FROM slip_no_seq;
END
$$;

-- numbering / uniqueness now live inside one business
ALTER TABLE dayend_slips DROP CONSTRAINT IF EXISTS dayend_slips_slip_no_key;
ALTER TABLE shops        DROP CONSTRAINT IF EXISTS shops_shop_no_key;
DROP INDEX IF EXISTS idx_srs_role_display_no;
CREATE UNIQUE INDEX idx_srs_role_display_no ON srs(business_id, role, display_no);
CREATE UNIQUE INDEX idx_slips_biz_no ON dayend_slips(business_id, slip_no);
CREATE UNIQUE INDEX idx_shops_biz_no ON shops(business_id, shop_no);

DROP TABLE IF EXISTS sr_display_seq;
DROP SEQUENCE IF EXISTS shop_no_seq;
DROP SEQUENCE IF EXISTS slip_no_seq;

-- per-business lookups
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

-- security for the two new tables (only the server / service_role may touch them)
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['businesses','biz_counters']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO service_role USING (true) WITH CHECK (true)', 'srv_' || t, t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO anon USING (false)', 'anon_deny_' || t, t);
  END LOOP;
END
$$;

-- the month cycle now lives on the business, not on the settings row
ALTER TABLE app_settings DROP COLUMN IF EXISTS cycle_start_day;

COMMIT;
