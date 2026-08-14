/**
 * Phase 4 浏览器实测唯一编排入口（root npm script：npm run test:phase4-browser）。
 *
 * 职责（全自动启动/teardown，非零失败码）：
 * 1. 启动 test-only fixture server（in-memory SQLite + ScriptedAiProvider，随机端口）；
 * 2. 用 Vite JS interface 启动 dev server（随机端口，server.proxy 把 /api 代理到 fixture，
 *    浏览器保持同源，cookie 与 SSE 均经代理流转；不修改静态 client/vite.config.ts）；
 * 3. 设置 PLAYWRIGHT_BROWSERS_PATH 指向仓库内 gitignored 的 playwright-browsers/，
 *    再动态 import playwright（保证路径在浏览器解析前生效）；
 * 4. 运行 client/src/tests/phase4-browser-flow.test.ts 导出的隔离三 context 场景；
 * 5. 全部通过 → exit 0；任何失败 → 打印 blocker 并 exit 1。绝不读/写默认 dnd.sqlite。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { createServer as createViteServer } from 'vite';
import type { AddressInfo } from 'node:net';
import clientViteConfig from '../client/vite.config.ts';
import { startPhase4FixtureServer } from '../server/src/tests/fixtures/phase4BrowserServer.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const phase4FixtureCa = readFileSync(
  fileURLToPath(new URL('../server/src/tests/fixtures/tls/localhost-cert.pem', import.meta.url)),
);

// Playwright 浏览器二进制位于仓库内 gitignored 的 playwright-browsers/；
// 必须在 playwright 解析浏览器路径之前设置（动态 import 保证顺序）。
const browsersPath = path.join(repoRoot, 'playwright-browsers');
process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;

const outputDir = path.join(repoRoot, 'output', 'playwright', 'phase4');
mkdirSync(outputDir, { recursive: true });

async function findFreePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function main(): Promise<number> {
  const fixture = await startPhase4FixtureServer({ previewDeltaMs: 400 });
  console.log(`[phase4-browser] fixture server: ${fixture.baseUrl}`);

  let vite: Awaited<ReturnType<typeof createViteServer>> | null = null;
  try {
    const base = clientViteConfig;
    const frontendPort = await findFreePort();
    const viteConfig = {
      ...base,
      configFile: false,
      root: path.join(repoRoot, 'client'),
      logLevel: 'warn' as const,
      server: {
        ...(base.server ?? {}),
        host: '127.0.0.1',
        port: frontendPort,
        strictPort: true,
        // The browser reaches Vite over HTTP, while the fixture's policy expects its HTTPS origin.
        // Rewrite only the test proxy's outbound authority/origin; keep CA verification enabled.
        proxy: {
          '/api': {
            target: fixture.baseUrl,
            changeOrigin: true,
            ca: phase4FixtureCa,
            secure: true,
            headers: {
              origin: fixture.baseUrl,
            },
          },
        },
      },
    };
    vite = await createViteServer(viteConfig);
    await vite.listen();
    const address = vite.httpServer.address() as AddressInfo;
    const frontendUrl = `http://127.0.0.1:${address.port}`;
    console.log(`[phase4-browser] vite dev server: ${frontendUrl}`);

    const { runPhase4BrowserScenarios } = await import('../client/src/tests/phase4-browser-flow.test.ts');
    const result = await runPhase4BrowserScenarios({
      frontendUrl,
      outputDir,
      // 真正关闭指定 viewer 的服务端 SSE 订阅/响应（非 route abort：已建立的连接不受 context.route 影响）。
      disconnectRealtime: (campaignId, viewer) => fixture.disconnectViewer(campaignId, viewer),
      providerConfig: fixture.providerConfig,
    });

    if (!result.ok) {
      console.error(`[phase4-browser] 场景失败，见上方错误。已执行的步骤：`);
      for (const step of result.steps) {
        console.error(`  - ${step}`);
      }
      console.error(`[phase4-browser] BLOCKER：${result.error ?? '未知错误'}`);
      return 1;
    }
    console.log(`[phase4-browser] 全部场景通过（${result.steps.length} 步）`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(`[phase4-browser] BLOCKER：编排层失败\n${message}`);
    return 1;
  } finally {
    await vite?.close().catch(() => undefined);
    await fixture.close().catch(() => undefined);
  }
}

main().then((code) => {
  process.exitCode = code;
});
