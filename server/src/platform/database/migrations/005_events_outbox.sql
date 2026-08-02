-- 005_events_outbox.sql
-- Transactional event outbox + per-campaign sequence counter.
-- New events are unpublished (published_at IS NULL). The sequence is allocated
-- by an atomic upsert of platform_outbox_sequences INSIDE the business
-- transaction; UNIQUE(campaign_id, sequence) is only an invariant, never the
-- allocation mechanism. Safe to re-run; portable across SQLite and PostgreSQL.

CREATE TABLE IF NOT EXISTS platform_outbox_sequences (
  campaign_id TEXT PRIMARY KEY REFERENCES campaigns(id),
  last_seq INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_outbox_events (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('public','owner_only','player_private')),
  target_player_id TEXT,
  payload_json TEXT NOT NULL,
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (campaign_id, sequence)
);

CREATE INDEX IF NOT EXISTS platform_outbox_events_campaign_seq_idx
  ON platform_outbox_events(campaign_id, sequence);
