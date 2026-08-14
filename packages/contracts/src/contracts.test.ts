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
          targetPlayerId: null,
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

    expect(result.diceResults[0].targetPlayerId).toBeNull();
    expect(result.diceResults[0].total).toBe(18);
    expect(result.stateChanges[0].patch).toEqual({ hpCurrent: 3 });
    expect(result.interactionRequests[0].prompt).toMatch(/酒馆老板/);
  });

  it('requires a non-null targetPlayerId for player_private dice', () => {
    expect(() => turnResolutionSchema.parse({
      publicNarrative: 'x', privateUpdates: [], stateChanges: [],
      diceResults: [{ id: 'd', formula: '1d20', total: 7, visibility: 'player_private', targetPlayerId: null }],
      interactionRequests: [],
    })).toThrow();
  });

  it('rejects an empty publicNarrative', () => {
    expect(() => turnResolutionSchema.parse({
      publicNarrative: '', privateUpdates: [], diceResults: [], stateChanges: [], interactionRequests: [],
    })).toThrow();
  });

  it('defaults every omitted empty collection to an empty array', () => {
    const result = turnResolutionSchema.parse({ publicNarrative: '雨停了。' });

    expect(result.privateUpdates).toEqual([]);
    expect(result.diceResults).toEqual([]);
    expect(result.stateChanges).toEqual([]);
    expect(result.interactionRequests).toEqual([]);
    expect(result.worldFactCreations).toEqual([]);
    expect(result.encounterStarts).toEqual([]);
  });

  it('still rejects malformed nested values when a collection is supplied', () => {
    expect(() => turnResolutionSchema.parse({
      publicNarrative: '雨停了。',
      privateUpdates: [{ playerId: 'player-1', content: 42 }],
    })).toThrow();
  });

  it('parses worldFactCreations and encounterStarts with rollInitiative defaulting to true', () => {
    const result = turnResolutionSchema.parse({
      publicNarrative: '战斗开始。',
      privateUpdates: [],
      diceResults: [],
      stateChanges: [],
      interactionRequests: [],
      worldFactCreations: [
        { title: '烛堡密道', kind: 'location', content: '石墙后藏着通道。', visibility: 'public', knownBy: [] },
      ],
      encounterStarts: [
        {
          name: '密道伏击',
          combatants: [
            { name: '哥布林', characterId: null, initiativeBonus: 2, hpCurrent: 9, hpMax: 9, ac: 13, conditions: [], visibility: 'public', targetPlayerId: null },
          ],
        },
      ],
    });
    expect(result.worldFactCreations[0].title).toBe('烛堡密道');
    expect(result.encounterStarts[0].rollInitiative).toBe(true);
    expect(result.encounterStarts[0].combatants[0].name).toBe('哥布林');
  });

  it('honors rollInitiative=false when explicitly provided', () => {
    const result = turnResolutionSchema.parse({
      publicNarrative: 'x', privateUpdates: [], diceResults: [], stateChanges: [], interactionRequests: [],
      encounterStarts: [{
        name: '对峙',
        rollInitiative: false,
        combatants: [
          { name: '卫士', characterId: null, initiativeBonus: 1, hpCurrent: 10, hpMax: 10, ac: 15, conditions: [], visibility: 'public', targetPlayerId: null },
        ],
      }],
    });
    expect(result.encounterStarts[0].rollInitiative).toBe(false);
  });
});
