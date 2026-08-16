import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../../platform/database/SqliteDatabaseAdapter.js';
import { resolveCampaignContext } from '../campaigns/CampaignAccess.js';
import { CampaignService } from '../campaigns/CampaignService.js';
import { CharacterService } from '../characters/CharacterService.js';
import { IdentityService } from '../identity/IdentityService.js';
import { OutboxRepository } from '../../platform/events/OutboxRepository.js';
import { TurnService } from '../turns/TurnService.js';
import { WorldFactService } from '../world/WorldFactService.js';
import { AiContextBuilder } from './AiContextBuilder.js';

describe('ai context builder', () => {
  it('builds an owner-safe prompt from locked actions, approved characters and active world facts', async () => {
    const db = createSqliteDatabase(':memory:');
    await db.migrate();
    const identity = new IdentityService(db);
    const campaigns = new CampaignService(db);
    const characters = new CharacterService(db);
    const worldFacts = new WorldFactService(db);
    const owner = await identity.register({ login: 'owner@example.test', password: 'correct-password' });
    const a = await identity.register({ login: 'a@example.test', password: 'correct-password' });
    const b = await identity.register({ login: 'b@example.test', password: 'correct-password' });
    const created = await campaigns.create(owner.userId, { name: '失落矿坑', ruleset: 'dnd5e' });
    for (const user of [a, b]) await campaigns.join({ userId: user.userId }, created.campaign.id, created.inviteCode);
    const ownerCtx = await resolveCampaignContext(db, { userId: owner.userId }, created.campaign.id);
    const aCtx = await resolveCampaignContext(db, { userId: a.userId }, created.campaign.id);
    const bCtx = await resolveCampaignContext(db, { userId: b.userId }, created.campaign.id);
    const approve = async (ctx: typeof aCtx, name: string) => {
      const draft = await characters.createDraft(ctx, { name, sheet: { ac: 14, hpCurrent: 10 } });
      await characters.submitForReview(ctx, draft.id);
      await characters.approve(ownerCtx, draft.id);
    };
    await approve(aCtx, '薇拉');
    await approve(bCtx, '卡恩');
    await worldFacts.create(ownerCtx, { title: '酒馆', kind: 'location', content: '热闹。', visibility: 'public' });
    await worldFacts.create(ownerCtx, { title: '密信', kind: 'item', content: '给 A。', visibility: 'player_private', knownBy: [aCtx.playerId as string] });
    const turns = new TurnService(db, new OutboxRepository(db));
    const turn = await turns.startTurn(ownerCtx);
    await turns.submitAction(aCtx, turn.id, { body: '我搜索房间。' });
    await turns.submitAction(bCtx, turn.id, { body: '我警戒门口。' });

    const builder = new AiContextBuilder(db);
    const pkg = await builder.buildForTurn(created.campaign.id, turn.id, db);
    expect(pkg.prompt.campaignId).toBe(created.campaign.id);
    // system 指令只存在于 messages 中，避免 context_json 同时保存顶层 system 与 system message。
    expect('system' in pkg.prompt).toBe(false);
    expect(pkg.prompt.messages.filter((message) => message.role === 'system')).toHaveLength(1);
    const promptText = pkg.prompt.messages.map((m) => m.content).join('\n');
    const userText = JSON.stringify(promptText);
    expect(userText).toContain('搜索房间');
    expect(userText).toContain('薇拉');
    expect(userText).toContain('酒馆');
    // 不含敏感字段与原始 DB 列名。
    expect(userText).not.toContain('password_hash');
    expect(userText).not.toContain('invite_code_hash');
    expect(userText).not.toContain('_json');
    expect(userText).not.toContain('known_by_json');
    // prompt.characters 是结构化 player ids（provider 不解析人类 prompt 字符串）。
    expect(pkg.prompt.characters.map((c) => c.playerId)).toEqual(
      expect.arrayContaining([aCtx.playerId as string, bCtx.playerId as string]),
    );
    // 创建式字段与 id/RNG 规则必须在 prompt 中显式描述。
    expect(userText).toContain('worldFactCreations');
    expect(userText).toContain('encounterStarts');
    expect(userText).toContain('rollInitiative');
    expect(userText).toContain('服务端生成');
    expect(userText).toContain('骰子');
    expect(promptText).toContain('diceResults 必须始终为 []');
    // 实际发给 Provider 的 messages 必须携带 JSON-only 指令与完整顶层模板。
    expect(promptText).toContain('只返回一个 JSON 对象');
    expect(promptText).toContain('不要输出解释、前后缀、Markdown');
    for (const key of [
      'publicNarrative', 'privateUpdates', 'diceResults', 'stateChanges',
      'interactionRequests', 'worldFactCreations', 'encounterStarts',
    ]) {
      expect(promptText).toContain(`"${key}"`);
    }
    expect(promptText).toContain('没有条目时使用空数组 []');
    await db.close();
  });

  it('filters GM-only and other actors private facts from an actor context with denial trace', async () => {
    const db = createSqliteDatabase(':memory:');
    await db.migrate();
    const identity = new IdentityService(db);
    const campaigns = new CampaignService(db);
    const characters = new CharacterService(db);
    const worldFacts = new WorldFactService(db);
    const owner = await identity.register({ login: 'actor-filter-owner@example.test', password: 'correct-password' });
    const a = await identity.register({ login: 'actor-filter-a@example.test', password: 'correct-password' });
    const b = await identity.register({ login: 'actor-filter-b@example.test', password: 'correct-password' });
    const created = await campaigns.create(owner.userId, { name: '秘密矿坑', ruleset: 'dnd5e' });
    await campaigns.join({ userId: a.userId }, created.campaign.id, created.inviteCode);
    await campaigns.join({ userId: b.userId }, created.campaign.id, created.inviteCode);
    const ownerCtx = await resolveCampaignContext(db, { userId: owner.userId }, created.campaign.id);
    const aCtx = await resolveCampaignContext(db, { userId: a.userId }, created.campaign.id);
    const bCtx = await resolveCampaignContext(db, { userId: b.userId }, created.campaign.id);
    const draft = await characters.createDraft(aCtx, { name: '调查员', sheet: { ac: 12 } });
    await characters.submitForReview(aCtx, draft.id);
    await characters.approve(ownerCtx, draft.id);
    await worldFacts.create(ownerCtx, {
      title: 'NPC 真相', kind: 'npc', content: 'NPC 是叛徒。', visibility: 'owner_only',
    });
    await worldFacts.create(ownerCtx, {
      title: 'A 的认知', kind: 'lore', content: '你相信 NPC。', visibility: 'player_private', knownBy: [aCtx.playerId as string],
    });
    await worldFacts.create(ownerCtx, {
      title: 'B 的认知', kind: 'lore', content: 'B 知道另一件事。', visibility: 'player_private', knownBy: [bCtx.playerId as string],
    });
    const turn = await new TurnService(db, new OutboxRepository(db)).startTurn(ownerCtx);
    const pkg = await new AiContextBuilder(db).buildForTurn(created.campaign.id, turn.id, db, {
      audience: 'actor_private', actorId: aCtx.playerId as string, actionId: 'actor-action-1',
    });
    const promptText = pkg.prompt.messages.map((message) => message.content).join('\\n');
    expect(promptText).toContain('你相信 NPC');
    expect(pkg.blocks.find((block) => block.content.includes('你相信 NPC'))?.audienceActorIds).toEqual([aCtx.playerId]);
    expect(promptText).not.toContain('NPC 是叛徒');
    expect(promptText).not.toContain('B 知道另一件事');
    expect(pkg.trace.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceRef: expect.stringMatching(/^world-fact:/), included: false, reason: 'visibility_denied' }),
    ]));
    const deniedSecret = pkg.trace.entries.find((entry) => entry.sourceRef.startsWith('world-fact:') && entry.included === false);
    expect(deniedSecret?.reason).toBe('visibility_denied');
    expect(pkg.trace.actionId).toBe('actor-action-1');
    await db.close();
  });

  it('includes an owner projection of active combat in the context', async () => {
    const db = createSqliteDatabase(':memory:');
    await db.migrate();
    const identity = new IdentityService(db);
    const campaigns = new CampaignService(db);
    const characters = new CharacterService(db);
    const owner = await identity.register({ login: 'ctx-combat-owner@example.test', password: 'correct-password' });
    const a = await identity.register({ login: 'ctx-combat-a@example.test', password: 'correct-password' });
    const created = await campaigns.create(owner.userId, { name: '战斗矿坑', ruleset: 'dnd5e' });
    await campaigns.join({ userId: a.userId }, created.campaign.id, created.inviteCode);
    const ownerCtx = await resolveCampaignContext(db, { userId: owner.userId }, created.campaign.id);
    const aCtx = await resolveCampaignContext(db, { userId: a.userId }, created.campaign.id);
    const draft = await characters.createDraft(aCtx, { name: '薇拉', sheet: { ac: 14 } });
    await characters.submitForReview(aCtx, draft.id);
    await characters.approve(ownerCtx, draft.id);
    const turns = new TurnService(db, new OutboxRepository(db));
    const turn = await turns.startTurn(ownerCtx);
    await turns.submitAction(aCtx, turn.id, { body: '我搜索房间。' });
    // 建一个 active 战斗（owner 视角全量战斗员）。
    const { CombatService } = await import('../combat/CombatService.js');
    const combat = new CombatService(db, new OutboxRepository(db), () => 0.5);
    const encounter = await combat.start(ownerCtx, {
      name: '地窖遭遇',
      combatants: [
        { name: '战士', characterId: null, initiativeBonus: 2, hpCurrent: 12, hpMax: 12, ac: 16, conditions: [], visibility: 'public', targetPlayerId: null },
        { name: '密探', characterId: null, initiativeBonus: 1, hpCurrent: 8, hpMax: 8, ac: 13, conditions: ['中毒'], visibility: 'player_private', targetPlayerId: aCtx.playerId as string },
        { name: '伏兵', characterId: null, initiativeBonus: 0, hpCurrent: 5, hpMax: 5, ac: 11, conditions: [], visibility: 'owner_only', targetPlayerId: null },
      ],
    });
    await combat.execute(ownerCtx, encounter.id, { kind: 'roll_initiative', payload: {} });

    const builder = new AiContextBuilder(db);
    const pkg = await builder.buildForTurn(created.campaign.id, turn.id, db);
    const context = pkg.context.combat as Array<Record<string, unknown>>;
    expect(context).toHaveLength(1);
    expect(context[0].name).toBe('地窖遭遇');
    expect(context[0].status).toBe('active');
    // owner 上下文包含全部 unsuperseded 战斗员（含 owner_only 与 player_private target）。
    const names = (context[0].combatants as Array<{ name: string }>).map((c) => c.name);
    expect(names).toEqual(['战士', '密探', '伏兵']);
    const userText = JSON.stringify(pkg.prompt.messages.map((m) => m.content).join('\n'));
    expect(userText).toContain('地窖遭遇');
    expect(userText).toContain('伏兵'); // owner prompt 包含隐藏战斗员
    await db.close();
  });
});
