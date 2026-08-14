import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../config.js';
import { runServerWithSignals } from './runServerWithSignals.js';
import type { RunningPlatformServer } from './startPlatformServer.js';

const config: AppConfig = { host: '127.0.0.1', port: 0, databasePath: ':memory:' };

interface CapturedHandlers {
  handlers: Map<NodeJS.Signals, () => void>;
  on: (signal: NodeJS.Signals, handler: () => void) => void;
}

function captureSignals(): CapturedHandlers {
  const handlers = new Map<NodeJS.Signals, () => void>();
  return {
    handlers,
    on: (signal, handler) => {
      handlers.set(signal, handler);
    },
  };
}

function fakeServer(): RunningPlatformServer & { closeCalls: number } {
  const state = { closeCalls: 0 };
  const server = {
    close: async () => {
      state.closeCalls += 1;
    },
  } as unknown as RunningPlatformServer & { closeCalls: number };
  Object.defineProperty(server, 'closeCalls', { get: () => state.closeCalls });
  return server;
}

describe('runServerWithSignals', () => {
  it('starts normally and registers signal handlers without exiting when no signal arrives', async () => {
    const signals = captureSignals();
    const exitCalls: number[] = [];
    const server = fakeServer();
    await runServerWithSignals({
      config,
      env: {},
      onSignal: signals.on,
      startServer: async () => server,
      exit: ((code?: number) => {
        exitCalls.push(code ?? 0);
      }) as unknown as (code?: number) => never,
    });
    expect(signals.handlers.has('SIGINT')).toBe(true);
    expect(signals.handlers.has('SIGTERM')).toBe(true);
    expect(exitCalls).toEqual([]);
    expect(server.closeCalls).toBe(0);
  });

  it('closes the server and exits when a signal arrives after startup completed', async () => {
    const signals = captureSignals();
    const exitCalls: number[] = [];
    const server = fakeServer();
    await runServerWithSignals({
      config,
      env: {},
      onSignal: signals.on,
      startServer: async () => server,
      exit: ((code?: number) => {
        exitCalls.push(code ?? 0);
      }) as unknown as (code?: number) => never,
    });
    signals.handlers.get('SIGTERM')!();
    await Promise.resolve(); // 让 handler 的 async 清理完成
    await Promise.resolve();
    expect(server.closeCalls).toBe(1);
    expect(exitCalls).toEqual([0]);
  });

  it('waits for startup to settle when a signal arrives during startup, then closes the server and exits', async () => {
    const signals = captureSignals();
    const exitCalls: number[] = [];
    const server = fakeServer();
    let resolveStart!: (value: RunningPlatformServer) => void;
    const pending = new Promise<RunningPlatformServer>((resolve) => {
      resolveStart = resolve;
    });
    const started = runServerWithSignals({
      config,
      env: {},
      onSignal: signals.on,
      startServer: async () => pending,
      exit: ((code?: number) => {
        exitCalls.push(code ?? 0);
      }) as unknown as (code?: number) => never,
    });
    // 启动仍在进行：发送 SIGINT。
    signals.handlers.get('SIGINT')!();
    // 启动随后成功 settle。
    resolveStart(server);
    await started;
    // 信号 handler 的 close→exit 链在微任务中完成；用 setImmediate 排空微任务队列后再断言。
    await new Promise<void>((resolve) => setImmediate(() => resolve()));
    expect(server.closeCalls).toBe(1);
    expect(exitCalls).toEqual([0]);
  });

  it('reports a coarse error and exits non-zero when a signal arrives during startup and startup fails', async () => {
    const signals = captureSignals();
    const exitCalls: number[] = [];
    const reported: string[] = [];
    const server = fakeServer();
    const started = runServerWithSignals({
      config,
      env: {},
      onSignal: signals.on,
      reportError: (message) => reported.push(message),
      startServer: async () => {
        throw new Error('startup boom');
      },
      exit: ((code?: number) => {
        exitCalls.push(code ?? 0);
      }) as unknown as (code?: number) => never,
    });
    signals.handlers.get('SIGINT')!();
    await expect(started).resolves.toBeUndefined();
    expect(server.closeCalls).toBe(0);
    // 启动失败且收到信号：报告粗粒度错误并以非零码退出（不打印密钥/堆栈）。
    expect(exitCalls).toEqual([1]);
    expect(reported.join('\n')).toContain('startup boom');
    expect(reported.join('\n')).toContain('启动或关闭失败');
  });

  it('reports a coarse error and exits non-zero when server.close rejects during graceful shutdown', async () => {
    const signals = captureSignals();
    const exitCalls: number[] = [];
    const reported: string[] = [];
    const server = {
      close: async () => {
        throw new Error('close boom');
      },
    } as unknown as RunningPlatformServer;
    await runServerWithSignals({
      config,
      env: {},
      onSignal: signals.on,
      reportError: (message) => reported.push(message),
      startServer: async () => server,
      exit: ((code?: number) => {
        exitCalls.push(code ?? 0);
      }) as unknown as (code?: number) => never,
    });
    signals.handlers.get('SIGINT')!();
    await new Promise<void>((resolve) => setImmediate(() => resolve()));
    // close 失败：报告粗粒度错误并以非零码退出。
    expect(exitCalls).toEqual([1]);
    expect(reported.join('\n')).toContain('close boom');
    expect(reported.join('\n')).not.toContain('at '); // 不泄漏堆栈
  });

  it('rethrows startup failure when no signal was received', async () => {
    const signals = captureSignals();
    await expect(
      runServerWithSignals({
        config,
        env: {},
        onSignal: signals.on,
        startServer: async () => {
          throw new Error('startup boom');
        },
        exit: ((code?: number) => {
          throw new Error(`unexpected exit ${code}`);
        }) as unknown as (code?: number) => never,
      }),
    ).rejects.toThrow('startup boom');
  });

  it('ignores a second signal while already shutting down (close once)', async () => {
    const signals = captureSignals();
    const exitCalls: number[] = [];
    const server = fakeServer();
    await runServerWithSignals({
      config,
      env: {},
      onSignal: signals.on,
      startServer: async () => server,
      exit: ((code?: number) => {
        exitCalls.push(code ?? 0);
      }) as unknown as (code?: number) => never,
    });
    signals.handlers.get('SIGINT')!();
    signals.handlers.get('SIGTERM')!(); // 第二次信号被忽略
    await new Promise<void>((resolve) => setImmediate(() => resolve()));
    expect(server.closeCalls).toBe(1);
    expect(exitCalls).toEqual([0]);
  });

  it('passes env through to the server starter', async () => {
    const signals = captureSignals();
    const seen: Array<Record<string, string | undefined>> = [];
    await runServerWithSignals({
      config,
      env: { AI_PROVIDER: 'unavailable' },
      onSignal: signals.on,
      startServer: async (options) => {
        seen.push(options.env);
        return fakeServer();
      },
      exit: vi.fn() as unknown as (code?: number) => never,
    });
    expect(seen).toEqual([{ AI_PROVIDER: 'unavailable' }]);
  });
});
