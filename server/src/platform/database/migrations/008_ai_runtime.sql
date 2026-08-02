-- 008_ai_runtime.sql
-- AI runtime persistence: per-campaign run sequences, ai runs, turn entries and
-- interaction requests. Safe to run once via MigrationRunner; portable across
-- SQLite and PostgreSQL. campaign_sequence is allocated by an atomic upsert of
-- platform_ai_run_sequences INSIDE the write transaction (same pattern as outbox).

CREATE TABLE IF NOT EXISTS platform_ai_run_sequences (
  campaign_id TEXT PRIMARY KEY REFERENCES campaigns(id),
  last_seq INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_ai_runs (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  campaign_sequence INTEGER NOT NULL,
  turn_id TEXT NOT NULL REFERENCES platform_turns(id),
  attempt INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed')),
  context_json TEXT NOT NULL,
  result_json TEXT,
  error_code TEXT,
  error_json TEXT,
  raw_debug_json TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  superseded_at TEXT,
  superseded_by_archive_id TEXT REFERENCES platform_archives(id),
  UNIQUE (campaign_id, campaign_sequence),
  UNIQUE (campaign_id, idempotency_key),
  UNIQUE (turn_id, attempt)
);

CREATE INDEX IF NOT EXISTS platform_ai_runs_turn_idx
  ON platform_ai_runs(turn_id, attempt);

CREATE TABLE IF NOT EXISTS platform_turn_entries (
  id TEXT PRIMARY KEY,
  ai_run_id TEXT NOT NULL REFERENCES platform_ai_runs(id),
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  turn_id TEXT NOT NULL REFERENCES platform_turns(id),
  entry_kind TEXT NOT NULL CHECK (entry_kind IN ('narrative','private_update','dice_result')),
  entry_index INTEGER NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('public','player_private','owner_only')),
  target_player_id TEXT REFERENCES users(id),
  payload_json TEXT NOT NULL,
  superseded_at TEXT,
  superseded_by_archive_id TEXT REFERENCES platform_archives(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (ai_run_id, entry_index),
  -- 可见性不变量：player_private 必须有目标玩家；public/owner_only 必须无目标玩家。
  CHECK (
    (visibility = 'player_private' AND target_player_id IS NOT NULL)
    OR
    (visibility IN ('public','owner_only') AND target_player_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS platform_turn_entries_turn_idx
  ON platform_turn_entries(turn_id, visibility);

CREATE TABLE IF NOT EXISTS platform_interaction_requests (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  turn_id TEXT NOT NULL REFERENCES platform_turns(id),
  ai_run_id TEXT NOT NULL REFERENCES platform_ai_runs(id),
  -- provider_id：provider 输出中的客户端引用 id（同输出内唯一）；DB 主键是内部 nanoid，
  -- 避免跨 run/跨 campaign 复用 'i1' 之类短 id 撞全局主键。客户端应答/投影用内部 id。
  provider_id TEXT NOT NULL,
  target_player_id TEXT NOT NULL REFERENCES users(id),
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','answered')),
  superseded_at TEXT,
  superseded_by_archive_id TEXT REFERENCES platform_archives(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS platform_interaction_requests_turn_idx
  ON platform_interaction_requests(turn_id, target_player_id);
