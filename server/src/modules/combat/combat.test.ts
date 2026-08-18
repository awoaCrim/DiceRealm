import { describe, expect, it } from 'vitest';
import { nanoid } from 'nanoid';
import type { CampaignAuthContext } from '../campaigns/CampaignAccess.js';
import { resolveCampaignContext } from '../campaigns/CampaignAccess.js';
import { CampaignService } from '../campaigns/CampaignService.js';
import { CharacterService } from '../characters/CharacterService.js';
import { IdentityService } from '../identity/IdentityService.js';
import { createSqliteDatabase } from '../../platform/database/SqliteDatabaseAdapter.js';
import { OutboxRepository } from '../../platform/events/OutboxRepository.js';
import { CombatService } from './CombatService.js';
import { CombatRepository } from './CombatRepository.js';
import { ArchiveService } from '../archives/ArchiveService.js';
import { TurnService } from '../turns/TurnService.js';
import type { StartEncounterInput } from '@dnd/contracts';
import type { QueryExecutor } from '../../platform/database/DatabasePort.js';

/** 确定性 RNG：每次调用返回序列中下一个 [0,1)。 */
function seqRandom(values: number[]): () => number {
  let i = 0;
  return () => {
    const value = values[i % values.length];
    i += 1;
    return value;
  };
}

async function makeFixture() {
  const db = createSqliteDatabase(':memory:');
  await db.migrate();
  const identity = new IdentityService(db);
  const campaigns = new CampaignService(db);
  const characters = new CharacterService(db);
  const owner = await identity.register({ login: 'combat-owner@example.test', password: 'correct-password' });
  const a = await identity.register({ login: 'combat-a@example.test', password: 'correct-password' });
  const b = await identity.register({ login: 'combat-b@example.test', password: 'correct-password' });
  const created = await campaigns.create(owner.userId, { name: '战斗矿坑', ruleset: 'dnd5e' });
  for (const user of [a, b]) {
    await campaigns.join({ userId: user.userId }, created.campaign.id, created.inviteCode);
  }
  const ownerCtx = await resolveCampaignContext(db, { userId: owner.userId }, created.campaign.id);
  const aCtx = await resolveCampaignContext(db, { userId: a.userId }, created.campaign.id);
  const bCtx = await resolveCampaignContext(db, { userId: b.userId }, created.campaign.id);
  const approve = async (ctx: CampaignAuthContext, name: string) => {
    const draft = await characters.createDraft(ctx, { name, sheet: { ac: 14 } });
    await characters.submitForReview(ctx, draft.id);
    await characters.approve(ownerCtx, draft.id);
    return draft.id;
  };
  const charA = await approve(aCtx, '薇拉');
  const charB = await approve(bCtx, '卡恩');
  const outbox = new OutboxRepository(db);
  const combat = new CombatService(db, outbox, seqRandom([0.5]));
  const archives = new ArchiveService(db, new OutboxRepository(db));
  const turns = new TurnService(db, new OutboxRepository(db));
  return { db, combat, archives, turns, ownerCtx, aCtx, bCtx, charA, charB, outbox };
}

const publicFighter: StartEncounterInput['combatants'][number] = {
  name: '战士',
  characterId: null,
  initiativeBonus: 2,
  hpCurrent: 12,
  hpMax: 12,
  ac: 16,
  conditions: [],
  visibility: 'public',
  targetPlayerId: null,
};

describe('combat service', () => {
  it('owner starts a preparation encounter with combatants and publishes combat.updated in the same tx', async () => {
    const { db, combat, ownerCtx } = await makeFixture();
    const encounter = await combat.start(ownerCtx, {
      name: '地窖遭遇',
      combatants: [publicFighter, { ...publicFighter, name: '地精', hpCurrent: 7, hpMax: 7, ac: 13 }],
    });
    expect(encounter.status).toBe('preparation');
    expect(encounter.round).toBe(1);
    expect(encounter.activeCombatantId).toBeNull();
    expect(encounter.combatants).toHaveLength(2);
    expect(encounter.combatants.every((combatant) => Boolean(combatant.actorId))).toBe(true);
    expect(encounter.combatants[0].id).not.toBe(encounter.combatants[0].actorId);
    expect(encounter.combatants[0].characterId).toBeNull();
    expect(encounter.combatants[0].initiative).toBeNull();
    expect(encounter.combatants[0].initiativeBonus).toBe(2);
    // 时间戳显式 ISO（不是 SQLite 默认格式）。
    expect(encounter.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(encounter.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const events = await db.query<{ event_type: string; payload_json: string }>(
      'SELECT event_type, payload_json FROM platform_outbox_events WHERE campaign_id = ? AND event_type = ?',
      [ownerCtx.campaignId, 'combat.updated'],
    );
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload_json)).toMatchObject({
      type: 'combat.updated', campaignId: ownerCtx.campaignId, encounterId: encounter.id,
    });
    await db.close();
  });

  it('rejects a player starting an encounter with FORBIDDEN', async () => {
    const { db, combat, aCtx } = await makeFixture();
    await expect(combat.start(aCtx, { name: '越权', combatants: [publicFighter] }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    await db.close();
  });

  it('rejects a second unfinished encounter with STATE_CONFLICT', async () => {
    const { db, combat, ownerCtx } = await makeFixture();
    await combat.start(ownerCtx, { name: '遭遇一', combatants: [publicFighter] });
    await expect(combat.start(ownerCtx, { name: '遭遇二', combatants: [publicFighter] }))
      .rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    // 第二个 encounter 行与额外事件都不存在（整体回滚）。
    const rows = await db.query<{ count: number }>(
      'SELECT COUNT(*) AS count FROM platform_encounters WHERE campaign_id = ? AND name = ?',
      [ownerCtx.campaignId, '遭遇二'],
    );
    expect(Number(rows[0].count)).toBe(0);
    await db.close();
  });

  it('rejects start with a cross-campaign characterId or non-member targetPlayerId', async () => {
    const { db, combat, ownerCtx, aCtx } = await makeFixture();
    // 其它战役的角色。
    const otherCampaign = await new CampaignService(db).create(aCtx.userId, { name: '别的战役', ruleset: 'dnd5e' });
    await db.execute(
      'INSERT INTO platform_characters (id, campaign_id, player_id, name, status, sheet_json, derived_json, submitted_at, approved_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)',
      ['foreign-char', otherCampaign.campaign.id, aCtx.playerId, '外域角色', 'approved', '{}', '{}', new Date().toISOString(), new Date().toISOString()],
    );
    await expect(combat.start(ownerCtx, {
      name: '坏角色', combatants: [{ ...publicFighter, characterId: 'foreign-char' }],
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    // targetPlayerId 必须是 member；用另一个战役的 owner 用户 id 也拒绝。
    const outsider = await new IdentityService(db).register({ login: 'outsider@example.test', password: 'correct-password' });
    await expect(combat.start(ownerCtx, {
      name: '坏目标', combatants: [{ ...publicFighter, visibility: 'player_private', targetPlayerId: outsider.userId }],
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await db.close();
  });

  it('seeds an existing Actor Combatant from runtime and rejects Actor/Character mismatch', async () => {
    const { db, combat, ownerCtx, charA, charB } = await makeFixture();
    const actorId = `actor:character:${charA}`;
    await db.execute(
      `UPDATE platform_character_runtime_states
       SET current_hp = ?, temporary_hp = ?, conditions_json = ?, runtime_status = ?
       WHERE campaign_id = ? AND actor_id = ?`,
      [4, 2, JSON.stringify(['poisoned']), 'active', ownerCtx.campaignId, actorId],
    );
    const encounter = await combat.start(ownerCtx, {
      name: 'runtime seed',
      combatants: [
        {
          actorId,
          characterId: charA,
          name: 'Kayla input must not win',
          initiativeBonus: 2,
          hpCurrent: 20,
          hpMax: 4,
          ac: 16,
          conditions: ['caller-condition-must-not-win'],
          visibility: 'public',
          targetPlayerId: null,
        },
        publicFighter,
      ],
    });
    const seeded = encounter.combatants.find((combatant) => combatant.actorId === actorId)!;
    expect(seeded.characterId).toBe(charA);
    expect(seeded.hpCurrent).toBe(4);
    expect(seeded.conditions).toEqual(['poisoned']);
    const active = await combat.execute(ownerCtx, encounter.id, { kind: 'roll_initiative', payload: {} });
    await combat.execute(ownerCtx, encounter.id, {
      kind: 'apply_damage',
      payload: {
        actorCombatantId: active.activeCombatantId as string,
        targetCombatantId: seeded.id,
        amount: 3,
      },
    });
    const runtime = (await db.query<{ current_hp: number }>(
      'SELECT current_hp FROM platform_character_runtime_states WHERE campaign_id = ? AND actor_id = ?',
      [ownerCtx.campaignId, actorId],
    ))[0];
    const projection = await combat.get(ownerCtx, encounter.id);
    expect(runtime.current_hp).toBe(3);
    expect(projection.combatants.find((combatant) => combatant.id === seeded.id)?.hpCurrent).toBe(3);
    await combat.execute(ownerCtx, encounter.id, {
      kind: 'apply_healing',
      payload: {
        actorCombatantId: active.activeCombatantId as string,
        targetCombatantId: seeded.id,
        amount: 99,
      },
    });
    const healedRuntime = (await db.query<{ current_hp: number }>(
      'SELECT current_hp FROM platform_character_runtime_states WHERE campaign_id = ? AND actor_id = ?',
      [ownerCtx.campaignId, actorId],
    ))[0];
    expect(healedRuntime.current_hp).toBe(4);
    await combat.execute(ownerCtx, encounter.id, { kind: 'end_encounter', payload: {} });
    await expect(combat.start(ownerCtx, {
      name: 'mismatched character',
      combatants: [{
        actorId,
        characterId: charB,
        name: 'wrong character reference',
        initiativeBonus: 0,
        hpCurrent: 4,
        hpMax: 4,
        ac: 10,
        conditions: [],
        visibility: 'public',
        targetPlayerId: null,
      }],
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await db.close();
  });

  it('rolls initiative with server RNG, sorts stably by total desc, and activates the encounter', async () => {
    const { db, combat, ownerCtx } = await makeFixture();
    // 注入 RNG 返回 0.5 → d20 固定为 10（d20 = floor(0.5*20)+1 = 11；见实现约定）。
    const combat2 = new CombatService(db, new OutboxRepository(db), () => 0.5);
    const encounter = await combat2.start(ownerCtx, {
      name: '先攻',
      combatants: [
        { ...publicFighter, name: '慢速', initiativeBonus: 0 },
        { ...publicFighter, name: '快速', initiativeBonus: 5 },
        { ...publicFighter, name: '中速', initiativeBonus: 2 },
      ],
    });
    const active = await combat2.execute(ownerCtx, encounter.id, { kind: 'roll_initiative', payload: {} });
    expect(active.status).toBe('active');
    expect(active.activeCombatantId).toBeTruthy();
    // initiative = d20 + bonus，全部由服务端 RNG 产生。
    const byName = Object.fromEntries(active.combatants.map((c) => [c.name, c]));
    expect(byName['快速'].initiative).toBeGreaterThan(byName['中速'].initiative as number);
    expect(byName['中速'].initiative).toBeGreaterThan(byName['慢速'].initiative as number);
    // 首行动者是最快者。
    expect(active.activeCombatantId).toBe(byName['快速'].id);
    // 排序写入 positions 0..n-1。
    const positions = await db.query<{ name: string; position: number }>(
      'SELECT name, position FROM platform_combatants WHERE encounter_id = ? ORDER BY position',
      [encounter.id],
    );
    expect(positions.map((p) => p.name)).toEqual(['快速', '中速', '慢速']);
    expect(positions.map((p) => p.position)).toEqual([0, 1, 2]);
    await db.close();
  });

  it('applies attack with server RNG: hit deals floored damage, miss deals none', async () => {
    const { db, combat, ownerCtx } = await makeFixture();
    // 攻击骰命中：rng 0.99 → d20=20（必中），伤害骰 rng 0.5。
    const hitCombat = new CombatService(db, new OutboxRepository(db), seqRandom([0.99, 0.5]));
    const encounter = await hitCombat.start(ownerCtx, {
      name: '打击', combatants: [publicFighter, { ...publicFighter, name: '靶子', hpCurrent: 10, hpMax: 10, ac: 10 }],
    });
    const active = await hitCombat.execute(ownerCtx, encounter.id, { kind: 'roll_initiative', payload: {} });
    const fighter = active.combatants[0];
    const target = active.combatants[1];
    const after = await hitCombat.execute(ownerCtx, encounter.id, {
      kind: 'apply_attack',
      payload: { actorCombatantId: fighter.id, targetCombatantId: target.id, attackBonus: 0, damageDie: 'd8', damageDice: 1, damageBonus: 0 },
    });
    const targetAfter = after.combatants.find((c) => c.id === target.id);
    // d8 with rng 0.5 → 5（floor(0.5*8)+1=5），10 - 5 = 5。
    expect(targetAfter?.hpCurrent).toBe(5);
    await hitCombat.execute(ownerCtx, encounter.id, { kind: 'end_encounter', payload: {} });
    // 下一次：攻击骰未命中（rng 0.0 → d20=1）。
    const missCombat = new CombatService(db, new OutboxRepository(db), seqRandom([0.0]));
    const enc2 = await missCombat.start(ownerCtx, { name: '未命中', combatants: [publicFighter, { ...publicFighter, name: '高甲', hpCurrent: 6, hpMax: 6, ac: 25 }] });
    const active2 = await missCombat.execute(ownerCtx, enc2.id, { kind: 'roll_initiative', payload: {} });
    const f2 = active2.combatants[0];
    const t2 = active2.combatants[1];
    const afterMiss = await missCombat.execute(ownerCtx, enc2.id, {
      kind: 'apply_attack',
      payload: { actorCombatantId: f2.id, targetCombatantId: t2.id, attackBonus: 0, damageDie: 'd8', damageDice: 1, damageBonus: 0 },
    });
    expect(afterMiss.combatants.find((c) => c.id === t2.id)?.hpCurrent).toBe(6);
    await db.close();
  });

  it('floors negative total damage at zero and never heals', async () => {
    const { db, combat, ownerCtx } = await makeFixture();
    const hitCombat = new CombatService(db, new OutboxRepository(db), seqRandom([0.99, 0.0]));
    const encounter = await hitCombat.start(ownerCtx, {
      name: '负伤', combatants: [publicFighter, { ...publicFighter, name: '靶子', hpCurrent: 8, hpMax: 8, ac: 5 }],
    });
    const active = await hitCombat.execute(ownerCtx, encounter.id, { kind: 'roll_initiative', payload: {} });
    const fighter = active.combatants[0];
    const target = active.combatants[1];
    // d8 rng 0.0 → 1，damageBonus -5 → total -4 → floor 0。
    const after = await hitCombat.execute(ownerCtx, encounter.id, {
      kind: 'apply_attack',
      payload: { actorCombatantId: fighter.id, targetCombatantId: target.id, attackBonus: 0, damageDie: 'd8', damageDice: 1, damageBonus: -5 },
    });
    expect(after.combatants.find((c) => c.id === target.id)?.hpCurrent).toBe(8);
    await db.close();
  });

  it('applies saving throws: failure applies damage, success applies none', async () => {
    const { db, combat, ownerCtx } = await makeFixture();
    // rng 0.0 → d20=1：豁免必然失败（1 + saveBonus < dc）。
    const failCombat = new CombatService(db, new OutboxRepository(db), seqRandom([0.0]));
    const enc1 = await failCombat.start(ownerCtx, {
      name: '豁免败', combatants: [publicFighter, { ...publicFighter, name: '靶子', hpCurrent: 10, hpMax: 10, ac: 12 }],
    });
    const active1 = await failCombat.execute(ownerCtx, enc1.id, { kind: 'roll_initiative', payload: {} });
    const f1 = active1.combatants[0];
    const t1 = active1.combatants[1];
    const after1 = await failCombat.execute(ownerCtx, enc1.id, {
      kind: 'apply_saving_throw',
      payload: { actorCombatantId: f1.id, targetCombatantId: t1.id, saveBonus: 0, dc: 13, damageOnFailure: 4 },
    });
    expect(after1.combatants.find((c) => c.id === t1.id)?.hpCurrent).toBe(6);
    await failCombat.execute(ownerCtx, enc1.id, { kind: 'end_encounter', payload: {} });
    // rng 0.99 → d20=20：豁免必然成功（20 + saveBonus >= dc）。
    const okCombat = new CombatService(db, new OutboxRepository(db), seqRandom([0.99]));
    const enc2 = await okCombat.start(ownerCtx, {
      name: '豁免胜', combatants: [publicFighter, { ...publicFighter, name: '靶子', hpCurrent: 10, hpMax: 10, ac: 12 }],
    });
    const active2 = await okCombat.execute(ownerCtx, enc2.id, { kind: 'roll_initiative', payload: {} });
    const f2 = active2.combatants[0];
    const t2 = active2.combatants[1];
    const after2 = await okCombat.execute(ownerCtx, enc2.id, {
      kind: 'apply_saving_throw',
      payload: { actorCombatantId: f2.id, targetCombatantId: t2.id, saveBonus: 0, dc: 13, damageOnFailure: 4 },
    });
    expect(after2.combatants.find((c) => c.id === t2.id)?.hpCurrent).toBe(10);
    await db.close();
  });

  it('advances turns and wraps the round', async () => {
    const { db, combat, ownerCtx } = await makeFixture();
    const encounter = await combat.start(ownerCtx, {
      name: '轮转', combatants: [publicFighter, { ...publicFighter, name: '第二', hpCurrent: 5, hpMax: 5 }],
    });
    const active = await combat.execute(ownerCtx, encounter.id, { kind: 'roll_initiative', payload: {} });
    const firstId = active.activeCombatantId;
    const secondId = active.combatants.find((c) => c.id !== firstId)!.id;
    const step2 = await combat.execute(ownerCtx, encounter.id, { kind: 'advance_turn', payload: {} });
    expect(step2.activeCombatantId).toBe(secondId);
    expect(step2.round).toBe(1);
    const step3 = await combat.execute(ownerCtx, encounter.id, { kind: 'advance_turn', payload: {} });
    expect(step3.activeCombatantId).toBe(firstId);
    expect(step3.round).toBe(2); // 回绕时 round+1
    await db.close();
  });

  it('rejects non-active actor commands with STATE_CONFLICT and changes nothing', async () => {
    const { db, combat, ownerCtx } = await makeFixture();
    const encounter = await combat.start(ownerCtx, {
      name: '门禁', combatants: [publicFighter, { ...publicFighter, name: '旁观者', hpCurrent: 5, hpMax: 5 }],
    });
    const active = await combat.execute(ownerCtx, encounter.id, { kind: 'roll_initiative', payload: {} });
    const activeId = active.activeCombatantId as string;
    const idleId = active.combatants.find((c) => c.id !== activeId)!.id;
    const before = await db.query<{ hp_current: number }>('SELECT hp_current FROM platform_combatants WHERE id = ?', [idleId]);
    const eventsBefore = await db.query<{ count: number }>(
      'SELECT COUNT(*) AS count FROM platform_outbox_events WHERE campaign_id = ?', [ownerCtx.campaignId],
    );
    await expect(combat.execute(ownerCtx, encounter.id, {
      kind: 'apply_damage', payload: { actorCombatantId: idleId, targetCombatantId: activeId, amount: 3 },
    })).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    const after = await db.query<{ hp_current: number }>('SELECT hp_current FROM platform_combatants WHERE id = ?', [idleId]);
    const eventsAfter = await db.query<{ count: number }>(
      'SELECT COUNT(*) AS count FROM platform_outbox_events WHERE campaign_id = ?', [ownerCtx.campaignId],
    );
    expect(after[0].hp_current).toBe(before[0].hp_current);
    expect(Number(eventsAfter[0].count)).toBe(Number(eventsBefore[0].count));
    await db.close();
  });

  it('applies damage/healing/conditions and ends the encounter', async () => {
    const { db, combat, ownerCtx } = await makeFixture();
    const encounter = await combat.start(ownerCtx, {
      name: '流程', combatants: [publicFighter, { ...publicFighter, name: '目标', hpCurrent: 6, hpMax: 6 }],
    });
    const active = await combat.execute(ownerCtx, encounter.id, { kind: 'roll_initiative', payload: {} });
    const actor = active.combatants[0];
    const target = active.combatants[1];
    let state = await combat.execute(ownerCtx, encounter.id, {
      kind: 'apply_damage', payload: { actorCombatantId: actor.id, targetCombatantId: target.id, amount: 4 },
    });
    expect(state.combatants.find((c) => c.id === target.id)?.hpCurrent).toBe(2);
    state = await combat.execute(ownerCtx, encounter.id, {
      kind: 'apply_healing', payload: { actorCombatantId: actor.id, targetCombatantId: target.id, amount: 3 },
    });
    expect(state.combatants.find((c) => c.id === target.id)?.hpCurrent).toBe(5);
    state = await combat.execute(ownerCtx, encounter.id, {
      kind: 'add_condition', payload: { actorCombatantId: actor.id, targetCombatantId: target.id, condition: '中毒' },
    });
    expect(state.combatants.find((c) => c.id === target.id)?.conditions).toEqual(['中毒']);
    // 去重：重复添加幂等。
    state = await combat.execute(ownerCtx, encounter.id, {
      kind: 'add_condition', payload: { actorCombatantId: actor.id, targetCombatantId: target.id, condition: '中毒' },
    });
    expect(state.combatants.find((c) => c.id === target.id)?.conditions).toEqual(['中毒']);
    // 移除不存在条件幂等成功。
    state = await combat.execute(ownerCtx, encounter.id, {
      kind: 'remove_condition', payload: { actorCombatantId: actor.id, targetCombatantId: target.id, condition: '不存在' },
    });
    expect(state.combatants.find((c) => c.id === target.id)?.conditions).toEqual(['中毒']);
    state = await combat.execute(ownerCtx, encounter.id, {
      kind: 'remove_condition', payload: { actorCombatantId: actor.id, targetCombatantId: target.id, condition: '中毒' },
    });
    expect(state.combatants.find((c) => c.id === target.id)?.conditions).toEqual([]);
    state = await combat.execute(ownerCtx, encounter.id, { kind: 'end_encounter', payload: {} });
    expect(state.status).toBe('completed');
    expect(state.activeCombatantId).toBeNull();
    // completed 之后任何命令 → STATE_CONFLICT。
    await expect(combat.execute(ownerCtx, encounter.id, {
      kind: 'apply_damage', payload: { actorCombatantId: actor.id, targetCombatantId: target.id, amount: 1 },
    })).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    await db.close();
  });

  it('projects owner/player views with targetPlayerId masking and hides invisible combatants', async () => {
    const { db, combat, ownerCtx, aCtx, bCtx } = await makeFixture();
    const encounter = await combat.start(ownerCtx, {
      name: '隐私',
      combatants: [
        publicFighter,
        { ...publicFighter, name: '密探', visibility: 'player_private', targetPlayerId: aCtx.playerId as string },
        { ...publicFighter, name: '伏兵', visibility: 'owner_only', targetPlayerId: null },
      ],
    });
    // owner 全量可见；preparation 阶段 initiative=null 但元数据可见。
    const ownerView = await combat.get(ownerCtx, encounter.id);
    expect(ownerView.combatants.map((c) => c.name)).toEqual(['战士', '密探', '伏兵']);
    expect(ownerView.combatants.every((c) => c.initiative === null)).toBe(true);
    const aView = await combat.get(aCtx, encounter.id);
    expect(aView.combatants.map((c) => c.name)).toEqual(['战士', '密探']); // 伏兵隐藏
    const aPrivate = aView.combatants.find((c) => c.name === '密探');
    expect(aPrivate?.targetPlayerId).toBe(aCtx.playerId); // 自己的 target 保留
    expect(aView.combatants.find((c) => c.name === '战士')?.targetPlayerId).toBeNull();
    const bView = await combat.get(bCtx, encounter.id);
    expect(bView.combatants.map((c) => c.name)).toEqual(['战士']); // player_private 不是 B 的
    await db.close();
  });

  it('masks a hidden activeCombatantId for players and lists only own campaign', async () => {
    const { db, combat, ownerCtx, aCtx, bCtx } = await makeFixture();
    const otherCampaign = await new CampaignService(db).create(bCtx.userId, { name: '他人战役', ruleset: 'dnd5e' });
    await db.execute(
      'INSERT INTO campaign_members (campaign_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
      [otherCampaign.campaign.id, ownerCtx.userId, 'owner', new Date().toISOString()],
    );
    const encounter = await combat.start(ownerCtx, {
      name: '隐藏行动者',
      combatants: [
        { ...publicFighter, name: '明面', visibility: 'public', targetPlayerId: null },
        { ...publicFighter, name: '暗影', visibility: 'owner_only', targetPlayerId: null },
      ],
    });
    // 恒定 rng 0.5 → d20=11，两人同 total=13，稳定排序按原 position：明面在前。
    const active = await combat.execute(ownerCtx, encounter.id, { kind: 'roll_initiative', payload: {} });
    const shadow = active.combatants.find((c) => c.name === '暗影')!;
    const light = active.combatants.find((c) => c.name === '明面')!;
    expect(active.activeCombatantId).toBe(light.id);
    // 明面可见时 player 能看到 activeCombatantId。
    let playerView = await combat.get(aCtx, encounter.id);
    expect(playerView.activeCombatantId).toBe(light.id);
    // 推进到暗影：player 看不到 owner_only 战斗员，activeCombatantId 必须为 null。
    await combat.execute(ownerCtx, encounter.id, { kind: 'advance_turn', payload: {} });
    playerView = await combat.get(aCtx, encounter.id);
    expect(playerView.activeCombatantId).toBeNull();
    expect(playerView.combatants.some((c) => c.name === '暗影')).toBe(false);
    // list 只返回本 campaign 的 encounters（他人战役的遭遇对 A 不可见）。
    const otherEncounter = await combat.start({
      userId: bCtx.userId, campaignId: otherCampaign.campaign.id, role: 'owner', playerId: null,
    }, { name: '他人遭遇', combatants: [publicFighter] });
    const aList = await combat.list(aCtx);
    expect(aList.some((e) => e.id === otherEncounter.id)).toBe(false);
    await db.close();
  });

  it('filters superseded encounters and combatants from default queries', async () => {
    const { db, combat, ownerCtx, archives } = await makeFixture();
    const encounter = await combat.start(ownerCtx, { name: '历史', combatants: [publicFighter] });
    // 先创建真实 archive（superseded_by_archive_id 有 FK）。
    const archive = await archives.createManual(ownerCtx, 'supersede-来源');
    await db.execute(
      'UPDATE platform_encounters SET superseded_at = ?, superseded_by_archive_id = ? WHERE id = ?',
      [new Date().toISOString(), archive.id, encounter.id],
    );
    await db.execute(
      'UPDATE platform_combatants SET superseded_at = ?, superseded_by_archive_id = ? WHERE encounter_id = ?',
      [new Date().toISOString(), archive.id, encounter.id],
    );
    await expect(combat.get(ownerCtx, encounter.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const list = await combat.list(ownerCtx);
    expect(list.map((e) => e.id)).not.toContain(encounter.id);
    await db.close();
  });

  it('round-trips combat through a manual archive v2 and restores it', async () => {
    const { db, combat, archives, ownerCtx } = await makeFixture();
    const encounter = await combat.start(ownerCtx, {
      name: '存档战斗', combatants: [publicFighter, { ...publicFighter, name: '地精', hpCurrent: 5, hpMax: 5, ac: 13 }],
    });
    const active = await combat.execute(ownerCtx, encounter.id, { kind: 'roll_initiative', payload: {} });
    const fighter = active.combatants[0];
    const goblin = active.combatants[1];
    const after = await combat.execute(ownerCtx, encounter.id, {
      kind: 'apply_damage', payload: { actorCombatantId: fighter.id, targetCombatantId: goblin.id, amount: 2 },
    });
    expect(after.combatants.find((c) => c.id === goblin.id)?.hpCurrent).toBe(3);
    const manual = await archives.createManual(ownerCtx, '战斗存档');
    // 当前快照是 v3，且保留 v2 的 encounters 结构。
    const state = JSON.parse((await db.query<{ state_json: string }>('SELECT state_json FROM platform_archives WHERE id = ?', [manual.id]))[0].state_json);
    expect(state.schemaVersion).toBe(3);
    expect(state.encounters).toHaveLength(1);
    expect(state.encounters[0].combatants).toHaveLength(2);
    // 存档后修改战斗。
    const mutated = await combat.execute(ownerCtx, encounter.id, {
      kind: 'apply_healing', payload: { actorCombatantId: fighter.id, targetCombatantId: goblin.id, amount: 1 },
    });
    expect(mutated.combatants.find((c) => c.id === goblin.id)?.hpCurrent).toBe(4);
    await archives.restore(ownerCtx, manual.id);
    // 恢复后战斗回到快照状态（goblin hp=3），encounter 重新 active。
    const restored = await combat.get(ownerCtx, encounter.id);
    expect(restored.combatants.find((c) => c.id === goblin.id)?.hpCurrent).toBe(3);
    expect(restored.status).toBe('active');
    // 快照内 combatant 无 superseded。
    const rows = await db.query<{ id: string; superseded_at: string | null }>(
      'SELECT id, superseded_at FROM platform_combatants WHERE encounter_id = ?', [encounter.id],
    );
    expect(rows.every((r) => r.superseded_at === null)).toBe(true);
    await db.close();
  });

  it('v1 restore supersedes all current combat and v2 snapshot-in clears superseded', async () => {
    const { db, combat, archives, ownerCtx, aCtx, bCtx } = await makeFixture();
    const turns = new TurnService(db, new OutboxRepository(db));
    // 无任何战斗时创建 v2 存档，再手工转换为 schemaVersion=1 快照（Phase 2 语义：当时尚无平台战斗）。
    const t1 = await turns.startTurn(ownerCtx);
    const v1Archive = await archives.createManual(ownerCtx, 'v1-无战斗');
    const v1State = JSON.parse((await db.query<{ state_json: string }>('SELECT state_json FROM platform_archives WHERE id = ?', [v1Archive.id]))[0].state_json);
    expect(v1State.schemaVersion).toBe(3);
    delete v1State.encounters;
    v1State.schemaVersion = 1;
    await db.execute('UPDATE platform_archives SET state_json = ? WHERE id = ?', [JSON.stringify(v1State), v1Archive.id]);
    // 存档后开始一场战斗。
    const encounter = await combat.start(ownerCtx, { name: '战后战斗', combatants: [publicFighter] });
    await combat.execute(ownerCtx, encounter.id, { kind: 'roll_initiative', payload: {} });
    // 再创建一个 v2 存档（含该战斗），并去掉 v3 新增的 Actor/runtime 区块，模拟历史 v2 快照。
    const v2 = await archives.createManual(ownerCtx, 'v2-含战斗');
    const v2State = JSON.parse((await db.query<{ state_json: string }>('SELECT state_json FROM platform_archives WHERE id = ?', [v2.id]))[0].state_json);
    expect(v2State.schemaVersion).toBe(3);
    delete v2State.actors;
    delete v2State.actorControlBindings;
    delete v2State.characterRuntimeStates;
    v2State.schemaVersion = 2;
    await db.execute('UPDATE platform_archives SET state_json = ? WHERE id = ?', [JSON.stringify(v2State), v2.id]);
    // 恢复 v1：当前 unsuperseded 战斗全部 supersede。
    await archives.restore(ownerCtx, v1Archive.id);
    const encRow = await db.query<{ superseded_at: string | null; superseded_by_archive_id: string | null }>(
      'SELECT superseded_at, superseded_by_archive_id FROM platform_encounters WHERE id = ?', [encounter.id],
    );
    expect(encRow[0].superseded_at).not.toBeNull();
    expect(encRow[0].superseded_by_archive_id).toBe(v1Archive.id);
    await expect(combat.get(ownerCtx, encounter.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // 再恢复 v2：快照内 encounter 解除 superseded 并还原状态。
    await archives.restore(ownerCtx, v2.id);
    const encRow2 = await db.query<{ superseded_at: string | null; status: string }>(
      'SELECT superseded_at, status FROM platform_encounters WHERE id = ?', [encounter.id],
    );
    expect(encRow2[0].superseded_at).toBeNull();
    expect(encRow2[0].status).toBe('active');
    // v2 没有 Actor/runtime 区块时，仍应从快照中的 combatant 投影恢复 Actor runtime。
    const restoredCombatant = (await db.query<{ actor_id: string | null; hp_current: number; conditions_json: string }>(
      'SELECT actor_id, hp_current, conditions_json FROM platform_combatants WHERE encounter_id = ? AND superseded_at IS NULL',
      [encounter.id],
    ))[0];
    expect(restoredCombatant.actor_id).not.toBeNull();
    const restoredRuntime = (await db.query<{ current_hp: number; conditions_json: string; runtime_status: string }>(
      'SELECT current_hp, conditions_json, runtime_status FROM platform_character_runtime_states WHERE actor_id = ?',
      [restoredCombatant.actor_id],
    ))[0];
    expect(restoredRuntime).toMatchObject({
      current_hp: restoredCombatant.hp_current,
      conditions_json: restoredCombatant.conditions_json,
      runtime_status: restoredCombatant.hp_current === 0 ? 'defeated' : 'active',
    });
    await db.close();
  });

  it('normalizes a v2 snapshot missing encounters into INTERNAL_ERROR and rolls back', async () => {
    const { db, combat, archives, ownerCtx } = await makeFixture();
    const manual = await archives.createManual(ownerCtx, '坏v2');
    // 手工把 v2 快照的 encounters 字段删除 → schema fail → INTERNAL_ERROR。
    const state = JSON.parse((await db.query<{ state_json: string }>('SELECT state_json FROM platform_archives WHERE id = ?', [manual.id]))[0].state_json);
    delete state.encounters;
    await db.execute('UPDATE platform_archives SET state_json = ? WHERE id = ?', [JSON.stringify(state), manual.id]);
    await expect(archives.restore(ownerCtx, manual.id)).rejects.toMatchObject({ code: 'INTERNAL_ERROR', message: '存档快照无效。' });
    // 未发生任何战斗 supersede。
    const encCount = await db.query<{ count: number }>(
      'SELECT COUNT(*) AS count FROM platform_encounters WHERE campaign_id = ? AND superseded_at IS NOT NULL',
      [ownerCtx.campaignId],
    );
    expect(Number(encCount[0].count)).toBe(0);
    await db.close();
  });

  it('restores a v2 no-combat archive and supersedes any later combat', async () => {
    const { db, combat, archives, ownerCtx } = await makeFixture();
    // 无战斗时创建 manual 存档 → v2 快照 encounters=[]（空 encounter ids + 空 combatant ids）。
    const manual = await archives.createManual(ownerCtx, '无战斗存档');
    const state = JSON.parse((await db.query<{ state_json: string }>('SELECT state_json FROM platform_archives WHERE id = ?', [manual.id]))[0].state_json);
    expect(state.schemaVersion).toBe(3);
    expect(state.encounters).toEqual([]);
    // 存档后开始一场战斗。
    const encounter = await combat.start(ownerCtx, { name: '存档后战斗', combatants: [publicFighter] });
    await combat.execute(ownerCtx, encounter.id, { kind: 'roll_initiative', payload: {} });
    // 恢复无战斗存档：快照外的战斗必须全部 supersede（空列表路径不得生成非法 NOT IN）。
    await archives.restore(ownerCtx, manual.id);
    const encRow = await db.query<{ superseded_at: string | null; superseded_by_archive_id: string | null }>(
      'SELECT superseded_at, superseded_by_archive_id FROM platform_encounters WHERE id = ?', [encounter.id],
    );
    expect(encRow[0].superseded_at).not.toBeNull();
    expect(encRow[0].superseded_by_archive_id).toBe(manual.id);
    const cbtRow = await db.query<{ count: number }>(
      'SELECT COUNT(*) AS count FROM platform_combatants WHERE campaign_id = ? AND superseded_at IS NULL',
      [ownerCtx.campaignId],
    );
    expect(Number(cbtRow[0].count)).toBe(0); // 战斗员同样全部 superseded
    await db.close();
  });
});

describe('combat repository supersedeNotIn SQL portability', () => {
  /** 记录 SQL 的 executor 桩：只记录 execute 的 SQL 文本与参数，不执行。 */
  class RecordingExecutor implements QueryExecutor {
    readonly statements: Array<{ sql: string; params: unknown[] }> = [];
    async query<T>(): Promise<T[]> {
      return [];
    }
    async execute(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
      this.statements.push({ sql, params });
      return { changes: 0 };
    }
  }

  it('skips invalid NOT IN clauses when both kept lists are empty', async () => {
    const executor = new RecordingExecutor();
    const repo = new CombatRepository(executor);
    await repo.supersedeNotIn('c1', [], [], 'archive-1', 'now');
    expect(executor.statements).toHaveLength(2);
    // 空列表：UPDATE 不得生成无效的 'NOT IN ()'。
    for (const statement of executor.statements) {
      expect(statement.sql).not.toContain('NOT IN');
      expect(statement.sql).toMatch(/UPDATE platform_(encounters|combatants)/);
      expect(statement.params).toEqual(['now', 'archive-1', 'c1']);
    }
  });

  it('uses parameterized NOT IN when lists are non-empty and skips it for the empty list in mixed case', async () => {
    const executor = new RecordingExecutor();
    const repo = new CombatRepository(executor);
    // encounter ids 非空、combatant ids 空（快照含 encounter 但 combatants=[]）。
    await repo.supersedeNotIn('c1', ['enc-1', 'enc-2'], [], 'archive-1', 'now');
    expect(executor.statements).toHaveLength(2);
    const encountersSql = executor.statements[0].sql;
    expect(encountersSql).toMatch(/id NOT IN \(\?,\?\)/);
    expect(executor.statements[0].params).toEqual(['now', 'archive-1', 'c1', 'enc-1', 'enc-2']);
    const combatantsSql = executor.statements[1].sql;
    expect(combatantsSql).not.toContain('NOT IN');
    expect(executor.statements[1].params).toEqual(['now', 'archive-1', 'c1']);
    // 反向：encounter ids 空、combatant ids 非空。
    const executor2 = new RecordingExecutor();
    const repo2 = new CombatRepository(executor2);
    await repo2.supersedeNotIn('c1', [], ['cbt-1'], 'archive-1', 'now');
    expect(executor2.statements[0].sql).not.toContain('NOT IN');
    expect(executor2.statements[1].sql).toMatch(/id NOT IN \(\?\)/);
    expect(executor2.statements[1].params).toEqual(['now', 'archive-1', 'c1', 'cbt-1']);
  });
});
