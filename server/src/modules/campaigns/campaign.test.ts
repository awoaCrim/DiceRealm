import { describe, expect, it } from 'vitest';
import type { AuthContext, CampaignMember, CampaignView } from '@dnd/contracts';
import { createSqliteDatabase } from '../../platform/database/SqliteDatabaseAdapter.js';
import type { SqliteDatabaseAdapter } from '../../platform/database/SqliteDatabaseAdapter.js';
import { IdentityService } from '../identity/IdentityService.js';
import { CampaignService } from './CampaignService.js';

interface CampaignFixture {
  db: SqliteDatabaseAdapter;
  service: CampaignService;
  ownerContext: AuthContext;
  playerContext: AuthContext;
  playerBContext: AuthContext;
  campaignId: string;
  inviteCode: string;
}

/** 玩家默认已加入战役（role=player）；playerB 保持非成员。 */
async function createCampaignFixture(options: { joinPlayer?: boolean } = {}): Promise<CampaignFixture> {
  const db = createSqliteDatabase(':memory:');
  await db.migrate();
  const identity = new IdentityService(db);
  const service = new CampaignService(db);

  const owner = await identity.register({ login: 'owner@example.test', password: 'correct-password' });
  const player = await identity.register({ login: 'player@example.test', password: 'correct-password' });
  const playerB = await identity.register({ login: 'playerb@example.test', password: 'correct-password' });

  const ownerContext: AuthContext = { userId: owner.userId };
  const playerContext: AuthContext = { userId: player.userId };
  const playerBContext: AuthContext = { userId: playerB.userId };

  const created = await service.create(owner.userId, { name: '失落矿坑', ruleset: 'dnd5e' });
  const campaignId = created.campaign.id;
  const inviteCode = created.inviteCode;
  if (options.joinPlayer !== false) {
    await service.join(playerContext, campaignId, inviteCode);
  }

  return { db, service, ownerContext, playerContext, playerBContext, campaignId, inviteCode };
}

describe('campaigns', () => {
  it('creates a campaign owned by the creating user and returns a raw invite code', async () => {
    const fixture = await createCampaignFixture({ joinPlayer: false });
    const view = await fixture.service.getForMember(fixture.ownerContext, fixture.campaignId);
    expect(view.campaign.name).toBe('失落矿坑');
    expect(view.campaign.ruleset).toBe('dnd5e');
    expect(view.campaign.ownerId).toBe(fixture.ownerContext.userId);
    expect(view.campaign.status).toBe('setup');
    expect(view.members).toHaveLength(1);
    expect(view.members[0]).toMatchObject({ role: 'owner', userId: fixture.ownerContext.userId });
    expect(fixture.inviteCode).toBeTruthy();
    await fixture.db.close();
  });

  it('stores only the invite-code hash, never the raw code', async () => {
    const fixture = await createCampaignFixture({ joinPlayer: false });
    const rows = await fixture.db.query<{ invite_code_hash: string | null }>(
      'SELECT invite_code_hash FROM campaigns WHERE id = ?',
      [fixture.campaignId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].invite_code_hash).toBeTruthy();
    expect(rows[0].invite_code_hash).not.toBe(fixture.inviteCode);
    expect(rows[0].invite_code_hash).toMatch(/^[a-f0-9]{64}$/);
    await fixture.db.close();
  });

  it('generates distinct, high-entropy invite codes per campaign', async () => {
    const fixture = await createCampaignFixture({ joinPlayer: false });
    const second = await fixture.service.create(fixture.ownerContext.userId!, { name: '第二战役', ruleset: 'dnd5e' });
    expect(second.inviteCode).not.toBe(fixture.inviteCode);
    // 128 bit base64url 编码 ≥ 16 字节。
    expect(Buffer.from(fixture.inviteCode, 'base64url').length).toBeGreaterThanOrEqual(16);
    expect(Buffer.from(second.inviteCode, 'base64url').length).toBeGreaterThanOrEqual(16);
    await fixture.db.close();
  });

  it('lists campaigns the user owns or joined', async () => {
    const fixture = await createCampaignFixture();
    const summaries = await fixture.service.listOwnedOrJoined(fixture.playerContext.userId!);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ id: fixture.campaignId, role: 'player', name: '失落矿坑' });
    await fixture.db.close();
  });

  it('lists only campaigns the user belongs to', async () => {
    const fixture = await createCampaignFixture();
    const summaries = await fixture.service.listOwnedOrJoined(fixture.playerBContext.userId!);
    expect(summaries).toEqual([]);
    await fixture.db.close();
  });

  it('does not let a non-member view a campaign (hides existence)', async () => {
    const fixture = await createCampaignFixture();
    await expect(fixture.service.getForMember(fixture.playerBContext, fixture.campaignId)).rejects.toMatchObject({ code: 'CAMPAIGN_NOT_FOUND' });
    await fixture.db.close();
  });

  it('joins a campaign with a valid invite code as a player', async () => {
    const fixture = await createCampaignFixture({ joinPlayer: false });
    const member = await fixture.service.join(fixture.playerContext, fixture.campaignId, fixture.inviteCode);
    expect(member).toMatchObject({ campaignId: fixture.campaignId, role: 'player', userId: fixture.playerContext.userId });

    const view: CampaignView = await fixture.service.getForMember(fixture.playerContext, fixture.campaignId);
    expect(view.members).toHaveLength(2);
    await fixture.db.close();
  });

  it('rejects an invalid invite code', async () => {
    const fixture = await createCampaignFixture({ joinPlayer: false });
    await expect(fixture.service.join(fixture.playerContext, fixture.campaignId, 'wrong-invite-code')).rejects.toMatchObject({ code: 'CAMPAIGN_NOT_FOUND' });
    await fixture.db.close();
  });

  it('rejects a duplicate join with the same error code', async () => {
    const fixture = await createCampaignFixture();
    await expect(fixture.service.join(fixture.playerContext, fixture.campaignId, fixture.inviteCode)).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    await fixture.db.close();
  });

  it('rejects joining a non-existent campaign', async () => {
    const fixture = await createCampaignFixture();
    await expect(fixture.service.join(fixture.playerContext, 'no-such-campaign', 'anything')).rejects.toMatchObject({ code: 'CAMPAIGN_NOT_FOUND' });
    await fixture.db.close();
  });

  it('allows only the owner to update campaign settings', async () => {
    const fixture = await createCampaignFixture();
    await expect(fixture.service.updateSettings(fixture.playerContext, fixture.campaignId, { name: 'nope' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('lets the owner update campaign settings', async () => {
    const fixture = await createCampaignFixture();
    const updated = await fixture.service.updateSettings(fixture.ownerContext, fixture.campaignId, { name: '新名字' });
    expect(updated.name).toBe('新名字');
    expect(updated.updatedAt).toBeTruthy();
    await fixture.db.close();
  });

  it('rejects settings updates from a non-member with CAMPAIGN_NOT_FOUND', async () => {
    const fixture = await createCampaignFixture();
    await expect(fixture.service.updateSettings(fixture.playerBContext, fixture.campaignId, { name: 'nope' })).rejects.toMatchObject({ code: 'CAMPAIGN_NOT_FOUND' });
    await fixture.db.close();
  });

  it('rejects unauthenticated access with AUTH_REQUIRED', async () => {
    const fixture = await createCampaignFixture();
    const emptyContext: AuthContext = { userId: '' };
    await expect(fixture.service.listOwnedOrJoined('')).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    await expect(fixture.service.getForMember(emptyContext, fixture.campaignId)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    await expect(fixture.service.create('', { name: 'x', ruleset: 'dnd5e' })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    await fixture.db.close();
  });

  it('never exposes the invite code or hash inside player-visible DTOs', async () => {
    const fixture = await createCampaignFixture();
    const view: CampaignView = await fixture.service.getForMember(fixture.ownerContext, fixture.campaignId);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(fixture.inviteCode);
    expect(serialized).not.toContain('invite');
    expect(serialized).not.toContain('inviteCode');
    await fixture.db.close();
  });

  it('does not leak a member DTO for players', async () => {
    const fixture = await createCampaignFixture({ joinPlayer: false });
    const member: CampaignMember = await fixture.service.join(fixture.playerContext, fixture.campaignId, fixture.inviteCode);
    expect(member).not.toHaveProperty('inviteCode');
    expect(member).not.toHaveProperty('invite_code');
    expect(Object.keys(member).sort()).toEqual(['campaignId', 'joinedAt', 'role', 'userId']);
    await fixture.db.close();
  });
});
