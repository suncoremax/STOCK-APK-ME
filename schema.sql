-- ══════════════════════════════════════════════════════════════════
--  AXIION স্টক ম্যানেজমেন্ট — Supabase Schema V28
--  Miron Electronics
--
--  ✅ FRESH INSTALL — নতুন Supabase project এ পুরোটা paste করুন
--  ✅ পুরানো data নেই, পুরানো table নেই — সম্পূর্ণ নতুন
--  ✅ শেষে Owner এর PIN সেট আছে: 12345
--  ✅ V9:  DSR-SO assignment (so_id), RLS data isolation
--  ✅ V14: Global Group Chat (group_chat_messages)
--  ✅ V17: Notice Panel (notices)
--  ✅ V18: Important Contacts (important_contacts)
--  ✅ V20: UI — Dark/Light theme toggle, Numbers tab (manager/SO/DSR),
--           Group Chat loading fix (timeout + retry)
--  ✅ V21: AXIION Blueprint §14+§15 — Live Location tracking, Office
--           geofence, Punch Attendance, Rewards/Penalties.
--           (bonus.js + damage.js merged into api/claims.js at the API
--           layer only — no schema change to the `bonus` / `dmg_claims`
--           tables themselves, they are untouched below.)
--  ✅ V22: Full Salary system — attendance now supports TWO punches/day
--           (in=morning, out=evening checkout 18:00→08:30 next day); a
--           day only pays if both exist (or Owner overrides it). Owner
--           sets a base monthly salary + optional configurable bonus
--           scheme per person per month (salary_settings), pays out per
--           month independently (salary_ledger), and can approve a
--           forgotten-punch day (salary_day_override). Replaces the
--           simpler V21 reward_ledger concept entirely.
--  ✅ V23: AXIION Blueprint §2+§3+§4 — 12-file rulebook finalised
--           (load-all.js folded into dashboard.js?action=load-all,
--           shops.js added as the 12th file), 4-decimal money precision
--           everywhere + products.case_price (§7 schema only — the
--           reverse price-entry UI lands separately), stable DSR/SO
--           display_no + so_link_status pairing handshake (§10), the
--           full Shop Registry + due linkage (§11/§12), and the SO
--           Order → Approval → Van-Load workflow tables (§13). Personal
--           Calculator (§21) and SO Daily Quota (§17) tables are also
--           included since their routes were added to expenses.js.
--  ✅ V24: AXIION Blueprint §7+§8+§9 — reverse price entry is now fully
--           live end-to-end (products.case_purchase_price column added;
--           owner types case/jar/poly buy+sell price, per-piece price is
--           derived server-side to 4-decimal precision); transactions
--           list now sorts newest-first everywhere; Owner Approval screen
--           gained a full item-level detail view + PIN-gated inline edit.
--           Also: side-menu items are now boxed/tappable, and Dark Mode +
--           Logout moved from the top bar into the side menu (Logout in
--           red) — front-end only, no schema impact from that part.
--  ✅ V25: AXIION Blueprint §17 — SO Dashboard full rebuild completed:
--           dashboard.js?role=so now accepts an optional from/to date
--           range and returns a regular-sale-vs-point-sale revenue/unit
--           split for today, this month, and any custom range. Owner can
--           now set each SO's daily "pay to company today" quota directly
--           from the DSR/SO staff list (🎯 button on SO rows), and the SO
--           sees their progress against it live on their own dashboard.
--           No schema change was required — so_daily_quota already
--           existed from V23. Also: 5 side-menu labels that were still in
--           English (Password Manager / Owner Approval / Group Chat /
--           Important Notice / Important Number) are now shown in Bengali
--           to match the rest of the menu — front-end only, DSR/SO stays
--           in English as instructed.
--  ✅ V25b: Order → Approval flow — the DSR is now auto-carried onto an
--           order from the SO's §10/§17 connect/handshake pairing at the
--           moment the SO places it (orders.assigned_dsr_id is pre-filled
--           from whichever DSR that SO is currently "accepted"-connected
--           with). Manager/Owner now just tap Approve — no more picking a
--           DSR from a dropdown every time. A manual "change" override
--           stays available for the rare case where the SO hadn't
--           connected with a DSR yet, or a different DSR is genuinely
--           needed. No schema change — reuses the existing
--           orders.assigned_dsr_id column, just populated earlier.
--  ✅ V26: AXIION Blueprint §18 — DSR Dashboard full rebuild: added a
--           Shop Visit workflow (search/detail/record-sale against the
--           existing shops.js §11 endpoints) and a Clear Plate tab
--           (today's outstanding shop dues) directly inside the DSR
--           dashboard, plus read-only access to the company Due
--           Calendar filtered to the DSR's own entries. Also: "দেওয়া"
--           (give) from Owner/Manager to a DSR now creates an
--           already-approved Load Task instead of writing stock
--           immediately — the DSR must tick every item and press
--           "Finish Loading" on the van-load checklist first, exactly
--           like an approved SO order (give to an SO is unchanged,
--           since an SO has no van to load). SO dashboard's 9-option
--           top bar and the DSR dashboard's own tab bar are now boxed
--           tappable tiles instead of a wrapping row of text buttons —
--           front-end only. shops.js list/search now also returns each
--           shop's outstanding totalDue. No new tables were needed —
--           this release reuses orders, shops, and due_calendar as-is.
--  ✅ V27: AXIION Blueprint §11 — full Shop Registry front-end (Owner/
--           Manager registration form with on-the-spot GPS capture +
--           printable QR, a shared "Shops & Map" page for Owner/Manager/
--           SO with search + a live map of every registered shop), DSR
--           on-site quick-registration + GPS auto-detect of the nearest
--           shop while visiting a route, and a free BarcodeDetector-based
--           QR scanner (no schema change — shops.lat/lng already
--           existed). Also: SO no longer has a punch/attendance button —
--           SO's own live location is still shared with Owner, and SO
--           can now see their assigned DSRs on a live map instead.
--           Morning on-time punch window widened from a single 08:30
--           cutoff to a 07:00–10:00 range (evening checkout window
--           unchanged); punch buttons now read "Present IN" / "Present
--           OUT". Important Contacts is now Owner-edit /
--           everyone-else-view-only (server + UI enforced). No table
--           changes in this release — every fix above was reachable
--           with columns that already existed.
--  ✅ V28: AXIION Blueprint §12 — Daily Due Collection / "Clear Plate"
--           finished as its own dedicated module (it had only existed as
--           a by-product of the §18 DSR dashboard rebuild until now):
--           the DSR's Clear Plate now shows a live total (shop count +
--           outstanding amount) at a glance, a one-tap "সম্পূর্ণ" button
--           to fill the exact remaining amount, and a tap-to-call phone
--           number per shop. A fully-paid shop visit now also writes an
--           already-cleared due_calendar row (instead of nothing) so
--           every visit — paid in full or not — leaves a real entry in
--           the shop's due history for a complete audit trail. Owner/
--           Manager also gain a company-wide Clear Plate overview card
--           on the Shops & Map page — today's outstanding collections
--           across every DSR, grouped and drillable. No schema change —
--           entirely additive logic on top of the existing due_calendar
--           table (shop_id/client_type already existed from V23).
--  ✅ V29: "শপ ডেলিভারি" merge — the DSR's separate "শপ ভিজিট" and
--           "ক্লিয়ার প্লেট" tabs are now ONE tab: search/GPS-nearest +
--           an inline shop map, shop due status with in-place "register/
--           collect due" before continuing, a delivery (sale) screen with
--           a select-all toggle + optional per-product commission, a
--           clear itemised bill (subtotal/discount/commission/net) with a
--           one-tap "সম্পূর্ণ" full-payment fill, and a printable/
--           downloadable slip after every sale. The day's outstanding
--           shop dues now live at the bottom of the same page instead of
--           a separate tab, and — per the DSR's own request — that list
--           is now a ROLLING 12-HOUR WINDOW from each due's creation time
--           (not the calendar day), so it quietly drops off on its own
--           after 12h and never causes day-boundary confusion on a long
--           route; the underlying due_calendar row is never deleted, only
--           this view's filter changed. NO SCHEMA CHANGE — every column
--           this touches (due_calendar.created_at/status, shops.*) already
--           existed; this is entirely additive front-end + query logic in
--           api/shops.js and public/index.html.
-- ══════════════════════════════════════════════════════════════════

DROP TABLE IF EXISTS user_passwords  CASCADE;
DROP TABLE IF EXISTS due_calendar    CASCADE;
DROP TABLE IF EXISTS exp_records     CASCADE;
DROP TABLE IF EXISTS exp_cats        CASCADE;
DROP TABLE IF EXISTS sr_payments     CASCADE;
DROP TABLE IF EXISTS bonus           CASCADE;
DROP TABLE IF EXISTS dmg_claims      CASCADE;
DROP TABLE IF EXISTS transactions    CASCADE;
DROP TABLE IF EXISTS srs             CASCADE;
DROP TABLE IF EXISTS products        CASCADE;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE products (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT        NOT NULL,
  sku              TEXT        NOT NULL,
  case_size        INTEGER     DEFAULT 1,
  unit_type        TEXT        DEFAULT 'কেস',
  -- case_price / case_purchase_price: source-of-truth bulk (case/jar/poly)
  -- prices — §7 reverse price entry. The owner types these two; selling_price
  -- / purchase_price are the derived per-piece values (case price ÷ case_size,
  -- kept at full NUMERIC(14,4) precision) that every transaction actually
  -- calculates against, computed server-side in products.js on every save.
  case_price          NUMERIC(14,4) DEFAULT 0,
  case_purchase_price NUMERIC(14,4) DEFAULT 0,
  purchase_price   NUMERIC(14,4) DEFAULT 0,
  selling_price    NUMERIC(14,4) DEFAULT 0,
  bonus_free_units NUMERIC(14,4) DEFAULT 0,
  bonus_cases_req  NUMERIC(10,2) DEFAULT 1,
  bonus_free_money NUMERIC(14,4) DEFAULT 0,
  low_stock_alert  NUMERIC(10,2) DEFAULT 0,
  thumb            TEXT        DEFAULT '',
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- so_id: UUID-as-text of the SO this DSR is assigned to; '' = unassigned
-- display_no: stable per-role number (DSR-1, DSR-2… / SO-1, SO-2…),
--   assigned once and never reused even if the slot's name changes (§10).
-- so_link_status: today's SO↔DSR "connect" handshake — none/pending/accepted.
CREATE TABLE srs (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT        NOT NULL,
  phone          TEXT        DEFAULT '',
  area           TEXT        DEFAULT '',
  role           TEXT        DEFAULT 'dsr' CHECK (role IN ('dsr', 'so', 'driver')),
  thumb          TEXT        DEFAULT '',
  so_id          TEXT        DEFAULT '',
  so_name        TEXT        DEFAULT '',
  display_no     INTEGER,
  so_link_status TEXT        DEFAULT 'none' CHECK (so_link_status IN ('none','pending','accepted')),
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_srs_so_id      ON srs(so_id);
CREATE INDEX idx_srs_role       ON srs(role);
CREATE UNIQUE INDEX idx_srs_role_display_no ON srs(role, display_no);

-- Running counter per role so display_no is never reused, even after a
-- DSR/SO slot is deleted. next_sr_display_no() below increments this
-- atomically from srs.js on every new DSR/SO creation.
DROP TABLE IF EXISTS sr_display_seq CASCADE;
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

CREATE TABLE transactions (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tx_id          UUID        NOT NULL,
  type           TEXT        NOT NULL CHECK (type IN ('give','return','damage','buy','point_sale','point_damage_return')),
  sr_id          TEXT        DEFAULT '',
  sr_name        TEXT        DEFAULT '',
  date           DATE        NOT NULL,
  slip_no        TEXT        DEFAULT '',
  product_id     TEXT        NOT NULL,
  product_name   TEXT        DEFAULT '',
  sku            TEXT        DEFAULT '',
  cases          NUMERIC(10,2) DEFAULT 0,
  pcs            NUMERIC(10,2) DEFAULT 0,
  total_units    NUMERIC(14,4) DEFAULT 0,
  purchase_price NUMERIC(14,4) DEFAULT 0,
  selling_price  NUMERIC(14,4) DEFAULT 0,
  total_cost     NUMERIC(14,4) DEFAULT 0,
  total_revenue  NUMERIC(14,4) DEFAULT 0,
  -- shop_id: links a point_sale row to a registered shop (§11) so the
  -- shop's Detail screen can show a real sales history, not just dues.
  shop_id        TEXT        DEFAULT '',
  note           TEXT        DEFAULT '',
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_tx_type    ON transactions(type);
CREATE INDEX idx_tx_date    ON transactions(date);
CREATE INDEX idx_tx_sr_id   ON transactions(sr_id);
CREATE INDEX idx_tx_shop_id ON transactions(shop_id);

CREATE TABLE dmg_claims (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tx_id          TEXT        DEFAULT '',
  product_id     TEXT        NOT NULL,
  product_name   TEXT        DEFAULT '',
  sku            TEXT        DEFAULT '',
  total_units    NUMERIC(12,2) DEFAULT 0,
  purchase_price NUMERIC(12,2) DEFAULT 0,
  total_cost     NUMERIC(14,2) DEFAULT 0,
  date           DATE,
  sr_id          TEXT        DEFAULT '',
  sr_name        TEXT        DEFAULT '',
  status         TEXT        DEFAULT 'pending' CHECK (status IN ('pending','cleared')),
  cleared_date   DATE,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_dmg_product ON dmg_claims(product_id);
CREATE INDEX idx_dmg_status  ON dmg_claims(status);
CREATE INDEX idx_dmg_sr_id   ON dmg_claims(sr_id);

CREATE TABLE bonus (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id    TEXT        NOT NULL,
  product_name  TEXT        DEFAULT '',
  sku           TEXT        DEFAULT '',
  from_date     DATE,
  to_date       DATE,
  given_units   NUMERIC(12,2) DEFAULT 0,
  bonus_amount  NUMERIC(14,2) DEFAULT 0,
  status        TEXT        DEFAULT 'cleared',
  cleared_date  DATE,
  note          TEXT        DEFAULT '',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE sr_payments (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  sr_id          TEXT        NOT NULL,
  sr_name        TEXT        DEFAULT '',
  date           DATE        NOT NULL,
  amount         NUMERIC(14,4) DEFAULT 0,
  cash_amount    NUMERIC(14,4) DEFAULT 0,
  commission_amt NUMERIC(14,4) DEFAULT 0,
  discount_amt   NUMERIC(14,4) DEFAULT 0,
  damage_amt     NUMERIC(14,4) DEFAULT 0,
  note           TEXT        DEFAULT '',
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_pay_sr   ON sr_payments(sr_id);
CREATE INDEX idx_pay_date ON sr_payments(date);

CREATE TABLE exp_cats (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT        NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE exp_records (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id   TEXT        NOT NULL,
  category_name TEXT        DEFAULT '',
  date          DATE        NOT NULL,
  amount        NUMERIC(14,2) DEFAULT 0,
  note          TEXT        DEFAULT '',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_exp_date ON exp_records(date);

CREATE TABLE due_calendar (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  dsr_id       TEXT        DEFAULT '',
  dsr_name     TEXT        DEFAULT '',
  client_type  TEXT        DEFAULT 'dsr',   -- 'dsr' | 'shop'
  shop_id      TEXT        DEFAULT '',      -- set when client_type='shop' (§11/§12)
  shop_name    TEXT        DEFAULT '',
  due_date     DATE        NOT NULL,
  amount       NUMERIC(14,4) DEFAULT 0,
  paid_amount  NUMERIC(14,4) DEFAULT 0,
  note         TEXT        DEFAULT '',
  status       TEXT        DEFAULT 'pending' CHECK (status IN ('pending','partial','cleared')),
  cleared_date DATE,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_due_date    ON due_calendar(due_date);
CREATE INDEX idx_due_status  ON due_calendar(status);
CREATE INDEX idx_due_dsr_id  ON due_calendar(dsr_id);
CREATE INDEX idx_due_shop_id ON due_calendar(shop_id);

CREATE TABLE user_passwords (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_key   TEXT        NOT NULL UNIQUE,
  user_name  TEXT        DEFAULT '',
  role       TEXT        NOT NULL CHECK (role IN ('owner','manager','so','dsr','driver')),
  password   TEXT        NOT NULL UNIQUE,
  thumb      TEXT        DEFAULT '',   -- V25: Manager's individual profile photo (Owner-set), same base64-thumb pattern as srs.thumb
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_up_password ON user_passwords(password);

-- ── RLS: service_role gets full access, anon gets none ─────────────
ALTER TABLE products       ENABLE ROW LEVEL SECURITY;
ALTER TABLE srs            ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE dmg_claims     ENABLE ROW LEVEL SECURITY;
ALTER TABLE bonus          ENABLE ROW LEVEL SECURITY;
ALTER TABLE sr_payments    ENABLE ROW LEVEL SECURITY;
ALTER TABLE exp_cats       ENABLE ROW LEVEL SECURITY;
ALTER TABLE exp_records    ENABLE ROW LEVEL SECURITY;
ALTER TABLE due_calendar   ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_passwords ENABLE ROW LEVEL SECURITY;

CREATE POLICY "srv_products"       ON products       FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "srv_srs"            ON srs            FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "srv_transactions"   ON transactions   FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "srv_dmg_claims"     ON dmg_claims     FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "srv_bonus"          ON bonus          FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "srv_sr_payments"    ON sr_payments    FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "srv_exp_cats"       ON exp_cats       FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "srv_exp_records"    ON exp_records    FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "srv_due_calendar"   ON due_calendar   FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "srv_user_passwords" ON user_passwords FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Anon: no direct access — all traffic must go through service-key API
CREATE POLICY "anon_deny_products"       ON products       FOR ALL TO anon USING (false);
CREATE POLICY "anon_deny_srs"            ON srs            FOR ALL TO anon USING (false);
CREATE POLICY "anon_deny_transactions"   ON transactions   FOR ALL TO anon USING (false);
CREATE POLICY "anon_deny_dmg_claims"     ON dmg_claims     FOR ALL TO anon USING (false);
CREATE POLICY "anon_deny_bonus"          ON bonus          FOR ALL TO anon USING (false);
CREATE POLICY "anon_deny_sr_payments"    ON sr_payments    FOR ALL TO anon USING (false);
CREATE POLICY "anon_deny_exp_cats"       ON exp_cats       FOR ALL TO anon USING (false);
CREATE POLICY "anon_deny_exp_records"    ON exp_records    FOR ALL TO anon USING (false);
CREATE POLICY "anon_deny_due_calendar"   ON due_calendar   FOR ALL TO anon USING (false);
CREATE POLICY "anon_deny_user_passwords" ON user_passwords FOR ALL TO anon USING (false);

-- ── Seed ───────────────────────────────────────────────────────────
INSERT INTO user_passwords (user_key, user_name, role, password)
VALUES ('owner', 'Owner', 'owner', '12345');

-- ══════════════════════════════════════════════════════════════════
--  V14: Global Group Chat
-- ══════════════════════════════════════════════════════════════════

DROP TABLE IF EXISTS group_chat_messages CASCADE;

CREATE TABLE group_chat_messages (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id   TEXT        NOT NULL DEFAULT '',
  sender_name TEXT        NOT NULL DEFAULT '',
  sender_role TEXT        NOT NULL DEFAULT '',
  message     TEXT        NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_gcm_created_at ON group_chat_messages(created_at);

ALTER TABLE group_chat_messages ENABLE ROW LEVEL SECURITY;

-- Service role: full access (used by Vercel API for INSERT/SELECT)
CREATE POLICY "srv_chat"
  ON group_chat_messages FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Anon: SELECT only — needed for Supabase Realtime client-side subscriptions
CREATE POLICY "anon_chat_read"
  ON group_chat_messages FOR SELECT TO anon
  USING (true);

-- Enable realtime broadcast on this table
-- (Run in Supabase Dashboard → Database → Replication, or use the line below)
ALTER PUBLICATION supabase_realtime ADD TABLE group_chat_messages;


DROP TABLE IF EXISTS manager_pending_approvals CASCADE;

CREATE TABLE manager_pending_approvals (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  manager_id   TEXT        NOT NULL DEFAULT '',
  manager_name TEXT        NOT NULL DEFAULT '',
  input_type   TEXT        NOT NULL DEFAULT '' CHECK (input_type IN ('transaction','payment','expense')),
  input_data   JSONB       NOT NULL DEFAULT '{}',
  submitted_at TIMESTAMPTZ DEFAULT NOW(),
  status       TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  approved_at  TIMESTAMPTZ,
  approved_by  TEXT        DEFAULT ''
);

CREATE INDEX idx_mpa_manager_id   ON manager_pending_approvals(manager_id);
CREATE INDEX idx_mpa_status       ON manager_pending_approvals(status);
CREATE INDEX idx_mpa_submitted_at ON manager_pending_approvals(submitted_at);

ALTER TABLE manager_pending_approvals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "srv_mpa" ON manager_pending_approvals FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_deny_mpa" ON manager_pending_approvals FOR ALL TO anon USING (false);

-- ══════════════════════════════════════════════════════════════════
--  V17: Notice Panel
-- ══════════════════════════════════════════════════════════════════

DROP TABLE IF EXISTS notices CASCADE;

CREATE TABLE notices (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  content    TEXT        NOT NULL DEFAULT '',
  is_active  BOOLEAN     NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE notices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "srv_notices"       ON notices FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_deny_notices" ON notices FOR ALL TO anon USING (false);

-- ══════════════════════════════════════════════════════════════════
--  V18: Important Contacts Directory
-- ══════════════════════════════════════════════════════════════════

DROP TABLE IF EXISTS important_contacts CASCADE;

CREATE TABLE important_contacts (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT        NOT NULL DEFAULT '',
  role         TEXT        NOT NULL DEFAULT '',
  phone_number TEXT        NOT NULL DEFAULT '',
  special_note TEXT        NOT NULL DEFAULT '',
  created_by   TEXT        NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_ic_created_at ON important_contacts(created_at);

ALTER TABLE important_contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "srv_important_contacts"       ON important_contacts FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_deny_important_contacts" ON important_contacts FOR ALL TO anon          USING (false);

-- ══════════════════════════════════════════════════════════════════
--  V21: Office Geofence + Live Location + Punch Attendance + Rewards
--  (AXIION Blueprint §14 — Location Tracking, §15 — Attendance/Rewards)
-- ══════════════════════════════════════════════════════════════════

-- Single-row table: the office's reference GPS point. Set once by the
-- Owner standing physically at the office and tapping "set office here"
-- inside the app — the device's GPS becomes the stored lat/lng.
DROP TABLE IF EXISTS office_location CASCADE;

CREATE TABLE office_location (
  id         INTEGER       PRIMARY KEY DEFAULT 1,
  lat        NUMERIC(10,7) NOT NULL,
  lng        NUMERIC(10,7) NOT NULL,
  radius_m   INTEGER       NOT NULL DEFAULT 150,
  set_by     TEXT          DEFAULT '',
  set_at     TIMESTAMPTZ   DEFAULT NOW(),
  CONSTRAINT office_location_single_row CHECK (id = 1)
);

ALTER TABLE office_location ENABLE ROW LEVEL SECURITY;
CREATE POLICY "srv_office_location"       ON office_location FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_deny_office_location" ON office_location FOR ALL TO anon          USING (false);

-- One row per user, upserted on every free browser-geolocation ping
-- while that user's app is open (§14 free method — no paid API).
DROP TABLE IF EXISTS live_locations CASCADE;

CREATE TABLE live_locations (
  user_key   TEXT          PRIMARY KEY,
  user_name  TEXT          DEFAULT '',
  role       TEXT          DEFAULT '',
  lat        NUMERIC(10,7),
  lng        NUMERIC(10,7),
  updated_at TIMESTAMPTZ   DEFAULT NOW()
);

ALTER TABLE live_locations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "srv_live_locations"       ON live_locations FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_deny_live_locations" ON live_locations FOR ALL TO anon          USING (false);

-- Punch log — TWO rows per workday per user: punch_type='in' (morning,
-- the day's 1st confirmation, on-time/late determined here) and
-- punch_type='out' (evening checkout, 18:00 today through 08:30 the next
-- day). A day only counts toward SALARY once both exist (see
-- salary_day_override below for the forgotten-punch exception).
-- at_office / distance_m are enforced at the API layer — a punch outside
-- the office radius is rejected before it ever reaches this table.
DROP TABLE IF EXISTS attendance CASCADE;

CREATE TABLE attendance (
  id          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_key    TEXT          NOT NULL,
  user_name   TEXT          DEFAULT '',
  role        TEXT          NOT NULL,
  punch_date  DATE          NOT NULL,   -- the WORKDAY this punch belongs to (not necessarily the calendar date it was tapped on, for late-night "out" punches)
  punch_type  TEXT          NOT NULL DEFAULT 'in' CHECK (punch_type IN ('in','out')),
  punch_time  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  status      TEXT          CHECK (status IS NULL OR status IN ('present','late')), -- only meaningful for punch_type='in'
  lat         NUMERIC(10,7),
  lng         NUMERIC(10,7),
  at_office   BOOLEAN,
  distance_m  NUMERIC(10,1),
  created_at  TIMESTAMPTZ   DEFAULT NOW(),
  UNIQUE (user_key, punch_date, punch_type)
);
CREATE INDEX idx_att_user ON attendance(user_key);
CREATE INDEX idx_att_date ON attendance(punch_date);

ALTER TABLE attendance ENABLE ROW LEVEL SECURITY;
CREATE POLICY "srv_attendance"       ON attendance FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_deny_attendance" ON attendance FOR ALL TO anon          USING (false);

-- Owner-configured base salary + optional bonus scheme, PER PERSON PER
-- MONTH (a raise only applies going forward — past months keep whatever
-- was set for them at the time). If a month has no row, the API falls
-- back to the most recent PRIOR month's settings for that person.
DROP TABLE IF EXISTS salary_settings CASCADE;

CREATE TABLE salary_settings (
  user_key          TEXT          NOT NULL,
  month             TEXT          NOT NULL, -- 'YYYY-MM'
  user_name         TEXT          DEFAULT '',
  base_salary       NUMERIC(14,2) NOT NULL DEFAULT 0,
  bonus_enabled     BOOLEAN       NOT NULL DEFAULT false,
  daily_bonus_amt   NUMERIC(10,2) NOT NULL DEFAULT 20,
  perfect_bonus_amt NUMERIC(10,2) NOT NULL DEFAULT 500,
  late_penalty_amt  NUMERIC(10,2) NOT NULL DEFAULT 500,
  set_by            TEXT          DEFAULT '',
  set_at            TIMESTAMPTZ   DEFAULT NOW(),
  PRIMARY KEY (user_key, month)
);

ALTER TABLE salary_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "srv_salary_settings"       ON salary_settings FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_deny_salary_settings" ON salary_settings FOR ALL TO anon          USING (false);

-- Marks a specific person's specific month as paid. Months are tracked
-- completely independently — an unpaid month just stays "due" for that
-- month and never rolls into or mixes with the next month's calculation.
DROP TABLE IF EXISTS salary_ledger CASCADE;

CREATE TABLE salary_ledger (
  user_key    TEXT          NOT NULL,
  month       TEXT          NOT NULL, -- 'YYYY-MM'
  user_name   TEXT          DEFAULT '',
  paid_at     TIMESTAMPTZ,
  paid_amount NUMERIC(14,2) DEFAULT 0,
  paid_by     TEXT          DEFAULT '',
  updated_at  TIMESTAMPTZ   DEFAULT NOW(),
  PRIMARY KEY (user_key, month)
);

ALTER TABLE salary_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY "srv_salary_ledger"       ON salary_ledger FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_deny_salary_ledger" ON salary_ledger FOR ALL TO anon          USING (false);

-- Owner's manual override for a specific missed-punch day (e.g. someone
-- forgot to punch in/out once but told the Owner) — if a row exists here
-- for a given (user, date), that date counts as a valid salary day
-- regardless of the actual punch records.
DROP TABLE IF EXISTS salary_day_override CASCADE;

CREATE TABLE salary_day_override (
  user_key      TEXT        NOT NULL,
  workday_date  DATE        NOT NULL,
  reason        TEXT        DEFAULT '',
  approved_by   TEXT        DEFAULT '',
  approved_at   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_key, workday_date)
);

ALTER TABLE salary_day_override ENABLE ROW LEVEL SECURITY;
CREATE POLICY "srv_salary_day_override"       ON salary_day_override FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_deny_salary_day_override" ON salary_day_override FOR ALL TO anon          USING (false);

-- Advance salary payment requests. Any staff role (Manager/DSR/SO/Driver)
-- can request an advance against their own upcoming/current salary from
-- their dashboard. Owner approves or rejects (from মালিক অনুমোদন tab);
-- once approved, the amount is automatically subtracted from that same
-- person's salary total for the given month (see computeSalary in
-- api/attendance.js — advanceApproved / payable fields).
DROP TABLE IF EXISTS advance_requests CASCADE;

CREATE TABLE advance_requests (
  id           UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_key     TEXT          NOT NULL,
  user_name    TEXT          DEFAULT '',
  role         TEXT          DEFAULT '',
  amount       NUMERIC(14,2) NOT NULL DEFAULT 0,
  month        TEXT          NOT NULL, -- 'YYYY-MM' — the salary month it will be deducted from
  note         TEXT          DEFAULT '',
  status       TEXT          NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  requested_at TIMESTAMPTZ   DEFAULT NOW(),
  decided_at   TIMESTAMPTZ,
  decided_by   TEXT          DEFAULT ''
);
CREATE INDEX idx_advance_requests_user_month ON advance_requests(user_key, month);
CREATE INDEX idx_advance_requests_status     ON advance_requests(status);

ALTER TABLE advance_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "srv_advance_requests"       ON advance_requests FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_deny_advance_requests" ON advance_requests FOR ALL TO anon          USING (false);


-- ══════════════════════════════════════════════════════════════════
--  V23: AXIION Blueprint §2 + §3 + §4 — Shop Registry, SO Ordering /
--  Van-Load workflow, Personal Calculator, SO Daily Quota
-- ══════════════════════════════════════════════════════════════════

-- ── Shop Registry (§11) ──────────────────────────────────────────────
DROP TABLE IF EXISTS shops CASCADE;

CREATE TABLE shops (
  id                 UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_no            TEXT          NOT NULL UNIQUE,   -- e.g. SHOP-0001
  name               TEXT          NOT NULL,
  keeper_name        TEXT          DEFAULT '',        -- shopkeeper's own name, captured at registration
  phone              TEXT          DEFAULT '',
  address            TEXT          DEFAULT '',        -- optional free-form / reverse-geocoded (§14 bonus)
  lat                NUMERIC(10,7),
  lng                NUMERIC(10,7),
  assigned_dsr_id    TEXT          NOT NULL,           -- srs.id of the owning DSR (stable — never a name)
  assigned_dsr_name  TEXT          DEFAULT '',
  created_at         TIMESTAMPTZ   DEFAULT NOW()
);
CREATE INDEX idx_shops_dsr   ON shops(assigned_dsr_id);
CREATE INDEX idx_shops_phone ON shops(phone);

ALTER TABLE shops ENABLE ROW LEVEL SECURITY;
CREATE POLICY "srv_shops"       ON shops FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_deny_shops" ON shops FOR ALL TO anon          USING (false);

-- Running counter for shop_no (SHOP-0001, SHOP-0002…), never reused.
DROP SEQUENCE IF EXISTS shop_no_seq;
CREATE SEQUENCE shop_no_seq START 1;

CREATE OR REPLACE FUNCTION next_shop_no() RETURNS INTEGER AS $$
BEGIN
  RETURN nextval('shop_no_seq');
END;
$$ LANGUAGE plpgsql;
GRANT EXECUTE ON FUNCTION next_shop_no() TO service_role;

-- ── SO Ordering → Approval → Van-Load Workflow (§13) ─────────────────
DROP TABLE IF EXISTS orders CASCADE;

CREATE TABLE orders (
  id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  so_id             TEXT          NOT NULL,
  so_name           TEXT          DEFAULT '',
  items             JSONB         NOT NULL DEFAULT '[]',
  requested_amount  NUMERIC(14,4) DEFAULT 0,
  status            TEXT          NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','modified_pending','approved','rejected')),
  modified_by       TEXT          DEFAULT '',
  modified_amount   NUMERIC(14,4),
  -- proposed_items: a DSR's requested-but-not-yet-approved item change.
  -- Manager/Owner edits apply straight to `items` instead (no approval
  -- gate needed for them, per §13).
  proposed_items    JSONB,
  assigned_dsr_id   TEXT          DEFAULT '',
  load_status       TEXT          NOT NULL DEFAULT 'not_started'
                      CHECK (load_status IN ('not_started','loading','loaded')),
  load_ticks        JSONB         NOT NULL DEFAULT '{}',
  approved_by       TEXT          DEFAULT '',
  approved_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ   DEFAULT NOW()
);
CREATE INDEX idx_orders_so_id  ON orders(so_id);
CREATE INDEX idx_orders_dsr_id ON orders(assigned_dsr_id);
CREATE INDEX idx_orders_status ON orders(status);

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "srv_orders"       ON orders FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_deny_orders" ON orders FOR ALL TO anon          USING (false);

-- ── Personal (Off-Books) Calculator (§21) — isolated per user, never
--    included in any company financial calculation ───────────────────
DROP TABLE IF EXISTS personal_ledger CASCADE;

CREATE TABLE personal_ledger (
  id         UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_key   TEXT          NOT NULL,
  type       TEXT          NOT NULL CHECK (type IN ('received','given')),
  amount     NUMERIC(14,4) DEFAULT 0,
  note       TEXT          DEFAULT '',
  date       DATE          NOT NULL,
  created_at TIMESTAMPTZ   DEFAULT NOW()
);
CREATE INDEX idx_pl_user ON personal_ledger(user_key);

ALTER TABLE personal_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY "srv_personal_ledger"       ON personal_ledger FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_deny_personal_ledger" ON personal_ledger FOR ALL TO anon          USING (false);

-- ── SO Daily "Pay to Company" Quota (§17) ────────────────────────────
DROP TABLE IF EXISTS so_daily_quota CASCADE;

CREATE TABLE so_daily_quota (
  so_id      TEXT          NOT NULL,
  date       DATE          NOT NULL,
  amount     NUMERIC(14,4) DEFAULT 0,
  set_by     TEXT          DEFAULT '',
  set_at     TIMESTAMPTZ   DEFAULT NOW(),
  PRIMARY KEY (so_id, date)
);

ALTER TABLE so_daily_quota ENABLE ROW LEVEL SECURITY;
CREATE POLICY "srv_so_daily_quota"       ON so_daily_quota FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_deny_so_daily_quota" ON so_daily_quota FOR ALL TO anon          USING (false);


-- ══════════════════════════════════════════════════════════════════
--  V24: AXIION Blueprint §16 — Sales Targets (owner-only correction)
--  Owner sets a per-period (YYYY-MM) revenue target for each DSR/SO,
--  PLUS one special row per period with user_key='COMPANY_TOTAL' and
--  role='company' holding the single overall company-wide target that
--  every role can view. Only the Owner may write to this table at all
--  (enforced in api/attendance.js, action=target-set) — Manager/SO/DSR
--  are always view-only, watching their own or the company's progress.
--  "Achieved" is never stored here — it's always computed live from the
--  transactions table (same give/point_sale − return/point_damage_return
--  pattern every other revenue figure in the app already uses), so a
--  target row only ever holds the goal, never a snapshot of progress.
-- ══════════════════════════════════════════════════════════════════
DROP TABLE IF EXISTS targets CASCADE;

CREATE TABLE targets (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_key      TEXT          NOT NULL,               -- = srs.id (DSR or SO), or 'COMPANY_TOTAL'
  user_name     TEXT          DEFAULT '',
  role          TEXT          DEFAULT '' CHECK (role IN ('', 'dsr', 'so', 'company')),
  period        TEXT          NOT NULL,               -- 'YYYY-MM'
  target_amount NUMERIC(14,4) DEFAULT 0,
  set_by        TEXT          DEFAULT '',
  set_at        TIMESTAMPTZ   DEFAULT NOW(),
  UNIQUE (user_key, period)
);
CREATE INDEX idx_targets_period   ON targets(period);
CREATE INDEX idx_targets_userkey  ON targets(user_key);

ALTER TABLE targets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "srv_targets"       ON targets FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_deny_targets" ON targets FOR ALL TO anon          USING (false);
