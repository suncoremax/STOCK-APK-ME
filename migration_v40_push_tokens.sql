-- V40 — Push notification device tokens. Safe to run once on an existing
-- database: only adds this new table, doesn't touch anything else.
-- See NOTIFICATION_PROTOCOL.md for the full design.

CREATE TABLE IF NOT EXISTS push_tokens (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_key   TEXT        DEFAULT '',
  role       TEXT        DEFAULT '',
  token      TEXT        NOT NULL UNIQUE,   -- one row per physical device install
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_push_tokens_user_key ON push_tokens(user_key);
CREATE INDEX IF NOT EXISTS idx_push_tokens_role     ON push_tokens(role);

ALTER TABLE push_tokens ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "srv_push_tokens"       ON push_tokens;
DROP POLICY IF EXISTS "anon_deny_push_tokens" ON push_tokens;
CREATE POLICY "srv_push_tokens"       ON push_tokens FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "anon_deny_push_tokens" ON push_tokens FOR ALL TO anon         USING (false);
