import { describe, expect, it } from 'vitest';
import type { AiPrompt, NarrationRequest } from '@dnd/contracts';
import type { AiProviderPort } from '../ai-runtime/AiProviderPort.js';
import { NarrationService } from './NarrationService.js';

const request: NarrationRequest = {
  outcomeId: 'outcome-1',
  executionId: 'run-1',
  campaignId: 'campaign-1',
  turnId: 'turn-1',
  stateRevision: 8,
  audience: 'player_public',
  observableEntities: [
    { id: 'player-1', kind: 'actor', displayName: '薇拉' },
    { id: 'goblin-1', kind: 'combatant', displayName: '地精' },
  ],
  actionSummaries: [{
    actionId: 'action-1', actorId: 'player-1',
    observableIntent: { actionType: 'attack', actionRef: 'attack:basic', targetIds: ['goblin-1'] },
  }],
  observableOutcome: {
    effects: [{ sourceActionId: 'action-1', kind: 'hp_delta', targetId: 'goblin-1', delta: -4, reason: 'attack_damage' }],
    rolls: [{ actionId: 'action-1', actorId: 'player-1', targetIds: ['goblin-1'], kind: 'attack', selectedDice: [19], total: 24, result: 'success' }],
  },
};

const basePrompt: AiPrompt = {
  campaignId: 'campaign-1',
  audience: 'owner_only',
  stage: 'intent_interpretation',
  characters: [
    { id: 'character-1', playerId: 'player-1', name: '薇拉' },
    { id: 'character-2', playerId: 'player-2', name: '卡恩' },
  ],
  messages: [
    { role: 'system', content: 'GM secret: 不应进入 Narration。' },
    { role: 'user', content: 'owner raw context' },
  ],
};

function providerReturning(output: unknown, capture?: (prompt: AiPrompt) => void): AiProviderPort {
  return {
    name: 'scripted',
    model: 'test-model',
    stream: async (prompt) => {
      capture?.(prompt);
      return output;
    },
  };
}

describe('NarrationService', () => {
  it('builds a separate observable prompt without GM context or non-actor identities', async () => {
    let received: AiPrompt | undefined;
    const service = new NarrationService(providerReturning({
      publicNarrative: '命中，地精踉跄后退。',
      privateUpdates: [{ playerId: 'player-1', content: '你确认攻击造成了伤害。' }],
    }, (prompt) => { received = prompt; }));

    const output = await service.generate(request, basePrompt, { onDelta: async () => undefined });

    expect(output.publicNarrative).toContain('地精');
    expect(received?.stage).toBe('narration');
    expect(received?.characters).toEqual([{ id: 'character-1', playerId: 'player-1', name: '薇拉' }]);
    expect(JSON.stringify(received?.messages)).toContain('observableOutcome');
    expect(JSON.stringify(received?.messages)).not.toContain('GM secret');
    expect(JSON.stringify(received?.messages)).not.toContain('owner raw context');
    expect(JSON.stringify(received?.messages)).not.toContain('targetValue');
    expect(JSON.stringify(received?.messages)).not.toContain('modifierBreakdown');
  });

  it('rejects mechanical fields and private updates for unrelated players', async () => {
    const mechanicalOutput = new NarrationService(providerReturning({
      publicNarrative: 'x', privateUpdates: [], stateChanges: [],
    }));
    await expect(mechanicalOutput.generate(request, basePrompt, { onDelta: async () => undefined }))
      .rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });

    const unrelatedPrivateUpdate = new NarrationService(providerReturning({
      publicNarrative: 'x', privateUpdates: [{ playerId: 'player-2', content: '不应出现。' }],
    }));
    await expect(unrelatedPrivateUpdate.generate(request, basePrompt, { onDelta: async () => undefined }))
      .rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
  });
});
