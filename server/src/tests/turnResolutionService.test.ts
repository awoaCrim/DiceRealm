import { describe, expect, it } from 'vitest';
import { createMemoryDb } from '../db/connection.js';
import { migrate } from '../db/schema.js';
import type { AiTurnResult } from '../domain/types.js';
import { persistGameEvents } from '../services/gameEventService.js';
import { applyResolutionRunToAiTurnResult, createTurnLogMaterializedEvent, createTurnResolutionRun, loadTurnResolutionRun } from '../services/turnResolutionService.js';

function seedRoom(db: ReturnType<typeof createMemoryDb>) {
  const now = '2026-06-03T00:00:00.000Z';
  const roomId = 'room-1';
  const turnId = 'turn-1';
  const playerId = 'player-1';
  const characterId = 'character-1';
  db.prepare('INSERT INTO rooms (id, name, system_prompt, world_info, current_turn, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(roomId, 'Test Room', '', '', 1, 'ready_to_resolve', now);
  db.prepare('INSERT INTO turns (id, room_id, number, status, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(turnId, roomId, 1, 'ready_to_resolve', now, null);
  db.prepare('INSERT INTO players (id, room_id, name, token, is_connected, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(playerId, roomId, 'Aster', 'token-1', 1, now);
  const sheet = {
    name: 'Aster',
    species: 'Human',
    className: 'Fighter',
    level: 1,
    abilityScores: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 8 },
    hitPoints: { current: 12, max: 12 },
    armorClass: 16,
    proficiencyBonus: 2,
    skills: ['Athletics'],
    equipment: [],
    spells: [],
    privateNotes: ''
  };
  db.prepare('INSERT INTO characters (id, player_id, sheet_json, draft_source, confirmed, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(characterId, playerId, JSON.stringify(sheet), 'manual', 1, now);
  return { roomId, turnId, playerId, characterId };
}

function insertPreview(db: ReturnType<typeof createMemoryDb>, previewId: string, roomId: string, turnId: string) {
  db.prepare(`
    INSERT INTO ai_turn_previews (id, room_id, turn_id, original_prompt, suggested_state_changes_json, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(previewId, roomId, turnId, 'prompt', '[]', 'previewed', '2026-06-03T00:00:00.000Z');
}

function aiTurnResult(characterId: string, hidden = false): AiTurnResult {
  return {
    objectiveLog: 'objective',
    publicLog: 'public',
    privateUpdatesByPlayer: {},
    ruleResults: [],
    interactionRequests: [],
    suggestedStateChanges: [],
    characterResourceChanges: [],
    diceRequests: [{
      characterId,
      type: 'skillCheck',
      ability: 'str',
      skill: 'Athletics',
      dc: 15,
      reason: '撬开铁门',
      isHidden: hidden
    }]
  };
}

describe('turnResolutionService', () => {
  it('saves deterministic dice results for a resolution run', () => {
    const db = createMemoryDb();
    migrate(db);
    try {
      const { roomId, turnId, characterId } = seedRoom(db);
      insertPreview(db, 'preview-1', roomId, turnId);
      insertPreview(db, 'preview-2', roomId, turnId);

      const first = createTurnResolutionRun(db, {
        previewId: 'preview-1',
        roomId,
        turnId,
        result: aiTurnResult(characterId),
        seed: 'stable-seed'
      });
      const second = createTurnResolutionRun(db, {
        previewId: 'preview-2',
        roomId,
        turnId,
        result: aiTurnResult(characterId),
        seed: 'stable-seed'
      });
      const row = db.prepare('SELECT resolution_run_id as resolutionRunId FROM ai_turn_previews WHERE id = ?').get('preview-1') as { resolutionRunId: string };
      const loaded = loadTurnResolutionRun(db, first.id);

      expect(row.resolutionRunId).toBe(first.id);
      expect(loaded?.seed).toBe('stable-seed');
      expect(first.diceLogs).toHaveLength(1);
      expect(second.diceLogs[0].values).toEqual(first.diceLogs[0].values);
      expect(second.diceLogs[0].total).toBe(first.diceLogs[0].total);
      expect(first.events[0]).toMatchObject({ eventType: 'DICE_ROLLED', visibilityScope: 'public' });
    } finally {
      db.close();
    }
  });

  it('applies saved dice results without rerolling and routes hidden dice privately', () => {
    const db = createMemoryDb();
    migrate(db);
    try {
      const { roomId, turnId, playerId, characterId } = seedRoom(db);
      insertPreview(db, 'preview-hidden', roomId, turnId);
      const run = createTurnResolutionRun(db, {
        previewId: 'preview-hidden',
        roomId,
        turnId,
        result: aiTurnResult(characterId, true),
        seed: 'hidden-seed'
      });
      const result = aiTurnResult(characterId, true);

      applyResolutionRunToAiTurnResult(db, result, run);

      expect(result.diceResults?.[0].id).toBe(run.diceLogs[0].id);
      expect(result.publicLog).toBe('public');
      expect(result.objectiveLog).toContain('隐藏骰点（客观）');
      expect(result.privateUpdatesByPlayer[playerId]).not.toContain('🎲 隐藏骰点');
      expect(result.privateUpdatesByPlayer[playerId]).toContain('撬开铁门');
    } finally {
      db.close();
    }
  });

  it('infers wisdom for perception checks when AI omits ability', () => {
    const db = createMemoryDb();
    migrate(db);
    try {
      const { roomId, turnId, characterId } = seedRoom(db);
      const row = db.prepare('SELECT sheet_json as sheetJson FROM characters WHERE id = ?').get(characterId) as { sheetJson: string };
      const sheet = JSON.parse(row.sheetJson) as Record<string, unknown>;
      sheet.abilityScores = { str: 8, dex: 10, con: 10, int: 10, wis: 14, cha: 10 };
      sheet.skills = [];
      db.prepare('UPDATE characters SET sheet_json = ? WHERE id = ?').run(JSON.stringify(sheet), characterId);
      insertPreview(db, 'preview-perception', roomId, turnId);

      const result = createTurnResolutionRun(db, {
        previewId: 'preview-perception',
        roomId,
        turnId,
        result: {
          ...aiTurnResult(characterId),
          diceRequests: [{
            characterId,
            type: 'skillCheck',
            skill: 'perception',
            dc: 15,
            reason: '观察林线'
          }]
        },
        seed: 'perception-seed'
      });

      expect(result.diceLogs[0].modifier).toBe(2);
    } finally {
      db.close();
    }
  });

  it('persists game event sequences incrementally per room and turn', () => {
    const db = createMemoryDb();
    migrate(db);
    try {
      const { roomId, turnId } = seedRoom(db);
      persistGameEvents(db, [
        createTurnLogMaterializedEvent(roomId, turnId, { publicLog: 'one' }, '2026-06-03T00:00:01.000Z'),
        createTurnLogMaterializedEvent(roomId, turnId, { publicLog: 'two' }, '2026-06-03T00:00:02.000Z')
      ]);
      persistGameEvents(db, [
        createTurnLogMaterializedEvent(roomId, turnId, { publicLog: 'three' }, '2026-06-03T00:00:03.000Z')
      ]);

      const rows = db.prepare('SELECT sequence FROM game_events WHERE room_id = ? AND turn_id = ? ORDER BY sequence ASC')
        .all(roomId, turnId) as Array<{ sequence: number }>;
      expect(rows.map((row) => row.sequence)).toEqual([1, 2, 3]);
    } finally {
      db.close();
    }
  });
});
