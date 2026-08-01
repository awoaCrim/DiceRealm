import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readNodePins } from './databaseContractSuite.js';

describe('node engine constraint', () => {
  // server/src/platform/database → server/src/platform → server/src → server → 仓库根（上溯四级）
  const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));
  it('declares engines.node matching .nvmrc', () => {
    const { engines, nvmrc } = readNodePins(repoRoot);
    expect(engines).toContain(nvmrc);
    expect(engines).toMatch(/^>=\d+\.\d+\.\d+ </);
  });
});
