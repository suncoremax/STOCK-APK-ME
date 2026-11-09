# SETUP — NEW INSTALL (Single-business edition)

**One SQL file only: `schema.sql`.** Run it once in the Supabase SQL Editor on a new, empty project. It is the complete database (tables, functions, price history, company deposits / receipts, photo bucket, owner login PIN 12345). Then set `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` (service_role) in Vercel, deploy, log in with 12345 and choose your own PIN. The app then asks for your **business name** and **month cycle** — and opens. That is all.

This edition runs **exactly one business** (the multi-business edition could run up to 20). Everything inside is identical. The database itself refuses a second business, and there is no business list / add / delete / switch in the app.

# Deployment

Stack: **Vercel** (serverless API, 11 functions — under the 12 limit) + **Supabase** (Postgres) + **GitHub**.

## 1. Supabase
1. supabase.com → New project.
2. **SQL Editor → New query →** paste the whole of `schema.sql` → **Run**. It refuses to run if the database already holds data.
3. Project Settings → API → copy **Project URL** and the **service_role** key.
4. Already created the database from an older build of this app? Run **`add-speed-indexes.sql`** once (optional, safe to repeat) — it only adds indexes.

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

### Make it fast (important)
- **Vercel → Project → Settings → Functions → Function Region**: choose the region **closest to your Supabase project** (Supabase → Project Settings → General shows its region, e.g. *Southeast Asia (Singapore)* → Vercel *Singapore (sin1)*). The API makes several database calls per screen; if the two are on different continents every call adds 200–300 ms. This is the single biggest speed setting. Redeploy after changing it.
- Free Supabase projects **pause after 1 week without use** and the first request after a pause is slow — open the app once to wake it.
- Lists are paged: the server returns the full data (beyond Supabase's 1000-row cap) and the screens show 40 rows at a time with **⬇ আরও দেখুন**.

## 3. First login
Open the site → PIN **12345** (first-setup PIN) → choose your own 5-digit PIN → enter your **business name** and **month cycle** → the app opens.
Locked out? Run `reset-owner-pin.sql` (it touches only the login row).

### How the month cycle works
Day **S** means: the month named "November" runs from the S-th of October to the (S−1)-th of November.
S = 26 → 26 Oct – 25 Nov · S = 1 → plain calendar month · S = 5 → 5 Oct – 4 Nov.
Changing it (সেটিং → ব্যবসা ও মাসের সাইকেল) never deletes or edits any entry — only where the month boundaries fall in Home, Reports, Bonus and Expenses.

## 4. Daily routine
1. **মাল দেওয়া ও দিনশেষ হিসাব → মাল দেওয়া** — pick the DSR/SO, tick products, type cases/pieces → memo prints.
2. DSR comes back → **↩️ মাল ফেরত**, then **🧮 দিনশেষ হিসাব** (damage, discount, commission, bonus to shops, other) → enter cash received.
3. **সরাসরি বিক্রয / দোকানের বাকি আদায়** for shops you serve directly.
4. **হোম** and **রিপোর্ট** show profit / loss, bonus, damage and dues for the month.

## 5. Stock first
**পণ্য ও স্টক → ➕ যোগ করুন**. Record company purchases in **কোম্পানি লেনদেন → 🛒 কোম্পানি থেকে কেনা**.

## 6. Before real use
Do test entries, then **সেটিং → ডেটা রিসেট** wipes them.

## For developers — how the single business works
The tables still carry `business_id` (same layout as the multi-business edition, so every SQL function and query is unchanged), but `schema.sql` adds `CREATE UNIQUE INDEX one_business_only ON businesses ((TRUE))` — at most one row. `api/_lib/auth.js › ensureBusiness()` finds that row (creating it on the very first login), caches it for 60 s and shares one lookup between simultaneous requests; `withBiz()` runs every handler inside its context and **ignores any `X-Business-Id` header**. `api/_lib/db.js` still scopes every query to it. `biz-add` / `biz-del` answer "only one business" and never touch the database.

## Files
`schema.sql` full database · `add-speed-indexes.sql` optional indexes for an existing database · `reset-owner-pin.sql` PIN reset · `api/` 11 serverless functions · `src/index.html` the app · `build.js` minifies it into `public/` · `public/logo.png` · `vercel.json` · `package.json` · `tests/` (`node tests/single-business.test.js`, `ledger`, `offer`, `profit`)
