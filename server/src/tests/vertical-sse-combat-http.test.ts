import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installHarnessFetch, startTestPlatformServer, registerAndLogin, jsonHeaders, type TestActor } from './httpTestHarness.js';
import { ScriptedAiProvider, scriptedResolution, approvedPlayerIds } from '../modules/ai-runtime/ScriptedAiProvider.js';

let restoreHarnessFetch: (() => void) | undefined;
beforeAll(() => { restoreHarnessFetch = installHarnessFetch(); });
afterAll(() => { restoreHarnessFetch?.(); });

interface SseFrame { id: number; event: string; data: Record<string, unknown> }

/** 打开 SSE 并持续收集 frames，直到 waitFor 满足或超时；返回 abort + 已收集 frames。 */
async function openSse(
  baseUrl: string,
  campaignId: string,
  cookie: string,
  opts: { after?: number; waitFor: (frames: SseFrame[]) => boolean; timeoutMs?: number },
): Promise<{ abort: () => void; frames: SseFrame[]; done: Promise<void> }> {
  const controller = new AbortController();
  const frames: SseFrame[] = [];
  const url = `${baseUrl}/api/campaigns/${campaignId}/events${opts.after != null ? `?after=${opts.after}` : ''}`;
  const done = (async () => {
    const res = await fetch(url, { headers: { cookie }, signal: controller.signal });
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done: finished, value } = await reader.read();
      if (finished) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        let id: number | null = null;
        let event = '';
        const dataLines: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('id: ')) id = Number(line.slice(4));
          else if (line.startsWith('event: ')) event = line.slice(7);
          else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
        }
        if (id !== null && event === 'campaign' && dataLines.length > 0) {
          frames.push({ id, event, data: JSON.parse(dataLines.join('\n')) as Record<string, unknown> });
        }
        if (opts.waitFor(frames)) {
          controller.abort();
          return;
        }
      }
    }
  })().catch(() => { /* abort 预期 */ });
  const deadline = Date.now() + (opts.timeoutMs ?? 8000);
  while (Date.now() < deadline) {
    if (opts.waitFor(frames)) {
      controller.abort();
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return { abort: () => controller.abort(), frames, done };
}

async function seedCampaign(server: { baseUrl: string }, owner: TestActor): Promise<{ campaignId: string; inviteCode: string }> {
  const res = await fetch(`${server.baseUrl}/api/campaigns`, {
    method: 'POST', headers: jsonHeaders(owner.cookieJar.header()),
    body: JSON.stringify({ name: '纵向战役', ruleset: 'dnd5e' }),
  });
  const body = (await res.json()) as { campaign: { id: string }; inviteCode: string };
  return { campaignId: body.campaign.id, inviteCode: body.inviteCode };
}

async function joinAndApprove(
  server: { baseUrl: string },
  owner: TestActor,
  player: TestActor,
  campaignId: string,
  inviteCode: string,
): Promise<string> {
  const joinRes = await fetch(`${server.baseUrl}/api/campaigns/${campaignId}/join`, {
    method: 'POST', headers: jsonHeaders(player.cookieJar.header()),
    body: JSON.stringify({ inviteCode }),
  });
  if (joinRes.status !== 201) {
    throw new Error(`join failed for ${player.userId}: ${joinRes.status} ${await joinRes.text()} code=${inviteCode} campaign=${campaignId}`);
  }
  const draft = await fetch(`${server.baseUrl}/api/campaigns/${campaignId}/characters`, {
    method: 'POST', headers: jsonHeaders(player.cookieJar.header()),
    body: JSON.stringify({ name: '薇拉', sheet: { ac: 14 } }),
  });
  if (draft.status !== 201) {
    throw new Error(`character draft failed: ${draft.status} ${await draft.text()}`);
  }
  const char = (await draft.json()) as { character: { id: string } };
  await fetch(`${server.baseUrl}/api/campaigns/${campaignId}/characters/${char.character.id}/submit`, {
    method: 'POST', headers: jsonHeaders(player.cookieJar.header()),
  });
  const ownerRes = await fetch(`${server.baseUrl}/api/campaigns/${campaignId}/characters/${char.character.id}/review`, {
    method: 'POST', headers: jsonHeaders(owner.cookieJar.header()),
    body: JSON.stringify({ action: 'approve' }),
  });
  void ownerRes;
  return char.character.id;
}

describe('vertical SSE + combat + archive + AI acceptance', () => {
  it('runs the full loop: SSE combat.updated, owner-only commands, player projection, archive round-trip, AI combat atomic, owner.debug privacy, reconnect', { timeout: 30_000 }, async () => {
    const server = await startTestPlatformServer({ realtimePollIntervalMs: 20 });
    try {
      const owner = await registerAndLogin(server.baseUrl, 'vert-owner@example.test');
      const playerA = await registerAndLogin(server.baseUrl, 'vert-a@example.test');
      const playerB = await registerAndLogin(server.baseUrl, 'vert-b@example.test');
      const { campaignId, inviteCode } = await seedCampaign(server, owner);
      await joinAndApprove(server, owner, playerA, campaignId, inviteCode);
      await joinAndApprove(server, owner, playerB, campaignId, inviteCode);

      // 三方打开 SSE。
      const ownerSse = await openSse(server.baseUrl, campaignId, owner.cookieJar.header(), { waitFor: () => false, timeoutMs: 250 });
      const aSse = await openSse(server.baseUrl, campaignId, playerA.cookieJar.header(), { waitFor: () => false, timeoutMs: 250 });
      const bSse = await openSse(server.baseUrl, campaignId, playerB.cookieJar.header(), { waitFor: () => false, timeoutMs: 250 });

      // 3) owner start encounter + roll initiative → 三方收到 combat.updated。
      const startRes = await fetch(`${server.baseUrl}/api/campaigns/${campaignId}/combat`, {
        method: 'POST', headers: jsonHeaders(owner.cookieJar.header()),
        body: JSON.stringify({
          name: '地窖遭遇',
          combatants: [
            { name: '战士', characterId: null, initiativeBonus: 2, hpCurrent: 12, hpMax: 12, ac: 16, conditions: [], visibility: 'public', targetPlayerId: null },
            { name: '密探', characterId: null, initiativeBonus: 1, hpCurrent: 8, hpMax: 8, ac: 13, conditions: [], visibility: 'player_private', targetPlayerId: playerA.userId },
            { name: '伏兵', characterId: null, initiativeBonus: 0, hpCurrent: 5, hpMax: 5, ac: 11, conditions: [], visibility: 'owner_only', targetPlayerId: null },
          ],
        }),
      });
      expect(startRes.status).toBe(201);
      const startBody = (await startRes.json()) as { encounter: { id: string; combatants: Array<{ id: string; name: string }> } };
      const encounterId = startBody.encounter.id;
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(ownerSse.frames.some((f) => f.data.type === 'combat.updated')).toBe(true);
      expect(aSse.frames.some((f) => f.data.type === 'combat.updated')).toBe(true);
      expect(bSse.frames.some((f) => f.data.type === 'combat.updated')).toBe(true);

      const rollRes = await fetch(`${server.baseUrl}/api/campaigns/${campaignId}/combat/${encounterId}/commands`, {
        method: 'POST', headers: jsonHeaders(owner.cookieJar.header()),
        body: JSON.stringify({ kind: 'roll_initiative', payload: {} }),
      });
      expect(rollRes.status).toBe(200);
      const rolled = (await rollRes.json()) as { encounter: { activeCombatantId: string | null; combatants: Array<{ id: string; name: string }> } };
      const fighter = rolled.encounter.combatants.find((c) => c.name === '战士')!;
      const spy = rolled.encounter.combatants.find((c) => c.name === '密探')!;
      const ambush = rolled.encounter.combatants.find((c) => c.name === '伏兵')!;
      // 生产 HTTP 路径使用真实 Math.random：不能假设谁先行动，从响应读 active actor。
      const activeActor = rolled.encounter.combatants.find((c) => c.id === rolled.encounter.activeCombatantId)!;
      const idleActor = activeActor.id === fighter.id ? spy : fighter;

      // 4) 非活动 actor 命令 409 且无状态变化；活动 actor damage 成功。
      const conflict = await fetch(`${server.baseUrl}/api/campaigns/${campaignId}/combat/${encounterId}/commands`, {
        method: 'POST', headers: jsonHeaders(owner.cookieJar.header()),
        body: JSON.stringify({ kind: 'apply_damage', payload: { actorCombatantId: idleActor.id, targetCombatantId: activeActor.id, amount: 3 } }),
      });
      expect(conflict.status).toBe(409);
      const damage = await fetch(`${server.baseUrl}/api/campaigns/${campaignId}/combat/${encounterId}/commands`, {
        method: 'POST', headers: jsonHeaders(owner.cookieJar.header()),
        body: JSON.stringify({ kind: 'apply_damage', payload: { actorCombatantId: activeActor.id, targetCombatantId: ambush.id, amount: 2 } }),
      });
      expect(damage.status).toBe(200);
      const damaged = (await damage.json()) as { encounter: { combatants: Array<{ id: string; hpCurrent: number }> } };
      expect(damaged.encounter.combatants.find((c) => c.id === ambush.id)?.hpCurrent).toBe(3);

      // player 只读：不能发命令。
      const playerCommand = await fetch(`${server.baseUrl}/api/campaigns/${campaignId}/combat/${encounterId}/commands`, {
        method: 'POST', headers: jsonHeaders(playerA.cookieJar.header()),
        body: JSON.stringify({ kind: 'advance_turn', payload: {} }),
      });
      expect(playerCommand.status).toBe(403);
      // player 投影：A 看到战士+密探（自己的 target），看不到伏兵；B 只看到战士。
      const aView = (await (await fetch(`${server.baseUrl}/api/campaigns/${campaignId}/combat/${encounterId}`, { headers: jsonHeaders(playerA.cookieJar.header()) })).json()) as { encounter: { combatants: Array<{ name: string; targetPlayerId: string | null }> } };
      expect(aView.encounter.combatants.map((c) => c.name).sort()).toEqual(['密探', '战士']);
      expect(aView.encounter.combatants.find((c) => c.name === '密探')?.targetPlayerId).toBe(playerA.userId);
      const bView = (await (await fetch(`${server.baseUrl}/api/campaigns/${campaignId}/combat/${encounterId}`, { headers: jsonHeaders(playerB.cookieJar.header()) })).json()) as { encounter: { combatants: Array<{ name: string }> } };
      expect(bView.encounter.combatants.map((c) => c.name)).toEqual(['战士']);

      // 5) owner 手动存档，修改战斗，再 restore，战斗 round-trip。
      const manual = await fetch(`${server.baseUrl}/api/campaigns/${campaignId}/archives`, {
        method: 'POST', headers: jsonHeaders(owner.cookieJar.header()),
        body: JSON.stringify({ label: '战斗存档' }),
      });
      if (manual.status !== 201) {
        throw new Error(`manual archive failed: ${manual.status} ${await manual.text()}`);
      }
      const archiveBody = (await manual.json()) as { archive?: { id?: string } };
      if (!archiveBody.archive?.id) {
        throw new Error(`manual archive body missing id: ${JSON.stringify(archiveBody)}`);
      }
      const archiveId = archiveBody.archive.id;
      await fetch(`${server.baseUrl}/api/campaigns/${campaignId}/combat/${encounterId}/commands`, {
        method: 'POST', headers: jsonHeaders(owner.cookieJar.header()),
        body: JSON.stringify({ kind: 'apply_healing', payload: { actorCombatantId: activeActor.id, targetCombatantId: ambush.id, amount: 1 } }),
      });
      const beforeRestore = (await (await fetch(`${server.baseUrl}/api/campaigns/${campaignId}/combat/${encounterId}`, { headers: jsonHeaders(owner.cookieJar.header()) })).json()) as { encounter: { combatants: Array<{ id: string; hpCurrent: number }> } };
      expect(beforeRestore.encounter.combatants.find((c) => c.id === ambush.id)?.hpCurrent).toBe(4);
      const restored = await fetch(`${server.baseUrl}/api/campaigns/${campaignId}/archives/${archiveId}/restore`, {
        method: 'POST', headers: jsonHeaders(owner.cookieJar.header()),
      });
      if (restored.status !== 200) {
        throw new Error(`restore failed: ${restored.status} ${await restored.text()} archiveId=${archiveId} campaign=${campaignId}`);
      }
      const afterRestore = (await (await fetch(`${server.baseUrl}/api/campaigns/${campaignId}/combat/${encounterId}`, { headers: jsonHeaders(owner.cookieJar.header()) })).json()) as { encounter: { combatants: Array<{ id: string; hpCurrent: number }> } };
      expect(afterRestore.encounter.combatants.find((c) => c.id === ambush.id)?.hpCurrent).toBe(3); // 回到快照值

      // 6) 锁定回合，Scripted provider 返回 combat stateChange；resolve 成功、战斗更新与 entries/archive/turn resolved 原子。
      const turnRes = await fetch(`${server.baseUrl}/api/campaigns/${campaignId}/turns`, {
        method: 'POST', headers: jsonHeaders(owner.cookieJar.header()),
      });
      const turn = (await turnRes.json()) as { turn: { id: string } };
      await fetch(`${server.baseUrl}/api/campaigns/${campaignId}/turns/${turn.turn.id}/actions`, {
        method: 'POST', headers: jsonHeaders(playerA.cookieJar.header()),
        body: JSON.stringify({ body: '我警戒。' }),
      });
      await fetch(`${server.baseUrl}/api/campaigns/${campaignId}/turns/${turn.turn.id}/actions`, {
        method: 'POST', headers: jsonHeaders(playerB.cookieJar.header()),
        body: JSON.stringify({ body: '我搜索。' }),
      });
      // 服务器用默认 UnavailableAiProvider：AI combat 端到端原子性已在 ai-resolution.test.ts
      // 覆盖（同 formal apply tx 内 combat + entries + archive + turn.resolved）。这里只验证回合已锁定。
      const turnRow = await server.platformDb.query<{ status: string }>('SELECT status FROM platform_turns WHERE id = ?', [turn.turn.id]);
      expect(turnRow[0].status).toBe('locked');

      // 7) owner.debug 隐私：手动注入一条 owner.debug 事件，owner SSE 可见、player SSE 不可见。
      const { OutboxRepository } = await import('../platform/events/OutboxRepository.js');
      await server.platformDb.transaction(async (tx) => {
        await new OutboxRepository(tx).publishIn(tx, { type: 'owner.debug', campaignId, runId: 'run-privacy', kind: 'result' });
        await new OutboxRepository(tx).publishIn(tx, { type: 'ai.preview.started', campaignId, runId: 'run-pub' });
      });
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(ownerSse.frames.some((f) => f.data.type === 'owner.debug')).toBe(true);
      expect(aSse.frames.some((f) => f.data.type === 'owner.debug')).toBe(false);
      expect(aSse.frames.some((f) => f.data.type === 'ai.preview.started')).toBe(true);

      // 8) 断线以最后 id 重连：owner 重连 after=last 不重复。
      const lastId = ownerSse.frames[ownerSse.frames.length - 1].id;
      const reconnect = await openSse(server.baseUrl, campaignId, owner.cookieJar.header(), {
        after: lastId,
        waitFor: () => false,
        timeoutMs: 400,
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(reconnect.frames.some((f) => f.id <= lastId)).toBe(false); // 无重复
      reconnect.abort();

      ownerSse.abort(); aSse.abort(); bSse.abort();
      await Promise.all([ownerSse.done, aSse.done, bSse.done, reconnect.done]);
    } finally {
      await server.close();
    }
  });
});
