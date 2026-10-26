# AXIION DMS — Manual (Owner-only) Edition · Deployment

One owner, one login. DSR / SO are **names only** (nobody logs in with them). The owner gives stock,
types in each DSR's day-end slip, and the app does all the calculations (month cycle 26 → 25, bonus / free,
stock, commission, discount, damage, dues) exactly like the original AXIION DMS.

## 1. Supabase (new, empty project)
1. supabase.com → New project.
2. **SQL Editor → New query →** paste the whole of `schema.sql` → **Run**.
   (It creates every table, function, the `thumbs` photo bucket, 35 starter products and the Owner login.
   It refuses to run if the database already contains data.)
3. Project Settings → API → copy **Project URL** and the **service_role** key.

## 2. GitHub → Vercel
1. Push this folder to a new GitHub repository.
2. vercel.com → Add New → Project → import the repo (no framework preset needed).
3. Settings → Environment Variables:

| Name | Value |
|---|---|
| `SUPABASE_URL` | Project URL |
| `SUPABASE_SERVICE_KEY` | the `service_role` key |
| `AUTH_SECRET` *(optional)* | any long random text — signs login sessions |

4. Deploy. (Build command and output folder are already in `vercel.json`.)

## 3. First login
Open the site → PIN **12345** (first-setup PIN) → the app forces you to choose your own 5-digit PIN. The PIN is asked every time you open the app in a new browser session (login lasts for that session, max 12 hours — closing the tab/browser logs you out). Until you have chosen your own PIN the app keeps showing the "নতুন PIN সেট করুন" window, even after a reload. After that you can change it any time from **সেটিং → PIN পরিবর্তন**.

**Locked out / 12345 not working on an existing database?** Run `reset-owner-pin.sql` in the Supabase SQL Editor (it only resets the login, no data is touched), then log in with 12345 again.
Then: **সেটিং** → fill business name / address / mobile (printed on every slip).

## 4. Daily routine
1. **দেওয়া, ফেরত ও পেমেন্ট → দেওয়া** — pick the DSR/SO, choose products and cases/pieces → memo prints.
2. DSR comes back with his slip → **দেওয়া, ফেরত ও পেমেন্ট → দিনশেষ স্লিপ** — enter returned goods, damage, commission, discount and the cash you received. The app shows the expected cash, what is short, and the DSR's remaining due.
3. **পয়েন্ট সেল / বাকি আদায়** for shops you serve directly.
4. **হোম** (today / this month) and **রিপোর্ট** show profit, bonus / free, damage and dues.

## 5. Stock first
Open **পণ্য ও স্টক** → **➕ যোগ করুন** to add products (prices per case, bonus / free offer, category, low-stock alert, photo). **🏪 SKU স্টক** shows the live stock and its value. Record company purchases in **কোম্পানি লেনদেন → 🛒 কেনা**; damage in **⚠️ ড্যামেজ**; and see what the company owes you in **💥 ড্যামেজ ক্লেইম** and **🎁 বোনাস / ফ্রি**.

## 6. Before real use
Do some test entries, then **সেটিং → ডেটা রিসেট** wipes them (products, names, shops and settings are kept).

## Files
`schema.sql` full database · `reset-owner-pin.sql` PIN reset · `api/` 10 serverless functions · `src/index.html` the app · `build.js` minifies it into `public/` ·
`public/logo.png` logo · `vercel.json` · `package.json`
