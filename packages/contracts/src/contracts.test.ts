import { describe, expect, it } from 'vitest';
import { campaignEventSchema, turnResolutionSchema } from './index';

describe('shared contracts', () => {
  it('accepts a structured turn resolution', () => {
    const result = turnResolutionSchema.parse({
      publicNarrative: '雨停了。',
      privateUpdates: [{ playerId: 'player-1', content: '你发现了暗门。' }],
      diceResults: [],
      stateChanges: [],
      interactionRequests: [],
    });

    expect(result.privateUpdates[0].playerId).toBe('player-1');
  });

  it('rejects an event without a visibility-safe event type', () => {
    expect(() => campaignEventSchema.parse({ type: 'database.row_dump' })).toThrow();
  });

  it('accepts a structured dice result with visibility', () => {
    const result = turnResolutionSchema.parse({
      publicNarrative: '剑刃劈开空气。',
      privateUpdates: [],
      diceResults: [
        {
          id: 'dice-1',
          formula: '1d20+5',
          total: 18,
          visibility: 'public',
        },
      ],
      stateChanges: [
        {
          kind: 'combat',
          targetId: 'goblin-1',
          patch: { hpCurrent: 3 },
          visibility: 'public',
        },
      ],
      interactionRequests: [
        {
          id: 'interaction-1',
          targetPlayerId: 'player-2',
          prompt: '酒馆老板等待你的回答。',
        },
      ],
    });

    expect(result.diceResults[0].total).toBe(18);
    expect(result.stateChanges[0].patch).toEqual({ hpCurrent: 3 });
    expect(result.interactionRequests[0].prompt).toMatch(/酒馆老板/);
  });
});
