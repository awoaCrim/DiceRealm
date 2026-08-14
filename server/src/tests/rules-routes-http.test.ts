import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installHarnessFetch, jsonHeaders, registerAndLogin, startTestPlatformServer } from './httpTestHarness.js';

const hash = 'ab'.repeat(32);

let restoreHarnessFetch: (() => void) | undefined;
beforeAll(() => { restoreHarnessFetch = installHarnessFetch(); });
afterAll(() => { restoreHarnessFetch?.(); });

describe('HTTP rule-source routes', () => {
  it('lets only the owner list and register metadata without accepting or returning rule text', async () => {
    const server = await startTestPlatformServer();
    try {
      const owner = await registerAndLogin(server.baseUrl, 'http-rules-owner@example.test');
      const player = await registerAndLogin(server.baseUrl, 'http-rules-player@example.test');
      const createRes = await fetch(`${server.baseUrl}/api/campaigns`, {
        method: 'POST', headers: jsonHeaders(owner.cookieJar.header()),
        body: JSON.stringify({ name: 'HTTP 规则战役', ruleset: 'dnd5e' }),
      });
      const created = (await createRes.json()) as { campaign: { id: string }; inviteCode: string };
      await fetch(`${server.baseUrl}/api/campaigns/${created.campaign.id}/join`, {
        method: 'POST', headers: jsonHeaders(player.cookieJar.header()),
        body: JSON.stringify({ inviteCode: created.inviteCode }),
      });
      const base = `${server.baseUrl}/api/campaigns/${created.campaign.id}/rules/sources`;

      const playerList = await fetch(base, { headers: { cookie: player.cookieJar.header() } });
      expect(playerList.status).toBe(403);
      const playerCreate = await fetch(base, {
        method: 'POST', headers: jsonHeaders(player.cookieJar.header()),
        body: JSON.stringify({ content: 'invalid bodies must not bypass authorization' }),
      });
      expect(playerCreate.status).toBe(403);

      const rejectedBody = await fetch(base, {
        method: 'POST', headers: jsonHeaders(owner.cookieJar.header()),
        body: JSON.stringify({
          sourceName: 'No Body', version: '1', license: 'CC0', attribution: 'Example',
          contentHash: hash, scope: 'campaign', content: 'third-party rules must not enter the platform',
        }),
      });
      expect(rejectedBody.status).toBe(422);
      expect(await rejectedBody.json()).toEqual({
        error: {
          code: 'INVALID_RULE_SOURCE',
          message: '规则来源必须包含来源、版本、许可证、署名与有效的 SHA-256 哈希。',
        },
      });

      const createSource = await fetch(base, {
        method: 'POST', headers: jsonHeaders(owner.cookieJar.header()),
        body: JSON.stringify({
          sourceName: 'Open Reference', version: '1', license: 'CC-BY-4.0',
          attribution: 'Example Author', contentHash: hash, scope: 'campaign',
        }),
      });
      expect(createSource.status).toBe(201);
      const createText = await createSource.text();
      expect(createText).not.toContain('third-party rules');
      expect(JSON.parse(createText)).toMatchObject({
        source: { sourceName: 'Open Reference', scope: 'campaign', campaignId: created.campaign.id },
      });

      const list = await fetch(base, { headers: { cookie: owner.cookieJar.header() } });
      expect(list.status).toBe(200);
      const listText = await list.text();
      const listBody = JSON.parse(listText) as { sources: Array<Record<string, unknown>> };
      expect(listBody.sources[0]).not.toHaveProperty('content');
      expect(listBody).toMatchObject({ sources: [{ sourceName: 'Open Reference' }] });

      const duplicate = await fetch(base, {
        method: 'POST', headers: jsonHeaders(owner.cookieJar.header()),
        body: JSON.stringify({
          sourceName: 'Open Reference', version: '1', license: 'CC-BY-4.0',
          attribution: 'Example Author', contentHash: hash, scope: 'campaign',
        }),
      });
      expect(duplicate.status).toBe(422);
      expect(await duplicate.json()).toEqual({
        error: { code: 'INVALID_RULE_SOURCE', message: '规则来源元数据无效或已登记。' },
      });
    } finally {
      await server.close();
    }
  });

  it('authenticates before parsing a malformed owner-only registration body', async () => {
    const server = await startTestPlatformServer();
    try {
      const res = await fetch(`${server.baseUrl}/api/campaigns/not-visible/rules/sources`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{',
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: { code: 'AUTH_REQUIRED', message: '请先登录。' } });

      const validJson = await fetch(`${server.baseUrl}/api/campaigns/not-visible/rules/sources`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      expect(validJson.status).toBe(401);
      expect(await validJson.json()).toEqual({ error: { code: 'AUTH_REQUIRED', message: '请先登录。' } });
    } finally {
      await server.close();
    }
  });
});
