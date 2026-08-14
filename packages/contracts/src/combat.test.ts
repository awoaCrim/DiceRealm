import { describe, expect, it } from 'vitest';
import {
  combatCommandSchema,
  combatantSchema,
  encounterSchema,
  startEncounterInputSchema,
} from './index';

describe('combat contracts', () => {
  describe('combatantSchema', () => {
    it('accepts nullable characterId/initiative/targetPlayerId and initiativeBonus', () => {
      const combatant = combatantSchema.parse({
        id: 'cbt-1',
        name: '薇拉',
        characterId: null,
        initiative: null,
        initiativeBonus: 2,
        hpCurrent: 10,
        hpMax: 10,
        ac: 15,
        conditions: [],
        visibility: 'public',
        targetPlayerId: null,
      });
      expect(combatant.characterId).toBeNull();
      expect(combatant.initiative).toBeNull();
      expect(combatant.initiativeBonus).toBe(2);
      expect(combatant.targetPlayerId).toBeNull();
    });

    it('requires targetPlayerId for player_private visibility', () => {
      expect(() => combatantSchema.parse({
        id: 'cbt-2',
        name: '密探',
        characterId: null,
        initiative: null,
        initiativeBonus: 0,
        hpCurrent: 5,
        hpMax: 5,
        ac: 12,
        conditions: [],
        visibility: 'player_private',
        targetPlayerId: null,
      })).toThrow();
    });

    it('rejects targetPlayerId for public/owner_only visibility', () => {
      for (const visibility of ['public', 'owner_only'] as const) {
        expect(() => combatantSchema.parse({
          id: 'cbt-3',
          name: '守卫',
          characterId: null,
          initiative: null,
          initiativeBonus: 0,
          hpCurrent: 5,
          hpMax: 5,
          ac: 12,
          conditions: [],
          visibility,
          targetPlayerId: 'p1',
        })).toThrow();
      }
    });
  });

  describe('encounterSchema', () => {
    it('requires round and exposes nullable activeCombatantId', () => {
      const encounter = encounterSchema.parse({
        id: 'enc-1',
        campaignId: 'c1',
        name: '酒馆混战',
        status: 'preparation',
        activeCombatantId: null,
        round: 1,
        combatants: [],
        createdAt: '2026-08-02T00:00:00.000Z',
        updatedAt: '2026-08-02T00:00:00.000Z',
      });
      expect(encounter.round).toBe(1);
      expect(encounter.activeCombatantId).toBeNull();
    });

    it('rejects an encounter without round', () => {
      expect(() => encounterSchema.parse({
        id: 'enc-1',
        campaignId: 'c1',
        name: '酒馆混战',
        status: 'preparation',
        activeCombatantId: null,
        combatants: [],
        createdAt: 'now',
        updatedAt: 'now',
      })).toThrow();
    });
  });

  describe('startEncounterInputSchema', () => {
    it('parses a full start input with combatants', () => {
      const input = startEncounterInputSchema.parse({
        name: '地窖遭遇',
        combatants: [{
          name: '战士',
          characterId: 'char-1',
          initiativeBonus: 2,
          hpCurrent: 12,
          hpMax: 12,
          ac: 16,
          conditions: ['中毒'],
          visibility: 'public',
          targetPlayerId: null,
        }, {
          name: '地精',
          characterId: null,
          initiativeBonus: 1,
          hpCurrent: 7,
          hpMax: 7,
          ac: 13,
          conditions: [],
          visibility: 'owner_only',
          targetPlayerId: null,
        }],
      });
      expect(input.combatants).toHaveLength(2);
      expect(input.combatants[0].visibility).toBe('public');
    });

    it('rejects an empty combatant list', () => {
      expect(() => startEncounterInputSchema.parse({
        name: '空遭遇',
        combatants: [],
      })).toThrow();
    });

    it('rejects non-positive hpMax and negative ac', () => {
      expect(() => startEncounterInputSchema.parse({
        name: '坏战斗员',
        combatants: [{ name: 'x', characterId: null, initiativeBonus: 0, hpCurrent: 0, hpMax: 0, ac: 5, conditions: [], visibility: 'public', targetPlayerId: null }],
      })).toThrow();
      expect(() => startEncounterInputSchema.parse({
        name: '坏战斗员',
        combatants: [{ name: 'x', characterId: null, initiativeBonus: 0, hpCurrent: 1, hpMax: 2, ac: -1, conditions: [], visibility: 'public', targetPlayerId: null }],
      })).toThrow();
    });
  });

  describe('combatCommandSchema', () => {
    it('parses all ten command kinds with strict payloads', () => {
      const commands = [
        { kind: 'start_encounter', payload: { name: 'e', combatants: [{ name: 'x', characterId: null, initiativeBonus: 0, hpCurrent: 1, hpMax: 1, ac: 10, conditions: [], visibility: 'public', targetPlayerId: null }] } },
        { kind: 'roll_initiative', payload: {} },
        { kind: 'advance_turn', payload: {} },
        { kind: 'apply_attack', payload: { actorCombatantId: 'a', targetCombatantId: 'b', attackBonus: 3, damageDie: 'd8', damageDice: 1, damageBonus: 2 } },
        { kind: 'apply_saving_throw', payload: { actorCombatantId: 'a', targetCombatantId: 'b', saveBonus: 2, dc: 13, damageOnFailure: 4 } },
        { kind: 'apply_damage', payload: { actorCombatantId: 'a', targetCombatantId: 'b', amount: 3 } },
        { kind: 'apply_healing', payload: { actorCombatantId: 'a', targetCombatantId: 'b', amount: 2 } },
        { kind: 'add_condition', payload: { actorCombatantId: 'a', targetCombatantId: 'b', condition: '昏迷' } },
        { kind: 'remove_condition', payload: { actorCombatantId: 'a', targetCombatantId: 'b', condition: '昏迷' } },
        { kind: 'end_encounter', payload: {} },
      ];
      for (const command of commands) {
        expect(combatCommandSchema.parse(command).kind).toBe(command.kind);
      }
    });

    it('rejects an unknown command kind', () => {
      expect(() => combatCommandSchema.parse({ kind: 'apply_magic', payload: {} })).toThrow();
    });

    it('rejects extra payload fields (strict mode)', () => {
      expect(() => combatCommandSchema.parse({
        kind: 'apply_damage',
        payload: { actorCombatantId: 'a', targetCombatantId: 'b', amount: 3, surprise: true },
      })).toThrow();
    });

    it('rejects negative amounts and empty ids', () => {
      expect(() => combatCommandSchema.parse({
        kind: 'apply_healing',
        payload: { actorCombatantId: 'a', targetCombatantId: 'b', amount: -1 },
      })).toThrow();
      expect(() => combatCommandSchema.parse({
        kind: 'apply_damage',
        payload: { actorCombatantId: '', targetCombatantId: 'b', amount: 1 },
      })).toThrow();
    });

    it('rejects invalid damage dice specifications', () => {
      expect(() => combatCommandSchema.parse({
        kind: 'apply_attack',
        payload: { actorCombatantId: 'a', targetCombatantId: 'b', attackBonus: 0, damageDie: 'd3', damageDice: 1, damageBonus: 0 },
      })).toThrow();
      expect(() => combatCommandSchema.parse({
        kind: 'apply_attack',
        payload: { actorCombatantId: 'a', targetCombatantId: 'b', attackBonus: 0, damageDie: 'd8', damageDice: 0, damageBonus: 0 },
      })).toThrow();
      expect(() => combatCommandSchema.parse({
        kind: 'apply_attack',
        payload: { actorCombatantId: 'a', targetCombatantId: 'b', attackBonus: 0, damageDie: 'd8', damageDice: 21, damageBonus: 0 },
      })).toThrow();
    });

    it('rejects a negative save DC / non-integer attack bonus', () => {
      expect(() => combatCommandSchema.parse({
        kind: 'apply_saving_throw',
        payload: { actorCombatantId: 'a', targetCombatantId: 'b', saveBonus: 2, dc: -1, damageOnFailure: 0 },
      })).toThrow();
      expect(() => combatCommandSchema.parse({
        kind: 'apply_attack',
        payload: { actorCombatantId: 'a', targetCombatantId: 'b', attackBonus: 1.5, damageDie: 'd6', damageDice: 1, damageBonus: 0 },
      })).toThrow();
    });
  });
});
