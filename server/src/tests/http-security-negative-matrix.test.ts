import { describe, expect, it, vi } from 'vitest';
import { appErrorCodes } from '@dnd/contracts';
import { parseSecurityConfig } from '../config.js';
import { DEFAULT_HTTP_STATUS } from '../platform/http/AppError.js';
import { RequestSecurityPolicy } from '../platform/http/RequestSecurityPolicy.js';
import { securityHeaders } from '../platform/http/securityHeaders.js';
import { installHarnessFetch, jsonHeaders, registerAndLogin, startTestPlatformServer, testFetch } from './httpTestHarness.js';

const ORIGIN = 'https://127.0.0.1';

function request(remoteAddress: string, headers: Record<string, string>, encrypted = false): any {
  return { socket: { remoteAddress, encrypted }, headers, method: 'GET' };
}

const trustedConfig = parseSecurityConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: 'https://game.test:8443', TRUSTED_PROXY_CIDRS: '127.0.0.1/32' });

describe('Task 7 strict security config', () => {
  it.each([
    undefined, '', 'http://game.test', 'https://game.test/path', 'https://game.test?x=1', 'https://u:p@game.test', 'https://game.test/#x', 'https://*.game.test',
  ])('rejects invalid PUBLIC_ORIGIN %s', (origin) => {
    expect(() => parseSecurityConfig({ PUBLIC_ORIGIN: origin })).toThrow();
  });

  it('accepts canonical HTTPS origin and explicit non-production origins only', () => {
    expect(parseSecurityConfig({ NODE_ENV: 'development', PUBLIC_ORIGIN: 'https://GAME.test:8443', DEV_ALLOWED_ORIGINS: 'http://localhost:5173,https://dev.test' })).toMatchObject({
      publicOrigin: 'https://game.test:8443',
      allowedOrigins: ['https://game.test:8443', 'http://localhost:5173', 'https://dev.test'],
    });
    expect(() => parseSecurityConfig({ NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://game.test', DEV_ALLOWED_ORIGINS: 'https://dev.test' })).toThrow();
  });

  it.each(['*', 'true', '127.0.0.1/33', '10.0.0.0/8/1', 'not-an-ip'])('rejects invalid trusted proxy value %s', (cidr) => {
    expect(() => parseSecurityConfig({ PUBLIC_ORIGIN: ORIGIN, TRUSTED_PROXY_CIDRS: cidr })).toThrow();
  });

  it.each(['*', '', 'https://dev.test/path', 'https://*.dev.test'])('rejects invalid dev origin %s', (origin) => {
    if (origin === '') return;
    expect(() => parseSecurityConfig({ PUBLIC_ORIGIN: ORIGIN, DEV_ALLOWED_ORIGINS: origin })).toThrow();
  });

  it('accepts canonical 32-byte bootstrap secret and normalizes default ports', () => {
    const secret = Buffer.from(new Uint8Array(32).fill(7)).toString('base64url');
    expect(secret).toHaveLength(43);
    expect(parseSecurityConfig({ NODE_ENV: 'development', PUBLIC_ORIGIN: 'https://GAME.test:443', DEV_ALLOWED_ORIGINS: 'http://LOCALHOST:80', BOOTSTRAP_ENABLED: 'true', BOOTSTRAP_DATABASE_ID: 'opaque-db-id', BOOTSTRAP_SECRET: secret })).toMatchObject({
      publicOrigin: 'https://game.test',
      devAllowedOrigins: ['http://localhost'],
      allowedOrigins: ['https://game.test', 'http://localhost'],
    });
  });

  it.each([
    '', 'short', 'a'.repeat(42), 'a'.repeat(44), `${'a'.repeat(42)}==`, `${'a'.repeat(42)}é`, `${'a'.repeat(43)} `,
  ])('rejects illegal full bootstrap secret %s', (secret) => {
    expect(() => parseSecurityConfig({ PUBLIC_ORIGIN: ORIGIN, BOOTSTRAP_ENABLED: 'true', BOOTSTRAP_DATABASE_ID: 'opaque-db-id', BOOTSTRAP_SECRET: secret })).toThrow();
  });

  it('rejects an invalid bootstrap database id while keeping the contract opaque', () => {
    const secret = Buffer.alloc(32, 1).toString('base64url');
    expect(() => parseSecurityConfig({ PUBLIC_ORIGIN: ORIGIN, BOOTSTRAP_ENABLED: 'true', BOOTSTRAP_DATABASE_ID: ' ', BOOTSTRAP_SECRET: secret })).toThrow();
    expect(() => parseSecurityConfig({ PUBLIC_ORIGIN: ORIGIN, BOOTSTRAP_ENABLED: 'true', BOOTSTRAP_DATABASE_ID: 'x'.repeat(257), BOOTSTRAP_SECRET: secret })).toThrow();
  });

  it('rejects partial bootstrap configuration before listen', () => {
    expect(() => parseSecurityConfig({ PUBLIC_ORIGIN: ORIGIN, BOOTSTRAP_ENABLED: 'true' })).toThrow();
    expect(() => parseSecurityConfig({ PUBLIC_ORIGIN: ORIGIN, BOOTSTRAP_DATABASE_ID: 'db', BOOTSTRAP_SECRET: 'x' })).toThrow();
  });
});

describe('RequestSecurityPolicy forwarding and client IP', () => {
  it('performs one authoritative resolve across headers and enforcement middleware', () => {
    const policy = new RequestSecurityPolicy(parseSecurityConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: 'https://game.test' }));
    const resolve = vi.spyOn(policy, 'resolve');
    const req = request('203.0.113.2', { host: 'game.test', origin: 'https://game.test' }, true);
    const headers = new Map<string, string>();
    const res = {
      setHeader(name: string, value: string) { headers.set(name, value); },
      status() { return this; },
      end() { return this; },
    } as any;
    let nextCalls = 0;
    securityHeaders()(req, res, () => { nextCalls += 1; });
    policy.middleware()(req, res, () => { nextCalls += 1; });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(nextCalls).toBe(2);
  });

  it.each(['not-an-ip', '198.51.100.9:443', ''])('rejects invalid direct remote address %s', (remoteAddress) => {
    const policy = new RequestSecurityPolicy(parseSecurityConfig({ PUBLIC_ORIGIN: 'https://game.test' }));
    expect(() => policy.resolve(request(remoteAddress, { host: 'game.test' }, true))).toThrow();
  });

  it('accepts valid direct IPv4 and IPv6 addresses', () => {
    const policy = new RequestSecurityPolicy(parseSecurityConfig({ PUBLIC_ORIGIN: 'https://game.test' }));
    expect(policy.resolve(request('203.0.113.2', { host: 'game.test' }, true)).clientIp).toBe('203.0.113.2');
    expect(policy.resolve(request('2001:db8::2', { host: 'game.test' }, true)).clientIp).toBe('2001:db8::2');
  });
  it('uses explicit default-port origins consistently for request matching', () => {
    const config = parseSecurityConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: 'https://game.test:443' });
    const policy = new RequestSecurityPolicy(config);
    expect(policy.resolve(request('203.0.113.2', { host: 'game.test:443', origin: 'https://game.test:443' }, true))).toMatchObject({ host: 'game.test', origin: 'https://game.test' });
  });
  it('uses direct TLS and host when no proxy is trusted', () => {
    const policy = new RequestSecurityPolicy(parseSecurityConfig({ PUBLIC_ORIGIN: 'https://game.test' }));
    expect(policy.resolve(request('203.0.113.2', { host: 'game.test', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'evil.test' }, true))).toMatchObject({ isHttps: true, host: 'game.test', clientIp: '203.0.113.2' });
  });


  it('accepts trusted proxy TLS/host/client IP forwarding', () => {
    const policy = new RequestSecurityPolicy(trustedConfig);
    expect(policy.resolve(request('127.0.0.1', { host: 'internal', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'game.test:8443', 'x-forwarded-for': '198.51.100.9' }))).toMatchObject({ isHttps: true, host: 'game.test:8443', clientIp: '198.51.100.9' });
    expect(policy.resolve(request('127.0.0.1', { host: 'internal', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'game.test:8443', 'x-forwarded-for': '2001:db8::9' })).clientIp).toBe('2001:db8::9');
  });

  it.each(['unknown', '198.51.100.9:443', '[2001:db8::9]:443', '[2001:db8::9]', '2001:db8:::9', ''])('rejects non-address trusted client IP %s', (clientIp) => {
    const headers: Record<string, string> = { host: 'game.test:8443', 'x-forwarded-proto': 'https', 'x-forwarded-for': clientIp };
    expect(() => new RequestSecurityPolicy(trustedConfig).resolve(request('127.0.0.1', headers))).toThrow();
  });

  it('ignores untrusted forwarding and rejects malformed or ambiguous trusted values', () => {
    const policy = new RequestSecurityPolicy(trustedConfig);
    expect(policy.resolve(request('127.0.0.2', { host: 'game.test:8443', 'x-forwarded-proto': 'https', 'x-forwarded-for': '198.51.100.9' })).isHttps).toBe(false);
    expect(() => policy.resolve(request('127.0.0.1', { host: 'game.test:8443', 'x-forwarded-proto': 'https,http' }))).toThrow();
    expect(() => policy.resolve(request('127.0.0.1', { host: 'game.test:8443', 'x-forwarded-host': 'game.test:8443,evil.test' }))).toThrow();
    expect(() => policy.resolve(request('127.0.0.1', { host: 'game.test:8443', 'x-forwarded-for': '198.51.100.9,203.0.113.1' }))).toThrow();
  });

  it('rejects normalized lowercase standardized Forwarded data on a trusted peer', () => {
    const policy = new RequestSecurityPolicy(trustedConfig);
    expect(() => policy.resolve(request('127.0.0.1', { host: 'game.test:8443', forwarded: 'proto=https;host=game.test:8443;for=198.51.100.9' }))).toThrow();
    expect(() => policy.resolve(request('127.0.0.1', {
      host: 'internal',
      forwarded: 'proto=http;host=evil.test;for=203.0.113.7',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'game.test:8443',
      'x-forwarded-for': '198.51.100.9',
    }))).toThrow();
  });
});


describe('Task 7 HTTPS HTTP matrix', () => {
  let restore: (() => void) | undefined;
  it('enforces exact origin, CORS, headers, no-store, and parser ordering', async () => {
    restore = installHarnessFetch();
    const server = await startTestPlatformServer();
    try {
      const fixed = await testFetch(`${server.baseUrl}/api/auth/me`);
      expect(fixed.status).toBe(401);
      expect(fixed.headers.get('content-security-policy')).toBeTruthy();
      expect(fixed.headers.get('strict-transport-security')).toBe('max-age=31536000');
      expect(fixed.headers.get('cache-control')).toBe('no-store');

      const preflight = await testFetch(`${server.baseUrl}/api/auth/login`, { method: 'OPTIONS', headers: { Origin: server.baseUrl, 'Access-Control-Request-Method': 'POST' } });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe(server.baseUrl);
      expect(preflight.headers.get('access-control-allow-credentials')).toBe('true');
      expect(preflight.headers.get('vary')).toContain('Origin');
      expect(preflight.headers.get('access-control-allow-origin')).not.toBe('*');

      for (const origin of ['', 'null', 'https://127.0.0.1:443', 'http://127.0.0.1', 'https://evil.test']) {
        const headers = new Headers({ 'content-type': 'application/json' });
        if (origin) headers.set('Origin', origin);
        const response = await testFetch(`${server.baseUrl}/api/auth/login`, { method: 'POST', headers, body: '{bad' });
        expect(response.status, origin || 'missing').toBe(403);
        expect(response.headers.get('cache-control')).toBe('no-store');
      }

      const authRegister = await testFetch(`${server.baseUrl}/api/auth/register`, { method: 'POST', headers: { Origin: server.baseUrl, 'content-type': 'application/json' }, body: JSON.stringify({ login: 'task7-cache-user', password: 'correct-password' }) });
      expect(authRegister.status).toBe(201);
      expect(authRegister.headers.get('cache-control')).toBe('no-store');
      const authMalformed = await testFetch(`${server.baseUrl}/api/auth/register`, { method: 'POST', headers: { Origin: server.baseUrl, 'content-type': 'application/json' }, body: '{bad' });
      expect(authMalformed.status).toBe(400);
      expect(authMalformed.headers.get('cache-control')).toBe('no-store');
      const authOversize = await testFetch(`${server.baseUrl}/api/auth/register`, { method: 'POST', headers: { Origin: server.baseUrl, 'content-type': 'application/json' }, body: JSON.stringify({ login: 'x'.repeat(20_000), password: 'correct-password' }) });
      expect(authOversize.status).toBe(413);
      expect(authOversize.headers.get('cache-control')).toBe('no-store');
      const auth404 = await testFetch(`${server.baseUrl}/api/auth/does-not-exist`, { headers: { Origin: server.baseUrl } });
      expect(auth404.status).toBe(404);
      expect(auth404.headers.get('cache-control')).toBe('no-store');

      const actor = await registerAndLogin(server.baseUrl, 'task7-budget-user');
      const over = await testFetch(`${server.baseUrl}/api/campaigns`, { method: 'POST', headers: { Origin: server.baseUrl, cookie: actor.cookieJar.header(), 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x'.repeat(40_000) }) });
      expect(over.status).toBe(413);
      expect((await over.json()).error.code).toBe('PAYLOAD_TOO_LARGE');
      const malformed = await testFetch(`${server.baseUrl}/api/campaigns`, { method: 'POST', headers: { Origin: server.baseUrl, cookie: actor.cookieJar.header(), 'content-type': 'application/json' }, body: '{bad' });
      expect(malformed.status).toBe(400);
      expect((await malformed.json()).error.code).toBe('VALIDATION_ERROR');
    } finally { await server.close(); restore?.(); }
  });

  it('returns fixed headers and safe JSON for rejected host and forwarding', async () => {
    restore = installHarnessFetch();
    const server = await startTestPlatformServer({ trustedProxyCidrs: '127.0.0.1/32' });
    try {
      const rejectedHost = await testFetch(`${server.baseUrl}/api/auth/me`, { headers: { Origin: server.baseUrl, 'x-forwarded-host': 'evil.test' } });
      expect(rejectedHost.status).toBe(403);
      expect((await rejectedHost.json()).error.code).toBe('FORBIDDEN');
      expect(rejectedHost.headers.get('cache-control')).toBe('no-store');
      expect(rejectedHost.headers.get('content-security-policy')).toBeTruthy();
      expect(rejectedHost.headers.get('strict-transport-security')).toBe('max-age=31536000');
      expect(rejectedHost.headers.get('access-control-allow-origin')).toBeNull();
      expect(rejectedHost.headers.get('access-control-allow-credentials')).toBeNull();

      const malformed = await testFetch(`${server.baseUrl}/api/auth/me`, { headers: { Origin: server.baseUrl, 'x-forwarded-for': 'unknown' } });
      expect(malformed.status).toBe(403);
      expect((await malformed.json()).error.code).toBe('FORBIDDEN');
      expect(malformed.headers.get('cache-control')).toBe('no-store');
      expect(malformed.headers.get('strict-transport-security')).toBe('max-age=31536000');
      expect(malformed.headers.get('access-control-allow-origin')).toBeNull();
      expect(malformed.headers.get('access-control-allow-credentials')).toBeNull();

      const forwardedHttp = await testFetch(`${server.baseUrl}/api/auth/me`, { headers: { Origin: server.baseUrl, 'x-forwarded-proto': 'http', 'x-forwarded-host': '127.0.0.1', 'x-forwarded-for': '198.51.100.9' } });
      expect(forwardedHttp.status).toBe(403);
      expect((await forwardedHttp.json()).error.code).toBe('FORBIDDEN');
      expect(forwardedHttp.headers.get('strict-transport-security')).toBeNull();
      expect(forwardedHttp.headers.get('access-control-allow-origin')).toBeNull();
      expect(forwardedHttp.headers.get('access-control-allow-credentials')).toBeNull();

      const lowerForwarded = await testFetch(`${server.baseUrl}/api/auth/me`, { headers: { Origin: server.baseUrl, forwarded: 'proto=https;host=127.0.0.1;for=198.51.100.9' } });
      expect(lowerForwarded.status).toBe(403);
      expect((await lowerForwarded.json()).error.code).toBe('FORBIDDEN');
      expect(lowerForwarded.headers.get('cache-control')).toBe('no-store');

      const conflictingForwarding = await testFetch(`${server.baseUrl}/api/auth/me`, { headers: {
        Origin: server.baseUrl,
        forwarded: 'proto=http;host=evil.test;for=203.0.113.7',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': new URL(server.baseUrl).host,
        'x-forwarded-for': '198.51.100.9',
      } });
      expect(conflictingForwarding.status).toBe(403);
      expect((await conflictingForwarding.json()).error.code).toBe('FORBIDDEN');
      expect(conflictingForwarding.headers.get('access-control-allow-origin')).toBeNull();
      expect(conflictingForwarding.headers.get('access-control-allow-credentials')).toBeNull();
    } finally { await server.close(); restore?.(); }
  });

  it('enforces authorization before malformed and oversized body parsing across sensitive operations', async () => {
    restore = installHarnessFetch();
    const providerFetch = vi.fn<typeof fetch>();
    const server = await startTestPlatformServer({ providerFetch });
    try {
      const owner = await registerAndLogin(server.baseUrl, 'task7-order-owner');
      const player = await registerAndLogin(server.baseUrl, 'task7-order-player');
      const create = await testFetch(`${server.baseUrl}/api/campaigns`, { method: 'POST', headers: jsonHeaders(owner.cookieJar.header(), server.baseUrl), body: JSON.stringify({ name: 'order-check', ruleset: 'dnd5e' }) });
      expect(create.status).toBe(201);
      const created = await create.json() as { campaign: { id: string }; inviteCode: string };
      const campaign = created.campaign.id;
      const join = await testFetch(`${server.baseUrl}/api/campaigns/${campaign}/join`, { method: 'POST', headers: jsonHeaders(player.cookieJar.header(), server.baseUrl), body: JSON.stringify({ inviteCode: created.inviteCode }) });
      expect(join.status).toBe(201);
      const malformed = '{bad';
      const oversized = JSON.stringify({ value: 'x'.repeat(300_000) });
      const post = (url: string, cookie: string, body: string) => testFetch(url, { method: 'POST', headers: jsonHeaders(cookie, server.baseUrl), body });
      const patch = (url: string, cookie: string, body: string) => testFetch(url, { method: 'PATCH', headers: jsonHeaders(cookie, server.baseUrl), body });
      const put = (url: string, cookie: string, body: string) => testFetch(url, { method: 'PUT', headers: jsonHeaders(cookie, server.baseUrl), body });
      for (const body of [malformed, oversized]) {
        expect((await patch(`${server.baseUrl}/api/campaigns/${campaign}/settings`, player.cookieJar.header(), body)).status).toBe(403);
        expect((await post(`${server.baseUrl}/api/campaigns/${campaign}/ai/turns/missing/runs`, player.cookieJar.header(), body)).status).toBe(403);
        expect((await put(`${server.baseUrl}/api/campaigns/${campaign}/ai/provider-config`, player.cookieJar.header(), body)).status).toBe(403);
        expect((await post(`${server.baseUrl}/api/campaigns/${campaign}/ai/provider-config/test`, player.cookieJar.header(), body)).status).toBe(403);
        expect((await post(`${server.baseUrl}/api/campaigns/${campaign}/characters/missing`, owner.cookieJar.header(), body)).status).toBe(404);
        expect((await post(`${server.baseUrl}/api/campaigns/${campaign}/turns/missing/actions`, owner.cookieJar.header(), body)).status).toBe(403);
      }
      for (const body of [malformed, oversized]) {
        expect((await post(`${server.baseUrl}/api/campaigns/${campaign}/characters`, owner.cookieJar.header(), body)).status).toBe(403);
        expect((await put(`${server.baseUrl}/api/campaigns/${campaign}/characters/missing`, owner.cookieJar.header(), body)).status).toBe(403);
      }
      const providerOversize = await put(`${server.baseUrl}/api/campaigns/${campaign}/ai/provider-config`, owner.cookieJar.header(), JSON.stringify({ provider: 'openai-compatible', baseUrl: 'https://example.test', model: 'm', apiKey: 'x'.repeat(20_000) }));
      expect(providerOversize.status).toBe(413);
      const providerTestOversize = await post(`${server.baseUrl}/api/campaigns/${campaign}/ai/provider-config/test`, owner.cookieJar.header(), JSON.stringify({ provider: 'openai-compatible', baseUrl: 'https://example.test', model: 'm', apiKey: 'x'.repeat(20_000) }));
      expect(providerTestOversize.status).toBe(413);
      const aiOversize = await post(`${server.baseUrl}/api/campaigns/${campaign}/ai/turns/missing/runs`, owner.cookieJar.header(), JSON.stringify({ idempotencyKey: 'x'.repeat(9_000) }));
      expect(aiOversize.status).toBe(413);

      const characterOversize = JSON.stringify({ value: 'x'.repeat(300_000) });
      const characterCreateOversize = await post(`${server.baseUrl}/api/campaigns/${campaign}/characters`, player.cookieJar.header(), characterOversize);
      expect(characterCreateOversize.status).toBe(413);
      expect((await characterCreateOversize.json()).error.code).toBe('PAYLOAD_TOO_LARGE');
      const characterUpdateOversize = await put(`${server.baseUrl}/api/campaigns/${campaign}/characters/missing`, player.cookieJar.header(), characterOversize);
      expect(characterUpdateOversize.status).toBe(413);
      expect((await characterUpdateOversize.json()).error.code).toBe('PAYLOAD_TOO_LARGE');

      const commonOversize = JSON.stringify({ value: 'x'.repeat(70_000) });
      const commonBudgetResponses = await Promise.all([
        post(`${server.baseUrl}/api/campaigns/${campaign}/world`, owner.cookieJar.header(), commonOversize),
        post(`${server.baseUrl}/api/campaigns/${campaign}/turns/missing/actions`, player.cookieJar.header(), commonOversize),
        post(`${server.baseUrl}/api/campaigns/${campaign}/archives`, owner.cookieJar.header(), commonOversize),
        post(`${server.baseUrl}/api/campaigns/${campaign}/combat`, owner.cookieJar.header(), commonOversize),
        post(`${server.baseUrl}/api/campaigns/${campaign}/rules/sources`, owner.cookieJar.header(), commonOversize),
      ]);
      for (const response of commonBudgetResponses) {
        expect(response.status).toBe(413);
        expect((await response.json()).error.code).toBe('PAYLOAD_TOO_LARGE');
      }
      expect(providerFetch).not.toHaveBeenCalled();
    } finally { await server.close(); restore?.(); }
  });
  it('rejects plain HTTP and preserves SSE pre-header safety', async () => {
    restore = installHarnessFetch();
    const server = await startTestPlatformServer();
    try {
      const plain = await fetch(server.baseUrl.replace('https:', 'http:') + '/api/auth/me').catch(() => null);
      expect(plain).toBeNull();
      const sse = await testFetch(`${server.baseUrl}/api/campaigns/missing/events`, { headers: { Origin: server.baseUrl } });
      expect(sse.status).toBe(401);
      expect(sse.headers.get('content-type')).not.toContain('text/event-stream');
    } finally { await server.close(); restore?.(); }
  });
});

describe('approved application error status map', () => {
  it('contains one HTTP status for every contract error code', () => {
    expect(Object.keys(DEFAULT_HTTP_STATUS).sort()).toEqual([...appErrorCodes].sort());
    for (const code of appErrorCodes) expect(DEFAULT_HTTP_STATUS[code]).toBeGreaterThanOrEqual(400);
    expect(DEFAULT_HTTP_STATUS.PAYLOAD_TOO_LARGE).toBe(413);
    expect(DEFAULT_HTTP_STATUS.RATE_LIMITED).toBe(429);
    expect(DEFAULT_HTTP_STATUS.MAINTENANCE_MODE).toBe(503);
  });
});
