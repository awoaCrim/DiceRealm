import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { waitForHttpServer } from '../../../scripts/wait-for-dev-server.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  return address.port;
}

describe('dev server readiness gate', () => {
  it('treats an AUTH_REQUIRED response as ready', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end('{"error":{"code":"AUTH_REQUIRED"}}');
    });
    const port = await listen(server);

    await expect(waitForHttpServer(`http://127.0.0.1:${port}/api/auth/me`, {
      timeoutMs: 500,
      intervalMs: 10,
    })).resolves.toBeUndefined();
  });

  it('wires the root dev command so Vite starts only after the readiness gate', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts.dev).toContain('npm run dev:client');
    expect(packageJson.scripts['dev:client']).toMatch(
      /^tsx scripts\/wait-for-dev-server\.ts && npm run dev --workspace client$/,
    );
  });
});
