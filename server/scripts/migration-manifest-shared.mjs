// Migration artifact contract shared between build scripts (copy-migrations.mjs,
// clean-dist.mjs) and the runtime verifier. Kept as a plain ESM module so build
// scripts can import it without a TypeScript compile step.
//
// The canonical predicate / hash must stay in lockstep with
// server/src/platform/ops/migrationManifest.ts; migrationManifest.test.ts has a
// contract test that asserts both sides behave identically.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CANONICAL_MIGRATION_FILENAME_PATTERN = /^\d{3}_[A-Za-z0-9][A-Za-z0-9._-]*\.sql$/;

export function isCanonicalMigrationFilename(name) {
  return CANONICAL_MIGRATION_FILENAME_PATTERN.test(name);
}

export function sortMigrationFilenames(names) {
  return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function normalizeMigrationText(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function sha256OfMigrationText(text) {
  return createHash('sha256').update(normalizeMigrationText(text), 'utf8').digest('hex');
}

function canonicalSqlFiles(migrationsDir) {
  const entries = readdirSync(migrationsDir);
  return sortMigrationFilenames(entries.filter((name) => isCanonicalMigrationFilename(name)));
}

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]';
}

/**
 * 与 runtime verifier（migrationManifest.ts）相同的严格 manifest schema 检查：
 * malformed entries / 非 canonical 文件名 / 重复文件名 / 重复版本号 / 非法 sha256
 * 全部拒绝，保证 build gate 与启动前验证语义完全一致。
 */
function assertStrictManifest(manifest) {
  if (!isPlainObject(manifest) || manifest.format !== 1 || !Array.isArray(manifest.files)) {
    throw new Error('migrations.manifest.json 格式无效（需要 format=1 与 files 数组）。');
  }
  const seenNames = new Set();
  const seenVersions = new Set();
  for (const entry of manifest.files) {
    if (!isPlainObject(entry) || typeof entry.name !== 'string' || typeof entry.sha256 !== 'string') {
      throw new Error('migrations.manifest.json 包含无效条目。');
    }
    if (!isCanonicalMigrationFilename(entry.name)) {
      throw new Error(`manifest 文件名不符合规范：${entry.name}`);
    }
    if (seenNames.has(entry.name)) {
      throw new Error(`manifest 包含重复文件名：${entry.name}`);
    }
    seenNames.add(entry.name);
    const version = entry.name.slice(0, 3);
    if (seenVersions.has(version)) {
      throw new Error(`manifest 包含重复版本号：${version}`);
    }
    seenVersions.add(version);
    if (!/^[0-9a-f]{64}$/.test(entry.sha256)) {
      throw new Error(`manifest 中 ${entry.name} 的 sha256 不是 64 位小写十六进制。`);
    }
  }
}

/**
 * Verify an exact-set + SHA-256 manifest against a migrations directory.
 * Throws with a readable message on any deviation. Returns { files }.
 */
export function verifyMigrationManifestSync({ migrationsDir, manifestPath }) {
  let raw;
  try {
    raw = readFileSync(manifestPath, 'utf8');
  } catch {
    throw new Error(`manifest 文件缺失：${manifestPath}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    throw new Error(`manifest 不是合法 JSON：${manifestPath}`);
  }
  assertStrictManifest(manifest);
  const names = manifest.files.map((entry) => entry.name);
  const actual = canonicalSqlFiles(migrationsDir);
  const missing = names.filter((name) => !actual.includes(name));
  // 非 canonical .sql 也视为 extra（与 runtime verifier 的 exact-set 语义一致）。
  const allEntries = readdirSync(migrationsDir);
  const rogueSql = sortMigrationFilenames(
    allEntries.filter((name) => name.endsWith('.sql') && !isCanonicalMigrationFilename(name)),
  );
  const extra = [...actual.filter((name) => !names.includes(name)), ...rogueSql];
  if (missing.length > 0) throw new Error(`manifest 声明的迁移缺失：${missing.join(', ')}`);
  if (extra.length > 0) throw new Error(`迁移目录存在 manifest 未声明的额外文件：${extra.join(', ')}`);
  if (names.join('\n') !== actual.join('\n')) {
    throw new Error('manifest 文件顺序不符合 canonical ASCII 排序。');
  }
  for (const entry of manifest.files) {
    const actualHash = sha256OfMigrationText(readFileSync(join(migrationsDir, entry.name), 'utf8'));
    if (actualHash !== entry.sha256) {
      throw new Error(`迁移内容与 manifest SHA-256 不一致：${entry.name}`);
    }
  }
  return { files: manifest.files };
}
