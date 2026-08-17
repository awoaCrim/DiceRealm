import { describe, expect, it } from 'vitest';
import type { CampaignAuthContext } from '../campaigns/CampaignAccess.js';
import { resolveCampaignContext } from '../campaigns/CampaignAccess.js';
import { CampaignMutationCoordinator } from '../campaigns/CampaignMutationCoordinator.js';
import { ArchiveService } from '../archives/ArchiveService.js';
import { CampaignService } from '../campaigns/CampaignService.js';
import { CharacterService } from '../characters/CharacterService.js';
import { IdentityService } from '../identity/IdentityService.js';
import { createSqliteDatabase } from '../../platform/database/SqliteDatabaseAdapter.js';
import { OutboxRepository } from '../../platform/events/OutboxRepository.js';
import { TurnService } from '../turns/TurnService.js';
import { NarrativeRoundService } from './NarrativeRoundService.js';
import { RoundProjectionService } from './RoundProjectionService.js';
import { AiContextBuilder } from '../ai-runtime/AiContextBuilder.js';
import { NarrativeDecisionResolutionService } from './NarrativeDecisionResolutionService.js';

async function makeFixture() {
  const db = createSqliteDatabase(':memory:');
  await db.migrate();
  const identity = new IdentityService(db);
  const campaigns = new CampaignService(db);
  const characters = new CharacterService(db);
  const owner = await identity.register({ login: 'owner@narrative.test', password: 'correct-password' });
  const users = await Promise.all([
    identity.register({ login: 'a@narrative.test', password: 'correct-password' }),
    identity.register({ login: 'b@narrative.test', password: 'correct-password' }),
    identity.register({ login: 'c@narrative.test', password: 'correct-password' }),
  ]);
  const created = await campaigns.create(owner.userId, { name: '叙事测试', ruleset: 'dnd5e' });
  for (const user of users) await campaigns.join({ userId: user.userId }, created.campaign.id, created.inviteCode);
  const ownerCtx = await resolveCampaignContext(db, { userId: owner.userId }, created.campaign.id);
  const contexts = await Promise.all(users.map((user) => resolveCampaignContext(db, { userId: user.userId }, created.campaign.id)));
  for (const [index, context] of contexts.entries()) {
    const draft = await characters.createDraft(context, { name: `角色${index}`, sheet: { ac: 14, hpCurrent: 10, hpMax: 10 } });
    await characters.submitForReview(context, draft.id);
    await characters.approve(ownerCtx, draft.id);
  }
  const outbox = new OutboxRepository(db);
  const turns = new TurnService(db, outbox);
  const narrative = new NarrativeRoundService(db, outbox);
  return { db, ownerCtx, contexts, turns, narrative, mutations: new CampaignMutationCoordinator(db) };
}

async function resolveDecision(
  db: ReturnType<typeof createSqliteDatabase>,
  narrative: NarrativeRoundService,
  mutations: CampaignMutationCoordinator,
  campaignId: string,
  roundId: string,
  decisionId: string,
  fact: {
    factKind: string;
    payload: Record<string, unknown>;
    visibility: 'public' | 'player_private' | 'owner_only';
    audienceActorIds?: string[];
  },
) {
  const claim = await narrative.claimDecision(campaignId, roundId, decisionId, `exec-${decisionId}`);
  const decision = claim.decision;
  await db.transaction(async (tx) => {
    await mutations.mutateIn(tx, {
      campaignId: decision.campaignId,
      expectedRevision: claim.stateRevision,
      mutationId: `apply-${decisionId}`,
      causeType: 'test_decision_apply',
      causeId: decisionId,
    }, async ({ stateRevision }) => {
      await narrative.recordWorkingFactIn(tx, {
        campaignId: decision.campaignId,
        roundId,
        decisionId,
        actionId: decision.actionId,
        factKind: fact.factKind,
        payload: fact.payload,
        visibility: fact.visibility,
        audienceActorIds: fact.audienceActorIds,
        authority: 'runtime_state',
        validationStatus: 'authoritative',
        sourceKind: 'narrative_decision',
        provenance: {
          roundId,
          decisionId,
          actionId: decision.actionId,
          executionId: decision.executionId,
          outcomeId: null,
          eventId: null,
          basedOnStateRevision: claim.stateRevision,
          appliedStateRevision: stateRevision,
          sourceRefs: [`round:${roundId}`, `decision:${decisionId}`, `state-revision:${decision.campaignId}:${stateRevision}`],
        },
      });
      await narrative.markDecisionResolvedIn(tx, {
        campaignId: decision.campaignId,
        roundId,
        decisionId,
        stateRevision,
      });
    });
  });
  return decision;
}

describe('NarrativeRound runtime', () => {
  it('persists one round, participants and deterministic decisions, then projects WorkingFacts into the next round', async () => {
    const { db, ownerCtx, contexts, turns, narrative, mutations } = await makeFixture();
    try {
      const turn = await turns.startTurn(ownerCtx);
      await turns.submitAction(contexts[0], turn.id, { body: 'A 打开后门进入院子。' });
      await turns.submitAction(contexts[1], turn.id, { body: 'B 检查门边的痕迹。' });
      await turns.submitAction(contexts[2], turn.id, { body: 'C 私下观察暗门。' });
      const view = await narrative.getRequiredByTurn(turn.campaignId, turn.id);
      expect(view.round.status).toBe('ready');
      expect(view.participants).toHaveLength(3);
      expect(view.decisions.map((decision) => decision.actionId)).toEqual(
        expect.arrayContaining(view.participants.map((participant) => expect.any(String))),
      );
      expect(view.decisions.map((decision) => decision.decisionOrder)).toEqual([0, 1, 2]);

      const [aDecision, bDecision, cDecision] = view.decisions;
      await resolveDecision(db, narrative, mutations, turn.campaignId, turn.id, aDecision.id, {
        factKind: 'door.open', payload: { targetId: 'door', state: 'open' }, visibility: 'public',
      });
      const bWorking = await new RoundProjectionService(db).projectWorkingFacts(turn.id, 'actor_private', contexts[1].playerId as string);
      expect(bWorking.map((fact) => fact.factKind)).toContain('door.open');
      expect(JSON.stringify(bWorking)).not.toContain('A 打开后门进入院子');
      const bDecisionContext = await new AiContextBuilder(db).buildForTurn(turn.campaignId, turn.id, db, {
        audience: 'actor_private', actorId: contexts[1].playerId as string,
        roundId: turn.id, decisionId: bDecision.id, stage: 'decision_interpretation',
      });
      const bPrompt = bDecisionContext.prompt.messages.map((message) => message.content).join('\\n');
      expect(bPrompt).toContain('door.open');
      expect(bPrompt).not.toContain('A 打开后门进入院子');
      expect(bPrompt).not.toContain('C 私下观察暗门');

      await resolveDecision(db, narrative, mutations, turn.campaignId, turn.id, bDecision.id, {
        factKind: 'evidence.found', payload: { targetId: 'door' }, visibility: 'public',
      });
      await resolveDecision(db, narrative, mutations, turn.campaignId, turn.id, cDecision.id, {
        factKind: 'secret_fact', payload: { text: 'C 发现暗门后的密室。' }, visibility: 'player_private',
        audienceActorIds: [contexts[2].playerId as string],
      });

      const closed = await narrative.closeRound(turn.campaignId, turn.id);
      expect(closed.factSet.facts.map((fact) => fact.factKind)).toEqual(expect.arrayContaining([
        'door.open', 'evidence.found', 'secret_fact',
      ]));
      expect(closed.factSet.facts).toHaveLength(3);
      expect(closed.nextTurnId).toBeTruthy();

      const projectionA = await narrative.projectRoundFacts(turn.id, 'actor_private', contexts[0].playerId as string);
      const projectionB = await narrative.projectRoundFacts(turn.id, 'actor_private', contexts[1].playerId as string);
      const projectionC = await narrative.projectRoundFacts(turn.id, 'actor_private', contexts[2].playerId as string);
      expect(projectionA?.facts.map((fact) => fact.factKind)).not.toContain('secret_fact');
      expect(projectionB?.facts.map((fact) => fact.factKind)).not.toContain('secret_fact');
      expect(projectionC?.facts.map((fact) => fact.factKind)).toContain('secret_fact');
      expect(projectionC?.facts.every((fact) => fact.provenance.sourceRefs.length > 0)).toBe(true);

      const replay = await narrative.closeRound(turn.campaignId, turn.id);
      expect(replay.replayed).toBe(true);
      expect(replay.factSet.id).toBe(closed.factSet.id);
      expect(replay.stateRevision).toBe(closed.stateRevision);
      expect((await db.query('SELECT id FROM platform_narrative_round_fact_sets WHERE round_id = ?', [turn.id]))).toHaveLength(1);

      const nextTurn = (await db.query<{ id: string; number: number }>(
        'SELECT id, number FROM platform_turns WHERE id = ?', [closed.nextTurnId],
      ))[0];
      const nextProjection = await narrative.getProjectionForNextRound(
        turn.campaignId, nextTurn.number, 'actor_private', contexts[2].playerId as string,
      );
      expect(nextProjection?.facts.map((fact) => fact.factKind)).toContain('secret_fact');
      const nextContextC = await new AiContextBuilder(db).buildForTurn(turn.campaignId, nextTurn.id, db, {
        audience: 'actor_private', actorId: contexts[2].playerId as string,
      });
      const nextContextA = await new AiContextBuilder(db).buildForTurn(turn.campaignId, nextTurn.id, db, {
        audience: 'actor_private', actorId: contexts[0].playerId as string,
      });
      expect(JSON.stringify(nextContextC.context.previousRoundSummary)).toContain('secret_fact');
      expect(JSON.stringify(nextContextA.context.previousRoundSummary)).not.toContain('secret_fact');
      expect(nextContextC.blocks.find((block) => block.type === 'previous_round_summary')?.sourceRefs.length).toBeGreaterThan(0);
    } finally {
      await db.close();
    }
  });

  it('resolves exactly one Decision through Provider intent, server mechanics and WorkingFacts', async () => {
    const { db, ownerCtx, contexts, turns, narrative } = await makeFixture();
    try {
      const turn = await turns.startTurn(ownerCtx);
      await turns.submitAction(contexts[0], turn.id, { body: 'A 恢复体力。' });
      await turns.submitAction(contexts[1], turn.id, { body: 'B 守望。' });
      await turns.submitAction(contexts[2], turn.id, { body: 'C 观察。' });
      const view = await narrative.getRequiredByTurn(turn.campaignId, turn.id);
      const decision = view.decisions.find((item) => item.actorId === contexts[0].playerId);
      if (!decision || !decision.actionId) throw new Error('expected A decision');
      const provider = {
        name: 'scripted',
        model: 'narrative-test',
        stream: async () => ({
          actionIntents: [{
            actionId: decision.actionId,
            actorId: decision.actorId,
            mode: 'player_action',
            actionType: 'healing',
            actionRef: 'healing:basic',
            targetIds: [],
            declaredApproach: '恢复体力',
            desiredOutcome: '恢复一点生命',
            resourceChoices: [],
            fallbackPolicy: 'continue',
          }],
        }),
      } as const;
      const outbox = new OutboxRepository(db);
      const service = new NarrativeDecisionResolutionService(db, provider, outbox);
      const first = await service.resolveDecision(ownerCtx, turn.id, decision.id, { idempotencyKey: 'decision-one' });
      expect(first.created).toBe(true);
      expect(first.run.status).toBe('succeeded');
      const second = await service.resolveDecision(ownerCtx, turn.id, decision.id, { idempotencyKey: 'decision-one' });
      expect(second.created).toBe(false);
      expect(second.run.id).toBe(first.run.id);
      expect(await db.query('SELECT id FROM platform_roll_records WHERE execution_id = ?', [first.run.id])).toHaveLength(1);
      const updated = await narrative.getRequiredByTurn(turn.campaignId, turn.id);
      expect(updated.decisions.find((item) => item.id === decision.id)?.status).toBe('resolved');
      expect(updated.decisions.filter((item) => item.status === 'submitted')).toHaveLength(2);
      expect(updated.workingFacts.length).toBeGreaterThan(0);
      expect(JSON.stringify(updated.workingFacts)).not.toContain('A 恢复体力');
    } finally {
      await db.close();
    }
  });

  it('rejects AI candidates from becoming authoritative facts', async () => {
    const { db, ownerCtx, contexts, turns, narrative } = await makeFixture();
    try {
      const turn = await turns.startTurn(ownerCtx);
      await turns.submitAction(contexts[0], turn.id, { body: 'A' });
      await turns.submitAction(contexts[1], turn.id, { body: 'B' });
      await turns.submitAction(contexts[2], turn.id, { body: 'C' });
      await expect(db.transaction((tx) => narrative.recordWorkingFactIn(tx, {
        campaignId: turn.campaignId,
        roundId: turn.id,
        factKind: 'npc.afraid',
        payload: { value: true },
        visibility: 'public',
        authority: 'ai_candidate',
        validationStatus: 'authoritative',
        sourceKind: 'narration_result',
        provenance: {
          roundId: turn.id, decisionId: null, actionId: null, executionId: null,
          outcomeId: null, eventId: null, basedOnStateRevision: 0,
          appliedStateRevision: null, sourceRefs: [`round:${turn.id}`],
        },
      }))).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
      expect(await db.query('SELECT id FROM platform_narrative_working_facts WHERE round_id = ?', [turn.id])).toHaveLength(0);
    } finally {
      await db.close();
    }
  });

  it('restores the captured same-round fact boundary instead of retaining later WorkingFacts', async () => {
    const { db, ownerCtx, contexts, turns, narrative } = await makeFixture();
    try {
      const turn = await turns.startTurn(ownerCtx);
      await turns.submitAction(contexts[0], turn.id, { body: 'A' });
      await turns.submitAction(contexts[1], turn.id, { body: 'B' });
      await turns.submitAction(contexts[2], turn.id, { body: 'C' });
      const archives = new ArchiveService(db, new OutboxRepository(db));
      const checkpoint = await archives.createManual(ownerCtx, 'before-fact');
      await db.transaction((tx) => narrative.recordWorkingFactIn(tx, {
        campaignId: turn.campaignId,
        roundId: turn.id,
        factKind: 'later.same-round.fact',
        payload: { branch: 'after-checkpoint' },
        visibility: 'public',
        authority: 'runtime_state',
        validationStatus: 'authoritative',
        sourceKind: 'state_transaction',
        provenance: {
          roundId: turn.id, decisionId: null, actionId: null, executionId: null,
          outcomeId: null, eventId: null, basedOnStateRevision: 0,
          appliedStateRevision: null, sourceRefs: [`round:${turn.id}`],
        },
      }));
      await archives.restore(ownerCtx, checkpoint.id);
      expect(await new RoundProjectionService(db).projectWorkingFacts(turn.id, 'party')).toEqual([]);
      const superseded = await db.query<{ superseded_at: string | null }>(
        'SELECT superseded_at FROM platform_narrative_working_facts WHERE round_id = ?', [turn.id],
      );
      expect(superseded[0].superseded_at).not.toBeNull();
    } finally {
      await db.close();
    }
  });

  it('supersedes later round facts during archive restore so they cannot enter active projection', async () => {
    const { db, ownerCtx, contexts, turns, narrative } = await makeFixture();
    try {
      const first = await turns.startTurn(ownerCtx);
      await turns.submitAction(contexts[0], first.id, { body: 'A' });
      await turns.submitAction(contexts[1], first.id, { body: 'B' });
      await turns.submitAction(contexts[2], first.id, { body: 'C' });
      const firstView = await narrative.getRequiredByTurn(first.campaignId, first.id);
      for (const decision of firstView.decisions) await narrative.skipDecision(first.campaignId, first.id, decision.id);
      const closed = await narrative.closeRound(first.campaignId, first.id);
      const second = (await db.query<{ id: string; number: number }>(
        'SELECT id, number FROM platform_turns WHERE id = ?', [closed.nextTurnId],
      ))[0];
      const archives = new ArchiveService(db, new OutboxRepository(db));
      const checkpoint = await archives.createManual(ownerCtx, 'round-2-checkpoint');
      await db.execute("UPDATE platform_turns SET status = 'completed', completed_at = ? WHERE id = ?", [new Date().toISOString(), second.id]);
      const third = await turns.startTurn(ownerCtx);
      await turns.submitAction(contexts[0], third.id, { body: 'A3' });
      await turns.submitAction(contexts[1], third.id, { body: 'B3' });
      await turns.submitAction(contexts[2], third.id, { body: 'C3' });
      await db.transaction((tx) => narrative.recordWorkingFactIn(tx, {
        campaignId: first.campaignId,
        roundId: third.id,
        factKind: 'later.branch.fact',
        payload: { branch: 'later' },
        visibility: 'public',
        authority: 'runtime_state',
        validationStatus: 'authoritative',
        sourceKind: 'state_transaction',
        provenance: {
          roundId: third.id, decisionId: null, actionId: null, executionId: null,
          outcomeId: null, eventId: null, basedOnStateRevision: 0,
          appliedStateRevision: null, sourceRefs: [`round:${third.id}`],
        },
      }));
      await archives.restore(ownerCtx, checkpoint.id);
      const row = (await db.query<{ superseded_at: string | null }>(
        'SELECT superseded_at FROM platform_narrative_rounds WHERE id = ?', [third.id],
      ))[0];
      expect(row.superseded_at).not.toBeNull();
      const facts = await db.query<{ superseded_at: string | null }>(
        'SELECT superseded_at FROM platform_narrative_working_facts WHERE round_id = ?', [third.id],
      );
      expect(facts[0].superseded_at).not.toBeNull();
      expect(await new RoundProjectionService(db).projectWorkingFacts(third.id, 'party')).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it('rolls back a failed Decision transaction without erasing an earlier committed fact', async () => {
    const { db, ownerCtx, contexts, turns, narrative, mutations } = await makeFixture();
    try {
      const turn = await turns.startTurn(ownerCtx);
      await turns.submitAction(contexts[0], turn.id, { body: 'A' });
      await turns.submitAction(contexts[1], turn.id, { body: 'B' });
      await turns.submitAction(contexts[2], turn.id, { body: 'C' });
      const view = await narrative.getRequiredByTurn(turn.campaignId, turn.id);
      await resolveDecision(db, narrative, mutations, turn.campaignId, turn.id, view.decisions[0].id, {
        factKind: 'door.open', payload: { state: 'open' }, visibility: 'public',
      });
      const secondClaim = await narrative.claimDecision(turn.campaignId, turn.id, view.decisions[1].id, 'second-exec');
      await expect(db.transaction(async (tx) => mutations.mutateIn(tx, {
        campaignId: turn.campaignId,
        expectedRevision: secondClaim.stateRevision,
        mutationId: 'second-failing-apply',
        causeType: 'test_decision_apply',
        causeId: view.decisions[1].id,
      }, async ({ stateRevision }) => {
        await narrative.recordWorkingFactIn(tx, {
          campaignId: turn.campaignId,
          roundId: turn.id,
          decisionId: view.decisions[1].id,
          actionId: view.decisions[1].actionId,
          factKind: 'must.rollback',
          payload: { value: true },
          visibility: 'public',
          authority: 'runtime_state',
          validationStatus: 'authoritative',
          sourceKind: 'state_transaction',
          provenance: {
            roundId: turn.id, decisionId: view.decisions[1].id, actionId: view.decisions[1].actionId,
            executionId: secondClaim.decision.executionId, outcomeId: null, eventId: null,
            basedOnStateRevision: secondClaim.stateRevision, appliedStateRevision: stateRevision,
            sourceRefs: [`round:${turn.id}`, `decision:${view.decisions[1].id}`],
          },
        });
        throw new Error('rollback');
      }))).rejects.toThrow('rollback');
      expect((await db.query<{ fact_kind: string }>(
        'SELECT fact_kind FROM platform_narrative_working_facts WHERE round_id = ? AND superseded_at IS NULL ORDER BY created_at', [turn.id],
      )).map((row) => row.fact_kind)).toEqual(['door.open']);
    } finally {
      await db.close();
    }
  });
});
