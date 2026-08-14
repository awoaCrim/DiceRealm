import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface WaitForHttpServerOptions {
  timeoutMs?: number;
  intervalMs?: number;
  fetchImpl?: typeof fetch;
}

export async function waitForHttpServer(
  url: string,
  options: WaitForHttpServerOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 100;
  const fetchImpl = options.fetchImpl ?? fetch;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      await fetchImpl(url, { signal: AbortSignal.timeout(Math.min(1_000, timeoutMs)) });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`Timed out waiting for dev server at ${url}${detail}`);
}

async function main(): Promise<void> {
  const url = process.env.DEV_SERVER_READY_URL ?? 'http://127.0.0.1:3000/api/auth/me';
  console.log(`[dev] waiting for server: ${url}`);
  await waitForHttpServer(url);
  console.log(`[dev] server ready: ${url}`);
}

const isMain = process.argv[1]
  ? fileURLToPath(import.meta.url) === resolve(process.argv[1])
  : false;

if (isMain) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
