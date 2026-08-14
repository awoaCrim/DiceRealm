import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startTestPlatformServer, testFetch } from './httpTestHarness.js';

if (process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0') {
  throw new Error('TLS pin regression child must run with NODE_TLS_REJECT_UNAUTHORIZED=0.');
}

const UNTRUSTED_KEY = readFileSync(fileURLToPath(new URL('./fixtures/tls/untrusted/localhost-key.pem', import.meta.url)));
const UNTRUSTED_CERT = readFileSync(fileURLToPath(new URL('./fixtures/tls/untrusted/localhost-cert.pem', import.meta.url)));

const untrustedServer = createServer({ key: UNTRUSTED_KEY, cert: UNTRUSTED_CERT }, (_req, res) => res.end('ok'));
untrustedServer.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => untrustedServer.once('listening', resolve));
const address = untrustedServer.address() as AddressInfo;
const untrustedUrl = `https://127.0.0.1:${address.port}`;
const platform = await startTestPlatformServer();

try {
  const pinnedResponse = await testFetch(`${platform.baseUrl}/api/auth/me`);
  if (pinnedResponse.status !== 401) {
    throw new Error(`Pinned fixture request returned unexpected status ${pinnedResponse.status}.`);
  }

  let rejected = false;
  try {
    await testFetch(untrustedUrl);
  } catch {
    rejected = true;
  }
  if (!rejected) {
    throw new Error('Shared harness dispatcher accepted a valid certificate outside the pinned fixture CA.');
  }
} finally {
  await platform.close();
  await new Promise<void>((resolve, reject) => {
    untrustedServer.close((error) => error ? reject(error) : resolve());
    untrustedServer.closeAllConnections();
  });
}
