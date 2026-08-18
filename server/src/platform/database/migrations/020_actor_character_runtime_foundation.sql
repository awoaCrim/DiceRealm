-- Phase 4: additive CampaignActor identity and authoring/runtime separation.
-- Existing user/player/legacy actor columns are intentionally retained.

CREATE TABLE IF NOT EXISTS platform_campaign_actors (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  display_name TEXT NOT NULL,
  character_type TEXT NOT NULL CHECK (character_type IN ('player_character','npc')),
  control_mode TEXT NOT NULL CHECK (control_mode IN ('player','ai','gm','shared','scripted')),
  mechanics_mode TEXT NOT NULL CHECK (mechanics_mode IN ('pc_build','npc_statblock','lightweight')),
  character_id TEXT REFERENCES platform_characters(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (campaign_id, character_id)
);

CREATE INDEX IF NOT EXISTS platform_campaign_actors_campaign_idx
  ON platform_campaign_actors(campaign_id, character_type, created_at);

CREATE TABLE IF NOT EXISTS platform_actor_control_bindings (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  actor_id TEXT NOT NULL REFERENCES platform_campaign_actors(id),
  user_id TEXT REFERENCES users(id),
  binding_role TEXT NOT NULL CHECK (binding_role IN ('player','gm','operator')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (actor_id, user_id, binding_role)
);

CREATE INDEX IF NOT EXISTS platform_actor_bindings_user_idx
  ON platform_actor_control_bindings(campaign_id, user_id, active);
CREATE INDEX IF NOT EXISTS platform_actor_bindings_actor_idx
  ON platform_actor_control_bindings(campaign_id, actor_id, active);

CREATE TABLE IF NOT EXISTS platform_character_runtime_states (
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  actor_id TEXT PRIMARY KEY REFERENCES platform_campaign_actors(id),
  current_hp INTEGER NOT NULL CHECK (current_hp >= 0),
  temporary_hp INTEGER NOT NULL DEFAULT 0 CHECK (temporary_hp >= 0),
  conditions_json TEXT NOT NULL DEFAULT '[]',
  runtime_status TEXT NOT NULL CHECK (runtime_status IN ('active','incapacitated','defeated','inactive')),
  state_revision INTEGER NOT NULL CHECK (state_revision >= 0),
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS platform_character_runtime_states_campaign_idx
  ON platform_character_runtime_states(campaign_id, updated_at);

-- Dual identity columns. Null means this row predates the live Actor cutover.
ALTER TABLE platform_combatants ADD COLUMN actor_id TEXT REFERENCES platform_campaign_actors(id);

-- Userless NPC narrative participants need a nullable submitter/player column.
-- Rebuild only this table so the legacy player_id meaning and all rows remain intact;
-- the unique actor index below becomes the live identity boundary.
DROP INDEX IF EXISTS platform_narrative_participants_campaign_idx;
PRAGMA legacy_alter_table = ON;
ALTER TABLE platform_narrative_round_participants RENAME TO platform_narrative_round_participants_legacy;
CREATE TABLE platform_narrative_round_participants (
  round_id TEXT NOT NULL REFERENCES platform_narrative_rounds(id),
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  player_id TEXT REFERENCES users(id),
  actor_id TEXT REFERENCES platform_campaign_actors(id),
  character_id TEXT REFERENCES platform_characters(id),
  participant_order INTEGER NOT NULL CHECK (participant_order >= 0),
  required INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0,1)),
  status TEXT NOT NULL CHECK (status IN ('waiting','submitted','processing','resolved','skipped','needs_owner_attention')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  superseded_at TEXT,
  superseded_by_archive_id TEXT REFERENCES platform_archives(id),
  PRIMARY KEY (round_id, player_id, actor_id)
);
INSERT INTO platform_narrative_round_participants
  (round_id, campaign_id, player_id, actor_id, character_id, participant_order, required, status,
   created_at, updated_at, superseded_at, superseded_by_archive_id)
SELECT round_id, campaign_id, player_id, NULL, character_id, participant_order, required, status,
       created_at, updated_at, superseded_at, superseded_by_archive_id
FROM platform_narrative_round_participants_legacy;
DROP TABLE platform_narrative_round_participants_legacy;
CREATE UNIQUE INDEX platform_narrative_participants_legacy_unique_idx
  ON platform_narrative_round_participants(round_id, player_id)
  WHERE player_id IS NOT NULL;
CREATE UNIQUE INDEX platform_narrative_participants_actor_unique_idx
  ON platform_narrative_round_participants(round_id, actor_id)
  WHERE actor_id IS NOT NULL;
CREATE INDEX platform_narrative_participants_campaign_idx
  ON platform_narrative_round_participants(campaign_id, round_id, participant_order, superseded_at);
-- Decisions also need a nullable legacy submitter for userless Actors.
DROP INDEX IF EXISTS platform_narrative_decisions_order_idx;
ALTER TABLE platform_narrative_decisions RENAME TO platform_narrative_decisions_legacy;
CREATE TABLE platform_narrative_decisions (
  id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL REFERENCES platform_narrative_rounds(id),
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  turn_id TEXT NOT NULL,
  action_id TEXT,
  actor_id TEXT REFERENCES users(id),
  campaign_actor_id TEXT REFERENCES platform_campaign_actors(id),
  decision_order INTEGER NOT NULL CHECK (decision_order >= 0),
  status TEXT NOT NULL CHECK (status IN ('waiting','submitted','processing','resolved','skipped','needs_owner_attention')),
  execution_id TEXT,
  outcome_id TEXT,
  claim_revision INTEGER CHECK (claim_revision IS NULL OR claim_revision >= 0),
  applied_state_revision INTEGER CHECK (applied_state_revision IS NULL OR applied_state_revision >= 0),
  failure_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  superseded_at TEXT,
  superseded_by_archive_id TEXT REFERENCES platform_archives(id)
);
INSERT INTO platform_narrative_decisions
  (id, round_id, campaign_id, turn_id, action_id, actor_id, campaign_actor_id, decision_order, status,
   execution_id, outcome_id, claim_revision, applied_state_revision, failure_code, created_at, updated_at,
   superseded_at, superseded_by_archive_id)
SELECT id, round_id, campaign_id, turn_id, action_id, actor_id, NULL, decision_order, status,
       execution_id, outcome_id, claim_revision, applied_state_revision, failure_code, created_at, updated_at,
       superseded_at, superseded_by_archive_id
FROM platform_narrative_decisions_legacy;
DROP TABLE platform_narrative_decisions_legacy;

-- SQLite rewrites dependent FK SQL during table rename. Rebuild the two fact
-- tables that reference decisions so their FK target remains the live table.
DROP INDEX IF EXISTS platform_narrative_working_facts_round_idx;
DROP INDEX IF EXISTS platform_narrative_working_facts_campaign_idx;
ALTER TABLE platform_narrative_working_facts RENAME TO platform_narrative_working_facts_legacy;
CREATE TABLE platform_narrative_working_facts (
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
INSERT INTO platform_narrative_working_facts SELECT * FROM platform_narrative_working_facts_legacy;
DROP TABLE platform_narrative_working_facts_legacy;
CREATE INDEX platform_narrative_working_facts_round_idx
  ON platform_narrative_working_facts(round_id, created_at, superseded_at);
CREATE INDEX platform_narrative_working_facts_campaign_idx
  ON platform_narrative_working_facts(campaign_id, visibility, superseded_at);

DROP INDEX IF EXISTS platform_narrative_round_facts_projection_idx;
DROP INDEX IF EXISTS platform_narrative_round_facts_campaign_idx;
ALTER TABLE platform_narrative_round_facts RENAME TO platform_narrative_round_facts_legacy;
CREATE TABLE platform_narrative_round_facts (
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
INSERT INTO platform_narrative_round_facts SELECT * FROM platform_narrative_round_facts_legacy;
DROP TABLE platform_narrative_round_facts_legacy;
CREATE INDEX platform_narrative_round_facts_projection_idx
  ON platform_narrative_round_facts(round_id, visibility, validation_status, superseded_at);
CREATE INDEX platform_narrative_round_facts_campaign_idx
  ON platform_narrative_round_facts(campaign_id, created_at, superseded_at);

CREATE UNIQUE INDEX platform_narrative_decisions_legacy_actor_unique_idx
  ON platform_narrative_decisions(round_id, actor_id)
  WHERE actor_id IS NOT NULL;
CREATE UNIQUE INDEX platform_narrative_decisions_action_unique_idx
  ON platform_narrative_decisions(round_id, action_id)
  WHERE action_id IS NOT NULL;
CREATE INDEX platform_narrative_decisions_order_idx
  ON platform_narrative_decisions(round_id, decision_order, superseded_at);
PRAGMA legacy_alter_table = OFF;
ALTER TABLE platform_actions ADD COLUMN actor_id TEXT REFERENCES platform_campaign_actors(id);

CREATE INDEX IF NOT EXISTS platform_combatants_actor_idx
  ON platform_combatants(campaign_id, actor_id, superseded_at);
CREATE INDEX IF NOT EXISTS platform_narrative_participants_actor_idx
  ON platform_narrative_round_participants(campaign_id, actor_id, superseded_at);
CREATE UNIQUE INDEX IF NOT EXISTS platform_narrative_decisions_active_campaign_actor_idx
  ON platform_narrative_decisions(round_id, campaign_actor_id)
  WHERE superseded_at IS NULL AND campaign_actor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS platform_actions_actor_idx
  ON platform_actions(campaign_id, actor_id, updated_at);

-- Deterministic backfill: each approved authoring Character gets one Actor,
-- one player binding and one runtime row. Legacy HP is read only here.
INSERT OR IGNORE INTO platform_campaign_actors
  (id, campaign_id, display_name, character_type, control_mode, mechanics_mode, character_id, created_at, updated_at)
SELECT 'actor:character:' || c.id, c.campaign_id, c.name, 'player_character', 'player', 'pc_build',
       c.id, c.created_at, c.updated_at
FROM platform_characters c
WHERE c.status = 'approved';

INSERT OR IGNORE INTO platform_actor_control_bindings
  (id, campaign_id, actor_id, user_id, binding_role, active, created_at, updated_at)
SELECT 'binding:character:' || c.id || ':user:' || c.player_id,
       c.campaign_id, 'actor:character:' || c.id, c.player_id, 'player', 1, c.created_at, c.updated_at
FROM platform_characters c
WHERE c.status = 'approved';

INSERT OR IGNORE INTO platform_character_runtime_states
  (campaign_id, actor_id, current_hp, temporary_hp, conditions_json, runtime_status, state_revision, updated_at)
SELECT c.campaign_id, 'actor:character:' || c.id,
       CASE
         WHEN json_valid(c.sheet_json) = 1
           AND json_type(c.sheet_json, '$.hpCurrent') IN ('integer','real')
           AND CAST(json_extract(c.sheet_json, '$.hpCurrent') AS INTEGER) >= 0
         THEN CAST(json_extract(c.sheet_json, '$.hpCurrent') AS INTEGER)
         ELSE 0
       END,
       0,
       '[]', 'active', 0, c.updated_at
FROM platform_characters c
WHERE c.status = 'approved';

-- Existing encounter-only NPCs receive a real userless Actor instead of
-- remaining actorless. The combatant instance id remains unchanged.
INSERT OR IGNORE INTO platform_campaign_actors
  (id, campaign_id, display_name, character_type, control_mode, mechanics_mode, character_id, created_at, updated_at)
SELECT 'actor:combatant:' || c.id, c.campaign_id, c.name, 'npc', 'ai', 'lightweight',
       NULL, c.created_at, c.updated_at
FROM platform_combatants c
WHERE c.character_id IS NULL;

INSERT OR IGNORE INTO platform_character_runtime_states
  (campaign_id, actor_id, current_hp, temporary_hp, conditions_json, runtime_status, state_revision, updated_at)
SELECT c.campaign_id, 'actor:combatant:' || c.id, c.hp_current, 0,
       CASE WHEN json_valid(c.conditions_json) = 1 THEN c.conditions_json ELSE '[]' END,
       'active', 0, c.updated_at
FROM platform_combatants c
WHERE c.character_id IS NULL;

UPDATE platform_combatants
SET actor_id = CASE
  WHEN character_id IS NOT NULL THEN 'actor:character:' || character_id
  ELSE 'actor:combatant:' || id
END
WHERE actor_id IS NULL;

UPDATE platform_narrative_round_participants
SET actor_id = 'actor:character:' || character_id
WHERE actor_id IS NULL AND character_id IS NOT NULL;

-- Only rows with an unambiguous authoring participant are backfilled. Other
-- historical decision actor_id values remain legacy user identities.
UPDATE platform_narrative_decisions
SET campaign_actor_id = (
  SELECT p.actor_id
  FROM platform_narrative_round_participants p
  WHERE p.round_id = platform_narrative_decisions.round_id
    AND p.player_id = platform_narrative_decisions.actor_id
    AND p.actor_id IS NOT NULL
  ORDER BY p.participant_order ASC
  LIMIT 1
)
WHERE campaign_actor_id IS NULL;

UPDATE platform_actions
SET actor_id = (
  SELECT d.campaign_actor_id
  FROM platform_narrative_decisions d
  WHERE d.action_id = platform_actions.id
    AND d.campaign_actor_id IS NOT NULL
  ORDER BY d.decision_order ASC
  LIMIT 1
)
WHERE actor_id IS NULL;
