-- 001_initial_platform.sql
-- Platform foundation: accounts, sessions, campaigns and membership.
-- Safe to re-run: every statement is idempotent (IF NOT EXISTS).
-- Must stay compatible with both SQLite and PostgreSQL basic syntax:
--   - TEXT primary/foreign keys
--   - DEFAULT CURRENT_TIMESTAMP (portable across engines, unlike the
--     SQLite-only now() helper)
-- No SQLite-only functions or syntax are allowed in this file.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  login TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  ruleset TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS campaign_members (
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'player')),
  joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (campaign_id, user_id)
);
