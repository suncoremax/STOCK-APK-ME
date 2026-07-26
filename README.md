# AXIION Stock Management — Miron Electronics
### Version beta v1 (V57 update)

A mobile-first stock & sales management web app built with **Vercel serverless functions** + **Supabase** (PostgreSQL).

---

## 🆕 What's New in V57 — SO "Today's Sale" now shows NET (bonus-excluded) pieces + Point Sale SO-attribution

Still exactly the **12 API files** — no new endpoints, no schema
changes. Both changes live entirely inside the existing
`api/dashboard.js` and `public/index.html`.

1. **SO Dashboard → "আজকের মোট বিক্রয়" widget now shows NET sale, not
   gross.** Every product already has an Owner-set bonus config
   (`bonus_free_units` / `bonus_cases_req`, plus `case_size`) — e.g.
   "buy 1 case (24 pcs), get 2 pcs free." Previously the widget showed
   the raw pieces given by DSRs. Now, for each product, that raw count
   is reduced by the bonus pieces earned that day using the exact same
   case-math the Bonus Report already uses:
   `cases = floor(rawPieces / caseSize)`,
   `bonusPieces = floor(cases / bonusCasesReq) × bonusFreeUnits`,
   `shown = rawPieces − bonusPieces`.
   Example: 24 pcs sold, case size 24, bonus 2 pcs/case → shows **22**.
   Only the net number is returned/shown — there is no separate gross
   figure by design.

2. **Point Sale (Owner/Manager) now requires selecting an SO.**
   Previously an Owner/Manager point-sale was saved with a blank
   `sr_id`, so it never counted toward anyone's dashboard. There's now a
   required "কার পয়েন্ট থেকে বিক্রয় হচ্ছে — SO বাছাই করুন" dropdown as
   the first field of the Point Sale wizard (Owner/Manager screen only
   — the SO's own point-sale flow is unaffected). Once attributed, that
   sale is included in the selected SO's "today's total sale" figure,
   net of bonus, exactly like a normal DSR-delivered sale.
   ⚠️ No SQL migration needed for this update — every column involved
   (`case_size`, `bonus_free_units`, `bonus_cases_req`, `sr_id`) already
   existed in V56. Just redeploy `api/dashboard.js` and
   `public/index.html`.

---

## 🆕 What's New in V56 — Salary Overhaul + Weekly Road Scheduling + Road-Duty Banner (Spec §3, §4, §5)

Still exactly the **12 API files** — every change below lives inside
the existing `api/attendance.js`, `api/srs.js`, and `api/dashboard.js`.
Also: every ৳ figure app-wide now displays **2 decimal places instead
of 3** (single `fm()` formatter change, used 257× across the app).

1. **§3 — Salary system.** `salary_settings.base_salary` (a monthly
   total) is renamed/repurposed to `salary_per_day` — the Owner now
   enters a per-day rate directly, no more ÷ working-days step. Added a
   flat, Owner-configurable **"no 3-day gap" full-attendance bonus**
   (`no_gap_bonus_amt`) — paid whenever a person never goes 3+
   consecutive calendar days with no valid attendance in the cycle,
   independent of the on-time bonus toggle. Added an **Owner-settled
   target bonus** (`target_bonuses` table + `target-bonus-set` /
   `target-bonus-settle` / `target-bonus-list` actions) — informational
   only inside `computeSalary()`, never auto-added to the payable
   total; the Owner reviews eligibility and manually settles it from
   the Target tab.
   ⚠️ See `AXIION_V56_partial_migration.sql` for the required column
   rename + one-time data-approximation step if upgrading a live app.

2. **§4 — Weekly recurring road-visit scheduling.** Replaces the old
   one-row-per-date `road_visit_plans` calendar with a small weekly
   rule table (`road_weekly_plans`, one row per road+weekday). The
   Owner ticks a road's visit weekday(s) once from Owner → রোড
   ম্যানেজমেন্ট and it repeats automatically forever. `api/dashboard.js`
   now resolves "today's road duty" live from this table instead of
   pre-inserted date rows (SO: today's weekday; paired DSR: yesterday's
   weekday, unchanged "day after" rule). New actions: `road-weekly-set`,
   `road-weekly-delete`, `road-weekly-list` in `api/srs.js`. The old
   `road_visit_plans` table and its actions are kept, untouched, for
   historical reads only.

3. **§5 — Road-duty header banner.** "You're due at [road] today" now
   shows as a compact banner at the very top of the SO and DSR
   dashboards, on **every tab** — not just buried inside one specific
   tab's content — stacked above the Owner's own notice banner. The
   fuller road-duty card remains as a secondary detail inside the
   Overview (SO) / Dues (DSR) tabs.


Two items from the spec. **One table changed** (`online_deposit` — new
`id` PK + new `deposit_method` column, additive/non-destructive
migration, see `migration_v55_online_deposit.sql`) — still exactly the
**12 API files** (both changes live inside the existing
`api/expenses.js` and `api/dashboard.js`):

1. **Update #55 — Online Deposit: multiple entries/day + Bank/Depot
   method + fixed today/month totals + month picker + PDF slip.**
   `online_deposit` was one row per **date** (a `PRIMARY KEY`), and
   every save **upserted** it — so a second entry the same day silently
   overwrote the first, and there was no way to say whether a deposit
   went to the bank or was handed in as cash at the depot. It's now one
   row per **entry** (`id UUID PRIMARY KEY`, `date` no longer unique),
   with a required `deposit_method` ('bank' or 'depot'). `deposit-set`
   now **inserts** instead of upserting; `deposit-get`'s today/month
   figures are a **sum** over the date range (not a single-row read)
   and both now resolve "today" via `bdtToday()` (Asia/Dhaka) instead
   of the server's raw UTC clock — the old UTC-based resolution is why
   a deposit saved in the early hours of the Bangladesh day could
   appear to "not show up" in the today box, and why "this month" could
   occasionally look like it belonged to the wrong cycle. The
   breakdown modal (tap "এই মাসের মোট জমা") now has a **◀ পূর্ববর্তী /
   পরবর্তী ▶** month picker (any past pay-cycle month with data is
   browsable; future months are disabled) and each row shows its
   bank/depot method. A **📄 PDF স্লিপ** button on that same modal
   generates a downloadable/shareable monthly deposit slip — date,
   amount, method per row, grand total, company header, generation
   timestamp — using the exact same client-side html2canvas render →
   share-panel pattern already used for the SO daily/period challan
   slips (`_showSlipSharePanel`), so nothing is stored server-side.
2. **Update #56 — SO Dashboard: "Today's Total Sale" replaces "My
   DSR".** The "👥 আমার DSR" tab (a plain name-list with no real use for
   the SO) is removed. In its place, a new "📦 আজকের মোট বিক্রয়" tab
   shows, per product, how many **raw pieces** were sold **today** by
   this SO's assigned DSRs — `give` minus `return` units from
   `transactions`, sorted highest-sold first, with the same product
   photo/name styling used elsewhere in the app. This figure
   deliberately **excludes** any bonus/free units from the `bonus`
   table's buy-X-get-Y scheme — that stays a separate concept and is
   never mixed in, since this widget reflects exactly what will be
   registered on the company's sales records. The underlying
   `assignedDsrs`/`dsrIds` data this old tab merely displayed is
   untouched and still powers the DSR-due and DSR-transaction features
   elsewhere on the SO dashboard.

**Also checked, no change needed:** the requested punch-time cutoffs
(Manager must punch in by 8:00 AM, SO/DSR/Driver by 8:30 AM) were
already implemented correctly in `api/attendance.js` since V44 Update
#8 — verified against the live code, nothing was changed for this item.

See `update_note.md` (the owner's spec) for the full original request,
including items #3–#5 (Salary per-day, Road Visit weekly recurring
scheduling, Road-Duty notice banner) which are **not** part of this V55
release and remain open for a future update.

---

## 🆕 What's New in V52 — Point-of-Sale Customer Search + Deposit Breakdown (Updates #52–54)

Three items from the spec, all built on top of V49's Update #51
groundwork. **No new tables, no new columns** — `pos_customers` and
`transactions.customer_id` already existed. Still exactly the
**12 API files** (both new actions live inside `shops.js` and
`expenses.js`).

1. **Update #52 — Point-of-Sale customer search.** Both point-sale
   sub-flows (sale and damage/return) now have a "🔍 কাস্টমার খুঁজুন"
   search box on step 1. It searches registered shops **and**
   `pos_customers` records by name/phone (new read-only action
   `GET /api/shops?action=pos-customer-search&q=`) and auto-fills
   name/keeper/phone/address on tap, so a repeat customer never has to
   be retyped. `pos-customer-save` now also accepts an optional
   `selectedShopId`/`selectedCustomerId` — when the customer was
   picked from search, that exact record is reused/updated instead of
   re-matching by phone, so editing a phone-less repeat customer never
   creates a duplicate row.
2. **Update #53 — Same customer fields on Damage/Return under
   Point-Sale.** The point-sale damage/return wizard's step 1
   previously captured only a bare customer name. It now captures the
   same fields as the sale side (keeper name, phone, address) plus the
   Update #52 search box, and calls `pos-customer-save` before saving
   the `point_damage_return` transaction — which is now tagged with a
   real `shop_id`/`customer_id`, the same as a point-sale row.
3. **Update #54 — Daily Deposit tap-to-expand breakdown.** "এই মাসের
   মোট জমা" on the online-deposit panel (Owner/Manager and SO
   dashboards) is now tappable and opens a modal with a date-by-date
   breakdown of the current pay cycle's deposits (new read-only action
   `GET /api/expenses?action=deposit-history&date=`), instead of only
   showing the running total.

See `update_note.md` for the original spec.

---

## What's New in V49 — Owner/Manager Dashboard Cleanup + Point-of-Sale batch (Updates #47–51)

Five items from the spec. **One new table** (`pos_customers`) + **one
additive column** (`transactions.customer_id`) — still exactly the
**12 API files**:

1. **Update #47 — Full ranked SKU list, not just Top 4.** The old
   "সবচেয়ে বেশি বিক্রি" widget hid every product past 4th place.
   `api/dashboard.js`'s `buildTopSellers` is now `buildRankedSellers`:
   every product in the catalog is returned, ranked #1 (best-selling)
   down to the lowest, for both "today" and "this month" — including
   SKUs with zero sales, so the owner sees the complete picture. Medal
   icons (🥇🥈🥉) for the top 3, a plain rank number after that, in a
   scrollable panel so a large catalog doesn't blow up the dashboard.
   Response fields renamed `top4Today`/`top4Month` →
   `rankedToday`/`rankedMonth`.
2. **Update #48 — "Recent Transactions" removed.** The widget, its
   backing query, and the `recent` response field are gone entirely
   from the Owner/Manager dashboard.
3. **Update #49 — DSR/SO due amount → tap for full history.** The due
   figure on "DSR/SO বাকির তালিকা" is now tappable and opens a modal
   showing every transaction that makes up that due (source — supply/
   return/payment — date, product, and shop when there is one), not
   just the bare total. New read-only action `GET /api/transactions?
   action=due-history&srId=` — a pure read over the existing
   `transactions` + `sr_payments` tables. `transactions.shop_id`
   (defined back in Update #11 but never actually surfaced to the
   front-end) is now exposed through `mapTx`.
4. **Update #50 — Bengali numeral font fix.** `'Noto Sans'` now loads
   alongside `'Hind Siliguri'` and is listed **first** in every
   `font-family` stack app-wide (main document + both PDF-style popup
   slip windows). Noto Sans has no Bengali glyphs, so every Bengali
   character still renders in Hind Siliguri exactly as before — only
   digits 0–9 (where Hind Siliguri's "1" glyph looked visually
   inconsistent) now render from Noto Sans' clean lining numerals.
   Front-end only, no API/schema change.
5. **Update #51 — Full customer capture on Point-of-Sale.** The
   Point-Sale wizard's first step now captures shop/customer name,
   phone, address, and keeper name — the same basic fields as normal
   shop registration — instead of only a free-text name. A phone that
   matches an existing **registered shop** reuses that shop's real id/
   history; otherwise the details are saved to the new `pos_customers`
   table (kept deliberately separate from `shops` so a walk-in customer
   never pollutes the Shop Registry, road/map filters, or the Update
   #38 duplicate-name check). New action `POST /api/shops?action=
   pos-customer-save`, called right before the sale transaction itself,
   which is now tagged with a real `shop_id` or the new `customer_id`
   column instead of only a note-field mention.

See `update_note.md` for the original spec and `schema.sql`'s V49
header comment for the full breakdown.

---

## What's New in V48 — Shop Registration fixes + Reports batch (Updates #37, #38, #44, #45, #46)

Five items from the spec, all inside the existing **12 API files**,
**no new table, no schema/column change**:

1. **Update #37 — Edit a registered shop (Owner-only).** Name and phone
   can be edited after registration; GPS location stays locked (delete
   + re-register if it needs to move). Deleting a shop removes its map
   marker too.
2. **Update #38 — No duplicate shop names.** Registering or renaming a
   shop to the exact same name (trimmed, case-insensitive) as an
   existing shop is blocked — a distinguishing number/suffix is
   required instead (`api/shops.js`'s `_isDuplicateShopName` helper,
   server-side Owner PIN re-verified via `_verifyOwnerPin`).
3. **Update #44 — Generation timestamp everywhere.** Every generated
   report/sheet now stamps the actual date+time it was generated, not
   just who generated it.
4. **Update #45 — SKU-count line on the daily SO report.** One extra
   line: how many distinct SKUs were sold that day.
5. **Update #46 — Monthly damage report.** New spreadsheet-style export
   — one row per damaged SKU (case count, piece count, total quantity,
   buying price) — scoped to the Update #7 pay-cycle month, for
   reconciling total damage losses.

See `update_note.md` for the original spec.

---

## What's New in V47 — Reports & PDFs batch (Updates #39–43)

Five items from the spec, all inside the existing **12 API files**, no new
table, no schema/column change — `daily_so_reports.report_data`/`due_data`
are JSONB and already flexible enough to carry the extra fields:

1. **Update #39 — SO PDF report visual overhaul.** Same architecture as
   before (rendered client-side from raw JSON via html2canvas, never
   stored as a file server-side, to keep Supabase storage flat). Sale/
   return/damage columns are now colour-coded (green/orange/red) so
   they're distinct at a glance, the route header now also prints the
   Road (Update #21/#22) that route's SO/DSR is assigned to when set,
   and the document shows the actual generation date/time
   (`row.generatedAt`), not just who generated it.
2. **Update #40 — Case+piece, not raw pieces, on the SO report.** Every
   loading/return/damage/sold figure on the challan now prints as
   "X কেস Y পিস" (Update #15's rule), using each product's own case
   size — `api/report.js`'s product lookup (`fetchProductMetaMap`,
   formerly unit-type-only) now also returns `case_size` so this needs
   no extra query.
3. **Update #41 — "দর" → "কেস দর".** The challan's rate column now shows
   case price (rate × case size) instead of a per-piece price; the
   টাকা/amount total underneath is untouched — it was always computed
   from the per-piece rate, only the displayed rate column changed.
4. **Update #42 — Summary Board on period reports.** The date-range
   analytics report (`GET /api/report?from=&to=`) now has a dedicated
   "📊 সারাংশ বোর্ড" section: delivery/return/damage figures plus their
   money totals for that exact period, in one place.
5. **Update #43 — Two due figures on every report.** The SO daily
   report's due page already had this shape (today's due + carried-over
   previous due = grand total) and is now labelled more clearly; the
   date-range analytics report gains the same idea company-wide —
   this period's own due, and the cumulative due outstanding as of the
   period's end date — via a new `computePeriodDueTotals` helper (pure
   read over the existing `due_calendar` table).

See `update_note.md` for the original spec and `schema.sql`'s V47 header
comment for the full breakdown.

---

## What's New in V45 — Order Flow + DSR Van-Stock batch (Updates #28, #29, #32, #33, #34, #35, #36)

Seven items from the spec, all inside the existing **12 API files** —
one additive schema change (a new allowed value on an existing column,
not a new column or table):

1. **Update #28 — Simplified DSR Van-Load Completion.** The old
   per-item tick-then-finish flow is gone. The DSR now sees the whole
   approved load at once as read-only, color-coded rows and presses one
   single **"✅ সম্পন্ন"** button. That doesn't touch stock — it flags
   the load `load_status = 'load_complete'` and hands it to
   Manager/Owner, who review the same color-coded list on a new
   **"✅ নিশ্চিতকরণ প্রয়োজন"** tab and press **"নিশ্চিত করুন"** — that
   confirm step is what actually writes the `give` transactions and
   deducts warehouse stock (`api/sr-payments.js` actions
   `van_load_complete` / `van_load_confirm_list` / `van_load_confirm`;
   old `van_load_tick`/`van_load_finish` kept as harmless aliases).
2. **Update #29 — Auto-generated order memo.** The moment an SO submits
   an order, a timestamped memo (Product → Qty in case+piece → Rate/case
   → Total, footer with total cases + grand total) renders instantly,
   reusing the existing html2canvas-based share panel for
   print/save-as-JPG/share — pure front-end, no schema change.
3. **Updates #32/#33 — Fixed the "Empty Van" bug + day-scoped stock.**
   The DSR's sell-to-shop screen used to check main-**warehouse** stock
   (`S.stockMap`, always > 0 for nearly everything) instead of what that
   DSR actually loaded that day — DSRs could appear able to sell stock
   they never received. New read-only endpoint `GET
   /api/sr-payments?action=van-stock` computes true per-product van
   inventory scoped to exactly one date (given − returned − sold −
   Owner-reconciled damage only), with nothing from any other day ever
   read, so nothing carries over. Still-pending (unreconciled) damage
   stays counted as "in hand" until the Owner clears it.
4. **Update #34 — Case+piece display + visual refresh** on the DSR sell
   screen: stock badges now read "X কেস Y পিস" instead of a raw piece
   count, plus a gradient header and color-tinted product rows.
5. **Update #35 — Full due detail on the DSR's shop-visit screen** — the
   same richer treatment Update #12 already gave the Owner's due
   calendar (status label, partial-payment progress bar, creation
   time, reason/note), not just a bare date.
6. **Update #36 — Verified**: no handshake/pairing UI remains anywhere
   on the DSR dashboard — already fully removed back in Update #20. No
   further change needed.

See `update_note.md` for the original spec and `schema.sql`'s V45 header
comment for the full breakdown.

---

## What's New in V44 — Auth + SO Dashboard batch (Updates #18, #19, #30, #31)

Four items from the spec, all inside the existing 12 API files — **no new
API file, no new database table** beyond one additive column:

1. **Update #18 — Owner first-login forced password setup.** The Owner's
   seeded starter PIN (`12345`) now carries a `must_change_pw` flag
   (new `user_passwords.must_change_pw` column, defaults `false`, seeded
   `true` only for the fresh Owner row). `POST /api/auth` returns this
   flag on login; the front-end shows a full-screen, non-dismissible
   "set your own PIN" step — no close button, no backdrop-tap dismiss,
   hardware back does nothing here — before the app becomes usable. It
   submits through the existing `PUT /api/auth` `action=change`, which
   now also clears the flag (as does `action=owner_set`, for
   completeness).
2. **Update #19 — Self-service PIN change for every role.** The
   🔐 password page (and its existing `action=change` endpoint — no
   backend change needed here) was Owner-only before; it's now on every
   role's own side menu (Manager/SO/DSR/Driver), labelled "আমার
   পাসওয়ার্ড" for them vs. Owner's "পাসওয়ার্ড ম্যানেজার". Each
   non-owner role only ever sees/changes their own PIN — the "manage
   everyone's PIN" admin section underneath stays strictly
   `role === 'owner'`-gated, unchanged.
3. **Update #30 — Handshake-protocol UI removal, SO dashboard.**
   Verified already fully done back in V36 (Update #20 — SO↔DSR
   auto-pairing by registration order removed the manual
   connect/handshake step everywhere, including the SO dashboard's "আমার
   DSR" tab, which is read-only). No further change required.
4. **Update #31 — "আজকের বিক্রয়" summary cards on the SO dashboard.**
   New at-a-glance row under the existing overview metrics: today's
   sale (gross, before returns), today's damage cost, and today's
   returns — each its own card, all in Bengali. `GET
   /api/dashboard?role=so` now also returns `today.saleGross`,
   `today.damage`, `today.returns` alongside the existing (unchanged)
   `today.revenue` net figure.

See `update_note.md` for the original spec and `schema.sql`'s V44 header
comment for the full breakdown.

---

## What's New in V43 — Sales Targets (Updates #1–6)

Six fixes/upgrades to the existing ৳-total + per-product Sales Target
system, all inside `api/attendance.js`'s existing target actions — **no
new API file, no new database table** (still exactly 12 functions):

1. **Per-product CASE targets** — the owner's per-product quantity
   target is now explicitly a **case** count. A sale only counts once
   enough pieces have accumulated to fill a full case (uses each
   product's own case size) — nothing is tracked or shown in raw
   pieces. The list itself now follows the same order as the Product
   Catalog page, instead of alphabetical.
2. **Color-coded product target blocks** — each product's card on the
   target page gets its own background/border color from a fixed
   10-color palette, so they're easy to tell apart at a glance.
3. **Distinct color theme per SO** — same palette, applied per-SO on
   the target dashboard.
4. **Fixed: individual SO progress % stuck at 0%** — root cause: real
   shop sales are recorded under the *delivering DSR's* id, not the
   SO's own id, so filtering strictly by the SO's id found almost
   nothing. Achieved-% now sums the SO **and** their auto-paired DSR(s)
   together.
5. **Owner PIN required to save any target** — every target save
   (total, per-SO, even-split, per-product) now prompts for the Owner
   PIN client-side (`confirmOwnerPin`) and re-verifies it server-side
   against `user_passwords` before writing.
6. **"RADT" daily case-target widget** — new read-only
   `action=daily-target-split` splits the remaining total case target
   across the working days left in the pay cycle (Update #7's 26→25
   cycle), excluding Friday. Shown on the Owner/Manager, SO, and DSR
   dashboards.

See `update_note.md` for the original spec (Updates #1–6) and
`schema.sql`'s V43 header comment for the full breakdown.

---

## What's New in V41 — Roads / Routes (Updates #21–27)

New feature: **Roads** — the Owner can create named routes ("রোড"), assign
one SO per road (their auto-paired DSR — Update #20 — inherits the same
road automatically, no manual DSR-to-road step anywhere), pick a road at
shop registration to auto-derive that shop's DSR instead of choosing one by
hand, filter the shop list/map by road, and schedule "SO visits road X on
date D, paired DSR delivers on D+1" visit-day plans that surface as a
"you're due at [road] today" widget on both the SO's and DSR's dashboards.
The shared shop map now also shows same-day visit ticks (colour-coded SO
vs. DSR, auto-resetting at midnight with no cleanup job needed) and the
viewer's own live GPS position, for every role that opens it — not just the
DSR's dedicated map tab.

**No 13th API file was created** — every new action lives inside the
existing `api/srs.js` (Roads CRUD, SO→road assignment, visit-day plans) and
`api/shops.js` (road-aware registration/filtering, visit logging), per the
Vercel Hobby 12-function cap. Schema changes are purely additive: `roads`,
`road_visit_plans`, `shop_visits` tables, plus `road_id`/`road_name`
columns on `srs` and `shops`. See `schema.sql`'s V41 header comment for the
full breakdown, and `update_note.md` for the original spec (Updates #21–27).

---

## What's New in V40 — Incremental Stock Balance (Supabase egress fix) + Product Reorder Fix

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
├── schema.sql               # Full fresh-install schema (V52)
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
