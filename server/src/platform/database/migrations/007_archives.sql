-- 007_archives.sql
-- Campaign archives (real snapshot + real restore) and superseded-history foundations.
-- Version per campaign is allocated by an atomic upsert of platform_archive_sequences
-- INSIDE the write transaction (same pattern as the outbox sequence counter);
-- UNIQUE(campaign_id, version) is only an invariant, never the allocation mechanism.
-- Safe to run once via MigrationRunner; portable across SQLite and PostgreSQL.

CREATE TABLE IF NOT EXISTS platform_archive_sequences (
  campaign_id TEXT PRIMARY KEY REFERENCES campaigns(id),
  last_version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_archives (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  kind TEXT NOT NULL CHECK (kind IN ('automatic','manual')),
  turn_id TEXT REFERENCES platform_turns(id),
  label TEXT,
  version INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  superseded_at TEXT,
  superseded_by_archive_id TEXT REFERENCES platform_archives(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (campaign_id, version)
);

CREATE INDEX IF NOT EXISTS platform_archives_campaign_version_idx
  ON platform_archives(campaign_id, version);

-- Superseded-history foundations on existing platform tables.
ALTER TABLE platform_turns ADD COLUMN superseded_at TEXT;
ALTER TABLE platform_turns ADD COLUMN superseded_by_archive_id TEXT;
ALTER TABLE platform_world_facts ADD COLUMN superseded_at TEXT;
ALTER TABLE platform_world_facts ADD COLUMN superseded_by_archive_id TEXT;
ALTER TABLE platform_outbox_events ADD COLUMN superseded_at TEXT;
ALTER TABLE platform_outbox_events ADD COLUMN superseded_by_archive_id TEXT;
