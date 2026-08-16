import { describe, expect, it } from 'vitest';
import type { CampaignAuthContext } from '../campaigns/CampaignAccess.js';
import { resolveCampaignContext } from '../campaigns/CampaignAccess.js';
import { CampaignService } from '../campaigns/CampaignService.js';
import { CharacterService } from '../characters/CharacterService.js';
import { IdentityService } from '../identity/IdentityService.js';
import { createSqliteDatabase } from '../../platform/database/SqliteDatabaseAdapter.js';
import { OutboxRepository } from '../../platform/events/OutboxRepository.js';
import { CombatService } from './CombatService.js';
import { CombatAiAdapter } from './CombatAiAdapter.js';
import { CombatRepository } from './CombatRepository.js';
import { markStateChangeValidated, type StartEncounterInput } from '@dnd/contracts';

const publicFighter: StartEncounterInput['combatants'][number] = {
  name: '战士', characterId: null, initiativeBonus: 2, hpCurrent: 12, hpMax: 12, ac: 16,
  conditions: [], visibility: 'public', targetPlayerId: null,
};

async function makeFixture() {
  const db = createSqliteDatabase(':memory:');
  await db.migrate();
  const identity = new IdentityService(db);
  const campaigns = new CampaignService(db);
  const characters = new CharacterService(db);
  const owner = await identity.register({ login: 'ai-combat-owner@example.test', password: 'correct-password' });
  const a = await identity.register({ login: 'ai-combat-a@example.test', password: 'correct-password' });
  const created = await campaigns.create(owner.userId, { name: 'AI 战斗矿坑', ruleset: 'dnd5e' });
  await campaigns.join({ userId: a.userId }, created.campaign.id, created.inviteCode);
  const ownerCtx = await resolveCampaignContext(db, { userId: owner.userId }, created.campaign.id);
  const aCtx = await resolveCampaignContext(db, { userId: a.userId }, created.campaign.id);
  const draft = await characters.createDraft(aCtx, { name: '薇拉', sheet: { ac: 14 } });
  await characters.submitForReview(aCtx, draft.id);
  await characters.approve(ownerCtx, draft.id);
  const combat = new CombatService(db, new OutboxRepository(db), () => 0.5);
  const adapter = new CombatAiAdapter(combat, new CombatRepository(db));
  return { db, combat, adapter, ownerCtx, aCtx };
}

describe('combat AI adapter', () => {
  it('maps a whitelisted combat patch to the same command port and applies it in the caller tx', async () => {
    const { db, combat, adapter, ownerCtx } = await makeFixture();
    const encounter = await combat.start(ownerCtx, {
      name: 'AI 打击', combatants: [publicFighter, { ...publicFighter, name: '靶子', hpCurrent: 10, hpMax: 10, ac: 5 }],
    });
    await combat.execute(ownerCtx, encounter.id, { kind: 'roll_initiative', payload: {} });
    const fighter = (await combat.get(ownerCtx, encounter.id)).combatants[0];
    const target = (await combat.get(ownerCtx, encounter.id)).combatants[1];
    // adapter.apply 在调用方 tx 内执行（CombatService.applyIn 不再开 transaction）。
    const result = await db.transaction(async (tx) => {
      await adapter.apply(tx, ownerCtx.campaignId, markStateChangeValidated({
        kind: 'combat',
        targetId: encounter.id,
        patch: { command: 'apply_damage', actorCombatantId: fighter.id, targetCombatantId: target.id, amount: 4 },
        visibility: 'public',
      }));
      const rows = await tx.query<{ hp_current: number }>('SELECT hp_current FROM platform_combatants WHERE id = ?', [target.id]);
      return rows[0].hp_current;
    });
    expect(result).toBe(6);
    // 同一 tx 内发布了 combat.updated（与 entries/archive 同原子性）。
    const events = await db.query<{ count: number }>(
      'SELECT COUNT(*) AS count FROM platform_outbox_events WHERE campaign_id = ? AND event_type = ?',
      [ownerCtx.campaignId, 'combat.updated'],
    );
    expect(Number(events[0].count)).toBe(3); // start + roll_initiative + apply_damage
    await db.close();
  });

  it('rejects an unvalidated change before the adapter can reach combat state', async () => {
    const { db, combat, adapter, ownerCtx } = await makeFixture();
    const encounter = await combat.start(ownerCtx, {
      name: '未校验', combatants: [publicFighter, { ...publicFighter, name: '靶子', hpCurrent: 10, hpMax: 10 }],
    });
    await combat.execute(ownerCtx, encounter.id, { kind: 'roll_initiative', payload: {} });
    const target = (await combat.get(ownerCtx, encounter.id)).combatants[1];
    await expect(db.transaction((tx) => adapter.apply(tx, ownerCtx.campaignId, {
      kind: 'combat', targetId: encounter.id,
      patch: { command: 'apply_damage', actorCombatantId: 'actor', targetCombatantId: target.id, amount: 4 },
      visibility: 'public',
    }))).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
    const row = await db.query<{ hp_current: number }>('SELECT hp_current FROM platform_combatants WHERE id = ?', [target.id]);
    expect(row[0].hp_current).toBe(10);
    await db.close();
  });

  it('rejects a start_encounter command via AI with AI_OUTPUT_INVALID', async () => {
    const { db, adapter, ownerCtx } = await makeFixture();
    await expect(db.transaction((tx) => adapter.apply(tx, ownerCtx.campaignId, {
      kind: 'combat', targetId: 'enc-x',
      patch: { command: 'start_encounter', name: 'x', combatants: [publicFighter] } as never,
      visibility: 'public',
    }))).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
    await db.close();
  });

  it('rejects a cross-campaign or missing encounter target with AI_OUTPUT_INVALID', async () => {
    const { db, adapter, ownerCtx } = await makeFixture();
    await expect(db.transaction((tx) => adapter.apply(tx, ownerCtx.campaignId, {
      kind: 'combat', targetId: 'no-such-encounter',
      patch: { command: 'advance_turn' },
      visibility: 'public',
    }))).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
    await db.close();
  });

  it('keeps combat state conflicts as STATE_CONFLICT', async () => {
    const { db, combat, adapter, ownerCtx } = await makeFixture();
    const encounter = await combat.start(ownerCtx, {
      name: '冲突', combatants: [publicFighter, { ...publicFighter, name: '靶子', hpCurrent: 10, hpMax: 10 }],
    });
    // 未 roll_initiative：非 active 状态，命令必须 STATE_CONFLICT。
    const fighter = (await combat.get(ownerCtx, encounter.id)).combatants[0];
    const target = (await combat.get(ownerCtx, encounter.id)).combatants[1];
    await expect(db.transaction((tx) => adapter.apply(tx, ownerCtx.campaignId, markStateChangeValidated({
      kind: 'combat', targetId: encounter.id,
      patch: { command: 'apply_damage', actorCombatantId: fighter.id, targetCombatantId: target.id, amount: 1 },
      visibility: 'public',
    })))).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    // 冲突时 combat row 与 outbox 都不变。
    const hp = await db.query<{ hp_current: number }>('SELECT hp_current FROM platform_combatants WHERE id = ?', [target.id]);
    expect(hp[0].hp_current).toBe(10);
    const events = await db.query<{ count: number }>(
      'SELECT COUNT(*) AS count FROM platform_outbox_events WHERE campaign_id = ? AND event_type = ?',
      [ownerCtx.campaignId, 'combat.updated'],
    );
    expect(Number(events[0].count)).toBe(1); // 只有 start 的 combat.updated
    await db.close();
  });

  it('rejects a patch with an unknown command or invalid payload fields', async () => {
    const { db, combat, adapter, ownerCtx } = await makeFixture();
    const encounter = await combat.start(ownerCtx, { name: '坏命令', combatants: [publicFighter] });
    await expect(db.transaction((tx) => adapter.apply(tx, ownerCtx.campaignId, {
      kind: 'combat', targetId: encounter.id, patch: { command: 'apply_magic' } as never, visibility: 'public',
    }))).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
    await expect(db.transaction((tx) => adapter.apply(tx, ownerCtx.campaignId, {
      kind: 'combat', targetId: encounter.id,
      patch: { command: 'apply_damage', actorCombatantId: 'a', targetCombatantId: 'b', amount: 3, surprise: true } as never,
      visibility: 'public',
    }))).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
    await db.close();
  });

  it('starts an AI encounter and rolls initiative in the same caller tx by default', async () => {
    const { db, adapter, ownerCtx } = await makeFixture();
    await db.transaction(async (tx) => {
      await adapter.startEncounter(tx, ownerCtx.campaignId, {
        name: 'AI 伏击',
        combatants: [publicFighter, { ...publicFighter, name: '靶子', hpCurrent: 10, hpMax: 10 }],
      });
      // 同 tx 内：encounter 已 active 且先攻已由服务端 RNG 掷出。
      const rows = await tx.query<{ status: string; active_combatant_id: string | null }>(
        'SELECT status, active_combatant_id FROM platform_encounters WHERE campaign_id = ?', [ownerCtx.campaignId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('active');
      expect(rows[0].active_combatant_id).not.toBeNull();
      const combatants = await tx.query<{ initiative: number | null }>(
        'SELECT initiative FROM platform_combatants WHERE campaign_id = ?', [ownerCtx.campaignId],
      );
      expect(combatants.every((c) => c.initiative !== null)).toBe(true);
    });
    // combat.updated 与创建/掷先攻同 tx：2 条事件（create + roll_initiative）。
    const events = await db.query<{ count: number }>(
      'SELECT COUNT(*) AS count FROM platform_outbox_events WHERE campaign_id = ? AND event_type = ?',
      [ownerCtx.campaignId, 'combat.updated'],
    );
    expect(Number(events[0].count)).toBe(2);
    await db.close();
  });

  it('honors rollInitiative=false and leaves the encounter in preparation', async () => {
    const { db, adapter, ownerCtx } = await makeFixture();
    await db.transaction((tx) => adapter.startEncounter(tx, ownerCtx.campaignId, {
      name: '对峙',
      rollInitiative: false,
      combatants: [publicFighter],
    }));
    const rows = await db.query<{ status: string }>(
      'SELECT status FROM platform_encounters WHERE campaign_id = ?', [ownerCtx.campaignId],
    );
    expect(rows[0].status).toBe('preparation');
    await db.close();
  });

  it('converts AI creation VALIDATION_ERROR (non-member / cross-campaign / malformed) to AI_OUTPUT_INVALID', async () => {
    const { db, adapter, ownerCtx } = await makeFixture();
    // 跨战役 characterId：validateCombatants 抛 VALIDATION_ERROR → 转 AI_OUTPUT_INVALID。
    await expect(db.transaction((tx) => adapter.startEncounter(tx, ownerCtx.campaignId, {
      name: '坏角色',
      combatants: [{ ...publicFighter, characterId: 'ch-from-another-campaign' }],
    }))).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
    // 非成员 targetPlayerId 同样转码。
    await expect(db.transaction((tx) => adapter.startEncounter(tx, ownerCtx.campaignId, {
      name: '坏目标',
      combatants: [{ ...publicFighter, visibility: 'player_private', targetPlayerId: 'ghost' }],
    }))).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
    // schema 失败（缺 hpMax 等）→ AI_OUTPUT_INVALID。
    await expect(db.transaction((tx) => adapter.startEncounter(tx, ownerCtx.campaignId, {
      name: '坏 schema',
      combatants: [{ name: 'x', characterId: null, initiativeBonus: 0, hpCurrent: 5, ac: 10, visibility: 'public', targetPlayerId: null } as never],
    }))).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
    // 全部失败路径都不落库。
    const rows = await db.query('SELECT id FROM platform_encounters WHERE campaign_id = ?', [ownerCtx.campaignId]);
    expect(rows).toHaveLength(0);
    await db.close();
  });

  it('preserves STATE_CONFLICT when an unfinished encounter already exists', async () => {
    const { db, combat, adapter, ownerCtx } = await makeFixture();
    await combat.start(ownerCtx, { name: '已有遭遇', combatants: [publicFighter] });
    await expect(db.transaction((tx) => adapter.startEncounter(tx, ownerCtx.campaignId, {
      name: '重复发起',
      combatants: [publicFighter],
    }))).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    // 只有一个 encounter。
    const rows = await db.query('SELECT id FROM platform_encounters WHERE campaign_id = ?', [ownerCtx.campaignId]);
    expect(rows).toHaveLength(1);
    await db.close();
  });
});
