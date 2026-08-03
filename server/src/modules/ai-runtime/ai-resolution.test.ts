import { describe, expect, it, vi } from 'vitest';
import type { CampaignAuthContext } from '../campaigns/CampaignAccess.js';
import { resolveCampaignContext } from '../campaigns/CampaignAccess.js';
import { CampaignService } from '../campaigns/CampaignService.js';
import { CharacterService } from '../characters/CharacterService.js';
import { IdentityService } from '../identity/IdentityService.js';
import { createSqliteDatabase } from '../../platform/database/SqliteDatabaseAdapter.js';
import type { QueryExecutor } from '../../platform/database/DatabasePort.js';
import type { CampaignEvent } from '@dnd/contracts';
import { OutboxRepository } from '../../platform/events/OutboxRepository.js';
import { TurnService } from '../turns/TurnService.js';
import { ArchiveService } from '../archives/ArchiveService.js';
import { AiContextBuilder } from './AiContextBuilder.js';
import { TurnResolutionValidator } from './TurnResolutionValidator.js';
import { StateChangeMaterializer } from './StateChangeMaterializer.js';
import { ScriptedAiProvider, scriptedResolution, approvedPlayerIds } from './ScriptedAiProvider.js';
import { AiResolutionService } from './AiResolutionService.js';
import type { AiProviderPort } from './AiProviderPort.js';

async function makeFixture(provider: AiProviderPort, options: { lockTurn?: boolean } = {}) {
  const db = createSqliteDatabase(':memory:');
  await db.migrate();
  const identity = new IdentityService(db);
  const campaigns = new CampaignService(db);
  const characters = new CharacterService(db);
  const owner = await identity.register({ login: 'owner@example.test', password: 'correct-password' });
  const a = await identity.register({ login: 'a@example.test', password: 'correct-password' });
  const b = await identity.register({ login: 'b@example.test', password: 'correct-password' });
  const created = await campaigns.create(owner.userId, { name: '失落矿坑', ruleset: 'dnd5e' });
  for (const user of [a, b]) await campaigns.join({ userId: user.userId }, created.campaign.id, created.inviteCode);
  const ownerCtx = await resolveCampaignContext(db, { userId: owner.userId }, created.campaign.id);
  const aCtx = await resolveCampaignContext(db, { userId: a.userId }, created.campaign.id);
  const bCtx = await resolveCampaignContext(db, { userId: b.userId }, created.campaign.id);
  const approve = async (ctx: CampaignAuthContext, name: string) => {
    const draft = await characters.createDraft(ctx, { name, sheet: { ac: 14 } });
    await characters.submitForReview(ctx, draft.id);
    await characters.approve(ownerCtx, draft.id);
  };
  await approve(aCtx, '薇拉');
  await approve(bCtx, '卡恩');
  const outbox = new OutboxRepository(db);
  const turns = new TurnService(db, outbox);
  const turn = await turns.startTurn(ownerCtx);
  if (options.lockTurn !== false) {
    await turns.submitAction(aCtx, turn.id, { body: '我搜索房间。' });
    await turns.submitAction(bCtx, turn.id, { body: '我警戒门口。' });
  }
  const archives = new ArchiveService(db, outbox);
  const service = new AiResolutionService(
    db, provider, outbox, archives,
    new AiContextBuilder(db), new TurnResolutionValidator(db), new StateChangeMaterializer(db),
  );
  return { db, service, ownerCtx, aCtx, bCtx, turn };
}

const validResolution = (playerA: string, playerB: string) => ({
  publicNarrative: '雨停了，队伍继续前进。',
  privateUpdates: [
    { playerId: playerA, content: '你发现墙上有暗门。' },
    { playerId: playerB, content: '你听见远处有脚步声。' },
  ],
  diceResults: [
    { id: 'd1', formula: '1d20+2', total: 17, visibility: 'public', targetPlayerId: null },
    { id: 'd2', formula: '1d20', total: 5, visibility: 'player_private', targetPlayerId: playerA },
  ],
  stateChanges: [],
  interactionRequests: [],
});

describe('ai resolution service', () => {
  it('claims, runs the provider, applies formal state and auto-archives', async () => {
    const { db, service, ownerCtx, turn } = await makeFixture(
      // 脚本经 approvedPlayerIds 从真实 prompt 解析成员 id，避免在 makeFixture 前引用 aCtx/bCtx（TDZ）。
      new ScriptedAiProvider(async (input, hooks) => {
        const [pa, pb] = approvedPlayerIds(input);
        return scriptedResolution(validResolution(pa, pb), ['雨停了…'])(input, hooks);
      }),
    );
    const result = await service.resolveTurn(ownerCtx, turn.id, { idempotencyKey: 'k1' });
    expect(result.created).toBe(true);
    const run = result.run;
    expect(run.status).toBe('succeeded');
    expect(run.attempt).toBe(1);
    const turnRow = await db.query<{ status: string; completed_at: string | null }>(
      'SELECT status, completed_at FROM platform_turns WHERE id = ?', [turn.id],
    );
    expect(turnRow[0].status).toBe('completed');
    expect(turnRow[0].completed_at).not.toBeNull();
    const entries = await db.query<{ entry_kind: string; visibility: string; target_player_id: string | null }>(
      'SELECT entry_kind, visibility, target_player_id FROM platform_turn_entries WHERE turn_id = ? ORDER BY entry_index', [turn.id],
    );
    expect(entries.map((e) => e.entry_kind)).toEqual(['narrative', 'private_update', 'private_update', 'dice_result', 'dice_result']);
    const archives = await db.query<{ kind: string; label: string | null }>(
      'SELECT kind, label FROM platform_archives WHERE campaign_id = ?', [turn.campaignId],
    );
    expect(archives).toEqual([{ kind: 'automatic', label: null }]);
    // 下一回合已创建（waiting），number=2。
    const next = await db.query<{ number: number; status: string }>(
      'SELECT number, status FROM platform_turns WHERE campaign_id = ? AND number = 2', [turn.campaignId],
    );
    expect(next).toEqual([{ number: 2, status: 'waiting_for_actions' }]);
    // outbox 事件：preview.started → deltas → turn.resolved（无 owner.debug emit）。
    const events = await db.query<{ event_type: string }>(
      'SELECT event_type FROM platform_outbox_events WHERE campaign_id = ? ORDER BY sequence', [turn.campaignId],
    );
    expect(events.map((e) => e.event_type)).toContain('ai.preview.started');
    expect(events.map((e) => e.event_type)).toContain('ai.preview.delta');
    expect(events.map((e) => e.event_type)).toContain('turn.resolved');
    expect(events.map((e) => e.event_type)).not.toContain('owner.debug');
    await db.close();
  });

  it('is idempotent for the same key and does not call the provider again', async () => {
    let calls = 0;
    const { db, service, ownerCtx, turn } = await makeFixture(
      new ScriptedAiProvider(async (input, hooks) => {
        calls += 1;
        const [pa, pb] = approvedPlayerIds(input);
        return scriptedResolution(validResolution(pa, pb))(input, hooks);
      }),
    );
    const first = await service.resolveTurn(ownerCtx, turn.id, { idempotencyKey: 'same' });
    const second = await service.resolveTurn(ownerCtx, turn.id, { idempotencyKey: 'same' });
    expect(calls).toBe(1);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.run.id).toBe(first.run.id);
    expect(second.run.status).toBe('succeeded');
    // 同 key 不重写 entries/archive/events。
    const runs = await db.query<{ id: string }>('SELECT id FROM platform_ai_runs WHERE turn_id = ?', [turn.id]);
    expect(runs).toHaveLength(1);
    const entries = await db.query('SELECT id FROM platform_turn_entries WHERE turn_id = ?', [turn.id]);
    expect(entries).toHaveLength(5);
    const archives = await db.query('SELECT id FROM platform_archives WHERE campaign_id = ?', [turn.campaignId]);
    expect(archives).toHaveLength(1);
    await db.close();
  });

  it('same-key resolve while a run is running returns the running run and stays deterministic', async () => {
    // 固定 API 语义（见执行前约束）：同 key 命中 running run 时立即返回 { created:false, status:'running' }，
    // 不等待、不重复调 provider；客户端可 GET run 轮询。测试用 gate 阻塞首个 provider claim 之后、
    // 其 formal apply 之前，确定性地验证第二次 resolve 的返回与状态。
    let calls = 0;
    let releaseProvider: (() => void) | null = null;
    const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const { db, service, ownerCtx, turn } = await makeFixture(
      new ScriptedAiProvider(async (input, hooks) => {
        calls += 1;
        await providerGate; // 第一次 provider 调用在此阻塞，直到测试放行
        const [pa, pb] = approvedPlayerIds(input);
        return scriptedResolution(validResolution(pa, pb))(input, hooks);
      }),
    );
    // 第一次 resolve 启动（claim 已提交：run=running、turn=resolving），provider 阻塞在 gate。
    // 注：SQLite 按 adapter 串行化异步事务，claim 先 commit 后 provider 才启动，因此 second resolve
    // 到达时 run 已持久化为 running（turn=resolving），幂等查重稳定命中。
    const firstPromise = service.resolveTurn(ownerCtx, turn.id, { idempotencyKey: 'gate-same' });
    // 等待首个 provider 调用真正进入（calls === 1）后再发起第二个同 key resolve。
    await vi.waitFor(() => expect(calls).toBe(1));
    const second = await service.resolveTurn(ownerCtx, turn.id, { idempotencyKey: 'gate-same' });
    // 第二个同 key resolve 立即返回既有 running run（created=false），不等待、不重复调 provider。
    expect(second.created).toBe(false);
    expect(second.run.status).toBe('running');
    expect(second.run.id).toBeDefined();
    expect(calls).toBe(1); // provider 仍只被调用一次
    // 放行 provider → 第一个 resolve 完成 formal apply → succeeded。
    releaseProvider!();
    const first = await firstPromise;
    expect(first.created).toBe(true);
    expect(first.run.status).toBe('succeeded');
    expect(first.run.id).toBe(second.run.id);
    // 第三次同 key resolve = 完成后 replay，返回同一 succeeded run。
    const replay = await service.resolveTurn(ownerCtx, turn.id, { idempotencyKey: 'gate-same' });
    expect(replay.created).toBe(false);
    expect(replay.run.id).toBe(first.run.id);
    expect(replay.run.status).toBe('succeeded');
    // 始终只有一组 runs/entries/archive/events。
    expect((await db.query('SELECT id FROM platform_ai_runs WHERE turn_id = ?', [turn.id])).length).toBe(1);
    expect((await db.query('SELECT id FROM platform_turn_entries WHERE turn_id = ?', [turn.id])).length).toBe(5);
    expect((await db.query('SELECT id FROM platform_archives WHERE campaign_id = ?', [turn.campaignId])).length).toBe(1);
    await db.close();
  });

  it('serializes concurrent different-key resolves: one claim wins, the other gets STATE_CONFLICT, attempts distinct', async () => {
    const { db, service, ownerCtx, turn } = await makeFixture(
      new ScriptedAiProvider(async (input, hooks) => {
        const [pa, pb] = approvedPlayerIds(input);
        return scriptedResolution(validResolution(pa, pb))(input, hooks);
      }),
    );
    const results = await Promise.allSettled([
      service.resolveTurn(ownerCtx, turn.id, { idempotencyKey: 'conc-a' }),
      service.resolveTurn(ownerCtx, turn.id, { idempotencyKey: 'conc-b' }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1); // 恰一个 claim 成功
    expect(rejected).toHaveLength(1);
    expect((rejected[0].reason as { code?: string }).code).toBe('STATE_CONFLICT'); // 后到者撞 resolving
    const runs = await db.query<{ attempt: number }>('SELECT attempt FROM platform_ai_runs WHERE turn_id = ?', [turn.id]);
    expect(runs).toHaveLength(1);
    expect(runs[0].attempt).toBe(1); // attempt 无重复、无跳号
    await db.close();
  });

  it('marks an internal formal-apply failure as INTERNAL_ERROR with no partial writes and consistent state', async () => {
    // formal apply 内 throw 非 AppError 的 DB/未知错误（materializer 或 insert 层）：
    // 必须 INTERNAL_ERROR（绝不当 AI_PROVIDER_FAILED 误报），turn=needs_owner_attention，
    // run 置 failed，且无任何半截正式写（entries/archive/next turn/turn.resolved 全无）。
    // 用依赖注入模拟 materializer：applyAll 抛 raw Error（非 AppError），provider 本身正常。
    const { db, ownerCtx, turn } = await makeFixture(
      new ScriptedAiProvider(async (input, hooks) => {
        const [pa, pb] = approvedPlayerIds(input);
        return scriptedResolution(validResolution(pa, pb))(input, hooks);
      }),
    );
    const failing = new AiResolutionService(
      db,
      new ScriptedAiProvider(async (input, hooks) => {
        const [pa, pb] = approvedPlayerIds(input);
        return scriptedResolution(validResolution(pa, pb))(input, hooks);
      }),
      new OutboxRepository(db),
      new ArchiveService(db, new OutboxRepository(db)),
      new AiContextBuilder(db),
      new TurnResolutionValidator(db),
      new (class extends StateChangeMaterializer {
        override async applyAll(): Promise<void> {
          throw new Error('boom apply');
        }
      })(db),
    );
    await expect(failing.resolveTurn(ownerCtx, turn.id, { idempotencyKey: 'internal-2' })).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    const runRow = await db.query<{ id: string; status: string; error_code: string | null }>(
      'SELECT id, status, error_code FROM platform_ai_runs WHERE turn_id = ?', [turn.id],
    );
    expect(runRow).toHaveLength(1);
    expect(runRow[0].status).toBe('failed');
    expect(runRow[0].error_code).toBe('INTERNAL_ERROR');
    // 落库脱敏文案也按 code 区分：INTERNAL_ERROR 不得出现 provider 专属文案（与 fail() 的
    // code-aware 脱敏一致），证明阶段分类在持久化层同样成立、绝不在落库层误报 provider 失败。
    const failedJson = await db.query<{ error_json: string | null }>('SELECT error_json FROM platform_ai_runs WHERE id = ?', [runRow[0].id]);
    expect(JSON.stringify(failedJson[0].error_json)).toContain('AI 结算内部错误，详情已脱敏。');
    expect(JSON.stringify(failedJson[0].error_json)).not.toContain('AI Provider 调用失败');
    const turnRow = await db.query<{ status: string }>('SELECT status FROM platform_turns WHERE id = ?', [turn.id]);
    expect(turnRow[0].status).toBe('needs_owner_attention');
    // 无半截正式写：无 entries、无 archive、无新回合、无 turn.resolved。
    const entries = await db.query('SELECT id FROM platform_turn_entries WHERE turn_id = ?', [turn.id]);
    expect(entries).toHaveLength(0);
    const archives = await db.query('SELECT id FROM platform_archives WHERE campaign_id = ?', [turn.campaignId]);
    expect(archives).toHaveLength(0);
    const turnCount = await db.query<{ count: number }>(
      'SELECT COUNT(*) AS count FROM platform_turns WHERE campaign_id = ?', [turn.campaignId],
    );
    expect(Number(turnCount[0].count)).toBe(1); // 只有 t1，无下一回合
    const events = await db.query<{ event_type: string }>(
      'SELECT event_type FROM platform_outbox_events WHERE campaign_id = ?', [turn.campaignId],
    );
    expect(events.map((e) => e.event_type)).toContain('ai.preview.failed');
    expect(events.map((e) => e.event_type)).not.toContain('turn.resolved');
    await db.close();
  });

  it('fails provider errors into needs_owner_attention with AI_PROVIDER_FAILED and no partial writes', async () => {
    const { db, service, ownerCtx, turn } = await makeFixture(
      new ScriptedAiProvider(async () => { throw new Error('provider down'); }),
    );
    await expect(service.resolveTurn(ownerCtx, turn.id, { idempotencyKey: 'fail1' })).rejects.toMatchObject({ code: 'AI_PROVIDER_FAILED' });
    const run = await db.query<{ status: string; error_code: string | null }>(
      'SELECT status, error_code FROM platform_ai_runs WHERE turn_id = ?', [turn.id],
    );
    expect(run[0].status).toBe('failed');
    expect(run[0].error_code).toBe('AI_PROVIDER_FAILED');
    const turnRow = await db.query<{ status: string }>('SELECT status FROM platform_turns WHERE id = ?', [turn.id]);
    expect(turnRow[0].status).toBe('needs_owner_attention');
    // 无正式 entries / archive / 下一回合 / turn.resolved。
    expect((await db.query('SELECT id FROM platform_turn_entries WHERE turn_id = ?', [turn.id])).length).toBe(0);
    expect((await db.query('SELECT id FROM platform_archives WHERE campaign_id = ?', [turn.campaignId])).length).toBe(0);
    expect((await db.query('SELECT id FROM platform_turns WHERE campaign_id = ? AND number = 2', [turn.campaignId])).length).toBe(0);
    const events = await db.query<{ event_type: string }>(
      'SELECT event_type FROM platform_outbox_events WHERE campaign_id = ?', [turn.campaignId],
    );
    expect(events.map((e) => e.event_type)).toContain('ai.preview.failed');
    expect(events.map((e) => e.event_type)).not.toContain('turn.resolved');
    await db.close();
  });

  it('wraps a delta publish DB failure as INTERNAL_ERROR, not AI_PROVIDER_FAILED', async () => {
    // provider 成功 stream，但首个 delta 的短 tx/outbox publish 抛 raw DB 错误：
    // 必须按内部错误（INTERNAL_ERROR）归类，绝不当 provider 失败误报；无正式写、无原始 DB 信息泄漏。
    const { db, ownerCtx, turn } = await makeFixture(
      new ScriptedAiProvider(async (input, hooks) => {
        const [pa, pb] = approvedPlayerIds(input);
        return scriptedResolution(validResolution(pa, pb), ['雨停了…'])(input, hooks);
      }),
    );
    // 注入 outbox 失败：只在 ai.preview.delta 事件（provider 流式期间的短 tx/publish）抛 raw DB 错误，
    // 其它事件（claim 的 ai.preview.started、fail 的 ai.preview.failed）走真实实现，保证故障定位在 delta publish。
    const brokenOutbox = new (class extends OutboxRepository {
      override async publishIn(tx: QueryExecutor, event: CampaignEvent): Promise<number> {
        if (event.type === 'ai.preview.delta') {
          throw new Error('boom delta db');
        }
        return super.publishIn(tx, event);
      }
    })(db);
    const failing = new AiResolutionService(
      db,
      new ScriptedAiProvider(async (input, hooks) => {
        const [pa, pb] = approvedPlayerIds(input);
        return scriptedResolution(validResolution(pa, pb), ['雨停了…'])(input, hooks);
      }),
      brokenOutbox,
      new ArchiveService(db, brokenOutbox),
      new AiContextBuilder(db),
      new TurnResolutionValidator(db),
      new StateChangeMaterializer(db),
    );
    await expect(failing.resolveTurn(ownerCtx, turn.id, { idempotencyKey: 'delta-internal' })).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    const runRow = await db.query<{ status: string; error_code: string | null; error_json: string | null; raw_debug_json: string | null }>(
      'SELECT status, error_code, error_json, raw_debug_json FROM platform_ai_runs WHERE turn_id = ?', [turn.id],
    );
    expect(runRow).toHaveLength(1);
    expect(runRow[0].status).toBe('failed');
    expect(runRow[0].error_code).toBe('INTERNAL_ERROR');
    // 脱敏：原始 DB 错误文本与内部固定文案均不携带 'boom delta db'。
    const joined = `${runRow[0].error_json ?? ''}${runRow[0].raw_debug_json ?? ''}`;
    expect(joined).toContain('AI 预览流式写入内部错误。');
    expect(joined).not.toContain('boom delta db');
    expect(joined).not.toContain('AI Provider 调用失败');
    const turnRow = await db.query<{ status: string }>('SELECT status FROM platform_turns WHERE id = ?', [turn.id]);
    expect(turnRow[0].status).toBe('needs_owner_attention');
    // 无正式写：无 entries、无 archive、无下一回合、无 turn.resolved。
    expect((await db.query('SELECT id FROM platform_turn_entries WHERE turn_id = ?', [turn.id])).length).toBe(0);
    expect((await db.query('SELECT id FROM platform_archives WHERE campaign_id = ?', [turn.campaignId])).length).toBe(0);
    expect((await db.query('SELECT id FROM platform_turns WHERE campaign_id = ? AND number = 2', [turn.campaignId])).length).toBe(0);
    const events = await db.query<{ event_type: string }>(
      'SELECT event_type FROM platform_outbox_events WHERE campaign_id = ?', [turn.campaignId],
    );
    expect(events.map((e) => e.event_type)).toContain('ai.preview.failed');
    expect(events.map((e) => e.event_type)).not.toContain('turn.resolved');
    await db.close();
  });

  it('sanitizes provider error messages so raw secrets never persist', async () => {
    const { db, service, ownerCtx, turn } = await makeFixture(
      new ScriptedAiProvider(async () => { throw new Error('boom api_key=sk-secret-123&token=abc456'); }),
    );
    await expect(service.resolveTurn(ownerCtx, turn.id, { idempotencyKey: 'fail-secret' }))
      .rejects.toMatchObject({ code: 'AI_PROVIDER_FAILED' });
    const rows = await db.query<{ error_json: string | null; raw_debug_json: string | null }>(
      'SELECT error_json, raw_debug_json FROM platform_ai_runs WHERE turn_id = ?', [turn.id],
    );
    const joined = `${rows[0].error_json ?? ''}${rows[0].raw_debug_json ?? ''}`;
    // 原始 provider 文本（secret/token 与 raw 前缀 boom）一律不落库；只有固定脱敏结构。
    expect(joined).not.toContain('sk-secret-123');
    expect(joined).not.toContain('abc456');
    expect(joined).not.toContain('boom');
    expect(joined).toContain('AI Provider 调用失败，详情已脱敏。');
    await db.close();
  });

  it('rejects invalid AI output with AI_OUTPUT_INVALID and no formal writes', async () => {
    const { db, service, ownerCtx, turn } = await makeFixture(
      // 空 publicNarrative 触发 schema 校验 AI_OUTPUT_INVALID；与 combat gate 分离。
      new ScriptedAiProvider(scriptedResolution({ publicNarrative: '', privateUpdates: [], diceResults: [], stateChanges: [], interactionRequests: [] })),
    );
    await expect(service.resolveTurn(ownerCtx, turn.id, { idempotencyKey: 'bad1' })).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
    const turnRow = await db.query<{ status: string }>('SELECT status FROM platform_turns WHERE id = ?', [turn.id]);
    expect(turnRow[0].status).toBe('needs_owner_attention');
    expect((await db.query('SELECT id FROM platform_archives WHERE campaign_id = ?', [turn.campaignId])).length).toBe(0);
    await db.close();
  });

  it('gates combat state changes with STATE_CONFLICT and writes no formal state', async () => {
    const { db, service, ownerCtx, turn } = await makeFixture(
      new ScriptedAiProvider(scriptedResolution({ publicNarrative: '战斗开始。', privateUpdates: [], diceResults: [], stateChanges: [{ kind: 'combat', targetId: 'enc-1', patch: { hpCurrent: 1 }, visibility: 'public' }], interactionRequests: [] })),
    );
    await expect(service.resolveTurn(ownerCtx, turn.id, { idempotencyKey: 'combat1' })).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    const turnRow = await db.query<{ status: string }>('SELECT status FROM platform_turns WHERE id = ?', [turn.id]);
    expect(turnRow[0].status).toBe('needs_owner_attention');
    expect((await db.query('SELECT id FROM platform_archives WHERE campaign_id = ?', [turn.campaignId])).length).toBe(0);
    expect((await db.query('SELECT id FROM platform_turn_entries WHERE turn_id = ?', [turn.id])).length).toBe(0);
    await db.close();
  });

  it('allows a failed retry with a NEW key and rejects the same key as a replay', async () => {
    const { db, service, ownerCtx, turn } = await makeFixture(
      new ScriptedAiProvider(async (input, hooks) => {
        throw new Error('boom');
      }),
    );
    await expect(service.resolveTurn(ownerCtx, turn.id, { idempotencyKey: 'failA' })).rejects.toMatchObject({ code: 'AI_PROVIDER_FAILED' });
    // 同 key 重试 = idempotent replay：返回既有 failed run（created=false），不调 provider。
    const replay = await service.resolveTurn(ownerCtx, turn.id, { idempotencyKey: 'failA' });
    expect(replay.created).toBe(false);
    expect(replay.run.status).toBe('failed');
    // 新 key → 新 attempt 成功（换 provider 后重试）。
    const db2 = db; // 同库；换 provider 直接构造新服务验证新 key 重试
    const outbox = new OutboxRepository(db2);
    const archives = new ArchiveService(db2, outbox);
    const ok = new AiResolutionService(
      db2, new ScriptedAiProvider(async (input, hooks) => {
        const [pa, pb] = approvedPlayerIds(input);
        return scriptedResolution(validResolution(pa, pb))(input, hooks);
      }), outbox, archives,
      new AiContextBuilder(db2), new TurnResolutionValidator(db2), new StateChangeMaterializer(db2),
    );
    const retried = await ok.resolveTurn(ownerCtx, turn.id, { idempotencyKey: 'retryB' });
    expect(retried.created).toBe(true);
    expect(retried.run.attempt).toBe(2);
    expect(retried.run.status).toBe('succeeded');
    await db.close();
  });

  it('rejects resolving a waiting turn and a completed turn', async () => {
    // waiting 用例：makeFixture({ lockTurn: false }) 只 startTurn，不提交 action → turn 仍是 waiting_for_actions。
    const waiting = await makeFixture(new ScriptedAiProvider(scriptedResolution({ publicNarrative: 'x', privateUpdates: [], diceResults: [], stateChanges: [], interactionRequests: [] })), { lockTurn: false });
    await expect(waiting.service.resolveTurn(waiting.ownerCtx, waiting.turn.id, { idempotencyKey: 'k-wait' })).rejects.toMatchObject({ code: 'TURN_NOT_ACTIVE' });
    await waiting.db.close();

    // completed 用例：locked fixture（默认 lockTurn: true 已提交并锁定）后在测试 SQL 直接置 completed
    // （等价于专用 helper 构造完成态）；completed 是终态已结算，新 key resolve 不得绕过 idempotency，
    // 因此必须 STATE_CONFLICT（同 key completed replay 返回既有 succeeded run，见下方独立用例）。
    const { db, service, ownerCtx, turn } = await makeFixture(
      new ScriptedAiProvider(scriptedResolution({ publicNarrative: 'x', privateUpdates: [], diceResults: [], stateChanges: [], interactionRequests: [] })),
    );
    const now = new Date().toISOString();
    await db.execute("UPDATE platform_turns SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?", [
      now, now, turn.id,
    ]);
    await expect(service.resolveTurn(ownerCtx, turn.id, { idempotencyKey: 'k-completed' })).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    await db.close();
  });

  it('rejects a player resolving', async () => {
    const { service, aCtx, turn } = await makeFixture(new ScriptedAiProvider(scriptedResolution({})));
    await expect(service.resolveTurn(aCtx, turn.id, { idempotencyKey: 'k' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('returns created=false for an idempotent replay after the turn is completed (succeeded run)', async () => {
    const { db, service, ownerCtx, turn } = await makeFixture(
      new ScriptedAiProvider(async (input, hooks) => {
        const [pa, pb] = approvedPlayerIds(input);
        return scriptedResolution(validResolution(pa, pb))(input, hooks);
      }),
    );
    const first = await service.resolveTurn(ownerCtx, turn.id, { idempotencyKey: 'replay-after-success' });
    expect(first.created).toBe(true);
    expect(first.run.status).toBe('succeeded');
    // 成功后 turn 已 completed：同 key replay 仍应返回既有 succeeded run（created=false），不抛 STATE_CONFLICT。
    const replay = await service.resolveTurn(ownerCtx, turn.id, { idempotencyKey: 'replay-after-success' });
    expect(replay.created).toBe(false);
    expect(replay.run.id).toBe(first.run.id);
    expect(replay.run.status).toBe('succeeded');
    await db.close();
  });
});
