-- ══════════════════════════════════════════════════════════════════
--  AXIION স্টক ম্যানেজমেন্ট — Supabase Schema V55
--  Miron Electronics
--  ✅ V55 (Updates #55–56): Online Deposit multi-entry/Bank+Depot
--           overhaul + SO Dashboard "Today's Total Sale" widget.
--           ONE table changed (`online_deposit` — new `id` PK + new
--           `deposit_method` column, additive/non-destructive), still
--           exactly 12 API files (both changes live inside the
--           existing `api/expenses.js` and `api/dashboard.js`):
--           #55 `online_deposit` converted from one-row-per-date
--              (upserted, so a 2nd entry the same day overwrote the
--              1st) to one-row-per-ENTRY: new `id UUID PRIMARY KEY`,
--              `date` no longer unique by itself, new required
--              `deposit_method TEXT CHECK IN ('bank','depot')` column.
--              `deposit-set` now INSERTs instead of upserting (so any
--              number of entries/day are kept, each tagged bank/depot);
--              `deposit-get`'s today/month figures are now a SUM over
--              that date range's rows, not a single row read, and both
--              now resolve "today" via `bdtToday()` (Asia/Dhaka) instead
--              of the server's raw UTC clock, fixing the early-morning-
--              BDT day-boundary mismatch that made a just-saved entry
--              seem to "not show up" in the today box; `deposit-history`
--              gained a `period=YYYY-MM` parameter (defaults to the
--              pay-cycle containing `date`) so the breakdown modal can
--              page to any past month with data, returns `method` per
--              row, and is reused as-is to feed the client-side monthly
--              PDF/JPG deposit slip (rendered with the same html2canvas
--              share-panel pattern as the existing challan slips — no
--              server-side storage).
--           #56 SO Dashboard: the "👥 আমার DSR" name-list tab is
--              removed (the underlying `assignedDsrs`/`dsrIds` data
--              this tab merely displayed is untouched and still powers
--              DSR-due and DSR-transaction features elsewhere). In its
--              place, a new "📦 আজকের মোট বিক্রয়" tab shows, per
--              product, RAW pieces sold today (`give` − `return`
--              units, from `transactions`, across this SO's assigned
--              DSRs only) — no `bonus` top-up mixed in — sorted
--              highest-sold first, product photo + name from the
--              existing `products` table. Pure application-logic
--              change in `api/dashboard.js` (`role='so'` block, new
--              `todayProductSales` response field) — no schema change
--              for this part.
--           ℹ️  Punch-time cutoff request (Manager by 8:00 AM, SO/DSR/
--              Driver by 8:30 AM) — VERIFIED ALREADY CORRECT in the
--              existing codebase since V44 Update #8 (see
--              `api/attendance.js`, action=`punch`, `onTimeEndMin`).
--              No change was needed or made for this item.
--  ✅ V52 (Updates #52–54): Point-of-Sale customer search + Daily
--           Deposit breakdown. PURE application-logic change — NO new
--           table, NO new/changed column, still exactly 12 API files:
--           #52 Point-of-Sale customer search — new read-only action
--              `GET /api/shops?action=pos-customer-search&q=` searches
--              both `shops` and the V49 `pos_customers` table by name/
--              phone, so a repeat point-sale customer (sale OR
--              damage/return) can be found and auto-filled instead of
--              retyped. `pos-customer-save` (V49) gained two optional
--              body fields, `selectedShopId`/`selectedCustomerId` — set
--              when the customer was picked from search, so that exact
--              record is reused/updated instead of re-matched by phone.
--           #53 Point-sale damage/return sub-flow now captures the same
--              full customer fields as the sale side (V49): keeper
--              name, phone, address — not just a bare name — and calls
--              `pos-customer-save` before the `point_damage_return`
--              transaction is written, tagging it with a real
--              `shop_id`/`customer_id` (both columns already existed
--              from V49) instead of only a free-text `note`.
--           #54 "এই মাসের মোট জমা" (this month's total online deposit)
--              is now tappable, opening a date-by-date breakdown of the
--              current pay-cycle's deposits. New read-only action
--              `GET /api/expenses?action=deposit-history&date=` — a
--              pure read over the existing `online_deposit` table using
--              the same V41-#7 pay-cycle boundary (26th → 25th) as the
--              existing `deposit-get` running-total action.
--  ✅ V49 (Updates #47–51): Owner/Manager Dashboard Cleanup + Point-of-
--           Sale batch. ONE new table (`pos_customers`) + one additive
--           column (`transactions.customer_id`) — still exactly 12 API
--           files:
--           #47 "Top 4 Products" widget replaced with a full ranked SKU
--              list — every product, #1 (best-selling) down to the
--              lowest, for both "today" and "this month". Pure
--              application-logic change in api/dashboard.js
--              (buildTopSellers → buildRankedSellers) — no schema
--              change, response fields renamed top4Today/top4Month →
--              rankedToday/rankedMonth.
--           #48 "Recent Transactions" widget removed entirely from the
--              Owner/Manager dashboard — the backing query in
--              api/dashboard.js and the `recent` response field are
--              both gone.
--           #49 DSR/SO due amount is now tappable — opens that
--              person's full due transaction history (source: give/
--              return/payment, date, product, shop when there is one).
--              New read-only action `GET /api/transactions?action=
--              due-history&srId=` — pure read over the existing
--              `transactions` + `sr_payments` tables, no schema change.
--              `transactions.shop_id` (already a column, previously
--              unused by any live code path) is now surfaced through
--              `mapTx` so this and future features can read it.
--           #50 Bengali numeral/digit font fix — 'Noto Sans' now loads
--              alongside 'Hind Siliguri' and is listed FIRST in every
--              font-family stack app-wide. Noto Sans has no Bengali
--              glyphs, so all Bengali text still renders in Hind
--              Siliguri exactly as before; only digits 0–9 (where Hind
--              Siliguri's '1' glyph looked visually off) now render
--              from Noto Sans. Front-end only, no API/schema change.
--           #51 Point-of-Sale now captures full customer details (shop/
--              customer name, phone, address, keeper name — the same
--              basic fields as normal shop registration) as a proper
--              stored record, instead of only a free-text name. A phone
--              number that matches an existing REGISTERED shop reuses
--              that shop's real id/history; otherwise the details are
--              saved to the new `pos_customers` table (deliberately
--              separate from `shops` so a walk-in customer never
--              pollutes the Shop Registry, road/map filters, or the
--              duplicate-shop-name check from Update #38). The sale
--              transaction is tagged with whichever id applies via the
--              new `transactions.customer_id` column (mirrors the
--              existing `shop_id` column, which was defined back in
--              Update #11 but never actually written to by any live
--              code path until now). New action `POST /api/shops?
--              action=pos-customer-save`, called by the front-end
--              Point-Sale wizard right before the sale itself is saved.
--  ✅ V48 (Updates #37, #38, #44, #45, #46): Shop Registration fixes +
--           Reports batch. PURE application-logic change — no new
--           table, no new/changed column, still exactly 12 API files:
--           #37 Owner can edit a registered shop's name/phone (GPS stays
--              locked — delete + re-register to move it); deleting a
--              shop removes its map marker too.
--           #38 Registering/renaming a shop to the exact same name
--              (trimmed, case-insensitive) as an existing shop is now
--              blocked — `api/shops.js`'s `_isDuplicateShopName` helper,
--              checked on both `action=register` and the new edit
--              action.
--           #44 Every generated report/sheet now stamps its actual
--              generation date+time, not just who generated it.
--           #45 Daily SO report gains one extra line: how many distinct
--              SKUs were sold that day.
--           #46 New monthly damage report — one row per damaged SKU
--              (case count, piece count, total quantity, buying price),
--              scoped to the Update #7 pay-cycle month, spreadsheet-
--              style layout for reconciling total damage losses.
--  ✅ V47 (Updates #39–43): Reports & PDFs batch — SO daily report visual
--           overhaul + period-report improvements. PURE application-logic
--           change — no new table, no new/changed column, on top of the
--           existing `daily_so_reports` (report_data/due_data are JSONB,
--           already flexible) and `due_calendar` tables:
--           #39 SO PDF report visual overhaul — kept the exact same
--              architecture (rendered client-side from raw JSON via
--              html2canvas, never stored as a file, to keep Supabase
--              storage flat). Sale/return/damage columns are now
--              colour-coded (green/orange/red) throughout the challan
--              table, the route header now also prints the Road (Update
--              #21/#22) that SO/DSR belongs to when set, and both pages
--              of the document now show the actual server-side
--              generation timestamp (row.generatedAt), not just who
--              generated it.
--           #40 Every loading/return/damage/sold figure on the SO
--              challan is now printed as "X কেস Y পিস" (Update #15's
--              rule) using each product's own case_size, instead of a
--              bare piece count — api/report.js's product-meta fetch
--              (`fetchProductMetaMap`, formerly unit-type-only) now also
--              carries case_size through into report_data so this can
--              render without re-querying products.
--           #41 The "দর" (unit price) column on the SO challan is now
--              "কেস দর" (case price) — a straight display-time multiple
--              (rate × case_size) of the exact same per-piece rate the
--              টাকা/amount total already used; the underlying money math
--              is unchanged, only what that one column shows.
--           #42 Date-range analytics report (api/report.js's plain
--              `?from=&to=` action) gains a clearly-labelled "সারাংশ
--              বোর্ড" (Summary Board) section pulling delivery/return/
--              damage figures and their money totals for that exact
--              period into one place.
--           #43 "Two due figures on every report": the SO daily report's
--              existing due-report (today's due + carried-over previous
--              due = grand total) already had this shape and is now just
--              more clearly labelled; the date-range analytics report
--              gains the same concept company-wide — periodDue (due
--              created inside the picked range) and cumulativeDue (all
--              outstanding due as of the range's end date) — computed by
--              a new `computePeriodDueTotals` helper, pure read over the
--              existing `due_calendar` table.
--  ✅ V45 (Updates #28, #29, #32, #33, #34, #35, #36): Order flow +
--           DSR van-stock batch. ONE additive schema change (an
--           allowed-value addition, not a new column) — still exactly
--           12 API files, no new table:
--           #28 Simplified DSR Van-Load Completion — the old per-item
--              tick-then-finish flow is replaced with a single "সম্পন্ন"
--              button. orders.load_status gains a new value,
--              'load_complete', sitting between 'approved' (not yet
--              loaded) and 'loaded' (stock actually deducted): DSR
--              taps সম্পন্ন → load_status='load_complete' (no
--              transaction written yet) → Manager/Owner reviews the
--              color-coded item list and taps নিশ্চিত করুন
--              (api/sr-payments.js action=van_load_confirm) → THAT is
--              the point the real `give` transactions are written and
--              stock leaves the warehouse — same underlying write the
--              old van_load_finish did, just now gated behind an
--              explicit Manager/Owner approval instead of the DSR's own
--              tap, matching every other stock-affecting flow in the
--              app. Old van_load_tick/van_load_finish actions are kept
--              as harmless no-op-if-unused aliases for compatibility.
--           #29 Auto-generated, timestamped, downloadable/printable
--              order memo — pure front-end (reuses the existing
--              html2canvas-based _showSlipSharePanel), no schema change.
--           #32/#33 Fixed the "Empty Van" bug: the DSR's sell-to-shop
--              screen used to check main-WAREHOUSE stock (always > 0
--              for nearly everything) instead of what that DSR actually
--              had loaded that day. New read-only endpoint
--              api/sr-payments.js action=van-stock computes true,
--              day-scoped (no carry-over — never reads any date but the
--              one asked for) per-product van inventory: given −
--              returned − sold-to-shops − damage the Owner has already
--              reconciled (dmg_claims.status='cleared'); still-pending
--              damage stays counted as "in hand" per #33 until the
--              Owner clears it. No new table/column — pure read over
--              existing transactions + dmg_claims rows.
--           #34 Case+piece display (not raw pieces) + a visual refresh
--              on the DSR sell screen — pure front-end.
--           #35 Shop-visit due list now shows the full reason/status/
--              creation-time detail (same richer treatment Update #12
--              already gave the Owner's due calendar), not just a bare
--              date — pure front-end, reuses fields mapDue() already
--              returns (note, createdAt, status).
--           #36 Verified: no handshake/pairing UI remains anywhere on
--              the DSR dashboard (removed already back in Update #20) —
--              no further change needed.
--  ✅ V44 (Updates #18, #19, #30, #31): Auth + SO dashboard batch.
--           #18 First-login forced password setup for Owner — new
--              `user_passwords.must_change_pw` column (BOOLEAN, defaults
--              false; the seeded Owner row is inserted with it TRUE).
--              On login, api/auth.js POST now also returns this flag;
--              the front-end shows a non-dismissible "set your own
--              password" screen until the Owner submits a new PIN via
--              the existing PUT action=change, which clears the flag.
--           #19 Self-service "change my own PIN" is now reachable by
--              every role (Manager/SO/DSR/Driver), not just Owner — the
--              existing 🔐 পাসওয়ার্ড menu item (and its existing
--              action=change endpoint, unchanged) is now shown for all
--              roles; only the Owner still additionally sees the
--              "manage everyone's PIN" admin section beneath it. No
--              schema change needed for this one beyond #18's column.
--           #30 Handshake-protocol UI removal on the SO dashboard was
--              already completed back in V36 (Update #20 — auto-pairing
--              by registration order) — verified still fully removed,
--              no further change needed here.
--           #31 New "আজকের বিক্রয়" (today's sale) summary cards on the
--              SO dashboard — sale, damage, and returns figures for
--              today. Pure read: reuses existing `transactions` rows
--              already fetched by api/dashboard.js's SO section (adds
--              a `damage`/`returns`/`saleGross` breakdown to the
--              existing `today` object), no schema change.
--  ✅ V43 (Updates #1–6): Sales Targets batch. NO NEW TABLES, NO
--           COLUMN CHANGES — this batch is pure application-logic on
--           top of the existing `targets`/`product_targets` tables
--           from V24/V32:
--           #1 Per-product CASE targets: product_targets.target_qty is
--              now read/achieved as whole CASES (converted from raw
--              transaction pieces via each product's own case_size —
--              see api/attendance.js _achievedCasesByProduct), and the
--              list is ordered by products.sort_order to match the
--              Product Catalog instead of alphabetically.
--           #2/#3 Color-coded product blocks / per-SO themes — front-end
--              only (public/index.html TARGET_PALETTE), no schema/API
--              data shape change.
--           #4 BUG FIX: an individual SO's achieved-% used to filter
--              transactions by sr_id = the SO's own id, but real sales
--              are recorded under the DELIVERING DSR's id — so it was
--              effectively always ~0. Fixed to sum the SO + every DSR
--              auto-paired to them (srs.so_id), same "SO + assigned
--              DSRs" id-list pattern api/dashboard.js already used.
--           #5 Owner PIN now required (and re-verified server-side
--              against user_passwords) on every target save — target-set,
--              target-split-even, product-target-set.
--           #6 New read-only action=daily-target-split ("RADT" widget):
--              splits the remaining total case target across the
--              working days left in the pay cycle (Update #7), excluding
--              Friday — shown on every role's dashboard.
--  ✅ V41 (Updates #21–27): "Roads" / Routes — new feature. Owner
--           creates roads freely by name (`roads` table, #21); assigns
--           one SO per road and the SO's auto-paired DSR (Update #20)
--           inherits the same road automatically (#22 — srs.road_id/
--           road_name + roads.dsr_id/dsr_name, set by api/srs.js
--           action=road-assign-so); shop registration now picks a road
--           instead of a DSR, auto-deriving assigned_dsr_id/name from
--           that road (#23 — shops.road_id/road_name); shops can be
--           filtered by road (#24 — shops.js action=list/search now
--           accepts roadId); Owner schedules "SO visits road X on date
--           D, paired DSR delivers D+1" (#25 — `road_visit_plans`,
--           surfaced on both dashboards by api/dashboard.js); the map
--           shows same-day visit ticks per shop, colour-coded SO vs.
--           DSR, needing no cleanup job since every read is scoped to
--           today's date (#26 — `shop_visits`); and the map shows the
--           viewer's own live GPS position alongside DSR dots (#27 —
--           front-end only, public/index.html, no schema change).
--           No existing table's data or existing route's behaviour
--           changed — this is purely additive (2 new columns each on
--           `srs`/`shops`, 3 new tables).
--  ✅ V36 (Update #20): Removed the manual SO↔DSR "handshake" pairing
--           entirely (srs.so_link_status column + pair_request/
--           pair_accept/pair_reject actions are gone). Pairing is now
--           fully automatic by registration order: the 1st SO ever
--           registered (display_no=1) auto-pairs with the 1st DSR ever
--           registered (display_no=1), 2nd with 2nd, and so on — no
--           manual "connect" step anywhere in the app. so_id/so_name on
--           `srs` stay as the single permanent pairing link, now set by
--           the server at creation time instead of by hand. See
--           api/srs.js for the matching logic.
--  ✅ V35: (1) DSR পেমেন্ট পেজ — আজকের কমিশন/ছাড়/ড্যামেজের সারাংশ যোগ
--           হলো, যাতে পেমেন্ট হিসাব সঠিকভাবে সম্পন্ন করা যায়। এর জন্য
--           transactions টেবিলে দুটি নতুন কলাম: commission_amt,
--           discount_amt (দোকানে বিক্রয়ের সময় প্রতি-আইটেম কমিশন/ছাড়
--           এখন স্থায়ীভাবে সংরক্ষিত হয় — আগে শুধু বিলের মোট হিসেবে
--           দেখানো হতো, ডাটাবেসে জমা থাকত না)।
--           (2) ড্যামেজ লজিক সংশোধন — ড্যামেজ রেজিস্টার করলে এখন আর
--           স্টক কমবে না (পণ্যটি শুধু রিপোর্ট/দাবির জন্য চিহ্নিত হয়,
--           গুদামের স্টক অপরিবর্তিত থাকে)। ড্যামেজ রিপোর্টে এখনো ক্রয়
--           মূল্য (purchase_price/total_cost) ব্যবহার হয় — কোম্পানির
--           কাছে সরবরাহকারীর থেকে দাবির জন্য। DSR পেমেন্ট পেজে ঐ একই
--           ড্যামেজ এন্ট্রির বিক্রয় মূল্য (selling_price/total_revenue)
--           ব্যবহার হয় — DSR এর আজকের হিসাব থেকে বাদ দেওয়ার জন্য। এই
--           দুটি হিসাব ইচ্ছাকৃতভাবে আলাদা রাখা হয়েছে। NO NEW TABLE —
--           শুধু transactions এ ২টি কলাম যোগ; বাকি সব স্কিমা অপরিবর্তিত।
--  ✅ V34: Shop Delivery panel cleanup + GPS auto-detection + per-case
--           commission/discount (this update). Removed the "নতুন শপ
--           নিবন্ধন করতে চান?" shortcut link and the always-on full
--           "shop name + due/clean status" list from the DSR's শপ
--           ডেলিভারি panel (shop registration already lives on its own
--           dedicated tab). In their place: the panel now auto-detects
--           nearby registered shops from the DSR's live GPS position
--           (within 300m) — exactly one nearby shop auto-selects itself
--           with a one-tap "sell now" card, multiple nearby shops show
--           only those as a pick-list, and the manual search box still
--           works as a fallback. আজকের বাকি আদায় (Due Collection) section
--           is untouched, still at the very bottom of the same panel.
--           Also: the per-product Commission field in the delivery sale
--           screen is now "commission PER CASE" (total = rate × cases
--           sold, auto-calculated) instead of a manually-typed total, and
--           a new matching "ছাড় (Discount) per case" field was added
--           right below it with the same per-case × cases-sold logic.
--           NO SCHEMA CHANGE — this entire update is front-end logic
--           (public/index.html) only; every column it touches
--           (shops.lat/lng, due_calendar.*) already existed.
--  ✅ V33: Product Category + manual re-ordering (products.category,
--           products.sort_order — see products.js action=reorder /
--           action=categories), DSR dashboard gets its own dedicated
--           "শপ নিবন্ধন" tab (separated from the shop-visit/sell flow to
--           stop accidental taps) and a dedicated live "ম্যাপ" tab (every
--           registered shop + the DSR's own live GPS position + a
--           one-tap "নেভিগেট" that opens Google Maps turn-by-turn
--           directions). DSR sell screen reorganised (search + category
--           filter + clearer per-product quantity rows). No schema
--           change beyond the two new products columns above — shops.lat/
--           lng already existed.
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
--           display_no pairing (§10 — originally a manual handshake,
--           replaced by fully automatic same-number pairing in V36 /
--           Update #20), the full Shop Registry + due linkage (§11/§12),
--           and the SO Order → Approval → Van-Load workflow tables
--           (§13). Personal
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
--  ✅ V30: AXIION Blueprint — Report Dashboard: Daily SO Delivery Report +
--           Due Report. New table `daily_so_reports` stores a full daily
--           snapshot per SO (product-wise loading/return/sale challan
--           across every DSR route under that SO, plus a companion
--           shop-wise due report — today's due, carried-over previous
--           due, and a per-shop breakdown). Reports auto-generate every
--           day at 02:00 Asia/Dhaka via a Vercel Cron hitting
--           api/report.js?action=cron-generate (needs env var
--           CRON_SECRET — see README), or the Owner can generate on
--           demand from the রিপোর্ট tab (Owner PIN required every time,
--           re-verified server-side). Only the most recent 60 dates are
--           kept per SO — older snapshots are pruned automatically on
--           every new generation. No changes to any existing table.
--  ✅ V31: "অনলাইন জমার পরিমাণ" simplified — replaced the old per-SO
--           daily quota (owner had to set a separate target for every
--           SO) with a single shared daily amount. Owner enters ONE
--           number each day ("আজকে অনলাইন জমা কত টাকা জমা হয়েছে") and
--           it shows identically on every SO's dashboard as two
--           numbers: আজকের জমা (today's amount) and এই মাসের মোট জমা
--           (sum of every day entered so far this month). New table
--           `online_deposit` (date PK, amount, set_by, set_at)
--           replaces `so_daily_quota` entirely.
--  ✅ V32: Sales Target page — added a SECOND target type below the
--           existing ৳ money target: owner can now also set a
--           quantity target per product (e.g. 500 কেস of a product
--           this month), company-wide. New table `product_targets`
--           (period, product_id, target_qty). Read-only progress bar
--           for everyone else, same live-computed achieved pattern.
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
  -- V33: category — free-typed label (owner types a name, or picks one
  -- already used by another product — see products.js ?action=categories).
  -- sort_order — manual display order (§ product re-ordering); assigned as
  -- max(sort_order)+1 on every insert, and rewritten in bulk whenever the
  -- Owner drags/moves a product to a new position (products.js action=reorder).
  category         TEXT        DEFAULT '',
  sort_order       INTEGER     DEFAULT 0,
  -- V40: running stock balance, maintained automatically by the
  -- trg_apply_stock_delta trigger below every time a stock-affecting
  -- transaction row is inserted (buy/give/return/point_sale/
  -- point_damage_return). Reading this column directly replaces the old
  -- pattern of re-fetching and re-summing the ENTIRE lifetime
  -- transactions table on every dashboard load just to know current
  -- stock — that old pattern got linearly more expensive (in Supabase
  -- egress) as the transactions table grew year over year. This column
  -- is always kept in sync at the database level, not the app level, so
  -- every current and future API route gets correct stock for free.
  current_stock    NUMERIC(14,4) DEFAULT 0,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_products_category   ON products(category);
CREATE INDEX idx_products_sort_order ON products(sort_order);

-- so_id: UUID-as-text of the paired SO for a DSR (or, mirrored the other
--   way, the paired DSR "belongs to" this SO) — '' = no same-numbered
--   partner registered yet. This is now set automatically by the server
--   at creation time (see api/srs.js), never chosen manually (Update #20).
-- display_no: stable per-role number (DSR-1, DSR-2… / SO-1, SO-2…),
--   assigned once and never reused even if the slot's name changes (§10).
--   Update #20: matching display_no across roles = the auto-pair (DSR-1
--   ↔ SO-1, DSR-2 ↔ SO-2, …). No more manual "connect" handshake.
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
  -- road_id/road_name (Update #21/#22): which Road this SO is assigned
  -- to. The paired DSR (so_id link above) automatically inherits the
  -- exact same road_id/road_name the moment their SO is assigned — see
  -- api/srs.js action=road-assign-so. '' = not assigned to any road yet.
  road_id        TEXT        DEFAULT '',
  road_name      TEXT        DEFAULT '',
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_srs_so_id      ON srs(so_id);
CREATE INDEX idx_srs_role       ON srs(role);
CREATE INDEX idx_srs_road_id    ON srs(road_id);
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
  -- V31: 'dsr_sale' = a DSR selling stock he already loaded (already
  -- deducted from stock + already registered as his due at 'give' time)
  -- to a registered shop. Deliberately distinct from 'point_sale' (a
  -- true walk-in/counter sale straight out of warehouse stock, which
  -- still deducts stock) so the same stock is never deducted twice.
  type           TEXT        NOT NULL CHECK (type IN ('give','return','damage','buy','point_sale','point_damage_return','dsr_sale')),
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
  -- V35: per-item commission/discount for a 'dsr_sale' (shop visit sale)
  -- row, persisted so the DSR Payment page can total "today's commission"
  -- / "today's discount" per DSR straight from the DB instead of only
  -- from the momentary bill shown on the sale slip.
  commission_amt NUMERIC(14,4) DEFAULT 0,
  discount_amt   NUMERIC(14,4) DEFAULT 0,
  -- shop_id: links a point_sale row to a registered shop (§11) so the
  -- shop's Detail screen can show a real sales history, not just dues.
  shop_id        TEXT        DEFAULT '',
  -- customer_id (Update #51): links a point_sale row to a proper
  -- pos_customers record when the walk-in customer isn't (yet) a
  -- registered shop. '' when the row predates Update #51 or matched an
  -- existing shop by phone instead (shop_id is set in that case).
  customer_id    TEXT        DEFAULT '',
  note           TEXT        DEFAULT '',
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_tx_type    ON transactions(type);
CREATE INDEX idx_tx_date    ON transactions(date);
CREATE INDEX idx_tx_sr_id   ON transactions(sr_id);
CREATE INDEX idx_tx_shop_id ON transactions(shop_id);
CREATE INDEX idx_tx_customer_id ON transactions(customer_id);

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
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_key       TEXT        NOT NULL UNIQUE,
  user_name      TEXT        DEFAULT '',
  role           TEXT        NOT NULL CHECK (role IN ('owner','manager','so','dsr','driver')),
  password       TEXT        NOT NULL UNIQUE,
  thumb          TEXT        DEFAULT '',   -- V25: Manager's individual profile photo (Owner-set), same base64-thumb pattern as srs.thumb
  must_change_pw BOOLEAN     NOT NULL DEFAULT false,  -- V44 #18: forces a mandatory password-set screen on next login; only ever true for the freshly-seeded Owner row
  created_at     TIMESTAMPTZ DEFAULT NOW()
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
-- V44 #18: must_change_pw = true so the very first login is forced to
-- set a real password before the Owner can do anything else in the app.
INSERT INTO user_passwords (user_key, user_name, role, password, must_change_pw)
VALUES ('owner', 'Owner', 'owner', '12345', true);

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
--
-- V41 update 7 — every 'month'/'period' TEXT column in this schema
-- ('YYYY-MM', e.g. salary_settings.month, salary_ledger.month,
-- advance_requests.month, targets.period, product_targets.period) keeps
-- this exact text format, but as of V41 it no longer means the plain
-- calendar month — it means the company's pay cycle: the 26th of the
-- PREVIOUS calendar month through the 25th of the labeled month. E.g.
-- period/month "2026-06" covers 2026-05-26 → 2026-06-25. This is an
-- application-layer change only (see cyclePeriodBounds/cyclePeriodForDate
-- in api/_lib/db.js) — no column types or constraints below changed.
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
  -- road_id/road_name (Update #23): which Road this shop belongs to.
  -- Picking a road at registration auto-derives assigned_dsr_id/name
  -- above from that road's current SO/DSR pair (api/shops.js action=
  -- register) — the DSR is never chosen by hand any more once a road
  -- is picked. '' = legacy shop registered before Roads existed, or a
  -- one-off shop registered with no road on purpose.
  road_id            TEXT          DEFAULT '',
  road_name          TEXT          DEFAULT '',
  created_at         TIMESTAMPTZ   DEFAULT NOW()
);
CREATE INDEX idx_shops_dsr   ON shops(assigned_dsr_id);
CREATE INDEX idx_shops_phone ON shops(phone);
CREATE INDEX idx_shops_road  ON shops(road_id);

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

-- ── Point-of-Sale Customers (Update #51) ─────────────────────────────
-- Update #51 — the old point-sale flow only ever captured a free-text
-- customer name (`sr_name` on the transaction row). This is a proper,
-- lightweight customer record — the same basic fields as normal shop
-- registration (name, keeper/owner name, phone, address) minus the
-- GPS/road fields that only make sense for an actual route stop —
-- deliberately kept as its OWN table rather than folded into `shops`,
-- so a one-off walk-in customer never pollutes the Shop Registry, the
-- road/map filters, or the duplicate-shop-name check (Update #38).
-- `phone` isn't UNIQUE (a customer may have none), but api/shops.js
-- upserts by phone when one is given, so repeat customers get one
-- growing record instead of a new row every visit.
DROP TABLE IF EXISTS pos_customers CASCADE;

CREATE TABLE pos_customers (
  id           UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT          NOT NULL,
  keeper_name  TEXT          DEFAULT '',
  phone        TEXT          DEFAULT '',
  address      TEXT          DEFAULT '',
  created_at   TIMESTAMPTZ   DEFAULT NOW()
);
CREATE INDEX idx_pos_cust_phone ON pos_customers(phone);

ALTER TABLE pos_customers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "srv_pos_customers"       ON pos_customers FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_deny_pos_customers" ON pos_customers FOR ALL TO anon          USING (false);

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
                      CHECK (load_status IN ('not_started','loading','load_complete','loaded')),
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

-- ── Daily Online Deposit (V31, overhauled V55 #55) ────────────────────
-- Company-wide deposit log (NOT per-SO). Owner logs every amount
-- actually deposited — one row PER ENTRY, not per date, so any number
-- of deposits/day are kept (e.g. one by bank in the morning + one by
-- depot/cash-in-hand in the evening). `deposit_method` records which.
-- Every dashboard's "today"/"this month" figures are computed as a
-- SUM over this table for the relevant date range. Replaces the old
-- per-SO so_daily_quota table.
DROP TABLE IF EXISTS so_daily_quota CASCADE;
DROP TABLE IF EXISTS online_deposit CASCADE;

CREATE TABLE online_deposit (
  id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  date           DATE          NOT NULL,
  amount         NUMERIC(14,4) DEFAULT 0,
  -- V55 #55 — required: 'bank' (deposited to bank) or 'depot' (handed
  -- in as cash at the depot/godown/office). No default on new inserts —
  -- api/expenses.js `deposit-set` rejects a missing/invalid method.
  deposit_method TEXT          NOT NULL CHECK (deposit_method IN ('bank','depot')),
  set_by         TEXT          DEFAULT '',
  set_at         TIMESTAMPTZ   DEFAULT NOW()
);
CREATE INDEX idx_online_deposit_date ON online_deposit(date);

ALTER TABLE online_deposit ENABLE ROW LEVEL SECURITY;
CREATE POLICY "srv_online_deposit"       ON online_deposit FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_deny_online_deposit" ON online_deposit FOR ALL TO anon          USING (false);


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

-- ══════════════════════════════════════════════════════════════════
--  V32: Product-wise Sales Target — a SECOND, separate target type
--  alongside the ৳ money target above. Owner also sets a quantity
--  goal (e.g. 500 কেস) per product per month, company-wide (not
--  per-SO). "Achieved" is summed live from transactions.total_units
--  the same give/point_sale − return/point_damage_return way every
--  other achieved figure in the app works — nothing about progress
--  is ever stored, only the goal itself.
-- ══════════════════════════════════════════════════════════════════
DROP TABLE IF EXISTS product_targets CASCADE;

CREATE TABLE product_targets (
  id          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  period      TEXT          NOT NULL,               -- 'YYYY-MM'
  product_id  TEXT          NOT NULL,
  target_qty  NUMERIC(14,4) DEFAULT 0,
  set_by      TEXT          DEFAULT '',
  set_at      TIMESTAMPTZ   DEFAULT NOW(),
  UNIQUE (period, product_id)
);
CREATE INDEX idx_prod_targets_period ON product_targets(period);
CREATE INDEX idx_prod_targets_pid    ON product_targets(product_id);

ALTER TABLE product_targets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "srv_product_targets"       ON product_targets FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_deny_product_targets" ON product_targets FOR ALL TO anon          USING (false);

-- ══════════════════════════════════════════════════════════════════
--  V30: Report Dashboard — Daily SO Delivery Report + Due Report
--
--  One row per (SO, calendar date). `report_data` is the full
--  product-wise loading/return/sale challan — one section per DSR
--  route under that SO (1st/2nd/… loading = each distinct "give" batch
--  that DSR received that day, return = unsold stock brought back,
--  sold = loading − return, amount = sold × rate) plus an SO-wide
--  total. `due_data` is the companion due report for the same SO/date
--  — today's due, any previous/carried-over due, and a shop-wise
--  breakdown (shop name/number/phone + amount). Only the newest 60
--  dates are kept per SO; api/report.js prunes older rows every time
--  a new one is generated (auto 02:00 Asia/Dhaka cron, or Owner
--  on-demand — both go through the same generator function).
-- ══════════════════════════════════════════════════════════════════
DROP TABLE IF EXISTS daily_so_reports CASCADE;

CREATE TABLE daily_so_reports (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  so_id         TEXT          NOT NULL,
  so_name       TEXT          DEFAULT '',
  report_date   DATE          NOT NULL,
  generated_at  TIMESTAMPTZ   DEFAULT NOW(),
  generated_by  TEXT          DEFAULT '',   -- 'auto' (cron) or the Owner's user_name
  report_data   JSONB         NOT NULL DEFAULT '{}',
  due_data      JSONB         NOT NULL DEFAULT '{}',
  UNIQUE (so_id, report_date)
);
CREATE INDEX idx_dsr_so_id ON daily_so_reports(so_id);
CREATE INDEX idx_dsr_date  ON daily_so_reports(report_date);

ALTER TABLE daily_so_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY "srv_daily_so_reports"       ON daily_so_reports FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_deny_daily_so_reports" ON daily_so_reports FOR ALL TO anon          USING (false);

-- ══════════════════════════════════════════════════════════════════
--  V40: Incremental stock balance (products.current_stock)
--
--  PROBLEM this fixes: every dashboard load (owner/manager, SO, DSR,
--  and the app-boot load-all) used to re-fetch EVERY transaction row
--  ever created, just to sum up current stock per product. That's
--  correct but expensive — the amount of data pulled from Supabase
--  grows every single year as the transactions table grows, so the
--  same "load the dashboard" action slowly costs more and more
--  Supabase egress bandwidth over time, with no ceiling.
--
--  FIX: products.current_stock is now the single source of truth for
--  current stock, updated automatically at the database level by this
--  trigger every time a stock-affecting transaction row is inserted.
--  The API layer (api/dashboard.js) now simply reads this column off
--  the products row it already fetches — no more full-history refetch
--  for stock, on any dashboard, ever. This is a DATABASE trigger (not
--  app code) so it applies no matter which API route inserts a
--  transaction, now or in the future — nothing to remember to call.
--
--  Only 'buy' / 'give' / 'return' / 'point_sale' / 'point_damage_return'
--  affect stock — exactly matching the existing calcStock() logic in
--  api/_lib/db.js. 'damage' and 'dsr_sale' deliberately do NOT touch
--  stock (see the comments already in that function) and this trigger
--  preserves that same rule.
-- ══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION apply_stock_delta() RETURNS TRIGGER AS $$
DECLARE
  delta NUMERIC(14,4);
BEGIN
  delta := CASE NEW.type
    WHEN 'buy'                  THEN  NEW.total_units
    WHEN 'give'                 THEN -NEW.total_units
    WHEN 'return'                THEN  NEW.total_units
    WHEN 'point_sale'            THEN -NEW.total_units
    WHEN 'point_damage_return'   THEN  NEW.total_units
    ELSE 0
  END;
  IF delta <> 0 AND NEW.product_id IS NOT NULL AND NEW.product_id <> '' THEN
    UPDATE products SET current_stock = current_stock + delta
      WHERE id::text = NEW.product_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_apply_stock_delta ON transactions;
CREATE TRIGGER trg_apply_stock_delta
  AFTER INSERT ON transactions
  FOR EACH ROW EXECUTE FUNCTION apply_stock_delta();

-- One-time backfill for a FRESH install: since this schema.sql always
-- starts from empty tables (see the DROP TABLE IF EXISTS block at the
-- very top), current_stock already correctly starts at 0 for every
-- product on a brand-new project — there is nothing to backfill here.
-- (If you are instead applying this to an EXISTING project that
-- already has data, use migration_v40_stock_balance.sql, NOT this
-- file — it backfills current_stock from your real transaction
-- history before turning the trigger on.)

-- ══════════════════════════════════════════════════════════════════
--  V41 batch — Updates #21–27: "Roads" / Routes (new feature)
--
--  All Roads logic lives inside the existing 12 API files (srs.js and
--  shops.js — see the MANDATORY note at the top of update_note.md); no
--  13th `/api/` file was created. Three new tables, all small and
--  low-growth (roads themselves rarely change; road_visit_plans is one
--  row per road per day scheduled; shop_visits is one row per shop per
--  visit per day — trivial volume compared to `transactions`).
-- ══════════════════════════════════════════════════════════════════

-- ── #21: Roads — Core Data Model ─────────────────────────────────────
-- Owner creates roads freely by name, no fixed/predefined list. so_id/
-- so_name/dsr_id/dsr_name are set by api/srs.js action=road-assign-so
-- (#22) — dsr_id is NEVER set directly, it is always derived from
-- whichever DSR is auto-paired (srs.so_id link) to the assigned SO.
DROP TABLE IF EXISTS roads CASCADE;

CREATE TABLE roads (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT        NOT NULL,
  so_id      TEXT        DEFAULT '',
  so_name    TEXT        DEFAULT '',
  dsr_id     TEXT        DEFAULT '',
  dsr_name   TEXT        DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_roads_so_id  ON roads(so_id);
CREATE INDEX idx_roads_dsr_id ON roads(dsr_id);

ALTER TABLE roads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "srv_roads"       ON roads FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_deny_roads" ON roads FOR ALL TO anon          USING (false);

-- ── #25: Visit-Day Automation — Owner schedules "SO visits road X on
--    date D, paired DSR delivers on D+1" plans. api/srs.js action=
--    road-plan writes one row per schedule; dashboard.js reads today's
--    matching row(s) to surface "you're due at [road] today" on the
--    SO's dashboard (when today = so_visit_date) and the DSR's
--    dashboard (when today = dsr_visit_date, always so_visit_date+1).
DROP TABLE IF EXISTS road_visit_plans CASCADE;

CREATE TABLE road_visit_plans (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  road_id        TEXT        NOT NULL,
  road_name      TEXT        DEFAULT '',
  so_id          TEXT        DEFAULT '',
  so_name        TEXT        DEFAULT '',
  dsr_id         TEXT        DEFAULT '',
  dsr_name       TEXT        DEFAULT '',
  so_visit_date  DATE        NOT NULL,   -- day 1 — SO visits shops
  dsr_visit_date DATE        NOT NULL,   -- day 2 (so_visit_date + 1) — DSR delivers
  created_by     TEXT        DEFAULT '',
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_rvp_road          ON road_visit_plans(road_id);
CREATE INDEX idx_rvp_so_date       ON road_visit_plans(so_id, so_visit_date);
CREATE INDEX idx_rvp_dsr_date      ON road_visit_plans(dsr_id, dsr_visit_date);

ALTER TABLE road_visit_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY "srv_road_visit_plans"       ON road_visit_plans FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_deny_road_visit_plans" ON road_visit_plans FOR ALL TO anon          USING (false);

-- ── #26: Map — Daily Visit Tracking with Auto-Reset ──────────────────
-- One row per (shop, visitor, day). The DSR side is written
-- automatically by api/shops.js action=visit-sale (every real shop
-- sale IS a visit); the SO side is written by api/shops.js
-- action=visit-log, called from the SO's road view when they tick off
-- a shop they've physically visited that day (no sale attached, since
-- SOs don't carry stock). "Auto-reset at start of new day" needs no
-- cleanup job at all — every read is filtered to visit_date = today
-- (Asia/Dhaka), so yesterday's ticks simply stop matching on their own
-- the moment the calendar date rolls over; old rows are harmless
-- history and can be pruned occasionally if the table ever gets large.
DROP TABLE IF EXISTS shop_visits CASCADE;

CREATE TABLE shop_visits (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id      TEXT        NOT NULL,
  visit_role   TEXT        NOT NULL CHECK (visit_role IN ('so', 'dsr')),
  visitor_id   TEXT        DEFAULT '',
  visitor_name TEXT        DEFAULT '',
  visit_date   DATE        NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_shop_visits_date      ON shop_visits(visit_date);
CREATE INDEX idx_shop_visits_shop_date ON shop_visits(shop_id, visit_date);

ALTER TABLE shop_visits ENABLE ROW LEVEL SECURITY;
CREATE POLICY "srv_shop_visits"       ON shop_visits FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_deny_shop_visits" ON shop_visits FOR ALL TO anon          USING (false);
