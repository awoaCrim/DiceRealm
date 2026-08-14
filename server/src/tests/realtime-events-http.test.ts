import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionAuthority } from '../modules/identity/SessionAuthority.js';
import type { SessionAuthorityBinding } from '../modules/identity/SessionAuthority.js';
import { OutboxRepository } from '../platform/events/OutboxRepository.js';
import type { EventAuthorityChecker } from '../platform/realtime/EventStreamService.js';
import { installHarnessFetch, startTestPlatformServer, registerAndLogin, jsonHeaders, TestCookieJar, type TestActor } from './httpTestHarness.js';

type SettledOutcome = { status: 'fulfilled' } | { status: 'rejected'; error: unknown };

function settled(promise: Promise<unknown>): Promise<SettledOutcome> {
  return promise.then(
    (): SettledOutcome => ({ status: 'fulfilled' }),
    (error: unknown): SettledOutcome => ({ status: 'rejected', error }),
  );
}

async function within<T>(promise: Promise<T>, ms: number, diagnostic: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${diagnostic} timed out after ${ms}ms.`)), ms);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function cancelReaderBestEffort(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  void Promise.race([
    reader.cancel().catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 100)),
  ]).catch(() => undefined);
}

async function readWithDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  controller: AbortController,
  ms: number,
  diagnostic: string,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  try {
    return await within(reader.read(), ms, diagnostic);
  } catch (error) {
    controller.abort();
    cancelReaderBestEffort(reader);
    throw error;
  }
}

function isKnownServerStreamClosure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = 'code' in error ? error.code : undefined;
  const cause = 'cause' in error && typeof error.cause === 'object' && error.cause !== null ? error.cause : null;
  const causeCode = cause && 'code' in cause ? cause.code : undefined;
  const message = 'message' in error && typeof error.message === 'string' ? error.message : '';
  return code === 'UND_ERR_SOCKET'
    || causeCode === 'UND_ERR_SOCKET'
    || (error instanceof TypeError && /terminated|fetch failed|socket/i.test(message));
}

async function closePlatformBounded(
  server: Awaited<ReturnType<typeof startTestPlatformServer>>,
  diagnostic: string,
): Promise<void> {
  await within(server.close(), 2_000, diagnostic);
}

/** 解析 SSE 响应流，返回按 id 排序的 frame 列表（id: / event: / data: 行）。 */
let restoreHarnessFetch: (() => void) | undefined;
beforeAll(() => { restoreHarnessFetch = installHarnessFetch(); });
afterAll(() => { restoreHarnessFetch?.(); });

async function readSseFrames(
  _baseUrl: string,
  url: string,
  cookieHeader: string,
  opts: { timeoutMs?: number } = {},
): Promise<{
  abortAndWait: (diagnostic?: string) => Promise<void>;
  frames: Array<{ id: number; event: string; data: unknown }>;
  ready: Promise<void>;
  waitClosed: (ms: number, diagnostic: string) => Promise<void>;
}> {
  const controller = new AbortController();
  const frames: Array<{ id: number; event: string; data: unknown }> = [];
  let clientAbortArmed = false;
  let markReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    rejectReady = reject;
  });
  const task = (async () => {
    try {
      const res = await fetch(url, { headers: { cookie: cookieHeader }, signal: controller.signal });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      expect(res.headers.get('cache-control')).toContain('no-cache');
      expect(res.headers.get('cache-control')).toContain('no-transform');
      expect(res.headers.get('x-accel-buffering')).toBe('no');
      markReady();
      if (!res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await readWithDeadline(reader, controller, 20_000, 'SSE stream read');
        if (done) break;
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
            else if (line === ': ping') continue;
          }
          if (id !== null && event && dataLines.length > 0) {
            frames.push({ id, event, data: JSON.parse(dataLines.join('\n')) });
          }
        }
      }
    } catch (error) {
      if (clientAbortArmed && isExpectedAbort(error, controller.signal)) return;
      rejectReady(error);
      throw error;
    }
  })();
  const outcome = settled(task);
  const waitClosed = async (ms: number, diagnostic: string): Promise<void> => {
    const result = await within(outcome, ms, diagnostic);
    if (result.status === 'rejected') throw result.error;
  };
  const timeoutMs = opts.timeoutMs ?? 5000;
  try {
    await within(ready, timeoutMs, 'SSE response readiness');
  } catch (error) {
    clientAbortArmed = true;
    controller.abort();
    await waitClosed(1_000, 'SSE readiness cleanup').catch(() => undefined);
    throw error;
  }
  return {
    abortAndWait: async (diagnostic = 'SSE client abort cleanup') => {
      clientAbortArmed = true;
      controller.abort();
      await waitClosed(1_000, diagnostic);
    },
    frames,
    ready,
    waitClosed,
  };
}

function isExpectedAbort(error: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted || typeof error !== 'object' || error === null) return false;
  return 'name' in error && (error.name === 'AbortError' || error.name === 'TypeError');
}

async function makeCampaign(baseUrl: string, owner: TestActor): Promise<{ campaignId: string }> {
  const res = await fetch(`${baseUrl}/api/campaigns`, {
    method: 'POST',
    headers: jsonHeaders(owner.cookieJar.header()),
    body: JSON.stringify({ name: 'SSE 战役', ruleset: 'dnd5e' }),
  });
  const body = (await res.json()) as { campaign: { id: string }; inviteCode: string };
  return { campaignId: body.campaign.id };
}

async function joinCampaign(baseUrl: string, actor: TestActor, inviteCode: string): Promise<void> {
  await fetch(`${baseUrl}/api/campaigns/join`, {
    method: 'POST',
    headers: jsonHeaders(actor.cookieJar.header()),
    body: JSON.stringify({ inviteCode }),
  });
}

async function loginDevice(baseUrl: string, login: string): Promise<TestCookieJar> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login, password: 'correct-password' }),
  });
  expect(response.status).toBe(200);
  const jar = new TestCookieJar();
  jar.absorb(response);
  return jar;
}

async function openTrackedSse(baseUrl: string, campaignId: string, jar: TestCookieJar) {
  const controller = new AbortController();
  let expectedServerClose = false;
  let clientAbortArmed = false;
  const pendingResponse = fetch(`${baseUrl}/api/campaigns/${campaignId}/events`, {
    headers: { cookie: jar.header() },
    signal: controller.signal,
  });
  let response: Response;
  try {
    response = await within(pendingResponse, 2_000, 'tracked SSE response');
  } catch (error) {
    controller.abort();
    await within(settled(pendingResponse), 1_000, 'tracked SSE response cleanup').catch(() => undefined);
    throw error;
  }
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  if (!response.body) throw new Error('tracked SSE response body is missing');
  const reader = response.body.getReader();
  const task = (async () => {
    while (!(await readWithDeadline(reader, controller, 20_000, 'tracked SSE read')).done) {
      // Drain until an explicitly expected server close or client abort.
    }
  })();
  const outcome = settled(task);
  const waitClosed = async (ms: number, diagnostic: string): Promise<void> => {
    const result = await within(outcome, ms, diagnostic);
    if (result.status === 'fulfilled') {
      if (!expectedServerClose && !clientAbortArmed) {
        throw new Error(`${diagnostic} closed without an armed expectation.`);
      }
      return;
    }
    if (clientAbortArmed && isExpectedAbort(result.error, controller.signal)) return;
    if (expectedServerClose && isKnownServerStreamClosure(result.error)) return;
    throw result.error;
  };
  return {
    response,
    armExpectedServerClose: () => { expectedServerClose = true; },
    waitClosed,
    expectOpenFor: async (ms: number, diagnostic: string) => {
      const result = await Promise.race([
        outcome.then((value) => ({ closed: true as const, value })),
        new Promise<{ closed: false }>((resolve) => setTimeout(() => resolve({ closed: false }), ms)),
      ]);
      if (result.closed) {
        if (result.value.status === 'rejected') throw result.value.error;
        throw new Error(`${diagnostic} closed unexpectedly.`);
      }
    },
    abortAndWait: async (diagnostic = 'tracked SSE client abort') => {
      clientAbortArmed = true;
      controller.abort();
      await waitClosed(1_000, diagnostic);
    },
  };
}

describe('realtime events HTTP', () => {
  it('a real logout commit during the final authority await rejects before SSE headers', async () => {
    let delegate: SessionAuthority | undefined;
    let authorityReadFinished!: () => void;
    const authorityRead = new Promise<void>((resolve) => { authorityReadFinished = resolve; });
    let releaseAuthority!: () => void;
    const release = new Promise<void>((resolve) => { releaseAuthority = resolve; });
    const checker: EventAuthorityChecker = {
      isCurrent: async (binding: SessionAuthorityBinding) => {
        if (!delegate) throw new Error('authority delegate not installed');
        const current = await delegate.isCurrent(binding);
        authorityReadFinished();
        await release;
        return current;
      },
    };
    const server = await startTestPlatformServer({ realtimeAuthorityChecker: checker });
    delegate = new SessionAuthority(server.platformDb);
    const streamController = new AbortController();
    try {
      const owner = await registerAndLogin(server.baseUrl, 'sse-final-commit-race@example.test');
      const { campaignId } = await makeCampaign(server.baseUrl, owner);
      const pendingStream = fetch(`${server.baseUrl}/api/campaigns/${campaignId}/events`, {
        headers: { cookie: owner.cookieJar.header() },
        signal: streamController.signal,
      });
      await within(authorityRead, 2_000, 'final authority read phase');

      const logout = await fetch(`${server.baseUrl}/api/auth/logout`, {
        method: 'POST',
        headers: { cookie: owner.cookieJar.header(), 'x-csrf-token': owner.cookieJar.peek('__Host-dnd_csrf') },
      });
      expect(logout.status).toBe(200);
      releaseAuthority();

      const response = await within(pendingStream, 2_000, 'pre-header race response');
      expect(response.status).toBe(401);
      expect(response.headers.get('content-type')).not.toContain('text/event-stream');
    } finally {
      releaseAuthority();
      streamController.abort();
      await closePlatformBounded(server, 'final-authority test server close');
    }
  });

  it('a real logout commit while the per-frame check awaits sends no replay frame and rejects reconnect', async () => {
    let delegate: SessionAuthority | undefined;
    let frameCheckStarted!: () => void;
    const atFrameCheck = new Promise<void>((resolve) => { frameCheckStarted = resolve; });
    let releaseFrameCheck!: () => void;
    const release = new Promise<void>((resolve) => { releaseFrameCheck = resolve; });
    let authorityChecks = 0;
    let replayFramePhaseReached = false;
    const checker: EventAuthorityChecker = {
      isCurrent: async (binding: SessionAuthorityBinding) => {
        if (!delegate) throw new Error('authority delegate not installed');
        authorityChecks += 1;
        const current = await delegate.isCurrent(binding);
        // The prepared replay row makes the third check the first immediately-before-frame authority phase:
        // pre-header, before-batch, then before the visible replay frame. Name and assert that phase explicitly.
        if (authorityChecks === 3) {
          replayFramePhaseReached = true;
          frameCheckStarted();
          await release;
        }
        return current;
      },
    };
    const server = await startTestPlatformServer({ realtimeAuthorityChecker: checker, realtimePollIntervalMs: 20 });
    delegate = new SessionAuthority(server.platformDb);
    const streamController = new AbortController();
    try {
      const owner = await registerAndLogin(server.baseUrl, 'sse-frame-commit-race@example.test');
      const { campaignId } = await makeCampaign(server.baseUrl, owner);
      await server.platformDb.transaction((tx) => new OutboxRepository(tx).publishIn(tx, {
        type: 'ai.preview.started', campaignId, runId: 'race-run',
      }));

      const response = await within(fetch(`${server.baseUrl}/api/campaigns/${campaignId}/events`, {
        headers: { cookie: owner.cookieJar.header() },
        signal: streamController.signal,
      }), 2_000, 'per-frame SSE response');
      expect(response.status).toBe(200);
      await within(atFrameCheck, 2_000, 'per-frame authority phase');
      expect(replayFramePhaseReached).toBe(true);
      expect(authorityChecks).toBe(3);
      const logout = await fetch(`${server.baseUrl}/api/auth/logout`, {
        method: 'POST',
        headers: { cookie: owner.cookieJar.header(), 'x-csrf-token': owner.cookieJar.peek('__Host-dnd_csrf') },
      });
      expect(logout.status).toBe(200);
      releaseFrameCheck();

      const streamed = await within(response.text(), 2_000, 'revoked SSE response closure');
      expect(streamed).not.toContain('event: campaign');
      expect(streamed).not.toContain('race-run');
      const reconnect = await fetch(`${server.baseUrl}/api/campaigns/${campaignId}/events`, {
        headers: { cookie: owner.cookieJar.header() },
      });
      expect(reconnect.status).toBe(401);
    } finally {
      releaseFrameCheck();
      streamController.abort();
      await closePlatformBounded(server, 'per-frame test server close');
    }
  });

  it('final authority rejection happens before SSE headers are flushed', async () => {
    const server = await startTestPlatformServer({
      realtimeAuthorityChecker: { isCurrent: async () => false },
    });
    try {
      const owner = await registerAndLogin(server.baseUrl, 'sse-final-authority@example.test');
      const { campaignId } = await makeCampaign(server.baseUrl, owner);
      const response = await fetch(`${server.baseUrl}/api/campaigns/${campaignId}/events`, {
        headers: { cookie: owner.cookieJar.header() },
      });
      expect(response.status).toBe(401);
      expect(response.headers.get('content-type')).not.toContain('text/event-stream');
    } finally {
      await server.close();
    }
  });

  it('post-commit notifier failure still returns logout success and exact deletion cookies', async () => {
    const server = await startTestPlatformServer({
      identityOptions: {
        revocationNotifier: {
          revokeSession: () => { throw new Error('forced notifier failure'); },
          revokeUser: () => { throw new Error('forced notifier failure'); },
        },
      },
    });
    try {
      const actor = await registerAndLogin(server.baseUrl, 'logout-notifier-failure@example.test');
      const response = await fetch(`${server.baseUrl}/api/auth/logout`, {
        method: 'POST',
        headers: { cookie: actor.cookieJar.header(), 'x-csrf-token': actor.cookieJar.peek('__Host-dnd_csrf') },
      });
      expect(response.status).toBe(200);
      expect(response.headers.getSetCookie()).toEqual([
        '__Host-dnd_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax',
        '__Host-dnd_csrf=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; SameSite=Lax',
      ]);
    } finally {
      await server.close();
    }
  });

  it('two devices: current logout closes only that SSE and only that reconnect is unauthorized', async () => {
    const server = await startTestPlatformServer({ realtimePollIntervalMs: 20 });
    try {
      const first = await registerAndLogin(server.baseUrl, 'sse-two-device-current@example.test');
      const secondJar = await loginDevice(server.baseUrl, 'sse-two-device-current@example.test');
      const { campaignId } = await makeCampaign(server.baseUrl, first);
      const firstStream = await openTrackedSse(server.baseUrl, campaignId, first.cookieJar);
      const secondStream = await openTrackedSse(server.baseUrl, campaignId, secondJar);
      expect(firstStream.response.status).toBe(200);
      expect(secondStream.response.status).toBe(200);

      firstStream.armExpectedServerClose();
      const logout = await fetch(`${server.baseUrl}/api/auth/logout`, {
        method: 'POST',
        headers: { cookie: first.cookieJar.header(), 'x-csrf-token': first.cookieJar.peek('__Host-dnd_csrf') },
      });
      expect(logout.status).toBe(200);
      await firstStream.waitClosed(500, 'current-device logout stream closure');
      await secondStream.expectOpenFor(100, 'second device after current logout');

      const firstReconnect = await fetch(`${server.baseUrl}/api/campaigns/${campaignId}/events`, {
        headers: { cookie: first.cookieJar.header() },
      });
      expect(firstReconnect.status).toBe(401);
      const secondStillCurrent = await fetch(`${server.baseUrl}/api/campaigns`, {
        headers: { cookie: secondJar.header() },
      });
      expect(secondStillCurrent.status).toBe(200);
      await secondStream.abortAndWait('second-device explicit cleanup');
    } finally {
      await server.close();
    }
  });

  it('two devices: logout-all closes both SSE streams and both reconnects are unauthorized', async () => {
    const server = await startTestPlatformServer({ realtimePollIntervalMs: 20 });
    try {
      const first = await registerAndLogin(server.baseUrl, 'sse-two-device-all@example.test');
      const secondJar = await loginDevice(server.baseUrl, 'sse-two-device-all@example.test');
      const { campaignId } = await makeCampaign(server.baseUrl, first);
      const firstStream = await openTrackedSse(server.baseUrl, campaignId, first.cookieJar);
      const secondStream = await openTrackedSse(server.baseUrl, campaignId, secondJar);

      firstStream.armExpectedServerClose();
      secondStream.armExpectedServerClose();
      const logout = await fetch(`${server.baseUrl}/api/auth/logout-all`, {
        method: 'POST',
        headers: { cookie: first.cookieJar.header(), 'x-csrf-token': first.cookieJar.peek('__Host-dnd_csrf') },
      });
      expect(logout.status).toBe(200);
      await firstStream.waitClosed(500, 'logout-all first stream closure');
      await secondStream.waitClosed(500, 'logout-all second stream closure');

      for (const jar of [first.cookieJar, secondJar]) {
        const reconnect = await fetch(`${server.baseUrl}/api/campaigns/${campaignId}/events`, {
          headers: { cookie: jar.header() },
        });
        expect(reconnect.status).toBe(401);
      }
    } finally {
      await server.close();
    }
  });

  it('tracked SSE rejects an unarmed server-side closure instead of treating it as revocation evidence', async () => {
    const server = await startTestPlatformServer({ realtimePollIntervalMs: 20 });
    try {
      const owner = await registerAndLogin(server.baseUrl, 'sse-unarmed-close@example.test');
      const { campaignId } = await makeCampaign(server.baseUrl, owner);
      const stream = await openTrackedSse(server.baseUrl, campaignId, owner.cookieJar);
      expect(server.realtimeRuntime.closeAllForMaintenance()).toBe(1);
      await expect(stream.waitClosed(500, 'unarmed server close')).rejects.toThrow('without an armed expectation');
    } finally {
      await server.close();
    }
  });

  it('runtime callback failures are isolated so every matching client is dropped and destroyed', async () => {
    const server = await startTestPlatformServer();
    try {
      const calls: string[] = [];
      const binding = {
        internalSessionId: 'throwing-session', userId: 'throwing-user', authRevision: 0, revokeEpoch: 0,
        campaignId: 'c1', viewer: { role: 'owner' as const, playerId: null },
      };
      server.realtimeRuntime.registerClient({
        campaignId: 'c1', viewer: binding.viewer, authorityBinding: binding,
        close: () => { calls.push('close-1'); throw new Error('close failed'); },
        destroy: () => { calls.push('destroy-1'); throw new Error('destroy failed'); },
      });
      server.realtimeRuntime.registerClient({
        campaignId: 'c1', viewer: binding.viewer, authorityBinding: binding,
        close: () => { calls.push('close-2'); },
        destroy: () => { calls.push('destroy-2'); },
      });

      expect(server.realtimeRuntime.revokeUser('throwing-user')).toBe(2);
      expect(calls).toEqual(['close-1', 'close-2', 'destroy-1', 'destroy-2']);
      expect(server.realtimeRuntime.revokeUser('throwing-user')).toBe(0);
    } finally {
      await server.close();
    }
  });

  it('runtime session/user/maintenance invalidation closes matching clients after dropping delivery state', async () => {
    const server = await startTestPlatformServer({ realtimePollIntervalMs: 20 });
    try {
      const first = await registerAndLogin(server.baseUrl, 'sse-runtime-invalidation@example.test');
      const firstSessionId = (await server.platformDb.query<{ id: string }>('SELECT id FROM sessions'))[0].id;
      const secondJar = await loginDevice(server.baseUrl, 'sse-runtime-invalidation@example.test');
      const { campaignId } = await makeCampaign(server.baseUrl, first);
      const firstStream = await openTrackedSse(server.baseUrl, campaignId, first.cookieJar);
      const secondStream = await openTrackedSse(server.baseUrl, campaignId, secondJar);

      firstStream.armExpectedServerClose();
      expect(server.realtimeRuntime.revokeSession(firstSessionId)).toBe(1);
      await firstStream.waitClosed(500, 'runtime session revocation closure');
      await secondStream.expectOpenFor(100, 'other device after session revocation');
      secondStream.armExpectedServerClose();
      expect(server.realtimeRuntime.revokeUser(first.userId)).toBe(1);
      await secondStream.waitClosed(500, 'runtime user revocation closure');

      const thirdJar = await loginDevice(server.baseUrl, 'sse-runtime-invalidation@example.test');
      const thirdStream = await openTrackedSse(server.baseUrl, campaignId, thirdJar);
      thirdStream.armExpectedServerClose();
      expect(server.realtimeRuntime.closeAllForMaintenance()).toBe(1);
      await thirdStream.waitClosed(500, 'maintenance runtime closure');
    } finally {
      await server.close();
    }
  });

  it('closeViewer preservation closes every connection matching the existing viewer fixture', async () => {
    const server = await startTestPlatformServer({ realtimePollIntervalMs: 20 });
    try {
      const owner = await registerAndLogin(server.baseUrl, 'sse-close-viewer@example.test');
      const { campaignId } = await makeCampaign(server.baseUrl, owner);
      const first = await openTrackedSse(server.baseUrl, campaignId, owner.cookieJar);
      const secondJar = await loginDevice(server.baseUrl, 'sse-close-viewer@example.test');
      const second = await openTrackedSse(server.baseUrl, campaignId, secondJar);
      first.armExpectedServerClose();
      second.armExpectedServerClose();
      expect(server.realtimeRuntime.closeViewer?.(campaignId, { role: 'owner', playerId: null })).toBe(2);
      await first.waitClosed(500, 'closeViewer first stream closure');
      await second.waitClosed(500, 'closeViewer second stream closure');
    } finally {
      await server.close();
    }
  });

  it('rejects unauthenticated and non-member SSE access', async () => {
    const server = await startTestPlatformServer({ realtimePollIntervalMs: 20 });
    try {
      const owner = await registerAndLogin(server.baseUrl, 'sse-owner@example.test');
      const outsider = await registerAndLogin(server.baseUrl, 'sse-outsider@example.test');
      const { campaignId } = await makeCampaign(server.baseUrl, owner);
      const unauth = await fetch(`${server.baseUrl}/api/campaigns/${campaignId}/events`);
      expect(unauth.status).toBe(401);
      // 非成员 → 404（隐藏存在性）。
      const nonMember = await fetch(`${server.baseUrl}/api/campaigns/${campaignId}/events`, {
        headers: { cookie: outsider.cookieJar.header() },
      });
      expect(nonMember.status).toBe(404);
      // 成员可达：SSE 长连接（用 after 直接结束为空流，客户端立即 close）。
      const memberRes = await fetch(`${server.baseUrl}/api/campaigns/${campaignId}/events?after=999999`, {
        headers: { cookie: owner.cookieJar.header() },
        signal: AbortSignal.timeout(500),
      });
      expect(memberRes.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it('rejects a non-safe-integer or negative cursor with 400', async () => {
    const server = await startTestPlatformServer({ realtimePollIntervalMs: 20 });
    try {
      const owner = await registerAndLogin(server.baseUrl, 'sse-cursor@example.test');
      const { campaignId } = await makeCampaign(server.baseUrl, owner);
      for (const q of ['after=-1', 'after=1.5', 'after=abc']) {
        const res = await fetch(`${server.baseUrl}/api/campaigns/${campaignId}/events?${q}`, {
          headers: { cookie: owner.cookieJar.header() },
        });
        expect(res.status).toBe(400);
      }
      // ?after 优先于 Last-Event-ID。
      const ok = await fetch(`${server.baseUrl}/api/campaigns/${campaignId}/events?after=0`, {
        headers: { cookie: owner.cookieJar.header(), 'last-event-id': 'not-a-number' },
        signal: AbortSignal.timeout(500),
      });
      expect(ok.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it('delivers replay frames and live frames with shared projection', async () => {
    const server = await startTestPlatformServer({ realtimePollIntervalMs: 20 });
    try {
      const owner = await registerAndLogin(server.baseUrl, 'sse-live-owner@example.test');
      const playerA = await registerAndLogin(server.baseUrl, 'sse-live-a@example.test');
      // 创建战役并让 A 加入。
      const createRes = await fetch(`${server.baseUrl}/api/campaigns`, {
        method: 'POST', headers: jsonHeaders(owner.cookieJar.header()),
        body: JSON.stringify({ name: 'SSE 实时战役', ruleset: 'dnd5e' }),
      });
      const created = (await createRes.json()) as { campaign: { id: string }; inviteCode: string };
      const campaignId = created.campaign.id;
      await fetch(`${server.baseUrl}/api/campaigns/${campaignId}/join`, {
        method: 'POST', headers: jsonHeaders(playerA.cookieJar.header()),
        body: JSON.stringify({ inviteCode: created.inviteCode }),
      });
      // 批准角色 → 开始回合 → 玩家提交行动（产生 turn.action_submitted 事件）。
      const draft = await fetch(`${server.baseUrl}/api/campaigns/${campaignId}/characters`, {
        method: 'POST', headers: jsonHeaders(playerA.cookieJar.header()),
        body: JSON.stringify({ name: '薇拉', sheet: { ac: 14 } }),
      });
      const charBody = (await draft.json()) as { character: { id: string } };
      await fetch(`${server.baseUrl}/api/campaigns/${campaignId}/characters/${charBody.character.id}/submit`, {
        method: 'POST', headers: jsonHeaders(playerA.cookieJar.header()),
      });
      await fetch(`${server.baseUrl}/api/campaigns/${campaignId}/characters/${charBody.character.id}/review`, {
        method: 'POST', headers: jsonHeaders(owner.cookieJar.header()),
        body: JSON.stringify({ action: 'approve' }),
      });
      const turnRes = await fetch(`${server.baseUrl}/api/campaigns/${campaignId}/turns`, {
        method: 'POST', headers: jsonHeaders(owner.cookieJar.header()),
      });
      const turnBody = (await turnRes.json()) as { turn: { id: string } };

      // 先开启 owner replay SSE（after=0），再提交行动验证 live 追加。
      const stream = await readSseFrames(
        server.baseUrl,
        `${server.baseUrl}/api/campaigns/${campaignId}/events`,
        owner.cookieJar.header(),
        { timeoutMs: 3000 },
      );
      await fetch(`${server.baseUrl}/api/campaigns/${campaignId}/turns/${turnBody.turn.id}/actions`, {
        method: 'POST', headers: jsonHeaders(playerA.cookieJar.header()),
        body: JSON.stringify({ body: '我警戒门口。' }),
      });
      await within((async () => {
        while (stream.frames.length < 1) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      })(), 3_000, 'live SSE campaign frame');
      await stream.abortAndWait('live SSE abort cleanup');
      expect(stream.frames.length).toBeGreaterThanOrEqual(1);
      expect(stream.frames.every((f) => f.event === 'campaign')).toBe(true);
      const actionFrames = stream.frames.filter((f) => (f.data as { type?: string }).type === 'turn.action_submitted');
      expect(actionFrames.length).toBe(1);
      expect((actionFrames[0].data as { campaignId: string }).campaignId).toBe(campaignId);
    } finally {
      await server.close();
    }
  });

  it('delivers a heartbeat comment and closes a live stream on server shutdown without client abort', async () => {
    const server = await startTestPlatformServer({ realtimePollIntervalMs: 20, realtimeHeartbeatIntervalMs: 50 });
    const controller = new AbortController();
    let closed = false;
    try {
      const owner = await registerAndLogin(server.baseUrl, 'sse-hb@example.test');
      const { campaignId } = await makeCampaign(server.baseUrl, owner);
      const res = await within(fetch(`${server.baseUrl}/api/campaigns/${campaignId}/events`, {
        headers: { cookie: owner.cookieJar.header() },
        signal: controller.signal,
      }), 2_000, 'shutdown SSE response');
      expect(res.status).toBe(200);
      expect(res.body).not.toBeNull();
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline && !buffer.includes(': ping')) {
        const { done, value } = await readWithDeadline(reader, controller, 1_000, 'heartbeat read');
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
      expect(buffer).toContain(': ping');

      const streamOutcome = settled((async () => {
        while (!(await readWithDeadline(reader, controller, 1_000, 'shutdown stream closure')).done) {
          // Drain until server shutdown.
        }
      })());
      await closePlatformBounded(server, 'live-shutdown server close');
      closed = true;
      const outcome = await within(streamOutcome, 1_000, 'live-shutdown stream outcome');
      if (outcome.status === 'rejected' && !isKnownServerStreamClosure(outcome.error)) throw outcome.error;
    } finally {
      controller.abort();
      if (!closed) await closePlatformBounded(server, 'live-shutdown fallback server close');
    }
  });

  it('cleans up SSE subscriptions on client abort without hanging the server', async () => {
    const server = await startTestPlatformServer({ realtimePollIntervalMs: 20 });
    try {
      const owner = await registerAndLogin(server.baseUrl, 'sse-close@example.test');
      const { campaignId } = await makeCampaign(server.baseUrl, owner);
      const stream = await readSseFrames(
        server.baseUrl,
        `${server.baseUrl}/api/campaigns/${campaignId}/events`,
        owner.cookieJar.header(),
        { timeoutMs: 1_000 },
      );
      await within(stream.ready, 1_000, 'cleanup test SSE readiness');
      await stream.abortAndWait('cleanup test client abort');
      // 服务器仍然可用。
      const ping = await fetch(`${server.baseUrl}/api/campaigns`, {
        headers: { cookie: owner.cookieJar.header() },
      });
      expect(ping.status).toBe(200);
    } finally {
      await server.close();
    }
  });
});
