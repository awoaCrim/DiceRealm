import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { loadEnvFile as loadNodeEnvFile } from 'node:process';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer, type InlineConfig, type ViteDevServer } from 'vite';
import type { AppConfig } from '../server/src/config.js';

export type DevelopmentPlatformConfig = AppConfig;

export interface DevelopmentPlatformServer {
  close(): Promise<void>;
}

export interface DevelopmentViteServer {
  listen(): Promise<unknown>;
  close(): Promise<void>;
  printUrls?(): void;
}

export interface DevelopmentSignalHandlers {
  onSignal(signal: NodeJS.Signals, handler: () => void): void;
}

export interface DevelopmentCoordinatorOptions {
  startPlatformServer(): Promise<DevelopmentPlatformServer>;
  createViteServer(): Promise<DevelopmentViteServer>;
  onSignal?: DevelopmentSignalHandlers['onSignal'];
  exit?: (code: number) => void;
  reportError?: (message: string) => void;
}

interface PlatformRuntime {
  loadConfig(): DevelopmentPlatformConfig;
  startPlatformServer(options: {
    config: DevelopmentPlatformConfig;
    env: Record<string, string | undefined>;
  }): Promise<DevelopmentPlatformServer>;
}

export interface DevelopmentMainDependencies {
  loadEnvFile?: (path: string) => void;
  loadPlatformRuntime?: () => Promise<PlatformRuntime>;
  createViteServer?: () => Promise<DevelopmentViteServer>;
  runCoordinator?: (options: DevelopmentCoordinatorOptions) => Promise<void>;
}

const REPOSITORY_ROOT = fileURLToPath(new URL('../', import.meta.url));
export const SERVER_DIRECTORY = resolve(REPOSITORY_ROOT, 'server');
export const SERVER_ENV_PATH = resolve(SERVER_DIRECTORY, '.env');
export const CLIENT_DIRECTORY = resolve(REPOSITORY_ROOT, 'client');
export const CLIENT_VITE_CONFIG_PATH = resolve(CLIENT_DIRECTORY, 'vite.config.ts');

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code;
}

function coarseErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return '[dev] startup or shutdown failed for an unknown reason.';
  const message = error.message || error.name;
  return `[dev] startup or shutdown failed: ${message.length > 300 ? `${message.slice(0, 300)}…` : message}`;
}

async function closeDevelopmentResources(
  viteServer: DevelopmentViteServer | null,
  platformServer: DevelopmentPlatformServer | null,
): Promise<void> {
  const errors: unknown[] = [];
  if (viteServer !== null) {
    try {
      await viteServer.close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (platformServer !== null) {
    try {
      await platformServer.close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw errors[0];
}

/**
 * Owns the complete development lifecycle in one Node process.
 *
 * Signal handlers are registered before either server starts. A signal received
 * during startup prevents the next startup phase, waits for the current phase to
 * settle, then closes every acquired resource. Shutdown is idempotent and always
 * awaits Vite before the Platform Server so the SQLite InstanceLock is released
 * only after the frontend has stopped issuing proxied requests.
 */
export async function runDevelopmentCoordinator(options: DevelopmentCoordinatorOptions): Promise<void> {
  const onSignal = options.onSignal ?? ((signal, handler) => process.on(signal, handler));
  const exit = options.exit ?? ((code) => process.exit(code));
  const reportError = options.reportError ?? ((message) => console.error(message));

  let platformServer: DevelopmentPlatformServer | null = null;
  let viteServer: DevelopmentViteServer | null = null;
  let shutdownRequested = false;
  let closePromise: Promise<void> | null = null;
  let resolveStartupOutcome!: (outcome: { error?: unknown }) => void;
  const startupOutcome = new Promise<{ error?: unknown }>((resolveOutcome) => {
    resolveStartupOutcome = resolveOutcome;
  });

  const closeOnce = (): Promise<void> => {
    closePromise ??= closeDevelopmentResources(viteServer, platformServer);
    return closePromise;
  };

  const handleSignal = (): void => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    void (async () => {
      let exitCode = 0;
      const outcome = await startupOutcome;
      if (outcome.error !== undefined) {
        reportError(coarseErrorMessage(outcome.error));
        exitCode = 1;
      }
      try {
        await closeOnce();
      } catch (error) {
        reportError(coarseErrorMessage(error));
        exitCode = 1;
      }
      exit(exitCode);
    })();
  };

  onSignal('SIGINT', handleSignal);
  onSignal('SIGTERM', handleSignal);

  const startupPromise = (async () => {
    try {
      platformServer = await options.startPlatformServer();
      if (shutdownRequested) return;

      viteServer = await options.createViteServer();
      if (shutdownRequested) return;

      await viteServer.listen();
      if (shutdownRequested) return;
      viteServer.printUrls?.();
    } catch (error) {
      try {
        await closeOnce();
      } catch {
        // Preserve the startup failure; closeOnce still attempted both resources.
      }
      throw error;
    }
  })();

  void startupPromise.then(
    () => resolveStartupOutcome({}),
    (error: unknown) => resolveStartupOutcome({ error }),
  );

  try {
    await startupPromise;
  } catch (error) {
    if (shutdownRequested) return;
    throw error;
  }
}

export function developmentViteInlineConfig(parentServer: HttpServer): InlineConfig {
  return {
    root: CLIENT_DIRECTORY,
    configFile: CLIENT_VITE_CONFIG_PATH,
    // Middleware mode prevents Vite from installing its own SIGTERM handler,
    // which calls process.exit() before the Platform Server can release its lock.
    // The repository coordinator owns this HTTP server and every shutdown step.
    server: {
      host: '0.0.0.0',
      middlewareMode: { server: parentServer },
    },
  };
}

async function listenHttpServer(
  server: HttpServer,
  options: { host: string; port: number; strictPort: boolean; log(message: string): void },
): Promise<number> {
  for (let port = options.port; port <= 65_535; port += 1) {
    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        const onError = (error: Error): void => {
          server.off('listening', onListening);
          rejectListen(error);
        };
        const onListening = (): void => {
          server.off('error', onError);
          resolveListen();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, options.host);
      });
      return port;
    } catch (error) {
      if (!isErrno(error, 'EADDRINUSE')) throw error;
      if (options.strictPort) throw new Error(`Port ${port} is already in use`);
      options.log(`Port ${port} is in use, trying another one...`);
    }
  }
  throw new Error(`No available ports found between ${options.port} and 65535`);
}

export async function createRepositoryViteServer(): Promise<DevelopmentViteServer> {
  const parentServer = createHttpServer();
  const vite = await createViteServer(developmentViteInlineConfig(parentServer));
  parentServer.on('request', vite.middlewares);

  let listeningPort: number | null = null;
  let closePromise: Promise<void> | null = null;
  return {
    listen: async () => {
      const serverConfig = vite.config.server;
      const host = typeof serverConfig.host === 'string' ? serverConfig.host : '0.0.0.0';
      listeningPort = await listenHttpServer(parentServer, {
        host,
        port: serverConfig.port ?? 5173,
        strictPort: serverConfig.strictPort,
        log: (message) => vite.config.logger.info(message),
      });
      return listeningPort;
    },
    close: async () => {
      closePromise ??= (async () => {
        let resolveHttpClose: (() => void) | null = null;
        let rejectHttpClose: ((error: Error) => void) | null = null;
        const httpClosed = parentServer.listening
          ? new Promise<void>((resolveClose, rejectClose) => {
              resolveHttpClose = resolveClose;
              rejectHttpClose = rejectClose;
            })
          : Promise.resolve();

        if (parentServer.listening) {
          parentServer.close((error) => {
            if (error) rejectHttpClose?.(error);
            else resolveHttpClose?.();
          });
        }

        let viteError: unknown;
        try {
          await vite.close();
        } catch (error) {
          viteError = error;
        }
        parentServer.closeAllConnections?.();
        await httpClosed;
        if (viteError !== undefined) throw viteError;
      })();
      await closePromise;
    },
    printUrls: () => {
      if (listeningPort !== null) console.log(`[dev] Vite: http://localhost:${listeningPort}/`);
    },
  };
}

function loadServerEnvironment(loadEnvFile: (path: string) => void): void {
  try {
    loadEnvFile(SERVER_ENV_PATH);
  } catch (error) {
    // server/.env is optional, but when present it must be read before config.ts
    // is imported. Ignore only a genuinely absent file.
    if (!isErrno(error, 'ENOENT')) throw error;
  }
}

async function loadRepositoryPlatformRuntime(): Promise<PlatformRuntime> {
  const [configModule, startupModule] = await Promise.all([
    import('../server/src/config.js'),
    import('../server/src/platform/startup/startPlatformServer.js'),
  ]);
  return {
    loadConfig: configModule.loadConfig,
    startPlatformServer: startupModule.startPlatformServer,
  };
}

async function loadPlatformRuntimeWithServerEnv(
  loadRuntime: () => Promise<PlatformRuntime>,
): Promise<PlatformRuntime> {
  // config.ts still imports dotenv/config for the direct Server entrypoint.
  // Pin that import to server/.env so root `npm run dev` cannot also consume a
  // repository-root .env merely because its process.cwd() is the repository.
  const previousDotenvPath = process.env.DOTENV_CONFIG_PATH;
  process.env.DOTENV_CONFIG_PATH = SERVER_ENV_PATH;
  try {
    return await loadRuntime();
  } finally {
    if (previousDotenvPath === undefined) delete process.env.DOTENV_CONFIG_PATH;
    else process.env.DOTENV_CONFIG_PATH = previousDotenvPath;
  }
}

function resolveServerDatabasePath(databasePath: string): string {
  if (databasePath === ':memory:' || isAbsolute(databasePath)) return databasePath;
  // `npm run dev --workspace server` historically evaluated relative paths from
  // server/. Keep that behavior now that the owner process starts at repo root.
  return resolve(SERVER_DIRECTORY, databasePath);
}

export async function runDevelopmentMain(dependencies: DevelopmentMainDependencies = {}): Promise<void> {
  loadServerEnvironment(dependencies.loadEnvFile ?? loadNodeEnvFile);

  // This import is deliberately dynamic and after loadServerEnvironment: the
  // server config module imports dotenv/config and evaluates process.env.
  const runtime = await loadPlatformRuntimeWithServerEnv(
    dependencies.loadPlatformRuntime ?? loadRepositoryPlatformRuntime,
  );
  const loadedConfig = runtime.loadConfig();
  const config = {
    ...loadedConfig,
    databasePath: resolveServerDatabasePath(loadedConfig.databasePath),
  };

  const runCoordinator = dependencies.runCoordinator ?? runDevelopmentCoordinator;
  await runCoordinator({
    startPlatformServer: () => runtime.startPlatformServer({ config, env: process.env }),
    createViteServer: dependencies.createViteServer ?? createRepositoryViteServer,
  });
}

const isMain = process.argv[1]
  ? fileURLToPath(import.meta.url) === resolve(process.argv[1])
  : false;

if (isMain) {
  runDevelopmentMain().catch((error: unknown) => {
    console.error(coarseErrorMessage(error));
    process.exitCode = 1;
  });
}
