import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../../platform/database/SqliteDatabaseAdapter.js';
import type { SqliteDatabaseAdapter } from '../../platform/database/SqliteDatabaseAdapter.js';
import { resolveCampaignContext, type CampaignAuthContext } from '../campaigns/CampaignAccess.js';
import { IdentityService } from '../identity/IdentityService.js';
import { CampaignService } from '../campaigns/CampaignService.js';
import { CharacterService } from './CharacterService.js';

async function makeFixture() {
  const db = createSqliteDatabase(':memory:');
  await db.migrate();
  const identity = new IdentityService(db);
  const campaigns = new CampaignService(db);
  const owner = await identity.register({ login: 'owner@example.test', password: 'correct-password' });
  const player = await identity.register({ login: 'player@example.test', password: 'correct-password' });
  const playerB = await identity.register({ login: 'playerb@example.test', password: 'correct-password' });
  const created = await campaigns.create(owner.userId, { name: '失落矿坑', ruleset: 'dnd5e' });
  await campaigns.join({ userId: player.userId }, created.campaign.id, created.inviteCode);
  await campaigns.join({ userId: playerB.userId }, created.campaign.id, created.inviteCode);
  const ownerCtx = await resolveCampaignContext(db, { userId: owner.userId }, created.campaign.id);
  const playerCtx = await resolveCampaignContext(db, { userId: player.userId }, created.campaign.id);
  const playerBCtx = await resolveCampaignContext(db, { userId: playerB.userId }, created.campaign.id);
  return { db, ownerCtx, playerCtx, playerBCtx };
}

describe('characters', () => {
  it('creates the character and audit tables via migration', async () => {
    const { db } = await makeFixture();
    const tables = await db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('platform_characters', 'platform_character_audits')",
    );
    expect(tables.map((table) => table.name).sort()).toEqual(['platform_character_audits', 'platform_characters']);
    await db.close();
  });

  it('creates a player draft, updates it, then submits for review', async () => {
    const { db, playerCtx } = await makeFixture();
    const service = new CharacterService(db);
    const draft = await service.createDraft(playerCtx, { name: '薇拉', sheet: { ac: 14 } });
    expect(draft.status).toBe('draft');
    const updated = await service.updateDraft(playerCtx, draft.id, { name: '薇拉', sheet: { ac: 15 } });
    expect(updated.sheet.ac).toBe(15);
    const review = await service.submitForReview(playerCtx, draft.id);
    expect(review.status).toBe('pending_review');
    await db.close();
  });

  it('allows only the owner to approve a pending character', async () => {
    const { db, playerCtx } = await makeFixture();
    const service = new CharacterService(db);
    const draft = await service.createDraft(playerCtx, { name: '薇拉', sheet: { ac: 14 } });
    await service.submitForReview(playerCtx, draft.id);
    await expect(service.approve(playerCtx, draft.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await db.close();
  });

  it('approves a character with auditable derived AC persisted to derived_json', async () => {
    const { db, ownerCtx, playerCtx } = await makeFixture();
    const service = new CharacterService(db);
    const draft = await service.createDraft(playerCtx, { name: '薇拉', sheet: { ac: 14 } });
    await service.submitForReview(playerCtx, draft.id);
    const approved = await service.approve(ownerCtx, draft.id);
    expect(approved.status).toBe('approved');
    expect(approved.derived.ac).toEqual({ value: 14, sources: ['base'] });
    const rows = await db.query<{ derived_json: string }>(
      'SELECT derived_json FROM platform_characters WHERE id = ?',
      [draft.id],
    );
    expect(JSON.parse(rows[0].derived_json)).toEqual({ ac: { value: 14, sources: ['base'] } });
    await db.close();
  });

  it('prevents a player from operating on another player character', async () => {
    const { db, playerCtx, playerBCtx } = await makeFixture();
    const service = new CharacterService(db);
    const draft = await service.createDraft(playerCtx, { name: '薇拉', sheet: { ac: 14 } });
    await expect(service.submitForReview(playerBCtx, draft.id))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    await db.close();
  });

  it('persists an audit row on every status/content change', async () => {
    const { db, ownerCtx, playerCtx } = await makeFixture();
    const service = new CharacterService(db);
    const draft = await service.createDraft(playerCtx, { name: '薇拉', sheet: { ac: 14 } });
    await service.updateDraft(playerCtx, draft.id, { name: '薇拉', sheet: { ac: 15 } });
    await service.submitForReview(playerCtx, draft.id);
    await service.approve(ownerCtx, draft.id);
    const rows = await db.query<{ count: number }>(
      'SELECT COUNT(*) AS count FROM platform_character_audits WHERE character_id = ?',
      [draft.id],
    );
    // create / update / submit / approve 各写一条审计。
    expect(Number(rows[0].count)).toBe(4);
    await db.close();
  });

  it('rejects a second approve after the status changed (conditional update)', async () => {
    const { db, ownerCtx, playerCtx } = await makeFixture();
    const service = new CharacterService(db);
    const draft = await service.createDraft(playerCtx, { name: '薇拉', sheet: { ac: 14 } });
    await service.submitForReview(playerCtx, draft.id);
    await service.approve(ownerCtx, draft.id);
    await expect(service.approve(ownerCtx, draft.id)).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    await db.close();
  });

  it('serializes concurrent approve so exactly one wins with STATE_CONFLICT', async () => {
    const { db, ownerCtx, playerCtx } = await makeFixture();
    const service = new CharacterService(db);
    const draft = await service.createDraft(playerCtx, { name: '薇拉', sheet: { ac: 14 } });
    await service.submitForReview(playerCtx, draft.id);
    // 同一 adapter 上两个并发 approve：互斥队列串行化后，恰一成功、败方 STATE_CONFLICT。
    const results = await Promise.allSettled([
      service.approve(ownerCtx, draft.id),
      service.approve(ownerCtx, draft.id),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0].reason as { code?: string }).code).toBe('STATE_CONFLICT');
    // approve 审计恰一条，无双写。
    const auditRows = await db.query<{ count: number }>(
      "SELECT COUNT(*) AS count FROM platform_character_audits WHERE character_id = ? AND action = 'approve'",
      [draft.id],
    );
    expect(Number(auditRows[0].count)).toBe(1);
    const finalRows = await db.query<{ status: string }>(
      'SELECT status FROM platform_characters WHERE id = ?',
      [draft.id],
    );
    expect(finalRows[0].status).toBe('approved');
    await db.close();
  });

  it('rejects a pending character, lets the player edit and resubmit', async () => {
    const { db, ownerCtx, playerCtx } = await makeFixture();
    const service = new CharacterService(db);
    const draft = await service.createDraft(playerCtx, { name: '薇拉', sheet: { ac: 14 } });
    await service.submitForReview(playerCtx, draft.id);
    const rejected = await service.reject(ownerCtx, draft.id);
    expect(rejected.status).toBe('rejected');
    const edited = await service.updateDraft(playerCtx, draft.id, { name: '薇拉', sheet: { ac: 16 } });
    expect(edited.status).toBe('draft');
    const review = await service.submitForReview(playerCtx, draft.id);
    expect(review.status).toBe('pending_review');
    await db.close();
  });

  it('shows own pending and approved characters to the owning player', async () => {
    const { db, ownerCtx, playerCtx } = await makeFixture();
    const service = new CharacterService(db);
    const draft = await service.createDraft(playerCtx, { name: '薇拉', sheet: { ac: 14 } });
    await service.submitForReview(playerCtx, draft.id);
    const pendingView = await service.projectForCampaign(playerCtx);
    expect(pendingView.myPending).toHaveLength(1);
    await service.approve(ownerCtx, draft.id);
    const approvedView = await service.projectForCampaign(playerCtx);
    expect(approvedView.myApproved).toHaveLength(1);
    expect(approvedView.myApproved[0].derived).toHaveProperty('ac');
    await db.close();
  });

  it('projects approved summaries visible to another player, hiding private drafts', async () => {
    const { db, ownerCtx, playerCtx, playerBCtx } = await makeFixture();
    const service = new CharacterService(db);
    const draft = await service.createDraft(playerCtx, { name: '薇拉', sheet: { ac: 14 } });
    await service.submitForReview(playerCtx, draft.id);
    await service.approve(ownerCtx, draft.id);
    const viewForB = await service.projectForCampaign(playerBCtx);
    expect(viewForB.approvedSummaries).toHaveLength(1);
    expect(viewForB.approvedSummaries[0]).toMatchObject({ name: '薇拉' });
    expect(viewForB.myDrafts).toEqual([]);
    expect(viewForB.myPending).toEqual([]);
    expect(viewForB.myRejected).toEqual([]);
    expect(viewForB.myApproved).toEqual([]);
    await db.close();
  });

  it('shows the owner the pending review queue but not other players own lists', async () => {
    const { db, ownerCtx, playerCtx } = await makeFixture();
    const service = new CharacterService(db);
    const draft = await service.createDraft(playerCtx, { name: '薇拉', sheet: { ac: 14 } });
    await service.submitForReview(playerCtx, draft.id);
    const ownerView = await service.projectForCampaign(ownerCtx);
    expect(ownerView.reviews).toHaveLength(1);
    expect(ownerView.reviews[0]).toMatchObject({ id: draft.id, status: 'pending_review' });
    expect(ownerView.myDrafts).toEqual([]);
    expect(ownerView.myPending).toEqual([]);
    await db.close();
  });
});
