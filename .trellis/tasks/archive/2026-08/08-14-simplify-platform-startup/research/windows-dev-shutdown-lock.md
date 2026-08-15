# Windows dev shutdown leaves a stale instance lock

Date: 2026-08-15

## Reported behavior

On Windows, the repository-root development command starts normally, but pressing Ctrl+C can leave `server/.dev/.dnd-instance.lock`. The next `npm run dev` fails closed with `InstanceLockError` even though the recorded owner process and the port-3000 listener no longer exist.

During investigation, multiple well-formed lock files were observed whose recorded PIDs no longer existed. This distinguishes the failure from real lock contention.

## Process tree

The current commands form this tree:

```text
npm run dev
  -> concurrently 9.2.1
       -> npm run dev --workspace server
            -> tsx watch src/index.ts
                 -> server child that owns InstanceLock
       -> tsx scripts/wait-for-dev-server.ts && npm run dev --workspace client
```

The server itself has a graceful signal path: `runServerWithSignals()` waits for `RunningPlatformServer.close()`, and `startPlatformServer()` closes HTTP/SSE connections, the database, and finally releases the lock. Unit tests prove that path only when the handler is invoked inside the server process.

## Root cause

`concurrently` always installs its `KillOnSignal` controller. On `SIGINT`, it calls `command.kill('SIGINT')` for each command. Its default kill implementation is `tree-kill`.

On Windows, `tree-kill` does not deliver the requested graceful signal. Its implementation executes:

```text
taskkill /pid <pid> /T /F
```

The `/F` termination kills the workspace npm/tsx/server process tree before the server's asynchronous close sequence can release the instance lock.

A local Node probe also confirmed that `ChildProcess.kill('SIGINT')` on Windows is not a safe replacement: the child signal handler did not run, and the process closed as killed by `SIGINT`. Therefore a custom supervisor must not attempt to make Windows shutdown graceful merely by forwarding `SIGINT` with `child.kill()`.

`tsx watch` has the same class of risk for backend restarts: its watch supervisor calls `child.kill('SIGTERM')`; on Windows this is an abrupt termination rather than an awaited application-level shutdown. A lock-owning backend should therefore not sit beneath that watcher unless restart is coordinated through an application-level close protocol.

## Fix boundary

Fix the development lifecycle, not the lock ownership rule:

- replace the repository-root `concurrently` process tree with a repository-owned, single-process dev coordinator;
- run the TypeScript coordinator directly with `node --import tsx`, so the lock owner and coordinator share one Node process rather than relying on Windows child signals;
- start the backend through the normal startup API and start Vite programmatically only after backend startup succeeds;
- register signals before startup, await Vite/backend close, and release the lock before process exit;
- remove `tsx watch` from the lock-owning server development path unless a future watcher uses an explicit application-level shutdown handshake;
- retain fail-closed handling for arbitrary/corrupt/foreign lock files; do not solve the bug by blindly unlinking a lock.

Frontend HMR remains provided by Vite. Backend source changes require an orderly Ctrl+C/restart in the focused fix; transparent backend restart is not worth reintroducing forced termination at the instance-lock boundary.

## Regression loop

The implementation should cover both in-process lifecycle tests and an observable development-command check:

1. Start against a temporary copied/initialized data directory.
2. Wait for backend and Vite readiness.
3. Invoke the coordinator's graceful shutdown path.
4. Assert the lock file is absent and the recorded lock-owner PID is gone.
5. Start again immediately against the same data directory and assert success.
6. Verify startup failure and partial startup also close any already-created resource.

On Windows, include a manual or platform-specific smoke check using an actual console Ctrl+C. A test that calls `ChildProcess.kill('SIGINT')` is not equivalent and must not be treated as proof of graceful shutdown.

## Implemented development seam

The focused implementation replaces the process tree with `scripts/devCoordinator.ts`, launched by `node --import tsx`. The coordinator starts the Platform Server directly, then mounts Vite in middleware mode on a coordinator-owned Node HTTP server. Middleware mode is required because standalone Vite 8 installs a `SIGTERM` handler that closes Vite and calls `process.exit()` without waiting for the Platform Server; the owned HTTP server keeps all exit authority in the coordinator while retaining the existing proxy and HMR behavior.

The coordinator explicitly loads `server/.env` and temporarily pins `DOTENV_CONFIG_PATH` to that same file while importing the existing `dotenv/config`-using Server config module. This prevents a repository-root `.env` from being consumed merely because the new process starts at repository root, and the previous `DOTENV_CONFIG_PATH` value is restored afterward.

Automated coverage now proves startup/close ordering, partial-start cleanup, signal-during-startup behavior, repeated-signal idempotency, real InstanceLock release/reacquisition, real Vite HTTP/HMR middleware startup, no competing Vite `SIGTERM` listener, environment-path isolation, type checking, and build behavior. The remaining manual gate is an actual Windows console Ctrl+C followed by an immediate second `npm run dev` against the same data directory.
