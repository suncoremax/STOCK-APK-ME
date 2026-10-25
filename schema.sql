-- ═══════════════════════════════════════════════════════════════════
--  AXIION Business Manager (v6.0) — fresh database
--  Owner + Manager only. Run ONCE on a NEW Supabase project
--  (Supabase → SQL editor → paste → Run).  Safe to re-run: every
--  statement is IF NOT EXISTS / OR REPLACE and nothing is ever dropped.
-- ═══════════════════════════════════════════════════════════════════
create extension if not exists pgcrypto;

-- ── users (owner / manager) ────────────────────────────────────────
create table if not exists app_users (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  username    text not null,
  role        text not null check (role in ('owner','manager')),
  pin_hash    text not null,
  active      boolean not null default true,
  must_change boolean not null default false,
  created_at  timestamptz not null default now()
);
create unique index if not exists uq_app_users_username on app_users (lower(username));

create table if not exists settings (
  key   text primary key,
  value jsonb not null
);

-- ── master data ────────────────────────────────────────────────────
create table if not exists products (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  sku            text not null default '',
  category       text not null default '',
  unit_name      text not null default 'পিস',      -- what one piece is called
  case_name      text not null default 'কেস',      -- what one case is called
  case_size      integer not null default 1 check (case_size >= 1),
  purchase_price numeric(14,4) not null default 0,  -- per piece
  selling_price  numeric(14,4) not null default 0,  -- per piece
  stock          numeric(14,2) not null default 0,  -- good stock, pieces
  damage_stock   numeric(14,2) not null default 0,  -- damaged, waiting for company claim
  low_stock      numeric(14,2) not null default 0,
  supplier_id    uuid,
  note           text not null default '',
  active         boolean not null default true,
  created_at     timestamptz not null default now()
);
create index if not exists idx_products_cat on products (category);

create table if not exists suppliers (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  phone      text not null default '',
  address    text not null default '',
  note       text not null default '',
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists employees (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  phone       text not null default '',
  designation text not null default '',   -- free text, e.g. DSR / SO / ড্রাইভার / হেল্পার
  salary      numeric(14,2) not null default 0,
  join_date   date,
  note        text not null default '',
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create sequence if not exists shop_code_seq start 1;
create table if not exists shops (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,
  name          text not null,
  keeper        text not null default '',
  phone         text not null default '',
  address       text not null default '',
  area          text not null default '',
  employee_id   uuid,
  employee_name text not null default '',
  credit_limit  numeric(14,2) not null default 0,   -- 0 = no limit
  promise_date  date,                                -- next promised payment date
  note          text not null default '',
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
create index if not exists idx_shops_area on shops (area);
create index if not exists idx_shops_name on shops (lower(name));

-- ── ledger: one table for shop dues and company payables ──────────
-- shop:     balance = Σdebit − Σcredit   (positive = shop owes us)
-- supplier: balance = Σcredit − Σdebit   (positive = we owe company)
create table if not exists ledger (
  id          uuid primary key default gen_random_uuid(),
  party_type  text not null check (party_type in ('shop','supplier')),
  party_id    uuid not null,
  party_name  text not null default '',
  date        date not null,
  kind        text not null,   -- opening|sale|sale_paid|collection|return|damage|exchange|refund|purchase|purchase_paid|payment|claim|discount
  debit       numeric(14,2) not null default 0 check (debit  >= 0),
  credit      numeric(14,2) not null default 0 check (credit >= 0),
  method      text not null default '',
  ref_type    text not null default '',
  ref_id      uuid,
  employee_id uuid,
  employee_name text not null default '',
  client_token text unique,
  note        text not null default '',
  by_name     text not null default '',
  created_at  timestamptz not null default now()
);
create index if not exists idx_ledger_party on ledger (party_type, party_id, date);
create index if not exists idx_ledger_date  on ledger (date);
create index if not exists idx_ledger_ref   on ledger (ref_id);

create table if not exists stock_moves (
  id         uuid primary key default gen_random_uuid(),
  product_id uuid not null,
  bucket     text not null default 'stock' check (bucket in ('stock','damage')),
  date       date not null,
  kind       text not null,
  qty        numeric(14,2) not null,       -- signed pieces
  ref_type   text not null default '',
  ref_id     uuid,
  note       text not null default '',
  by_name    text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists idx_moves_prod ON stock_moves (product_id, date);
create index if not exists idx_moves_ref  ON stock_moves (ref_id);

-- ── sales ──────────────────────────────────────────────────────────
create sequence if not exists sale_no_seq start 1;
create table if not exists sales (
  id            uuid primary key default gen_random_uuid(),
  inv_no        text not null unique,
  client_token  text unique,
  date          date not null,
  shop_id       uuid,
  shop_name     text not null default '',
  employee_id   uuid,
  employee_name text not null default '',
  subtotal      numeric(14,2) not null default 0,
  discount      numeric(14,2) not null default 0,
  commission    numeric(14,2) not null default 0,
  total         numeric(14,2) not null default 0,   -- net payable
  paid          numeric(14,2) not null default 0,
  due           numeric(14,2) not null default 0,
  cost          numeric(14,2) not null default 0,   -- Σ cost price × units (for profit)
  method        text not null default 'cash',
  note          text not null default '',
  status        text not null default 'ok' check (status in ('ok','void')),
  void_reason   text not null default '',
  by_name       text not null default '',
  created_at    timestamptz not null default now()
);
create index if not exists idx_sales_date on sales (date);
create index if not exists idx_sales_shop on sales (shop_id, date);
create table if not exists sale_items (
  id           uuid primary key default gen_random_uuid(),
  sale_id      uuid not null references sales(id) on delete cascade,
  product_id   uuid not null,
  product_name text not null default '',
  category     text not null default '',
  units        numeric(14,2) not null check (units > 0),
  unit_price   numeric(14,4) not null default 0,
  cost_price   numeric(14,4) not null default 0,
  line_total   numeric(14,2) not null default 0
);
create index if not exists idx_sale_items_sale on sale_items (sale_id);
create index if not exists idx_sale_items_prod on sale_items (product_id);

-- ── purchases from company ────────────────────────────────────────
create sequence if not exists purchase_no_seq start 1;
create table if not exists purchases (
  id           uuid primary key default gen_random_uuid(),
  pur_no       text not null unique,
  client_token text unique,
  date         date not null,
  slip_no      text not null default '',
  supplier_id  uuid,
  supplier_name text not null default '',
  subtotal     numeric(14,2) not null default 0,
  discount     numeric(14,2) not null default 0,
  total        numeric(14,2) not null default 0,
  paid         numeric(14,2) not null default 0,
  due          numeric(14,2) not null default 0,
  method       text not null default 'cash',
  note         text not null default '',
  status       text not null default 'ok' check (status in ('ok','void')),
  void_reason  text not null default '',
  by_name      text not null default '',
  created_at   timestamptz not null default now()
);
create index if not exists idx_pur_date on purchases (date);
create table if not exists purchase_items (
  id           uuid primary key default gen_random_uuid(),
  purchase_id  uuid not null references purchases(id) on delete cascade,
  product_id   uuid not null,
  product_name text not null default '',
  units        numeric(14,2) not null check (units > 0),
  unit_cost    numeric(14,4) not null default 0,
  line_total   numeric(14,2) not null default 0
);
create index if not exists idx_pur_items_pur on purchase_items (purchase_id);

-- ── returns / damage / claims / stock adjustments ─────────────────
create sequence if not exists adj_no_seq start 1;
create table if not exists adjustments (
  id            uuid primary key default gen_random_uuid(),
  adj_no        text not null unique,
  client_token  text unique,
  kind          text not null check (kind in ('sale_return','shop_damage','company_return','store_damage','company_claim','stock_adjust')),
  date          date not null,
  party_type    text not null default '',
  party_id      uuid,
  party_name    text not null default '',
  employee_id   uuid,
  employee_name text not null default '',
  mode          text not null default '',        -- credit | refund | exchange | replace
  items         jsonb not null default '[]',      -- [{product_id,name,units,price}]
  exch_items    jsonb not null default '[]',
  amount        numeric(14,2) not null default 0,
  method        text not null default 'cash',
  note          text not null default '',
  status        text not null default 'ok' check (status in ('ok','void')),
  by_name       text not null default '',
  created_at    timestamptz not null default now()
);
create index if not exists idx_adj_date on adjustments (date);

-- ── money: expenses, salary, manual cash entries, day close ───────
create table if not exists expense_cats (
  id   uuid primary key default gen_random_uuid(),
  name text not null unique
);
create table if not exists expenses (
  id          uuid primary key default gen_random_uuid(),
  date        date not null,
  category    text not null default 'অন্যান্য',
  amount      numeric(14,2) not null check (amount > 0),
  method      text not null default 'cash',
  employee_id uuid,
  employee_name text not null default '',
  note        text not null default '',
  by_name     text not null default '',
  created_at  timestamptz not null default now()
);
create index if not exists idx_exp_date on expenses (date);

create table if not exists cash_entries (
  id         uuid primary key default gen_random_uuid(),
  date       date not null,
  kind       text not null,     -- capital_in | owner_withdraw | bank_deposit | bank_withdraw | other_income | other_out
  direction  text not null check (direction in ('in','out')),
  amount     numeric(14,2) not null check (amount > 0),
  method     text not null default 'cash',
  group_id   uuid,              -- links the two legs of a cash↔bank transfer
  note       text not null default '',
  by_name    text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists idx_cash_date on cash_entries (date);

create table if not exists salary_payments (
  id          uuid primary key default gen_random_uuid(),
  employee_id uuid not null,
  employee_name text not null default '',
  month       text not null,                 -- YYYY-MM
  kind        text not null check (kind in ('salary','advance','bonus')),
  amount      numeric(14,2) not null check (amount > 0),
  method      text not null default 'cash',
  date        date not null,
  note        text not null default '',
  by_name     text not null default '',
  created_at  timestamptz not null default now()
);
create index if not exists idx_salpay_month on salary_payments (month, employee_id);

create table if not exists attendance (
  employee_id uuid not null,
  date        date not null,
  status      text not null check (status in ('present','absent','late','leave','half')),
  note        text not null default '',
  by_name     text not null default '',
  primary key (employee_id, date)
);

create table if not exists day_close (
  date          date primary key,
  expected_cash numeric(14,2) not null default 0,
  counted_cash  numeric(14,2) not null default 0,
  diff          numeric(14,2) not null default 0,
  note          text not null default '',
  by_name       text not null default '',
  created_at    timestamptz not null default now()
);

-- ── extras ─────────────────────────────────────────────────────────
create table if not exists notices (
  id         uuid primary key default gen_random_uuid(),
  title      text not null,
  body       text not null default '',
  pinned     boolean not null default false,
  by_name    text not null default '',
  created_at timestamptz not null default now()
);
create table if not exists contacts (
  id    uuid primary key default gen_random_uuid(),
  name  text not null,
  phone text not null default '',
  role  text not null default '',
  note  text not null default ''
);
create table if not exists audit_log (
  id        bigserial primary key,
  at        timestamptz not null default now(),
  user_name text not null default '',
  role      text not null default '',
  action    text not null,
  detail    jsonb not null default '{}'
);
create index if not exists idx_audit_at on audit_log (at desc);

-- ── lock every table: only the server (service_role) may touch data ─
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname='public' loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

-- ── default settings ───────────────────────────────────────────────
insert into settings(key,value) values
  ('business_name',        '"আমার ব্যবসা"'),
  ('business_phone',       '""'),
  ('business_address',     '""'),
  ('invoice_footer',       '"ধন্যবাদ"'),
  ('opening_cash',         '0'),
  ('opening_bank',         '0'),
  ('books_start',          '"2000-01-01"'),
  ('allow_negative_stock', 'false'),
  ('enforce_credit_limit', 'false'),
  ('update_cost_on_purchase','true'),
  ('salary_deduct_absent', 'true'),
  ('monthly_target',       '0'),
  ('due_alert_days',       '15'),
  ('manager_see_profit',   'false'),
  ('manager_can_void',     'false'),
  ('manager_manage_salary','false')
on conflict (key) do nothing;
insert into expense_cats(name) values ('গাড়ি/তেল'),('দোকান ভাড়া'),('বিদ্যুৎ/ইন্টারনেট'),('নাস্তা/খাবার'),('মেরামত'),('অন্যান্য')
on conflict (name) do nothing;
