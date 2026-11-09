# SETUP — NEW INSTALL (Beta 1)

**One SQL file only: `schema.sql`.** Run it once in the Supabase SQL Editor on a new, empty project. It is the complete database (tables, functions, price history, company deposits / receipts, photo bucket, owner login PIN 12345). No migration files are needed. Then set `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` (service_role) in Vercel, deploy, log in with 12345 and choose your own PIN. (Old upgrade notes further below are for old databases only.)

---

# AXIION DMS — Multi-Business Edition · Deployment

One owner, one PIN, **many businesses**. After the PIN the app shows your businesses; tapping one opens the full app for
that business. Every business has its own products, stock, DSR/SO, shops, dues, expenses, reports, settings and numbering,
and its own **month cycle** (the day the month starts, 1–28 — set by you when you create the business, changeable later).

Stack: **Vercel** (serverless API, 11 functions — under the 12 limit) + **Supabase** (Postgres) + **GitHub**.

## 1A. Brand-new Supabase project
1. supabase.com → New project.
2. **SQL Editor → New query →** paste the whole of `schema.sql` → **Run**.
   (Creates every table, function, the `thumbs` photo bucket and the Owner login. **No business is created** — you add them in the app.
   It refuses to run if the database already holds data.)
3. Project Settings → API → copy **Project URL** and the **service_role** key.

## 1B. You already use the previous (single-business) version → upgrade, keeping all data
1. Supabase **SQL Editor**: if you never ran it, first run `migrate-v6-dayend-tabs.sql`.
2. Run **`migrate-v7-multi-business.sql`** once. All your current data becomes the **first business** (named from your Settings
   business name, month cycle 26 → 25). Numbering (DSR-3, SHOP-0042, SL-000117 …) continues exactly where it was.
   Rename it / change its cycle later in the app. Run it **before** deploying the new code. It stops safely if run twice.
3. Do **not** run `schema.sql` on a database that has data.

## 1C. Upgrading from v9 → v10 (company receivable, offers, daily deposits)
Run **`migrate-v10-offers-deposits.sql`** once in the Supabase SQL Editor (safe to re-run), then deploy the new code.
It adds `company_receipts`, `company_deposits` and one-entry-per-day unique indexes (give / return / day-end).
If old duplicate rows exist the index step is skipped with a NOTICE — delete the duplicates and run the file again.
Until it is run the app still works (profit falls back to the old formula) and shows a warning.

## 1D. Speed (v14.1)
- **Run `add-speed-indexes.sql` once** in the Supabase SQL Editor if your database already exists (a brand-new install gets it from `schema.sql`). Safe to repeat; it only adds indexes.
- **Vercel → Project → Settings → Functions → Function Region**: choose the region closest to your Supabase project (Supabase → Project Settings → General shows it; e.g. Singapore ↔ `sin1`). The API makes several database calls per screen; if the two are on different continents every call adds 200–300 ms. Redeploy after changing it.
- Free Supabase projects pause after 1 week without use; the first request after a pause is slow — open the app once to wake it.
- Long lists show 40 rows with **⬇ আরও দেখুন**; the server returns the full data beyond Supabase's 1000-row cap.

## 2. GitHub → Vercel
1. Push this folder to a GitHub repository.
2. vercel.com → Add New → Project → import the repo (no framework preset needed).
3. Settings → Environment Variables (same as before):

| Name | Value |
|---|---|
| `SUPABASE_URL` | Project URL |
| `SUPABASE_SERVICE_KEY` | the `service_role` key |
| `AUTH_SECRET` *(optional)* | any long random text — signs login sessions |

4. Deploy. (Build command / output folder are already in `vercel.json`.)

## 3. First login
Open the site → PIN **12345** (first-setup PIN) → choose your own 5-digit PIN → you land on the **business screen**.
Locked out? Run `reset-owner-pin.sql` (it touches only the login row).

## 4. Using several businesses
- **＋ নতুন ব্যবসা যোগ করুন** — business name, **month cycle (required, you choose it)**, optional mobile / address / owner name → confirm with your PIN.
  The name, address and mobile are what that business prints on its slips (editable later in সেটিং).
- Tap a business to enter it. Everything inside works exactly as before, but only on that business's data.
- **🏢 (header) / মেনু → ব্যবসা পরিবর্তন** goes back to the list. **মেনু → মাসের সাইকেল** (or সেটিং → ব্যবসা ও মাসের সাইকেল) changes the month start day.
- **🗑** next to a business deletes that business and ALL its data (PIN required). Other businesses are never touched.
- Up to 20 businesses.

### How the month cycle works
Day **S** means: the month named "November" runs from the S-th of October to the (S−1)-th of November.
S = 26 → 26 Oct – 25 Nov (the old default) · S = 1 → plain calendar month · S = 5 → 5 Oct – 4 Nov.
Changing it never deletes or edits any entry — only where the month boundaries fall in Home, Reports, Bonus and Expenses.

## 5. Daily routine (inside a business)
1. **মাল দেওয়া ও দিনশেষ হিসাব → মাল দেওয়া** — pick the DSR/SO, tick products, type cases/pieces → memo prints.
2. DSR comes back → **↩️ মাল ফেরত**, then **🧮 দিনশেষ হিসাব** (damage, discount, commission, bonus to shops, other) → enter cash received.
3. **সরাসরি বিক্রয / দোকানের বাকি আদায়** for shops you serve directly.
4. **হোম** and **রিপোর্ট** show profit / loss, bonus, damage and dues for the business's month.

## 6. Stock first
**পণ্য ও স্টক → ➕ যোগ করুন** (per business). Record company purchases in **কোম্পানি লেনদেন → 🛒 কোম্পানি থেকে কেনা**.

## 7. Before real use
Do test entries, then **সেটিং → ডেটা রিসেট** wipes them — **for the current business only**.

## How the separation is guaranteed (for developers)
Every business-owned table has `business_id` (FK → `businesses`, `ON DELETE CASCADE`). The browser sends `X-Business-Id`;
`api/_lib/auth.js › withBiz()` checks the session and that the business exists, then runs the handler inside an
AsyncLocalStorage context. `api/_lib/db.js` exports a scoped `supabase` wrapper that adds `business_id` to every select / update /
delete, stamps it on every insert / upsert, and passes `p_biz` to every SQL function — so no query can reach another business.
All SQL functions take `p_biz` and filter on it; the stock trigger only touches the product of the same business.

## Files
`schema.sql` full database (fresh install) · `migrate-v7-multi-business.sql` upgrade from the single-business version ·
`migrate-v6-dayend-tabs.sql` older upgrade · `reset-owner-pin.sql` PIN reset · `api/` 10 serverless functions
(business list/add/edit/delete live inside `api/auth.js`) · `src/index.html` the app · `build.js` minifies it into `public/` ·
`public/logo.png` · `vercel.json` · `package.json`
