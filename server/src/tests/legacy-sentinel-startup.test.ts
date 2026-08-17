import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseSecurityConfig } from '../config.js';

import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { startPlatformServer } from '../platform/startup/startPlatformServer.js';
import { StartupSecurityError } from '../platform/startup/StartupSecurityGate.js';
import { runEnrollmentCommand } from '../platform/ops/EnrollmentCoordinator.js';
import { fileURLToPath } from 'node:url';
import { captureLegacySnapshot, makeLegacyFixture } from './phase2LegacySentinel.js';
import { PHASE3_APPROVED_MIGRATION_FILENAMES } from '../platform/ops/approvedMigrations.js';
import { createExistingDb001_010, commitMigrationsDir, commitManifestPath, tempDir } from './phase2StartupHelpers.js';

describe('legacy sentinel startup (Phase 2 fail-closed)', () => {
  it('leaves existing legacy schema and rows byte-identical when startup fails closed on an unenrolled DB', async () => {
    const dir = tempDir('dnd-sentinel-existing-');
    try {
      const databasePath = join(dir, 'db.sqlite');
      // 1) 手工建 legacy fixture + 当前 Phase 1 基线（无 012，无 enrollment）。
      createExistingDb001_010(databasePath);
      const fixtureRaw = new Database(databasePath);
      fixtureRaw.pragma('foreign_keys = ON');
      makeLegacyFixture(fixtureRaw);
      const before = captureLegacySnapshot(fixtureRaw);
      fixtureRaw.close();

      // 2) 普通 server 启动必须 fail closed（enrollment 提示），且不触碰 legacy 数据。
      await expect(startPlatformServer({
        config: { host: '127.0.0.1', port: 0, databasePath },
        env: {},
        migrationsDir: commitMigrationsDir(),
        credentialKeyPath: join(dir, '.dnd-ai-credential-key'),
      })).rejects.toThrow(StartupSecurityError);

      // 3) legacy snapshot 逐项相等。
      const afterRaw = new Database(databasePath, { readonly: true });
      try {
        const after = captureLegacySnapshot(afterRaw);
        expect(after.ddl).toBe(before.ddl);
        expect(after.rows).toBe(before.rows);
      } finally {
        afterRaw.close();
      }
      // 4) 关闭后 lock 消失。
      expect(existsSync(join(dir, '.dnd-instance.lock'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('init never creates legacy tables or schema_migrations, and a secure-ready instance starts normally', async () => {
    const dir = tempDir('dnd-sentinel-fresh-');
    try {
      const databasePath = join(dir, 'fresh.sqlite');
      const keyPath = join(dir, '.dnd-ai-credential-key');
      await runEnrollmentCommand({
        command: 'init',
        databasePath,
        keyPath,
        migrationsDir: commitMigrationsDir(),
        manifestPath: commitManifestPath(),
      });
      const raw = new Database(databasePath, { readonly: true });
      try {
        for (const legacy of ['schema_migrations', 'rooms', 'players', 'characters', 'rule_sources']) {
          const rows = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").all(legacy) as Array<{ name: string }>;
          expect(rows, legacy).toEqual([]);
        }
        const platform = raw.prepare('SELECT version FROM platform_migrations ORDER BY version').all() as Array<{ version: string }>;
        expect(platform.length).toBe(PHASE3_APPROVED_MIGRATION_FILENAMES.length);
      } finally {
        raw.close();
      }
      // secure-ready：普通 server 正常完成 pre-listen startup，legacy 仍不存在，锁释放。
      await startPlatformServer({
        config: { host: '127.0.0.1', port: 0, databasePath, security: parseSecurityConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: 'https://127.0.0.1' }) },
        env: {},
        migrationsDir: commitMigrationsDir(),
        credentialKeyPath: keyPath,
        listen: async (app) => {
          const server = app.listen(0);
          await new Promise<void>((resolve) => server.once('listening', () => resolve()));
          const closed = new Promise<void>((resolve) => server.once('close', resolve));
          return {
            stopAccepting: async () => { server.close(); },
            destroyConnections: async () => { server.closeAllConnections(); await closed; },
          };
        },
      }).then((running) => running.close());
      expect(existsSync(join(dir, '.dnd-instance.lock'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
