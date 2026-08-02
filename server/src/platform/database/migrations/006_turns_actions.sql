-- 006_turns_actions.sql
-- Turn lifecycle and player actions.
-- platform_turn_requirements normalises which players must act per turn and
-- whether each has submitted; platform_actions upserts per (turn, player).
-- Safe to re-run; portable across SQLite and PostgreSQL.

CREATE TABLE IF NOT EXISTS platform_turns (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  number INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('waiting_for_actions','locked','resolving','needs_owner_attention','completed')),
  locked_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (campaign_id, number)
);

CREATE INDEX IF NOT EXISTS platform_turns_campaign_idx
  ON platform_turns(campaign_id, number);

CREATE TABLE IF NOT EXISTS platform_actions (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES platform_turns(id),
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  player_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (turn_id, player_id)
);

CREATE INDEX IF NOT EXISTS platform_actions_turn_idx
  ON platform_actions(turn_id, player_id);

CREATE TABLE IF NOT EXISTS platform_turn_requirements (
  turn_id TEXT NOT NULL REFERENCES platform_turns(id),
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  player_id TEXT NOT NULL REFERENCES users(id),
  submitted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (turn_id, player_id)
);

CREATE INDEX IF NOT EXISTS platform_turn_requirements_turn_idx
  ON platform_turn_requirements(turn_id, submitted);
