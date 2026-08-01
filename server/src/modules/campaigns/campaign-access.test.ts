import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { Router } from 'express';
import { describe, expect, it } from 'vitest';
import type { AuthContext } from '@dnd/contracts';
import { createSqliteDatabase } from '../../platform/database/SqliteDatabaseAdapter.js';
import { requireCampaignMember, getCampaignContext } from '../../platform/http/campaignMiddleware.js';
import { errorMiddleware } from '../../platform/http/errorMiddleware.js';
import { IdentityService } from '../identity/IdentityService.js';
import { CampaignService } from './CampaignService.js';
import { requireOwner, resolveCampaignContext } from './CampaignAccess.js';

async function makeFixture() {
  const db = createSqliteDatabase(':memory:');
  await db.migrate();
  const identity = new IdentityService(db);
  const campaigns = new CampaignService(db);
  const owner = await identity.register({ login: 'owner@example.test', password: 'correct-password' });
  const player = await identity.register({ login: 'player@example.test', password: 'correct-password' });
  const created = await campaigns.create(owner.userId, { name: '失落矿坑', ruleset: 'dnd5e' });
  await campaigns.join({ userId: player.userId }, created.campaign.id, created.inviteCode);
  return { db, created, owner, player };
}

describe('campaign access context', () => {
  it('resolves owner and player roles with the expected playerId', async () => {
    const { db, created, owner, player } = await makeFixture();
    const ownerCtx: AuthContext = { userId: owner.userId };
    const playerCtx: AuthContext = { userId: player.userId };
    const ownerView = await resolveCampaignContext(db, ownerCtx, created.campaign.id);
    expect(ownerView).toMatchObject({ campaignId: created.campaign.id, role: 'owner', playerId: null });
    const playerView = await resolveCampaignContext(db, playerCtx, created.campaign.id);
    expect(playerView).toMatchObject({ campaignId: created.campaign.id, role: 'player', playerId: player.userId });
    await db.close();
  });

  it('hides a campaign from a non-member', async () => {
    const { db, created } = await makeFixture();
    await expect(resolveCampaignContext(db, { userId: 'ghost' }, created.campaign.id))
      .rejects.toMatchObject({ code: 'CAMPAIGN_NOT_FOUND' });
    await db.close();
  });

  it('requireOwner rejects a player', async () => {
    const { db, created, player } = await makeFixture();
    const playerView = await resolveCampaignContext(db, { userId: player.userId }, created.campaign.id);
    expect(() => requireOwner(playerView)).toThrow(/你没有权限执行此操作/);
    await db.close();
  });
});

describe('campaign middleware probe router', () => {
  it('resolves the parent :campaignId param and rejects non-members over HTTP', async () => {
    const { db, created, player } = await makeFixture();
    // 会话中间件最小桩：直接写 authContext（真实流程由 sessionMiddleware 填充）。
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as { authContext?: AuthContext }).authContext = { userId: player.userId };
      next();
    });
    // 测试内 probe router：mergeParams 必须为 true，否则子路由读不到父级 :campaignId。
    const probe = Router({ mergeParams: true });
    probe.use(requireCampaignMember(db));
    probe.get('/', (req, res) => {
      const ctx = getCampaignContext(req);
      res.json({ campaignId: ctx.campaignId, role: ctx.role });
    });
    app.use('/api/campaigns/:campaignId/characters', probe);
    app.use(errorMiddleware);

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address() as AddressInfo;
    try {
      const memberRes = await fetch(`http://127.0.0.1:${address.port}/api/campaigns/${created.campaign.id}/characters`);
      expect(memberRes.status).toBe(200);
      const memberBody = (await memberRes.json()) as { campaignId: string; role: string };
      expect(memberBody).toEqual({ campaignId: created.campaign.id, role: 'player' });

      // 非成员（session 仍为 player，但 campaign 不存在/未加入）→ CAMPAIGN_NOT_FOUND 隐藏存在性。
      const ghostRes = await fetch(`http://127.0.0.1:${address.port}/api/campaigns/ghost-campaign/characters`);
      expect(ghostRes.status).toBe(404);
      const ghostBody = (await ghostRes.json()) as { error: { code: string } };
      expect(ghostBody.error.code).toBe('CAMPAIGN_NOT_FOUND');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.close();
    }
  });
});
