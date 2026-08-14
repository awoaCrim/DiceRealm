import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CANONICAL_MIGRATION_FILENAME_PATTERN,
  isCanonicalMigrationFilename,
  MigrationManifestError,
  normalizeMigrationText,
  parseMigrationManifest,
  sha256OfMigrationText,
  sortMigrationFilenames,
  verifyMigrationManifest,
} from './migrationManifest.js';
import {
  isCanonicalMigrationFilename as mjsIsCanonicalMigrationFilename,
  normalizeMigrationText as mjsNormalizeMigrationText,
  sha256OfMigrationText as mjsSha256OfMigrationText,
  sortMigrationFilenames as mjsSortMigrationFilenames,
  verifyMigrationManifestSync as mjsVerifyMigrationManifestSync,
} from '../../../scripts/migration-manifest-shared.mjs';
import { APPROVED_MIGRATION_FILENAMES } from '../../tests/phase2TempFixture.js';

const COMMITTED_MIGRATIONS_DIR = fileURLToPath(new URL('../database/migrations/', import.meta.url));
const COMMITTED_MANIFEST_PATH = fileURLToPath(new URL('../database/migrations/migrations.manifest.json', import.meta.url));

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 在临时目录写一组 canonical SQL + manifest；返回 { dir, manifestPath }。 */
function fixtureDir(
  sql: Array<{ name: string; content: string }>,
  manifestJson: string,
): { dir: string; manifestPath: string } {
  const dir = tempDir('dnd-manifest-');
  for (const file of sql) {
    const dirPart = join(dir, dirname(file.name));
    if (dirPart !== dir) mkdirSync(dirPart, { recursive: true });
    writeFileSync(join(dir, file.name), file.content, 'utf8');
  }
  const manifestPath = join(dir, 'migrations.manifest.json');
  writeFileSync(manifestPath, manifestJson, 'utf8');
  return { dir, manifestPath };
}

function manifestJson(files: Array<{ name: string; sha256: string }>): string {
  return JSON.stringify({ format: 1, files });
}

const SQL_001 = 'CREATE TABLE platform_users (id TEXT PRIMARY KEY);\n';
const HASH_001 = sha256OfMigrationText(SQL_001);

describe('migrationManifest canonical contract', () => {
  it('matches only canonical three-digit prefixed SQL filenames', () => {
    expect(isCanonicalMigrationFilename('001_initial_platform.sql')).toBe(true);
    expect(isCanonicalMigrationFilename('010_ai_provider_credentials.sql')).toBe(true);
    expect(isCanonicalMigrationFilename('011_rule_sources.sql')).toBe(true);
    for (const bad of [
      '001.sql',
      '1_initial.sql',
      '01_initial.sql',
      '0001_initial.sql',
      '001_initial.txt',
      '001-initial.sql',
      '001_initial.SQL',
      'schema_migrations.sql',
      'notes.md',
    ]) {
      expect(isCanonicalMigrationFilename(bad), bad).toBe(false);
    }
    expect('001_initial.sql'.match(CANONICAL_MIGRATION_FILENAME_PATTERN)?.[0]).toBe('001_initial.sql');
  });

  it('sorts by ASCII code-unit order deterministically', () => {
    expect(sortMigrationFilenames(['002_b.sql', '011_c.sql', '001_a.sql', '002_a.sql'])).toEqual([
      '001_a.sql',
      '002_a.sql',
      '002_b.sql',
      '011_c.sql',
    ]);
  });
});

describe('migrationManifest hashing', () => {
  it('computes the same canonical hash for LF and CRLF variants of the same text', () => {
    const lf = 'CREATE TABLE a (id TEXT PRIMARY KEY);\nALTER TABLE a ADD COLUMN b TEXT;\n';
    const crlf = lf.replace(/\n/g, '\r\n');
    expect(normalizeMigrationText(crlf)).toBe(lf);
    expect(sha256OfMigrationText(lf)).toBe(sha256OfMigrationText(crlf));
  });

  it('normalises isolated CR line endings too', () => {
    expect(normalizeMigrationText('a\rb\r\nc\nd')).toBe('a\nb\nc\nd');
  });
});

describe('migrationManifest parsing', () => {
  it('rejects malformed, wrong-format and duplicate manifests', () => {
    expect(() => parseMigrationManifest('not-json')).toThrow(MigrationManifestError);
    expect(() => parseMigrationManifest(JSON.stringify({ format: 2, files: [] }))).toThrow(MigrationManifestError);
    expect(() => parseMigrationManifest(JSON.stringify({ format: 1, files: 'x' }))).toThrow(MigrationManifestError);
    expect(() => parseMigrationManifest(manifestJson([
      { name: '001_a.sql', sha256: 'ab'.repeat(32) },
      { name: '001_b.sql', sha256: 'cd'.repeat(32) },
    ]))).toThrow(/duplicate|重复|version|版本/i);
    expect(() => parseMigrationManifest(manifestJson([
      { name: '001_a.sql', sha256: 'not-a-hash' },
    ]))).toThrow(MigrationManifestError);
    expect(() => parseMigrationManifest(manifestJson([
      { name: '001_a.sql', sha256: 'ab'.repeat(32) },
      { name: '001_a.sql', sha256: 'cd'.repeat(32) },
    ]))).toThrow(/duplicate|重复|name/i);
  });
});

describe('migrationManifest vs build helper contract', () => {
  // copy-migrations.mjs / clean-dist.mjs 使用 migration-manifest-shared.mjs；
  // 本测试锁定两份实现行为完全一致，防止正则/hash 漂移。
  it('keeps the shared .mjs helper behaviour identical to the TS verifier', () => {
    const names = ['002_b.sql', '011_c.sql', '001_a.sql', 'schema_migrations.sql', '001.sql', '001_a.txt'];
    for (const name of names) {
      expect(mjsIsCanonicalMigrationFilename(name)).toBe(isCanonicalMigrationFilename(name));
    }
    expect(mjsSortMigrationFilenames(names)).toEqual(sortMigrationFilenames(names));
    const text = 'a\r\nb\rc\nd';
    expect(mjsNormalizeMigrationText(text)).toBe(normalizeMigrationText(text));
    expect(mjsSha256OfMigrationText('CREATE TABLE a (id TEXT PRIMARY KEY);\n')).toBe(
      sha256OfMigrationText('CREATE TABLE a (id TEXT PRIMARY KEY);\n'),
    );
    const report = mjsVerifyMigrationManifestSync({
      migrationsDir: COMMITTED_MIGRATIONS_DIR,
      manifestPath: COMMITTED_MANIFEST_PATH,
    });
    // Phase 2 Task 0：manifest 测试改为断言“当前 approved set”（001–011 baseline）；
    // 012/013/014 在对应 Task 通过 APPENDED_APPROVED_MIGRATIONS 加入，避免中间 Task 假绿。
    expect(report.files.length).toBe(APPROVED_MIGRATION_FILENAMES.length);
    expect(report.files.map((file) => file.name)).toEqual([...APPROVED_MIGRATION_FILENAMES].sort());
  });

  it('rejects the same failure cases as the TS verifier (rogue SQL, duplicate, invalid hash, missing, extra, tamper)', () => {
    const cases: Array<{
      label: string;
      sql: Array<{ name: string; content: string }>;
      manifest: string;
    }> = [
      {
        label: 'rogue non-canonical .sql',
        sql: [{ name: '001_a.sql', content: SQL_001 }, { name: 'schema_migrations.sql', content: 'x' }],
        manifest: manifestJson([{ name: '001_a.sql', sha256: HASH_001 }]),
      },
      {
        label: 'duplicate version prefix',
        sql: [{ name: '001_a.sql', content: SQL_001 }, { name: '001_b.sql', content: SQL_001 }],
        manifest: manifestJson([
          { name: '001_a.sql', sha256: HASH_001 },
          { name: '001_b.sql', sha256: HASH_001 },
        ]),
      },
      {
        label: 'duplicate filename',
        sql: [{ name: '001_a.sql', content: SQL_001 }],
        manifest: manifestJson([
          { name: '001_a.sql', sha256: HASH_001 },
          { name: '001_a.sql', sha256: HASH_001 },
        ]),
      },
      {
        label: 'invalid sha256 format',
        sql: [{ name: '001_a.sql', content: SQL_001 }],
        manifest: manifestJson([{ name: '001_a.sql', sha256: 'not-a-hash' }]),
      },
      {
        label: 'missing SQL file',
        sql: [{ name: '001_a.sql', content: SQL_001 }],
        manifest: manifestJson([
          { name: '001_a.sql', sha256: HASH_001 },
          { name: '002_b.sql', sha256: 'cd'.repeat(32) },
        ]),
      },
      {
        label: 'extra SQL file',
        sql: [{ name: '001_a.sql', content: SQL_001 }, { name: '002_b.sql', content: SQL_001 }],
        manifest: manifestJson([{ name: '001_a.sql', sha256: HASH_001 }]),
      },
      {
        label: 'tampered SQL content',
        sql: [{ name: '001_a.sql', content: 'CREATE TABLE platform_users (id TEXT PRIMARY KEY, tampered INTEGER);\n' }],
        manifest: manifestJson([{ name: '001_a.sql', sha256: HASH_001 }]),
      },
    ];
    for (const testCase of cases) {
      const { dir, manifestPath } = fixtureDir(testCase.sql, testCase.manifest);
      try {
        const tsError = (() => {
          try {
            verifyMigrationManifest({ migrationsDir: dir, manifestPath });
            return null;
          } catch (caught) {
            return caught;
          }
        })();
        const mjsError = (() => {
          try {
            mjsVerifyMigrationManifestSync({ migrationsDir: dir, manifestPath });
            return null;
          } catch (caught) {
            return caught;
          }
        })();
        expect(tsError, `${testCase.label}: TS verifier must reject`).toBeInstanceOf(Error);
        expect(mjsError, `${testCase.label}: .mjs build helper must reject`).toBeInstanceOf(Error);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});


describe('migrationManifest verification', () => {
  it('verifies the committed source migrations directory (001-011) against the committed manifest', () => {
    const report = verifyMigrationManifest({
      migrationsDir: COMMITTED_MIGRATIONS_DIR,
      manifestPath: COMMITTED_MANIFEST_PATH,
    });
    expect(report.files.length).toBe(APPROVED_MIGRATION_FILENAMES.length);
    expect(report.files.map((file) => file.name)).toEqual(
      sortMigrationFilenames(report.files.map((file) => file.name)),
    );
  });

  it('fails when a manifest SQL file is missing from the directory', () => {
    const { dir, manifestPath } = fixtureDir(
      [{ name: '001_a.sql', content: SQL_001 }],
      manifestJson([{ name: '001_a.sql', sha256: HASH_001 }, { name: '002_b.sql', sha256: 'cd'.repeat(32) }]),
    );
    try {
      expect(() => verifyMigrationManifest({ migrationsDir: dir, manifestPath })).toThrow(/missing|缺失/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when the directory contains an extra SQL file', () => {
    const { dir, manifestPath } = fixtureDir(
      [{ name: '001_a.sql', content: SQL_001 }, { name: '999_rogue.sql', content: 'SELECT 1;\n' }],
      manifestJson([{ name: '001_a.sql', sha256: HASH_001 }]),
    );
    try {
      expect(() => verifyMigrationManifest({ migrationsDir: dir, manifestPath })).toThrow(/extra|多余|额外/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when a SQL file has been tampered with', () => {
    const { dir, manifestPath } = fixtureDir(
      [{ name: '001_a.sql', content: 'CREATE TABLE platform_users (id TEXT PRIMARY KEY, tampered INTEGER);\n' }],
      manifestJson([{ name: '001_a.sql', sha256: HASH_001 }]),
    );
    try {
      expect(() => verifyMigrationManifest({ migrationsDir: dir, manifestPath })).toThrow(/hash|SHA-256/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when a non-canonical .sql file appears in the directory', () => {
    const { dir, manifestPath } = fixtureDir(
      [{ name: '001_a.sql', content: SQL_001 }, { name: 'schema_migrations.sql', content: 'x' }],
      manifestJson([{ name: '001_a.sql', sha256: HASH_001 }]),
    );
    try {
      expect(() => verifyMigrationManifest({ migrationsDir: dir, manifestPath })).toThrow(MigrationManifestError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when the manifest file itself is missing', () => {
    const dir = tempDir('dnd-manifest-missing-');
    try {
      expect(() => verifyMigrationManifest({
        migrationsDir: dir,
        manifestPath: join(dir, 'migrations.manifest.json'),
      })).toThrow(MigrationManifestError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
