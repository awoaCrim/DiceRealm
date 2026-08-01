-- 004_world_state.sql
-- World facts: the persistent world model for a campaign.
-- Only the owner writes facts; players read only the visibility-projected subset.
-- Safe to re-run: every statement is idempotent (IF NOT EXISTS).
-- Portable across SQLite and PostgreSQL:
--   - TEXT primary/foreign keys
--   - DEFAULT CURRENT_TIMESTAMP
--   - no SQLite-only functions or syntax

CREATE TABLE IF NOT EXISTS platform_world_facts (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('location','npc','item','lore','faction','quest','custom')),
  content TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('public','player_private','owner_only')),
  known_by_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS platform_world_facts_campaign_idx
  ON platform_world_facts(campaign_id, visibility);
