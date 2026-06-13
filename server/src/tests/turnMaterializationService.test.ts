import { describe, expect, it } from 'vitest';
import { createMemoryDb } from '../db/connection.js';
import { migrate } from '../db/schema.js';
import type { AiTurnResult, Player, Room, Turn } from '../domain/types.js';
import { defaultAiConfig } from '../services/aiContextBuilder.js';
import { materializeAiTurnResult } from '../services/turnMaterializationService.js';
import { createTurnResolutionRun } from '../services/turnResolutionService.js';

const now = '2026-06-07T00:00:00.000Z';

function seedTurn(db: ReturnType<typeof createMemoryDb>): { room: Room; turn: Turn; players: Player[] } {
  db.prepare(`
    INSERT INTO rooms (id, name, system_prompt, world_info, current_turn, status, expected_player_count, ai_config_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('room-1', '测试房间', '', '', 1, 'ready_to_resolve', 1, JSON.stringify(defaultAiConfig), now);
  db.prepare('INSERT INTO turns (id, room_id, number, status, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('turn-1', 'room-1', 1, 'ready_to_resolve', now, null);
  db.prepare('INSERT INTO players (id, room_id, name, token, is_connected, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('player-1', 'room-1', '娜雅', 'token-1', 1, now);
  db.prepare(`
    INSERT INTO ai_turn_previews (id, room_id, turn_id, original_prompt, suggested_state_changes_json, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('preview-1', 'room-1', 'turn-1', 'prompt', '[]', 'previewed', now);

  return {
    room: {
      id: 'room-1',
      name: '测试房间',
      systemPrompt: '',
      worldInfo: '',
      currentTurn: 1,
      status: 'ready_to_resolve',
      expectedPlayerCount: 1,
      aiConfig: defaultAiConfig,
      createdAt: now
    },
    turn: {
      id: 'turn-1',
      roomId: 'room-1',
      number: 1,
      status: 'ready_to_resolve',
      startedAt: now,
      endedAt: null
    },
    players: [{
      id: 'player-1',
      roomId: 'room-1',
      name: '娜雅',
      token: 'token-1',
      isConnected: true,
      createdAt: now
    }]
  };
}

function baseResult(suggestedStateChanges: Array<Record<string, unknown>>): AiTurnResult {
  return {
    objectiveLog: '客观记录。',
    publicLog: '公开记录。',
    privateUpdatesByPlayer: {},
    ruleResults: [],
    interactionRequests: [],
    suggestedStateChanges,
    characterResourceChanges: [],
    diceRequests: []
  };
}

describe('turnMaterializationService', () => {
  it('does not treat native combat state suggestions as missing plugin database sheets', () => {
    const db = createMemoryDb();
    migrate(db);
    try {
      const { room, turn, players } = seedTurn(db);
      const result = baseResult([{
        changeType: 'database_row_upsert',
        targetId: 'sheet:combat_state',
        rowKey: 'active',
        after: { status: 'active' }
      }]);
      const resolutionRun = createTurnResolutionRun(db, {
        previewId: 'preview-1',
        roomId: room.id,
        turnId: turn.id,
        result,
        seed: 'native-combat-state'
      });

      const outcome = materializeAiTurnResult(db, {
        room,
        turn,
        players,
        actions: [],
        result,
        resolutionRun,
        providerName: 'test',
        inputSummary: 'test input',
        ruleMatches: []
      });

      const generation = db.prepare('SELECT error FROM ai_generations WHERE room_id = ?').get(room.id) as { error: string | null };
      expect(outcome.resourceErrors).toEqual([]);
      expect(generation.error).toBeNull();
    } finally {
      db.close();
    }
  });

  it('keeps virtual campaign state suggestions out of plugin database errors', () => {
    const db = createMemoryDb();
    migrate(db);
    try {
      const { room, turn, players } = seedTurn(db);
      const result = baseResult([{
        changeType: 'database_row_upsert',
        targetId: 'campaign_state',
        rowKey: 'opening-road',
        after: { tension: 'rising' },
        reason: '记录本回合战役状态建议。'
      }]);
      const resolutionRun = createTurnResolutionRun(db, {
        previewId: 'preview-1',
        roomId: room.id,
        turnId: turn.id,
        result,
        seed: 'virtual-campaign-state'
      });

      const outcome = materializeAiTurnResult(db, {
        room,
        turn,
        players,
        actions: [],
        result,
        resolutionRun,
        providerName: 'test',
        inputSummary: 'test input',
        ruleMatches: []
      });

      const generation = db.prepare('SELECT error FROM ai_generations WHERE room_id = ?').get(room.id) as { error: string | null };
      expect(outcome.resourceErrors).toEqual([]);
      expect(generation.error).toBeNull();
    } finally {
      db.close();
    }
  });

  it('rolls back the whole materialization when a plugin database change fails', () => {
    const db = createMemoryDb();
    migrate(db);
    try {
      const { room, turn, players } = seedTurn(db);
      const result = baseResult([{
        changeType: 'database_row_upsert',
        targetId: 'sheet:missing_sheet',
        rowKey: 'active',
        after: { status: 'active' }
      }]);
      const resolutionRun = createTurnResolutionRun(db, {
        previewId: 'preview-1',
        roomId: room.id,
        turnId: turn.id,
        result,
        seed: 'missing-plugin-sheet'
      });

      expect(() => materializeAiTurnResult(db, {
        room,
        turn,
        players,
        actions: [],
        result,
        resolutionRun,
        providerName: 'test',
        inputSummary: 'test input',
        ruleMatches: []
      })).toThrow('Pending admin review: plugin database sheet not found or not enabled: sheet:missing_sheet');

      const logCount = db.prepare('SELECT COUNT(*) as count FROM log_entries WHERE room_id = ?').get(room.id) as { count: number };
      const nextTurn = db.prepare('SELECT id FROM turns WHERE room_id = ? AND number = ?').get(room.id, 2);
      const run = db.prepare('SELECT status FROM turn_resolution_runs WHERE id = ?').get(resolutionRun.id) as { status: string };
      expect(logCount.count).toBe(0);
      expect(nextTurn).toBeUndefined();
      expect(run.status).toBe('previewed');
    } finally {
      db.close();
    }
  });
});
