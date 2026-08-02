import { describe, expect, it } from 'vitest';
import { nanoid } from 'nanoid';
import type { CampaignAuthContext } from '../campaigns/CampaignAccess.js';
import { resolveCampaignContext } from '../campaigns/CampaignAccess.js';
import { CampaignService } from '../campaigns/CampaignService.js';
import { CharacterService } from '../characters/CharacterService.js';
import { IdentityService } from '../identity/IdentityService.js';
import { createSqliteDatabase } from '../../platform/database/SqliteDatabaseAdapter.js';
import { OutboxRepository } from '../../platform/events/OutboxRepository.js';
import { TurnService } from '../turns/TurnService.js';
import { TurnRepository } from '../turns/TurnRepository.js';
import { WorldFactRepository } from '../world/WorldFactRepository.js';
import { ArchiveService } from './ArchiveService.js';

async function makeFixture() {
  const db = createSqliteDatabase(':memory:');
  await db.migrate();
  const identity = new IdentityService(db);
  const campaigns = new CampaignService(db);
  const characters = new CharacterService(db);
  const owner = await identity.register({ login: 'owner@example.test', password: 'correct-password' });
  const a = await identity.register({ login: 'a@example.test', password: 'correct-password' });
  const b = await identity.register({ login: 'b@example.test', password: 'correct-password' });
  const c = await identity.register({ login: 'c@example.test', password: 'correct-password' });
  const created = await campaigns.create(owner.userId, { name: '失落矿坑', ruleset: 'dnd5e' });
  for (const user of [a, b, c]) {
    await campaigns.join({ userId: user.userId }, created.campaign.id, created.inviteCode);
  }
  const ownerCtx = await resolveCampaignContext(db, { userId: owner.userId }, created.campaign.id);
  const aCtx = await resolveCampaignContext(db, { userId: a.userId }, created.campaign.id);
  const bCtx = await resolveCampaignContext(db, { userId: b.userId }, created.campaign.id);
  const cCtx = await resolveCampaignContext(db, { userId: c.userId }, created.campaign.id);
  const approve = async (ctx: CampaignAuthContext, name: string) => {
    const draft = await characters.createDraft(ctx, { name, sheet: { ac: 14 } });
    await characters.submitForReview(ctx, draft.id);
    await characters.approve(ownerCtx, draft.id);
  };
  await approve(aCtx, '薇拉');
  await approve(bCtx, '卡恩');
  const turns = new TurnService(db, new OutboxRepository(db));
  const archives = new ArchiveService(db, new OutboxRepository(db));
  return { db, characters, turns, archives, ownerCtx, aCtx, bCtx, cCtx };
}

describe('archives', () => {
  it('owner creates a manual archive with a trimmed label and atomic version', async () => {
    const { db, turns, archives, ownerCtx, aCtx, bCtx } = await makeFixture();
    const turn = await turns.startTurn(ownerCtx);
    await turns.submitAction(aCtx, turn.id, { body: 'A 行动' });
    await turns.submitAction(bCtx, turn.id, { body: 'B 行动' });
    const first = await archives.createManual(ownerCtx, '  进入矿洞前  ');
    expect(first.kind).toBe('manual');
    expect(first.label).toBe('进入矿洞前');
    expect(first.version).toBe(1);
    expect(first.turnId).toBe(turn.id);
    const second = await archives.createManual(ownerCtx, '再走一步');
    expect(second.version).toBe(2);
    await db.close();
  });

  it('rejects a manual archive while the current turn is resolving', async () => {
    const { db, turns, archives, ownerCtx } = await makeFixture();
    const turn = await turns.startTurn(ownerCtx);
    await db.execute("UPDATE platform_turns SET status = 'resolving' WHERE id = ?", [turn.id]);
    await expect(archives.createManual(ownerCtx, '结算中')).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    await db.close();
  });

  it('rejects a player creating, restoring or listing an archive', async () => {
    const { db, archives, aCtx } = await makeFixture();
    await expect(archives.createManual(aCtx, '越权')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(archives.restore(aCtx, 'any')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(archives.listForCampaign(aCtx)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await db.close();
  });

  it('round-trips all character statuses and audits restore + supersede changes', async () => {
    const { db, characters, archives, ownerCtx, aCtx, bCtx } = await makeFixture();
    // 为 A 建五个状态的角色；再为 B 建一个 approved（恢复前存在、快照外的角色，会被 supersede 为 archived）。
    const draft = await characters.createDraft(aCtx, { name: '草稿', sheet: { ac: 12 } });
    const pending = await characters.createDraft(aCtx, { name: '待审', sheet: { ac: 13 } });
    await characters.submitForReview(aCtx, pending.id);
    const approved = await characters.createDraft(aCtx, { name: '已批准', sheet: { ac: 14 } });
    await characters.submitForReview(aCtx, approved.id);
    await characters.approve(ownerCtx, approved.id);
    const rejected = await characters.createDraft(aCtx, { name: '已退回', sheet: { ac: 11 } });
    await characters.submitForReview(aCtx, rejected.id);
    await characters.reject(ownerCtx, rejected.id);
    const archived = await characters.createDraft(aCtx, { name: '已归档', sheet: { ac: 10 } });
    await characters.submitForReview(aCtx, archived.id);
    await characters.approve(ownerCtx, archived.id);
    await db.execute("UPDATE platform_characters SET status = 'archived' WHERE id = ?", [archived.id]);

    // 手动存档：快照含全部五个状态的角色。
    const manual = await archives.createManual(ownerCtx, '全状态');
    const snapshot = JSON.parse((await db.query<{ state_json: string }>('SELECT state_json FROM platform_archives WHERE id = ?', [manual.id]))[0].state_json) as { characters: Array<{ id: string; status: string }> };
    const byId = Object.fromEntries(snapshot.characters.map((c) => [c.id, c.status]));
    expect(byId[draft.id]).toBe('draft');
    expect(byId[pending.id]).toBe('pending_review');
    expect(byId[approved.id]).toBe('approved');
    expect(byId[rejected.id]).toBe('rejected');
    expect(byId[archived.id]).toBe('archived');

    // 恢复前制造快照外角色（B 的新 approved 角色），恢复时会被 supersede 为 archived。
    const bDraft = await characters.createDraft(bCtx, { name: 'B 新建', sheet: { ac: 15 } });
    await characters.submitForReview(bCtx, bDraft.id);
    await characters.approve(ownerCtx, bDraft.id);
    // 手动改一个快照内角色状态为 rejected（archived 之外的变化），验证恢复把状态还原为快照值。
    await db.execute("UPDATE platform_characters SET status = 'rejected' WHERE id = ?", [approved.id]);

    await archives.restore(ownerCtx, manual.id);

    const rows = await db.query<{ id: string; status: string; approved_at: string | null }>(
      'SELECT id, status, approved_at FROM platform_characters WHERE campaign_id = ?', [ownerCtx.campaignId],
    );
    const after = Object.fromEntries(rows.map((r) => [r.id, r.status]));
    expect(after[draft.id]).toBe('draft');
    expect(after[pending.id]).toBe('pending_review');
    expect(after[approved.id]).toBe('approved'); // 恢复把 rejected 还原为 approved
    expect(after[rejected.id]).toBe('rejected');
    expect(after[archived.id]).toBe('archived');
    expect(after[bDraft.id]).toBe('archived'); // 快照外角色被 archived，不物理删除
    // 恢复后已批准角色的 approved_at 与快照一致（round-trip 字段保留）。
    const approvedRow = rows.find((r) => r.id === approved.id);
    expect(approvedRow?.approved_at).toBeTruthy();

    // 审计：快照内角色 upsert 有 archive_restore；快照外角色有 archive_restore_supersede。
    const audits = await db.query<{ character_id: string; action: string; actor_user_id: string }>(
      'SELECT character_id, action, actor_user_id FROM platform_character_audits WHERE campaign_id = ? ORDER BY character_id, created_at', [ownerCtx.campaignId],
    );
    const restoreAudits = audits.filter((a) => a.action === 'archive_restore');
    expect(restoreAudits.map((a) => a.character_id)).toEqual(expect.arrayContaining([draft.id, pending.id, approved.id, rejected.id, archived.id]));
    // 快照内每个角色无论字段是否相同均恰一条 archive_restore audit（restore 是独立可审计动作），不按字段变化去重。
    for (const id of [draft.id, pending.id, approved.id, rejected.id, archived.id]) {
      expect(restoreAudits.filter((a) => a.character_id === id)).toHaveLength(1);
    }
    expect(restoreAudits.every((a) => a.actor_user_id === ownerCtx.userId)).toBe(true);
    expect(audits.some((a) => a.character_id === bDraft.id && a.action === 'archive_restore_supersede' && a.actor_user_id === ownerCtx.userId)).toBe(true);
    await db.close();
  });

  it('restores a completed automatic snapshot: supersedes later turns and creates the next turn with MAX+1 no reuse', async () => {
    const { db, characters, turns, archives, ownerCtx, aCtx, bCtx, cCtx } = await makeFixture();
    const t1 = await turns.startTurn(ownerCtx);
    await turns.submitAction(aCtx, t1.id, { body: 'A' });
    await turns.submitAction(bCtx, t1.id, { body: 'B' });
    // 快照中含一个 draft 角色（c 的唯一角色）：恢复后的下一回合 requirements 不得把 c 列为必需玩家。
    await characters.createDraft(cCtx, { name: '草稿', sheet: { ac: 9 } });
    // 完成 t1，并模拟 AiResolutionService 生成 automatic 存档（snapshot currentTurn = t1 completed）。
    await db.execute("UPDATE platform_turns SET status = 'completed', completed_at = ? WHERE id = ?", [new Date().toISOString(), t1.id]);
    const autoArchiveId = nanoid(24);
    const auto = await db.transaction((tx) => archives.createAutomatic(tx, t1.campaignId, t1.id, ownerCtx.userId, autoArchiveId));
    expect(auto.kind).toBe('automatic');
    expect(auto.label).toBeNull();
    expect(auto.version).toBe(1);
    // 后续历史：t2、t3 完成（超过快照 watermark number=1）。
    const t2 = await turns.startTurn(ownerCtx);
    await db.execute("UPDATE platform_turns SET status = 'completed', completed_at = ? WHERE id = ?", [new Date().toISOString(), t2.id]);
    const t3 = await turns.startTurn(ownerCtx);
    await db.execute("UPDATE platform_turns SET status = 'completed', completed_at = ? WHERE id = ?", [new Date().toISOString(), t3.id]);
    // 恢复 completed 自动存档：t2/t3 supersede，同 tx 创建新 waiting turn number=4（不复用）。
    const restored = await archives.restore(ownerCtx, auto.id);
    expect(restored.restoredTurnId).toBeTruthy();
    const rows = await db.query<{ id: string; number: number; status: string; superseded_at: string | null }>(
      'SELECT id, number, status, superseded_at FROM platform_turns WHERE campaign_id = ? ORDER BY number',
      [t1.campaignId],
    );
    expect(rows.map((r) => r.number)).toEqual([1, 2, 3, 4]);
    expect(rows[1].superseded_at).not.toBeNull(); // t2 被 supersede
    expect(rows[2].superseded_at).not.toBeNull(); // t3 被 supersede
    expect(rows[3].status).toBe('waiting_for_actions'); // 新回合
    // 新回合 requirements 直接断言：只包含快照中 approved 角色（distinct），draft/pending/rejected/archived 均不包含。
    const reqs = await db.query<{ player_id: string }>(
      'SELECT player_id FROM platform_turn_requirements WHERE turn_id = ? ORDER BY player_id', [restored.restoredTurnId as string],
    );
    expect(reqs.map((r) => r.player_id).sort())
      .toEqual([aCtx.playerId as string, bCtx.playerId as string].sort());
    expect(reqs.map((r) => r.player_id)).not.toContain(cCtx.playerId); // 只有 draft 的 c 不是必需玩家
    await db.close();
  });

  it('restores a waiting snapshot without auto-creating a new turn', async () => {
    const { db, turns, archives, ownerCtx, aCtx, bCtx } = await makeFixture();
    const t1 = await turns.startTurn(ownerCtx);
    await turns.submitAction(aCtx, t1.id, { body: 'A' });
    await turns.submitAction(bCtx, t1.id, { body: 'B' });
    const manual = await archives.createManual(ownerCtx, '锁定时'); // snapshot currentTurn = t1 locked
    await db.execute("UPDATE platform_turns SET status = 'completed', completed_at = ? WHERE id = ?", [new Date().toISOString(), t1.id]);
    const restored = await archives.restore(ownerCtx, manual.id);
    const turn = await db.query<{ status: string; superseded_at: string | null }>(
      'SELECT status, superseded_at FROM platform_turns WHERE id = ?', [t1.id],
    );
    expect(turn[0].status).toBe('locked'); // 恢复到锁定状态，不开新回合
    expect(turn[0].superseded_at).toBeNull();
    expect(restored.restoredTurnId).toBe(t1.id);
    await db.close();
  });

  it('restores a setup snapshot (turnNumber=0) and supersedes all later turns', async () => {
    const { db, turns, archives, ownerCtx } = await makeFixture();
    // 存档前无任何回合：setup 快照 currentTurn=null、turnNumber=0。
    const setup = await archives.createManual(ownerCtx, 'setup');
    const setupSnapshot = JSON.parse((await db.query<{ state_json: string }>('SELECT state_json FROM platform_archives WHERE id = ?', [setup.id]))[0].state_json);
    expect(setupSnapshot.currentTurn).toBeNull();
    expect(setupSnapshot.watermarks.turnNumber).toBe(0);
    // 后续历史：t1、t2 完成。
    const t1 = await turns.startTurn(ownerCtx);
    await db.execute("UPDATE platform_turns SET status = 'completed', completed_at = ? WHERE id = ?", [new Date().toISOString(), t1.id]);
    const t2 = await turns.startTurn(ownerCtx);
    await db.execute("UPDATE platform_turns SET status = 'completed', completed_at = ? WHERE id = ?", [new Date().toISOString(), t2.id]);
    const restored = await archives.restore(ownerCtx, setup.id);
    expect(restored.restoredTurnId).toBeNull(); // setup 快照无 currentTurn，不开新回合
    const rows = await db.query<{ number: number; superseded_at: string | null }>(
      'SELECT number, superseded_at FROM platform_turns WHERE campaign_id = ? ORDER BY number', [t1.campaignId],
    );
    expect(rows.map((r) => r.number)).toEqual([1, 2]);
    expect(rows[0].superseded_at).not.toBeNull(); // t1 被 supersede（number=1 > 0）
    expect(rows[1].superseded_at).not.toBeNull(); // t2 被 supersede
    await db.close();
  });

  it('restores an idle-after-completed snapshot: keeps turns <= turnNumber, supersedes > turnNumber, consistent with outbox watermark', async () => {
    const { db, turns, archives, ownerCtx } = await makeFixture();
    // 完成后（无进行中回合）创建 manual 存档：currentTurn=null、turnNumber=1。
    const t1 = await turns.startTurn(ownerCtx);
    await db.execute("UPDATE platform_turns SET status = 'completed', completed_at = ? WHERE id = ?", [new Date().toISOString(), t1.id]);
    const idle = await archives.createManual(ownerCtx, '完成后');
    const idleSnapshot = JSON.parse((await db.query<{ state_json: string }>('SELECT state_json FROM platform_archives WHERE id = ?', [idle.id]))[0].state_json);
    expect(idleSnapshot.currentTurn).toBeNull();
    expect(idleSnapshot.watermarks.turnNumber).toBe(1);
    // 后续历史：t2、t3 完成（number > turnNumber 水位）。
    const t2 = await turns.startTurn(ownerCtx);
    await db.execute("UPDATE platform_turns SET status = 'completed', completed_at = ? WHERE id = ?", [new Date().toISOString(), t2.id]);
    const t3 = await turns.startTurn(ownerCtx);
    await db.execute("UPDATE platform_turns SET status = 'completed', completed_at = ? WHERE id = ?", [new Date().toISOString(), t3.id]);
    await archives.restore(ownerCtx, idle.id);
    const rows = await db.query<{ number: number; superseded_at: string | null }>(
      'SELECT number, superseded_at FROM platform_turns WHERE campaign_id = ? ORDER BY number', [t1.campaignId],
    );
    // <=1（t1）保留、>1（t2/t3）supersede；快照无 currentTurn，不开新回合。
    expect(rows).toHaveLength(3);
    expect(rows[0].superseded_at).toBeNull();
    expect(rows[1].superseded_at).not.toBeNull();
    expect(rows[2].superseded_at).not.toBeNull();
    // 与 outbox watermark 一致：archive.restored 事件 sequence 大于快照 outbox watermark（不被本次 supersede）。
    const events = await db.query<{ event_type: string; sequence: number; superseded_at: string | null }>(
      'SELECT event_type, sequence, superseded_at FROM platform_outbox_events WHERE campaign_id = ? ORDER BY sequence', [t1.campaignId],
    );
    const restoredEvent = events.find((e) => e.event_type === 'archive.restored');
    expect(restoredEvent).toBeTruthy();
    expect(restoredEvent!.superseded_at).toBeNull();
    expect(restoredEvent!.sequence).toBeGreaterThan(idleSnapshot.watermarks.outboxSequence);
    await db.close();
  });

  it('rejects restore while an unsuperseded resolving turn exists', async () => {
    const { db, turns, archives, ownerCtx } = await makeFixture();
    const turn = await turns.startTurn(ownerCtx);
    const manual = await archives.createManual(ownerCtx, 'pre'); // snapshot currentTurn = t1 waiting
    await db.execute("UPDATE platform_turns SET status = 'resolving' WHERE id = ?", [turn.id]);
    await expect(archives.restore(ownerCtx, manual.id)).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    await db.close();
  });

  it('rejects restore while a running AI run exists but the turn is not resolving (second guard)', async () => {
    // 第二道 guard 独立覆盖：turn 非 resolving（人工改回 waiting），但 platform_ai_runs 仍有一条
    // running run（如 provider 挂起、run 未终结）。若没有第二道 guard，restore 会放行并污染恢复状态。
    const { db, turns, archives, ownerCtx } = await makeFixture();
    const turn = await turns.startTurn(ownerCtx);
    const manual = await archives.createManual(ownerCtx, 'pre');
    // 手动构造异常窗口：turn 不是 resolving，但存在一条 unsuperseded running run。
    await db.execute("UPDATE platform_turns SET status = 'waiting_for_actions' WHERE id = ?", [turn.id]);
    await db.execute(
      `INSERT INTO platform_ai_runs
        (id, campaign_id, campaign_sequence, turn_id, attempt, idempotency_key, provider, model, status,
         context_json, result_json, error_code, error_json, raw_debug_json, started_at, completed_at, superseded_at, superseded_by_archive_id)
       VALUES (?, ?, 1, ?, 1, 'run-guard', 'scripted', 'scripted', 'running', '{}', NULL, NULL, NULL, NULL, ?, NULL, NULL, NULL)`,
      ['guard-run-1', turn.campaignId, turn.id, new Date().toISOString()],
    );
    await expect(archives.restore(ownerCtx, manual.id)).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    await db.close();
  });

  it('normalizes malformed snapshot JSON into a controlled INTERNAL_ERROR and rolls back', async () => {
    const { db, turns, archives, ownerCtx, aCtx, bCtx } = await makeFixture();
    const t1 = await turns.startTurn(ownerCtx);
    await turns.submitAction(aCtx, t1.id, { body: 'A' });
    await turns.submitAction(bCtx, t1.id, { body: 'B' });
    const manual = await archives.createManual(ownerCtx, 'rollback');
    // 存档后产生一个 later turn：restore 若进行会 supersede 它；malformed JSON 必须先于任何写入失败。
    await db.execute("UPDATE platform_turns SET status = 'completed', completed_at = ? WHERE id = ?", [new Date().toISOString(), t1.id]);
    const t2 = await turns.startTurn(ownerCtx);
    // 人为破坏存档 state_json → 精确断言受控错误（不泄漏 SyntaxError）且整体回滚。
    await db.execute('UPDATE platform_archives SET state_json = ? WHERE id = ?', ['{bad json', manual.id]);
    await expect(archives.restore(ownerCtx, manual.id)).rejects.toMatchObject({ code: 'INTERNAL_ERROR', message: '存档快照无效。' });
    const active = await db.query<{ id: string }>(
      'SELECT id FROM platform_turns WHERE campaign_id = ? AND superseded_at IS NULL', [t1.campaignId],
    );
    expect(active.map((r) => r.id)).toEqual([t1.id, t2.id]); // 没有任何回合被 supersede
    const events = await db.query<{ event_type: string }>('SELECT event_type FROM platform_outbox_events WHERE campaign_id = ?', [t1.campaignId]);
    expect(events.filter((e) => e.event_type === 'archive.restored')).toHaveLength(0); // 未发布 restore 事件
    await db.close();
  });

  it('rejects a snapshot that fails schema validation with a controlled INTERNAL_ERROR', async () => {
    const { db, turns, archives, ownerCtx, aCtx, bCtx } = await makeFixture();
    const t1 = await turns.startTurn(ownerCtx);
    await turns.submitAction(aCtx, t1.id, { body: 'A' });
    await turns.submitAction(bCtx, t1.id, { body: 'B' });
    const manual = await archives.createManual(ownerCtx, 'bad-schema');
    // 合法 JSON 但不符合 archiveSnapshotSchema（缺 watermarks）：同样归一为 INTERNAL_ERROR 并回滚。
    await db.execute('UPDATE platform_archives SET state_json = ? WHERE id = ?', ['{"not":"a snapshot"}', manual.id]);
    await expect(archives.restore(ownerCtx, manual.id)).rejects.toMatchObject({ code: 'INTERNAL_ERROR', message: '存档快照无效。' });
    const turnRow = await db.query<{ status: string; superseded_at: string | null }>('SELECT status, superseded_at FROM platform_turns WHERE id = ?', [t1.id]);
    expect(turnRow[0].status).toBe('locked'); // 回合状态未被改变
    expect(turnRow[0].superseded_at).toBeNull();
    await db.close();
  });

  it('rejects restoring a snapshot whose own turn is resolving even when live DB is clean', async () => {
    const { db, turns, archives, ownerCtx, aCtx, bCtx } = await makeFixture();
    const t1 = await turns.startTurn(ownerCtx);
    await turns.submitAction(aCtx, t1.id, { body: 'A' });
    await turns.submitAction(bCtx, t1.id, { body: 'B' });
    const manual = await archives.createManual(ownerCtx, 'resolving-snap'); // snapshot currentTurn = t1 locked
    // 人为把快照 currentTurn.turn.status 改为 resolving：live DB 无 resolving turn、无 running run，
    // 只能命中「快照自身 resolving」守卫（live 守卫测不出这种异常快照）。
    const state = JSON.parse((await db.query<{ state_json: string }>('SELECT state_json FROM platform_archives WHERE id = ?', [manual.id]))[0].state_json) as { currentTurn: { turn: { status: string } } };
    state.currentTurn.turn.status = 'resolving';
    await db.execute('UPDATE platform_archives SET state_json = ? WHERE id = ?', [JSON.stringify(state), manual.id]);
    await expect(archives.restore(ownerCtx, manual.id)).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    // 拒绝后：任何 superseded / archive.restored / 角色归档都没有发生。
    const turnsRows = await db.query<{ superseded_at: string | null }>('SELECT superseded_at FROM platform_turns WHERE campaign_id = ?', [ownerCtx.campaignId]);
    for (const row of turnsRows) expect(row.superseded_at).toBeNull();
    const events = await db.query<{ event_type: string }>('SELECT event_type FROM platform_outbox_events WHERE campaign_id = ?', [ownerCtx.campaignId]);
    expect(events.filter((e) => e.event_type === 'archive.restored')).toHaveLength(0);
    const charRows = await db.query<{ status: string }>('SELECT status FROM platform_characters WHERE campaign_id = ?', [ownerCtx.campaignId]);
    expect(charRows.every((r) => r.status !== 'archived')).toBe(true); // 快照外角色也不会被归档
    await db.close();
  });

  it('returns the replacement turn id and remaps children when the snapshot turn id no longer exists', async () => {
    const { db, turns, archives, ownerCtx, aCtx, bCtx } = await makeFixture();
    const t1 = await turns.startTurn(ownerCtx);
    await turns.submitAction(aCtx, t1.id, { body: 'A 原行动' });
    await turns.submitAction(bCtx, t1.id, { body: 'B 原行动' });
    const manual = await archives.createManual(ownerCtx, 'replacement'); // snapshot currentTurn = t1 locked, number=1
    const now = new Date().toISOString();
    // 快照 turn 被物理删除（历史清理/回填），同 number 换新 id 占位：先按 FK 安全顺序删 t1 的子行与引用。
    await db.execute('DELETE FROM platform_actions WHERE turn_id = ?', [t1.id]);
    await db.execute('DELETE FROM platform_turn_requirements WHERE turn_id = ?', [t1.id]);
    await db.execute('UPDATE platform_archives SET turn_id = NULL WHERE turn_id = ?', [t1.id]);
    await db.execute('DELETE FROM platform_turns WHERE id = ?', [t1.id]);
    const replacementId = nanoid(24);
    await db.execute(
      "INSERT INTO platform_turns (id, campaign_id, number, status, locked_at, completed_at, created_at, updated_at) VALUES (?, ?, 1, 'waiting_for_actions', NULL, NULL, ?, ?)",
      [replacementId, ownerCtx.campaignId, now, now],
    );
    await db.execute(
      'INSERT INTO platform_turn_requirements (turn_id, campaign_id, player_id, submitted) VALUES (?, ?, ?, 0)',
      [replacementId, ownerCtx.campaignId, aCtx.playerId as string],
    );
    const restored = await archives.restore(ownerCtx, manual.id);
    // restoredTurnId 必须返回实际落库的 existing.id（replacementId），而非已删除的快照 turn id。
    expect(restored.restoredTurnId).toBe(replacementId);
    // actions/requirements 全部 remap 到 replacementId。
    const actions = await db.query<{ body: string }>('SELECT body FROM platform_actions WHERE turn_id = ? ORDER BY body', [replacementId]);
    expect(actions.map((a) => a.body)).toEqual(['A 原行动', 'B 原行动']);
    const reqs = await db.query<{ player_id: string }>('SELECT player_id FROM platform_turn_requirements WHERE turn_id = ? ORDER BY player_id', [replacementId]);
    expect(reqs.map((r) => r.player_id).sort()).toEqual([aCtx.playerId as string, bCtx.playerId as string].sort());
    const turnRow = await db.query<{ status: string; superseded_at: string | null }>('SELECT status, superseded_at FROM platform_turns WHERE id = ?', [replacementId]);
    expect(turnRow[0].status).toBe('locked'); // 快照 locked 状态恢复到 replacement 行
    expect(turnRow[0].superseded_at).toBeNull();
    await db.close();
  });

  it('publishes an archive.restored event after superseding (not superseded itself)', async () => {
    const { db, turns, archives, ownerCtx, aCtx, bCtx } = await makeFixture();
    const t1 = await turns.startTurn(ownerCtx);
    await turns.submitAction(aCtx, t1.id, { body: 'A' });
    await turns.submitAction(bCtx, t1.id, { body: 'B' });
    const manual = await archives.createManual(ownerCtx, 'pre');
    await db.execute("UPDATE platform_turns SET status = 'completed', completed_at = ? WHERE id = ?", [new Date().toISOString(), t1.id]);
    await archives.restore(ownerCtx, manual.id);
    const events = await db.query<{ event_type: string; payload_json: string; superseded_at: string | null; sequence: number }>(
      'SELECT event_type, payload_json, superseded_at, sequence FROM platform_outbox_events WHERE campaign_id = ? ORDER BY sequence', [t1.campaignId],
    );
    const restored = events.find((e) => e.event_type === 'archive.restored');
    expect(restored).toBeTruthy();
    expect(JSON.parse(restored!.payload_json)).toMatchObject({ type: 'archive.restored', campaignId: t1.campaignId, archiveId: manual.id });
    expect(restored!.superseded_at).toBeNull(); // 本次 restored 事件不能被本次 supersede
    // snapshot 的 outbox watermark 只覆盖 restore 前已存在的事件；restored 事件在 supersede 后发布，
    // sequence 必须大于 watermark，证明它未被本次恢复 supersede。
    const snapshotWatermark = JSON.parse((await db.query<{ state_json: string }>('SELECT state_json FROM platform_archives WHERE id = ?', [manual.id]))[0].state_json).watermarks.outboxSequence as number;
    expect(restored!.sequence).toBeGreaterThan(snapshotWatermark);
    await db.close();
  });

  it('keeps the version counter monotonic across restores', async () => {
    const { db, turns, archives, ownerCtx, aCtx, bCtx } = await makeFixture();
    const t1 = await turns.startTurn(ownerCtx);
    await turns.submitAction(aCtx, t1.id, { body: 'A' });
    await turns.submitAction(bCtx, t1.id, { body: 'B' });
    const manual = await archives.createManual(ownerCtx, 'v1');
    expect(manual.version).toBe(1);
    await db.execute("UPDATE platform_turns SET status = 'completed', completed_at = ? WHERE id = ?", [new Date().toISOString(), t1.id]);
    await archives.restore(ownerCtx, manual.id);
    const after = await archives.createManual(ownerCtx, 'v2');
    expect(after.version).toBe(2); // 恢复后 version counter 不回退
    await db.close();
  });

  it('assigns distinct versions under concurrent creates', async () => {
    const { db, archives, ownerCtx } = await makeFixture();
    const results = await Promise.allSettled([
      archives.createManual(ownerCtx, '并发A'),
      archives.createManual(ownerCtx, '并发B'),
    ]);
    const versions: number[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled') {
        versions.push(r.value.version);
      }
    }
    expect(versions).toEqual(expect.arrayContaining([1, 2]));
    await expect(archives.createManual(ownerCtx, 'again')).resolves.toMatchObject({ version: 3 });
    await db.close();
  });

  it('keeps active findById/update/delete/lock paths away from superseded rows', async () => {
    const { db, turns, archives, ownerCtx, aCtx, bCtx } = await makeFixture();
    const t1 = await turns.startTurn(ownerCtx);
    await turns.submitAction(aCtx, t1.id, { body: 'A' });
    await turns.submitAction(bCtx, t1.id, { body: 'B' });
    const manual = await archives.createManual(ownerCtx, 'guard');
    // t2 是快照外的 later turn：恢复 setup/idle 风格会把它 supersede。
    await db.execute("UPDATE platform_turns SET status = 'completed', completed_at = ? WHERE id = ?", [new Date().toISOString(), t1.id]);
    const t2 = await turns.startTurn(ownerCtx);
    // 世界事实：快照外的 active fact 会在恢复时被 supersede。
    const facts = new WorldFactRepository(db);
    await facts.insert({
      id: 'fact-after', campaign_id: ownerCtx.campaignId, title: '战后传闻', kind: 'lore', content: 'x',
      visibility: 'public', known_by_json: '[]', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    // 恢复 manual（snapshot currentTurn=t1 locked，turnNumber=1）：t2 与快照外事实被 supersede。
    await archives.restore(ownerCtx, manual.id);
    const turnRepo = new TurnRepository(db);
    expect(await turnRepo.findTurnById(t2.id)).toBeNull(); // findById 不返回 superseded 行
    expect(await turnRepo.lockTurnRow(t2.id, ownerCtx.campaignId)).toBe(false);
    expect(await facts.findById('fact-after')).toBeNull();
    expect(await facts.updateContent('fact-after', ownerCtx.campaignId, {
      title: '改', kind: 'lore', content: 'y', visibility: 'public', known_by_json: '[]', updated_at: new Date().toISOString(),
    })).toBe(false);
    expect(await facts.delete('fact-after', ownerCtx.campaignId)).toBe(false);
    // 快照内角色仍然可查（字符没有 superseded 语义，只有 status）。
    await db.close();
  });

  it('rolls back the archive version counter when a capture fails after allocation', async () => {
    const { db, archives, ownerCtx } = await makeFixture();
    const charRow = (await db.query<{ id: string }>('SELECT id FROM platform_characters WHERE campaign_id = ? LIMIT 1', [ownerCtx.campaignId]))[0];
    // 破坏 sheet_json 使 captureSnapshot 在 nextVersion 之后抛错 → 整个 tx 回滚（含 version counter）。
    await db.execute("UPDATE platform_characters SET sheet_json = ? WHERE id = ?", ['{bad json', charRow.id]);
    await expect(archives.createManual(ownerCtx, '失败')).rejects.toBeTruthy();
    // 修复 sheet 后下一次分配仍为 1（counter 与存档同 tx 回滚，绝不从 2 续号）。
    await db.execute("UPDATE platform_characters SET sheet_json = ? WHERE id = ?", ['{"ac":14}', charRow.id]);
    const ok = await archives.createManual(ownerCtx, '成功');
    expect(ok.version).toBe(1);
    await db.close();
  });

  it('restores supersede ai runs and their entries above the snapshot ai-run watermark', async () => {
    const { db, turns, archives, ownerCtx, aCtx, bCtx } = await makeFixture();
    const t1 = await turns.startTurn(ownerCtx);
    await turns.submitAction(aCtx, t1.id, { body: 'A' });
    await turns.submitAction(bCtx, t1.id, { body: 'B' });
    // 快照时无任何 AI run：aiRunCampaignSequence=0。
    const manual = await archives.createManual(ownerCtx, 'ai-watermark');
    const now = new Date().toISOString();
    // 存档后产生一条 succeeded run（seq=1 > watermark=0）与它的 entry；restore 不得被 running 守卫挡住。
    await db.execute(
      `INSERT INTO platform_ai_runs
        (id, campaign_id, campaign_sequence, turn_id, attempt, idempotency_key, provider, model, status,
         context_json, result_json, error_code, error_json, raw_debug_json, started_at, completed_at, superseded_at, superseded_by_archive_id)
       VALUES (?, ?, 1, ?, 1, 'wm-run', 'scripted', 'scripted', 'succeeded', '{}', '{}', NULL, NULL, NULL, ?, ?, NULL, NULL)`,
      ['wm-run-1', ownerCtx.campaignId, t1.id, now, now],
    );
    await db.execute(
      `INSERT INTO platform_turn_entries (id, ai_run_id, campaign_id, turn_id, entry_kind, entry_index, visibility, target_player_id, payload_json, created_at)
       VALUES (?, ?, ?, ?, 'narrative', 0, 'public', NULL, '{"text":"x"}', ?)`,
      ['wm-entry-1', 'wm-run-1', ownerCtx.campaignId, t1.id, now],
    );
    await archives.restore(ownerCtx, manual.id);
    const run = await db.query<{ superseded_at: string | null; superseded_by_archive_id: string | null }>(
      'SELECT superseded_at, superseded_by_archive_id FROM platform_ai_runs WHERE id = ?', ['wm-run-1'],
    );
    expect(run[0].superseded_at).not.toBeNull(); // 超 AI watermark 的 run 被 supersede
    expect(run[0].superseded_by_archive_id).toBe(manual.id);
    const entries = await db.query<{ count: number }>(
      'SELECT COUNT(*) AS count FROM platform_turn_entries WHERE id = ? AND superseded_at IS NULL', ['wm-entry-1'],
    );
    expect(Number(entries[0].count)).toBe(0); // run 的 entries 同 tx supersede
    await db.close();
  });

  it('supersedes later archives when an earlier version is restored', async () => {
    const { db, archives, ownerCtx } = await makeFixture();
    const v1 = await archives.createManual(ownerCtx, 'v1');
    const v2 = await archives.createManual(ownerCtx, 'v2');
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    await archives.restore(ownerCtx, v1.id);
    const rows = await db.query<{ version: number; superseded_at: string | null }>(
      'SELECT version, superseded_at FROM platform_archives WHERE campaign_id = ? ORDER BY version', [ownerCtx.campaignId],
    );
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
    expect(rows[0].superseded_at).toBeNull(); // 被恢复的 v1 保持 active
    expect(rows[1].superseded_at).not.toBeNull(); // v2 被 supersede（不物理删除，version counter 不回退）
    const list = await archives.listForCampaign(ownerCtx);
    expect(list.map((a) => a.version)).toEqual([1]);
    await db.close();
  });

  it('restores world facts exactly and supersedes facts created after the snapshot', async () => {
    const { db, archives, ownerCtx } = await makeFixture();
    const facts = new WorldFactRepository(db);
    const now = new Date().toISOString();
    await facts.insert({
      id: 'fact-1', campaign_id: ownerCtx.campaignId, title: '酒馆', kind: 'location',
      content: '热闹。', visibility: 'public', known_by_json: '[]', created_at: now, updated_at: now,
    });
    const manual = await archives.createManual(ownerCtx, 'facts');
    // 存档后篡改快照内事实，并新增一个快照外事实。
    await db.execute("UPDATE platform_world_facts SET content = '冷清。', updated_at = ? WHERE id = ?", [now, 'fact-1']);
    await facts.insert({
      id: 'fact-2', campaign_id: ownerCtx.campaignId, title: '新传闻', kind: 'lore',
      content: 'x', visibility: 'public', known_by_json: '[]', created_at: now, updated_at: now,
    });
    await archives.restore(ownerCtx, manual.id);
    const f1 = await db.query<{ content: string; superseded_at: string | null }>(
      'SELECT content, superseded_at FROM platform_world_facts WHERE id = ?', ['fact-1'],
    );
    expect(f1[0].content).toBe('热闹。'); // 恢复为快照值
    expect(f1[0].superseded_at).toBeNull();
    const f2 = await db.query<{ superseded_at: string | null }>(
      'SELECT superseded_at FROM platform_world_facts WHERE id = ?', ['fact-2'],
    );
    expect(f2[0].superseded_at).not.toBeNull(); // 快照外事实被 supersede
    await db.close();
  });

  it('restores turn actions and requirements exactly', async () => {
    const { db, turns, archives, ownerCtx, aCtx, bCtx } = await makeFixture();
    const t1 = await turns.startTurn(ownerCtx);
    await turns.submitAction(aCtx, t1.id, { body: 'A 原行动' });
    await turns.submitAction(bCtx, t1.id, { body: 'B 原行动' });
    const manual = await archives.createManual(ownerCtx, 'actions'); // snapshot currentTurn = t1 locked
    const now = new Date().toISOString();
    // 存档后篡改行动正文并删除 B 的 requirement，再把回合置 completed。
    await db.execute('UPDATE platform_actions SET body = ? WHERE turn_id = ? AND player_id = ?', ['A 改后', t1.id, aCtx.playerId]);
    await db.execute('DELETE FROM platform_turn_requirements WHERE turn_id = ? AND player_id = ?', [t1.id, bCtx.playerId]);
    await db.execute("UPDATE platform_turns SET status = 'completed', completed_at = ? WHERE id = ?", [now, t1.id]);
    await archives.restore(ownerCtx, manual.id);
    const actions = await db.query<{ body: string }>('SELECT body FROM platform_actions WHERE turn_id = ? ORDER BY body', [t1.id]);
    expect(actions.map((a) => a.body)).toEqual(['A 原行动', 'B 原行动']); // 恢复为快照行动
    const reqs = await db.query<{ player_id: string }>('SELECT player_id FROM platform_turn_requirements WHERE turn_id = ? ORDER BY player_id', [t1.id]);
    expect(reqs.map((r) => r.player_id).sort()).toEqual([aCtx.playerId as string, bCtx.playerId as string].sort()); // B 的 requirement 恢复
    const turnRow = await db.query<{ status: string; superseded_at: string | null }>('SELECT status, superseded_at FROM platform_turns WHERE id = ?', [t1.id]);
    expect(turnRow[0].status).toBe('locked'); // 恢复到锁定状态，不开新回合
    expect(turnRow[0].superseded_at).toBeNull();
    await db.close();
  });

  it('never leaks state_json or _json fields and keeps non-owners out', async () => {
    const { db, turns, archives, ownerCtx, aCtx, bCtx } = await makeFixture();
    const turn = await turns.startTurn(ownerCtx);
    await turns.submitAction(aCtx, turn.id, { body: 'A 行动' });
    await turns.submitAction(bCtx, turn.id, { body: 'B 行动' });
    const manual = await archives.createManual(ownerCtx, 'DTO');
    // DTO 永不携带 state_json / 任何 *_json 内部字段（mapArchive 只输出契约形字段）。
    expect(JSON.stringify(manual)).not.toContain('state_json');
    expect(JSON.stringify(manual)).not.toContain('stateJson');
    expect(JSON.stringify(manual)).not.toContain('_json');
    const list = await archives.listForCampaign(ownerCtx);
    expect(JSON.stringify(list)).not.toContain('state_json');
    expect(JSON.stringify(list)).not.toContain('_json');
    // 非 owner 完全不可达 archive DTO：service 层直接 FORBIDDEN，错误体不含任何 state_json。
    await expect(archives.listForCampaign(aCtx)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(archives.restore(aCtx, manual.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(archives.createManual(aCtx, '越权')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await db.close();
  });
});
