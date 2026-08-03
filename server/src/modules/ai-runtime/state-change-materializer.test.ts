import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../../platform/database/SqliteDatabaseAdapter.js';
import { resolveCampaignContext } from '../campaigns/CampaignAccess.js';
import { CampaignService } from '../campaigns/CampaignService.js';
import { CharacterService } from '../characters/CharacterService.js';
import { IdentityService } from '../identity/IdentityService.js';
import { WorldFactService } from '../world/WorldFactService.js';
import { StateChangeMaterializer } from './StateChangeMaterializer.js';

async function makeFixture() {
  const db = createSqliteDatabase(':memory:');
  await db.migrate();
  const identity = new IdentityService(db);
  const campaigns = new CampaignService(db);
  const characters = new CharacterService(db);
  const worldFacts = new WorldFactService(db);
  const owner = await identity.register({ login: 'owner@example.test', password: 'correct-password' });
  const a = await identity.register({ login: 'a@example.test', password: 'correct-password' });
  const created = await campaigns.create(owner.userId, { name: '矿坑', ruleset: 'dnd5e' });
  await campaigns.join({ userId: a.userId }, created.campaign.id, created.inviteCode);
  const aCtx = await resolveCampaignContext(db, { userId: a.userId }, created.campaign.id);
  const ownerCtx = await resolveCampaignContext(db, { userId: owner.userId }, created.campaign.id);
  const draft = await characters.createDraft(aCtx, { name: '薇拉', sheet: { ac: 14, hpCurrent: 10 } });
  await characters.submitForReview(aCtx, draft.id);
  const approved = await characters.approve(ownerCtx, draft.id);
  const fact = await worldFacts.create(ownerCtx, { title: '任务', kind: 'quest', content: '找钥匙。', visibility: 'public' });
  return { db, ownerCtx, aCtx, approved, fact };
}

describe('state change materializer', () => {
  it('applies a whitelisted character patch and recomputes derived with an audit', async () => {
    const { db, ownerCtx, approved } = await makeFixture();
    const m = new StateChangeMaterializer(db);
    await db.transaction((tx) => m.applyAll(tx, approved.campaignId, [
      { kind: 'character', targetId: approved.id, patch: { sheet: { hpCurrent: 7 } }, visibility: 'public' },
    ], ownerCtx.userId));
    const row = await db.query<{ sheet_json: string; derived_json: string }>(
      'SELECT sheet_json, derived_json FROM platform_characters WHERE id = ?', [approved.id],
    );
    expect(JSON.parse(row[0].sheet_json)).toMatchObject({ ac: 14, hpCurrent: 7 });
    expect(JSON.parse(row[0].derived_json)).toMatchObject({ ac: { value: 14 } });
    const audits = await db.query<{ action: string }>(
      'SELECT action FROM platform_character_audits WHERE character_id = ? ORDER BY created_at', [approved.id],
    );
    expect(audits.map((r) => r.action)).toContain('state_change');
    await db.close();
  });

  it('rejects a character patch with an unknown sheet key', async () => {
    const { db, ownerCtx, approved } = await makeFixture();
    const m = new StateChangeMaterializer(db);
    await expect(db.transaction((tx) => m.applyAll(tx, approved.campaignId, [
      { kind: 'character', targetId: approved.id, patch: { sheet: { admin: true } }, visibility: 'public' },
    ], ownerCtx.userId))).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
    await db.close();
  });

  it('applies a world patch and rejects a player_private knownBy that is not a member', async () => {
    const { db, fact, ownerCtx } = await makeFixture();
    const m = new StateChangeMaterializer(db);
    await db.transaction((tx) => m.applyAll(tx, fact.campaignId, [
      { kind: 'world', targetId: fact.id, patch: { content: '钥匙在井里。', visibility: 'public' }, visibility: 'public' },
    ], ownerCtx.userId));
    await expect(db.transaction((tx) => m.applyAll(tx, fact.campaignId, [
      { kind: 'world', targetId: fact.id, patch: { visibility: 'player_private', knownBy: ['ghost'] }, visibility: 'player_private' },
    ], ownerCtx.userId))).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
    await db.close();
  });

  it('gates combat state changes with STATE_CONFLICT and writes nothing', async () => {
    const { db, ownerCtx, approved } = await makeFixture();
    const m = new StateChangeMaterializer(db);
    await expect(db.transaction((tx) => m.applyAll(tx, approved.campaignId, [
      { kind: 'combat', targetId: 'enc-1', patch: { hpCurrent: 1 }, visibility: 'public' },
    ], ownerCtx.userId))).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    const entries = await db.query<{ count: number }>(
      'SELECT COUNT(*) AS count FROM platform_turn_entries', [],
    );
    expect(Number(entries[0].count)).toBe(0);
    await db.close();
  });

  it('rejects an unknown state change kind with AI_OUTPUT_INVALID and writes nothing', async () => {
    const { db, ownerCtx, approved } = await makeFixture();
    const m = new StateChangeMaterializer(db);
    await expect(db.transaction((tx) => m.applyAll(tx, approved.campaignId, [
      { kind: 'banana', targetId: 'x', patch: {}, visibility: 'public' },
    ] as never, ownerCtx.userId))).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
    await db.close();
  });
});
