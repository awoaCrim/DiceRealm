-- 019_action_branch_lifecycle.sql
-- Versioned player actions for archive-restore branches.
--
-- platform_actions used to enforce UNIQUE(turn_id, player_id) at table level,
-- which made a restored participant reuse a later action row. That row may be
-- referenced by immutable adjudication audit, so it cannot be deleted or
-- silently rewritten as the restored action. Rebuild the SQLite FK dependency
-- graph once, retain every historical action, and enforce uniqueness only for
-- the active action in each turn/player slot.

-- SQLite cannot change the referenced platform_actions table in place while
-- platform_action_intents and its dependent audit tables still point at it.
-- Keep exact data-only copies of that dependency graph while the tables are
-- rebuilt with their original constraints and indexes below.
CREATE TABLE platform_019_action_intents_backup AS
  SELECT * FROM platform_action_intents;
CREATE TABLE platform_019_adjudication_decisions_backup AS
  SELECT * FROM platform_adjudication_decisions;
CREATE TABLE platform_019_roll_plans_backup AS
  SELECT * FROM platform_roll_plans;
CREATE TABLE platform_019_roll_records_backup AS
  SELECT * FROM platform_roll_records;

-- Remove children before their referenced tables so foreign_keys=ON remains
-- valid throughout the migration transaction.
DROP TABLE platform_roll_records;
DROP TABLE platform_adjudication_decisions;
DROP TABLE platform_roll_plans;
DROP TABLE platform_action_intents;

-- Rebuild platform_actions without the table-level UNIQUE constraint. The old
-- rows are all active at this migration boundary; future archive restores mark
-- branch rows superseded instead of deleting them.
DROP INDEX IF EXISTS platform_actions_turn_idx;
ALTER TABLE platform_actions RENAME TO platform_actions_019_old;

CREATE TABLE platform_actions (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES platform_turns(id),
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  player_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  superseded_at TEXT,
  superseded_by_archive_id TEXT REFERENCES platform_archives(id)
);

INSERT INTO platform_actions
  (id, turn_id, campaign_id, player_id, body, submitted_at, updated_at,
   superseded_at, superseded_by_archive_id)
SELECT id, turn_id, campaign_id, player_id, body, submitted_at, updated_at,
       NULL, NULL
FROM platform_actions_019_old;

DROP TABLE platform_actions_019_old;

CREATE INDEX platform_actions_turn_idx
  ON platform_actions(turn_id, player_id);

CREATE UNIQUE INDEX platform_actions_active_player_idx
  ON platform_actions(turn_id, player_id)
  WHERE superseded_at IS NULL;

-- Restore platform_action_intents and all dependent audit tables with their
-- original schemas, constraints and indexes.
CREATE TABLE platform_action_intents (
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

INSERT INTO platform_action_intents
  (id, action_id, campaign_id, turn_id, actor_id, execution_id, intent_order,
   source_input, mode, action_type, action_ref, target_ids_json,
   declared_approach, desired_outcome, resource_choices_json, fallback_policy,
   based_on_state_revision, created_at, superseded_at, superseded_by_archive_id)
SELECT id, action_id, campaign_id, turn_id, actor_id, execution_id, intent_order,
       source_input, mode, action_type, action_ref, target_ids_json,
       declared_approach, desired_outcome, resource_choices_json, fallback_policy,
       based_on_state_revision, created_at, superseded_at, superseded_by_archive_id
FROM platform_019_action_intents_backup;

CREATE INDEX platform_action_intents_turn_idx
  ON platform_action_intents(turn_id, intent_order);

CREATE TABLE platform_adjudication_decisions (
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

INSERT INTO platform_adjudication_decisions
  (id, campaign_id, turn_id, intent_id, execution_id, kind, reason_code,
   rule_ref, roll_plan_id, based_on_state_revision, created_at, superseded_at,
   superseded_by_archive_id)
SELECT id, campaign_id, turn_id, intent_id, execution_id, kind, reason_code,
       rule_ref, roll_plan_id, based_on_state_revision, created_at,
       superseded_at, superseded_by_archive_id
FROM platform_019_adjudication_decisions_backup;

CREATE INDEX platform_adjudication_decisions_turn_idx
  ON platform_adjudication_decisions(turn_id, created_at);

CREATE TABLE platform_roll_plans (
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

INSERT INTO platform_roll_plans
  (id, campaign_id, turn_id, intent_id, execution_id, actor_id, target_ids_json,
   roll_kind, dice_expression, modifier_breakdown_json, advantage_state,
   target_type, target_value, success_effects_json, failure_effects_json,
   rule_refs_json, ruleset_id, ruleset_version, based_on_state_revision,
   plan_hash, locked_at, superseded_at, superseded_by_archive_id)
SELECT id, campaign_id, turn_id, intent_id, execution_id, actor_id, target_ids_json,
       roll_kind, dice_expression, modifier_breakdown_json, advantage_state,
       target_type, target_value, success_effects_json, failure_effects_json,
       rule_refs_json, ruleset_id, ruleset_version, based_on_state_revision,
       plan_hash, locked_at, superseded_at, superseded_by_archive_id
FROM platform_019_roll_plans_backup;

CREATE INDEX platform_roll_plans_turn_idx
  ON platform_roll_plans(turn_id, locked_at);

CREATE TABLE platform_roll_records (
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

INSERT INTO platform_roll_records
  (id, campaign_id, turn_id, roll_plan_id, action_intent_id, execution_id,
   mutation_id, raw_dice_json, selected_dice_json, modifier_breakdown_json,
   total, target_value, result, ruleset_id, ruleset_version, state_revision,
   rolled_at, superseded_at, superseded_by_archive_id)
SELECT id, campaign_id, turn_id, roll_plan_id, action_intent_id, execution_id,
       mutation_id, raw_dice_json, selected_dice_json, modifier_breakdown_json,
       total, target_value, result, ruleset_id, ruleset_version, state_revision,
       rolled_at, superseded_at, superseded_by_archive_id
FROM platform_019_roll_records_backup;

CREATE INDEX platform_roll_records_turn_idx
  ON platform_roll_records(turn_id, rolled_at);

DROP TABLE platform_019_action_intents_backup;
DROP TABLE platform_019_adjudication_decisions_backup;
DROP TABLE platform_019_roll_plans_backup;
DROP TABLE platform_019_roll_records_backup;
