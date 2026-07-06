# AXIION Stock Management — Miron Electronics
### Version beta v1

A mobile-first stock & sales management web app built with **Vercel serverless functions** + **Supabase** (PostgreSQL).

---

## 🆕 What's New in V1 — Global Group Chat

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
