import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../../platform/database/SqliteDatabaseAdapter.js';
import { IdentityService } from '../identity/IdentityService.js';
import { CampaignService } from '../campaigns/CampaignService.js';
import { resolveCampaignContext } from '../campaigns/CampaignAccess.js';
import { CharacterService } from '../characters/CharacterService.js';
import { ActorRuntimeStateService } from './ActorRuntimeStateService.js';
import { ActorService } from './ActorService.js';
import { OutboxRepository } from '../../platform/events/OutboxRepository.js';
import { CampaignMutationCoordinator } from '../campaigns/CampaignMutationCoordinator.js';
import { NarrativeRoundService } from '../narrative-runtime/NarrativeRoundService.js';
import { TurnService } from '../turns/TurnService.js';

async function makeFixture() {
  const db = createSqliteDatabase(':memory:');
  await db.migrate();
  const identity = new IdentityService(db);
  const campaigns = new CampaignService(db);
  const owner = await identity.register({ login: 'actor-owner@test', password: 'correct-password' });
  const player = await identity.register({ login: 'actor-player@test', password: 'correct-password' });
  const created = await campaigns.create(owner.userId, { name: 'Actor test', ruleset: 'dnd5e' });
  await campaigns.join({ userId: player.userId }, created.campaign.id, created.inviteCode);
  const ownerCtx = await resolveCampaignContext(db, { userId: owner.userId }, created.campaign.id);
  const playerCtx = await resolveCampaignContext(db, { userId: player.userId }, created.campaign.id);
  return { db, campaigns, ownerCtx, playerCtx, characters: new CharacterService(db), actors: new ActorService(db), runtime: new ActorRuntimeStateService(db) };
}

type ActorFixture = Awaited<ReturnType<typeof makeFixture>>;

async function approveCharacter(fixture: ActorFixture, name: string) {
  const draft = await fixture.characters.createDraft(fixture.playerCtx, { name, sheet: { hpCurrent: 10, hpMax: 10, ac: 14 } });
  await fixture.characters.submitForReview(fixture.playerCtx, draft.id);
  await fixture.characters.approve(fixture.ownerCtx, draft.id);
  return draft.id;
}

describe('Actor and Character runtime vertical slice', () => {
  it('bootstraps multiple approved Characters without collapsing one user into one actor', async () => {
    const f = await makeFixture();
    try {
      const first = await approveCharacter(f, 'First');
      const second = await approveCharacter(f, 'Second');
      const controlled = await f.actors.listControlled(f.playerCtx);
      expect(controlled.map((actor) => actor.characterId)).toEqual(expect.arrayContaining([first, second]));
      expect(new Set(controlled.map((actor) => actor.id)).size).toBe(2);
    } finally {
      await f.db.close();
    }
  });

  it('keeps Narrative participants and action slots scoped to each controlled Actor', async () => {
    const f = await makeFixture();
    try {
      const firstCharacterId = await approveCharacter(f, 'First narrative actor');
      const secondCharacterId = await approveCharacter(f, 'Second narrative actor');
      const controlled = await f.actors.listControlled(f.playerCtx);
      const firstActor = controlled.find((actor) => actor.characterId === firstCharacterId)!;
      const secondActor = controlled.find((actor) => actor.characterId === secondCharacterId)!;
      const outbox = new OutboxRepository(f.db);
      const mutations = new CampaignMutationCoordinator(f.db);
      const narrative = new NarrativeRoundService(f.db, outbox, mutations, f.actors);
      const turns = new TurnService(f.db, outbox, mutations, narrative, f.actors);
      const turn = await turns.startTurn(f.ownerCtx);

      const initial = await narrative.getRequiredByTurn(f.playerCtx.campaignId, turn.id);
      expect(initial.participants.filter((participant) => participant.required).map((participant) => participant.actorId))
        .toEqual(expect.arrayContaining([firstActor.id, secondActor.id]));
      expect(initial.decisions.filter((decision) => decision.campaignActorId).map((decision) => decision.actorId))
        .toEqual(expect.arrayContaining([firstActor.id, secondActor.id]));
      await expect(turns.submitAction(f.playerCtx, turn.id, { body: 'ambiguous action' }))
        .rejects.toMatchObject({ code: 'STATE_CONFLICT' });

      await turns.submitAction(f.playerCtx, turn.id, { actorId: firstActor.id, body: 'First actor acts.' });
      const afterFirst = await narrative.getRequiredByTurn(f.playerCtx.campaignId, turn.id);
      expect(afterFirst.round.status).toBe('collecting');
      expect(afterFirst.decisions.find((decision) => decision.actorId === firstActor.id)?.actionId).toBeTruthy();
      expect(afterFirst.decisions.find((decision) => decision.actorId === secondActor.id)?.actionId).toBeNull();

      await turns.submitAction(f.playerCtx, turn.id, { actorId: secondActor.id, body: 'Second actor acts.' });
      const afterSecond = await narrative.getRequiredByTurn(f.playerCtx.campaignId, turn.id);
      expect(afterSecond.round.status).toBe('ready');
      const actions = await f.db.query<{ actor_id: string; body: string }>(
        'SELECT actor_id, body FROM platform_actions WHERE turn_id = ? AND superseded_at IS NULL ORDER BY body', [turn.id],
      );
      expect(actions).toEqual([
        { actor_id: firstActor.id, body: 'First actor acts.' },
        { actor_id: secondActor.id, body: 'Second actor acts.' },
      ]);
    } finally {
      await f.db.close();
    }
  });

  it('adds a userless NPC to a Narrative round without fabricating a user row', async () => {
    const f = await makeFixture();
    try {
      await approveCharacter(f, 'Narrative PC');
      const npc = await f.actors.createNpc(f.ownerCtx, { displayName: 'Elena', controlMode: 'ai', mechanicsMode: 'lightweight' });
      const outbox = new OutboxRepository(f.db);
      const mutations = new CampaignMutationCoordinator(f.db);
      const narrative = new NarrativeRoundService(f.db, outbox, mutations, f.actors);
      const turns = new TurnService(f.db, outbox, mutations, narrative, f.actors);
      const turn = await turns.startTurn(f.ownerCtx);
      const decision = await f.db.transaction((tx) => narrative.addActorParticipantIn(tx, f.ownerCtx.campaignId, turn.id, npc.id));
      expect(decision.actorId).toBe(npc.id);
      const participant = (await f.db.query<{ player_id: string | null; actor_id: string }>(
        'SELECT player_id, actor_id FROM platform_narrative_round_participants WHERE round_id = ? AND actor_id = ?', [turn.id, npc.id],
      ))[0];
      expect(participant).toEqual({ player_id: null, actor_id: npc.id });
    } finally {
      await f.db.close();
    }
  });

  it('creates a userless NPC and mutates runtime HP without changing the authoring sheet', async () => {
    const f = await makeFixture();
    try {
      const characterId = await approveCharacter(f, 'Authoring PC');
      const actor = (await f.actors.listControlled(f.playerCtx)).find((item) => item.characterId === characterId)!;
      const npc = await f.actors.createNpc(f.ownerCtx, {
        displayName: 'Userless NPC', controlMode: 'ai', mechanicsMode: 'lightweight', currentHp: 8,
      });
      const state = await f.runtime.apply(f.playerCtx.campaignId, actor.id, { kind: 'damage', amount: 3 }, 'runtime-test-damage');
      expect(state.state.currentHp).toBe(7);
      const replay = await f.runtime.apply(f.playerCtx.campaignId, actor.id, { kind: 'damage', amount: 3 }, 'runtime-test-damage');
      expect(replay.replayed).toBe(true);
      expect(replay.state.currentHp).toBe(7);
      const character = (await f.db.query<{ sheet_json: string }>('SELECT sheet_json FROM platform_characters WHERE id = ?', [characterId]))[0];
      expect(JSON.parse(character.sheet_json).hpCurrent).toBe(10);
      const binding = (await f.db.query<{ user_id: string | null }>('SELECT user_id FROM platform_actor_control_bindings WHERE actor_id = ?', [npc.id]))[0];
      expect(binding).toBeUndefined();
      const runtime = (await f.db.query<{ current_hp: number }>('SELECT current_hp FROM platform_character_runtime_states WHERE actor_id = ?', [npc.id]))[0];
      expect(runtime.current_hp).toBe(8);
    } finally {
      await f.db.close();
    }
  });
});
