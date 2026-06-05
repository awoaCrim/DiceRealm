import { Router } from 'express';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import type { AppDatabase } from '../db/connection.js';
import type { DiceLog } from '../domain/types.js';
import { createCombat, nextTurn, processAttack, rollInitiative } from '../services/combatService.js';
import { rollDice } from '../services/diceService.js';

const diceRollSchema = z.object({
  diceType: z.string().min(1),
  modifier: z.number().int().default(0),
  reason: z.string().min(1),
  dc: z.number().int().optional(),
}).strict();

const combatStartSchema = z.object({
  combatants: z.array(z.object({
    characterId: z.string().nullable().default(null),
    npcId: z.string().nullable().default(null),
    name: z.string().min(1),
    hp: z.number().int().positive().default(1),
    ac: z.number().int().positive().default(10),
    dexMod: z.number().int().default(0)
  })).min(1)
}).strict();

const combatActionSchema = z.object({
  combatId: z.string().min(1)
}).strict();

const combatAttackSchema = z.object({
  combatId: z.string().min(1),
  attackerIndex: z.number().int().min(0),
  targetIndex: z.number().int().min(0),
  weaponDie: z.string().default('d8')
}).strict();

function roomExists(db: AppDatabase, roomId: string): boolean {
  return Boolean(db.prepare('SELECT id FROM rooms WHERE id = ?').get(roomId));
}

export function registerAdminCombatRoutes(router: Router, db: AppDatabase): void {
  function insertDiceLog(log: Omit<DiceLog, 'id' | 'timestamp'>): string {
    const id = nanoid();
    const timestamp = new Date().toISOString();
    db.prepare(
      `INSERT INTO dice_logs (id, room_id, turn_id, combat_id, character_id, dice_type, values_json, modifier, total, dc, success, is_public, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      log.roomId,
      log.turnId ?? null,
      log.combatId ?? null,
      log.characterId ?? null,
      log.diceType,
      JSON.stringify(log.values),
      log.modifier,
      log.total,
      log.dc ?? null,
      log.success === null ? null : (log.success ? 1 : 0),
      log.isPublic ? 1 : 0,
      log.reason,
      timestamp
    );
    return id;
  }

  router.post('/rooms/:roomId/dice/roll', (req, res) => {
    if (!roomExists(db, req.params.roomId)) return res.status(404).json({ error: 'Room not found' });

    const input = diceRollSchema.parse(req.body);
    const { values, total: baseTotal } = rollDice(input.diceType, 1);
    const total = baseTotal + input.modifier;
    const success = input.dc !== undefined ? total >= input.dc : null;

    const diceLog: Omit<DiceLog, 'id' | 'timestamp'> = {
      roomId: req.params.roomId,
      turnId: null,
      combatId: null,
      characterId: null,
      diceType: input.diceType,
      values,
      modifier: input.modifier,
      total,
      dc: input.dc ?? null,
      success,
      isPublic: true,
      reason: input.reason,
    };
    const diceLogId = insertDiceLog(diceLog);

    res.json({
      values,
      modifier: input.modifier,
      total,
      success,
      diceLog: { id: diceLogId }
    });
  });

  router.post('/rooms/:roomId/combat/start', (req, res) => {
    if (!roomExists(db, req.params.roomId)) return res.status(404).json({ error: 'Room not found' });

    const input = combatStartSchema.parse(req.body);
    const now = new Date().toISOString();
    const combatantSpecs: Array<{
      characterId?: string;
      npcId?: string;
      name: string;
      hp: number;
      ac: number;
      isPlayer: boolean;
    }> = input.combatants.map((spec) => {
      let npcId: string | undefined = spec.npcId ?? undefined;

      if (!spec.characterId && !spec.npcId) {
        npcId = nanoid();
        const dexScore = spec.dexMod !== undefined && spec.dexMod !== 0
          ? 10 + spec.dexMod * 2 + 1
          : 10;
        db.prepare(
          'INSERT INTO npcs (id, room_id, name, hp_max, hp_current, ac, str, dex, con, int, wis, cha, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(npcId, req.params.roomId, spec.name, spec.hp, spec.hp, spec.ac, 10, dexScore, 10, 10, 10, 10, now);
      }

      return {
        characterId: spec.characterId ?? undefined,
        npcId,
        name: spec.name,
        hp: spec.hp ?? 1,
        ac: spec.ac ?? 10,
        isPlayer: !!spec.characterId,
      };
    });

    const combatState = createCombat(db, req.params.roomId, combatantSpecs);
    res.json({ combatState });
  });

  router.post('/rooms/:roomId/combat/roll-initiative', (req, res) => {
    if (!roomExists(db, req.params.roomId)) return res.status(404).json({ error: 'Room not found' });

    const input = combatActionSchema.parse(req.body);
    try {
      const combatState = rollInitiative(db, input.combatId);
      res.json({ combatState });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(message.includes('not found') ? 404 : 400).json({ error: message });
    }
  });

  router.post('/rooms/:roomId/combat/attack', (req, res) => {
    if (!roomExists(db, req.params.roomId)) return res.status(404).json({ error: 'Room not found' });

    const input = combatAttackSchema.parse(req.body);
    try {
      const result = processAttack(db, {
        roomId: req.params.roomId,
        combatId: input.combatId,
        attackerIndex: input.attackerIndex,
        targetIndex: input.targetIndex,
      });
      res.json({
        combatState: result.state,
        hit: result.attackResult.hit,
        criticalHit: result.attackResult.criticalHit,
        criticalMiss: result.attackResult.criticalMiss,
        attackRoll: result.attackResult.roll,
        attackTotal: result.attackResult.total,
        damageTotal: result.damageResult?.total,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(message.includes('not found') ? 404 : 400).json({ error: message });
    }
  });

  router.post('/rooms/:roomId/combat/next-turn', (req, res) => {
    if (!roomExists(db, req.params.roomId)) return res.status(404).json({ error: 'Room not found' });

    const input = combatActionSchema.parse(req.body);
    try {
      const combatState = nextTurn(db, input.combatId);
      res.json({ combatState });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(message.includes('not found') ? 404 : 400).json({ error: message });
    }
  });

  router.get('/rooms/:roomId/combat', (req, res) => {
    if (!roomExists(db, req.params.roomId)) return res.status(404).json({ error: 'Room not found' });

    const combatRows = db.prepare(
      'SELECT state_json FROM combat_state WHERE room_id = ? AND state_json LIKE ? ORDER BY updated_at DESC LIMIT 1'
    ).all(req.params.roomId, '%"status":"active"%') as Array<{ state_json: string }>;
    if (combatRows.length === 0) return res.status(404).json({ error: 'No active combat found' });

    res.json({ combatState: JSON.parse(combatRows[0].state_json) });
  });

  router.get('/rooms/:roomId/dice-logs', (req, res) => {
    if (!roomExists(db, req.params.roomId)) return res.status(404).json({ error: 'Room not found' });

    const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) || 50 : 50;
    const rows = db.prepare(
      'SELECT id, room_id as roomId, turn_id as turnId, combat_id as combatId, character_id as characterId, dice_type as diceType, values_json as valuesJson, modifier, total, dc, success, is_public as isPublic, reason, created_at as createdAt FROM dice_logs WHERE room_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(req.params.roomId, limit) as Array<{
      id: string; roomId: string; turnId: string | null; combatId: string | null;
      characterId: string | null; diceType: string; valuesJson: string;
      modifier: number; total: number; dc: number | null; success: number | null;
      isPublic: number; reason: string; createdAt: string;
    }>;
    const logs = rows.map((row) => ({
      id: row.id,
      roomId: row.roomId,
      turnId: row.turnId,
      combatId: row.combatId,
      characterId: row.characterId,
      diceType: row.diceType,
      values: JSON.parse(row.valuesJson) as number[],
      modifier: row.modifier,
      total: row.total,
      dc: row.dc,
      success: row.success === null ? null : Boolean(row.success),
      isPublic: Boolean(row.isPublic),
      reason: row.reason,
      timestamp: row.createdAt,
    }));
    res.json({ logs });
  });
}
