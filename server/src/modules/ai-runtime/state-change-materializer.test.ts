import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../../platform/database/SqliteDatabaseAdapter.js';
import type { QueryExecutor } from '../../platform/database/DatabasePort.js';
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
      { kind: 'character', targetId: approved.id, patch: { sheet: { admin: true } } as never, visibility: 'public' },
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

  it('gates combat state changes with STATE_CONFLICT when no applier is injected and writes nothing', async () => {
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

  it('delegates combat state changes to the injected applier', async () => {
    const { db, ownerCtx, approved } = await makeFixture();
    let applied: string[] = [];
    const applier = {
      async apply(_tx: QueryExecutor, campaignId: string, change: { targetId: string }): Promise<void> {
        applied.push(`${campaignId}:${change.targetId}`);
      },
      async startEncounter(): Promise<void> {
        applied.push('start');
      },
    };
    const m = new StateChangeMaterializer(db, applier);
    await db.transaction((tx) => m.applyAll(tx, approved.campaignId, [
      { kind: 'combat', targetId: 'enc-9', patch: { command: 'advance_turn' }, visibility: 'public' },
    ], ownerCtx.userId));
    expect(applied).toEqual([`${approved.campaignId}:enc-9`]);
    await db.close();
  });

  it('inserts world fact creations with server-generated ids and knownBy rules', async () => {
    const { db, ownerCtx, aCtx } = await makeFixture();
    const m = new StateChangeMaterializer(db);
    await db.transaction((tx) => m.applyAll(tx, ownerCtx.campaignId, [], ownerCtx.userId, {
      worldFactCreations: [
        { title: '烛堡密道', kind: 'location', content: '石墙后藏着通道。', visibility: 'public', knownBy: [] },
        { title: '影印暗记', kind: 'lore', content: '只有甲知道。', visibility: 'player_private', knownBy: [aCtx.playerId as string] },
        { title: '地宫主人', kind: 'npc', content: 'Owner 专属。', visibility: 'owner_only', knownBy: [] },
      ],
      encounterStarts: [],
    }));
    const rows = await db.query<{ id: string; title: string; kind: string; visibility: string; known_by_json: string; created_at: string }>(
      "SELECT id, title, kind, visibility, known_by_json, created_at FROM platform_world_facts WHERE campaign_id = ? AND title IN ('烛堡密道', '影印暗记', '地宫主人') ORDER BY created_at ASC",
      [ownerCtx.campaignId],
    );
    expect(rows).toHaveLength(3);
    const byTitle = new Map(rows.map((row) => [row.title, row]));
    expect(byTitle.get('烛堡密道')?.id).toHaveLength(24); // 服务端 nanoid
    expect(byTitle.get('烛堡密道')?.created_at).toBeTruthy();
    expect(byTitle.get('影印暗记')?.visibility).toBe('player_private');
    expect(JSON.parse(byTitle.get('影印暗记')!.known_by_json)).toEqual([aCtx.playerId]);
    expect(JSON.parse(byTitle.get('地宫主人')!.known_by_json)).toEqual([]); // owner_only/public 强制 []
    await db.close();
  });

  it('rejects a world fact creation with a non-member player_private knownBy as AI_OUTPUT_INVALID and writes nothing', async () => {
    const { db, ownerCtx } = await makeFixture();
    const m = new StateChangeMaterializer(db);
    await expect(db.transaction((tx) => m.applyAll(tx, ownerCtx.campaignId, [], ownerCtx.userId, {
      worldFactCreations: [
        { title: '私密', kind: 'lore', content: 'x', visibility: 'player_private', knownBy: ['ghost'] },
      ],
      encounterStarts: [],
    }))).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
    const rows = await db.query("SELECT id FROM platform_world_facts WHERE campaign_id = ? AND title = '私密'", [ownerCtx.campaignId]);
    expect(rows).toHaveLength(0);
    await db.close();
  });

  it('gates encounter starts with STATE_CONFLICT when no combat applier is injected and writes nothing', async () => {
    const { db, ownerCtx } = await makeFixture();
    const m = new StateChangeMaterializer(db);
    await expect(db.transaction((tx) => m.applyAll(tx, ownerCtx.campaignId, [], ownerCtx.userId, {
      worldFactCreations: [],
      encounterStarts: [{
        name: '伏击',
        combatants: [
          { name: '哥布林', characterId: null, initiativeBonus: 2, hpCurrent: 9, hpMax: 9, ac: 13, conditions: [], visibility: 'public', targetPlayerId: null },
        ],
      }],
    }))).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    const encounters = await db.query('SELECT id FROM platform_encounters WHERE campaign_id = ?', [ownerCtx.campaignId]);
    expect(encounters).toHaveLength(0);
    await db.close();
  });

  it('delegates encounter starts to the injected combat applier', async () => {
    const { db, ownerCtx } = await makeFixture();
    const started: string[] = [];
    const applier = {
      async apply(): Promise<void> {
        throw new Error('unexpected');
      },
      async startEncounter(_tx: QueryExecutor, campaignId: string, start: { name: string }): Promise<void> {
        started.push(`${campaignId}:${start.name}`);
      },
    };
    const m = new StateChangeMaterializer(db, applier);
    await db.transaction((tx) => m.applyAll(tx, ownerCtx.campaignId, [], ownerCtx.userId, {
      worldFactCreations: [],
      encounterStarts: [{ name: '伏击', combatants: [{ name: '哥布林', characterId: null, initiativeBonus: 2, hpCurrent: 9, hpMax: 9, ac: 13, conditions: [], visibility: 'public', targetPlayerId: null }] }],
    }));
    expect(started).toEqual([`${ownerCtx.campaignId}:伏击`]);
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
