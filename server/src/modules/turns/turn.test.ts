import { describe, expect, it } from 'vitest';
import type { CampaignAuthContext } from '../campaigns/CampaignAccess.js';
import { resolveCampaignContext } from '../campaigns/CampaignAccess.js';
import { CampaignService } from '../campaigns/CampaignService.js';
import { CharacterService } from '../characters/CharacterService.js';
import { IdentityService } from '../identity/IdentityService.js';
import { createSqliteDatabase } from '../../platform/database/SqliteDatabaseAdapter.js';
import { OutboxRepository } from '../../platform/events/OutboxRepository.js';
import { TurnService } from './TurnService.js';

async function makeFixture() {
  const db = createSqliteDatabase(':memory:');
  await db.migrate();
  const identity = new IdentityService(db);
  const campaigns = new CampaignService(db);
  const characters = new CharacterService(db);
  const owner = await identity.register({ login: 'owner@example.test', password: 'correct-password' });
  const a = await identity.register({ login: 'a@example.test', password: 'correct-password' });
  const b = await identity.register({ login: 'b@example.test', password: 'correct-password' });
  const c = await identity.register({ login: 'c@example.test', password: 'correct-password' });
  const created = await campaigns.create(owner.userId, { name: '失落矿坑', ruleset: 'dnd5e' });
  for (const user of [a, b, c]) {
    await campaigns.join({ userId: user.userId }, created.campaign.id, created.inviteCode);
  }
  const ownerCtx = await resolveCampaignContext(db, { userId: owner.userId }, created.campaign.id);
  const aCtx = await resolveCampaignContext(db, { userId: a.userId }, created.campaign.id);
  const bCtx = await resolveCampaignContext(db, { userId: b.userId }, created.campaign.id);
  const cCtx = await resolveCampaignContext(db, { userId: c.userId }, created.campaign.id);
  const approve = async (ctx: CampaignAuthContext, name: string) => {
    const draft = await characters.createDraft(ctx, { name, sheet: { ac: 14 } });
    await characters.submitForReview(ctx, draft.id);
    await characters.approve(ownerCtx, draft.id);
  };
  await approve(aCtx, '薇拉');
  await approve(bCtx, '卡恩');
  const service = new TurnService(db, new OutboxRepository(db));
  return { db, service, ownerCtx, aCtx, bCtx, cCtx };
}

describe('turns', () => {
  it('starts a turn requiring only the approved players', async () => {
    const { db, service, ownerCtx, aCtx, bCtx } = await makeFixture();
    const turn = await service.startTurn(ownerCtx);
    expect(turn.status).toBe('waiting_for_actions');
    expect(turn.number).toBe(1);
    const ownerView = await service.getView(ownerCtx, turn.id);
    if (!('actions' in ownerView)) throw new Error('expected owner view');
    expect(ownerView.progress.requiredPlayerIds.sort())
      .toEqual([aCtx.playerId as string, bCtx.playerId as string].sort());
    await db.close();
  });

  it('rejects a second start while a turn is active', async () => {
    const { db, service, ownerCtx } = await makeFixture();
    await service.startTurn(ownerCtx);
    await expect(service.startTurn(ownerCtx)).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    await db.close();
  });

  it('rejects startTurn without any approved character', async () => {
    const db = createSqliteDatabase(':memory:');
    await db.migrate();
    const identity = new IdentityService(db);
    const campaigns = new CampaignService(db);
    const owner = await identity.register({ login: 'owner@example.test', password: 'correct-password' });
    const created = await campaigns.create(owner.userId, { name: '空房', ruleset: 'dnd5e' });
    const ownerCtx = await resolveCampaignContext(db, { userId: owner.userId }, created.campaign.id);
    const service = new TurnService(db, new OutboxRepository(db));
    await expect(service.startTurn(ownerCtx)).rejects.toMatchObject({ code: 'CHARACTER_NOT_APPROVED' });
    await db.close();
  });

  it('locks after the last submit and emits 2 action_submitted + 1 locked once (edit adds no event)', async () => {
    const { db, service, ownerCtx, aCtx, bCtx } = await makeFixture();
    const turn = await service.startTurn(ownerCtx);
    const aView = await service.submitAction(aCtx, turn.id, { body: '我搜索房间。' });
    expect(aView.progress.submittedPlayerIds).toEqual([aCtx.playerId]);
    // A 锁前编辑：不重复发 progress 事件。
    await service.submitAction(aCtx, turn.id, { body: '我仔细搜索房间。' });
    const bView = await service.submitAction(bCtx, turn.id, { body: '我警戒门口。' });
    expect(bView.turn.status).toBe('locked');
    const rows = await db.query<{ sequence: number; event_type: string; payload_json: string }>(
      'SELECT sequence, event_type, payload_json FROM platform_outbox_events WHERE campaign_id = ? ORDER BY sequence',
      [turn.campaignId],
    );
    expect(rows.map((r) => r.sequence)).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.event_type)).toEqual([
      'turn.action_submitted', 'turn.action_submitted', 'turn.locked',
    ]);
    for (const row of rows) {
      expect(row.payload_json).not.toContain('搜索房间');
      expect(row.payload_json).not.toContain('警戒门口');
    }
    await db.close();
  });

  it('rejects editing after the turn is locked', async () => {
    const { db, service, ownerCtx, aCtx, bCtx } = await makeFixture();
    const turn = await service.startTurn(ownerCtx);
    await service.submitAction(aCtx, turn.id, { body: 'A 行动' });
    await service.submitAction(bCtx, turn.id, { body: 'B 行动' });
    await expect(service.submitAction(aCtx, turn.id, { body: '锁后修改' }))
      .rejects.toMatchObject({ code: 'TURN_LOCKED' });
    await db.close();
  });

  it('rejects an unapproved player and an owner submit', async () => {
    const { db, service, ownerCtx, cCtx } = await makeFixture();
    const turn = await service.startTurn(ownerCtx);
    await expect(service.submitAction(cCtx, turn.id, { body: '尝试' }))
      .rejects.toMatchObject({ code: 'CHARACTER_NOT_APPROVED' });
    await expect(service.submitAction(ownerCtx, turn.id, { body: 'owner 尝试' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    await db.close();
  });

  it('assigns concurrent submits distinct sequences and locks exactly once', async () => {
    const { db, service, ownerCtx, aCtx, bCtx } = await makeFixture();
    const turn = await service.startTurn(ownerCtx);
    await Promise.all([
      service.submitAction(aCtx, turn.id, { body: 'A 并发' }),
      service.submitAction(bCtx, turn.id, { body: 'B 并发' }),
    ]);
    const rows = await db.query<{ sequence: number; event_type: string }>(
      'SELECT sequence, event_type FROM platform_outbox_events WHERE campaign_id = ? ORDER BY sequence',
      [turn.campaignId],
    );
    expect(rows.map((r) => r.sequence)).toEqual([1, 2, 3]);
    expect(rows.filter((r) => r.event_type === 'turn.locked')).toHaveLength(1);
    await db.close();
  });

  it('keeps player action bodies private in player view and visible to owner', async () => {
    const { db, service, ownerCtx, aCtx, bCtx } = await makeFixture();
    const turn = await service.startTurn(ownerCtx);
    await service.submitAction(aCtx, turn.id, { body: 'A 的私密行动' });
    const bView = await service.getView(bCtx, turn.id);
    if (!('myAction' in bView)) throw new Error('expected player view');
    expect(bView.myAction).toBeNull();
    expect(JSON.stringify(bView)).not.toContain('A 的私密行动');
    const ownerView = await service.getView(ownerCtx, turn.id);
    if (!('actions' in ownerView)) throw new Error('expected owner view');
    expect(ownerView.actions.map((action) => action.body)).toContain('A 的私密行动');
    await db.close();
  });

  it('lists turns without action bodies', async () => {
    const { db, service, ownerCtx, aCtx } = await makeFixture();
    const turn = await service.startTurn(ownerCtx);
    await service.submitAction(aCtx, turn.id, { body: 'A 行动' });
    const list = await service.listForCampaign(ownerCtx);
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain('A 行动');
    expect(list[0].progress.requiredPlayerIds).toHaveLength(2);
    await db.close();
  });
});
