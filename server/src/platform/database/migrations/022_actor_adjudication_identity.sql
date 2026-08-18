-- Phase 4 follow-up: persist canonical CampaignActor identity beside legacy audit ids.
-- Existing actor_id columns retain their historical user/player meaning; new
-- live Actor paths write campaign_actor_id without rewriting old audit semantics.

ALTER TABLE platform_action_intents
  ADD COLUMN campaign_actor_id TEXT REFERENCES platform_campaign_actors(id);

ALTER TABLE platform_roll_plans
  ADD COLUMN campaign_actor_id TEXT REFERENCES platform_campaign_actors(id);

CREATE INDEX platform_action_intents_campaign_actor_idx
  ON platform_action_intents(campaign_id, campaign_actor_id, created_at);

CREATE INDEX platform_roll_plans_campaign_actor_idx
  ON platform_roll_plans(campaign_id, campaign_actor_id, locked_at);

-- Deterministic backfill for rows whose action branch was already mapped to a
-- canonical Actor by migration 020. Rows without that unambiguous mapping stay
-- legacy-only and remain readable exactly as before.
UPDATE platform_action_intents
SET campaign_actor_id = (
  SELECT actor_id
  FROM platform_actions
  WHERE platform_actions.id = platform_action_intents.action_id
)
WHERE campaign_actor_id IS NULL
  AND action_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM platform_actions
    WHERE platform_actions.id = platform_action_intents.action_id
      AND platform_actions.actor_id IS NOT NULL
  );

UPDATE platform_roll_plans
SET campaign_actor_id = (
  SELECT campaign_actor_id
  FROM platform_action_intents
  WHERE platform_action_intents.id = platform_roll_plans.intent_id
)
WHERE campaign_actor_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM platform_action_intents
    WHERE platform_action_intents.id = platform_roll_plans.intent_id
      AND platform_action_intents.campaign_actor_id IS NOT NULL
  );
