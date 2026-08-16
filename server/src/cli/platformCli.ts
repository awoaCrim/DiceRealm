import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { credentialKeyPathForDatabase } from '../modules/ai-runtime/CredentialKeyStore.js';
import { EnrollmentError, runEnrollmentCommand, type EnrollmentCommand } from '../platform/ops/EnrollmentCoordinator.js';
import { runSecurityCutover } from '../platform/ops/SecurityCutoverCoordinator.js';

const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../platform/database/migrations/', import.meta.url));

export interface CliIo {
  stdout(line: string): void;
  stderr(line: string): void;
  exit(code: number): void;
}

export interface CliArgs {
  command: string;
  options: Record<string, string>;
}

/** 简单 `--name value` 解析器（不引入第三方 CLI 框架）。 */
export function parseCliArgs(argv: string[]): CliArgs {
  const command = argv[0];
  if (!command || command.startsWith('-')) {
    throw new Error('缺少命令。');
  }
  const options: Record<string, string> = {};
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      throw new Error(`意外的参数：${token}`);
    }
    const name = token.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`缺少 --${name} 的值。`);
    }
    options[name] = value;
    i += 1;
  }
  return { command, options };
}

function requireOption(options: Record<string, string>, name: string): string {
  const value = options[name];
  if (!value) {
    throw new Error(`缺少必选参数 --${name}。`);
  }
  return value;
}

/** 可测试 CLI 入口：命令解析、IO 注入、exit code 语义分离。 */
export async function runPlatformCli(argv: string[], io: CliIo): Promise<void> {
  let parsed: CliArgs;
  try {
    parsed = parseCliArgs(argv);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    io.exit(2);
    return;
  }

  const command = parsed.command;
  const supported = new Set<EnrollmentCommand>(['init', 'enroll', 'resume', 'rollback', 'status']);
  if (command === 'security-cutover') {
    await runCutoverCommand(parsed.options, io);
    return;
  }
  if (!supported.has(command as EnrollmentCommand)) {
    io.stderr(`未知命令：${command}`);
    io.exit(2);
    return;
  }

  try {
    const databasePath = requireOption(parsed.options, 'database');
    const keyPath = parsed.options.key ?? credentialKeyPathForDatabase(databasePath);
    const result = await runEnrollmentCommand({
      command: command as EnrollmentCommand,
      databasePath,
      keyPath,
      migrationsDir: DEFAULT_MIGRATIONS_DIR,
      manifestPath: join(DEFAULT_MIGRATIONS_DIR, 'migrations.manifest.json'),
    });

    for (const message of result.messages) {
      io.stdout(message);
    }
    if (command === 'status') {
      io.stdout(`databaseId: ${result.databaseId}`);
      io.stdout(`enrollment: ${result.enrollmentState}`);
      io.stdout(`keyOrigin: ${result.keyOrigin}`);
      io.stdout(`keyFingerprint: ${result.keyFingerprint}`);
      io.stdout(`sessionSecurity: ${result.sessionSecurityState ?? 'n/a'}`);
      io.stdout(`maintenance: ${result.maintenanceState ?? 'n/a'}`);
    } else if (command === 'init') {
      io.stdout(`databaseId: ${result.databaseId}`);
      io.stdout('fresh instance ready (secure-ready)');
    } else if (command === 'enroll' || command === 'resume') {
      io.stdout(`databaseId: ${result.databaseId}`);
    } else if (command === 'rollback') {
      io.stdout('initializing row removed');
    }
    io.exit(0);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    io.exit(1);
  }
}

async function runCutoverCommand(options: Record<string, string>, io: CliIo): Promise<void> {
  try {
    const databasePath = requireOption(options, 'database');
    const backup = requireOption(options, 'backup');
    const keyPath = options.key ?? credentialKeyPathForDatabase(databasePath);
    const result = await runSecurityCutover({
      databasePath,
      keyPath,
      backupTargetDir: backup,
      migrationsDir: DEFAULT_MIGRATIONS_DIR,
      manifestPath: join(DEFAULT_MIGRATIONS_DIR, 'migrations.manifest.json'),
    });
    for (const message of result.messages) {
      io.stdout(message);
    }
    io.stdout(`sessionSecurity: ${result.sessionSecurityState}`);
    io.stdout(`oldSessions: ${result.oldSessionCount}`);
    for (const migration of result.appliedMigrations) {
      io.stdout(`applied: ${migration}`);
    }
    io.exit(0);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    io.exit(1);
  }
}

// 生产入口：`npm run platform:cli -- <command> ...`。
const isMain = typeof process !== 'undefined'
  && process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await runPlatformCli(process.argv.slice(2), {
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
    exit: (code) => process.exit(code),
  });
}
