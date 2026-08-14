import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function runTlsPinChild(): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const childScript = fileURLToPath(new URL('./httpTestHarnessTlsPinChild.ts', import.meta.url));
  const tsxCli = fileURLToPath(new URL('../../../node_modules/tsx/dist/cli.mjs', import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCli, childScript], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`TLS pin child timed out. stdout=${stdout} stderr=${stderr}`));
    }, 15_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

describe('HTTPS test harness certificate pinning', () => {
  it('the shared harness dispatcher rejects a valid untrusted certificate under an insecure process default', async () => {
    const result = await runTlsPinChild();
    expect(result, result.stderr).toMatchObject({ code: 0 });
  }, 20_000);
});
