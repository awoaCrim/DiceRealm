import { describe, expect, it } from 'vitest';
import { actorBindingRoleSchema, campaignActorSchema, characterRuntimeStateSchema, createNpcActorInputSchema, runtimeMutationEffectSchema } from './actor.js';

describe('actor contracts', () => {
  it('accepts a userless NPC and runtime state', () => {
    expect(campaignActorSchema.parse({
      id: 'actor:npc-1', campaignId: 'campaign-1', displayName: 'Guard',
      characterType: 'npc', controlMode: 'ai', mechanicsMode: 'lightweight',
      characterId: null, createdAt: '2026-01-01', updatedAt: '2026-01-01',
    }).characterId).toBeNull();
    expect(characterRuntimeStateSchema.parse({
      campaignId: 'campaign-1', actorId: 'actor:npc-1', currentHp: 4, temporaryHp: 0,
      conditions: ['blinded'], runtimeStatus: 'active', stateRevision: 3, updatedAt: '2026-01-01',
    }).conditions).toEqual(['blinded']);
  });

  it('allows NPCs to use pc_build mechanics independently from character type', () => {
    const actor = campaignActorSchema.parse({
      id: 'actor:npc-pc-build', campaignId: 'campaign-1', displayName: 'Companion',
      characterType: 'npc', controlMode: 'ai', mechanicsMode: 'pc_build',
      characterId: null, createdAt: '2026-01-01', updatedAt: '2026-01-01',
    });
    expect(actor.mechanicsMode).toBe('pc_build');
    expect(createNpcActorInputSchema.parse({
      displayName: 'Companion', mechanicsMode: 'pc_build', currentHp: 8,
    }).mechanicsMode).toBe('pc_build');
  });

  it('rejects player bindings without a user and duplicate runtime conditions', () => {
    expect(() => actorBindingRoleSchema.parse('invalid')).toThrow();
    expect(() => campaignActorSchema.parse({
      id: 'actor:pc-1', campaignId: 'campaign-1', displayName: 'PC',
      characterType: 'player_character', controlMode: 'player', mechanicsMode: 'pc_build',
      characterId: null, createdAt: '2026-01-01', updatedAt: '2026-01-01',
    })).toThrow();
    expect(() => characterRuntimeStateSchema.parse({
      campaignId: 'campaign-1', actorId: 'actor:pc-1', currentHp: 4, temporaryHp: 0,
      conditions: ['poisoned', 'poisoned'], runtimeStatus: 'active', stateRevision: 0, updatedAt: '2026-01-01',
    })).toThrow();
  });

  it('keeps runtime effects strict and bounded', () => {
    expect(runtimeMutationEffectSchema.parse({ kind: 'damage', amount: 2 })).toEqual({ kind: 'damage', amount: 2 });
    expect(() => runtimeMutationEffectSchema.parse({ kind: 'damage', amount: -1 })).toThrow();
    expect(() => runtimeMutationEffectSchema.parse({ kind: 'healing', amount: 1, hpCurrent: 99 })).toThrow();
  });
});
