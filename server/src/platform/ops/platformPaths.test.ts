import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { assertPathAbsent, canonicalAbsolutePath, PlatformPathError } from './platformPaths.js';

describe('platformPaths', () => {
  it('assertPathAbsent treats only ENOENT as absent; an existing path fails closed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dnd-paths-'));
    try {
      const existing = join(dir, 'existing.txt');
      writeFileSync(existing, 'x', 'utf8');
      expect(() => assertPathAbsent(existing)).toThrow(/路径已存在/);
      expect(() => assertPathAbsent(join(dir, 'missing.txt'))).not.toThrow();
      expect(() => assertPathAbsent(join(dir, 'missing-dir', 'child.txt'))).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('assertPathAbsent fails closed on non-ENOENT lstat errors (e.g. ERR_INVALID_ARG_VALUE)', () => {
    // 含 null byte 的路径使 lstatSync 抛 ERR_INVALID_ARG_VALUE（非 ENOENT）：
    // 不能当作 absent，必须 fail closed（旧实现 catch 后直接 return）。
    expect(() => assertPathAbsent('not-checked\u0000x')).toThrow(PlatformPathError);
  });

  it('canonicalAbsolutePath resolves relative paths and rejects empty input', () => {
    expect(canonicalAbsolutePath('relative/path.sql')).toBe(join(process.cwd(), 'relative/path.sql'));
    expect(() => canonicalAbsolutePath('')).toThrow(PlatformPathError);
    expect(() => canonicalAbsolutePath('   ')).toThrow(PlatformPathError);
  });
});
