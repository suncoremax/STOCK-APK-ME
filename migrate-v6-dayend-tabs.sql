-- ═══════════════════════════════════════════════════════════════════
-- AXIION DMS — v6 migration (run ONCE in the Supabase SQL editor on an EXISTING database)
-- Adds the day-end tabs "বোনাস (দোকানকে)" and "অন্যান্য". No data is touched or deleted.
-- (A brand-new database made from schema.sql already has all of this — do not run it there.)
-- ═══════════════════════════════════════════════════════════════════
ALTER TABLE sr_payments  ADD COLUMN IF NOT EXISTS bonus_amt NUMERIC(14,4) DEFAULT 0;
ALTER TABLE sr_payments  ADD COLUMN IF NOT EXISTS other_amt NUMERIC(14,4) DEFAULT 0;
ALTER TABLE dayend_slips ADD COLUMN IF NOT EXISTS bonus_amt NUMERIC(14,4) DEFAULT 0;
ALTER TABLE dayend_slips ADD COLUMN IF NOT EXISTS other_amt NUMERIC(14,4) DEFAULT 0;
ALTER TABLE dayend_slips ADD COLUMN IF NOT EXISTS details   JSONB DEFAULT '{}'::jsonb;

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
    INSERT INTO sr_payments (id, sr_id, sr_name, date, amount, cash_amount, commission_amt, discount_amt, damage_amt, bonus_amt, other_amt, note, created_at)
    VALUES (v_pay, pay->>'sr_id', COALESCE(pay->>'sr_name',''), (pay->>'date')::date,
            COALESCE((pay->>'amount')::numeric,0), COALESCE((pay->>'cash_amount')::numeric,0),
            COALESCE((pay->>'commission_amt')::numeric,0), COALESCE((pay->>'discount_amt')::numeric,0),
            COALESCE((pay->>'damage_amt')::numeric,0), COALESCE((pay->>'bonus_amt')::numeric,0), COALESCE((pay->>'other_amt')::numeric,0),
            COALESCE(pay->>'note',''), COALESCE((pay->>'created_at')::timestamptz, NOW()));
  END IF;

  INSERT INTO dayend_slips (slip_no, dsr_id, dsr_name, date, given_amt, return_amt, damage_amt, comm_amt, disc_amt, bonus_amt, other_amt, details,
                            expected_cash, cash_amt, due_before, due_after, note, return_tx_id, damage_tx_id, payment_id, created_at)
  VALUES (v_no, s->>'dsr_id', COALESCE(s->>'dsr_name',''), (s->>'date')::date,
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
GRANT EXECUTE ON FUNCTION save_day_end(JSONB) TO service_role;

CREATE OR REPLACE FUNCTION profit_extras(p_from DATE, p_to DATE)
RETURNS TABLE (commission NUMERIC, discount NUMERIC, damage_loss NUMERIC, expenses NUMERIC)
LANGUAGE sql STABLE AS $$
  SELECT
    (SELECT COALESCE(SUM(p.commission_amt), 0) FROM sr_payments p WHERE p.date BETWEEN p_from AND p_to)
  + (SELECT COALESCE(SUM(t.commission_amt), 0) FROM transactions t WHERE t.type = 'point_sale' AND t.date BETWEEN p_from AND p_to),
    (SELECT COALESCE(SUM(p.discount_amt + p.bonus_amt + p.other_amt), 0) FROM sr_payments p WHERE p.date BETWEEN p_from AND p_to)
  + (SELECT COALESCE(SUM(t.discount_amt), 0) FROM transactions t WHERE t.type = 'point_sale' AND t.date BETWEEN p_from AND p_to),
    (SELECT COALESCE(SUM(c.total_cost),     0) FROM dmg_claims  c WHERE c.date BETWEEN p_from AND p_to),
    (SELECT COALESCE(SUM(e.amount),         0) FROM exp_records e WHERE e.date BETWEEN p_from AND p_to);
$$;
GRANT EXECUTE ON FUNCTION profit_extras(DATE, DATE) TO service_role;
