-- 017_narrative_runtime_fact_memory.sql
-- NarrativeRound lifecycle, persistent WorkingFacts and immutable RoundFactSet.
-- Round state is authoritative here; platform_turns remains a compatibility mirror.
-- Portable across SQLite and PostgreSQL.

CREATE TABLE IF NOT EXISTS platform_narrative_rounds (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  -- Compatibility id only: deliberately no FK so legacy archive replacement can remap a Turn id.
  turn_id TEXT NOT NULL UNIQUE,
  number INTEGER NOT NULL CHECK (number >= 0),
  status TEXT NOT NULL CHECK (status IN ('collecting','ready','processing','needs_owner_attention','closed')),
  decision_cursor INTEGER NOT NULL DEFAULT 0 CHECK (decision_cursor >= 0),
  last_state_revision INTEGER NOT NULL DEFAULT 0 CHECK (last_state_revision >= 0),
  closed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  superseded_at TEXT,
  superseded_by_archive_id TEXT REFERENCES platform_archives(id)
);

CREATE INDEX IF NOT EXISTS platform_narrative_rounds_campaign_idx
  ON platform_narrative_rounds(campaign_id, number, superseded_at);

CREATE TABLE IF NOT EXISTS platform_narrative_round_participants (
  round_id TEXT NOT NULL REFERENCES platform_narrative_rounds(id),
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  player_id TEXT NOT NULL REFERENCES users(id),
  character_id TEXT REFERENCES platform_characters(id),
  participant_order INTEGER NOT NULL CHECK (participant_order >= 0),
  required INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0,1)),
  status TEXT NOT NULL CHECK (status IN ('waiting','submitted','processing','resolved','skipped','needs_owner_attention')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  superseded_at TEXT,
  superseded_by_archive_id TEXT REFERENCES platform_archives(id),
  PRIMARY KEY (round_id, player_id)
);

CREATE INDEX IF NOT EXISTS platform_narrative_participants_campaign_idx
  ON platform_narrative_round_participants(campaign_id, round_id, participant_order, superseded_at);

CREATE TABLE IF NOT EXISTS platform_narrative_decisions (
  id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL REFERENCES platform_narrative_rounds(id),
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  -- Legacy Turn/action rows may be replaced during archive restore; keep these as audit ids.
  turn_id TEXT NOT NULL,
  action_id TEXT,
  actor_id TEXT NOT NULL REFERENCES users(id),
  decision_order INTEGER NOT NULL CHECK (decision_order >= 0),
  status TEXT NOT NULL CHECK (status IN ('waiting','submitted','processing','resolved','skipped','needs_owner_attention')),
  -- Audit ids may be written before the corresponding AI/outcome row in one transaction.
  execution_id TEXT,
  outcome_id TEXT,
  claim_revision INTEGER CHECK (claim_revision IS NULL OR claim_revision >= 0),
  applied_state_revision INTEGER CHECK (applied_state_revision IS NULL OR applied_state_revision >= 0),
  failure_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  superseded_at TEXT,
  superseded_by_archive_id TEXT REFERENCES platform_archives(id),
  UNIQUE (round_id, actor_id),
  UNIQUE (round_id, action_id)
);

CREATE INDEX IF NOT EXISTS platform_narrative_decisions_order_idx
  ON platform_narrative_decisions(round_id, decision_order, superseded_at);

CREATE TABLE IF NOT EXISTS platform_narrative_working_facts (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  round_id TEXT NOT NULL REFERENCES platform_narrative_rounds(id),
  decision_id TEXT REFERENCES platform_narrative_decisions(id),
  action_id TEXT,
  fact_kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('public','player_private','owner_only')),
  audience_actor_ids_json TEXT NOT NULL DEFAULT '[]',
  authority TEXT NOT NULL CHECK (authority IN ('server_mechanical','runtime_state','event_evidence','ai_candidate')),
  validation_status TEXT NOT NULL CHECK (validation_status IN ('authoritative','candidate','pending','rejected')),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('state_transaction','mechanical_resolved_outcome','narrative_decision','narration_result','turn_or_narrative_event','gm_authored')),
  source_refs_json TEXT NOT NULL,
  based_on_state_revision INTEGER NOT NULL CHECK (based_on_state_revision >= 0),
  applied_state_revision INTEGER CHECK (applied_state_revision IS NULL OR applied_state_revision >= 0),
  execution_id TEXT,
  outcome_id TEXT,
  event_id TEXT,
  created_at TEXT NOT NULL,
  superseded_at TEXT,
  superseded_by_archive_id TEXT REFERENCES platform_archives(id)
);

CREATE INDEX IF NOT EXISTS platform_narrative_working_facts_round_idx
  ON platform_narrative_working_facts(round_id, created_at, superseded_at);

CREATE INDEX IF NOT EXISTS platform_narrative_working_facts_campaign_idx
  ON platform_narrative_working_facts(campaign_id, visibility, superseded_at);

CREATE TABLE IF NOT EXISTS platform_narrative_round_fact_sets (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  round_id TEXT NOT NULL UNIQUE REFERENCES platform_narrative_rounds(id),
  source_state_revision INTEGER NOT NULL CHECK (source_state_revision >= 0),
  closed_at TEXT NOT NULL,
  superseded_at TEXT,
  superseded_by_archive_id TEXT REFERENCES platform_archives(id)
);

CREATE INDEX IF NOT EXISTS platform_narrative_fact_sets_campaign_idx
  ON platform_narrative_round_fact_sets(campaign_id, closed_at, superseded_at);

CREATE TABLE IF NOT EXISTS platform_narrative_round_facts (
  id TEXT PRIMARY KEY,
  fact_set_id TEXT NOT NULL REFERENCES platform_narrative_round_fact_sets(id),
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  round_id TEXT NOT NULL REFERENCES platform_narrative_rounds(id),
  decision_id TEXT REFERENCES platform_narrative_decisions(id),
  action_id TEXT,
  fact_kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('public','player_private','owner_only')),
  audience_actor_ids_json TEXT NOT NULL DEFAULT '[]',
  authority TEXT NOT NULL CHECK (authority IN ('server_mechanical','runtime_state','event_evidence','ai_candidate')),
  validation_status TEXT NOT NULL CHECK (validation_status IN ('authoritative','candidate','pending','rejected')),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('state_transaction','mechanical_resolved_outcome','narrative_decision','narration_result','turn_or_narrative_event','gm_authored')),
  source_refs_json TEXT NOT NULL,
  based_on_state_revision INTEGER NOT NULL CHECK (based_on_state_revision >= 0),
  applied_state_revision INTEGER CHECK (applied_state_revision IS NULL OR applied_state_revision >= 0),
  execution_id TEXT,
  outcome_id TEXT,
  event_id TEXT,
  created_at TEXT NOT NULL,
  superseded_at TEXT,
  superseded_by_archive_id TEXT REFERENCES platform_archives(id),
  UNIQUE (fact_set_id, id)
);

CREATE INDEX IF NOT EXISTS platform_narrative_round_facts_projection_idx
  ON platform_narrative_round_facts(round_id, visibility, validation_status, superseded_at);

CREATE INDEX IF NOT EXISTS platform_narrative_round_facts_campaign_idx
  ON platform_narrative_round_facts(campaign_id, created_at, superseded_at);
