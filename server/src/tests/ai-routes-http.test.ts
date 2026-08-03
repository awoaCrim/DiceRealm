import { describe, expect, it } from 'vitest';
import { jsonHeaders, registerAndLogin, startPlatformServer } from './httpTestHarness.js';
import { ScriptedAiProvider, scriptedResolution, approvedPlayerIds } from '../modules/ai-runtime/ScriptedAiProvider.js';

interface Actor { userId: string; cookieHeader: string; }

async function createCharacter(charsBase: string, actor: Actor, name: string): Promise<string> {
  const createRes = await fetch(`${charsBase}`, { method: 'POST', headers: jsonHeaders(actor.cookieHeader), body: JSON.stringify({ name, sheet: { ac: 14 } }) });
  expect(createRes.status).toBe(201);
  const body = (await createRes.json()) as { character: { id: string } };
  const submitRes = await fetch(`${charsBase}/${body.character.id}/submit`, { method: 'POST', headers: jsonHeaders(actor.cookieHeader) });
  expect(submitRes.status).toBe(200);
  return body.character.id;
}

describe('HTTP ai routes', () => {
  it('resolves a locked turn via HTTP, projects entries per player, and keeps runs owner-only', async () => {
    const server = await startPlatformServer({
      aiProvider: new ScriptedAiProvider(async (prompt, hooks) => {
        const [pa, pb] = approvedPlayerIds(prompt);
        return {
          publicNarrative: '雨停了，队伍继续前进。',
          privateUpdates: [
            { playerId: pa, content: '你发现暗门。' },
            { playerId: pb, content: '你听见脚步。' },
          ],
          diceResults: [
            { id: 'd1', formula: '1d20+2', total: 17, visibility: 'public', targetPlayerId: null },
            { id: 'd2', formula: '1d20', total: 5, visibility: 'player_private', targetPlayerId: pa },
          ],
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
      const createRes = await fetch(`${baseUrl}/api/campaigns`, { method: 'POST', headers: jsonHeaders(owner.cookieHeader), body: JSON.stringify({ name: '矿坑', ruleset: 'dnd5e' }) });
      expect(createRes.status).toBe(201);
      const createBody = (await createRes.json()) as { campaign: { id: string }; inviteCode: string };
      for (const actor of [playerA, playerB]) {
        const joinRes = await fetch(`${baseUrl}/api/campaigns/${createBody.campaign.id}/join`, { method: 'POST', headers: jsonHeaders(actor.cookieHeader), body: JSON.stringify({ inviteCode: createBody.inviteCode }) });
        expect(joinRes.status).toBe(201);
      }
      const charsBase = `${baseUrl}/api/campaigns/${createBody.campaign.id}/characters`;
      for (const [actor, name] of [[playerA, '薇拉'], [playerB, '卡恩']] as const) {
        const id = await createCharacter(charsBase, actor, name);
        const review = await fetch(`${charsBase}/${id}/review`, { method: 'POST', headers: jsonHeaders(owner.cookieHeader), body: JSON.stringify({ action: 'approve' }) });
        expect(review.status).toBe(200);
      }
      const turnsBase = `${baseUrl}/api/campaigns/${createBody.campaign.id}/turns`;
      const startRes = await fetch(`${turnsBase}`, { method: 'POST', headers: jsonHeaders(owner.cookieHeader) });
      const turn = (await startRes.json()) as { turn: { id: string } };
      const submit = async (actor: Actor, body: string) => {
        const res = await fetch(`${turnsBase}/${turn.turn.id}/actions`, { method: 'POST', headers: jsonHeaders(actor.cookieHeader), body: JSON.stringify({ body }) });
        expect(res.status).toBe(200);
      };
      await submit(playerA, '搜索房间');
      await submit(playerB, '警戒门口');
      const aiBase = `${baseUrl}/api/campaigns/${createBody.campaign.id}/ai`;

      // player 不能 resolve（owner-only）。
      const playerResolve = await fetch(`${aiBase}/turns/${turn.turn.id}/runs`, { method: 'POST', headers: jsonHeaders(playerA.cookieHeader), body: JSON.stringify({ idempotencyKey: 'k1' }) });
      expect(playerResolve.status).toBe(403);

      const resolveRes = await fetch(`${aiBase}/turns/${turn.turn.id}/runs`, { method: 'POST', headers: jsonHeaders(owner.cookieHeader), body: JSON.stringify({ idempotencyKey: 'k1' }) });
      expect(resolveRes.status).toBe(201); // 新 run → 201
      const resolveBody = (await resolveRes.json()) as { run: { id: string; status: string } };
      expect(resolveBody.run.status).toBe('succeeded');

      // 同 key 幂等 replay → 200，返回同一 run，不重复调用 provider / 写 entries。
      const replayRes = await fetch(`${aiBase}/turns/${turn.turn.id}/runs`, { method: 'POST', headers: jsonHeaders(owner.cookieHeader), body: JSON.stringify({ idempotencyKey: 'k1' }) });
      expect(replayRes.status).toBe(200);
      const replayBody = (await replayRes.json()) as { run: { id: string } };
      expect(replayBody.run.id).toBe(resolveBody.run.id);

      // 自动存档 + 下一回合。
      const archives = await platformDb.query<{ kind: string }>('SELECT kind FROM platform_archives WHERE campaign_id = ?', [createBody.campaign.id]);
      expect(archives).toEqual([{ kind: 'automatic' }]);
      const nextTurn = await platformDb.query<{ number: number; status: string }>('SELECT number, status FROM platform_turns WHERE campaign_id = ? AND number = 2', [createBody.campaign.id]);
      expect(nextTurn).toEqual([{ number: 2, status: 'waiting_for_actions' }]);

      // entries 投影：A 只见 public + 自己的 private（private_update + player_private dice 两条）；B 只见 public + 自己的 private。
      const aEntries = (await (await fetch(`${aiBase}/turns/${turn.turn.id}/entries`, { headers: { cookie: playerA.cookieHeader } })).json()) as { entries: Array<{ entryKind: string; visibility: string; targetPlayerId: string | null }> };
      expect(aEntries.entries.filter((e) => e.visibility === 'player_private')).toHaveLength(2);
      const bText = JSON.stringify(await (await fetch(`${aiBase}/turns/${turn.turn.id}/entries`, { headers: { cookie: playerB.cookieHeader } })).json());
      expect(bText).not.toContain('暗门');
      expect(bText).toContain('脚步');

      // run 详情 owner 可读 context/result；player 不可读（FORBIDDEN）。
      const detail = await fetch(`${aiBase}/runs/${resolveBody.run.id}`, { headers: { cookie: owner.cookieHeader } });
      expect(detail.status).toBe(200);
      const playerDetail = await fetch(`${aiBase}/runs/${resolveBody.run.id}`, { headers: { cookie: playerA.cookieHeader } });
      expect(playerDetail.status).toBe(403);

      // 存档路由：owner 手动存档 + player 恢复拒绝。
      const archivesBase = `${baseUrl}/api/campaigns/${createBody.campaign.id}/archives`;
      const manual = await fetch(`${archivesBase}`, { method: 'POST', headers: jsonHeaders(owner.cookieHeader), body: JSON.stringify({ label: '手动' }) });
      expect(manual.status).toBe(201);
      const manualBody = (await manual.json()) as { archive: { id: string } };
      const playerRestore = await fetch(`${archivesBase}/${manualBody.archive.id}/restore`, { method: 'POST', headers: jsonHeaders(playerA.cookieHeader) });
      expect(playerRestore.status).toBe(403);
    } finally {
      await server.close();
    }
  });

  it('rejects cross-campaign ai runs/entries access with NOT_FOUND', async () => {
    const server = await startPlatformServer({
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
      const campA = await createCampaign('A', ownerA.cookieHeader);
      const campB = await createCampaign('B', ownerB.cookieHeader);
      // A 的一个真实回合（直接插入满足 FK 与 turn 路由归属校验），ownerB 通过 B 的 campaign URL 访问 → 必须 NOT_FOUND。
      const now = new Date().toISOString();
      const turnId = 'cross-turn-1';
      await platformDb.execute(
        "INSERT INTO platform_turns (id, campaign_id, number, status, locked_at, completed_at, created_at, updated_at) VALUES (?, ?, 1, 'locked', ?, NULL, ?, ?)",
        [turnId, campA, now, now, now],
      );
      const aiBaseB = `${baseUrl}/api/campaigns/${campB}/ai`;
      const entriesRes = await fetch(`${aiBaseB}/turns/${turnId}/entries`, { headers: { cookie: ownerB.cookieHeader } });
      expect(entriesRes.status).toBe(404);
      const runsRes = await fetch(`${aiBaseB}/turns/${turnId}/runs`, { headers: { cookie: ownerB.cookieHeader } });
      expect(runsRes.status).toBe(404);
      // 同 campaign 的 owner 也能读取；B 的 URL 仍然 404（不因 owner 而绕过 campaign 边界）。
      const aiBaseA = `${baseUrl}/api/campaigns/${campA}/ai`;
      const selfRuns = await fetch(`${aiBaseA}/turns/${turnId}/runs`, { headers: { cookie: ownerA.cookieHeader } });
      expect(selfRuns.status).toBe(200);
    } finally {
      await server.close();
    }
  });
});
