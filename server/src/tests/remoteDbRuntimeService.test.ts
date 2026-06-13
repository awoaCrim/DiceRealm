import { describe, expect, it } from 'vitest';
import { createMemoryDb } from '../db/connection.js';
import { migrate } from '../db/schema.js';
import { applyPluginDatabaseChange } from '../services/remoteDbRuntimeService.js';

function seedRoom(db: ReturnType<typeof createMemoryDb>): void {
  db.prepare(`
    INSERT INTO rooms (id, name, system_prompt, world_info, current_turn, status, expected_player_count, ai_config_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('room-1', '测试房间', '', '', 1, 'ready_to_resolve', 1, '{}', '2026-06-10T00:00:00.000Z');
}

describe('remoteDbRuntimeService', () => {
  it('does not block on missing virtual narrative state sheets', () => {
    const db = createMemoryDb();
    migrate(db);
    try {
      seedRoom(db);

      for (const targetId of ['campaign_state', 'sheet:campaign_state', 'combat_state', 'sheet:combat_state/active']) {
        const outcome = applyPluginDatabaseChange(db, 'room-1', {
          changeType: 'database_row_upsert',
          targetId,
          rowKey: 'state',
          after: { value: '辅助状态' }
        });

        expect(outcome).toEqual({ applied: false });
      }
    } finally {
      db.close();
    }
  });

  it('still reports pending admin review for unknown non-virtual sheets', () => {
    const db = createMemoryDb();
    migrate(db);
    try {
      seedRoom(db);

      const outcome = applyPluginDatabaseChange(db, 'room-1', {
        changeType: 'database_row_upsert',
        targetId: 'sheet:missing_sheet',
        rowKey: 'state',
        after: { value: 'changed' }
      });

      expect(outcome.applied).toBe(false);
      expect(outcome.message).toContain('Pending admin review');
    } finally {
      db.close();
    }
  });
});
