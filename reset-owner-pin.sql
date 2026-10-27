-- AXIION DMS — Owner PIN reset (safe: touches ONLY the login row, no business data).
-- Run in Supabase → SQL Editor if you are locked out. Afterwards log in with 12345
-- and the app will ask you to choose a new 5-digit PIN.
INSERT INTO user_passwords (user_key, user_name, role, password, must_change_pw)
VALUES ('owner', 'Owner', 'owner', encode(sha256(convert_to('axiion:12345', 'UTF8')), 'hex'), true)
ON CONFLICT (user_key) DO UPDATE SET password = EXCLUDED.password, must_change_pw = true;
