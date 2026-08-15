import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireInstanceLock } from '../server/src/platform/ops/InstanceLock.js';
import {
  CLIENT_DIRECTORY,
  CLIENT_VITE_CONFIG_PATH,
  SERVER_DIRECTORY,
  createRepositoryViteServer,
  developmentViteInlineConfig,
  runDevelopmentCoordinator,
  runDevelopmentMain,
  type DevelopmentSignalHandlers,
  type DevelopmentViteServer,
} from './devCoordinator.js';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function captureSignals(): DevelopmentSignalHandlers & {
  handlers: Map<NodeJS.Signals, () => void>;
} {
  const handlers = new Map<NodeJS.Signals, () => void>();
  return {
    handlers,
    onSignal: (signal, handler) => {
      handlers.set(signal, handler);
    },
  };
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
}

const tempDirectories: string[] = [];
afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('development coordinator lifecycle', () => {
  it('starts the Platform Server before Vite and closes Vite before the Platform Server', async () => {
    const events: string[] = [];
    const signals = captureSignals();
    const exitCalls: number[] = [];

    await runDevelopmentCoordinator({
      startPlatformServer: async () => {
        events.push('start.platform');
        return { close: async () => { events.push('close.platform'); } };
      },
      createViteServer: async () => {
        events.push('create.vite');
        return {
          listen: async () => { events.push('listen.vite'); },
          close: async () => { events.push('close.vite'); },
        };
      },
      onSignal: signals.onSignal,
      exit: (code) => { exitCalls.push(code); },
    });

    expect(events).toEqual(['start.platform', 'create.vite', 'listen.vite']);
    signals.handlers.get('SIGINT')!();
    await nextTurn();

    expect(events).toEqual([
      'start.platform',
      'create.vite',
      'listen.vite',
      'close.vite',
      'close.platform',
    ]);
    expect(exitCalls).toEqual([0]);
  });

  it('cleans up both partial resources when Vite startup fails', async () => {
    const events: string[] = [];

    await expect(runDevelopmentCoordinator({
      startPlatformServer: async () => {
        events.push('start.platform');
        return { close: async () => { events.push('close.platform'); } };
      },
      createViteServer: async (): Promise<DevelopmentViteServer> => {
        events.push('create.vite');
        return {
          listen: async () => {
            events.push('listen.vite');
            throw new Error('vite listen failed');
          },
          close: async () => { events.push('close.vite'); },
        };
      },
      onSignal: vi.fn(),
      exit: vi.fn(),
    })).rejects.toThrow('vite listen failed');

    expect(events).toEqual([
      'start.platform',
      'create.vite',
      'listen.vite',
      'close.vite',
      'close.platform',
    ]);
  });

  it('handles a signal during Platform startup without starting Vite', async () => {
    const signals = captureSignals();
    const platformStarted = deferred<{ close(): Promise<void> }>();
    const events: string[] = [];
    const exitCalls: number[] = [];

    const running = runDevelopmentCoordinator({
      startPlatformServer: async () => platformStarted.promise,
      createViteServer: async () => {
        events.push('create.vite');
        return {
          listen: async () => undefined,
          close: async () => undefined,
        };
      },
      onSignal: signals.onSignal,
      exit: (code) => { exitCalls.push(code); },
    });

    signals.handlers.get('SIGTERM')!();
    platformStarted.resolve({
      close: async () => { events.push('close.platform'); },
    });
    await running;
    await nextTurn();

    expect(events).toEqual(['close.platform']);
    expect(exitCalls).toEqual([0]);
  });

  it('makes repeated signals idempotent and awaits both close operations before exiting', async () => {
    const signals = captureSignals();
    const events: string[] = [];
    const exitCalls: number[] = [];
    const allowViteClose = deferred<void>();

    await runDevelopmentCoordinator({
      startPlatformServer: async () => ({
        close: async () => { events.push('close.platform'); },
      }),
      createViteServer: async () => ({
        listen: async () => undefined,
        close: async () => {
          events.push('close.vite.begin');
          await allowViteClose.promise;
          events.push('close.vite.end');
        },
      }),
      onSignal: signals.onSignal,
      exit: (code) => { exitCalls.push(code); },
    });

    signals.handlers.get('SIGINT')!();
    signals.handlers.get('SIGINT')!();
    signals.handlers.get('SIGTERM')!();
    await nextTurn();
    expect(events).toEqual(['close.vite.begin']);
    expect(exitCalls).toEqual([]);

    allowViteClose.resolve();
    await nextTurn();
    expect(events).toEqual(['close.vite.begin', 'close.vite.end', 'close.platform']);
    expect(exitCalls).toEqual([0]);
  });

  it('still closes the Platform Server when Vite close fails', async () => {
    const signals = captureSignals();
    const events: string[] = [];
    const exitCalls: number[] = [];
    const reported: string[] = [];

    await runDevelopmentCoordinator({
      startPlatformServer: async () => ({
        close: async () => { events.push('close.platform'); },
      }),
      createViteServer: async () => ({
        listen: async () => undefined,
        close: async () => {
          events.push('close.vite');
          throw new Error('vite close failed');
        },
      }),
      onSignal: signals.onSignal,
      reportError: (message) => { reported.push(message); },
      exit: (code) => { exitCalls.push(code); },
    });

    signals.handlers.get('SIGTERM')!();
    await nextTurn();

    expect(events).toEqual(['close.vite', 'close.platform']);
    expect(reported.join('\n')).toContain('vite close failed');
    expect(exitCalls).toEqual([1]);
  });

  it('releases the real instance lock before reporting shutdown complete so restart is immediate', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dnd-dev-coordinator-lock-'));
    tempDirectories.push(directory);
    const databasePath = join(directory, 'dnd.sqlite');
    writeFileSync(databasePath, '', 'utf8');
    const lock = acquireInstanceLock({ databasePath, purpose: 'server' });
    const signals = captureSignals();
    const exited = deferred<number>();

    await runDevelopmentCoordinator({
      startPlatformServer: async () => ({ close: async () => { lock.release(); } }),
      createViteServer: async () => ({
        listen: async () => undefined,
        close: async () => undefined,
      }),
      onSignal: signals.onSignal,
      exit: (code) => { exited.resolve(code); },
    });

    signals.handlers.get('SIGINT')!();
    await expect(exited.promise).resolves.toBe(0);
    expect(existsSync(join(directory, '.dnd-instance.lock'))).toBe(false);

    const restarted = acquireInstanceLock({ databasePath, purpose: 'server' });
    restarted.release();
  });
});

describe('development coordinator production wiring', () => {
  it('loads only server/.env before importing and evaluating server config', async () => {
    const order: string[] = [];
    let seenDatabasePath = '';
    const previousDotenvPath = process.env.DOTENV_CONFIG_PATH;
    delete process.env.DOTENV_CONFIG_PATH;

    try {
      await runDevelopmentMain({
        loadEnvFile: (path) => {
          order.push(`env:${path}`);
        },
        loadPlatformRuntime: async () => {
          expect(process.env.DOTENV_CONFIG_PATH).toMatch(/server[\\/]\.env$/);
          order.push('runtime.import');
          return {
            loadConfig: () => {
              order.push('config.load');
              return {
                host: '127.0.0.1',
                port: 3000,
                databasePath: 'fixture.sqlite',
              };
            },
            startPlatformServer: async ({ config }) => {
              seenDatabasePath = config.databasePath;
              return { close: async () => undefined };
            },
          };
        },
        createViteServer: async () => ({
          listen: async () => undefined,
          close: async () => undefined,
        }),
        runCoordinator: async (options) => {
          order.push('coordinator.run');
          const platform = await options.startPlatformServer();
          await platform.close();
        },
      });

      expect(order[0]).toMatch(/^env:.*server[\\/]\.env$/);
      expect(order).toEqual([
        order[0],
        'runtime.import',
        'config.load',
        'coordinator.run',
      ]);
      expect(seenDatabasePath).toBe(resolve(SERVER_DIRECTORY, 'fixture.sqlite'));
      expect(process.env.DOTENV_CONFIG_PATH).toBeUndefined();
    } finally {
      if (previousDotenvPath === undefined) delete process.env.DOTENV_CONFIG_PATH;
      else process.env.DOTENV_CONFIG_PATH = previousDotenvPath;
    }
  });

  it('uses Vite middleware mode with a coordinator-owned HTTP server', () => {
    const parentServer = createHttpServer();
    expect(developmentViteInlineConfig(parentServer)).toEqual({
      root: CLIENT_DIRECTORY,
      configFile: CLIENT_VITE_CONFIG_PATH,
      server: {
        host: '0.0.0.0',
        middlewareMode: { server: parentServer },
      },
    });
    parentServer.close();
  });

  it('serves the real Vite app without installing a competing SIGTERM process-exit handler', async () => {
    const before = process.rawListeners('SIGTERM');
    const vite = await createRepositoryViteServer();
    try {
      expect(process.rawListeners('SIGTERM')).toEqual(before);
      const port = await vite.listen();
      expect(typeof port).toBe('number');
      const response = await fetch(`http://127.0.0.1:${String(port)}/@vite/client`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('createHotContext');
      // Let Vite's background dependency scan settle before the test closes it.
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 500));
    } finally {
      await vite.close();
    }
  });

  it('uses the single-process coordinator for root dev and disables tsx watch for direct server dev', () => {
    const rootPackage = JSON.parse(readFileSync(resolve(CLIENT_DIRECTORY, '..', 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const serverPackage = JSON.parse(readFileSync(resolve(SERVER_DIRECTORY, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(rootPackage.scripts.dev).toBe('node --import tsx scripts/devCoordinator.ts');
    expect(rootPackage.devDependencies).not.toHaveProperty('concurrently');
    expect(serverPackage.scripts.dev).toBe('node --import tsx src/index.ts');
    expect(serverPackage.scripts.dev).not.toContain('watch');
  });
});
