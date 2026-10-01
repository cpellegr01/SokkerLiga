-- SokkerLiga schema. Every statement is idempotent; the file runs on every start.
--
-- Accounts live in the Conforza front door, not here. A person is known to
-- SokkerLiga only by the front door's user id, recorded when first seen.

CREATE TABLE IF NOT EXISTS people (
  user_id       TEXT PRIMARY KEY,   -- the front door's account id
  email         TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);
