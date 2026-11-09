# OFFER PROGRESS

## ALL 4 SESSIONS COMPLETE (v14.0.0)

## SESSION 3 of 4 — PROFIT PANEL, DASHBOARD, REPORTS, ROLE SAFETY — DONE (v14.0.0)
Files: api/_lib/profit.js (NEW helper), api/_lib/offerLedger.js (+settlements), api/_lib/offerHandler.js (export loadNorm), api/_lib/db.js (computeProfit opts.bonusTo), api/_lib/auth.js (withBiz scrubs non-owner/manager responses), api/dashboard.js, api/report.js, api/claims.js, api/deposits.js, src/index.html, package.json (14.0.0), CHANGELOG.md, tests/profit.test.js (NEW, 62 checks), public/index.html (build copy).
API functions: 11 (limit 12). Migration: none.
Test results: profit 62/62, ledger 70/70, offer 46/46 (in-memory DB, real handlers).

### Unfinished / known limits
- Not run against a live Supabase / real browser here (no network, no esbuild): the UI was syntax-checked and the API tested with an in-memory database. Please smoke-test the screens once after deploy (home panel, details modal, report tabs, memo export).
- Only owner tokens exist today (no manager / DSR / SO logins); role gates are enforced and tested with simulated tokens.
- Old company bonus receivable is excluded from profit from the offer start date onward (to avoid double counting); the "পাওনা" bonus screens still show it.
- Returns are booked on the return date; damage lines reverse the offer on their date.
- Regression of sales / point sales / returns / due collection / DSR expected cash / stock / A4 + thermal memos / WhatsApp share was covered by unchanged code paths and the existing 46 + 70 tests plus a syntax check of all scripts; the memo / share rendering itself was not exercised in a browser.
- public/index.html is an unminified copy (Vercel build minifies).

## SESSION 2 of 4 — COMPANY OFFER LEDGER — DONE (v13.0.0)
Done: ledger per product, company payments (add / edit / delete with PIN), FIFO settlement, adjustments, "কোম্পানিকে বিক্রয় পাঠান" (WhatsApp text + A4 / thermal memo), owner/manager-only (UI + API), tests (70 checks). No profit panel touched.

### Files changed
api/_lib/offerLedger.js (NEW, pure helper), api/_lib/offerHandler.js (NEW helper), api/claims.js (one dispatch line: `type=offer`), src/index.html (new page `pg-offer`, menu item, `S.role`), package.json (13.0.0), CHANGELOG.md, tests/ledger.test.js (NEW), public/index.html (build output, copied unminified).
(Helpers live in `api/_lib/` — the project's existing helper folder; there is no top-level /lib. Files starting with `_lib` are not serverless functions.)

### getOfferAllocation — location and return shape (session 3 uses this)
`api/_lib/offerLedger.js` → `getOfferAllocation(sales, returns, payments)` (pure, integer paisa inside).
- Input: `sales [{date, productId, productName, deduction}]` (deduction = offerDeductionTotal of a give / point_sale line), `returns [{date, productId, reversal}]` (return / damage / point_damage_return lines), `payments [{id, date, amount, note, productIds[], from, to, close}]`.
- Output:
  - `days: [{date, earned, grossEarned, returned, received, writtenOff, pending}]` — all products, oldest first. `earned = grossEarned − returned`; `pending = earned − received − writtenOff`.
  - `byProduct: {pid: {productId, name, earned, grossEarned, returned, received, writtenOff, pending, days:[same as above]}}`
  - `payments: [{id, date, amount, applied, excess, writtenOff, adjustment, kind}]` — `adjustment` is signed, `kind` = 'over' | 'close' | ''.
  - `adjustments: [{paymentId, date, amount (signed), kind}]` — **the only effect of payments on profit** (profit by day = adjustments on the payment date).
  - `total: {earned, grossEarned, returned, received, writtenOff, pending, paid, excess, adjustment}`
- Related pure helpers in the same file: `normRows(txRows, lineDeduction, {start})` → {sales, returns, qty}; `buildLedger(norm, payments)`; `buildReport(norm, payments, {from,to,mode})`; `sumQty`.
- To get the inputs from the database use `loadNorm()` / `loadPayments()` in `api/_lib/offerHandler.js` (exported: `loadPayments`; `loadNorm` is internal — export it if session 3 needs it).
- Rules: FIFO oldest sale date first, only offers dated on/before the payment date; a return is booked on the return date (a day may net below 0 = credit); an excess payment is NOT in `received` (it is the +adjustment); closed shortfall is in `writtenOff` and the −adjustment.
- For session 3: revenue (`total_revenue`) is already net of the offer, so profit must count the earned offer on the SALE day (earned by day) and then only the adjustments on the payment day — never the payment amount itself.

### Where payments are stored
Existing `audit_log` table (no migration): one row per event, `table_name='offer_payment'`, `action` = `offer_pay_add | offer_pay_edit | offer_pay_del`, `row_id` = payment id (uuid), `new_data` = `{ts, payment:{date, amount, note, productIds, from, to, close}}`. The current list is replayed in `ts` order by `loadPayments()`. Settings → data reset does NOT touch audit_log, so payments are never wiped by it. (An optional dedicated table is not needed.)

### API
`GET /api/claims?type=offer&action=ledger` · `GET …&action=report&mode=since|range&from=&to=` · `POST /api/claims?type=offer {action:'pay-add'|'pay-edit'|'pay-del', …}` (edit / delete need `pin`). Role gate: `allowed(req)` in offerHandler.js accepts token users `owner` / `manager` only; everyone else gets 403 `{forbidden:true}`.
### API function count: 11 (limit 12). No api file added.
### Migration: none needed (works on the existing database).

### What remains
- Session 3: profit panel — use `getOfferAllocation` (earned by day + adjustments by payment date); avoid double counting with the old bonus receivable (claims `type=receivable`, product-rule based, unchanged).
- Session 4: final checks.
- Known limits: the app currently issues owner tokens only (no manager / DSR / SO logins exist yet) — the gate is ready for a `manager` token and blocks anything else. "Since last payment" counts sales dated AFTER the last covering payment date (same-day sales belong to the payment before). Returns are booked on the return date, not back-dated onto the original sale day. The payment form's "বাকি" preview is an estimate from current balances; the server computes the real figure. public/index.html is a build output (copied unminified here; Vercel minifies).

## SESSION 1 of 4 — AUTO OFFER DEDUCTION ON SALES + RETURNS — DONE (v12.0.0)
Done: helper, auto deduction on DSR/SO give + point sales, return reversal, start-date setting, Bengali UI lines (sale screen, give screen, shop bill, day-end screen + slip, ledger), DSR-safe memos, tests (46 checks).

### Session-0 check
Snapshots (sellPrice, buyPrice, unitsPerCase, offerCasesReq/FreeUnits/FreeMoney) already existed on sale/return lines (v11). Added now: offerDeductionPerCase, offerDeductionTotal, offerApplied, shopPricePerCase, grossAmount (derived in `snapOf`, exposed as `row.snapshot` by `mapTx`).
Old use of bonusCasesReq / bonusFreeUnits / bonusFreeMoney: product form + products.js (save), db.js mapProduct, snapshot columns rule_bonus_* on every sale row, `bonus_net_units` RPC / `computeBonusRangeSummary` (company bonus receivable, unchanged), claims, old v10 day-end `offerBreakdown` (per-piece buy-price formula, replaced), `lineOffer` / `rowOfferPerUnit` (replaced), price-history labels. The company bonus receivable still uses the product rule per net pieces — unchanged.

### Files changed
api/_lib/offer.js (NEW helper, not a function), api/_lib/money.js, api/payments.js, api/shops.js, api/transactions.js, api/settings.js, src/index.html, package.json, CHANGELOG.md, tests/offer.test.js (new), public/index.html (build output).

### Helper names / locations
- api/_lib/offer.js: `calcOfferDeduction(snapshot, casesSold)` → {perCaseExact, perCase, qualifyingCases, total, shopPerCase, valuePerBottle, active}; `grossOf`, `lineDeduction(row)`, `wholeCases`, `getOfferStart()`, `setOfferStart(date)`, `offerOnFor(start, date)`.
- api/_lib/money.js: `priceItems` (applies deduction on give/point_sale; reversal on return/damage/point_damage_return), `offerReversal(sn, units)`, `sourceSnapshots` (now returns gross price, srcUnits, srcDed, prior), `snapOf`, `repriceFromSnapshot` (keeps offer).
- Front end: `offerCalc / offerOn / offerOfLines` (preview only), `ifTotals`, `saleCalc`, `offerStartToday/Save/Off`, memo engine `itemRows(items, mode, dsrView)`.
- Settings: `GET settings` → `settings.offerStartDate`; `POST settings {type:'offer-start', today:true | date:'YYYY-MM-DD' | date:''}`.

### Design decisions (read before session 2/3)
- `total_revenue` of a line = money AFTER the offer. Gross = snapshot price × quantity. Everything that sums `total_revenue` (due RPC, reports, profit) now sees the reduced revenue; the company's later payment arrives as the existing bonus receivable. Session 3 (profit panel) must avoid counting the offer twice.
- Deduction of a stored line = gross(snapshot) − stored revenue (noise guard 0.006 + 0.00006×pieces). No flag column needed; old lines read 0.
- Qualifying cases = floor(wholeCases / X) × X (full groups of X cases). For X=1 that is every whole case.
- Return reversal = remaining deduction before − after (cumulative); loose bottles reverse nothing until a whole case is broken.
- Start date stored in biz_counters (`offer_start`, YYYYMMDD) so no migration is needed; unset = offer off.
- DSR/SO-facing memos (give/return/damage) show only the reduced price; the day-end slip and shop bill show the "কোম্পানি অফার ছাড়" line.
- The day-end "bonus" step is no longer auto-filled with the offer (would double-deduct).

### API function count: 11 (limit 12). No api file added.
### Migration: none needed (optional v11 migration still optional).

### What remains
- Session 2: ledger (company receivable from the deduction totals).  Session 3: profit panel (revenue is now net of offer).  Session 4: final checks.
- Day-end damage preview in the browser prices damaged pieces at the average reduced price; the server re-prices exactly.
- Mixed-snapshot same-day sales of one product use the latest snapshot's offer for the reversal (rare).
- public/index.html is a build output; esbuild is not installed here, so it was copied unminified (Vercel build minifies).

## SESSION 0 of 4 — PRICE CHANGE SAFETY — DONE (v11.0.0)
Done: audit, snapshots, price history, legacy freeze (server + owner dialog + dashboard warning + settings button), tests (29 checks against the real handlers with an in-memory DB).

### Files changed
api/_lib/money.js (snapOf, sourceSnapshots, repriceFromSnapshot, return pricing, rowOfferPerUnit), api/_lib/db.js (mapTx snapshot, bonus legacy rule, case totals, scoped history table), api/_lib/history.js (new helper, NOT an api function), api/products.js, api/transactions.js, api/payments.js, api/shops.js, api/report.js, api/dashboard.js, src/index.html, package.json, CHANGELOG.md, migrate-v11-price-history.sql (optional).

### Snapshot field names
sellPrice, buyPrice, unitsPerCase, offerCasesReq, offerFreeUnits, offerFreeMoney, offerDeductionPerCase, offerDeductionTotal, snapshotAt (+ legacy, frozenAt). Stored in: selling_price, purchase_price, rule_case_size, rule_bonus_cases_req, rule_bonus_free_units, rule_bonus_free_money, created_at. Frozen old line = rule_case_size set, rule_bonus_cases_req = 0 (offer 0). Offer deduction figures are derived from the stored snapshot.

### API function count: 11 (limit 12). No api file added.
### Migration: optional (migrate-v11-price-history.sql).

### What remains / known limits
- Dashboard / SKU stock value (current stock × current buy price) is a live inventory figure and still moves with the buy price; per-batch costing is not built.
- Old day-end slips saved before v11 have no caseSize in their details: their case split falls back to the product's current pieces-per-case (money is unaffected).
- Products have no commission/discount fields (typed per bill, stored on the line), so only price/buy/case-size/offer are logged.
- The app has no in-place "edit sale" screen (delete + re-enter); `repriceFromSnapshot` is ready for when one is added.
- public/index.html is a build output; run `npm run build` (Vercel does it) — esbuild could not be installed here.
- Sessions 1–3 (offer features) not started.
