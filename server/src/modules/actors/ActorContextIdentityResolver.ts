import type { QueryExecutor } from '../../platform/database/DatabasePort.js';
import { ActorRepository } from './ActorRepository.js';

/**
 * Explicit identity projection used by AI context and other actor-private
 * readers. It keeps the canonical Actor id separate from legacy submitter/user
 * ids instead of making each consumer infer the relationship independently.
 */
export interface ActorContextIdentity {
  actorId: string;
  controllerUserIds: string[];
  characterId: string | null;
  legacyPlayerId: string | null;
  /** True only when the caller supplied a legacy user/player identity. */
  isLegacy: boolean;
}

export class ActorContextIdentityResolver {
  constructor(private readonly executor: QueryExecutor) {}

  async resolveIn(
    executor: QueryExecutor,
    campaignId: string,
    requestedActorId: string,
  ): Promise<ActorContextIdentity> {
    const actors = new ActorRepository(executor);
    const actor = await actors.findById(requestedActorId);
    if (actor && actor.campaign_id === campaignId) {
      const bindings = (await actors.listBindings(campaignId, actor.id))
        .filter((binding) => binding.active === 1 && binding.user_id !== null);
      const controllerUserIds = [...new Set(bindings.map((binding) => binding.user_id as string))];
      let legacyPlayerId = controllerUserIds[0] ?? null;
      if (actor.character_id) {
        const characters = await executor.query<{ player_id: string }>(
          'SELECT player_id FROM platform_characters WHERE campaign_id = ? AND id = ?',
          [campaignId, actor.character_id],
        );
        legacyPlayerId = characters[0]?.player_id ?? legacyPlayerId;
      }
      return {
        actorId: actor.id,
        controllerUserIds,
        characterId: actor.character_id,
        legacyPlayerId,
        isLegacy: false,
      };
    }

    // Legacy compatibility: old callers passed user/player identity in the
    // actorId option before CampaignActor rows existed. Keep that path scoped
    // to the requested campaign and never treat a different campaign's Actor
    // row as a valid identity.
    const legacyCharacter = (await executor.query<{ id: string; player_id: string }>(
      `SELECT id, player_id FROM platform_characters
       WHERE campaign_id = ? AND player_id = ? AND status = 'approved'
       ORDER BY approved_at ASC, id ASC LIMIT 1`,
      [campaignId, requestedActorId],
    ))[0];
    return {
      actorId: requestedActorId,
      controllerUserIds: [requestedActorId],
      characterId: legacyCharacter?.id ?? null,
      legacyPlayerId: requestedActorId,
      isLegacy: true,
    };
  }

  async resolve(
    campaignId: string,
    requestedActorId?: string,
    executor: QueryExecutor = this.executor,
  ): Promise<ActorContextIdentity | null> {
    return requestedActorId ? this.resolveIn(executor, campaignId, requestedActorId) : null;
  }
}
