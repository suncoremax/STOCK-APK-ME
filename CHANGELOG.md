# AXIION Business Manager

## 6.0.0 — Owner + Manager edition (rebuilt from v5.22)
**Removed:** DSR / SO / driver logins, van loading, orders & approvals, day-end DSR settlement, GPS/live location, road plans, group chat.
**Everything is now entered by the owner or manager**, including on behalf of field staff. Staff are plain records ("কর্মী"), not users.

**Kept / rebuilt:** products & stock (cases + pieces), company purchases with slip no., shops with tally-book ledger (খাতা), due collection (aging, promised dates, credit limit), returns / shop damage / company claim, expenses, online/bank deposits (now a full cash book), attendance, salary & advance, reports, notices, important numbers, reset centre, audit trail.

**New:** one-screen invoice with printable slip · cash book (cash vs bank/bkash) with day-close difference · company payables ledger · stock history per product · void invoice/purchase with automatic stock + ledger reversal · duplicate-tap protection on every save · CSV import/export · full JSON backup · stock re-sync · per-user hashed PINs with signed login tokens · owner-controlled manager permissions (see profit, void, salary).

**Safer money logic:** every sale/purchase/return runs inside one database transaction (stock + ledger + totals together), stock cannot go negative unless allowed, and the API re-checks permissions on every call (hiding cost/profit from managers is enforced on the server, not just in the screen).
