import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { PostgresDatabaseAdapter } from './PostgresDatabaseAdapter.js';
import { CampaignService } from '../../modules/campaigns/CampaignService.js';
import { CharacterService } from '../../modules/characters/CharacterService.js';
import { IdentityService } from '../../modules/identity/IdentityService.js';
import { resolveCampaignContext } from '../../modules/campaigns/CampaignAccess.js';
import { TurnService } from '../../modules/turns/TurnService.js';
import { OutboxRepository } from '../events/OutboxRepository.js';
import { ArchiveService } from '../../modules/archives/ArchiveService.js';

const url = process.env.POSTGRES_TEST_URL;

describe.skipIf(!url)('postgres archives + ai runtime', () => {
  it('allocates archive versions and restores a completed snapshot (no number reuse)', async () => {
    const db = new PostgresDatabaseAdapter(new pg.Pool({ connectionString: url, max: 1 }));
    // 共享 PG 测试库：捕获本次 fixture 的 id，finally 中按 FK 安全顺序清理，避免残留。
    let campaignId = '';
    const userIds: string[] = [];
    try {
      await db.migrate();
      const identity = new IdentityService(db);
      const campaigns = new CampaignService(db);
      const characters = new CharacterService(db);
      // 共享 Postgres 测试库：每次运行用 randomUUID 唯一 login，避免重复运行撞 UNIQUE(login) 与残留。
      const suffix = randomUUID();
      const owner = await identity.register({ login: `owner-${suffix}@example.test`, password: 'correct-password' });
      const a = await identity.register({ login: `a-${suffix}@example.test`, password: 'correct-password' });
      const b = await identity.register({ login: `b-${suffix}@example.test`, password: 'correct-password' });
      userIds.push(owner.userId, a.userId, b.userId);
      const created = await campaigns.create(owner.userId, { name: '矿坑', ruleset: 'dnd5e' });
      campaignId = created.campaign.id;
      await campaigns.join({ userId: a.userId }, created.campaign.id, created.inviteCode);
      await campaigns.join({ userId: b.userId }, created.campaign.id, created.inviteCode);
      const ownerCtx = await resolveCampaignContext(db, { userId: owner.userId }, created.campaign.id);
      const aCtx = await resolveCampaignContext(db, { userId: a.userId }, created.campaign.id);
      const bCtx = await resolveCampaignContext(db, { userId: b.userId }, created.campaign.id);
      for (const ctx of [aCtx, bCtx]) {
        const draft = await characters.createDraft(ctx, { name: '角色', sheet: { ac: 12 } });
        await characters.submitForReview(ctx, draft.id);
        await characters.approve(ownerCtx, draft.id);
      }
      const turns = new TurnService(db, new OutboxRepository(db));
      const archives = new ArchiveService(db, new OutboxRepository(db));
      const t1 = await turns.startTurn(ownerCtx);
      await turns.submitAction(aCtx, t1.id, { body: 'A' });
      await turns.submitAction(bCtx, t1.id, { body: 'B' });
      // 完成 t1 并创建 automatic 存档（snapshot currentTurn = t1 completed）。actorUserId 用真实 owner。
      await db.execute("UPDATE platform_turns SET status = 'completed', completed_at = ? WHERE id = ?", [new Date().toISOString(), t1.id]);
      const autoArchiveId = randomUUID();
      const auto = await db.transaction((tx) => archives.createAutomatic(tx, t1.campaignId, t1.id, ownerCtx.userId, autoArchiveId));
      expect(auto.kind).toBe('automatic');
      expect(auto.version).toBe(1);
      // 后续历史：t2 completed（超过快照 number=1 水位）。
      const t2 = await turns.startTurn(ownerCtx);
      await db.execute("UPDATE platform_turns SET status = 'completed', completed_at = ? WHERE id = ?", [new Date().toISOString(), t2.id]);
      // 恢复 completed 自动存档：t2 supersede；同 tx 创建新 waiting turn number=3（MAX+1 含 superseded，不复用 2）。
      const restored = await archives.restore(ownerCtx, auto.id);
      expect(restored.archive.id).toBe(auto.id);
      const rows = await db.query<{ number: number; status: string; superseded_at: string | null }>(
        'SELECT number, status, superseded_at FROM platform_turns WHERE campaign_id = ? ORDER BY number', [t1.campaignId],
      );
      expect(rows.map((r) => r.number)).toEqual([1, 2, 3]);
      expect(rows[1].superseded_at).not.toBeNull(); // t2 被 supersede
      expect(rows[2].status).toBe('waiting_for_actions'); // 恢复自动开的新回合，number=3 不复用
    } finally {
      // FK 安全顺序清理本 campaign 及其用户（best-effort：单条失败不影响其余清理与连接关闭）。
      if (campaignId) {
        const cleanup: Array<[string, string[]]> = [
          ['DELETE FROM platform_turn_entries WHERE campaign_id = ?', [campaignId]],
          ['DELETE FROM platform_interaction_requests WHERE campaign_id = ?', [campaignId]],
          ['DELETE FROM platform_ai_runs WHERE campaign_id = ?', [campaignId]],
          ['DELETE FROM platform_ai_run_sequences WHERE campaign_id = ?', [campaignId]],
          ['DELETE FROM platform_turn_requirements WHERE campaign_id = ?', [campaignId]],
          ['DELETE FROM platform_actions WHERE campaign_id = ?', [campaignId]],
          ['DELETE FROM platform_character_audits WHERE campaign_id = ?', [campaignId]],
          ['DELETE FROM platform_turns WHERE campaign_id = ?', [campaignId]],
          ['DELETE FROM platform_characters WHERE campaign_id = ?', [campaignId]],
          ['DELETE FROM platform_world_facts WHERE campaign_id = ?', [campaignId]],
          ['DELETE FROM platform_outbox_events WHERE campaign_id = ?', [campaignId]],
          ['DELETE FROM platform_outbox_sequences WHERE campaign_id = ?', [campaignId]],
          ['DELETE FROM platform_archives WHERE campaign_id = ?', [campaignId]],
          ['DELETE FROM platform_archive_sequences WHERE campaign_id = ?', [campaignId]],
          ['DELETE FROM campaign_members WHERE campaign_id = ?', [campaignId]],
          ['DELETE FROM campaigns WHERE id = ?', [campaignId]],
        ];
        for (const [sql, params] of cleanup) {
          try {
            await db.execute(sql, params);
          } catch {
            // best-effort：单条清理失败不掩盖主断言结果，后续清理继续。
          }
        }
      }
      for (const userId of userIds) {
        for (const sql of ['DELETE FROM sessions WHERE user_id = ?', 'DELETE FROM users WHERE id = ?']) {
          try {
            await db.execute(sql, [userId]);
          } catch {
            // 同上。
          }
        }
      }
      await db.close();
    }
  });
});
