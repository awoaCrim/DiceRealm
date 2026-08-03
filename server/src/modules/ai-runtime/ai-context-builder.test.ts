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
    const userText = JSON.stringify(pkg.prompt.messages.map((m) => m.content).join('\n'));
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
    await db.close();
  });
});
