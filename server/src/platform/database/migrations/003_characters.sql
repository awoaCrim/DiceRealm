-- 003_characters.sql
-- Character cards and their audit trail.
-- Safe to re-run: every statement is idempotent (IF NOT EXISTS).
-- Must stay compatible with both SQLite and PostgreSQL basic syntax:
--   - TEXT primary/foreign keys
--   - DEFAULT CURRENT_TIMESTAMP (portable across engines, unlike the
--     SQLite-only now() helper)
-- No SQLite-only functions or syntax are allowed in this file.

CREATE TABLE IF NOT EXISTS platform_characters (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  player_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','pending_review','approved','rejected','archived')),
  sheet_json TEXT NOT NULL DEFAULT '{}',
  derived_json TEXT NOT NULL DEFAULT '{}',
  submitted_at TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS platform_characters_campaign_idx
  ON platform_characters(campaign_id, status);

CREATE TABLE IF NOT EXISTS platform_character_audits (
  id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL REFERENCES platform_characters(id),
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS platform_character_audits_character_idx
  ON platform_character_audits(character_id);
