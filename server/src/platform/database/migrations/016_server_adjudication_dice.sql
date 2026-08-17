-- 016_server_adjudication_dice.sql
-- Server-owned semantic intent, adjudication, dice and narration retry records.
-- Mechanical records are immutable audit inputs to one authoritative StateRevision.

ALTER TABLE platform_ai_runs ADD COLUMN run_kind TEXT NOT NULL DEFAULT 'turn_resolution'
  CHECK (run_kind IN ('turn_resolution','intent_interpretation','mechanical_resolution','narration'));
ALTER TABLE platform_ai_runs ADD COLUMN parent_run_id TEXT REFERENCES platform_ai_runs(id);

CREATE TABLE IF NOT EXISTS platform_action_intents (
  id TEXT PRIMARY KEY,
  action_id TEXT REFERENCES platform_actions(id),
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  turn_id TEXT NOT NULL REFERENCES platform_turns(id),
  actor_id TEXT NOT NULL,
  execution_id TEXT NOT NULL REFERENCES platform_ai_runs(id),
  intent_order INTEGER NOT NULL CHECK (intent_order >= 0),
  source_input TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('player_action','npc_action','owner_command')),
  action_type TEXT NOT NULL CHECK (action_type IN ('ability_check','attack','saving_throw','healing','use_action','improvised_action')),
  action_ref TEXT,
  target_ids_json TEXT NOT NULL,
  declared_approach TEXT,
  desired_outcome TEXT,
  resource_choices_json TEXT NOT NULL,
  fallback_policy TEXT CHECK (fallback_policy IN ('stop_on_failure','continue','ask_player')),
  based_on_state_revision INTEGER NOT NULL CHECK (based_on_state_revision >= 0),
  created_at TEXT NOT NULL,
  superseded_at TEXT,
  superseded_by_archive_id TEXT REFERENCES platform_archives(id),
  UNIQUE (execution_id, action_id),
  UNIQUE (execution_id, intent_order)
);

CREATE INDEX IF NOT EXISTS platform_action_intents_turn_idx
  ON platform_action_intents(turn_id, intent_order);

CREATE TABLE IF NOT EXISTS platform_adjudication_decisions (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  turn_id TEXT NOT NULL REFERENCES platform_turns(id),
  intent_id TEXT NOT NULL REFERENCES platform_action_intents(id),
  execution_id TEXT NOT NULL REFERENCES platform_ai_runs(id),
  kind TEXT NOT NULL CHECK (kind IN ('automatic_success','automatic_failure','roll_required','player_choice_required','gm_adjudication_required','unsupported')),
  reason_code TEXT NOT NULL,
  rule_ref TEXT,
  roll_plan_id TEXT,
  based_on_state_revision INTEGER NOT NULL CHECK (based_on_state_revision >= 0),
  created_at TEXT NOT NULL,
  superseded_at TEXT,
  superseded_by_archive_id TEXT REFERENCES platform_archives(id),
  UNIQUE (execution_id, intent_id)
);

CREATE INDEX IF NOT EXISTS platform_adjudication_decisions_turn_idx
  ON platform_adjudication_decisions(turn_id, created_at);

CREATE TABLE IF NOT EXISTS platform_roll_plans (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  turn_id TEXT NOT NULL REFERENCES platform_turns(id),
  intent_id TEXT NOT NULL REFERENCES platform_action_intents(id),
  execution_id TEXT NOT NULL REFERENCES platform_ai_runs(id),
  actor_id TEXT NOT NULL REFERENCES users(id),
  target_ids_json TEXT NOT NULL,
  roll_kind TEXT NOT NULL CHECK (roll_kind IN ('d20_check','attack','saving_throw','damage','healing')),
  dice_expression TEXT NOT NULL,
  modifier_breakdown_json TEXT NOT NULL,
  advantage_state TEXT NOT NULL CHECK (advantage_state IN ('normal','advantage','disadvantage')),
  target_type TEXT NOT NULL CHECK (target_type IN ('dc','ac','none')),
  target_value INTEGER,
  success_effects_json TEXT NOT NULL,
  failure_effects_json TEXT NOT NULL,
  rule_refs_json TEXT NOT NULL,
  ruleset_id TEXT NOT NULL,
  ruleset_version TEXT NOT NULL,
  based_on_state_revision INTEGER NOT NULL CHECK (based_on_state_revision >= 0),
  plan_hash TEXT NOT NULL CHECK (length(plan_hash) = 64),
  locked_at TEXT NOT NULL,
  superseded_at TEXT,
  superseded_by_archive_id TEXT REFERENCES platform_archives(id),
  UNIQUE (execution_id, id),
  UNIQUE (execution_id, intent_id, roll_kind)
);

CREATE INDEX IF NOT EXISTS platform_roll_plans_turn_idx
  ON platform_roll_plans(turn_id, locked_at);

CREATE TABLE IF NOT EXISTS platform_roll_records (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  turn_id TEXT NOT NULL REFERENCES platform_turns(id),
  roll_plan_id TEXT NOT NULL REFERENCES platform_roll_plans(id),
  action_intent_id TEXT NOT NULL REFERENCES platform_action_intents(id),
  execution_id TEXT NOT NULL REFERENCES platform_ai_runs(id),
  mutation_id TEXT NOT NULL,
  raw_dice_json TEXT NOT NULL,
  selected_dice_json TEXT NOT NULL,
  modifier_breakdown_json TEXT NOT NULL,
  total INTEGER NOT NULL,
  target_value INTEGER,
  result TEXT NOT NULL CHECK (result IN ('success','failure','critical_success','critical_failure','not_applicable')),
  ruleset_id TEXT NOT NULL,
  ruleset_version TEXT NOT NULL,
  state_revision INTEGER NOT NULL CHECK (state_revision >= 0),
  rolled_at TEXT NOT NULL,
  superseded_at TEXT,
  superseded_by_archive_id TEXT REFERENCES platform_archives(id),
  UNIQUE (execution_id, roll_plan_id)
);

CREATE INDEX IF NOT EXISTS platform_roll_records_turn_idx
  ON platform_roll_records(turn_id, rolled_at);

CREATE TABLE IF NOT EXISTS platform_resolved_outcomes (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  turn_id TEXT NOT NULL REFERENCES platform_turns(id),
  execution_id TEXT NOT NULL REFERENCES platform_ai_runs(id),
  mutation_id TEXT NOT NULL,
  based_on_state_revision INTEGER NOT NULL CHECK (based_on_state_revision >= 0),
  applied_state_revision INTEGER NOT NULL CHECK (applied_state_revision >= 0),
  outcome_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  superseded_at TEXT,
  superseded_by_archive_id TEXT REFERENCES platform_archives(id),
  UNIQUE (execution_id),
  UNIQUE (campaign_id, mutation_id)
);

CREATE INDEX IF NOT EXISTS platform_resolved_outcomes_turn_idx
  ON platform_resolved_outcomes(turn_id, created_at);

CREATE TABLE IF NOT EXISTS platform_narration_attempts (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  turn_id TEXT NOT NULL REFERENCES platform_turns(id),
  execution_id TEXT NOT NULL REFERENCES platform_ai_runs(id),
  outcome_id TEXT NOT NULL REFERENCES platform_resolved_outcomes(id),
  idempotency_key TEXT NOT NULL,
  state_revision INTEGER NOT NULL CHECK (state_revision >= 0),
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed')),
  request_json TEXT NOT NULL,
  result_json TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  superseded_at TEXT,
  superseded_by_archive_id TEXT REFERENCES platform_archives(id),
  UNIQUE (campaign_id, idempotency_key),
  UNIQUE (execution_id, idempotency_key),
  UNIQUE (execution_id, attempt)
);

CREATE INDEX IF NOT EXISTS platform_narration_attempts_turn_idx
  ON platform_narration_attempts(turn_id, attempt);
