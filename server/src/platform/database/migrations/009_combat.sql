-- Phase 3: structured combat — encounters and combatants.
-- Portability: SQLite/PostgreSQL compatible DDL only; no driver-specific functions.
-- Repository inserts/updates always write explicit ISO timestamps, so DEFAULT
-- CURRENT_TIMESTAMP is only a safety net, never the source of record.

CREATE TABLE IF NOT EXISTS platform_encounters (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('preparation','active','completed')),
  active_combatant_id TEXT,
  round INTEGER NOT NULL DEFAULT 1 CHECK (round >= 1),
  superseded_at TEXT,
  superseded_by_archive_id TEXT REFERENCES platform_archives(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_encounters_campaign_status_superseded
  ON platform_encounters (campaign_id, status, superseded_at);

CREATE TABLE IF NOT EXISTS platform_combatants (
  id TEXT PRIMARY KEY,
  encounter_id TEXT NOT NULL REFERENCES platform_encounters(id),
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  character_id TEXT REFERENCES platform_characters(id),
  name TEXT NOT NULL,
  initiative INTEGER,
  initiative_bonus INTEGER NOT NULL DEFAULT 0,
  hp_current INTEGER NOT NULL CHECK (hp_current >= 0),
  hp_max INTEGER NOT NULL CHECK (hp_max > 0),
  ac INTEGER NOT NULL CHECK (ac >= 0),
  conditions_json TEXT NOT NULL DEFAULT '[]',
  visibility TEXT NOT NULL CHECK (visibility IN ('public','player_private','owner_only')),
  target_player_id TEXT REFERENCES users(id),
  position INTEGER NOT NULL CHECK (position >= 0),
  superseded_at TEXT,
  superseded_by_archive_id TEXT REFERENCES platform_archives(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (encounter_id, position),
  CHECK (
    (visibility = 'player_private' AND target_player_id IS NOT NULL)
    OR (visibility <> 'player_private' AND target_player_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_combatants_encounter_position
  ON platform_combatants (encounter_id, position);

CREATE INDEX IF NOT EXISTS idx_combatants_campaign_superseded
  ON platform_combatants (campaign_id, superseded_at);
