import { expect } from 'vitest';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:https';
import { Agent } from 'undici';
import { createTestPlatformApp } from '../app.js';
import { parseSecurityConfig } from '../config.js';
import { createSqliteDatabase, type SqliteDatabaseAdapter } from '../platform/database/SqliteDatabaseAdapter.js';
import type { AiProviderPort } from '../modules/ai-runtime/AiProviderPort.js';
import type { EventStreamRuntime } from '../platform/realtime/EventStreamService.js';
import { CredentialCipher } from '../modules/ai-runtime/CredentialCipher.js';

const TLS_KEY = readFileSync(fileURLToPath(new URL('./fixtures/tls/localhost-key.pem', import.meta.url)));
const TLS_CERT = readFileSync(fileURLToPath(new URL('./fixtures/tls/localhost-cert.pem', import.meta.url)));
const HTTPS_AGENT = new Agent({ connect: { ca: TLS_CERT, rejectUnauthorized: true } });
const NATIVE_FETCH = globalThis.fetch;

export class TestCookieJar {
  private readonly values = new Map<string, string>();

  absorb(response: Response): void {
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const separator = pair.indexOf('=');
      if (separator < 0) continue;
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (!value || /Max-Age=0/i.test(cookie)) this.values.delete(name);
      else this.values.set(name, value);
    }
  }

  header(): string {
    return [...this.values].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  /** Dedicated black-box auth tests only; ordinary callers use header(). */
  peek(name: string): string {
    return this.values.get(name) ?? '';
  }

  delete(name: string): void {
    this.values.delete(name);
  }
}

export interface StartedPlatform {
  baseUrl: string;
  platformDb: SqliteDatabaseAdapter;
  realtimeRuntime: EventStreamRuntime;
  close: () => Promise<void>;
}

/**
 * Test-only HTTPS adapter scoped to the ephemeral harness origin. It pins the fixture CA and avoids
 * mutating global fetch or process TLS verification; production transport remains untouched.
 */
export function installHarnessFetch(): () => void {
  const previous = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    if (url.startsWith('https://127.0.0.1:')) {
      const headers = new Headers(init?.headers ?? (typeof input === 'object' && 'headers' in input ? input.headers : undefined));
      if (!headers.has('origin')) headers.set('Origin', new URL(url).origin);
      return NATIVE_FETCH(input, { ...init, headers, dispatcher: HTTPS_AGENT } as RequestInit);
    }
    return NATIVE_FETCH(input, init);
  }) as typeof fetch;
  return () => { globalThis.fetch = previous; };
}

export interface TestActor {
  userId: string;
  cookieJar: TestCookieJar;
}

export async function testFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  return NATIVE_FETCH(input, { ...init, dispatcher: HTTPS_AGENT } as RequestInit);
}

export async function startTestPlatformServer(options: {
  aiProvider?: AiProviderPort;
  realtimePollIntervalMs?: number;
  realtimeHeartbeatIntervalMs?: number;
  credentialCipher?: CredentialCipher | null;
  providerFetch?: typeof fetch;
  configuredAiProviderFactory?: (config: import('../config.js').AiProviderEnvConfig, fetchImpl?: typeof fetch) => AiProviderPort;
  trustedProxyCidrs?: string;
  identityOptions?: import('../modules/identity/IdentityService.js').IdentityServiceOptions;
  realtimeAuthorityChecker?: import('../platform/realtime/EventStreamService.js').EventAuthorityChecker;
} = {}): Promise<StartedPlatform> {
  const platformDb = createSqliteDatabase(':memory:');
  await platformDb.migrate();
  const server = createServer({ key: TLS_KEY, cert: TLS_CERT });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `https://127.0.0.1:${address.port}`;
  const { app, realtimeRuntime } = createTestPlatformApp(
    {
      database: platformDb,
      securityConfig: parseSecurityConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: baseUrl, TRUSTED_PROXY_CIDRS: options.trustedProxyCidrs }),
      aiProvider: options.aiProvider,
      credentialCipher: options.credentialCipher === null ? undefined : options.credentialCipher ?? CredentialCipher.generate(),
    },
    {
      providerFetch: options.providerFetch,
      configuredAiProviderFactory: options.configuredAiProviderFactory,
      identityOptions: options.identityOptions,
      realtimeAuthorityChecker: options.realtimeAuthorityChecker,
      realtimePollIntervalMs: options.realtimePollIntervalMs,
      realtimeHeartbeatIntervalMs: options.realtimeHeartbeatIntervalMs,
    },
  );
  server.addListener('request', app);
  return {
    baseUrl,
    platformDb,
    realtimeRuntime,
    close: async () => {
      try { realtimeRuntime.closeAll(); }
      finally {
        try {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
            server.closeAllConnections();
          });
        } finally { await platformDb.close(); }
      }
    },
  };
}

export async function registerAndLogin(baseUrl: string, login: string, password = 'correct-password'): Promise<TestActor> {
  const origin = baseUrl;
  const registerRes = await testFetch(`${baseUrl}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json', Origin: origin }, body: JSON.stringify({ login, password }),
  });
  expect(registerRes.status).toBe(201);
  const registerText = await registerRes.text();
  expect(registerText).not.toContain('password_hash');
  expect(registerText).not.toContain('passwordHash');
  const registerBody = JSON.parse(registerText) as { user: { userId: string } };

  const loginRes = await testFetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', Origin: origin }, body: JSON.stringify({ login, password }),
  });
  expect(loginRes.status).toBe(200);
  const loginBody = (await loginRes.json()) as { session: { expiresAt: string } };
  expect(loginBody.session.expiresAt).toBeTruthy();
  const cookieJar = new TestCookieJar();
  cookieJar.absorb(loginRes);
  return { userId: registerBody.user.userId, cookieJar };
}

export function jsonHeaders(cookieHeader: string, origin?: string) {
  return { 'content-type': 'application/json', cookie: cookieHeader, ...(origin ? { Origin: origin } : {}) };
}
