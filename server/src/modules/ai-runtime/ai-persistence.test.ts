import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../../platform/database/SqliteDatabaseAdapter.js';
import { AiRunRepository, type AiRunInsertRow } from './AiRunRepository.js';
import { TurnEntryRepository, type TurnEntryInsertRow } from './TurnEntryRepository.js';

async function seedCampaign(db: ReturnType<typeof createSqliteDatabase>, campaignId: string, turnId: string): Promise<void> {
  const ownerId = `owner-${campaignId}`;
  const now = new Date().toISOString();
  await db.execute('INSERT INTO users (id, login, password_hash) VALUES (?, ?, ?)', [ownerId, `${ownerId}@example.test`, 'hash']);
  await db.execute('INSERT INTO campaigns (id, owner_id, name, status, ruleset, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [campaignId, ownerId, `c-${campaignId}`, 'setup', 'dnd5e', now, now]);
  await db.execute('INSERT INTO platform_turns (id, campaign_id, number, status, locked_at, completed_at, created_at, updated_at) VALUES (?, ?, 1, ?, ?, NULL, ?, ?)', [turnId, campaignId, 'locked', now, now, now]);
}

describe('ai runtime persistence', () => {
  it('allocates per-campaign ai run sequences atomically', async () => {
    const db = createSqliteDatabase(':memory:');
    try {
      await db.migrate();
      await seedCampaign(db, 'c1', 't1');
      const repo = new AiRunRepository(db);
      const seq1 = await db.transaction((tx) => repo.nextCampaignSequence(tx, 'c1'));
      const seq2 = await db.transaction((tx) => repo.nextCampaignSequence(tx, 'c1'));
      expect(seq1).toBe(1);
      expect(seq2).toBe(2);
    } finally {
      await db.close();
    }
  });

  it('rolls back run and sequence counter together', async () => {
    const db = createSqliteDatabase(':memory:');
    try {
      await db.migrate();
      await seedCampaign(db, 'c1', 't1');
      const repo = new AiRunRepository(db);
      await expect(db.transaction(async (tx) => {
        // 先分配 campaign_sequence（counter 写入与 run 同 tx），再插 run，整体回滚。
        const seq = await repo.nextCampaignSequence(tx, 'c1');
        await repo.insertRun(tx, runRow('run-1', 'c1', 't1', 1, 'k1', seq));
        throw new Error('abort');
      })).rejects.toThrow('abort');
      expect(await repo.listByTurn('t1')).toEqual([]);
      const counters = await db.query<{ campaign_id: string }>('SELECT campaign_id FROM platform_ai_run_sequences');
      expect(counters).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it('enforces UNIQUE(turn, attempt) and UNIQUE(campaign, idempotency_key)', async () => {
    const db = createSqliteDatabase(':memory:');
    try {
      await db.migrate();
      await seedCampaign(db, 'c1', 't1');
      const repo = new AiRunRepository(db);
      // campaign_sequence 用 1/2/3 区分，使每个断言只命中目标 UNIQUE 约束。
      await db.transaction((tx) => repo.insertRun(tx, runRow('run-1', 'c1', 't1', 1, 'k1', 1)));
      await expect(db.transaction((tx) => repo.insertRun(tx, runRow('run-2', 'c1', 't1', 1, 'k2', 2)))).rejects.toThrow(); // UNIQUE(turn, attempt)
      await expect(db.transaction((tx) => repo.insertRun(tx, runRow('run-3', 'c1', 't1', 2, 'k1', 3)))).rejects.toThrow(); // UNIQUE(campaign, idempotency)
    } finally {
      await db.close();
    }
  });

  it('supersedes runs/entries/requests by the ai run campaign watermark', async () => {
    const db = createSqliteDatabase(':memory:');
    try {
      await db.migrate();
      await seedCampaign(db, 'c1', 't1');
      const runs = new AiRunRepository(db);
      const entries = new TurnEntryRepository(db);
      await db.transaction(async (tx) => {
        await runs.insertRun(tx, runRow('run-1', 'c1', 't1', 1, 'k1', 1));
        await runs.insertRun(tx, runRow('run-2', 'c1', 't1', 2, 'k2', 2));
        await entries.insertEntry(tx, entryRow('e1', 'run-2', 't1', 'c1', 0));
      });
      const now = new Date().toISOString();
      // superseded_by_archive_id 有 FK → 先插入真实 platform_archives 行（含必要 owner/campaign/archive sequence 前置），
      // 再用它的 id，不能传不存在的 'arch-9' 撞 FK。
      await db.execute('INSERT INTO platform_archive_sequences (campaign_id, last_version) VALUES (?, ?)', ['c1', 1]);
      await db.execute(
        `INSERT INTO platform_archives
          (id, campaign_id, kind, turn_id, label, version, state_json, created_by_user_id, superseded_at, superseded_by_archive_id, created_at)
         VALUES (?, ?, 'automatic', ?, NULL, 1, '{}', ?, NULL, NULL, ?)`,
        ['arch-9', 'c1', 't1', 'owner-c1', now],
      );
      await db.transaction((tx) => runs.supersedeByWatermark(tx, 'c1', 'arch-9', 1, now));
      // run-1 (seq 1) 保留；run-2 (seq 2) 与它的 entries supersede。
      expect((await runs.listByTurn('t1')).map((r) => r.id)).toEqual(['run-1']);
      expect(await entries.listByTurn('t1')).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it('enforces the turn entry visibility/target CHECK', async () => {
    const db = createSqliteDatabase(':memory:');
    try {
      await db.migrate();
      await seedCampaign(db, 'c1', 't1');
      await db.execute('INSERT INTO users (id, login, password_hash) VALUES (?, ?, ?)', ['p1', 'p1@example.test', 'hash']);
      const runs = new AiRunRepository(db);
      const entries = new TurnEntryRepository(db);
      await db.transaction((tx) => runs.insertRun(tx, runRow('run-1', 'c1', 't1', 1, 'k1', 1)));
      // player_private 必须有目标玩家：null target 违反 CHECK。
      await expect(db.transaction(async (tx) => {
        await entries.insertEntry(tx, { ...entryRow('e1', 'run-1', 't1', 'c1', 0), visibility: 'player_private', target_player_id: null });
      })).rejects.toThrow(/CHECK constraint failed/);
      // public 不得带目标玩家：有 target 违反 CHECK。
      await expect(db.transaction(async (tx) => {
        await entries.insertEntry(tx, { ...entryRow('e2', 'run-1', 't1', 'c1', 1), visibility: 'public', target_player_id: 'p1' });
      })).rejects.toThrow(/CHECK constraint failed/);
    } finally {
      await db.close();
    }
  });

  it('keeps provider_id separate from the internal request id', async () => {
    const db = createSqliteDatabase(':memory:');
    try {
      await db.migrate();
      await seedCampaign(db, 'c1', 't1');
      await db.execute('INSERT INTO users (id, login, password_hash) VALUES (?, ?, ?)', ['p1', 'p1@example.test', 'hash']);
      const runs = new AiRunRepository(db);
      const entries = new TurnEntryRepository(db);
      const now = new Date().toISOString();
      await db.transaction(async (tx) => {
        await runs.insertRun(tx, runRow('run-1', 'c1', 't1', 1, 'k1', 1));
        // 内部主键是 nanoid；provider_id 是 provider 输出里的短引用 id，可跨 run 复用。
        await entries.insertInteractionRequest(tx, { id: 'req-a', provider_id: 'i1', campaign_id: 'c1', turn_id: 't1', ai_run_id: 'run-1', target_player_id: 'p1', prompt: '酒馆老板等待回答。', created_at: now });
        await entries.insertInteractionRequest(tx, { id: 'req-b', provider_id: 'i1', campaign_id: 'c1', turn_id: 't1', ai_run_id: 'run-1', target_player_id: 'p1', prompt: '另一条请求。', created_at: now });
      });
      const rows = await db.query<{ id: string; provider_id: string }>('SELECT id, provider_id FROM platform_interaction_requests ORDER BY created_at');
      expect(rows.map((r) => r.id)).toEqual(['req-a', 'req-b']);
      expect(rows.map((r) => r.provider_id)).toEqual(['i1', 'i1']);
    } finally {
      await db.close();
    }
  });
});

function runRow(id: string, campaignId: string, turnId: string, attempt: number, idempotencyKey: string, campaignSequence = 0): AiRunInsertRow {
  const now = new Date().toISOString();
  return {
    id, campaign_id: campaignId, campaign_sequence: campaignSequence, turn_id: turnId, attempt,
    idempotency_key: idempotencyKey, provider: 'scripted', model: 'scripted',
    status: 'running', context_json: '{}', result_json: null, error_code: null,
    error_json: null, raw_debug_json: null, started_at: now, completed_at: null,
  };
}

function entryRow(id: string, aiRunId: string, turnId: string, campaignId: string, entryIndex: number): TurnEntryInsertRow {
  return {
    id, ai_run_id: aiRunId, turn_id: turnId, campaign_id: campaignId,
    entry_kind: 'narrative', entry_index: entryIndex, visibility: 'public',
    target_player_id: null, payload_json: '{"text":"x"}', created_at: new Date().toISOString(),
  };
}
