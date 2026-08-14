import type { AppConfig } from '../../config.js';
import { startPlatformServer, type RunningPlatformServer, type StartPlatformServerOptions } from './startPlatformServer.js';

export interface RunServerWithSignalsOptions {
  config: AppConfig;
  env: Record<string, string | undefined>;
  /** 测试注入启动函数（生产默认 startPlatformServer）。 */
  startServer?: (options: StartPlatformServerOptions) => Promise<RunningPlatformServer>;
  /** 测试注入退出函数（生产默认 process.exit）。 */
  exit?: (code?: number) => never;
  /** 测试注入 signal 注册（生产默认 process.once）。 */
  onSignal?: (signal: NodeJS.Signals, handler: () => void) => void;
  /** 测试注入粗粒度错误报告（生产默认 console.error；绝不打印密钥/堆栈）。 */
  reportError?: (message: string) => void;
}

/** 粗粒度错误文本：只取 message（截断），不泄漏堆栈或密钥。 */
function coarseErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message || error.name;
    const truncated = message.length > 200 ? `${message.slice(0, 200)}…` : message;
    return `DND 服务启动或关闭失败：${truncated}`;
  }
  return 'DND 服务启动或关闭失败（未知原因）。';
}

/**
 * 可测试的入口 helper：在启动之前注册 SIGINT/SIGTERM handler，使启动窗口内
 * 的信号也不会留下 InstanceLock。
 *
 * - 启动正常完成且无信号：返回，server 持续运行。
 * - 启动期间收到信号：等待启动 settle；若得到 running server 则 close（server →
 *   realtime → connections → database → lock）后再退出；若启动失败则报告粗粒度错误并以
 *   非零码退出（不打印密钥/堆栈）。
 * - 启动完成后收到信号：close 后退出；close 失败报告错误并以非零码退出；重复信号忽略。
 * - 启动失败且无信号：原样抛出（coordinator 已自行清理锁）。
 */
export async function runServerWithSignals(options: RunServerWithSignalsOptions): Promise<void> {
  const { config, env } = options;
  const startServer = options.startServer ?? startPlatformServer;
  const exit = options.exit ?? ((code?: number) => process.exit(code ?? 0));
  const onSignal = options.onSignal ?? ((signal, handler) => process.once(signal, handler));
  const reportError = options.reportError ?? ((message: string) => console.error(message));

  let shuttingDown = false;
  let server: RunningPlatformServer | null = null;
  let startupSettled: Promise<void>;

  const handleSignal = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      let exitCode = 0;
      try {
        await startupSettled; // 等待启动 settle（拿到 running server 或启动失败）。
      } catch (error) {
        // 启动失败：报告粗粒度原因并以非零码退出（不打印密钥/堆栈）。
        reportError(coarseErrorMessage(error));
        exitCode = 1;
      }
      if (exitCode === 0 && server !== null) {
        try {
          await server.close();
        } catch (error) {
          reportError(coarseErrorMessage(error));
          exitCode = 1;
        }
      }
      exit(exitCode);
    })();
  };

  onSignal('SIGINT', handleSignal);
  onSignal('SIGTERM', handleSignal);

  startupSettled = (async () => {
    server = await startServer({ config, env });
  })();

  try {
    await startupSettled;
  } catch (error) {
    if (shuttingDown) return; // 信号处理路径负责 close+exit。
    throw error;
  }
  // 无信号：正常返回，server 持续运行（信号路径是唯一 close+exit 执行者）。
}
