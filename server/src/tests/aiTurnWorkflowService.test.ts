import { describe, expect, it } from 'vitest';
import { createMemoryDb } from '../db/connection.js';
import { migrate } from '../db/schema.js';
import type { AiTurnResult, CharacterSheet } from '../domain/types.js';
import { applyAiTurnPreview, buildPostResolutionNarrationPrompt, combinePostResolutionResult, createAiTurnPreview } from '../services/aiTurnWorkflowService.js';
import { createTurnResolutionRun } from '../services/turnResolutionService.js';

function seedCharacterRoom(db: ReturnType<typeof createMemoryDb>) {
  const now = '2026-06-06T00:00:00.000Z';
  const sheet: CharacterSheet = {
    name: '娜雅',
    species: '人类',
    className: '游荡者',
    level: 1,
    abilityScores: { str: 10, dex: 14, con: 12, int: 10, wis: 10, cha: 10 },
    hitPoints: { current: 9, max: 9 },
    armorClass: 14,
    proficiencyBonus: 2,
    skills: ['perception'],
    equipment: [],
    spells: [],
    privateNotes: ''
  };
  db.prepare(`
    INSERT INTO rooms (id, name, system_prompt, world_info, current_turn, status, expected_player_count, ai_config_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('room-1', '测试房间', '', '', 1, 'ready_to_resolve', 1, '{}', now);
  db.prepare('INSERT INTO turns (id, room_id, number, status, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('turn-1', 'room-1', 1, 'ready_to_resolve', now, null);
  db.prepare('INSERT INTO players (id, room_id, name, token, is_connected, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('player-1', 'room-1', 'wwaksx', 'token-1', 0, now);
  db.prepare('INSERT INTO characters (id, player_id, sheet_json, draft_source, confirmed, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('char-1', 'player-1', JSON.stringify(sheet), 'manual', 1, now);
}

function baseResult(): AiTurnResult {
  return {
    objectiveLog: '娜雅准备观察林线。',
    publicLog: '娜雅停下脚步，警惕地扫视路旁林线。',
    privateUpdatesByPlayer: {
      'player-1': '你试图确认现场是否有其他活人或潜伏生物，请等待系统进行察觉检定。'
    },
    ruleResults: [],
    interactionRequests: [],
    diceRequests: [{
      characterId: 'char-1',
      type: 'skillCheck',
      skill: 'perception',
      dc: 15,
      reason: '观察林线与四周是否有潜伏威胁'
    }],
    suggestedStateChanges: [],
    characterResourceChanges: []
  };
}

describe('aiTurnWorkflowService', () => {
  it('keeps narrative voice rules in post-roll rewrite prompts', () => {
    const db = createMemoryDb();
    migrate(db);
    try {
      seedCharacterRoom(db);
      db.prepare(`
        INSERT INTO ai_turn_previews (id, room_id, turn_id, original_prompt, suggested_state_changes_json, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('preview-voice', 'room-1', 'turn-1', 'prompt', '[]', 'previewed', '2026-06-06T00:00:00.000Z');
      const run = createTurnResolutionRun(db, {
        previewId: 'preview-voice',
        roomId: 'room-1',
        turnId: 'turn-1',
        result: baseResult(),
        seed: 'voice-rules'
      });

      const prompt = buildPostResolutionNarrationPrompt('Original prompt', baseResult(), run, ['player-1']);

      expect(prompt).toContain('publicLog and objectiveLog in third person or objective narration');
      expect(prompt).toContain('privateUpdatesByPlayer in second person');
    } finally {
      db.close();
    }
  });

  it('keeps post-roll public narration and replaces preliminary private narration for private dice', () => {
    const db = createMemoryDb();
    migrate(db);
    try {
      seedCharacterRoom(db);
      db.prepare(`
        INSERT INTO ai_turn_previews (id, room_id, turn_id, original_prompt, suggested_state_changes_json, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('preview-1', 'room-1', 'turn-1', 'prompt', '[]', 'previewed', '2026-06-06T00:00:00.000Z');
      const preliminary = baseResult();
      const run = createTurnResolutionRun(db, {
        previewId: 'preview-1',
        roomId: 'room-1',
        turnId: 'turn-1',
        result: preliminary,
        seed: 'private-perception'
      });
      const post: AiTurnResult = {
        ...preliminary,
        publicLog: '娜雅没有发现新的身影。队伍仍站在雨中的道路上，前方倒毙的马匹让气氛更加压抑。',
        objectiveLog: '察觉检定失败，隐藏威胁仍未被发现。',
        privateUpdatesByPlayer: {
          'player-1': '你仔细观察林线和道路，没有发现其他活动人影。'
        },
        diceRequests: []
      };

      const combined = combinePostResolutionResult(db, preliminary, post, run);

      expect(combined.publicLog).toContain('娜雅没有发现新的身影');
      expect(combined.publicLog).not.toContain('娜雅停下脚步');
      expect(combined.publicLog).not.toContain('系统骰点');
      expect(combined.objectiveLog).toContain('察觉检定失败');
      expect(combined.objectiveLog).not.toContain('娜雅准备观察林线');
      expect(combined.privateUpdatesByPlayer['player-1']).toContain('你仔细观察林线和道路');
      expect(combined.privateUpdatesByPlayer['player-1']).not.toContain('请等待系统进行察觉检定');
    } finally {
      db.close();
    }
  });

  it('keeps a failed apply retryable and allows the same preview to be applied after fixing the cause', async () => {
    const db = createMemoryDb();
    migrate(db);
    try {
      seedCharacterRoom(db);
      db.prepare(`
        INSERT INTO actions (id, room_id, turn_id, player_id, text, submitted_at, status, action_type, visibility, is_hidden_roll)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('action-1', 'room-1', 'turn-1', 'player-1', '观察林线', '2026-06-06T00:00:01.000Z', 'submitted', 'observe', 'public', 0);
      db.prepare('INSERT INTO turns (id, room_id, number, status, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('turn-2-blocker', 'room-1', 2, 'open', '2026-06-06T00:00:02.000Z', null);
      db.prepare(`
        INSERT INTO ai_turn_previews (id, room_id, turn_id, original_prompt, edited_prompt, response_text, suggested_state_changes_json, raw_json, status, created_at, sent_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'preview-retry',
        'room-1',
        'turn-1',
        'prompt',
        'prompt',
        '公开记录。',
        '[]',
        JSON.stringify({
          ...baseResult(),
          objectiveLog: '客观记录。',
          publicLog: '公开记录。',
          privateUpdatesByPlayer: {},
          diceRequests: []
        }),
        'sent',
        '2026-06-06T00:00:00.000Z',
        '2026-06-06T00:00:00.000Z'
      );
      const run = createTurnResolutionRun(db, {
        previewId: 'preview-retry',
        roomId: 'room-1',
        turnId: 'turn-1',
        result: {
          ...baseResult(),
          diceRequests: []
        },
        seed: 'retry-apply'
      });

      await expect(applyAiTurnPreview(db, {
        roomId: 'room-1',
        previewId: 'preview-retry',
        confirmedSuggestedStateChangeIndexes: [],
        confirmedCharacterResourceChangeIndexes: []
      })).rejects.toMatchObject({ statusCode: 500 });

      const failedRoom = db.prepare('SELECT status FROM rooms WHERE id = ?').get('room-1') as { status: string };
      const failedTurn = db.prepare('SELECT status FROM turns WHERE id = ?').get('turn-1') as { status: string };
      const failedPreview = db.prepare('SELECT status, error_message as errorMessage FROM ai_turn_previews WHERE id = ?')
        .get('preview-retry') as { status: string; errorMessage: string | null };
      expect(failedRoom.status).toBe('ready_to_resolve');
      expect(failedTurn.status).toBe('ready_to_resolve');
      expect(failedPreview.status).toBe('sent');
      expect(failedPreview.errorMessage).toBeTruthy();

      db.prepare('DELETE FROM turns WHERE id = ?').run('turn-2-blocker');
      const applied = await applyAiTurnPreview(db, {
        roomId: 'room-1',
        previewId: 'preview-retry',
        confirmedSuggestedStateChangeIndexes: [],
        confirmedCharacterResourceChangeIndexes: []
      });

      const appliedRun = db.prepare('SELECT status FROM turn_resolution_runs WHERE id = ?').get(run.id) as { status: string };
      expect(applied.applied).toBe(true);
      expect(appliedRun.status).toBe('applied');
    } finally {
      db.close();
    }
  });

  it('rolls back all turn changes when confirmed state changes fail during apply', async () => {
    const db = createMemoryDb();
    migrate(db);
    try {
      seedCharacterRoom(db);
      db.prepare(`
        INSERT INTO actions (id, room_id, turn_id, player_id, text, submitted_at, status, action_type, visibility, is_hidden_roll)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('action-1', 'room-1', 'turn-1', 'player-1', '观察林线', '2026-06-06T00:00:01.000Z', 'submitted', 'observe', 'public', 0);
      const result: AiTurnResult = {
        ...baseResult(),
        objectiveLog: '客观记录。',
        publicLog: '公开记录。',
        privateUpdatesByPlayer: {},
        diceRequests: [],
        suggestedStateChanges: [{
          changeType: 'database_row_upsert',
          targetId: 'sheet:missing_sheet',
          rowKey: 'state',
          after: { value: 'changed' }
        }]
      };
      db.prepare(`
        INSERT INTO ai_turn_previews (id, room_id, turn_id, original_prompt, edited_prompt, response_text, suggested_state_changes_json, raw_json, status, created_at, sent_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'preview-state-error',
        'room-1',
        'turn-1',
        'prompt',
        'prompt',
        result.publicLog,
        JSON.stringify([{ type: 'suggested_state_change', ...result.suggestedStateChanges?.[0] }]),
        JSON.stringify(result),
        'sent',
        '2026-06-06T00:00:00.000Z',
        '2026-06-06T00:00:00.000Z'
      );
      createTurnResolutionRun(db, {
        previewId: 'preview-state-error',
        roomId: 'room-1',
        turnId: 'turn-1',
        result,
        seed: 'state-change-rollback'
      });

      await expect(applyAiTurnPreview(db, {
        roomId: 'room-1',
        previewId: 'preview-state-error',
        confirmedSuggestedStateChangeIndexes: [0],
        confirmedCharacterResourceChangeIndexes: []
      })).rejects.toMatchObject({ statusCode: 500 });

      const logCountAfterFailure = db.prepare('SELECT COUNT(*) as count FROM log_entries WHERE room_id = ?').get('room-1') as { count: number };
      const turnTwoAfterFailure = db.prepare('SELECT id FROM turns WHERE room_id = ? AND number = ?').get('room-1', 2);
      const turnAfterFailure = db.prepare('SELECT status FROM turns WHERE id = ?').get('turn-1') as { status: string };
      expect(logCountAfterFailure.count).toBe(0);
      expect(turnTwoAfterFailure).toBeUndefined();
      expect(turnAfterFailure.status).toBe('ready_to_resolve');

      const applied = await applyAiTurnPreview(db, {
        roomId: 'room-1',
        previewId: 'preview-state-error',
        confirmedSuggestedStateChangeIndexes: [],
        confirmedCharacterResourceChangeIndexes: []
      });
      const logCountAfterRetry = db.prepare('SELECT COUNT(*) as count FROM log_entries WHERE room_id = ?').get('room-1') as { count: number };
      const turnTwoAfterRetry = db.prepare('SELECT id FROM turns WHERE room_id = ? AND number = ?').get('room-1', 2);
      expect(applied.applied).toBe(true);
      expect(logCountAfterRetry.count).toBe(2);
      expect(turnTwoAfterRetry).toBeTruthy();
    } finally {
      db.close();
    }
  });

  it('recovers an old needs-admin-attention apply failure when regenerating', async () => {
    const db = createMemoryDb();
    migrate(db);
    try {
      seedCharacterRoom(db);
      db.prepare(`
        INSERT INTO actions (id, room_id, turn_id, player_id, text, submitted_at, status, action_type, visibility, is_hidden_roll)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('action-1', 'room-1', 'turn-1', 'player-1', '观察林线', '2026-06-06T00:00:01.000Z', 'submitted', 'observe', 'public', 0);
      db.prepare('UPDATE rooms SET status = ? WHERE id = ?').run('needs_admin_attention', 'room-1');
      db.prepare('UPDATE turns SET status = ? WHERE id = ?').run('needs_admin_attention', 'turn-1');

      const preview = await createAiTurnPreview(db, 'room-1');
      const room = db.prepare('SELECT status FROM rooms WHERE id = ?').get('room-1') as { status: string };
      const turn = db.prepare('SELECT status FROM turns WHERE id = ?').get('turn-1') as { status: string };

      expect(preview.previewId).toBeTruthy();
      expect(room.status).toBe('ready_to_resolve');
      expect(turn.status).toBe('ready_to_resolve');
    } finally {
      db.close();
    }
  });
});
