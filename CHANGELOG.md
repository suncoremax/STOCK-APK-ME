# CHANGELOG

## v14.1.0 — Pagination + speed (multi-business edition, business features unchanged)
**Pagination**
- Server: list endpoints used `.limit(1500…5000)`, which Supabase silently cuts to **1000** rows (history, DSR slips, DSR payments, expenses). New `fetchUpTo()` pages in 1000-row steps so the limit is real. Memo reprint now asks for that one memo (`transactions?txId=`) instead of downloading 5000 rows and filtering in the browser.
- Screens: shops, দিনশেষ হিসাব, লেনদেনের ইতিহাস, দোকানে বিক্রয় তালিকা and খরচ show 40 rows with **⬇ আরও দেখুন** (search resets it).

**Speed**
- Home screen (`api/dashboard.js`): deposit, offer-owed and "old lines" count queries ran one after another after the main batch — now one parallel batch. Shop list: the walk-in-customer query runs together with the list.
- Front end: the home-screen request starts at the same moment as the product / DSR / shop / settings lists (it used to wait for them).
- Login: the business list comes back with the login answer (one request fewer before the business screen appears).
- Business lookup (`withBiz`): cached 20 s (was 5 s) and simultaneous requests share one lookup — the app fires 4–7 at once. Rename / delete still clears it immediately on the same server.
- `build.js`: esbuild was escaping every Bengali character to `\uXXXX` (the "minified" page was *bigger* than the source). Fixed with `charset: 'utf8'` — 488 KB → 423 KB.
- Database: partial index for the "unfrozen old lines" count and `created_at` indexes for the newest-first lists (`schema.sql`; `add-speed-indexes.sql` for an existing database — run once, safe to repeat).
- Tests: `tests/perf-paging.test.js` (12 checks) + the existing 178 all pass.

## v14.0.0 — Step 3 (final): Profit panel, dashboard, reports, role safety
**Profit = cash profit + offer profit**, always from STORED snapshots (price after the offer deduction, buyPrice, offerDeductionTotal) — never today's price or offer.
- **Cash profit** = (shop price after offer − snapshot buy price) × qty, after commission / discount, as before (`computeProfit.finalProfit`). **Offer profit** = stored offer deduction − return reversals, booked on the SALE date (`getOfferAllocation().days[].earned`). **Total** = cash + offer (+ সমন্বয় on the payment date).
- **A company payment never changes any day's profit** — it only moves the offer from "বাকি" to "প্রাপ্ত" and counts as received cash/bank money (not a sale, not profit). Only the session-2 সমন্বয় (difference between payment and what was pending) touches profit, on the payment date. Month / range profit = Σ daily profit (verified before and after payments).
- **Panel (owner / manager)**: main figure "আজকের লাভ ৳1,500"; below "ক্যাশ লাভ ৳1,170 | অফার ৳330 (বাকি)" (negative cash profit in red); tap → details: সাধারণ বিক্রয়, কোম্পানি অফার ছাড়, আসল বিক্রয়, কেনা দাম, ক্যাশ লাভ, অফার বাকি / প্রাপ্ত, which payment settled it (ranges), সমন্বয়, মোট লাভ. When the offer is fully received the total stays and only the label turns "(প্রাপ্ত)".
- **Dashboard**: new card "পাওনা অফার (কোম্পানির কাছে)" (all-time balance), company payment and সমন্বয় of the period; cash tile shows company payments as received money.
- **Report**: summary shows the same breakdown plus "কোম্পানি অফার ও পেমেন্ট" (payments, সমন্বয় lines, owed offer); date-wise rows carry cash / offer / সমন্বয় / total profit and the day's company payment; PDF/JPG/Excel/WhatsApp exports include the new lines.
- **Old bonus receivable**: from the offer start date it is no longer added to profit (the offer is now a real deduction) — avoids counting the offer twice. Older periods unchanged.
- **Role safety (UI + API)**: `api/_lib/profit.js` → `isPriv(req)` / `scrub()`. `withBiz` scrubs every API response for any user who is not owner / manager (profit, buy price, offer, ledger, payments, receivable keys). Report, deposits, company receivable / bonus and the offer ledger answer 403 for DSR / SO. The home screen hides the profit card, offer / receivable / deposit cards for them. They keep: reduced price, expected cash, due.
- **No new api file (11 of 12), no migration.** Helpers: `api/_lib/profit.js` (new); `getOfferAllocation` now also returns `settlements` (which payment settled which sale day). `computeProfit(from,to,{bonusTo})`.
- Tests: `node tests/profit.test.js` (62 checks: 450/300/33 → 1,500 = 1,170 + 330; REAL 635/605/24/2 free ×10 → 5,861.54 / 6,050.00 / −188.46 / 488.46 / 300.00; payment 3,000 → profit unchanged, balance −3,000; price change → yesterday identical; Σ daily = range; over-payment adjustment only on the payment date; DSR / SO get nothing), plus `ledger.test.js` (70) and `offer.test.js` (46).

## SUMMARY OF ALL SESSIONS (v11 → v14)
- **v11 Step 0 — price-change safety**: every sale / return line keeps its own price, buy price, pieces-per-case and offer snapshot; old lines can be frozen; changing a product never changes past slips, profit or reports.
- **v12 Step 1 — automatic company-offer deduction**: offer "for X cases, F free bottles + M money" lowers the shop price on DSR/SO give and point sales; returns reverse it proportionally; stored as `total_revenue` after the offer; start-date setting; DSR copies show only the reduced price.
- **v13 Step 2 — company offer ledger**: per-product ledger, company payments (add / edit / delete with PIN), FIFO settlement, সমন্বয়, "কোম্পানিকে বিক্রয় পাঠান" (WhatsApp + A4 / thermal), owner / manager only.
- **v14 Step 3 — profit panel / dashboard / reports / role safety** (above).

## v13.0.0 — Step 2: Company offer ledger ("কোম্পানি অফার হিসাব")
New section (menu: **কোম্পানি অফার হিসাব**), visible and callable by **owner / manager only** — hidden from DSR / SO in the menu and `gTab`, and rejected by the API (HTTP 403 `forbidden`) for any other user.
- **Ledger per product** from the STORED snapshots only (never today's price / offer): total cases + bottles sold (net of returns), cases + bottles since the last company payment, offer earned = Σ `offerDeductionTotal` of sale lines − return reversals, received, closed-by-adjustment, balance (red = company still owes, green = settled). Day-by-day view per product.
- **Company payments**: date, amount, note, optional products and optional sale-date period. Add without PIN; **edit / delete ask the owner PIN** (same dialog as elsewhere). A payment is cash/bank received — **not profit**.
- **Settlement is computed, never written into old records** — `getOfferAllocation(sales, returns, payments)` (`api/_lib/offerLedger.js`): payments settle the **oldest earned offers first (FIFO by sale date)**; a payment not tied to a product runs through all products oldest-first, so per-product balances are derived from the total. Returns lower earned (and balance) on the day they happen.
- **সমন্বয় (adjustment)** — the only way a payment touches profit, and only by the difference, dated on the payment date: paid more than pending → **+ difference**; paid less and the owner ticked **"সমন্বয় সহ বন্ধ করুন"** → **− difference** (rest written off); paid less without it → stays pending, no adjustment. Exact payment → no profit effect.
- **"কোম্পানিকে বিক্রয় পাঠান"**: pick "since the last payment" or a date range → per product cases + bottles only (no SKU, no price) with the period. Share as a short WhatsApp text, or as an A4 / 50 mm thermal memo through the existing MEMO engine (PDF / JPG / Excel / print as usual).
- **No migration**: payments are stored as an append-only event list in the existing `audit_log` table (`table_name='offer_payment'`, actions `offer_pay_add|edit|del`) and replayed; works on every existing database. API: `GET claims?type=offer&action=ledger|report`, `POST claims?type=offer {action:'pay-add'|'pay-edit'|'pay-del'}` — **no new api file** (11 of 12). Helpers: `api/_lib/offerLedger.js` (pure), `api/_lib/offerHandler.js`.
- The front end now remembers the signed-in role (`S.role`) for the visibility checks.
- Tests: `node tests/ledger.test.js` (70 checks against the real `claims.js` handler with an in-memory DB) + `node tests/offer.test.js` (46, unchanged).

## v12.0.0 — Step 1: Automatic company-offer deduction (sales + returns)
A product offer "for every X cases, F free bottles + M free money" now lowers the SHOP PRICE automatically. The shop still gets the real bottles (stock drops by real bottles only); the company pays the distributor later.
- **Formula** (`api/_lib/offer.js` → `calcOfferDeduction(snapshot, casesSold)`): P = case price, U = bottles per case, f = F/X, m = M/X; value per bottle = P/(U+f); case price = value×U; shop price per case = case price − m; deduction per case = P − shop price. Only whole cases that complete a group of X cases qualify; loose bottles get none. The total is rounded once from the exact per-case figure (no drift): 635 / 24 bottles / 2 free → 48.85 per case, 10 cases → 488.46, shop pays 5,861.54.
- **Where it applies**: DSR/SO "give" and direct point sales (`give`, `point_sale`), only when the line date ≥ the new setting **"অফার হিসাব শুরুর তারিখ"** (Settings → 🎁 কোম্পানি অফার ছাড়, button **"আজ থেকে চালু করুন"**; also date picker and off switch). Without a start date nothing changes. Commission / discount stay separate: they are typed on top of the reduced bill, exactly as before.
- **Storage (no migration)**: each line keeps its snapshot (sellPrice, buyPrice, unitsPerCase, offerCasesReq, offerFreeUnits, offerFreeMoney) in the existing `rule_*` / price columns; `total_revenue` now holds the money AFTER the offer. The deduction of a stored line is always "gross from its own snapshot − stored revenue" (`snapOf` → offerDeductionPerCase / offerDeductionTotal / offerApplied), so later price or offer edits never change an old slip. Old lines (revenue = gross) read as 0 and are untouched. The start date lives in the existing `biz_counters` table (key `offer_start`).
- **Due, DSR expected cash, shop bill** all use the reduced amount automatically (they already read `total_revenue`). The day-end bonus step is no longer auto-filled with the offer (that would deduct it twice).
- **Returns / damage / shop returns** reverse the deduction proportionally from the ORIGINAL sale snapshot (DSR → his latest give day, shop → latest point sale), cumulatively (remaining qualifying deduction before − after), so several returns add up to exactly the original deduction. The reversal is part of the return line's revenue and is derived from it.
- **Screens / documents**: separate line **"কোম্পানি অফার ছাড়"** on the give screen totals, shop sale screen, sale modal, shop bill (A4 + thermal), shop-return memo, day-end screen and day-end slip, shop ledger. DSR/SO copies (give / return / damage memos) show only the reduced price — no offer or profit figure.
- Tests: `node tests/offer.test.js` (46 checks, in-memory stub, no database).
- API files: 11 (limit 12) — none added. Migration: none needed.

## v11.0.0 — Step 0: Price-change safety
Changing a product's price, buy price, pieces per case or offer never changes any past slip, report, profit or return.
- **Snapshots**: every sale / point-sale / return line stores its own sellPrice, buyPrice, unitsPerCase, offerCasesReq, offerFreeUnits, offerFreeMoney (+ derived offerDeductionPerCase / offerDeductionTotal, snapshotAt). Stored in the existing `rule_*`, `selling_price`, `purchase_price`, `created_at` columns — no migration. `mapTx` now returns `unitsPerCase` and a `snapshot` object.
- **Returns** use the original sale's snapshot (DSR/SO → his latest give; shop → that shop's latest point sale). Price, buy price, pieces-per-case and offer rule all come from the sale, not from today's product.
- **Old lines** (no snapshot) never get an offer and are never recalculated from today's product (bonus summary, day-end offer breakdown).
- **History reads snapshots only**: reprints/memos, day-end slip, report (cases per product), dashboard case totals, bonus summary case size.
- **Price history**: every change to sell/buy price (piece & case), pieces per case and offer fields is logged (old → new, date/time, who). Optional table `product_price_history`; falls back to `audit_log`; if neither exists the product still saves. New: `GET /api/products?action=price-history`, UI "🕘 দামের ইতিহাস".
- **Legacy freeze**: owner-only Bengali dialog on first dashboard load (backup advice, JSON backup download, "এখনই ফ্রিজ করুন" / "পরে মনে করান"), dashboard warning until done, and Settings button "পুরনো হিসাব ফ্রিজ করুন". Idempotent (only rows without a snapshot are ever written), safe with two tabs. `GET/POST /api/transactions?action=freeze-status|freeze-backup|freeze-legacy`.
- New helper `repriceFromSnapshot()` for changing the quantity of an existing line.
- Optional `migrate-v11-price-history.sql` (history table + `legacy`/`frozen_at` columns). API files: 11 (limit 12) — none added.
