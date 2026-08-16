import { describe, expect, it } from 'vitest';
import {
  actionIntentSchema,
  authoritySchema,
  contextBlockSchema,
  contextVisibilityFromPersisted,
  contextVisibilitySchema,
  contextSourceRefSchema,
  narrativeOutputSchema,
  resolvedOutcomeSchema,
  stateChangeSchema,
  stateRevisionSchema,
} from './runtime.js';

describe('runtime contracts', () => {
  it('keeps authority and context audience as independent enums', () => {
    expect(authoritySchema.parse('world')).toBe('world');
    expect(contextVisibilitySchema.parse('gm_only')).toBe('gm_only');
    expect(() => authoritySchema.parse('gm_only')).toThrow();
    expect(() => contextVisibilitySchema.parse('owner_only')).toThrow();
    expect(contextVisibilityFromPersisted('owner_only')).toBe('gm_only');
    expect(contextVisibilityFromPersisted('player_private')).toBe('actor_private');
    expect(contextVisibilityFromPersisted('public')).toBe('public');
  });

  it('requires bounded stable source references and strict context blocks', () => {
    expect(contextSourceRefSchema.parse('world-fact:secret-npc')).toBe('world-fact:secret-npc');
    expect(() => contextSourceRefSchema.parse('secret-without-namespace')).toThrow();
    expect(() => contextSourceRefSchema.parse('WORLD:secret')).toThrow();
    expect(() => contextBlockSchema.parse({
      id: 'block-1',
      type: 'actor_knowledge',
      content: 'known',
      sourceRefs: ['world-fact:secret-npc'],
      authority: 'world',
      visibility: 'actor_private',
      priority: 'P1',
      unexpected: true,
    })).toThrow();
  });

  it('accepts typed state changes and rejects arbitrary fields', () => {
    const character = stateChangeSchema.parse({
      kind: 'character',
      targetId: 'character-1',
      patch: { sheet: { hpCurrent: 7 } },
      visibility: 'public',
    });
    expect(character.kind).toBe('character');

    const combat = stateChangeSchema.parse({
      kind: 'combat',
      targetId: 'encounter-1',
      patch: {
        command: 'apply_damage',
        actorCombatantId: 'actor-1',
        targetCombatantId: 'target-1',
        amount: 3,
      },
      visibility: 'public',
    });
    expect(combat.kind).toBe('combat');

    expect(() => stateChangeSchema.parse({
      kind: 'character', targetId: 'character-1',
      patch: { sheet: { admin: true } }, visibility: 'public',
    })).toThrow();
    expect(() => stateChangeSchema.parse({
      kind: 'world', targetId: 'fact-1',
      patch: { content: 'updated' }, visibility: 'public', extra: 'not-allowed',
    })).toThrow();
    expect(() => stateChangeSchema.parse({
      kind: 'unknown', targetId: 'x', patch: {}, visibility: 'public',
    })).toThrow();
  });

  it('bounds the remaining runtime result contracts', () => {
    expect(actionIntentSchema.parse({
      actionId: 'turn-1', campaignId: 'campaign-1', actorId: 'player-1', input: 'search',
    }).actorId).toBe('player-1');
    expect(resolvedOutcomeSchema.parse({ summary: 'found', facts: [] }).facts).toEqual([]);
    expect(narrativeOutputSchema.parse({ publicNarrative: 'The door opens.' }).privateUpdates).toEqual([]);
    expect(stateRevisionSchema.parse({
      campaignId: 'campaign-1', revision: 2, mutationId: 'mutation-1',
      causeType: 'ai_formal_apply', createdAt: '2026-08-16T00:00:00.000Z',
    }).revision).toBe(2);
  });
});
