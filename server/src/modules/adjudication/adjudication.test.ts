import { describe, expect, it } from 'vitest';
import { actionIntentProposalSchema } from '@dnd/contracts';
import { AdjudicationService } from './AdjudicationService.js';
import { DiceService, hashRollPlan } from './DiceService.js';

function attackProposal() {
  return {
    actionId: 'action-1',
    actorId: 'player-1',
    mode: 'player_action' as const,
    actionType: 'attack' as const,
    actionRef: 'attack:basic',
    targetIds: ['goblin-1'],
    resourceChoices: [],
  };
}

function attackIntent() {
  return {
    ...attackProposal(),
    campaignId: 'campaign-1',
    input: '攻击地精',
  };
}

describe('server adjudication and dice authority', () => {
  it('rejects provider mechanical fields at the semantic intent boundary', () => {
    expect(() => actionIntentProposalSchema.parse({
      ...attackProposal(),
      attackBonus: 99,
    })).toThrow();
  });

  it('locks and hashes a plan before reading the random source', () => {
    let calls = 0;
    const dice = new DiceService(() => {
      calls += 1;
      return 0.5;
    });
    const input = {
      id: 'plan-1', campaignId: 'campaign-1', intentId: 'intent-1', executionId: 'run-1', actorId: 'player-1',
      targetIds: ['goblin-1'], rollKind: 'attack' as const, diceExpression: '1d20', modifierBreakdown: [],
      advantageState: 'normal' as const, targetType: 'ac' as const, targetValue: 12,
      successEffects: [], failureEffects: [], ruleRefs: ['attack:basic'], rulesetId: 'dnd5e', rulesetVersion: 'v0.1',
      basedOnStateRevision: 3,
    };
    const plan = dice.lockPlan(input, '2026-08-16T00:00:00.000Z');
    expect(calls).toBe(0);
    expect(plan.planHash).toBe(hashRollPlan(input));
    expect(plan.planHash).not.toBe(hashRollPlan({ ...input, targetValue: 13 }));
    expect(dice.rollD20().total).toBe(11);
    expect(calls).toBe(1);
  });

  it('selects advantage/disadvantage server-side', () => {
    const advantageValues = [0.05, 0.95];
    const advantage = new DiceService(() => advantageValues.shift() ?? 0);
    expect(advantage.rollD20('advantage')).toMatchObject({ rawDice: [2, 20], selectedDice: [20], total: 20 });

    const disadvantageValues = [0.05, 0.95];
    const disadvantage = new DiceService(() => disadvantageValues.shift() ?? 0);
    expect(disadvantage.rollD20('disadvantage')).toMatchObject({ rawDice: [2, 20], selectedDice: [2], total: 2 });
  });

  it('adjudicates attack and damage using only server-owned actor/target data', () => {
    const values = [0.90, 0.5];
    const adjudicator = new AdjudicationService(new DiceService(() => values.shift() ?? 0));
    const result = adjudicator.resolve({
      ...attackIntent(), basedOnStateRevision: 4,
    }, {
      campaignId: 'campaign-1', turnId: 'turn-1', executionId: 'run-1', stateRevision: 4,
      rulesetId: 'dnd5e', rulesetVersion: 'v0.1',
      appliedStateRevision: 5,
      actors: { 'player-1': { id: 'player-1', attackModifier: 5 } },
      targets: { 'goblin-1': { id: 'goblin-1', ac: 10, hpCurrent: 8, hpMax: 8 } },
    }, 'mutation-1');
    expect(result.decision.kind).toBe('roll_required');
    expect(result.plans.map((plan) => plan.rollKind)).toEqual(['attack', 'damage']);
    expect(result.records[0].total).toBe(24);
    expect(result.records[0].stateRevision).toBe(5);
    expect(result.effects).toEqual([{ kind: 'hp_delta', targetId: 'goblin-1', delta: -4, reason: 'attack_damage' }]);
  });

  it('does not let Provider resourceChoices select mechanical advantage', () => {
    const adjudicator = new AdjudicationService(new DiceService(() => 0.05));
    const result = adjudicator.resolve({
      ...attackIntent(), resourceChoices: ['advantage'], basedOnStateRevision: 4,
    }, {
      campaignId: 'campaign-1', turnId: 'turn-1', executionId: 'run-advantage', stateRevision: 4,
      rulesetId: 'dnd5e', rulesetVersion: 'v0.1',
      actors: { 'player-1': { id: 'player-1', attackModifier: 5 } },
      targets: { 'goblin-1': { id: 'goblin-1', ac: 10, hpCurrent: 8, hpMax: 8 } },
    }, 'mutation-advantage');
    expect(result.plans[0].advantageState).toBe('normal');
    expect(result.records[0].rawDice).toEqual([2]);
    expect(result.records[0].selectedDice).toEqual([2]);
  });

  it('applies saving throw failure consequences to the acting actor', () => {
    const adjudicator = new AdjudicationService(new DiceService(() => 0));
    const result = adjudicator.resolve({
      actionId: 'action-save', campaignId: 'campaign-1', actorId: 'player-1', input: '抵抗毒素',
      mode: 'player_action', actionType: 'saving_throw', actionRef: 'saving_throw:basic',
      targetIds: ['poison-source'], resourceChoices: [], basedOnStateRevision: 4,
    }, {
      campaignId: 'campaign-1', turnId: 'turn-1', executionId: 'run-save', stateRevision: 4,
      rulesetId: 'dnd5e', rulesetVersion: 'v0.1',
      actors: { 'player-1': { id: 'player-1', savingThrowModifiers: { basic: 0 }, hpCurrent: 8, hpMax: 8 } },
      targets: { 'poison-source': { id: 'poison-source', hpCurrent: 1, hpMax: 1 } },
    }, 'mutation-save');
    expect(result.records[0].result).toBe('failure');
    expect(result.effects).toEqual([{ kind: 'hp_delta', targetId: 'player-1', delta: -1, reason: 'saving_throw_failure' }]);
  });

  it('allows a fixed ability check without a Provider-supplied DC', () => {
    const adjudicator = new AdjudicationService(new DiceService(() => 0.5));
    const result = adjudicator.resolve({
      actionId: 'action-check', campaignId: 'campaign-1', actorId: 'player-1', input: '观察',
      mode: 'player_action', actionType: 'ability_check', actionRef: 'ability_check:perception',
      targetIds: [], resourceChoices: [], basedOnStateRevision: 2,
    }, {
      campaignId: 'campaign-1', turnId: 'turn-1', executionId: 'run-2', stateRevision: 2,
      rulesetId: 'dnd5e', rulesetVersion: 'v0.1',
      actors: { 'player-1': { id: 'player-1', abilityModifiers: { perception: 3 } } },
    }, 'mutation-2');
    expect(result.decision.kind).toBe('roll_required');
    expect(result.plans[0].targetValue).toBe(12);
    expect(result.records[0].total).toBe(14);
  });
});
