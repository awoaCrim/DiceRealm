import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installHarnessFetch, jsonHeaders, registerAndLogin, startTestPlatformServer } from './httpTestHarness.js';

let restoreHarnessFetch: (() => void) | undefined;
beforeAll(() => { restoreHarnessFetch = installHarnessFetch(); });
afterAll(() => { restoreHarnessFetch?.(); });

interface Actor {
  userId: string;
  cookieJar: import('./httpTestHarness.js').TestCookieJar;
}

async function createCharacter(
  charsBase: string,
  actor: Actor,
  name: string,
  ac: number,
): Promise<string> {
  const createRes = await fetch(`${charsBase}`, {
    method: 'POST',
    headers: jsonHeaders(actor.cookieJar.header()),
    body: JSON.stringify({ name, sheet: { ac } }),
  });
  expect(createRes.status).toBe(201);
  const body = (await createRes.json()) as { character: { id: string } };
  const submitRes = await fetch(`${charsBase}/${body.character.id}/submit`, {
    method: 'POST',
    headers: jsonHeaders(actor.cookieJar.header()),
  });
  expect(submitRes.status).toBe(200);
  return body.character.id;
}

describe('HTTP world + outbox + turns vertical flow', () => {
  it('projects world facts per player, locks the turn after the last submit, and emits ordered outbox events without bodies', async () => {
    const server = await startTestPlatformServer();
    try {
      const { baseUrl, platformDb } = server;
      const owner = await registerAndLogin(baseUrl, 'owner@example.test');
      const playerA = await registerAndLogin(baseUrl, 'a@example.test');
      const playerB = await registerAndLogin(baseUrl, 'b@example.test');

      const createRes = await fetch(`${baseUrl}/api/campaigns`, {
        method: 'POST', headers: jsonHeaders(owner.cookieJar.header()),
        body: JSON.stringify({ name: '失落矿坑', ruleset: 'dnd5e' }),
      });
      expect(createRes.status).toBe(201);
      const createBody = (await createRes.json()) as { campaign: { id: string }; inviteCode: string };

      for (const actor of [playerA, playerB]) {
        const joinRes = await fetch(`${baseUrl}/api/campaigns/${createBody.campaign.id}/join`, {
          method: 'POST', headers: jsonHeaders(actor.cookieJar.header()),
          body: JSON.stringify({ inviteCode: createBody.inviteCode }),
        });
        expect(joinRes.status).toBe(201);
      }

      const charsBase = `${baseUrl}/api/campaigns/${createBody.campaign.id}/characters`;
      const aCharId = await createCharacter(charsBase, playerA, '薇拉', 14);
      const bCharId = await createCharacter(charsBase, playerB, '卡恩', 16);
      for (const charId of [aCharId, bCharId]) {
        const review = await fetch(`${charsBase}/${charId}/review`, {
          method: 'POST', headers: jsonHeaders(owner.cookieJar.header()),
          body: JSON.stringify({ action: 'approve' }),
        });
        expect(review.status).toBe(200);
      }

      // --- world facts：owner 建 public / A-private / B-private / owner-only ---
      const worldBase = `${baseUrl}/api/campaigns/${createBody.campaign.id}/world`;
      const createFact = async (body: Record<string, unknown>) => {
        const res = await fetch(`${worldBase}`, {
          method: 'POST', headers: jsonHeaders(owner.cookieJar.header()), body: JSON.stringify(body),
        });
        expect(res.status).toBe(201);
        return (await res.json()) as { fact: { id: string } };
      };
      await createFact({ title: '酒馆', kind: 'location', content: '热闹。', visibility: 'public' });
      await createFact({ title: 'A 的密信', kind: 'item', content: '给 A。', visibility: 'player_private', knownBy: [playerA.userId] });
      await createFact({ title: 'B 的密信', kind: 'item', content: '给 B。', visibility: 'player_private', knownBy: [playerB.userId] });
      await createFact({ title: '隐秘布局', kind: 'lore', content: '只有你知道。', visibility: 'owner_only' });

      // player 不能写 world：owner-only → FORBIDDEN（契约错误体）。
      const playerCreateFact = await fetch(`${worldBase}`, {
        method: 'POST', headers: jsonHeaders(playerA.cookieJar.header()),
        body: JSON.stringify({ title: '越权', kind: 'lore', content: 'x', visibility: 'public' }),
      });
      expect(playerCreateFact.status).toBe(403);
      const playerCreateFactBody = (await playerCreateFact.json()) as { error: { code: string } };
      expect(playerCreateFactBody.error.code).toBe('FORBIDDEN');

      const aWorld = (await (await fetch(`${worldBase}`, { headers: { cookie: playerA.cookieJar.header() } })).json()) as {
        projection: { facts: Array<{ title: string; knownBy: string[] }> };
      };
      expect(aWorld.projection.facts.map((f) => f.title).sort()).toEqual(['A 的密信', '酒馆']);
      expect(aWorld.projection.facts.every((f) => f.knownBy.length <= 1)).toBe(true);
      expect(JSON.stringify(aWorld)).not.toContain(playerB.userId);

      const bWorld = (await (await fetch(`${worldBase}`, { headers: { cookie: playerB.cookieJar.header() } })).json()) as {
        projection: { facts: Array<{ title: string }> };
      };
      expect(bWorld.projection.facts.map((f) => f.title).sort()).toEqual(['B 的密信', '酒馆']);

      const ownerWorld = (await (await fetch(`${worldBase}`, { headers: { cookie: owner.cookieJar.header() } })).json()) as {
        projection: { facts: Array<{ title: string; knownBy: string[] }> };
      };
      expect(ownerWorld.projection.facts).toHaveLength(4);
      expect(JSON.stringify(ownerWorld.projection.facts)).toContain(playerA.userId);

      // --- turns ---
      const turnsBase = `${baseUrl}/api/campaigns/${createBody.campaign.id}/turns`;
      // player 不能开始回合：owner-only → FORBIDDEN。
      const playerStartTurn = await fetch(`${turnsBase}`, {
        method: 'POST', headers: jsonHeaders(playerA.cookieJar.header()),
      });
      expect(playerStartTurn.status).toBe(403);
      const playerStartBody = (await playerStartTurn.json()) as { error: { code: string } };
      expect(playerStartBody.error.code).toBe('FORBIDDEN');

      const startRes = await fetch(`${turnsBase}`, { method: 'POST', headers: jsonHeaders(owner.cookieJar.header()) });
      expect(startRes.status).toBe(201);
      const startBody = (await startRes.json()) as { turn: { id: string; number: number } };
      const turnId = startBody.turn.id;
      expect(startBody.turn.number).toBe(1);

      const submit = async (actor: Actor, body: string) => {
        const res = await fetch(`${turnsBase}/${turnId}/actions`, {
          method: 'POST', headers: jsonHeaders(actor.cookieJar.header()), body: JSON.stringify({ body }),
        });
        return res;
      };

      const aSubmit = await submit(playerA, '我搜索房间。');
      expect(aSubmit.status).toBe(200);
      const aView = (await aSubmit.json()) as {
        view: { turn: { status: string }; progress: { submittedPlayerIds: string[] } };
      };
      expect(aView.view.turn.status).toBe('waiting_for_actions');
      expect(aView.view.progress.submittedPlayerIds).toEqual([playerA.userId]);

      // A 锁前编辑：不重复发 progress 事件。
      const aEdit = await submit(playerA, '我仔细搜索房间。');
      expect(aEdit.status).toBe(200);

      const bSubmit = await submit(playerB, '我警戒门口。');
      expect(bSubmit.status).toBe(200);
      const bView = (await bSubmit.json()) as { view: { turn: { status: string } } };
      expect(bView.view.turn.status).toBe('locked');

      // A 锁后提交 → 409 TURN_LOCKED。
      const aLocked = await submit(playerA, '锁后想改');
      expect(aLocked.status).toBe(409);
      const lockedBody = (await aLocked.json()) as { error: { code: string } };
      expect(lockedBody.error.code).toBe('TURN_LOCKED');

      // outbox 直查：sequence [1,2,3]、types、payload 无正文、published_at null。
      const outboxRows = await platformDb.query<{
        sequence: number; event_type: string; payload_json: string; published_at: string | null;
      }>(
        'SELECT sequence, event_type, payload_json, published_at FROM platform_outbox_events WHERE campaign_id = ? ORDER BY sequence',
        [createBody.campaign.id],
      );
      expect(outboxRows.map((r) => r.sequence)).toEqual([1, 2, 3, 4, 5]);
      expect(outboxRows.map((r) => r.event_type)).toEqual([
        'turn.action_submitted', 'narrative.round.work_available',
        'turn.action_submitted', 'narrative.round.work_available', 'turn.locked',
      ]);
      for (const row of outboxRows) {
        expect(row.payload_json).not.toContain('搜索房间');
        expect(row.payload_json).not.toContain('警戒门口');
        expect(row.published_at).toBeNull();
      }

      // B 看不到 A 正文；owner 看全。
      const bTurnView = (await (await fetch(`${turnsBase}/${turnId}`, { headers: { cookie: playerB.cookieJar.header() } })).json()) as {
        view: { myAction: { body: string } | null };
      };
      expect(JSON.stringify(bTurnView)).not.toContain('搜索房间');
      expect(bTurnView.view.myAction?.body).toBe('我警戒门口。');
      const ownerTurnView = (await (await fetch(`${turnsBase}/${turnId}`, { headers: { cookie: owner.cookieJar.header() } })).json()) as {
        view: { actions: Array<{ body: string; playerId: string }> };
      };
      expect(ownerTurnView.view.actions.map((a) => a.body).sort()).toEqual(['我仔细搜索房间。', '我警戒门口。']);

      // turn list 无 action 正文。
      const turnList = (await (await fetch(`${turnsBase}`, { headers: { cookie: owner.cookieJar.header() } })).json()) as { turns: unknown[] };
      expect(JSON.stringify(turnList)).not.toContain('搜索房间');
      expect(JSON.stringify(turnList)).not.toContain('警戒门口');

      // DTO 无 *_json / 内部字段。
      expect(JSON.stringify(ownerWorld)).not.toContain('_json');
      expect(JSON.stringify(ownerTurnView)).not.toContain('_json');
    } finally {
      await server.close();
    }
  });
});
