import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { installHarnessFetch, jsonHeaders, registerAndLogin, startTestPlatformServer } from './httpTestHarness.js';
import { ScriptedAiProvider, scriptedResolution, approvedPlayerIds } from '../modules/ai-runtime/ScriptedAiProvider.js';
import { UnavailableAiProvider } from '../modules/ai-runtime/UnavailableAiProvider.js';
import { removeNarrativeRoundForLegacyTurn } from './legacyNarrativeFixture.js';

let restoreHarnessFetch: (() => void) | undefined;
beforeAll(() => { restoreHarnessFetch = installHarnessFetch(); });
afterAll(() => { restoreHarnessFetch?.(); });

interface Actor { userId: string; cookieJar: import('./httpTestHarness.js').TestCookieJar; }

async function createCharacter(charsBase: string, actor: Actor, name: string): Promise<string> {
  const createRes = await fetch(`${charsBase}`, { method: 'POST', headers: jsonHeaders(actor.cookieJar.header()), body: JSON.stringify({ name, sheet: { ac: 14 } }) });
  expect(createRes.status).toBe(201);
  const body = (await createRes.json()) as { character: { id: string } };
  const submitRes = await fetch(`${charsBase}/${body.character.id}/submit`, { method: 'POST', headers: jsonHeaders(actor.cookieJar.header()) });
  expect(submitRes.status).toBe(200);
  return body.character.id;
}

describe('HTTP ai routes', () => {
  it('resolves a locked turn via HTTP, projects entries per player, and keeps runs owner-only', async () => {
    const server = await startTestPlatformServer({
      aiProvider: new ScriptedAiProvider(async (prompt, hooks) => {
        const [pa, pb] = approvedPlayerIds(prompt);
        return {
          publicNarrative: '雨停了，队伍继续前进。',
          privateUpdates: [
            { playerId: pa, content: '你发现暗门。' },
            { playerId: pb, content: '你听见脚步。' },
          ],
          // Dice are resolved by the server, never authored by the Provider.
          diceResults: [],
          stateChanges: [],
          interactionRequests: [],
        };
      }),
    });
    try {
      const { baseUrl, platformDb } = server;
      const owner = await registerAndLogin(baseUrl, 'owner@example.test');
      const playerA = await registerAndLogin(baseUrl, 'a@example.test');
      const playerB = await registerAndLogin(baseUrl, 'b@example.test');
      const createRes = await fetch(`${baseUrl}/api/campaigns`, { method: 'POST', headers: jsonHeaders(owner.cookieJar.header()), body: JSON.stringify({ name: '矿坑', ruleset: 'dnd5e' }) });
      expect(createRes.status).toBe(201);
      const createBody = (await createRes.json()) as { campaign: { id: string }; inviteCode: string };
      for (const actor of [playerA, playerB]) {
        const joinRes = await fetch(`${baseUrl}/api/campaigns/${createBody.campaign.id}/join`, { method: 'POST', headers: jsonHeaders(actor.cookieJar.header()), body: JSON.stringify({ inviteCode: createBody.inviteCode }) });
        expect(joinRes.status).toBe(201);
      }
      const charsBase = `${baseUrl}/api/campaigns/${createBody.campaign.id}/characters`;
      for (const [actor, name] of [[playerA, '薇拉'], [playerB, '卡恩']] as const) {
        const id = await createCharacter(charsBase, actor, name);
        const review = await fetch(`${charsBase}/${id}/review`, { method: 'POST', headers: jsonHeaders(owner.cookieJar.header()), body: JSON.stringify({ action: 'approve' }) });
        expect(review.status).toBe(200);
      }
      const turnsBase = `${baseUrl}/api/campaigns/${createBody.campaign.id}/turns`;
      const startRes = await fetch(`${turnsBase}`, { method: 'POST', headers: jsonHeaders(owner.cookieJar.header()) });
      const turn = (await startRes.json()) as { turn: { id: string } };
      const submit = async (actor: Actor, body: string) => {
        const res = await fetch(`${turnsBase}/${turn.turn.id}/actions`, { method: 'POST', headers: jsonHeaders(actor.cookieJar.header()), body: JSON.stringify({ body }) });
        expect(res.status).toBe(200);
      };
      await submit(playerA, '搜索房间');
      await submit(playerB, '警戒门口');
      // This test exercises the historical whole-turn adapter explicitly.
      // Live Turns with NarrativeRound must use decision-scoped resolution.
      await removeNarrativeRoundForLegacyTurn(platformDb, turn.turn.id);
      const aiBase = `${baseUrl}/api/campaigns/${createBody.campaign.id}/ai`;

      const providerStatus = await fetch(`${aiBase}/provider-status`, { headers: { cookie: owner.cookieJar.header() } });
      expect(providerStatus.status).toBe(200);
      const providerStatusBody = (await providerStatus.json()) as { provider: { provider: string; baseUrl: string; model: string; configured: boolean; apiKey?: string } };
      expect(providerStatusBody.provider).toEqual({
        provider: 'scripted', baseUrl: '', model: 'scripted', configured: false,
        apiKeyConfigured: false, source: 'injected',
      });
      expect(providerStatusBody.provider.apiKey).toBeUndefined();
      const playerProviderStatus = await fetch(`${aiBase}/provider-status`, { headers: { cookie: playerA.cookieJar.header() } });
      expect(playerProviderStatus.status).toBe(403);

      const emptyRuns = await fetch(`${aiBase}/runs`, { headers: { cookie: owner.cookieJar.header() } });
      expect(emptyRuns.status).toBe(200);
      expect(((await emptyRuns.json()) as { runs: unknown[] }).runs).toEqual([]);
      const playerRuns = await fetch(`${aiBase}/runs`, { headers: { cookie: playerA.cookieJar.header() } });
      expect(playerRuns.status).toBe(403);

      // player 不能 resolve（owner-only）。
      const playerResolve = await fetch(`${aiBase}/turns/${turn.turn.id}/runs`, { method: 'POST', headers: jsonHeaders(playerA.cookieJar.header()), body: JSON.stringify({ idempotencyKey: 'k1' }) });
      expect(playerResolve.status).toBe(403);

      const resolveRes = await fetch(`${aiBase}/turns/${turn.turn.id}/runs`, { method: 'POST', headers: jsonHeaders(owner.cookieJar.header()), body: JSON.stringify({ idempotencyKey: 'k1' }) });
      expect(resolveRes.status).toBe(201); // 新 run → 201
      const resolveBody = (await resolveRes.json()) as { run: { id: string; status: string } };
      expect(resolveBody.run.status).toBe('succeeded');

      // 同 key 幂等 replay → 200，返回同一 run，不重复调用 provider / 写 entries。
      const replayRes = await fetch(`${aiBase}/turns/${turn.turn.id}/runs`, { method: 'POST', headers: jsonHeaders(owner.cookieJar.header()), body: JSON.stringify({ idempotencyKey: 'k1' }) });
      expect(replayRes.status).toBe(200);
      const replayBody = (await replayRes.json()) as { run: { id: string } };
      expect(replayBody.run.id).toBe(resolveBody.run.id);

      // 自动存档 + 下一回合。
      const archives = await platformDb.query<{ kind: string }>('SELECT kind FROM platform_archives WHERE campaign_id = ?', [createBody.campaign.id]);
      expect(archives).toEqual([{ kind: 'automatic' }]);
      const nextTurn = await platformDb.query<{ number: number; status: string }>('SELECT number, status FROM platform_turns WHERE campaign_id = ? AND number = 2', [createBody.campaign.id]);
      expect(nextTurn).toEqual([{ number: 2, status: 'waiting_for_actions' }]);

      // entries 投影：A 只见 public + 自己的 private_update；B 只见 public + 自己的 private_update。
      const aEntries = (await (await fetch(`${aiBase}/turns/${turn.turn.id}/entries`, { headers: { cookie: playerA.cookieJar.header() } })).json()) as { entries: Array<{ entryKind: string; visibility: string; targetPlayerId: string | null }> };
      expect(aEntries.entries.filter((e) => e.visibility === 'player_private')).toHaveLength(1);
      const bText = JSON.stringify(await (await fetch(`${aiBase}/turns/${turn.turn.id}/entries`, { headers: { cookie: playerB.cookieJar.header() } })).json());
      expect(bText).not.toContain('暗门');
      expect(bText).toContain('脚步');

      const ownerRuns = await fetch(`${aiBase}/runs`, { headers: { cookie: owner.cookieJar.header() } });
      expect(ownerRuns.status).toBe(200);
      const ownerRunsBody = (await ownerRuns.json()) as { runs: Array<{ id: string; turnId: string; superseded: boolean; errorCode: string | null }> };
      expect(ownerRunsBody.runs.some((run) => run.id === resolveBody.run.id && run.turnId === turn.turn.id && run.errorCode === null)).toBe(true);
      expect(ownerRunsBody.runs).toHaveLength(1);

      // run 详情 owner 可读 context/result；player 不可读（FORBIDDEN）。
      const detail = await fetch(`${aiBase}/runs/${resolveBody.run.id}`, { headers: { cookie: owner.cookieJar.header() } });
      expect(detail.status).toBe(200);
      const playerDetail = await fetch(`${aiBase}/runs/${resolveBody.run.id}`, { headers: { cookie: playerA.cookieJar.header() } });
      expect(playerDetail.status).toBe(403);

      // 存档路由：owner 手动存档 + player 恢复拒绝。
      const archivesBase = `${baseUrl}/api/campaigns/${createBody.campaign.id}/archives`;
      const manual = await fetch(`${archivesBase}`, { method: 'POST', headers: jsonHeaders(owner.cookieJar.header()), body: JSON.stringify({ label: '手动' }) });
      expect(manual.status).toBe(201);
      const manualBody = (await manual.json()) as { archive: { id: string } };
      const playerRestore = await fetch(`${archivesBase}/${manualBody.archive.id}/restore`, { method: 'POST', headers: jsonHeaders(playerA.cookieJar.header()) });
      expect(playerRestore.status).toBe(403);
    } finally {
      await server.close();
    }
  });

  it('uses a newly saved WebUI provider for the next AI run without restarting the server', async () => {
    const dynamicProvider = new ScriptedAiProvider(scriptedResolution({
      publicNarrative: '动态配置已经生效。', privateUpdates: [], diceResults: [], stateChanges: [], interactionRequests: [],
    }));
    const server = await startTestPlatformServer({
      aiProvider: new UnavailableAiProvider(),
      configuredAiProviderFactory: () => dynamicProvider,
    });
    try {
      const owner = await registerAndLogin(server.baseUrl, 'dynamic-owner@example.test');
      const createRes = await fetch(`${server.baseUrl}/api/campaigns`, {
        method: 'POST', headers: jsonHeaders(owner.cookieJar.header()),
        body: JSON.stringify({ name: '即时切换战役', ruleset: 'dnd5e' }),
      });
      const campaignId = ((await createRes.json()) as { campaign: { id: string } }).campaign.id;
      const now = new Date().toISOString();
      const turnId = 'dynamic-provider-turn';
      // 直接插入 locked 回合，聚焦 Provider 动态切换 seam（回合/角色流程由既有验收覆盖）。
      await server.platformDb.execute(
        "INSERT INTO platform_turns (id, campaign_id, number, status, locked_at, completed_at, created_at, updated_at) VALUES (?, ?, 1, 'locked', ?, NULL, ?, ?)",
        [turnId, campaignId, now, now, now],
      );
      const aiBase = `${server.baseUrl}/api/campaigns/${campaignId}/ai`;
      const saveRes = await fetch(`${aiBase}/provider-config`, {
        method: 'PUT', headers: jsonHeaders(owner.cookieJar.header()),
        body: JSON.stringify({ provider: 'openai-compatible', baseUrl: 'https://dynamic.example/v1', model: 'dynamic-model', apiKey: 'sk-dynamic' }),
      });
      expect(saveRes.status).toBe(200);

      const resolveRes = await fetch(`${aiBase}/turns/${turnId}/runs`, {
        method: 'POST', headers: jsonHeaders(owner.cookieJar.header()), body: JSON.stringify({ idempotencyKey: 'dynamic-run-1' }),
      });
      expect(resolveRes.status).toBe(201);
      const run = ((await resolveRes.json()) as { run: { provider: string; model: string; status: string } }).run;
      expect(run).toMatchObject({ provider: 'scripted', model: 'scripted', status: 'succeeded' });
      const credentialRows = await server.platformDb.query<{ encrypted_api_key: string }>(
        'SELECT encrypted_api_key FROM platform_ai_provider_configs WHERE campaign_id = ?',
        [campaignId],
      );
      expect(credentialRows).toHaveLength(1);
      expect(credentialRows[0].encrypted_api_key).not.toContain('sk-dynamic');
      const runRows = await server.platformDb.query<{ context_json: string; result_json: string | null; raw_debug_json: string | null; error_json: string | null }>(
        'SELECT context_json, result_json, raw_debug_json, error_json FROM platform_ai_runs WHERE campaign_id = ?',
        [campaignId],
      );
      expect(JSON.stringify(runRows)).not.toContain('sk-dynamic');
      const entries = await fetch(`${aiBase}/turns/${turnId}/entries`, { headers: { cookie: owner.cookieJar.header() } });
      expect(await entries.text()).toContain('动态配置已经生效');
    } finally {
      await server.close();
    }
  });

  it('lets only the owner test and save an encrypted provider configuration without ever echoing the API key', async () => {
    const apiKey = 'sk-browser-secret-never-echo';
    const providerFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const server = await startTestPlatformServer({
      aiProvider: new UnavailableAiProvider(),
      providerFetch,
    });
    try {
      const owner = await registerAndLogin(server.baseUrl, 'config-owner@example.test');
      const player = await registerAndLogin(server.baseUrl, 'config-player@example.test');
      const createRes = await fetch(`${server.baseUrl}/api/campaigns`, {
        method: 'POST', headers: jsonHeaders(owner.cookieJar.header()),
        body: JSON.stringify({ name: '接口配置战役', ruleset: 'dnd5e' }),
      });
      const created = (await createRes.json()) as { campaign: { id: string }; inviteCode: string };
      await fetch(`${server.baseUrl}/api/campaigns/${created.campaign.id}/join`, {
        method: 'POST', headers: jsonHeaders(player.cookieJar.header()), body: JSON.stringify({ inviteCode: created.inviteCode }),
      });
      const aiBase = `${server.baseUrl}/api/campaigns/${created.campaign.id}/ai`;
      const input = { provider: 'openai-compatible', baseUrl: 'https://newapi.uwoacrimson.com/v1', model: 'gpt-test', apiKey };

      const playerSave = await fetch(`${aiBase}/provider-config`, {
        method: 'PUT', headers: jsonHeaders(player.cookieJar.header()), body: JSON.stringify(input),
      });
      expect(playerSave.status).toBe(403);
      const playerTest = await fetch(`${aiBase}/provider-config/test`, {
        method: 'POST', headers: jsonHeaders(player.cookieJar.header()), body: JSON.stringify(input),
      });
      expect(playerTest.status).toBe(403);

      const testRes = await fetch(`${aiBase}/provider-config/test`, {
        method: 'POST', headers: jsonHeaders(owner.cookieJar.header()), body: JSON.stringify(input),
      });
      expect(testRes.status).toBe(200);
      const testText = await testRes.text();
      expect(testText).not.toContain(apiKey);
      expect(JSON.parse(testText)).toEqual({ ok: true });

      const saveRes = await fetch(`${aiBase}/provider-config`, {
        method: 'PUT', headers: jsonHeaders(owner.cookieJar.header()), body: JSON.stringify(input),
      });
      expect(saveRes.status).toBe(200);
      const saveText = await saveRes.text();
      expect(saveText).not.toContain(apiKey);
      expect(JSON.parse(saveText)).toEqual({
        provider: {
          provider: 'openai-compatible', baseUrl: input.baseUrl, model: input.model,
          configured: true, apiKeyConfigured: true, source: 'campaign',
        },
      });

      const rows = await server.platformDb.query<{ encrypted_api_key: string }>(
        'SELECT encrypted_api_key FROM platform_ai_provider_configs WHERE campaign_id = ?',
        [created.campaign.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].encrypted_api_key).not.toContain(apiKey);

      const status = await fetch(`${aiBase}/provider-status`, { headers: { cookie: owner.cookieJar.header() } });
      const statusText = await status.text();
      expect(statusText).not.toContain(apiKey);
      expect(JSON.parse(statusText)).toEqual({
        provider: {
          provider: 'openai-compatible', baseUrl: input.baseUrl, model: input.model,
          configured: true, apiKeyConfigured: true, source: 'campaign',
        },
      });

      expect(providerFetch).toHaveBeenCalledTimes(1);
      const testRequest = providerFetch.mock.calls[0];
      expect(String(testRequest[0])).toBe('https://newapi.uwoacrimson.com/v1/chat/completions');
      expect((testRequest[1]?.headers as Record<string, string>).authorization).toBe(`Bearer ${apiKey}`);
    } finally {
      await server.close();
    }
  });

  it('keeps saved API keys write-only by reusing the stored key when an empty key is submitted', async () => {
    const firstKey = 'sk-first-write-only';
    const providerFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const server = await startTestPlatformServer({
      providerFetch,
    });
    try {
      const owner = await registerAndLogin(server.baseUrl, 'write-only-owner@example.test');
      const createRes = await fetch(`${server.baseUrl}/api/campaigns`, {
        method: 'POST', headers: jsonHeaders(owner.cookieJar.header()),
        body: JSON.stringify({ name: '写入密钥战役', ruleset: 'dnd5e' }),
      });
      const campaignId = ((await createRes.json()) as { campaign: { id: string } }).campaign.id;
      const aiBase = `${server.baseUrl}/api/campaigns/${campaignId}/ai`;
      const save = (body: unknown) => fetch(`${aiBase}/provider-config`, {
        method: 'PUT', headers: jsonHeaders(owner.cookieJar.header()), body: JSON.stringify(body),
      });
      expect((await save({ provider: 'openai-compatible', baseUrl: 'https://one.example/v1', model: 'm1', apiKey: firstKey })).status).toBe(200);
      expect((await save({ provider: 'openai-compatible', baseUrl: 'https://one.example/v1', model: 'm2', apiKey: '' })).status).toBe(200);

      const rejectedEndpointChange = await save({ provider: 'openai-compatible', baseUrl: 'https://two.example/v1', model: 'm2', apiKey: '' });
      expect(rejectedEndpointChange.status).toBe(400);
      expect(await rejectedEndpointChange.text()).toContain('修改 API 地址时必须重新填写 API Key');

      const testRes = await fetch(`${aiBase}/provider-config/test`, {
        method: 'POST', headers: jsonHeaders(owner.cookieJar.header()),
        body: JSON.stringify({ provider: 'openai-compatible', baseUrl: 'https://one.example/v1', model: 'm2', apiKey: '' }),
      });
      expect(testRes.status).toBe(200);
      expect((providerFetch.mock.calls[0][1]?.headers as Record<string, string>).authorization).toBe(`Bearer ${firstKey}`);
    } finally {
      await server.close();
    }
  });

  it('refuses credential persistence when credential encryption is internally unavailable', async () => {
    const server = await startTestPlatformServer({ credentialCipher: null });
    try {
      const owner = await registerAndLogin(server.baseUrl, 'encryption-unavailable-owner@example.test');
      const createRes = await fetch(`${server.baseUrl}/api/campaigns`, {
        method: 'POST', headers: jsonHeaders(owner.cookieJar.header()),
        body: JSON.stringify({ name: '加密不可用战役', ruleset: 'dnd5e' }),
      });
      const campaignId = ((await createRes.json()) as { campaign: { id: string } }).campaign.id;
      const res = await fetch(`${server.baseUrl}/api/campaigns/${campaignId}/ai/provider-config`, {
        method: 'PUT', headers: jsonHeaders(owner.cookieJar.header()),
        body: JSON.stringify({ provider: 'openai-compatible', baseUrl: 'https://x.example/v1', model: 'm', apiKey: 'sk-secret' }),
      });
      expect(res.status).toBe(503);
      const text = await res.text();
      expect(text).not.toContain('sk-secret');
      expect(JSON.parse(text)).toEqual({ error: { code: 'CREDENTIAL_ENCRYPTION_UNAVAILABLE', message: '服务器凭证加密暂不可用。' } });
    } finally {
      await server.close();
    }
  });

  it('rejects cross-campaign ai runs/entries access with NOT_FOUND', async () => {
    const server = await startTestPlatformServer({
      aiProvider: new ScriptedAiProvider(scriptedResolution({ publicNarrative: 'x', privateUpdates: [], diceResults: [], stateChanges: [], interactionRequests: [] })),
    });
    try {
      const { baseUrl, platformDb } = server;
      const ownerA = await registerAndLogin(baseUrl, 'ownerA@example.test');
      const ownerB = await registerAndLogin(baseUrl, 'ownerB@example.test');
      const createCampaign = async (name: string, cookieHeader: string) => {
        const res = await fetch(`${baseUrl}/api/campaigns`, { method: 'POST', headers: jsonHeaders(cookieHeader), body: JSON.stringify({ name, ruleset: 'dnd5e' }) });
        expect(res.status).toBe(201);
        return ((await res.json()) as { campaign: { id: string } }).campaign.id;
      };
      const campA = await createCampaign('A', ownerA.cookieJar.header());
      const campB = await createCampaign('B', ownerB.cookieJar.header());
      // A 的一个真实回合（直接插入满足 FK 与 turn 路由归属校验），ownerB 通过 B 的 campaign URL 访问 → 必须 NOT_FOUND。
      const now = new Date().toISOString();
      const turnId = 'cross-turn-1';
      await platformDb.execute(
        "INSERT INTO platform_turns (id, campaign_id, number, status, locked_at, completed_at, created_at, updated_at) VALUES (?, ?, 1, 'locked', ?, NULL, ?, ?)",
        [turnId, campA, now, now, now],
      );
      const aiBaseB = `${baseUrl}/api/campaigns/${campB}/ai`;
      const entriesRes = await fetch(`${aiBaseB}/turns/${turnId}/entries`, { headers: { cookie: ownerB.cookieJar.header() } });
      expect(entriesRes.status).toBe(404);
      const runsRes = await fetch(`${aiBaseB}/turns/${turnId}/runs`, { headers: { cookie: ownerB.cookieJar.header() } });
      expect(runsRes.status).toBe(404);
      // 同 campaign 的 owner 也能读取；B 的 URL 仍然 404（不因 owner 而绕过 campaign 边界）。
      const aiBaseA = `${baseUrl}/api/campaigns/${campA}/ai`;
      const selfRuns = await fetch(`${aiBaseA}/turns/${turnId}/runs`, { headers: { cookie: ownerA.cookieJar.header() } });
      expect(selfRuns.status).toBe(200);
    } finally {
      await server.close();
    }
  });
});
