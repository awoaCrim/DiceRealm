import { describe, expect, it, vi } from 'vitest';
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
import {
  NARRATIVE_DECISION_CLAIM_EXPIRED_CODE,
  NARRATIVE_DECISION_CLAIM_LEASE_MS,
  NarrativeRoundService,
} from './NarrativeRoundService.js';
import { RoundProjectionService } from './RoundProjectionService.js';
import { AiContextBuilder } from '../ai-runtime/AiContextBuilder.js';
import { NarrativeDecisionResolutionService } from './NarrativeDecisionResolutionService.js';
import { NarrativeClaimLeaseSweeper } from './NarrativeClaimLeaseSweeper.js';
import { NarrativeWorkCoordinator } from './NarrativeWorkCoordinator.js';
import { NARRATIVE_WORK_CONSUMER_NAME, NarrativeWorkRuntime } from './NarrativeWorkRuntime.js';

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

  it('consumes work_available through the background resolver without an Owner resolve call', async () => {
    const { db, ownerCtx, contexts, turns, narrative } = await makeFixture();
    let providerCalls = 0;
    let actionId = '';
    let actorId = '';
    let runtime: NarrativeWorkRuntime | undefined;
    try {
      const turn = await turns.startTurn(ownerCtx);
      await turns.submitAction(contexts[0], turn.id, { body: 'A 恢复体力。' });
      const submitted = await narrative.getRequiredByTurn(turn.campaignId, turn.id);
      const decision = submitted.decisions.find((item) => item.actorId === contexts[0].playerId);
      if (!decision?.actionId) throw new Error('expected A decision');
      actionId = decision.actionId;
      actorId = decision.actorId;

      const provider = {
        name: 'background-scripted',
        model: 'background-test',
        stream: async () => {
          providerCalls += 1;
          return {
            actionIntents: [{
              actionId, actorId, mode: 'player_action', actionType: 'healing', actionRef: 'healing:basic',
              targetIds: [], declaredApproach: '恢复体力', desiredOutcome: '恢复一点生命',
              resourceChoices: [], fallbackPolicy: 'continue',
            }],
          };
        },
      } as const;
      const outbox = new OutboxRepository(db);
      const resolver = new NarrativeDecisionResolutionService(db, provider, outbox);
      runtime = new NarrativeWorkRuntime(
        db,
        new NarrativeWorkCoordinator(db, outbox),
        resolver,
        5,
      );
      runtime.start();

      await vi.waitFor(async () => {
        const current = await narrative.getRequiredByTurn(turn.campaignId, turn.id);
        expect(current.decisions.find((item) => item.id === decision.id)?.status).toBe('resolved');
      });

      expect(providerCalls).toBe(1);
      const runs = await db.query<{ status: string; id: string }>(
        'SELECT id, status FROM platform_ai_runs WHERE turn_id = ?', [turn.id],
      );
      expect(runs).toHaveLength(1);
      expect(runs[0].status).toBe('succeeded');
      expect(await db.query('SELECT id FROM platform_resolved_outcomes WHERE execution_id = ?', [runs[0].id])).toHaveLength(1);
      expect(await db.query('SELECT id FROM platform_narrative_working_facts WHERE decision_id = ?', [decision.id])).not.toHaveLength(0);

      const after = await narrative.getRequiredByTurn(turn.campaignId, turn.id);
      expect(after.decisions.find((item) => item.actorId === contexts[1].playerId)?.status).toBe('waiting');
      expect(after.decisions.find((item) => item.actorId === contexts[2].playerId)?.status).toBe('waiting');

      // A restarted runtime sees only signals without a durable consumer receipt;
      // the already handled wake-ups are not replayed.
      await runtime.stop();
      const restarted = new NarrativeWorkRuntime(
        db,
        new NarrativeWorkCoordinator(db, outbox),
        resolver,
        5,
      );
      await restarted.runOnce();
      await restarted.stop();
      expect(providerCalls).toBe(1);
    } finally {
      await runtime?.stop();
      await db.close();
    }
  });

  it('re-wakes a submitted Decision after restoring an archive whose original wake-up was consumed', async () => {
    const { db, ownerCtx, contexts, turns, narrative } = await makeFixture();
    const outbox = new OutboxRepository(db);
    const workEventType = 'narrative.round.work_available';
    let providerCalls = 0;
    let actionId = '';
    let actorId = '';
    let runtime: NarrativeWorkRuntime | undefined;
    try {
      const turn = await turns.startTurn(ownerCtx);
      await turns.submitAction(contexts[0], turn.id, { body: 'A 在存档前提交行动。' });
      const submitted = await narrative.getRequiredByTurn(turn.campaignId, turn.id);
      const decision = submitted.decisions.find((item) => item.actorId === contexts[0].playerId);
      if (!decision?.actionId) throw new Error('expected A decision');
      actionId = decision.actionId;
      actorId = decision.actorId;

      const archives = new ArchiveService(db, outbox);
      const checkpoint = await archives.createManual(ownerCtx, 'A submitted checkpoint');
      const workRows = await db.query<{ id: string; payload_json: string }>(
        'SELECT id, payload_json FROM platform_outbox_events WHERE campaign_id = ? AND event_type = ? ORDER BY sequence',
        [turn.campaignId, workEventType],
      );
      const originalWork = workRows.find((row) => JSON.parse(row.payload_json).roundId === turn.id);
      if (!originalWork) throw new Error('expected original work_available event');

      const provider = {
        name: 'restore-rewake-scripted',
        model: 'restore-rewake-test',
        stream: async () => {
          providerCalls += 1;
          return {
            actionIntents: [{
              actionId, actorId, mode: 'player_action', actionType: 'healing', actionRef: 'healing:basic',
              targetIds: [], declaredApproach: '恢复体力', desiredOutcome: '恢复一点生命',
              resourceChoices: [], fallbackPolicy: 'continue',
            }],
          };
        },
      } as const;
      const resolver = new NarrativeDecisionResolutionService(db, provider, outbox);
      runtime = new NarrativeWorkRuntime(
        db,
        new NarrativeWorkCoordinator(db, outbox),
        resolver,
        5,
      );

      await runtime.runOnce();
      expect(providerCalls).toBe(1);
      expect(await db.query(
        'SELECT event_id FROM platform_outbox_consumer_receipts WHERE consumer_name = ? AND event_id = ?',
        [NARRATIVE_WORK_CONSUMER_NAME, originalWork.id],
      )).toHaveLength(1);
      expect((await narrative.getRequiredByTurn(turn.campaignId, turn.id)).decisions
        .find((item) => item.id === decision.id)?.status).toBe('resolved');

      // Advance the round to a completed state so restore is legal, while leaving
      // the original archive's submitted A state as the branch to rewind to.
      const later = await narrative.getRequiredByTurn(turn.campaignId, turn.id);
      const bDecision = later.decisions.find((item) => item.actorId === contexts[1].playerId);
      const cDecision = later.decisions.find((item) => item.actorId === contexts[2].playerId);
      if (!bDecision || !cDecision) throw new Error('expected B and C decisions');
      await turns.submitAction(contexts[1], turn.id, { body: 'B 在 A 之后提交行动。' });
      await narrative.skipDecision(turn.campaignId, turn.id, bDecision.id);
      await turns.submitAction(contexts[2], turn.id, { body: 'C 在 A 之后提交行动。' });
      await narrative.skipDecision(turn.campaignId, turn.id, cDecision.id);
      await narrative.closeRound(turn.campaignId, turn.id);

      const restored = await archives.restore(ownerCtx, checkpoint.id);
      expect(restored.restoredTurnId).toBe(turn.id);
      const restoredView = await narrative.getRequiredByTurn(turn.campaignId, turn.id);
      expect(restoredView.decisions.find((item) => item.id === decision.id)?.status).toBe('submitted');

      const pending = await outbox.listPendingByConsumer(
        workEventType,
        NARRATIVE_WORK_CONSUMER_NAME,
      );
      expect(pending).toHaveLength(1);
      const restoredWork = pending[0];
      expect(restoredWork.id).not.toBe(originalWork.id);
      expect(JSON.parse(restoredWork.payload_json)).toMatchObject({
        type: workEventType, campaignId: turn.campaignId, roundId: turn.id, decisionId: decision.id,
      });
      expect(await db.query(
        'SELECT event_id FROM platform_outbox_consumer_receipts WHERE consumer_name = ? AND event_id = ?',
        [NARRATIVE_WORK_CONSUMER_NAME, originalWork.id],
      )).toHaveLength(1);
      expect(await db.query(
        'SELECT event_id FROM platform_outbox_consumer_receipts WHERE consumer_name = ? AND event_id = ?',
        [NARRATIVE_WORK_CONSUMER_NAME, restoredWork.id],
      )).toHaveLength(0);

      await runtime.runOnce();
      expect(providerCalls).toBe(2);
      expect((await narrative.getRequiredByTurn(turn.campaignId, turn.id)).decisions
        .find((item) => item.id === decision.id)?.status).toBe('resolved');
      expect(await db.query(
        'SELECT event_id FROM platform_outbox_consumer_receipts WHERE consumer_name = ? AND event_id = ?',
        [NARRATIVE_WORK_CONSUMER_NAME, originalWork.id],
      )).toHaveLength(1);
      expect(await db.query(
        'SELECT event_id FROM platform_outbox_consumer_receipts WHERE consumer_name = ? AND event_id = ?',
        [NARRATIVE_WORK_CONSUMER_NAME, restoredWork.id],
      )).toHaveLength(1);
    } finally {
      await runtime?.stop();
      await db.close();
    }
  });

  it('isolates referenced later Actions across restore and wakes a participant that resubmits', async () => {
    const { db, ownerCtx, contexts, turns, narrative } = await makeFixture();
    const outbox = new OutboxRepository(db);
    const workEventType = 'narrative.round.work_available';
    let providerCalls = 0;
    let currentActionId = '';
    let currentActorId = '';
    let b1ActionId = '';
    let runtime: NarrativeWorkRuntime | undefined;
    try {
      const turn = await turns.startTurn(ownerCtx);
      await turns.submitAction(contexts[0], turn.id, { body: 'A 在 checkpoint 前提交。' });
      const initial = await narrative.getRequiredByTurn(turn.campaignId, turn.id);
      const aDecision = initial.decisions.find((item) => item.actorId === contexts[0].playerId);
      if (!aDecision?.actionId) throw new Error('expected A decision');
      currentActionId = aDecision.actionId;
      currentActorId = aDecision.actorId;

      const archives = new ArchiveService(db, outbox);
      const checkpoint = await archives.createManual(ownerCtx, 'A submitted, B waiting');
      const provider = {
        name: 'action-branch-scripted',
        model: 'action-branch-test',
        stream: async () => {
          providerCalls += 1;
          return {
            actionIntents: [{
              actionId: currentActionId, actorId: currentActorId, mode: 'player_action', actionType: 'healing',
              actionRef: 'healing:basic', targetIds: [], declaredApproach: '恢复体力', desiredOutcome: '恢复一点生命',
              resourceChoices: [], fallbackPolicy: 'continue',
            }],
          };
        },
      } as const;
      const resolver = new NarrativeDecisionResolutionService(db, provider, outbox);
      runtime = new NarrativeWorkRuntime(
        db,
        new NarrativeWorkCoordinator(db, outbox),
        resolver,
        5,
      );

      await runtime.runOnce();
      expect(providerCalls).toBe(1);
      await runtime.runOnce(); // consume A's post-resolution wake before B submits.

      await turns.submitAction(contexts[1], turn.id, { body: 'B1 在 checkpoint 之后提交。' });
      const b1View = await narrative.getRequiredByTurn(turn.campaignId, turn.id);
      const bDecision = b1View.decisions.find((item) => item.actorId === contexts[1].playerId);
      if (!bDecision?.actionId) throw new Error('expected B1 decision');
      b1ActionId = bDecision.actionId;
      currentActionId = bDecision.actionId;
      currentActorId = bDecision.actorId;
      await runtime.runOnce();
      expect(providerCalls).toBe(2);
      expect(await db.query(
        'SELECT id FROM platform_action_intents WHERE action_id = ?', [b1ActionId],
      )).toHaveLength(1);
      await runtime.runOnce(); // consume B's post-resolution wake before closing the branch.

      const cDecision = b1View.decisions.find((item) => item.actorId === contexts[2].playerId);
      if (!cDecision) throw new Error('expected C decision');
      await turns.submitAction(contexts[2], turn.id, { body: 'C 在后分支提交。' });
      await narrative.skipDecision(turn.campaignId, turn.id, cDecision.id);
      await narrative.closeRound(turn.campaignId, turn.id);

      await archives.restore(ownerCtx, checkpoint.id);
      const restored = await narrative.getRequiredByTurn(turn.campaignId, turn.id);
      const restoredB = restored.decisions.find((item) => item.actorId === contexts[1].playerId);
      expect(restoredB?.status).toBe('waiting');
      expect(restoredB?.actionId).toBeNull();
      const requirements = await db.query<{ submitted: number }>(
        'SELECT submitted FROM platform_turn_requirements WHERE turn_id = ? AND player_id = ?',
        [turn.id, contexts[1].playerId],
      );
      expect(requirements[0].submitted).toBe(0);

      const ownerView = await turns.getView(ownerCtx, turn.id);
      if (!('actions' in ownerView)) throw new Error('expected owner view');
      expect(ownerView.actions.map((action) => action.playerId)).not.toContain(contexts[1].playerId);
      const bPlayerView = await turns.getView(contexts[1], turn.id);
      if (!('myAction' in bPlayerView)) throw new Error('expected player view');
      expect(bPlayerView.myAction).toBeNull();
      const b1Row = (await db.query<{ superseded_at: string | null }>(
        'SELECT superseded_at FROM platform_actions WHERE id = ?', [b1ActionId],
      ))[0];
      expect(b1Row.superseded_at).not.toBeNull();

      // The restored checkpoint still has A submitted. Consume that restored
      // wake before B submits, so B2's wake is isolated to this resubmission.
      currentActionId = aDecision.actionId;
      currentActorId = aDecision.actorId;
      await runtime.runOnce();
      expect(providerCalls).toBe(3);
      expect((await narrative.getRequiredByTurn(turn.campaignId, turn.id)).decisions
        .find((item) => item.actorId === contexts[0].playerId)?.status).toBe('resolved');
      await runtime.runOnce(); // consume A's post-resolution wake before B2 submits.

      await turns.submitAction(contexts[1], turn.id, { body: 'B2 在 restore 后重新提交。' });
      const b2Rows = await db.query<{ id: string; body: string; superseded_at: string | null }>(
        'SELECT id, body, superseded_at FROM platform_actions WHERE turn_id = ? AND player_id = ? AND superseded_at IS NULL',
        [turn.id, contexts[1].playerId],
      );
      expect(b2Rows).toHaveLength(1);
      expect(b2Rows[0].id).not.toBe(b1ActionId);
      expect(b2Rows[0].body).toBe('B2 在 restore 后重新提交。');
      currentActionId = b2Rows[0].id;
      const b2Decision = (await narrative.getRequiredByTurn(turn.campaignId, turn.id)).decisions
        .find((item) => item.actorId === contexts[1].playerId);
      if (!b2Decision) throw new Error('expected B2 decision');
      currentActorId = b2Decision.actorId;
      const afterB2Submit = await outbox.listPendingByConsumer(workEventType, NARRATIVE_WORK_CONSUMER_NAME);
      expect(afterB2Submit).toHaveLength(1);
      expect(JSON.parse(afterB2Submit[0].payload_json)).toMatchObject({
        type: workEventType, roundId: turn.id, decisionId: restoredB?.id,
      });

      await runtime.runOnce();
      expect(providerCalls).toBe(4);
      const afterB2 = await narrative.getRequiredByTurn(turn.campaignId, turn.id);
      expect(afterB2.decisions.find((item) => item.actorId === contexts[1].playerId)?.status).toBe('resolved');
      expect((await db.query<{ superseded_at: string | null }>(
        'SELECT superseded_at FROM platform_actions WHERE id = ?', [b1ActionId],
      ))[0].superseded_at).not.toBeNull();
      expect((await db.query<{ superseded_at: string | null }>(
        'SELECT superseded_at FROM platform_actions WHERE id = ?', [b2Rows[0].id],
      ))[0].superseded_at).toBeNull();
    } finally {
      await runtime?.stop();
      await db.close();
    }
  });

  it('advances durable work receipts past a full batch and after restart', async () => {
    const { db, ownerCtx, contexts, turns, narrative } = await makeFixture();
    const workEventType = 'narrative.round.work_available';
    const historicalCreatedAt = '2000-01-01T00:00:00.000Z';
    const outbox = new OutboxRepository(db);
    let providerCalls = 0;
    let actionId = '';
    let actorId = '';
    let runtime: NarrativeWorkRuntime | undefined;
    let restarted: NarrativeWorkRuntime | undefined;
    try {
      await db.transaction(async (tx) => {
        for (let index = 0; index < 201; index += 1) {
          await outbox.publishIn(tx, {
            type: workEventType,
            campaignId: ownerCtx.campaignId,
            roundId: `historical-round-${index}`,
            decisionId: `historical-decision-${index}`,
          });
        }
        await tx.execute(
          'UPDATE platform_outbox_events SET created_at = ? WHERE campaign_id = ? AND event_type = ?',
          [historicalCreatedAt, ownerCtx.campaignId, workEventType],
        );
      });

      const countHistoricalReceipts = async (): Promise<number> => {
        const rows = await db.query<{ count: number }>(
          `SELECT COUNT(*) AS count
           FROM platform_outbox_consumer_receipts r
           JOIN platform_outbox_events e ON e.id = r.event_id
           WHERE r.consumer_name = ? AND e.event_type = ? AND e.created_at = ?`,
          [NARRATIVE_WORK_CONSUMER_NAME, workEventType, historicalCreatedAt],
        );
        return Number(rows[0].count);
      };

      const provider = {
        name: 'durable-receipt-scripted',
        model: 'durable-receipt-test',
        stream: async () => {
          providerCalls += 1;
          return {
            actionIntents: [{
              actionId, actorId, mode: 'player_action', actionType: 'healing', actionRef: 'healing:basic',
              targetIds: [], declaredApproach: '恢复体力', desiredOutcome: '恢复一点生命',
              resourceChoices: [], fallbackPolicy: 'continue',
            }],
          };
        },
      } as const;
      const resolver = new NarrativeDecisionResolutionService(db, provider, outbox);
      runtime = new NarrativeWorkRuntime(
        db,
        new NarrativeWorkCoordinator(db, outbox),
        resolver,
        5,
      );

      await runtime.runOnce();
      expect(await countHistoricalReceipts()).toBe(200);
      await runtime.runOnce();
      expect(await countHistoricalReceipts()).toBe(201);
      await runtime.stop();

      const turn = await turns.startTurn(ownerCtx);
      await turns.submitAction(contexts[0], turn.id, { body: 'A 在重启后提交行动。' });
      const submitted = await narrative.getRequiredByTurn(turn.campaignId, turn.id);
      const decision = submitted.decisions.find((item) => item.actorId === contexts[0].playerId);
      if (!decision?.actionId) throw new Error('expected post-restart decision');
      actionId = decision.actionId;
      actorId = decision.actorId;

      restarted = new NarrativeWorkRuntime(
        db,
        new NarrativeWorkCoordinator(db, outbox),
        resolver,
        5,
      );
      await restarted.runOnce();
      await restarted.stop();

      expect(providerCalls).toBe(1);
      const resolved = await narrative.getRequiredByTurn(turn.campaignId, turn.id);
      expect(resolved.decisions.find((item) => item.id === decision.id)?.status).toBe('resolved');
      const receipts = await db.query<{ payload_json: string }>(
        `SELECT e.payload_json
         FROM platform_outbox_consumer_receipts r
         JOIN platform_outbox_events e ON e.id = r.event_id
         WHERE r.consumer_name = ? AND e.event_type = ?`,
        [NARRATIVE_WORK_CONSUMER_NAME, workEventType],
      );
      expect(receipts).toHaveLength(202);
      expect(receipts.some((row) => JSON.parse(row.payload_json).roundId === turn.id)).toBe(true);
      const published = await db.query<{ published_at: string | null }>(
        'SELECT published_at FROM platform_outbox_events WHERE event_type = ?', [workEventType],
      );
      expect(published.every((row) => row.published_at === null)).toBe(true);
    } finally {
      await runtime?.stop();
      await restarted?.stop();
      await db.close();
    }
  });

  it('allows later input submissions while an in-flight Decision applies', async () => {
    const { db, ownerCtx, contexts, turns, narrative } = await makeFixture();
    let calls = 0;
    let releaseProvider: (() => void) | undefined;
    const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
    try {
      const turn = await turns.startTurn(ownerCtx);
      await turns.submitAction(contexts[0], turn.id, { body: 'A resolves while B is composing' });
      const decision = (await narrative.getRequiredByTurn(turn.campaignId, turn.id)).decisions
        .find((item) => item.actorId === contexts[0].playerId);
      if (!decision?.actionId) throw new Error('expected A decision');
      const provider = {
        name: 'collecting-test',
        model: 'collecting-test',
        stream: async () => {
          calls += 1;
          await providerGate;
          return {
            actionIntents: [{
              actionId: decision.actionId!, actorId: decision.actorId, mode: 'player_action',
              actionType: 'healing', actionRef: 'healing:basic', targetIds: [],
              declaredApproach: 'recover', desiredOutcome: 'recover', resourceChoices: [], fallbackPolicy: 'continue',
            }],
          };
        },
      } as const;
      const service = new NarrativeDecisionResolutionService(db, provider, new OutboxRepository(db));
      const pending = service.resolveDecision(ownerCtx, turn.id, decision.id, { idempotencyKey: 'collecting-submit' });
      await vi.waitFor(() => expect(calls).toBe(1));

      await turns.submitAction(contexts[1], turn.id, { body: 'B submits during A resolution' });
      releaseProvider!();
      const result = await pending;
      expect(result.run.status).toBe('succeeded');
      const after = await narrative.getRequiredByTurn(turn.campaignId, turn.id);
      expect(after.round.status).toBe('collecting');
      expect(after.decisions.find((item) => item.id === decision.id)?.status).toBe('resolved');
      expect(after.decisions.find((item) => item.actorId === contexts[1].playerId)?.status).toBe('submitted');
    } finally {
      releaseProvider?.();
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

  it('runs and stops the process-local claim lease sweeper without overlapping ticks', async () => {
    vi.useFakeTimers();
    try {
      let active = 0;
      let calls = 0;
      const coordinator = {
        sweepExpiredClaims: async () => {
          active += 1;
          calls += 1;
          expect(active).toBe(1);
          active -= 1;
          return 0;
        },
      } as unknown as NarrativeWorkCoordinator;
      const sweeper = new NarrativeClaimLeaseSweeper(coordinator, 100);
      sweeper.start();
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(calls).toBe(2);
      await sweeper.stop();
      await vi.advanceTimersByTimeAsync(100);
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('claims only once when duplicate wake-ups reach two workers', async () => {
    const { db, ownerCtx, contexts, turns, narrative } = await makeFixture();
    try {
      const turn = await turns.startTurn(ownerCtx);
      await turns.submitAction(contexts[0], turn.id, { body: 'A first' });
      const view = await narrative.getRequiredByTurn(turn.campaignId, turn.id);
      const coordinator = new NarrativeWorkCoordinator(db, new OutboxRepository(db));
      const [left, right] = await Promise.all([
        coordinator.claimNext(turn.campaignId, turn.id, 'worker-left'),
        coordinator.claimNext(turn.campaignId, turn.id, 'worker-right'),
      ]);
      expect([left, right].filter(Boolean)).toHaveLength(1);
      expect((await narrative.getRequiredByTurn(turn.campaignId, turn.id)).decisions
        .find((decision) => decision.id === view.decisions.find((item) => item.actionId)?.id)?.status).toBe('processing');
      expect((await db.query<{ count: number }>(
        "SELECT COUNT(*) AS count FROM platform_narrative_decisions WHERE round_id = ? AND status = 'processing'", [turn.id],
      ))[0].count).toBe(1);
    } finally {
      await db.close();
    }
  });

  it('fences an expired worker claim and preserves the blocked prefix', async () => {
    const { db, ownerCtx, contexts, turns, narrative } = await makeFixture();
    try {
      const turn = await turns.startTurn(ownerCtx);
      await turns.submitAction(contexts[0], turn.id, { body: 'A orphaned claim' });
      await turns.submitAction(contexts[1], turn.id, { body: 'B remains blocked' });
      const initial = await narrative.getRequiredByTurn(turn.campaignId, turn.id);
      const firstDecision = initial.decisions.find((decision) => decision.actorId === contexts[0].playerId);
      if (!firstDecision) throw new Error('expected A decision');
      const coordinator = new NarrativeWorkCoordinator(db, new OutboxRepository(db));
      const claimed = await coordinator.claimNext(turn.campaignId, turn.id, 'orphaned-worker');
      expect(claimed?.decision.id).toBe(firstDecision.id);

      const expiredAt = new Date(Date.now() - NARRATIVE_DECISION_CLAIM_LEASE_MS - 1000).toISOString();
      await db.execute('UPDATE platform_narrative_decisions SET updated_at = ? WHERE id = ?', [expiredAt, firstDecision.id]);
      expect(await coordinator.sweepExpiredClaims()).toBe(1);

      const after = await narrative.getRequiredByTurn(turn.campaignId, turn.id);
      expect(after.round.status).toBe('needs_owner_attention');
      expect(after.decisions.find((decision) => decision.id === firstDecision.id)?.status).toBe('needs_owner_attention');
      expect(after.decisions.find((decision) => decision.actorId === contexts[1].playerId)?.status).toBe('submitted');
      expect(after.participants.find((participant) => participant.playerId === contexts[0].playerId)?.status)
        .toBe('needs_owner_attention');
      expect((await db.query<{ status: string }>('SELECT status FROM platform_turns WHERE id = ?', [turn.id]))[0].status)
        .toBe('needs_owner_attention');
      expect(await coordinator.claimNext(turn.campaignId, turn.id, 'later-worker')).toBeNull();
    } finally {
      await db.close();
    }
  });

  it('expires an orphaned AI run and rejects a late provider result', async () => {
    const { db, ownerCtx, contexts, turns, narrative } = await makeFixture();
    let calls = 0;
    let releaseProvider: (() => void) | undefined;
    const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
    try {
      const turn = await turns.startTurn(ownerCtx);
      await turns.submitAction(contexts[0], turn.id, { body: 'A provider will be fenced' });
      const decision = (await narrative.getRequiredByTurn(turn.campaignId, turn.id)).decisions
        .find((item) => item.actorId === contexts[0].playerId);
      if (!decision?.actionId) throw new Error('expected A decision');
      const provider = {
        name: 'lease-test', model: 'lease-test',
        stream: async () => {
          calls += 1;
          await providerGate;
          return { actionIntents: [{
            actionId: decision.actionId!, actorId: decision.actorId, mode: 'player_action',
            actionType: 'healing', actionRef: 'healing:basic', targetIds: [],
            declaredApproach: 'recover', desiredOutcome: 'recover', resourceChoices: [], fallbackPolicy: 'continue',
          }] };
        },
      } as const;
      const service = new NarrativeDecisionResolutionService(db, provider, new OutboxRepository(db));
      const pending = service.resolveDecision(ownerCtx, turn.id, decision.id, { idempotencyKey: 'expired-provider-run' });
      await vi.waitFor(() => expect(calls).toBe(1));

      const expiredAt = new Date(Date.now() - NARRATIVE_DECISION_CLAIM_LEASE_MS - 1000).toISOString();
      await db.execute('UPDATE platform_narrative_decisions SET updated_at = ? WHERE id = ?', [expiredAt, decision.id]);
      const replay = await service.resolveDecision(ownerCtx, turn.id, decision.id, { idempotencyKey: 'expired-provider-run' });
      expect(replay.created).toBe(false);
      expect(replay.run.status).toBe('failed');
      expect(replay.run.errorCode).toBe(NARRATIVE_DECISION_CLAIM_EXPIRED_CODE);
      expect((await db.query<{ status: string; error_code: string | null }>(
        'SELECT status, error_code FROM platform_ai_runs WHERE id = ?', [replay.run.id],
      ))[0]).toEqual({ status: 'failed', error_code: NARRATIVE_DECISION_CLAIM_EXPIRED_CODE });
      expect((await db.query<{ status: string; failure_code: string | null }>(
        'SELECT status, failure_code FROM platform_narrative_decisions WHERE id = ?', [decision.id],
      ))[0]).toEqual({ status: 'needs_owner_attention', failure_code: NARRATIVE_DECISION_CLAIM_EXPIRED_CODE });
      expect(await db.query('SELECT id FROM platform_resolved_outcomes WHERE execution_id = ?', [replay.run.id])).toHaveLength(0);
      expect(await db.query('SELECT id FROM platform_narrative_working_facts WHERE execution_id = ?', [replay.run.id])).toHaveLength(0);
      expect((await db.query<{ event_type: string }>(
        'SELECT event_type FROM platform_outbox_events WHERE campaign_id = ?', [turn.campaignId],
      )).map((event) => event.event_type)).toContain('ai.preview.failed');

      releaseProvider!();
      await expect(pending).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
      expect(calls).toBe(1);
    } finally {
      releaseProvider?.();
      await db.close();
    }
  });

  it('keeps a Round collecting while a claimed Decision processes and accepts later submissions', async () => {
    const { db, ownerCtx, contexts, turns, narrative, mutations } = await makeFixture();
    try {
      const turn = await turns.startTurn(ownerCtx);
      await turns.submitAction(contexts[0], turn.id, { body: 'A acts first' });
      const coordinator = new NarrativeWorkCoordinator(db, new OutboxRepository(db));
      const claimed = await coordinator.claimNext(turn.campaignId, turn.id, 'collecting-worker');
      if (!claimed) throw new Error('expected a claimed Decision');
      expect(claimed.decision.status).toBe('processing');
      expect((await narrative.getRequiredByTurn(turn.campaignId, turn.id)).round.status).toBe('collecting');

      await turns.submitAction(contexts[1], turn.id, { body: 'B submits while A processes' });
      expect((await narrative.getRequiredByTurn(turn.campaignId, turn.id)).round.status).toBe('collecting');
      await db.transaction(async (tx) => {
        const applyExpectedRevision = await mutations.latestCompatibleRevisionIn(
          tx,
          turn.campaignId,
          claimed.claim.stateRevision,
          ['turn_action_submit'],
        );
        await mutations.mutateIn(tx, {
          campaignId: turn.campaignId,
          expectedRevision: applyExpectedRevision,
          mutationId: 'collecting-worker-apply',
          causeType: 'test_decision_apply',
          causeId: claimed.decision.id,
        }, async ({ stateRevision }) => {
          await narrative.markDecisionResolvedIn(tx, {
            campaignId: turn.campaignId,
            roundId: turn.id,
            decisionId: claimed.decision.id,
            stateRevision,
          });
        });
      });
      await turns.submitAction(contexts[2], turn.id, { body: 'C submits last' });

      const final = await narrative.getRequiredByTurn(turn.campaignId, turn.id);
      expect(final.round.status).toBe('ready');
      expect(final.round.decisionCursor).toBe(1);
      expect(final.decisions.find((decision) => decision.actorId === contexts[0].playerId)?.status).toBe('resolved');
      expect((await db.query<{ status: string }>('SELECT status FROM platform_turns WHERE id = ?', [turn.id]))[0].status).toBe('resolving');
    } finally {
      await db.close();
    }
  });

  it('resolves A as soon as A submits while B is still collecting', async () => {
    const { db, ownerCtx, contexts, turns, narrative, mutations } = await makeFixture();
    try {
      const turn = await turns.startTurn(ownerCtx);
      await turns.submitAction(contexts[0], turn.id, { body: 'A acts now' });
      const view = await narrative.getRequiredByTurn(turn.campaignId, turn.id);
      const aDecision = view.decisions.find((decision) => decision.actorId === contexts[0].playerId);
      if (!aDecision) throw new Error('expected A decision');
      await resolveDecision(db, narrative, mutations, turn.campaignId, turn.id, aDecision.id, {
        factKind: 'a.resolved', payload: { ok: true }, visibility: 'public',
      });
      const after = await narrative.getRequiredByTurn(turn.campaignId, turn.id);
      expect(after.decisions.find((decision) => decision.id === aDecision.id)?.status).toBe('resolved');
      expect(after.decisions.filter((decision) => decision.status === 'waiting')).toHaveLength(2);
    } finally {
      await db.close();
    }
  });

  it('does not bypass an earlier needs_owner_attention decision', async () => {
    const { db, ownerCtx, contexts, turns, narrative } = await makeFixture();
    try {
      const turn = await turns.startTurn(ownerCtx);
      await turns.submitAction(contexts[0], turn.id, { body: 'A blocks' });
      await turns.submitAction(contexts[1], turn.id, { body: 'B waits' });
      await turns.submitAction(contexts[2], turn.id, { body: 'C waits' });
      const view = await narrative.getRequiredByTurn(turn.campaignId, turn.id);
      const [aDecision, bDecision] = view.decisions;
      const first = await narrative.claimDecision(turn.campaignId, turn.id, aDecision.id, 'attention-exec');
      await narrative.markDecisionNeedsOwnerAttention(turn.campaignId, turn.id, aDecision.id, 'GM_REQUIRED');
      expect((await narrative.getRequiredByTurn(turn.campaignId, turn.id)).round.status).toBe('needs_owner_attention');
      const coordinator = new NarrativeWorkCoordinator(db, new OutboxRepository(db));
      expect(await coordinator.claimNext(turn.campaignId, turn.id, 'b-worker')).toBeNull();
      await narrative.skipDecision(turn.campaignId, turn.id, aDecision.id);
      const next = await coordinator.claimNext(turn.campaignId, turn.id, 'b-worker-after-skip');
      expect(next?.decision.id).toBe(bDecision.id);
      expect(first.decision.executionId).toBe('attention-exec');
    } finally {
      await db.close();
    }
  });

  it('allows edit before claim, rejects edit after claim, and applies the claimed action snapshot', async () => {
    const { db, ownerCtx, contexts, turns, narrative } = await makeFixture();
    try {
      const turn = await turns.startTurn(ownerCtx);
      await turns.submitAction(contexts[0], turn.id, { body: 'before claim' });
      await turns.submitAction(contexts[0], turn.id, { body: 'edited before claim' });
      const view = await narrative.getRequiredByTurn(turn.campaignId, turn.id);
      const decision = view.decisions.find((item) => item.actorId === contexts[0].playerId);
      if (!decision?.actionId) throw new Error('expected A decision');
      const provider = {
        name: 'snapshot-test', model: 'snapshot-test',
        stream: async () => {
          await expect(turns.submitAction(contexts[0], turn.id, { body: 'edit after claim' }))
            .rejects.toMatchObject({ code: 'TURN_LOCKED' });
          await db.execute('UPDATE platform_actions SET body = ? WHERE id = ?', ['concurrent raw edit', decision.actionId]);
          return {
            actionIntents: [{
              actionId: decision.actionId, actorId: decision.actorId, mode: 'player_action',
              actionType: 'healing', actionRef: 'healing:basic', targetIds: [],
              declaredApproach: 'recover', desiredOutcome: 'recover', resourceChoices: [], fallbackPolicy: 'continue',
            }],
          };
        },
      } as const;
      const service = new NarrativeDecisionResolutionService(db, provider, new OutboxRepository(db));
      const result = await service.resolveDecision(ownerCtx, turn.id, decision.id, { idempotencyKey: 'snapshot-run' });
      const intents = await db.query<{ input: string }>(
        'SELECT source_input AS input FROM platform_action_intents WHERE execution_id = ?', [result.run.id],
      );
      expect(intents[0]?.input).toBe('edited before claim');
    } finally {
      await db.close();
    }
  });

  it('replays a committed mechanics checkpoint without rerunning facts or revision', async () => {
    const { db, ownerCtx, contexts, turns, narrative } = await makeFixture();
    try {
      const turn = await turns.startTurn(ownerCtx);
      await turns.submitAction(contexts[0], turn.id, { body: 'A heals' });
      const decision = (await narrative.getRequiredByTurn(turn.campaignId, turn.id)).decisions
        .find((item) => item.actorId === contexts[0].playerId);
      if (!decision?.actionId) throw new Error('expected A decision');
      const provider = {
        name: 'replay-test', model: 'replay-test',
        stream: async () => ({ actionIntents: [{
          actionId: decision.actionId!, actorId: decision.actorId, mode: 'player_action',
          actionType: 'healing', actionRef: 'healing:basic', targetIds: [],
          declaredApproach: 'recover', desiredOutcome: 'recover', resourceChoices: [], fallbackPolicy: 'continue',
        }] }),
      } as const;
      const service = new NarrativeDecisionResolutionService(db, provider, new OutboxRepository(db));
      const first = await service.resolveDecision(ownerCtx, turn.id, decision.id, { idempotencyKey: 'replay-run' });
      const before = await db.query<{ revision: number }>(
        'SELECT revision FROM platform_campaign_state_heads WHERE campaign_id = ?', [turn.campaignId],
      );
      const beforeFacts = await db.query('SELECT id FROM platform_narrative_working_facts WHERE execution_id = ?', [first.run.id]);
      const beforeRolls = await db.query('SELECT id FROM platform_roll_records WHERE execution_id = ?', [first.run.id]);
      await db.execute("UPDATE platform_ai_runs SET status = 'running', completed_at = NULL, result_json = NULL, applied_state_revision = NULL WHERE id = ?", [first.run.id]);
      const expiredAt = new Date(Date.now() - NARRATIVE_DECISION_CLAIM_LEASE_MS - 1000).toISOString();
      await db.execute("UPDATE platform_narrative_decisions SET status = 'processing', outcome_id = NULL, updated_at = ? WHERE id = ?", [expiredAt, decision.id]);
      const replay = await service.resolveDecision(ownerCtx, turn.id, decision.id, { idempotencyKey: 'replay-run' });
      expect(replay.created).toBe(false);
      expect(replay.run.status).toBe('succeeded');
      expect((await db.query<{ revision: number }>(
        'SELECT revision FROM platform_campaign_state_heads WHERE campaign_id = ?', [turn.campaignId],
      ))[0].revision).toBe(before[0].revision);
      expect(await db.query('SELECT id FROM platform_narrative_working_facts WHERE execution_id = ?', [first.run.id])).toHaveLength(beforeFacts.length);
      expect(await db.query('SELECT id FROM platform_roll_records WHERE execution_id = ?', [first.run.id])).toHaveLength(beforeRolls.length);
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
