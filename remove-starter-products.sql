-- Removes products from an EXISTING database (run once in Supabase → SQL Editor).
-- Safe: a product that already appears in any transaction, damage claim or bonus record
-- is KEPT, so old slips and reports never break. Everything else is deleted.
DELETE FROM products p
WHERE NOT EXISTS (SELECT 1 FROM transactions t WHERE t.product_id = p.id::text)
  AND NOT EXISTS (SELECT 1 FROM dmg_claims  d WHERE d.product_id = p.id::text)
  AND NOT EXISTS (SELECT 1 FROM bonus       b WHERE b.product_id = p.id::text);

-- How many are left (0 = clean catalogue):
SELECT count(*) AS products_left FROM products;
