# AXIION Stock Management — Miron Electronics
### Version beta v1 (V24 update)

A mobile-first stock & sales management web app built with **Vercel serverless functions** + **Supabase** (PostgreSQL).

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
│   ├── expenses.js          # Expenses, chat, notices, contacts, personal calculator, SO quota
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
4. Deploy — Vercel auto-deploys on every push

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
