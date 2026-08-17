import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installHarnessFetch, jsonHeaders, registerAndLogin, startTestPlatformServer } from './httpTestHarness.js';
import {
  ScriptedAiProvider,
  approvedPlayerIds,
  scriptedResolution,
  type AiProviderScript,
} from '../modules/ai-runtime/ScriptedAiProvider.js';

let restoreHarnessFetch: (() => void) | undefined;
beforeAll(() => { restoreHarnessFetch = installHarnessFetch(); });
afterAll(() => { restoreHarnessFetch?.(); });

interface Actor { userId: string; cookieJar: import('./httpTestHarness.js').TestCookieJar; }

/** 成功脚本：经 approvedPlayerIds 从真实 prompt 解析成员 id 构造 privateUpdates/dice/interactions。 */
const successScript: AiProviderScript = async (prompt, hooks) => {
  const [pa, pb] = approvedPlayerIds(prompt);
  await hooks.onDelta({ kind: 'text', text: '雨停了…' });
  return {
    publicNarrative: '雨停了，队伍在矿洞口重整。',
    privateUpdates: [
      { playerId: pa, content: '你发现墙上有暗门。' },
      { playerId: pb, content: '你听见远处传来脚步声。' },
    ],
    // Dice are resolved by the server, never authored by the Provider.
    diceResults: [],
    stateChanges: [],
    interactionRequests: [{ id: 'i1', targetPlayerId: pa, prompt: '暗门似乎虚掩，你要推开吗？' }],
  };
};

async function makeFullCampaign(baseUrl: string) {
  const owner = await registerAndLogin(baseUrl, 'owner@example.test');
  const playerA = await registerAndLogin(baseUrl, 'a@example.test');
  const playerB = await registerAndLogin(baseUrl, 'b@example.test');
  const createRes = await fetch(`${baseUrl}/api/campaigns`, {
    method: 'POST', headers: jsonHeaders(owner.cookieJar.header()),
    body: JSON.stringify({ name: '失落矿坑', ruleset: 'dnd5e' }),
  });
  expect(createRes.status).toBe(201);
  const created = (await createRes.json()) as { campaign: { id: string }; inviteCode: string };
  for (const actor of [playerA, playerB]) {
    const joinRes = await fetch(`${baseUrl}/api/campaigns/${created.campaign.id}/join`, {
      method: 'POST', headers: jsonHeaders(actor.cookieJar.header()),
      body: JSON.stringify({ inviteCode: created.inviteCode }),
    });
    expect(joinRes.status).toBe(201);
  }
  const charsBase = `${baseUrl}/api/campaigns/${created.campaign.id}/characters`;
  for (const [actor, name] of [[playerA, '薇拉'], [playerB, '卡恩']] as const) {
    const createChar = await fetch(`${charsBase}`, {
      method: 'POST', headers: jsonHeaders(actor.cookieJar.header()),
      body: JSON.stringify({ name, sheet: { ac: 14 } }),
    });
    expect(createChar.status).toBe(201);
    const char = (await createChar.json()) as { character: { id: string } };
    const submit = await fetch(`${charsBase}/${char.character.id}/submit`, { method: 'POST', headers: jsonHeaders(actor.cookieJar.header()) });
    expect(submit.status).toBe(200);
    const review = await fetch(`${charsBase}/${char.character.id}/review`, {
      method: 'POST', headers: jsonHeaders(owner.cookieJar.header()),
      body: JSON.stringify({ action: 'approve' }),
    });
    expect(review.status).toBe(200);
  }
  return { owner, playerA, playerB, campaignId: created.campaign.id };
}

async function lockTurn(baseUrl: string, campaignId: string, owner: Actor, playerA: Actor, playerB: Actor): Promise<{ turnId: string; aiBase: string }> {
  const turnsBase = `${baseUrl}/api/campaigns/${campaignId}/turns`;
  const startRes = await fetch(`${turnsBase}`, { method: 'POST', headers: jsonHeaders(owner.cookieJar.header()) });
  expect(startRes.status).toBe(201);
  const turn = (await startRes.json()) as { turn: { id: string } };
  for (const [actor, body] of [[playerA, '我搜索房间。'], [playerB, '我警戒门口。']] as const) {
    const res = await fetch(`${turnsBase}/${turn.turn.id}/actions`, {
      method: 'POST', headers: jsonHeaders(actor.cookieJar.header()),
      body: JSON.stringify({ body }),
    });
    expect(res.status).toBe(200);
  }
  return { turnId: turn.turn.id, aiBase: `${baseUrl}/api/campaigns/${campaignId}/ai` };
}

describe('HTTP server-side AI vertical flow', () => {
  it('runs create → join → approve → submit → lock → resolve → archive → project with full privacy isolation', async () => {
    const server = await startTestPlatformServer({ aiProvider: new ScriptedAiProvider(successScript) });
    try {
      const { baseUrl, platformDb } = server;
      const { owner, playerA, playerB, campaignId } = await makeFullCampaign(baseUrl);
      const { turnId, aiBase } = await lockTurn(baseUrl, campaignId, owner, playerA, playerB);

      // owner resolve（幂等 key）。
      const resolveRes = await fetch(`${aiBase}/turns/${turnId}/runs`, {
        method: 'POST', headers: jsonHeaders(owner.cookieJar.header()),
        body: JSON.stringify({ idempotencyKey: 'vertical-1' }),
      });
      expect(resolveRes.status).toBe(201);
      const run = (await resolveRes.json()) as { run: { id: string; status: string } };
      expect(run.run.status).toBe('succeeded');

      // 自动存档 + 下一回合 + interaction 请求。
      const archives = await platformDb.query<{ kind: string; label: string | null; version: number }>(
        'SELECT kind, label, version FROM platform_archives WHERE campaign_id = ?', [campaignId],
      );
      expect(archives).toEqual([{ kind: 'automatic', label: null, version: 1 }]);
      const nextTurn = await platformDb.query<{ number: number; status: string }>(
        'SELECT number, status FROM platform_turns WHERE campaign_id = ? AND number = 2', [campaignId],
      );
      expect(nextTurn).toEqual([{ number: 2, status: 'waiting_for_actions' }]);
      const interactions = await platformDb.query<{ id: string; provider_id: string; target_player_id: string; status: string }>(
        'SELECT id, provider_id, target_player_id, status FROM platform_interaction_requests WHERE campaign_id = ?', [campaignId],
      );
      // provider 的 'i1' 只存 provider_id 列；DB 主键是内部 nanoid（跨 run/跨 campaign 不复用短 id），status pending。
      expect(interactions).toHaveLength(1);
      expect(interactions[0].provider_id).toBe('i1');
      expect(interactions[0].target_player_id).toBe(playerA.userId);
      expect(interactions[0].status).toBe('pending');
      expect(interactions[0].id).not.toBe('i1');

      // preview / interaction 正式事件：preview.started + delta + turn.resolved + interaction.requested。
      const events = await platformDb.query<{ event_type: string; payload_json: string }>(
        'SELECT event_type, payload_json FROM platform_outbox_events WHERE campaign_id = ? ORDER BY sequence', [campaignId],
      );
      const eventTypes = events.map((e) => e.event_type);
      expect(eventTypes).toContain('ai.preview.started');
      expect(eventTypes).toContain('ai.preview.delta');
      expect(eventTypes).toContain('turn.resolved');
      expect(eventTypes).toContain('interaction.requested');
      const deltaPayloads = events.filter((e) => e.event_type === 'ai.preview.delta').map((e) => JSON.parse(e.payload_json));
      expect(deltaPayloads).toHaveLength(1);
      expect(deltaPayloads[0].text).toBe('雨停了…');
      // interaction.requested 的 requestId 是内部 id（与 platform_interaction_requests.id 一致，非 provider 短 id）。
      const interactionEvent = events.find((e) => e.event_type === 'interaction.requested');
      expect(JSON.parse(interactionEvent!.payload_json).requestId).toBe(interactions[0].id);

      // entries 投影：A 见 public + 自己的 private_update；不见 B 私密与 Provider-authored dice（骰子由服务端处理）。
      const aEntriesRes = await fetch(`${aiBase}/turns/${turnId}/entries`, { headers: { cookie: playerA.cookieJar.header() } });
      const aEntriesText = await aEntriesRes.text();
      const aEntries = JSON.parse(aEntriesText) as { entries: Array<{ visibility: string; targetPlayerId: string | null }> };
      expect(aEntries.entries.filter((e) => e.visibility === 'player_private').map((e) => e.targetPlayerId))
        .toEqual([playerA.userId]);
      const bEntries = JSON.stringify(await (await fetch(`${aiBase}/turns/${turnId}/entries`, { headers: { cookie: playerB.cookieJar.header() } })).json());
      expect(bEntries).not.toContain('暗门');
      expect(bEntries).toContain('脚步声');
      // entries DTO 不泄漏 *_json / 内部列。
      expect(aEntriesText).not.toContain('_json');

      // run 详情 owner 可见 context/rawDebug；player FORBIDDEN 且响应不泄漏 result/rawDebug。
      const playerRunDetail = await fetch(`${aiBase}/runs/${run.run.id}`, { headers: { cookie: playerA.cookieJar.header() } });
      expect(playerRunDetail.status).toBe(403);
      const playerDetailText = await playerRunDetail.text();
      expect(playerDetailText).not.toContain('rawDebug');
      expect(playerDetailText).not.toContain('publicNarrative');
      const ownerRunDetailRes = await fetch(`${aiBase}/runs/${run.run.id}`, { headers: { cookie: owner.cookieJar.header() } });
      expect(ownerRunDetailRes.status).toBe(200);
      const ownerRunDetailText = await ownerRunDetailRes.text();
      const ownerRunDetail = JSON.parse(ownerRunDetailText) as { run: { context: unknown; rawDebug: unknown; narrationAttempts: unknown[] } };
      expect(ownerRunDetail.run.context).toBeTruthy();
      expect(ownerRunDetail.run.rawDebug).toBeTruthy();
      expect(ownerRunDetail.run.narrationAttempts).toEqual([]);
      expect(ownerRunDetailText).not.toContain('_json');

      // 手动存档（label trimmed）+ 恢复：此时 AI 结算后回合 2 为 waiting，手动快照 currentTurn = 回合 2。
      // 恢复 waiting 快照 → 回合 2 恢复为 waiting（不被 supersede），不开新回合（number 仍为 2）。
      const archivesBase = `${baseUrl}/api/campaigns/${campaignId}/archives`;
      const manual = await fetch(`${archivesBase}`, {
        method: 'POST', headers: jsonHeaders(owner.cookieJar.header()),
        body: JSON.stringify({ label: '  进洞前  ' }),
      });
      expect(manual.status).toBe(201);
      const manualArchive = (await manual.json()) as { archive: { id: string; label: string; version: number } };
      expect(manualArchive.archive.label).toBe('进洞前');
      // archive DTO 不泄漏 state_json / *_json。
      expect(JSON.stringify(manualArchive)).not.toContain('_json');
      const archivesList = await (await fetch(`${archivesBase}`, { headers: { cookie: owner.cookieJar.header() } })).text();
      expect(archivesList).not.toContain('state_json');
      expect(archivesList).not.toContain('_json');
      const restoreRes = await fetch(`${archivesBase}/${manualArchive.archive.id}/restore`, { method: 'POST', headers: jsonHeaders(owner.cookieJar.header()) });
      expect(restoreRes.status).toBe(200);
      // 恢复完成后：回合 2 仍是当前回合（waiting、不被 supersede），没有新增回合。
      const allTurns = await platformDb.query<{ number: number; status: string; superseded_at: string | null }>(
        'SELECT number, status, superseded_at FROM platform_turns WHERE campaign_id = ? ORDER BY number', [campaignId],
      );
      expect(allTurns.map((r) => r.number)).toEqual([1, 2]);
      expect(allTurns[1].status).toBe('waiting_for_actions');
      expect(allTurns[1].superseded_at).toBeNull(); // 恢复的是当前回合，不被 supersede
      // completed 快照恢复后新回合 MAX+1 不复用的契约由 archive.test.ts 覆盖。
    } finally {
      await server.close();
    }
  });

  it('fails provider errors with AI_PROVIDER_FAILED, retries with a new key, and writes nothing partial', async () => {
    let calls = 0;
    const flakyScript: AiProviderScript = async (prompt, hooks) => {
      calls += 1;
      if (calls === 1) throw new Error('provider down');
      return successScript(prompt, hooks);
    };
    const server = await startTestPlatformServer({ aiProvider: new ScriptedAiProvider(flakyScript) });
    try {
      const { baseUrl, platformDb } = server;
      const { owner, playerA, playerB, campaignId } = await makeFullCampaign(baseUrl);
      const { turnId, aiBase } = await lockTurn(baseUrl, campaignId, owner, playerA, playerB);

      // 第一次 resolve：provider throw → AI_PROVIDER_FAILED，turn=needs_owner_attention，无正式写。
      const failRes = await fetch(`${aiBase}/turns/${turnId}/runs`, {
        method: 'POST', headers: jsonHeaders(owner.cookieJar.header()),
        body: JSON.stringify({ idempotencyKey: 'fail-1' }),
      });
      expect(failRes.status).toBe(502);
      const failBody = (await failRes.json()) as { error: { code: string } };
      expect(failBody.error.code).toBe('AI_PROVIDER_FAILED');
      const turnRow = await platformDb.query<{ status: string }>('SELECT status FROM platform_turns WHERE id = ?', [turnId]);
      expect(turnRow[0].status).toBe('needs_owner_attention');
      expect((await platformDb.query('SELECT id FROM platform_turn_entries WHERE turn_id = ?', [turnId])).length).toBe(0);
      expect((await platformDb.query('SELECT id FROM platform_archives WHERE campaign_id = ?', [campaignId])).length).toBe(0);
      expect((await platformDb.query('SELECT id FROM platform_turns WHERE campaign_id = ? AND number = 2', [campaignId])).length).toBe(0);
      const events = await platformDb.query<{ event_type: string }>('SELECT event_type FROM platform_outbox_events WHERE campaign_id = ?', [campaignId]);
      expect(events.map((e) => e.event_type)).toContain('ai.preview.failed');
      expect(events.map((e) => e.event_type)).not.toContain('turn.resolved');

      // 同 key 重试 = idempotent replay（返回既有 failed run，不再调 provider）。
      const replayRes = await fetch(`${aiBase}/turns/${turnId}/runs`, {
        method: 'POST', headers: jsonHeaders(owner.cookieJar.header()),
        body: JSON.stringify({ idempotencyKey: 'fail-1' }),
      });
      expect(replayRes.status).toBe(200);
      const replay = (await replayRes.json()) as { run: { status: string } };
      expect(replay.run.status).toBe('failed');
      const callsAfterReplay = calls;

      // 新 key 重试成功（attempt=2），正式写齐全且只产生一组。
      const retryRes = await fetch(`${aiBase}/turns/${turnId}/runs`, {
        method: 'POST', headers: jsonHeaders(owner.cookieJar.header()),
        body: JSON.stringify({ idempotencyKey: 'retry-2' }),
      });
      expect(retryRes.status).toBe(201);
      const retry = (await retryRes.json()) as { run: { id: string; status: string; attempt: number } };
      expect(retry.run.status).toBe('succeeded');
      expect(retry.run.attempt).toBe(2);
      expect(calls).toBe(callsAfterReplay + 1);
      const archives = await platformDb.query<{ kind: string }>('SELECT kind FROM platform_archives WHERE campaign_id = ?', [campaignId]);
      expect(archives).toEqual([{ kind: 'automatic' }]);
      // 恰两条 run（fail-1 failed + retry-2 succeeded），replay 不新增 run；正式 entries 只属于成功 run。
      const runs = await platformDb.query<{ status: string }>('SELECT status FROM platform_ai_runs WHERE turn_id = ?', [turnId]);
      expect(runs).toHaveLength(2);
      const entries = await platformDb.query<{ ai_run_id: string }>('SELECT ai_run_id FROM platform_turn_entries WHERE turn_id = ?', [turnId]);
      expect(entries).toHaveLength(3);
      expect(entries.every((e) => e.ai_run_id === retry.run.id)).toBe(true);
      // 失败回合（fail-1 的 run）error_json/raw_debug 为严格白名单脱敏结构，原始 provider 文本/secret 不落库。
      const failed = await platformDb.query<{ error_json: string | null }>("SELECT error_json FROM platform_ai_runs WHERE turn_id = ? AND status = 'failed'", [turnId]);
      expect(failed).toHaveLength(1);
      const errorJson = JSON.parse(failed[0].error_json ?? '{}');
      expect(errorJson).toMatchObject({ code: 'AI_PROVIDER_FAILED' });
      // 固定脱敏文案 + 不包含原始 provider Error 文本（flaky 脚本抛 'provider down'）。
      expect(JSON.stringify(errorJson)).toContain('AI Provider 调用失败，详情已脱敏。');
      expect(JSON.stringify(errorJson)).not.toContain('provider down');
    } finally {
      await server.close();
    }
  });

  it('rejects invalid AI output with AI_OUTPUT_INVALID and no partial writes', async () => {
    const server = await startTestPlatformServer({
      aiProvider: new ScriptedAiProvider(
        scriptedResolution({ publicNarrative: '', privateUpdates: [], diceResults: [], stateChanges: [], interactionRequests: [] }),
      ),
    });
    try {
      const { baseUrl, platformDb } = server;
      const { owner, playerA, playerB, campaignId } = await makeFullCampaign(baseUrl);
      const { turnId, aiBase } = await lockTurn(baseUrl, campaignId, owner, playerA, playerB);

      // 空 publicNarrative 触发 schema 校验 AI_OUTPUT_INVALID；turn=needs_owner_attention，无正式写。
      const invalidRes = await fetch(`${aiBase}/turns/${turnId}/runs`, {
        method: 'POST', headers: jsonHeaders(owner.cookieJar.header()),
        body: JSON.stringify({ idempotencyKey: 'invalid-1' }),
      });
      expect(invalidRes.status).toBe(422);
      const invalidBody = (await invalidRes.json()) as { error: { code: string } };
      expect(invalidBody.error.code).toBe('AI_OUTPUT_INVALID');
      const turnRow = await platformDb.query<{ status: string }>('SELECT status FROM platform_turns WHERE id = ?', [turnId]);
      expect(turnRow[0].status).toBe('needs_owner_attention');
      expect((await platformDb.query('SELECT id FROM platform_turn_entries WHERE turn_id = ?', [turnId])).length).toBe(0);
      expect((await platformDb.query('SELECT id FROM platform_archives WHERE campaign_id = ?', [campaignId])).length).toBe(0);
      expect((await platformDb.query('SELECT id FROM platform_turns WHERE campaign_id = ? AND number = 2', [campaignId])).length).toBe(0);
      const events = await platformDb.query<{ event_type: string }>('SELECT event_type FROM platform_outbox_events WHERE campaign_id = ?', [campaignId]);
      expect(events.map((e) => e.event_type)).toContain('ai.preview.failed');
      expect(events.map((e) => e.event_type)).not.toContain('turn.resolved');
      const runRow = await platformDb.query<{ status: string; error_code: string | null }>(
        'SELECT status, error_code FROM platform_ai_runs WHERE turn_id = ?', [turnId],
      );
      expect(runRow).toHaveLength(1);
      expect(runRow[0].status).toBe('failed');
      expect(runRow[0].error_code).toBe('AI_OUTPUT_INVALID');
    } finally {
      await server.close();
    }
  });

  it('keeps domain-invalid Provider values out of HTTP and persistence while exposing safe Owner diagnostics', async () => {
    const providerValue = `not-a-member-${'secret'.repeat(100)}`;
    const server = await startTestPlatformServer({
      aiProvider: new ScriptedAiProvider(scriptedResolution({
        publicNarrative: '雨停了。',
        privateUpdates: [{ playerId: providerValue, content: `私密正文-${providerValue}` }],
      })),
    });
    try {
      const { baseUrl, platformDb } = server;
      const { owner, playerA, playerB, campaignId } = await makeFullCampaign(baseUrl);
      const { turnId, aiBase } = await lockTurn(baseUrl, campaignId, owner, playerA, playerB);

      const invalidRes = await fetch(`${aiBase}/turns/${turnId}/runs`, {
        method: 'POST', headers: jsonHeaders(owner.cookieJar.header()),
        body: JSON.stringify({ idempotencyKey: 'invalid-domain-value' }),
      });
      expect(invalidRes.status).toBe(422);
      const invalidText = await invalidRes.text();
      expect(JSON.parse(invalidText)).toEqual({
        error: { code: 'AI_OUTPUT_INVALID', message: 'AI 输出不符合结构化结算契约。' },
      });
      expect(invalidText).not.toContain(providerValue);

      const runs = await platformDb.query<{ id: string; error_json: string | null; raw_debug_json: string | null }>(
        'SELECT id, error_json, raw_debug_json FROM platform_ai_runs WHERE turn_id = ?', [turnId],
      );
      expect(JSON.stringify(runs)).not.toContain(providerValue);
      expect(JSON.parse(runs[0].raw_debug_json as string)).toMatchObject({
        diagnostic: {
          kind: 'turn_resolution_domain_validation',
          issues: [{ path: ['privateUpdates', 0, 'playerId'], code: 'not_campaign_member' }],
        },
      });

      const ownerDetail = await fetch(`${aiBase}/runs/${runs[0].id}`, { headers: { cookie: owner.cookieJar.header() } });
      expect(ownerDetail.status).toBe(200);
      expect(await ownerDetail.json()).toMatchObject({
        run: { rawDebug: { diagnostic: { kind: 'turn_resolution_domain_validation' } } },
      });
      const playerDetail = await fetch(`${aiBase}/runs/${runs[0].id}`, { headers: { cookie: playerA.cookieJar.header() } });
      expect(playerDetail.status).toBe(403);
      expect(await playerDetail.text()).not.toContain('rawDebug');
    } finally {
      await server.close();
    }
  });
});
