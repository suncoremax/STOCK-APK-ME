# AXIION Business Manager v6.0 — Setup (owner + manager edition)

Same free stack as before: **Supabase** (database) + **Vercel** (hosting) + **GitHub**.
This is a **new, separate project**. Use a **new, empty Supabase project** — do not run it on your old DSR/SO database.

## 1. Supabase
1. Create a new project (free tier is fine).
2. SQL editor → paste **`schema.sql`** → Run.
3. SQL editor → paste **`functions.sql`** → Run.
   (Both are safe to run twice. Neither deletes anything.)
4. Project Settings → API → copy **Project URL** and the **`service_role`** key.

## 2. Vercel
Push this folder to GitHub, import it in Vercel, then add Environment Variables:

| Name | Value |
|---|---|
| `SUPABASE_URL` | Project URL |
| `SUPABASE_SERVICE_KEY` | the `service_role` key (keep secret — server only) |
| `SESSION_SECRET` | (recommended) any long random text; signs login tokens |

Redeploy after adding them. The project has **5 API files** (limit on the Hobby plan is 12).

## 3. First login
Open the site → it shows **"প্রথমবার সেটআপ"** → enter business name, your name, a username and a 4–8 digit PIN.
That creates the **owner**. Then go to **মেনু → সেটিংস → ইউজার → ＋ নতুন** to add managers.

## 4. Bring your data across (optional)
* Products and shops: **পণ্য ও স্টক → ⬆ CSV** and **দোকান ও খাতা → ⬆ CSV** (a sample file is downloadable inside the dialog; it supports opening stock and opening due per shop).
* From the old app, export your product list and shop list with the current stock and each shop's due, then import.
* Company payables: add each company with its "শুরুর দেনা".
* Cash: **সেটিংস → শুরুতে হাতে নগদ / ব্যাংক**.

## 5. Daily routine (how the owner/manager works now)
1. Field person comes back with the report → **নতুন বিক্রয়** per shop (pick the person in "কর্মী" so reports can show per-person sales), enter amount paid → rest becomes the shop's due.
2. Money collected from old dues → **বাকি আদায়**.
3. Goods brought back → **ফেরত ও ড্যামেজ**.
4. Mal arrives from the company → **কোম্পানি থেকে কেনা**.
5. Expenses → **খরচ**. End of day → **ক্যাশবুক → দিন শেষ করুন** (count the cash box; the app shows any difference).

## Tests (optional, for developers)
`tests/` needs a local PostgreSQL and `npm i --no-save pg jsdom`. `tests/api.test.js` (83 checks) and `tests/ui.test.js` run the real API and real screens against a real database.
