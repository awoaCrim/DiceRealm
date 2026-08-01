import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../../platform/database/SqliteDatabaseAdapter.js';
import { resolveCampaignContext, type CampaignAuthContext } from '../campaigns/CampaignAccess.js';
import { CampaignService } from '../campaigns/CampaignService.js';
import { IdentityService } from '../identity/IdentityService.js';
import { WorldFactService } from './WorldFactService.js';

async function makeFixture() {
  const db = createSqliteDatabase(':memory:');
  await db.migrate();
  const identity = new IdentityService(db);
  const campaigns = new CampaignService(db);
  const owner = await identity.register({ login: 'owner@example.test', password: 'correct-password' });
  const playerA = await identity.register({ login: 'a@example.test', password: 'correct-password' });
  const playerB = await identity.register({ login: 'b@example.test', password: 'correct-password' });
  const created = await campaigns.create(owner.userId, { name: '失落矿坑', ruleset: 'dnd5e' });
  await campaigns.join({ userId: playerA.userId }, created.campaign.id, created.inviteCode);
  await campaigns.join({ userId: playerB.userId }, created.campaign.id, created.inviteCode);
  const ownerCtx = await resolveCampaignContext(db, { userId: owner.userId }, created.campaign.id);
  const playerACtx = await resolveCampaignContext(db, { userId: playerA.userId }, created.campaign.id);
  const playerBCtx = await resolveCampaignContext(db, { userId: playerB.userId }, created.campaign.id);
  return { db, ownerCtx, playerACtx, playerBCtx };
}

describe('world facts', () => {
  it('owner creates public/player_private/owner_only facts with normalized knownBy', async () => {
    const { db, ownerCtx, playerACtx } = await makeFixture();
    const service = new WorldFactService(db);
    const pub = await service.create(ownerCtx, { title: '酒馆', kind: 'location', content: '热闹。', visibility: 'public' });
    expect(pub.knownBy).toEqual([]);
    const priv = await service.create(ownerCtx, {
      title: '密室钥匙', kind: 'item', content: '藏在地毯下。',
      visibility: 'player_private', knownBy: [playerACtx.playerId as string],
    });
    expect(priv.knownBy).toEqual([playerACtx.playerId]);
    const only = await service.create(ownerCtx, {
      title: '隐秘布局', kind: 'lore', content: '只有你知道。', visibility: 'owner_only',
    });
    expect(only.knownBy).toEqual([]);
    await db.close();
  });

  it('rejects player_private with empty or non-member knownBy', async () => {
    const { db, ownerCtx, playerACtx } = await makeFixture();
    const service = new WorldFactService(db);
    await expect(service.create(ownerCtx, {
      title: 'x', kind: 'lore', content: 'y', visibility: 'player_private', knownBy: [],
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(service.create(ownerCtx, {
      title: 'x', kind: 'lore', content: 'y', visibility: 'player_private', knownBy: ['ghost'],
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(playerACtx.playerId).toBeTruthy();
    await db.close();
  });

  it('rejects player writes', async () => {
    const { db, playerACtx } = await makeFixture();
    const service = new WorldFactService(db);
    await expect(service.create(playerACtx, {
      title: 'x', kind: 'lore', content: 'y', visibility: 'public',
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await db.close();
  });

  it('projects isolated facts per player without leaking knownBy or owner_only content', async () => {
    const { db, ownerCtx, playerACtx, playerBCtx } = await makeFixture();
    const service = new WorldFactService(db);
    const aId = playerACtx.playerId as string;
    const bId = playerBCtx.playerId as string;
    await service.create(ownerCtx, { title: '酒馆', kind: 'location', content: '热闹。', visibility: 'public' });
    await service.create(ownerCtx, { title: 'A 的密信', kind: 'item', content: '给 A。', visibility: 'player_private', knownBy: [aId] });
    await service.create(ownerCtx, { title: 'B 的密信', kind: 'item', content: '给 B。', visibility: 'player_private', knownBy: [bId] });
    await service.create(ownerCtx, { title: '隐秘布局', kind: 'lore', content: '只有你知道。', visibility: 'owner_only' });

    const a = await service.projectForCampaign(playerACtx);
    expect(a.facts.map((f) => f.title).sort()).toEqual(['A 的密信', '酒馆']);
    expect(a.facts.find((f) => f.title === 'A 的密信')?.knownBy).toEqual([aId]);
    expect(a.facts.every((f) => f.knownBy.length <= 1)).toBe(true);

    const b = await service.projectForCampaign(playerBCtx);
    expect(b.facts.map((f) => f.title).sort()).toEqual(['B 的密信', '酒馆']);

    const owner = await service.projectForCampaign(ownerCtx);
    expect(owner.facts).toHaveLength(4);
    expect(owner.facts.find((f) => f.title === 'A 的密信')?.knownBy).toEqual([aId]);
    await db.close();
  });

  it('owner updates and deletes a fact', async () => {
    const { db, ownerCtx, playerACtx } = await makeFixture();
    const service = new WorldFactService(db);
    const created = await service.create(ownerCtx, { title: '酒馆', kind: 'location', content: '热闹。', visibility: 'public' });
    // 确保 update 的 updated_at 与 create 的 updated_at 落在不同毫秒，updatedAt 变化的断言确定成立。
    await new Promise((resolve) => setTimeout(resolve, 5));
    const updated = await service.update(ownerCtx, created.id, { title: '酒馆·扩建', kind: 'location', content: '更热闹。', visibility: 'public' });
    expect(updated.title).toBe('酒馆·扩建');
    // update 保留原 created_at，仅 updated_at 前进（不得伪造创建时间）。
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt).not.toBe(created.updatedAt);
    expect((await service.projectForCampaign(playerACtx)).facts.map((f) => f.title)).toContain('酒馆·扩建');
    await service.delete(ownerCtx, created.id);
    expect(await service.projectForCampaign(ownerCtx)).toEqual({ facts: [] });
    await db.close();
  });

  it('update/delete across campaigns or missing facts returns NOT_FOUND', async () => {
    const { db, ownerCtx, playerACtx } = await makeFixture();
    const service = new WorldFactService(db);
    const created = await service.create(ownerCtx, { title: '酒馆', kind: 'location', content: '热闹。', visibility: 'public' });

    // 跨 campaign：另一战役的 owner 视角操作同一 factId。
    const identity = new IdentityService(db);
    const campaigns = new CampaignService(db);
    const otherOwner = await identity.register({ login: 'other@example.test', password: 'correct-password' });
    const otherCreated = await campaigns.create(otherOwner.userId, { name: '另一战役', ruleset: 'dnd5e' });
    const otherCtx = await resolveCampaignContext(db, { userId: otherOwner.userId }, otherCreated.campaign.id);

    await expect(service.update(otherCtx, created.id, { title: '篡改', kind: 'location', content: 'x', visibility: 'public' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(service.delete(otherCtx, created.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // 原事实未被篡改。
    expect((await service.projectForCampaign(playerACtx)).facts[0].title).toBe('酒馆');

    // 不存在 / 坏 id。
    await expect(service.update(ownerCtx, 'no-such-fact', { title: 'x', kind: 'location', content: 'y', visibility: 'public' }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(service.delete(ownerCtx, 'no-such-fact')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await db.close();
  });
});
