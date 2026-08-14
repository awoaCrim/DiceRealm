import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Migration filename canonical contract shared by copy/verifier/runner. */
export const CANONICAL_MIGRATION_FILENAME_PATTERN = /^\d{3}_[A-Za-z0-9][A-Za-z0-9._-]*\.sql$/;

/** 稳定、不含敏感数据的 manifest 错误。 */
export class MigrationManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationManifestError';
  }
}

export interface MigrationManifestEntry {
  name: string;
  sha256: string;
}

export interface MigrationManifest {
  format: 1;
  files: MigrationManifestEntry[];
}

export interface MigrationManifestReport {
  files: MigrationManifestEntry[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]';
}

export function isCanonicalMigrationFilename(name: string): boolean {
  return CANONICAL_MIGRATION_FILENAME_PATTERN.test(name);
}

/** ASCII code-unit deterministic sort（禁止 localeCompare，避免地区排序漂移）。 */
export function sortMigrationFilenames(names: string[]): string[] {
  return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** 规范化行尾：CRLF / 孤立 CR → LF（跨平台 hash 一致，兼容 Windows autocrlf 工作树）。 */
export function normalizeMigrationText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** 对规范化 LF 文本的 UTF-8 bytes 计算 SHA-256（manifest 使用此 hash）。 */
export function sha256OfMigrationText(text: string): string {
  return createHash('sha256').update(normalizeMigrationText(text), 'utf8').digest('hex');
}

function assertStrictManifest(value: unknown): asserts value is MigrationManifest {
  if (!isPlainObject(value) || value.format !== 1 || !Array.isArray(value.files)) {
    throw new MigrationManifestError('migrations.manifest.json 格式无效（需要 format=1 与 files 数组）。');
  }
  const seenNames = new Set<string>();
  const seenVersions = new Set<string>();
  for (const entry of value.files) {
    if (!isPlainObject(entry) || typeof entry.name !== 'string' || typeof entry.sha256 !== 'string') {
      throw new MigrationManifestError('migrations.manifest.json 包含无效条目。');
    }
    if (!isCanonicalMigrationFilename(entry.name)) {
      throw new MigrationManifestError(`manifest 文件名不符合规范：${entry.name}`);
    }
    if (seenNames.has(entry.name)) {
      throw new MigrationManifestError(`manifest 包含重复文件名：${entry.name}`);
    }
    seenNames.add(entry.name);
    const version = entry.name.slice(0, 3);
    if (seenVersions.has(version)) {
      throw new MigrationManifestError(`manifest 包含重复版本号：${version}`);
    }
    seenVersions.add(version);
    if (!/^[0-9a-f]{64}$/.test(entry.sha256)) {
      throw new MigrationManifestError(`manifest 中 ${entry.name} 的 sha256 不是 64 位小写十六进制。`);
    }
  }
}

/** 严格解析 committed manifest；任何格式偏差都抛 MigrationManifestError。 */
export function parseMigrationManifest(json: string): MigrationManifest {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new MigrationManifestError('migrations.manifest.json 不是合法 JSON。');
  }
  assertStrictManifest(value);
  return value;
}

/** 从迁移目录构建 manifest（canonical SQL 的 normalized-LF SHA-256）。 */
export function buildMigrationManifest(migrationsDir: string): MigrationManifest {
  const names = canonicalSqlFiles(migrationsDir);
  return {
    format: 1,
    files: names.map((name) => ({
      name,
      sha256: sha256OfMigrationText(readFileSync(join(migrationsDir, name), 'utf8')),
    })),
  };
}

function canonicalSqlFiles(migrationsDir: string): string[] {
  let entries;
  try {
    entries = readdirSync(migrationsDir);
  } catch {
    throw new MigrationManifestError(`迁移目录不存在：${migrationsDir}`);
  }
  return sortMigrationFilenames(entries.filter((name) => isCanonicalMigrationFilename(name)));
}

/**
 * 启动前验证 committed manifest 与迁移目录 exact set + SHA-256 完全一致。
 * missing/extra/tamper/非规范 .sql 均抛 MigrationManifestError。
 */
export function verifyMigrationManifest(options: {
  migrationsDir: string;
  manifestPath: string;
}): MigrationManifestReport {
  let raw: string;
  try {
    raw = readFileSync(options.manifestPath, 'utf8');
  } catch {
    throw new MigrationManifestError(`manifest 文件缺失：${options.manifestPath}`);
  }
  const manifest = parseMigrationManifest(raw);

  const actualNames = canonicalSqlFiles(options.migrationsDir);

  // 非规范 .sql 也视为 extra（与 exact set 一同拒绝）。
  let allEntries: string[];
  try {
    allEntries = readdirSync(options.migrationsDir);
  } catch {
    throw new MigrationManifestError(`迁移目录不存在：${options.migrationsDir}`);
  }
  const rogueSql = sortMigrationFilenames(allEntries.filter((name) => name.endsWith('.sql') && !isCanonicalMigrationFilename(name)));

  const manifestNames = manifest.files.map((entry) => entry.name);
  const missing = manifestNames.filter((name) => !actualNames.includes(name));
  const extra = [
    ...actualNames.filter((name) => !manifestNames.includes(name)),
    ...rogueSql,
  ];

  if (missing.length > 0) {
    throw new MigrationManifestError(`manifest 声明的迁移缺失：${missing.join(', ')}`);
  }
  if (extra.length > 0) {
    throw new MigrationManifestError(`迁移目录存在 manifest 未声明的额外文件：${extra.join(', ')}`);
  }
  // manifest 顺序必须与 canonical ASCII 排序一致。
  if (manifestNames.join('\n') !== actualNames.join('\n')) {
    throw new MigrationManifestError('manifest 文件顺序不符合 canonical ASCII 排序。');
  }
  for (const entry of manifest.files) {
    const actual = sha256OfMigrationText(readFileSync(join(options.migrationsDir, entry.name), 'utf8'));
    if (actual !== entry.sha256) {
      throw new MigrationManifestError(`迁移内容与 manifest SHA-256 不一致：${entry.name}`);
    }
  }
  return { files: manifest.files };
}
