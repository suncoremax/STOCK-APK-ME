# AXIION Stock Management — Miron Electronics
### Version beta v1 (V40 update)

A mobile-first stock & sales management web app built with **Vercel serverless functions** + **Supabase** (PostgreSQL).

---

## 🆕 What's New in V40 — Incremental Stock Balance (Supabase egress fix) + Product Reorder Fix

### Fix #1: Product reorder not surviving a page refresh

**The bug:** Dragging/nudging a product's position (▲▼ or typing a target
position) correctly wrote the new `sort_order` values to the database — but
on the next page load/refresh, products reverted to their old order. Root
cause: `api/dashboard.js` (which is what the app actually calls on every
boot — `?action=load-all`, plus the SO/DSR/Owner dashboards) was fetching
products ordered only by `created_at`, never by `sort_order`. Only
`api/products.js`'s own `GET` respected `sort_order` — but the app doesn't
call that route at boot, so the correct saved order was never actually
displayed after a refresh, even though it was safely sitting in the
database the whole time.

**The fix:** All 4 product fetches in `api/dashboard.js`, plus one in
`api/report.js`, now order by `.order('sort_order').order('created_at')` —
matching `api/products.js`. No database change needed for this part.

---

### Fix #2: Incremental Stock Balance (Supabase egress fix)

### The problem
Every dashboard load (Owner/Manager, SO, DSR, and the app-boot "load-all")
was re-fetching the **entire lifetime `transactions` table** just to sum up
current stock per product. This was always correct, but it meant the exact
same "open the dashboard" action got a little more expensive — in Supabase
**egress/bandwidth** — every single year, as the transactions table grew.
Left alone, this was the one thing most likely to eventually push a small
business past the free-tier egress cap, years down the line, even though
database storage itself stays small for a long time.

### The fix
`products` now has a `current_stock` column that is kept in sync
**automatically at the database level** by a trigger (`trg_apply_stock_delta`)
every time a stock-affecting transaction (`buy` / `give` / `return` /
`point_sale` / `point_damage_return`) is inserted — no matter which API
route inserts it, now or in the future. `api/dashboard.js` now reads this
column directly off the `products` row it already fetches, instead of
re-fetching and re-summing full transaction history on every load. The
"today" and "this month" figures, and the SR-wise due calculations, are
unchanged — those genuinely need to look at real transaction rows and were
already scoped narrowly (not full-history) except where noted below.

### Files touched
- `schema.sql` — `products.current_stock` column + the trigger, for **fresh
  installs** (new Supabase project, empty tables).
- `migration_v40_stock_balance.sql` — **run this instead of schema.sql** on
  an existing/live project. Adds the column, backfills it once from your
  real history, installs the same trigger. Doesn't touch or drop anything
  else.
- `api/_lib/db.js` — `mapProduct()` now also returns `currentStock`.
- `api/dashboard.js` — the four dashboard code paths (load-all, SO, DSR,
  Owner/Manager) read `current_stock` instead of re-summing full history.
  The Owner/Manager bonus calculation still needs lifetime data (it looks
  back to each product's own last-cleared date), so that one full-history
  fetch remains, but is now narrowed to `type = 'give'` only, since that's
  the only type the bonus calculation ever uses.
- `api/products.js` — new `GET /api/products?action=resync-stock` safety-net
  endpoint. Not called automatically anywhere — it's a manual repair tool
  an Owner can hit if `current_stock` ever needs to be recomputed from
  scratch (e.g. after restoring a backup or hand-editing rows in the
  Supabase dashboard directly).

### Fresh-start note
If you are setting up a **brand-new** Supabase project, just run the
updated `schema.sql` as normal — `current_stock` starts at 0 and the
trigger keeps it correct from the very first transaction.

If you already have a **live project with real data**, do NOT re-run
`schema.sql` (it drops every table). Instead run
`migration_v40_stock_balance.sql` once in the Supabase SQL Editor — it only
adds the new column/trigger and backfills the correct value, your existing
data is untouched.

### Known remaining full-history reads (not fixed in this pass)
Two spots still re-fetch full transaction history and were left as-is
since they're lower-traffic than the dashboard load (only fetched when
those specific tabs are opened, not on every page load):
- The Owner/Manager dashboard's SR-wise **due** calculation (who owes the
  company how much) — this is a genuinely lifetime aggregate per
  salesperson, not just per-product, so it can't reuse the same
  single-column trick without adding a second running-balance table.
- `computeBonusSummary()` in `api/_lib/db.js` (used by the Bonus/Claims
  tab) — same category of fix as this one, just not done yet.

Both are good candidates for the same incremental-balance technique later
if you want to fully eliminate this class of egress growth — happy to do
that pass too whenever you'd like.

---

## 🆕 What's New in V33 — DSR Map + separate Shop Register, Product ordering + Categories, Sell UI cleanup

### 1. DSR dashboard — brand new "🗺️ ম্যাপ" tab
Every registered shop plotted live on a map, plus the DSR's own GPS position
shown as a moving blue dot (updates continuously while the tab stays open,
stops as soon as the DSR leaves it — no background battery drain). A
checkbox toggles between "শুধু আমার দোকান" and "সব নিবন্ধিত শপ". Tapping any
shop in the list under the map pans/zooms straight to it and opens its
popup, which has a one-tap **🧭 নেভিগেট** link — opens Google Maps
turn-by-turn directions from wherever the DSR is currently standing to that
shop's saved GPS pin.

### 2. DSR dashboard — "➕ শপ নিবন্ধন" is now its own separate tab
Previously the "register a new shop here" button sat directly above the
shop-visit/sell list, so it was easy to tap by mistake while trying to open
a shop to sell to. It's now a fully separate tab in the DSR's tab bar — the
shop list itself only has a small, low-emphasis text link to get there on
purpose, so an accidental tap during a sale can no longer land the DSR on
the registration form.

### 3. DSR "শপ ডেলিভারি" sell screen — reorganised, less crowded
- A search box and (if categories are in use) category filter chips sit on
  top of the product list, so a DSR carrying 50+ SKUs doesn't have to
  scroll past everything to find what a shop actually wants.
- Each product's কেস/পিস quantity boxes are now clearly labelled instead of
  bare placeholder text, and show a running ৳ line-total the moment a
  quantity is entered.
- Commission input is now tucked behind an "➕ এই পণ্যে কমিশন যোগ করুন
  (ঐচ্ছিক)" toggle per product, since most sales don't use it — it no
  longer takes up a permanent slot on every row.

### 4. Product Catalog — manual re-ordering + Categories
- **Re-ordering**: every product row now shows its position number.
  Owner/Manager can nudge a product up/down with ▲▼, or type a target
  position directly into the number box and press Enter — e.g. type `5` on
  product #26 and it jumps straight to position 5, shifting everything
  else down by one, exactly as requested. Re-ordering is only available
  when no search/category filter is active (so "position 5" always means
  the same thing as what's saved).
- **Categories**: an optional "🗂️ ক্যাটাগরি" field on the Add/Edit product
  form (with autocomplete from categories already in use — e.g. "কোল্ড
  ড্রিংকস", "স্ন্যাকস"). The product list gets filter chips per category
  with live counts, and the DSR's sell screen gets the same category
  filter chips, so selling can be done category-by-category instead of
  scrolling one long flat list.
- New `products.category` (TEXT) and `products.sort_order` (INTEGER)
  columns — see `schema.sql`. `GET /api/products?action=categories` returns
  the distinct list already in use. `PUT /api/products` with
  `{action:'reorder', order:[id1,id2,...]}` bulk-rewrites `sort_order` for
  the whole given list in one shot.

### Fresh-start note
This is a **forward-only** addition — no backfill/migration needed. Run the
full `schema.sql` once on a fresh Supabase project (as documented below)
and the new columns/behaviour apply from that point on.

---

## 🆕 What's New in V31 — DSR Stock/Due Logic Fix (double stock deduction)

### The bug
When a DSR was given stock (দেওয়া — via manager give, Owner's direct give,
or a van-load), that stock was correctly deducted from company stock and
the **full value was registered as the DSR's own due** right away — this
part was already correct. But when that same DSR later sold that already-
loaded stock to a shop (the "visit-sale" flow, used when he visits a
registered shop), the app recorded that sale as a **`point_sale`** — the
exact same transaction type used for a genuine walk-in/counter sale — which
made the app deduct stock **a second time** for goods that had already left
the warehouse. It also meant a DSR's shop sales were silently mixed into
company-wide "given" totals a second time in reports.

### The fix
Introduced a new transaction type, **`dsr_sale`**, used only by the DSR
"visit a shop and sell" flow:
- `dsr_sale` is **excluded from stock calculation** (`calcStock` in
  `api/_lib/db.js`) — the stock was already deducted once, at `give` time.
- `dsr_sale` **does not reduce the DSR's own due** by itself. Per the
  confirmed business rule: the DSR's due only goes down when he (a) hands
  over actual cash (`sr_payments`), or (b) physically returns unsold stock
  (`return`). A credit sale to a shop just creates a `due_calendar` row
  under that shop (`client_type='shop'`) for visibility — the money still
  sits under the DSR's name/responsibility until it's actually collected.
- **True walk-in/counter sales** (no DSR give involved — `শপ.js`'s
  `point-sale` action, and the manual "পয়েন্ট সেল" wizard in the
  transaction screen) are **unchanged** — they still deduct stock
  immediately, exactly as before, since that stock never went through a
  DSR "give" step.
- New **`GET /api/sr-payments?action=dsr-reconcile&dsrId=&date=`** — used
  by the SR পেমেন্ট (Payment) entry screen (Owner/Manager) to show, for any
  DSR/SO + date: how much was given today, how much he's sold to shops,
  how much cash he's actually collected (should be handed over now), how
  much became a fresh shop-credit due today, how much stock is still
  unaccounted for (still on the van), and his all-time standing due. The
  same breakdown (minus the lifetime figure's cross-DSR list) is also
  returned to the DSR's own dashboard (`GET /api/dashboard?role=dsr...`)
  under `reconcile`, so a DSR can see his own daily accounting too.
- `schema.sql`'s `transactions.type` CHECK constraint now includes
  `'dsr_sale'`.

### Fresh-start note
This is a **forward-only** fix — no backfill/migration of old `give`/sale
history is performed or needed. Run the full `schema.sql` once on a fresh
Supabase project (as already documented below) and the new logic applies
from that point on.

---

## 🆕 What's New in V30 — Report Dashboard: Daily SO Report + Due Report

### 1. Daily SO Delivery Report (চালান-style, like the paper slip)
- New tab in রিপোর্ট → **🚐 SO রিপোর্ট**.
- For a chosen SO, shows one product-wise challan table **per DSR route** under that SO: প্যাক, ১ম লোডিং, ২য় লোডিং (however many "give" batches actually happened that day — 3rd/4th auto-added if needed), মোট লোডিং, ফেরত, (নষ্ট, only shown if any damage that day), বিক্রয়, দর, টাকা — plus a route subtotal and an SO-wide grand total. Exactly mirrors the paper চালান format (product / loading / return / sale / rate / amount), just computed automatically from the existing give/return/damage transactions instead of being hand-written.
- **1st/2nd/… loading** = each distinct stock-give batch that route received that calendar day (every van-load-finish or direct give shares one `tx_id`, so grouping by `tx_id` and ordering by time gives the day's loading events automatically — no new data entry needed anywhere else in the app).

### 2. Companion Due Report (auto-generated together, second page)
- Same document, second page (page-break before print): **আজকের বকেয়া**, **পূর্বের বকেয়া** (carried over from before that date), **সর্বমোট বকেয়া**, and a shop-wise table (দোকানের নাম, নং, ফোন, আজকের বকেয়া, পূর্বের বকেয়া, সর্বমোট) — built from the existing `due_calendar` shop entries for that SO + its DSRs.

### 3. Auto-generate at 2:00 AM (Asia/Dhaka) — or on demand
- A Vercel Cron hits `/api/report?action=cron-generate` every day at **02:00 Bangladesh time** and generates the previous day's report for **every SO** automatically.
- Owner can also generate (or regenerate) any date on demand from the রিপোর্ট tab — **always requires the Owner PIN**, re-verified server-side (not just the usual client-side confirm modal), same as other sensitive owner-only actions in this app.
- **Last 60 dates are kept per SO** — every time a new report is generated, older dates beyond the newest 60 are pruned automatically. Nothing needs manual cleanup.
- Every stored report can be opened, **printed (2-page PDF)**, downloaded as JPG, or shared to WhatsApp — same share-panel pattern as the existing delivery slip.

### New Environment Variable Required (for the 02:00 auto-generate cron only)
Add this to your Vercel project environment variables:
```
CRON_SECRET=any_long_random_string_you_choose
```
Vercel automatically sends this as an `Authorization: Bearer <value>` header when it triggers the cron — you don't need to configure anything else. **If you skip this**, the app still works completely normally — the Owner can still generate any day's report manually from the রিপোর্ট tab (Owner PIN required) — only the fully-automatic 2 AM run stays disabled until you add it.

### New Table
`daily_so_reports` (see schema.sql) — one row per (SO, date), storing both the delivery report and the due report as JSON, capped at 60 rows per SO.

### API Routes (still 12 total — at limit)
All of this lives inside the existing `/api/report` — no new serverless function file was added (Vercel Hobby plan caps functions at 12, and this project is already at that cap):
- `GET  /api/report?action=daily-list&soId=`         → last 60 stored report dates for one SO
- `GET  /api/report?action=daily-get&soId=&date=`    → one full stored report (for viewing/printing)
- `POST /api/report?action=daily-generate`           → Owner-triggered manual (re)generate — body `{ ownerPin, soId ('all' or one SO id), date }`
- `GET  /api/report?action=cron-generate`            → the 02:00 auto job (Vercel Cron only, `CRON_SECRET`-gated)

---

## 🆕 What's New in V25

### 1. Individual photos everywhere (instead of a generic role emoji)
- Every dashboard, list, and the live map now shows each person's **own individual photo** — not just a 👑/🧑/📊/🚚/🚛 role emoji.
- **Owner sets/uploads every photo** — DSR/SO/Driver photos are already set during registration (DSR/SO page, unchanged), and Manager now gets the same treatment: set a photo when creating the Manager PIN, or tap **📷 ছবি বদলান** next to an existing Manager anytime (পাসওয়ার্ড ম্যানেজার tab).
- If someone doesn't have a photo yet, their role-colored circle + emoji still shows as a fallback — nothing breaks for existing data.
- Updated everywhere a person is shown: side-menu header (your own photo), owner's attendance staff list, the person-attendance drill-down header, and the live map (marker pins, the people-chip strip, and popups) on দোকান ও লোকেশন / উপস্থিতি ও লোকেশন.
- New column: `user_passwords.thumb` (see schema.sql for fresh installs, or `MIGRATION_V25_photos_and_targets.sql` for an existing live database).

### 2. Sales Targets — SO-only split
- Owner still sets **one company-wide total target** exactly as before.
- That total now only ever splits across **SOs** — there's no separate DSR target row anymore. A DSR simply sees their **own paired SO's** target and progress (auto-connected via the existing SO↔DSR pairing), so nothing needs to be set for a DSR individually.
- New **🔄 সব SO-এর মধ্যে সমান ভাগে ভাগ করুন** button — one tap divides the company total evenly across every SO. Owner can still hand-edit any individual SO's figure afterwards to rebalance.
- Manager/SO keep the same view-only progress view as before, just without any DSR rows cluttering the list.

---

## What's New in V24

### 1. Menu rename
"শপ ও ম্যাপ" is now labelled **"দোকান ও লোকেশন"** (same tab/feature, text only).

### 2. Advance Salary Payment Request
- Every dashboard that shows the salary panel (Manager / DSR / Driver — via the উপস্থিতি ও লোকেশন tab) now has a **💵 অগ্রিম টাকার আবেদন করুন** box.
- Flow: enter amount → confirm with **your own PIN** (verifies it's really you) → request is sent to the Owner.
- Owner sees all pending requests in **মালিক অনুমোদন** (Owner Approval tab) with ✅ Approve / ❌ Reject.
- Once approved, the amount is **automatically deducted** from that person's salary total for that month — the salary panel shows "➖ অগ্রিম কর্তন" and the new balanced "পরিশোধযোগ্য" (payable) amount, and the ✅ পরিশোধ করুন owner payout button now pays the already-balanced figure.
- New table: `advance_requests` (see schema.sql for fresh installs, or `MIGRATION_advance_payment_only.sql` to add it to your existing live database without touching anything else).
- Driver's salary dashboard already shares the exact same code path as Manager/DSR (`renderAttScope` → `_salaryPanelHtml`), so this feature — and the whole salary view — is now identical across all three roles.

### 3. Important Numbers — search bar
- 🔍 A search box now sits above the "সকল নম্বর" list — type a shop/contact name to instantly filter, then tap the phone number to call directly (`tel:` link, unchanged).

---

## What's New in V1 — Global Group Chat

### Group Chat (Extra Features → Group Chat)
- One single global chat room for the entire company — all roles can read and send messages
- Each message shows: sender name, role badge (Owner / Manager / SO / DSR), and timestamp
- Messages load in chronological order; new messages appear at the bottom
- **Real-time updates** via Supabase Realtime subscriptions (auto-falls back to 4-second polling if realtime is unavailable)
- Fully mobile-responsive UI: scrollable message list, fixed input bar at bottom
- Enter key sends (Shift+Enter = new line); auto-growing textarea

### New Environment Variable Required
Add this to your Vercel project environment variables:
```
SUPABASE_ANON_KEY=your_supabase_anon_public_key
```
Find it in Supabase Dashboard → Project Settings → API → `anon public` key.

### API Routes (12 total — at limit)
Chat actions are merged into `/api/expenses`:
- `GET  /api/expenses?action=chat-config`  → returns Supabase URL + anon key for frontend realtime
- `GET  /api/expenses?action=chat-msgs`    → fetch last 80 messages
- `POST /api/expenses?action=chat-send`    → send a message

---

## 🆕 What's New in V5 — Smart Due Calendar

### Partial Payment (Installment) Support
- Dues no longer need to be cleared all at once
- Click **💳 পরিশোধ** to open the payment modal — enter any amount
- Quick-fill buttons: **২৫% / ৫০% / ৭৫% / সম্পূর্ণ**
- Status automatically becomes 🟠 **আংশিক** (partial) when partially paid, 🟢 **পরিশোধিত** when fully cleared
- Progress bar shows what % of each due has been paid
- Remaining balance always visible

### Owner PIN Verification
- Every payment action (full or partial) requires the **Owner PIN**
- PIN is verified client-side against the existing login system — no extra API calls

### Smarter Calendar Visuals
- **Heat-map**: days with the highest remaining due get a thicker border (top 40% by amount)
- **৳ amount badge** shown directly on each calendar cell so you can see which day has the most due at a glance
- **4-state color coding**: 🔴 Pending · 🟠 Partial · 🟢 Cleared · 🟡 Mixed
- **4-column summary strip**: Pending / Partial / Cleared / Total entries
- Calendar cells are taller (52px) to accommodate the amount badge

### New `status` State
- `pending` — no payment made
- `partial` — some payment made, balance remains
- `cleared` — fully paid

---

## Stack

| Layer       | Tech                              |
|-------------|-----------------------------------|
| Frontend    | Vanilla JS / HTML / CSS (SPA)     |
| Backend     | Vercel Serverless Functions (Node) |
| Database    | Supabase (PostgreSQL)             |
| Auth        | PIN-based role system (client)    |

---

## Roles & PINs

| Role    | PIN  | Access                                      |
|---------|------|---------------------------------------------|
| Owner   | 12345 | Full access + payment authorization         |
| Manager | 5620 | Most features, cannot authorize payments    |
| SO      | 1280 | View + limited entry                        |
| DSR     | 1275 | View only                                   |

---

## Database Migration (V4 → V5)

Run the following in your Supabase SQL editor:

```sql
-- Add paid_amount column
ALTER TABLE due_calendar ADD COLUMN IF NOT EXISTS paid_amount NUMERIC(14,2) DEFAULT 0;

-- Update status constraint to include 'partial'
ALTER TABLE due_calendar DROP CONSTRAINT IF EXISTS due_calendar_status_check;
ALTER TABLE due_calendar ADD CONSTRAINT due_calendar_status_check
  CHECK (status IN ('pending','partial','cleared'));
```

For **fresh installs**, run the full `schema.sql` — the V5 table definition is already updated.

---

## Project Structure

```
ME-main/
├── api/                     # Exactly 12 files — AXIION §3 hard limit
│   ├── _lib/db.js           # Supabase client, helpers, mappers
│   ├── auth.js              # Login + PIN/user management
│   ├── claims.js            # Bonus claims + damage claims (merged bonus.js+damage.js)
│   ├── dashboard.js         # Role-aware dashboards + app-boot load-all (?action=load-all)
│   ├── due-calendar.js      # Installment-capable due calendar (DSR + shop dues)
│   ├── expenses.js          # Expenses, chat, notices, contacts, personal calculator, online deposit
│   ├── products.js          # Product catalog + pricing
│   ├── report.js            # Date-range analytics report
│   ├── shops.js             # Shop registry, QR lookup, point-of-sale, clear-plate
│   ├── sr-payments.js       # SR payments + approval workflow + SO ordering/van-load
│   ├── srs.js               # DSR/SO staff registry, numbering, SO↔DSR pairing
│   └── transactions.js      # Give/Return/Buy/Damage/Point-sale ledger
├── public/
│   └── index.html           # Single-page vanilla-JS SPA
├── schema.sql               # Full fresh-install schema (V23)
├── vercel.json
└── package.json
```

---

## Deployment

1. Push to GitHub
2. Connect repo to Vercel
3. Add environment variables in Vercel:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_KEY`
   - `SUPABASE_ANON_KEY` — needed for Group Chat realtime (V1)
   - `CRON_SECRET` — optional but recommended; needed only for the 02:00 auto Daily SO Report (V30). Any long random string — Vercel sends it back automatically as the cron's `Authorization: Bearer` header.
4. In Supabase, run the full `schema.sql` once (fresh project — it drops/recreates every table, so don't run it against a live database with data you want to keep)
5. Deploy — Vercel auto-deploys on every push

---

## API Endpoints

| Method | Endpoint           | Description                          |
|--------|--------------------|--------------------------------------|
| GET    | /api/due-calendar  | Fetch dues (filter by `?month=YYYY-MM`) |
| POST   | /api/due-calendar  | Create a new due entry               |
| PUT    | /api/due-calendar  | Pay (partial/full) or edit           |
| DELETE | /api/due-calendar  | Delete a due entry                   |

### PUT payload for payment:
```json
{ "id": "<uuid>", "payAmount": 5000 }
```
Response includes `{ ok, paidAmount, remaining, status }`.
