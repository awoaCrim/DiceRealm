import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from './SqliteDatabaseAdapter.js';
import { OutboxRepository } from '../events/OutboxRepository.js';
import { TurnRepository } from '../../modules/turns/TurnRepository.js';
import { WorldFactRepository } from '../../modules/world/WorldFactRepository.js';

async function seedCampaign(db: ReturnType<typeof createSqliteDatabase>, campaignId: string): Promise<void> {
  const ownerId = `owner-${campaignId}`;
  const now = new Date().toISOString();
  await db.execute('INSERT INTO users (id, login, password_hash) VALUES (?, ?, ?)', [ownerId, `${ownerId}@example.test`, 'hash']);
  await db.execute(
    'INSERT INTO campaigns (id, owner_id, name, status, ruleset, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [campaignId, ownerId, `campaign-${campaignId}`, 'setup', 'dnd5e', now, now],
  );
}

describe('007 superseded foundations', () => {
  it('adds superseded columns to turns/world_facts/outbox_events', async () => {
    const db = createSqliteDatabase(':memory:');
    try {
      await db.migrate();
      const turnCols = await db.query<{ name: string }>('PRAGMA table_info(platform_turns)');
      expect(turnCols.map((c) => c.name)).toEqual(expect.arrayContaining(['superseded_at', 'superseded_by_archive_id']));
      const factCols = await db.query<{ name: string }>('PRAGMA table_info(platform_world_facts)');
      expect(factCols.map((c) => c.name)).toEqual(expect.arrayContaining(['superseded_at', 'superseded_by_archive_id']));
      const outboxCols = await db.query<{ name: string }>('PRAGMA table_info(platform_outbox_events)');
      expect(outboxCols.map((c) => c.name)).toEqual(expect.arrayContaining(['superseded_at', 'superseded_by_archive_id']));
    } finally {
      await db.close();
    }
  });

  it('excludes superseded rows from default active queries', async () => {
    const db = createSqliteDatabase(':memory:');
    try {
      await db.migrate();
      await seedCampaign(db, 'c1');
      const now = new Date().toISOString();
      await db.execute(
        "INSERT INTO platform_turns (id, campaign_id, number, status, locked_at, completed_at, created_at, updated_at) VALUES (?, ?, 1, 'completed', NULL, ?, ?, ?)",
        ['t1', 'c1', now, now, now],
      );
      await db.execute(
        "INSERT INTO platform_turns (id, campaign_id, number, status, locked_at, completed_at, created_at, updated_at) VALUES (?, ?, 2, 'waiting_for_actions', NULL, NULL, ?, ?)",
        ['t2', 'c1', now, now],
      );
      // 2 号回合被某次恢复 supersede：默认查询不应再把它当进行中回合。
      await db.execute('UPDATE platform_turns SET superseded_at = ?, superseded_by_archive_id = ? WHERE id = ?', [now, 'arch-1', 't2']);
      const turns = new TurnRepository(db);
      expect(await turns.findUnfinishedTurn('c1')).toBeNull();
      expect((await turns.listByCampaign('c1')).map((r) => r.id)).toEqual(['t1']);
      // maxTurnNumber 必须包含 superseded：恢复后新回合不得复用 2 号。
      expect(await turns.maxTurnNumber('c1')).toBe(2);
      // lockTurnRow 对 superseded 回合返回未命中（改不了已恢复覆盖的历史回合）。
      expect(await turns.lockTurnRow('t2', 'c1')).toBe(false);
    } finally {
      await db.close();
    }
  });

  it('excludes superseded world facts and outbox events but keeps audit queries', async () => {
    const db = createSqliteDatabase(':memory:');
    try {
      await db.migrate();
      await seedCampaign(db, 'c1');
      const repo = new WorldFactRepository(db);
      await repo.insert({
        id: 'f-active', campaign_id: 'c1', title: '酒馆', kind: 'location', content: '热闹。',
        visibility: 'public', known_by_json: '[]', created_at: 'now', updated_at: 'now',
      });
      await repo.insert({
        id: 'f-dead', campaign_id: 'c1', title: '旧密信', kind: 'item', content: 'x',
        visibility: 'player_private', known_by_json: '["p1"]', created_at: 'now', updated_at: 'now',
      });
      await db.execute('UPDATE platform_world_facts SET superseded_at = ? WHERE id = ?', ['now', 'f-dead']);
      expect((await repo.listByCampaign('c1')).map((r) => r.id)).toEqual(['f-active']);

      const outbox = new OutboxRepository(db);
      await db.transaction((tx) => outbox.publishIn(tx, { type: 'turn.locked', campaignId: 'c1', turnId: 't1' }));
      await db.transaction((tx) => outbox.publishIn(tx, { type: 'turn.locked', campaignId: 'c1', turnId: 't2' }));
      await db.execute('UPDATE platform_outbox_events SET superseded_at = ? WHERE sequence = 1', ['now']);
      expect((await outbox.listByCampaign('c1')).map((r) => r.sequence)).toEqual([2]);
      expect((await outbox.listUnpublished('c1')).map((r) => r.sequence)).toEqual([2]);
      // 审计全量查询保留 superseded 行。
      expect((await outbox.listAllByCampaign('c1')).map((r) => r.sequence)).toEqual([1, 2]);
    } finally {
      await db.close();
    }
  });
});
