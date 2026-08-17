import { describe, expect, it } from 'vitest';
import type { CampaignEvent } from '@dnd/contracts';
import { createSqliteDatabase, type SqliteDatabaseAdapter } from '../database/SqliteDatabaseAdapter.js';
import { OutboxRepository } from './OutboxRepository.js';

const locked = (campaignId: string, turnId = 't1'): CampaignEvent =>
  ({ type: 'turn.locked', campaignId, turnId });
const submitted = (campaignId: string, playerId: string): CampaignEvent =>
  ({ type: 'turn.action_submitted', campaignId, turnId: 't1', playerId });

/**
 * 内存库没有 campaign：platform_outbox_sequences.campaign_id 有 FK REFERENCES campaigns(id)，
 * 发布前必须先插入唯一 owner user 与 campaign（created_at/updated_at 等必填列）。
 * 保留 FK 作为不变量，不删除。
 */
async function seedCampaign(db: SqliteDatabaseAdapter, campaignId: string): Promise<void> {
  const ownerId = `owner-${campaignId}`;
  const now = new Date().toISOString();
  await db.execute(
    'INSERT INTO users (id, login, password_hash) VALUES (?, ?, ?)',
    [ownerId, `${ownerId}@example.test`, 'hash'],
  );
  await db.execute(
    'INSERT INTO campaigns (id, owner_id, name, status, ruleset, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [campaignId, ownerId, `campaign-${campaignId}`, 'setup', 'dnd5e', now, now],
  );
}

describe('outbox', () => {
  it('assigns independent per-campaign sequences', async () => {
    const db = createSqliteDatabase(':memory:');
    await db.migrate();
    await seedCampaign(db, 'c1');
    await seedCampaign(db, 'c2');
    const repo = new OutboxRepository(db);
    await db.transaction((tx) => repo.publishIn(tx, locked('c1')));
    await db.transaction((tx) => repo.publishIn(tx, locked('c1', 't2')));
    await db.transaction((tx) => repo.publishIn(tx, locked('c2')));
    expect((await repo.listByCampaign('c1')).map((row) => row.sequence)).toEqual([1, 2]);
    expect((await repo.listByCampaign('c2')).map((row) => row.sequence)).toEqual([1]);
    await db.close();
  });

  it('rolls back counter and event together with the business transaction', async () => {
    const db = createSqliteDatabase(':memory:');
    await db.migrate();
    await seedCampaign(db, 'c1');
    const repo = new OutboxRepository(db);
    await expect(db.transaction(async (tx) => {
      await repo.publishIn(tx, submitted('c1', 'p1'));
      throw new Error('abort');
    })).rejects.toThrow('abort');
    expect(await repo.listByCampaign('c1')).toEqual([]);
    const counters = await db.query<{ campaign_id: string }>(
      'SELECT campaign_id FROM platform_outbox_sequences',
    );
    expect(counters).toEqual([]);
    // 回滚无残留：下一次发布 sequence 仍从 1 开始。
    const seq = await db.transaction((tx) => repo.publishIn(tx, locked('c1')));
    expect(seq).toBe(1);
    await db.close();
  });

  it('assigns strictly increasing sequences under concurrent publishes', async () => {
    const db = createSqliteDatabase(':memory:');
    await db.migrate();
    await seedCampaign(db, 'c1');
    const repo = new OutboxRepository(db);
    await Promise.all([
      db.transaction((tx) => repo.publishIn(tx, submitted('c1', 'p1'))),
      db.transaction((tx) => repo.publishIn(tx, submitted('c1', 'p2'))),
    ]);
    const rows = await db.query<{ sequence: number }>(
      'SELECT sequence FROM platform_outbox_events WHERE campaign_id = ? ORDER BY sequence',
      ['c1'],
    );
    expect(rows.map((row) => row.sequence)).toEqual([1, 2]);
    await db.close();
  });

  it('rejects an event missing campaignId', async () => {
    const db = createSqliteDatabase(':memory:');
    await db.migrate();
    await seedCampaign(db, 'c1');
    const repo = new OutboxRepository(db);
    const bad = { type: 'turn.locked', turnId: 't1' } as unknown as CampaignEvent;
    await expect(db.transaction((tx) => repo.publishIn(tx, bad))).rejects.toThrow();
    await db.close();
  });

  it('round-trips the payload and leaves published_at null', async () => {
    const db = createSqliteDatabase(':memory:');
    await db.migrate();
    await seedCampaign(db, 'c1');
    const repo = new OutboxRepository(db);
    const event = submitted('c1', 'p1');
    await db.transaction((tx) => repo.publishIn(tx, event));
    const rows = await repo.listByCampaign('c1');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].payload_json)).toEqual(event);
    expect(rows[0].event_type).toBe('turn.action_submitted');
    expect(rows[0].visibility).toBe('public');
    expect(rows[0].target_player_id).toBeNull();
    expect(rows[0].published_at).toBeNull();
    await db.close();
  });

  it('advances independent durable consumer receipts without changing published_at', async () => {
    const db = createSqliteDatabase(':memory:');
    await db.migrate();
    await seedCampaign(db, 'c1');
    const repo = new OutboxRepository(db);
    await db.transaction((tx) => repo.publishIn(tx, locked('c1')));

    const first = await repo.listPendingByConsumer('turn.locked', 'consumer-a');
    expect(first).toHaveLength(1);
    expect(await db.transaction((tx) => repo.markConsumerReceiptIn(tx, 'consumer-a', first[0].id))).toBe(true);
    expect(await repo.listPendingByConsumer('turn.locked', 'consumer-a')).toHaveLength(0);
    expect(await repo.listPendingByConsumer('turn.locked', 'consumer-b')).toHaveLength(1);
    expect(await db.transaction((tx) => repo.markConsumerReceiptIn(tx, 'consumer-a', first[0].id))).toBe(false);

    const outbox = await db.query<{ published_at: string | null }>(
      'SELECT published_at FROM platform_outbox_events WHERE id = ?', [first[0].id],
    );
    expect(outbox).toEqual([{ published_at: null }]);
    await db.close();
  });

  it('writes owner.debug with owner_only visibility and no target', async () => {
    const db = createSqliteDatabase(':memory:');
    await db.migrate();
    await seedCampaign(db, 'c1');
    const repo = new OutboxRepository(db);
    await db.transaction((tx) => repo.publishIn(tx, { type: 'owner.debug', campaignId: 'c1', runId: 'r1', kind: 'ctx' }));
    const rows = await repo.listByCampaign('c1');
    expect(rows[0].visibility).toBe('owner_only');
    expect(rows[0].target_player_id).toBeNull();
    await db.close();
  });
});
