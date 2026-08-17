import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../../platform/database/SqliteDatabaseAdapter.js';
import { CampaignService } from './CampaignService.js';
import { CampaignMutationCoordinator } from './CampaignMutationCoordinator.js';
import { IdentityService } from '../identity/IdentityService.js';

type Fixture = Awaited<ReturnType<typeof makeFixture>>;

async function makeFixture() {
  const db = createSqliteDatabase(':memory:');
  await db.migrate();
  const identity = new IdentityService(db);
  const campaigns = new CampaignService(db);
  const owner = await identity.register({ login: 'mutation-owner@example.test', password: 'correct-password' });
  const created = await campaigns.create(owner.userId, { name: '版本战役', ruleset: 'dnd5e' });
  return { db, campaignId: created.campaign.id, ownerId: owner.userId, campaigns };
}

async function head(fixture: Fixture) {
  const rows = await fixture.db.query<{ revision: number }>(
    'SELECT revision FROM platform_campaign_state_heads WHERE campaign_id = ?', [fixture.campaignId],
  );
  return Number(rows[0]?.revision);
}

describe('CampaignMutationCoordinator', () => {
  it('advances once and makes duplicate mutation ids idempotent', async () => {
    const fixture = await makeFixture();
    const coordinator = new CampaignMutationCoordinator(fixture.db);
    let calls = 0;
    const first = await coordinator.run({
      campaignId: fixture.campaignId, mutationId: 'mutation-1', causeType: 'test_mutation', causeId: 'case-1',
    }, async ({ tx, stateRevision }) => {
      calls += 1;
      await tx.execute('UPDATE campaigns SET name = ? WHERE id = ?', ['已推进', fixture.campaignId]);
      return stateRevision;
    });
    const replay = await coordinator.run({
      campaignId: fixture.campaignId, mutationId: 'mutation-1', causeType: 'test_mutation', causeId: 'case-1',
    }, async () => {
      calls += 1;
      return 'must-not-run';
    });

    expect(first.replayed).toBe(false);
    expect(first.revision.revision).toBe(1);
    expect(replay.replayed).toBe(true);
    expect(replay.revision.revision).toBe(1);
    expect(replay.result).toBeUndefined();
    expect(calls).toBe(1);
    expect(await head(fixture)).toBe(1);
    const ledger = await fixture.db.query<{ count: number }>(
      'SELECT COUNT(*) AS count FROM platform_campaign_state_revisions WHERE campaign_id = ?', [fixture.campaignId],
    );
    expect(Number(ledger[0].count)).toBe(1);
    await expect(coordinator.run({
      campaignId: fixture.campaignId, mutationId: 'mutation-1', causeType: 'different_cause', causeId: 'case-1',
    }, async () => true)).rejects.toMatchObject({ code: 'MUTATION_REPLAY' });
    await fixture.db.close();
  });

  it('rejects stale compare-and-swap without invoking business work', async () => {
    const fixture = await makeFixture();
    const coordinator = new CampaignMutationCoordinator(fixture.db);
    await coordinator.run({ campaignId: fixture.campaignId, mutationId: 'mutation-1', causeType: 'test_mutation' }, async () => true);
    let called = false;
    await expect(coordinator.run({
      campaignId: fixture.campaignId, expectedRevision: 0, mutationId: 'mutation-2', causeType: 'test_stale',
    }, async () => {
      called = true;
      return true;
    })).rejects.toMatchObject({ code: 'STALE_STATE_REVISION' });
    expect(called).toBe(false);
    expect(await head(fixture)).toBe(1);
    await fixture.db.close();
  });

  it('allows input-only action submissions to advance a claimed revision but rejects other intervening mutations', async () => {
    const fixture = await makeFixture();
    const coordinator = new CampaignMutationCoordinator(fixture.db);
    await coordinator.run({
      campaignId: fixture.campaignId,
      mutationId: 'action-submit-1',
      causeType: 'turn_action_submit',
    }, async () => true);
    expect(await coordinator.latestCompatibleRevisionIn(
      fixture.db,
      fixture.campaignId,
      0,
      ['turn_action_submit'],
    )).toBe(1);
    await coordinator.run({
      campaignId: fixture.campaignId,
      mutationId: 'world-change-1',
      causeType: 'world_state_change',
    }, async () => true);
    await expect(coordinator.latestCompatibleRevisionIn(
      fixture.db,
      fixture.campaignId,
      0,
      ['turn_action_submit'],
    )).rejects.toMatchObject({ code: 'STALE_STATE_REVISION' });
    await fixture.db.close();
  });

  it('rolls back head, ledger and business writes together', async () => {
    const fixture = await makeFixture();
    const coordinator = new CampaignMutationCoordinator(fixture.db);
    await expect(coordinator.run({
      campaignId: fixture.campaignId, mutationId: 'mutation-rollback', causeType: 'test_rollback',
    }, async ({ tx }) => {
      await tx.execute('UPDATE campaigns SET name = ? WHERE id = ?', ['不应提交', fixture.campaignId]);
      throw new Error('business failure');
    })).rejects.toThrow('business failure');

    expect(await head(fixture)).toBe(0);
    const campaign = await fixture.db.query<{ name: string }>('SELECT name FROM campaigns WHERE id = ?', [fixture.campaignId]);
    expect(campaign[0].name).toBe('版本战役');
    const ledger = await fixture.db.query<{ count: number }>(
      'SELECT COUNT(*) AS count FROM platform_campaign_state_revisions WHERE campaign_id = ?', [fixture.campaignId],
    );
    expect(Number(ledger[0].count)).toBe(0);
    await fixture.db.close();
  });

  it('does not advance the runtime revision for metadata-only campaign settings', async () => {
    const fixture = await makeFixture();
    const before = await head(fixture);
    await fixture.campaigns.updateSettings(
      { userId: fixture.ownerId },
      fixture.campaignId,
      { name: '只改元数据' },
    );
    expect(await head(fixture)).toBe(before);
    await fixture.db.close();
  });

  it('allows only one concurrent request with the same expected revision', async () => {
    const fixture = await makeFixture();
    const coordinator = new CampaignMutationCoordinator(fixture.db);
    const results = await Promise.allSettled([
      coordinator.run({ campaignId: fixture.campaignId, expectedRevision: 0, mutationId: 'concurrent-a', causeType: 'test_concurrent' }, async () => 'a'),
      coordinator.run({ campaignId: fixture.campaignId, expectedRevision: 0, mutationId: 'concurrent-b', causeType: 'test_concurrent' }, async () => 'b'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await head(fixture)).toBe(1);
    await fixture.db.close();
  });
});
