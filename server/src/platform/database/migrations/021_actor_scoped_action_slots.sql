-- Phase 4 follow-up: make new live action slots actor-scoped.
-- Migration 020 adds platform_actions.actor_id, while 019 owns the branch
-- superseded columns and the legacy player-scoped active index. Keep the old
-- index for actorless historical/compatibility rows and add a live Actor slot.

DROP INDEX IF EXISTS platform_actions_active_player_idx;

CREATE UNIQUE INDEX platform_actions_active_player_idx
  ON platform_actions(turn_id, player_id)
  WHERE superseded_at IS NULL AND actor_id IS NULL;

CREATE UNIQUE INDEX platform_actions_active_actor_idx
  ON platform_actions(turn_id, actor_id)
  WHERE superseded_at IS NULL AND actor_id IS NOT NULL;
