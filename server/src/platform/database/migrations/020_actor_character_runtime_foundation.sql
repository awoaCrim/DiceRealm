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
ALTER TABLE platform_narrative_round_participants ADD COLUMN actor_id TEXT REFERENCES platform_campaign_actors(id);
ALTER TABLE platform_narrative_decisions ADD COLUMN campaign_actor_id TEXT REFERENCES platform_campaign_actors(id);
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
