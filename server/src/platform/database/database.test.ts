import { copyFileSync, cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from './SqliteDatabaseAdapter.js';
import { MigrationRunner, PLATFORM_MIGRATION_INSERT_SQL } from './migrations/MigrationRunner.js';
import type { MigrationToApply } from './DatabasePort.js';
import { defineSqliteDatabaseContractSuite } from './databaseContractSuite.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

defineSqliteDatabaseContractSuite();

describe('database adapter', () => {
  it('creates the initial platform tables after migrate', async () => {
    const db = createSqliteDatabase(':memory:');
    await db.migrate();
    for (const table of ['users', 'sessions', 'campaigns', 'campaign_members', 'platform_ai_provider_configs', 'platform_instance', 'platform_administrators', 'platform_registration_invites', 'platform_security_audit_events']) {
      const rows = await db.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        [table],
      );
      expect(rows.map((row) => row.name)).toContain(table);
    }
    await db.close();
  });

  it('rolls back the first failed migration in a batch', async () => {
    const db = createSqliteDatabase(':memory:');
    await db.migrate();
    await expect(
      db.exec(`
        CREATE TABLE IF NOT EXISTS _migration_test_partial (a TEXT);
        CREATE TABLE _migration_test_should_not_exist (a TEXT, b TEXT, c TEXT, d TEXT);
        INSERT INTO _migration_test_should_not_exist (a, b, c, d) VALUES (1, 1, 1, 1, 1);
      `),
    ).rejects.toThrow();
    const rows = await db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      ['_migration_test_partial'],
    );
    expect(rows).toEqual([]);
    await db.close();
  });
});

describe('transaction serialization', () => {
  it('serializes two overlapping async transactions without a nested BEGIN error', async () => {
    const db = createSqliteDatabase(':memory:');
    await db.migrate();
    const order: string[] = [];
    // 两个 transaction 同时发起：互斥队列必须串行执行，第二个不得因 BEGIN 冲突报裸 SQLITE_ERROR。
    const first = db.transaction(async (tx) => {
      order.push('first-start');
      await tx.execute(
        'INSERT INTO users (id, login, password_hash) VALUES (?, ?, ?)',
        ['t-1', 'serialized-1', 'hash'],
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      order.push('first-end');
    });
    const second = db.transaction(async (tx) => {
      order.push('second-start');
      await tx.execute(
        'INSERT INTO users (id, login, password_hash) VALUES (?, ?, ?)',
        ['t-2', 'serialized-2', 'hash'],
      );
      order.push('second-end');
    });
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second-start', 'second-end']);
    const rows = await db.query<{ count: number }>(
      'SELECT COUNT(*) AS count FROM users WHERE login IN (?, ?)',
      ['serialized-1', 'serialized-2'],
    );
    expect(Number(rows[0].count)).toBe(2);
    await db.close();
  });

  it('continues serving the queue after a transaction rejects', async () => {
    const db = createSqliteDatabase(':memory:');
    await db.migrate();
    const failing = db.transaction(async () => {
      throw new Error('abort');
    });
    const succeeding = db.transaction(async (tx) => {
      await tx.execute(
        'INSERT INTO users (id, login, password_hash) VALUES (?, ?, ?)',
        ['after-fail', 'after-fail-login', 'hash'],
      );
    });
    await expect(failing).rejects.toThrow('abort');
    // 前一事务失败后队列必须继续工作，不得因上一 reject 阻塞。
    await expect(succeeding).resolves.toBeUndefined();
    const rows = await db.query<{ count: number }>(
      'SELECT COUNT(*) AS count FROM users WHERE login = ?',
      ['after-fail-login'],
    );
    expect(Number(rows[0].count)).toBe(1);
    await db.close();
  });

  it('rejects a nested transaction with a clear error instead of deadlocking', async () => {
    const db = createSqliteDatabase(':memory:');
    await db.migrate();
    await expect(
      db.transaction(async (tx) => {
        await db.transaction(async (innerTx) => {
          await innerTx.query<{ v: number }>('SELECT 1 AS v');
        });
      }),
    ).rejects.toThrow(/不支持嵌套/);
    // 嵌套错误不会破坏队列：后续普通事务仍可执行。
    const result = await db.transaction(async (tx) => {
      const rows = await tx.query<{ v: number }>('SELECT 1 AS v');
      return rows[0].v;
    });
    expect(result).toBe(1);
    await db.close();
  });
});

describe('SQLite migration SQL', () => {
  it('applies migration 020 cleanly to an existing 001-019 database', async () => {
    const db = createSqliteDatabase(':memory:');
    const legacyDir = mkdtempSync(join(tmpdir(), 'dnd-migrations-001-019-'));
    try {
      for (const name of readdirSync(MIGRATIONS_DIR).filter((entry) => /^\d{3}_.*\.sql$/.test(entry) && !entry.startsWith('020_'))) {
        cpSync(join(MIGRATIONS_DIR, name), join(legacyDir, name));
      }
      const legacyReport = await new MigrationRunner(db, legacyDir).run();
      expect(legacyReport.applied).not.toContain('020');
      const now = '2026-08-18T00:00:00.000Z';
      await db.execute('INSERT INTO users (id, login, password_hash) VALUES (?, ?, ?)', ['mig-user', 'mig-user', 'hash']);
      await db.execute(
        'INSERT INTO campaigns (id, owner_id, name, ruleset, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ['mig-campaign', 'mig-user', 'Migration campaign', 'dnd5e', 'active', now, now],
      );
      await db.execute(
        'INSERT INTO platform_characters (id, campaign_id, player_id, name, status, sheet_json, derived_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ['mig-character', 'mig-campaign', 'mig-user', 'Migrated PC', 'approved', '{"hpCurrent":9,"hpMax":12}', '{}', now, now],
      );
      await db.execute(
        'INSERT INTO platform_characters (id, campaign_id, player_id, name, status, sheet_json, derived_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ['mig-draft', 'mig-campaign', 'mig-user', 'Draft PC', 'draft', '{"hpCurrent":4,"hpMax":4}', '{}', now, now],
      );
      await db.execute(
        'INSERT INTO platform_encounters (id, campaign_id, name, status, active_combatant_id, round, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ['mig-encounter', 'mig-campaign', 'Legacy encounter', 'preparation', null, 1, now, now],
      );
      await db.execute(
        'INSERT INTO platform_combatants (id, encounter_id, campaign_id, character_id, name, initiative, initiative_bonus, hp_current, hp_max, ac, conditions_json, visibility, target_player_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ['mig-npc-combatant', 'mig-encounter', 'mig-campaign', null, 'Legacy NPC', null, 0, 6, 6, 10, '["poisoned"]', 'public', null, 0, now, now],
      );
      await db.execute(
        'INSERT INTO platform_combatants (id, encounter_id, campaign_id, character_id, name, initiative, initiative_bonus, hp_current, hp_max, ac, conditions_json, visibility, target_player_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ['mig-draft-combatant', 'mig-encounter', 'mig-campaign', 'mig-draft', 'Draft PC instance', null, 0, 4, 4, 10, '[]', 'public', null, 1, now, now],
      );
      const currentReport = await new MigrationRunner(db, MIGRATIONS_DIR).run();
      expect(currentReport.applied).toEqual(['020']);
      const tables = await db.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('platform_campaign_actors', 'platform_actor_control_bindings', 'platform_character_runtime_states') ORDER BY name",
      );
      expect(tables.map((row) => row.name)).toEqual([
        'platform_actor_control_bindings', 'platform_campaign_actors', 'platform_character_runtime_states',
      ]);
      expect(await db.query('SELECT id, character_id FROM platform_campaign_actors WHERE id = ?', ['actor:character:mig-character']))
        .toEqual([{ id: 'actor:character:mig-character', character_id: 'mig-character' }]);
      expect(await db.query('SELECT current_hp FROM platform_character_runtime_states WHERE actor_id = ?', ['actor:character:mig-character']))
        .toEqual([{ current_hp: 9 }]);
      expect(await db.query('SELECT user_id FROM platform_actor_control_bindings WHERE actor_id = ?', ['actor:character:mig-character']))
        .toEqual([{ user_id: 'mig-user' }]);
      expect(await db.query('SELECT actor_id FROM platform_combatants WHERE id = ?', ['mig-npc-combatant']))
        .toEqual([{ actor_id: 'actor:combatant:mig-npc-combatant' }]);
      expect(await db.query('SELECT current_hp, conditions_json FROM platform_character_runtime_states WHERE actor_id = ?', ['actor:combatant:mig-npc-combatant']))
        .toEqual([{ current_hp: 6, conditions_json: '["poisoned"]' }]);
      // A legacy combatant pointing at a non-approved authoring Character stays
      // actorless instead of violating the new actor FK during backfill.
      expect(await db.query('SELECT actor_id FROM platform_combatants WHERE id = ?', ['mig-draft-combatant']))
        .toEqual([{ actor_id: null }]);
      expect(await db.query<{ sheet_json: string }>('SELECT sheet_json FROM platform_characters WHERE id = ?', ['mig-character']))
        .toEqual([{ sheet_json: '{"hpCurrent":9,"hpMax":12}' }]);
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
      await db.close();
    }
  });

  it('uses CURRENT_TIMESTAMP rather than SQLite datetime()', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '001_initial_platform.sql'), 'utf8');
    expect(sql).not.toMatch(/datetime\s*\(/i);
    expect(sql).toContain('DEFAULT CURRENT_TIMESTAMP');
  });
});

describe('migration 009 combat tables', () => {
  it('creates platform_encounters and platform_combatants with constraints', async () => {
    const db = createSqliteDatabase(':memory:');
    try {
      await db.migrate();
      const tables = await db.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('platform_encounters', 'platform_combatants')",
      );
      expect(tables.map((row) => row.name).sort()).toEqual(['platform_combatants', 'platform_encounters']);

      // 构造满足外键的父行：campaign/users/characters/archives。
      const now = '2026-08-09T00:00:00.000Z';
      await db.execute('INSERT INTO users (id, login, password_hash) VALUES (?, ?, ?)', ['u9', 'user9', 'hash']);
      await db.execute('INSERT INTO campaigns (id, owner_id, name, ruleset, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', ['c9', 'u9', '战役9', 'dnd5e', 'active', now, now]);
      await db.execute('INSERT INTO platform_characters (id, campaign_id, player_id, name, status, sheet_json, derived_json, submitted_at, approved_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ['ch9', 'c9', 'u9', '角色9', 'approved', '{}', '{}', now, now, now, now]);
      await db.execute('INSERT INTO platform_archives (id, campaign_id, kind, turn_id, label, version, state_json, created_by_user_id, superseded_at, superseded_by_archive_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ['ar9', 'c9', 'manual', null, '存档9', 1, '{}', 'u9', null, null, now]);

      await db.execute(
        'INSERT INTO platform_encounters (id, campaign_id, name, status, active_combatant_id, round, superseded_at, superseded_by_archive_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ['enc9', 'c9', '遭遇9', 'preparation', null, 1, null, null, now, now],
      );
      // 显式 ISO 时间被保留（不依赖默认文本格式）。
      const enc = await db.query<{ created_at: string; updated_at: string }>(
        'SELECT created_at, updated_at FROM platform_encounters WHERE id = ?',
        ['enc9'],
      );
      expect(enc[0]).toEqual({ created_at: now, updated_at: now });

      await db.execute(
        'INSERT INTO platform_combatants (id, encounter_id, campaign_id, character_id, name, initiative, initiative_bonus, hp_current, hp_max, ac, conditions_json, visibility, target_player_id, position, superseded_at, superseded_by_archive_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ['cbt9', 'enc9', 'c9', 'ch9', '战士', 18, 2, 10, 12, 16, '[]', 'public', null, 0, null, null, now, now],
      );
      const cbt = await db.query<{ visibility: string; target_player_id: string | null; created_at: string }>(
        'SELECT visibility, target_player_id, created_at FROM platform_combatants WHERE id = ?',
        ['cbt9'],
      );
      expect(cbt[0]).toEqual({ visibility: 'public', target_player_id: null, created_at: now });
    } finally {
      await db.close();
    }
  });

  it('enforces encounter FK, hp/round checks, unique position and visibility-target pairing', async () => {
    const db = createSqliteDatabase(':memory:');
    try {
      await db.migrate();
      const now = '2026-08-09T00:00:00.000Z';
      await db.execute('INSERT INTO users (id, login, password_hash) VALUES (?, ?, ?)', ['u9b', 'user9b', 'hash']);
      await db.execute('INSERT INTO campaigns (id, owner_id, name, ruleset, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', ['c9b', 'u9b', '战役9b', 'dnd5e', 'active', now, now]);
      // 无对应 campaign 的 encounter 违反 FK。
      await expect(db.execute(
        'INSERT INTO platform_encounters (id, campaign_id, name, status, active_combatant_id, round, superseded_at, superseded_by_archive_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ['enc-bad', 'no-such-campaign', 'x', 'preparation', null, 1, null, null, now, now],
      )).rejects.toThrow(/FOREIGN KEY/i);

      await db.execute('INSERT INTO platform_encounters (id, campaign_id, name, status, active_combatant_id, round, superseded_at, superseded_by_archive_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ['enc9b', 'c9b', '遭遇9b', 'preparation', null, 1, null, null, now, now]);
      // round < 1 违反 CHECK。
      await expect(db.execute(
        'INSERT INTO platform_encounters (id, campaign_id, name, status, active_combatant_id, round, superseded_at, superseded_by_archive_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ['enc-bad-round', 'c9b', 'x', 'preparation', null, 0, null, null, now, now],
      )).rejects.toThrow(/CHECK/i);

      // 同一 encounter 相同 position 违反 UNIQUE。
      await db.execute(
        'INSERT INTO platform_combatants (id, encounter_id, campaign_id, character_id, name, initiative, initiative_bonus, hp_current, hp_max, ac, conditions_json, visibility, target_player_id, position, superseded_at, superseded_by_archive_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ['cbt9b-1', 'enc9b', 'c9b', null, '地精甲', null, 1, 7, 7, 13, '[]', 'public', null, 0, null, null, now, now],
      );
      await expect(db.execute(
        'INSERT INTO platform_combatants (id, encounter_id, campaign_id, character_id, name, initiative, initiative_bonus, hp_current, hp_max, ac, conditions_json, visibility, target_player_id, position, superseded_at, superseded_by_archive_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ['cbt9b-2', 'enc9b', 'c9b', null, '地精乙', null, 1, 7, 7, 13, '[]', 'public', null, 0, null, null, now, now],
      )).rejects.toThrow(/UNIQUE/i);

      // hp_max <= 0 违反 CHECK。
      await expect(db.execute(
        'INSERT INTO platform_combatants (id, encounter_id, campaign_id, character_id, name, initiative, initiative_bonus, hp_current, hp_max, ac, conditions_json, visibility, target_player_id, position, superseded_at, superseded_by_archive_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ['cbt9b-3', 'enc9b', 'c9b', null, '坏战斗员', null, 0, 0, 0, 10, '[]', 'public', null, 1, null, null, now, now],
      )).rejects.toThrow(/CHECK/i);
    } finally {
      await db.close();
    }
  });

  it('applies 009 migration only once with the full version sequence', async () => {
    const db = createSqliteDatabase(':memory:');
    try {
      await db.migrate();
      const versions = await db.query<{ version: string }>('SELECT version FROM platform_migrations ORDER BY version');
      expect(versions.map((row) => row.version)).toContain('009');
      expect(new Set(versions.map((row) => row.version)).size).toBe(versions.length);
    } finally {
      await db.close();
    }
  });
});

describe('migration 019 action branch lifecycle', () => {
  it('rebuilds the action FK graph, preserves audit references, and allows only one active action per slot', async () => {
    const db = createSqliteDatabase(':memory:');
    const beforeDir = mkdtempSync(join(tmpdir(), 'dnd-migration-before-'));
    const afterDir = mkdtempSync(join(tmpdir(), 'dnd-migration-after-'));
    const beforeNames = readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith('.sql') && name.slice(0, 3) !== '019')
      .sort();
    try {
      for (const name of beforeNames) copyFileSync(join(MIGRATIONS_DIR, name), join(beforeDir, name));
      copyFileSync(join(MIGRATIONS_DIR, '019_action_branch_lifecycle.sql'), join(afterDir, '019_action_branch_lifecycle.sql'));
      await new MigrationRunner(db, beforeDir).run();

      const now = '2026-08-17T00:00:00.000Z';
      await db.execute('INSERT INTO users (id, login, password_hash) VALUES (?, ?, ?)', ['u019', 'user019', 'hash']);
      await db.execute(
        'INSERT INTO campaigns (id, owner_id, name, status, ruleset, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ['c019', 'u019', '战役019', 'active', 'dnd5e', now, now],
      );
      await db.execute(
        'INSERT INTO platform_turns (id, campaign_id, number, status, locked_at, completed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ['t019', 'c019', 1, 'waiting_for_actions', null, null, now, now],
      );
      await db.execute(
        'INSERT INTO platform_actions (id, turn_id, campaign_id, player_id, body, submitted_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ['a019-old', 't019', 'c019', 'u019', '旧分支行动', now, now],
      );
      await db.execute(
        'INSERT INTO platform_ai_runs (id, campaign_id, campaign_sequence, turn_id, attempt, idempotency_key, provider, model, status, context_json, result_json, error_code, error_json, raw_debug_json, started_at, completed_at, superseded_at, superseded_by_archive_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ['run019', 'c019', 1, 't019', 1, 'run019-key', 'test', 'test', 'succeeded', '{}', '{}', null, null, null, now, now, null, null],
      );
      await db.execute(
        `INSERT INTO platform_action_intents
          (id, action_id, campaign_id, turn_id, actor_id, execution_id, intent_order,
           source_input, mode, action_type, action_ref, target_ids_json,
           declared_approach, desired_outcome, resource_choices_json, fallback_policy,
           based_on_state_revision, created_at, superseded_at, superseded_by_archive_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['intent019', 'a019-old', 'c019', 't019', 'u019', 'run019', 0, '旧证据', 'player_action', 'healing', null, '[]', null, null, '[]', 'continue', 0, now, null, null],
      );

      await new MigrationRunner(db, afterDir).run();

      const oldAction = await db.query<{ id: string; superseded_at: string | null }>(
        'SELECT id, superseded_at FROM platform_actions WHERE id = ?', ['a019-old'],
      );
      expect(oldAction).toEqual([{ id: 'a019-old', superseded_at: null }]);
      expect(await db.query<{ action_id: string }>(
        'SELECT action_id FROM platform_action_intents WHERE id = ?', ['intent019'],
      )).toEqual([{ action_id: 'a019-old' }]);
      expect(await db.query<{ issue: string }>('PRAGMA foreign_key_check')).toEqual([]);

      const activeIndex = await db.query<{ sql: string }>(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'platform_actions_active_player_idx'",
      );
      expect(activeIndex[0].sql).toMatch(/CREATE UNIQUE INDEX/i);
      expect(activeIndex[0].sql).toContain('WHERE superseded_at IS NULL');

      await db.execute(
        'UPDATE platform_actions SET superseded_at = ?, superseded_by_archive_id = NULL WHERE id = ?',
        [now, 'a019-old'],
      );
      await db.execute(
        'INSERT INTO platform_actions (id, turn_id, campaign_id, player_id, body, submitted_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ['a019-new', 't019', 'c019', 'u019', '新分支行动', now, now],
      );
      await expect(db.execute(
        'INSERT INTO platform_actions (id, turn_id, campaign_id, player_id, body, submitted_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ['a019-too-many', 't019', 'c019', 'u019', '重复 active 行动', now, now],
      )).rejects.toThrow(/UNIQUE/i);
    } finally {
      rmSync(beforeDir, { recursive: true, force: true });
      rmSync(afterDir, { recursive: true, force: true });
      await db.close();
    }
  });
});

describe('migration 010 AI Provider credentials', () => {
  it('stores only encrypted campaign-scoped credentials and applies once', async () => {
    const db = createSqliteDatabase(':memory:');
    try {
      await db.migrate();
      const now = '2026-08-10T00:00:00.000Z';
      await db.execute('INSERT INTO users (id, login, password_hash) VALUES (?, ?, ?)', ['u10', 'user10', 'hash']);
      await db.execute('INSERT INTO campaigns (id, owner_id, name, ruleset, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', ['c10', 'u10', '战役10', 'dnd5e', 'active', now, now]);
      await db.execute(
        'INSERT INTO platform_ai_provider_configs (campaign_id, provider, base_url, model, encrypted_api_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ['c10', 'openai-compatible', 'https://provider.example/v1', 'gpt-test', 'v1.ciphertext-only', now, now],
      );
      const rows = await db.query<{ campaign_id: string; encrypted_api_key: string }>('SELECT campaign_id, encrypted_api_key FROM platform_ai_provider_configs');
      expect(rows).toEqual([{ campaign_id: 'c10', encrypted_api_key: 'v1.ciphertext-only' }]);
      const versions = await db.query<{ version: string }>('SELECT version FROM platform_migrations WHERE version = ?', ['010']);
      expect(versions).toEqual([{ version: '010' }]);
      await db.migrate();
      const afterSecondRun = await db.query<{ count: number }>('SELECT COUNT(*) AS count FROM platform_migrations WHERE version = ?', ['010']);
      expect(Number(afterSecondRun[0].count)).toBe(1);
    } finally {
      await db.close();
    }
  });
});

describe('migration runner failure modes', () => {
  it('fails explicitly when the migrations directory is missing', async () => {
    const db = createSqliteDatabase(':memory:');
    const runner = new MigrationRunner(db, join(MIGRATIONS_DIR, 'does-not-exist'));
    await expect(runner.run()).rejects.toThrow(/Migrations directory not found/);
    await db.close();
  });

  it('fails explicitly when the migrations directory contains no SQL files', async () => {
    // The parent directory exists but holds no *.sql migration files; this is
    // the production failure shape where a build forgot to copy the .sql files
    // next to the compiled runner (the directory itself still exists because
    // the compiled MigrationRunner.js is emitted there).
    const parentDir = fileURLToPath(new URL('../', import.meta.url));
    const db = createSqliteDatabase(':memory:');
    const runner = new MigrationRunner(db, parentDir);
    await expect(runner.run()).rejects.toThrow(/No SQL migration files found/);
    await db.close();
  });
});

describe('atomic migration application', () => {
  it('rolls back the migration schema when the tracking INSERT fails', async () => {
    const db = createSqliteDatabase(':memory:');
    try {
      // 先建立真实平台表（users 等），确保 migration 的 CREATE TABLE 与
      // ALTER TABLE users 都能执行；唯一失败源只能是 tracking INSERT 违反
      // PRIMARY KEY/UNIQUE，而不是 "no such table: users"。
      await db.migrate();
      // 以随机值 seed，避免与未来版本号（如 008）冲突；同时记录 baseline，
      // 不把迁移版本硬编码进断言。
      const seedVersion = `seed-${randomUUID()}`;
      const baseline = (await db.query<{ version: string }>('SELECT version FROM platform_migrations')).map((r) => r.version).sort();
      await db.execute(PLATFORM_MIGRATION_INSERT_SQL, [seedVersion, 'dummy', 'now']);

      const migration: MigrationToApply = {
        version: seedVersion,
        name: `${seedVersion}_atomic_test.sql`,
        sql: `
          CREATE TABLE atomic_rollback_probe (id TEXT PRIMARY KEY);
          ALTER TABLE users ADD COLUMN atomic_rollback_probe_col TEXT;
        `,
      };
      // 断言失败来自 tracking 的唯一约束，而不是迁移 SQL 本身。
      await expect(db.applyMigration(migration, new Date().toISOString())).rejects.toThrow(
        /UNIQUE constraint failed: platform_migrations\.version/,
      );
      const tableRows = await db.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        ['atomic_rollback_probe'],
      );
      expect(tableRows).toEqual([]);
      const colRows = await db.query<{ name: string }>(
        "SELECT name FROM pragma_table_info('users') WHERE name = ?",
        ['atomic_rollback_probe_col'],
      );
      expect(colRows).toEqual([]);
      // tracking = baseline + seed；seed 行仍是唯一的（name='dummy'），
      // 失败的 migration 没有留下自己的 tracking 行。
      const tracking = (await db.query<{ version: string }>('SELECT version FROM platform_migrations')).map((r) => r.version).sort();
      expect(tracking).toEqual([...baseline, seedVersion].sort());
      const seedRow = await db.query<{ name: string }>(
        'SELECT name FROM platform_migrations WHERE version = ?',
        [seedVersion],
      );
      expect(seedRow).toEqual([{ name: 'dummy' }]);
    } finally {
      await db.close();
    }
  });

  it('commits the migration schema and its tracking row together', async () => {
    const db = createSqliteDatabase(':memory:');
    try {
      // Tracking table bootstrap is a separate concern (CREATE IF NOT EXISTS),
      // exactly as MigrationRunner does before discovering applied versions.
      await db.exec(`
        CREATE TABLE IF NOT EXISTS platform_migrations (
          version TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);
      // 随机版本号，避免与真实迁移版本（001..008+）冲突。
      const version = `atomic-commit-${randomUUID()}`;
      const name = `${version}.sql`;
      const migration: MigrationToApply = {
        version,
        name,
        sql: 'CREATE TABLE atomic_commit_probe (id TEXT PRIMARY KEY);',
      };
      const appliedAt = new Date().toISOString();
      await db.applyMigration(migration, appliedAt);
      const tableRows = await db.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        ['atomic_commit_probe'],
      );
      expect(tableRows.map((row) => row.name)).toEqual(['atomic_commit_probe']);
      const tracking = await db.query<{ version: string; name: string; applied_at: string }>(
        'SELECT version, name, applied_at FROM platform_migrations WHERE version = ?',
        [version],
      );
      expect(tracking).toEqual([{ version, name, applied_at: appliedAt }]);
    } finally {
      await db.close();
    }
  });
});