import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryDb } from '../db/connection.js';
import { migrate } from '../db/schema.js';
import {
  checkForUpdates,
  deleteSource,
  detectSourceType,
  fetchRemoteJson,
  importFromUrlAsync,
  listSources,
  parseJsDatabase,
  getSource
} from '../services/remoteDbImportService.js';

async function createStubServer(handler: (body: unknown) => unknown): Promise<{ url: string; close: () => Promise<void>; updateHandler: (newHandler: (body: unknown) => unknown) => void }> {
  let currentHandler = handler;
  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const result = await currentHandler(null);
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(result));
      } catch {
        res.statusCode = 500;
        res.end('Internal Server Error');
      }
    })();
  });

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      if (!port) {
        reject(new Error('Failed to get server port'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: async () => {
          return new Promise<void>((res) => server.close(() => res()));
        },
        updateHandler: (newHandler: (body: unknown) => unknown) => {
          currentHandler = newHandler;
        }
      });
    });
    server.on('error', reject);
  });
}

describe('remoteDbImportService', () => {
  describe('detectSourceType', () => {
    it('detects world book JSON from entries array', () => {
      const json = { entries: [{ uid: 1, key: '测试', content: '测试内容' }] };
      expect(detectSourceType(json)).toBe('world_book');
    });

    it('detects preset package JSON from openai settings', () => {
      const json = { temperature: 0.7, model: 'gpt-4' };
      expect(detectSourceType(json)).toBe('preset_package');
    });

    it('detects character options JSON from option arrays', () => {
      const json = { species: [{ name: '人类', summary: '标准人类' }], classes: [{ name: '战士' }] };
      expect(detectSourceType(json)).toBe('character_options');
    });

    it('detects rules JSON from rules array', () => {
      const json = { rules: [{ title: '攻击检定', content: '...' }] };
      expect(detectSourceType(json)).toBe('rules_json');
    });

    it('returns unknown for unrecognized JSON', () => {
      expect(detectSourceType({ foo: 'bar' })).toBe('unknown');
      expect(detectSourceType(null)).toBe('unknown');
      expect(detectSourceType([])).toBe('unknown');
      expect(detectSourceType('string')).toBe('unknown');
    });
  });

  describe('parseJsDatabase', () => {
    it('importJsDatabase evaluates in sandbox', () => {
      const jsCode = `module.exports = { entries: [{ uid: 1, key: '沙箱测试', content: '沙箱内容' }] };`;
      const result = parseJsDatabase(jsCode);
      expect(result).toEqual({ entries: [{ uid: 1, key: '沙箱测试', content: '沙箱内容' }] });
    });

    it('rejects jsCode with require', () => {
      expect(() => parseJsDatabase("module.exports = require('fs')")).toThrow(/Forbidden token/);
    });

    it('rejects jsCode with process', () => {
      expect(() => parseJsDatabase('module.exports = process.env')).toThrow(/Forbidden token/);
    });

    it('rejects jsCode with global', () => {
      expect(() => parseJsDatabase('module.exports = global')).toThrow(/Forbidden token/);
    });

    it('rejects empty return', () => {
      expect(() => parseJsDatabase('module.exports = 42;')).toThrow(/JS database code must return a JSON object/);
    });
  });

  describe('fetchRemoteJson', () => {
    let server1: Awaited<ReturnType<typeof createStubServer>>;

    beforeAll(async () => {
      server1 = await createStubServer(() => ({ entries: [{ uid: 1, key: '远程', content: '远程内容' }] }));
    });

    afterAll(async () => {
      await server1.close();
    });

    it('fetches JSON and returns hash, size', async () => {
      const result = await fetchRemoteJson(server1.url);
      expect(result.json).toEqual({ entries: [{ uid: 1, key: '远程', content: '远程内容' }] });
      expect(result.fileHash).toBeTruthy();
      expect(result.fileHash).toHaveLength(64); // SHA256 hex
      expect(result.fileSize).toBeGreaterThan(0);
    });
  });

  describe('importFromUrlAsync and source management', () => {
    let db: ReturnType<typeof createMemoryDb>;
    let stubServer: Awaited<ReturnType<typeof createStubServer>>;

    beforeAll(async () => {
      stubServer = await createStubServer(() => ({
        entries: [
          { uid: 1, key: '测试', content: '测试内容' },
          { uid: 2, key: '测试2', content: '更多内容' }
        ]
      }));
    });

    afterAll(async () => {
      await stubServer.close();
    });

    beforeEach(() => {
      db = createMemoryDb();
      migrate(db);
    });

    afterEach(() => {
      db.close();
    });

    it('stores source metadata with hash and size', async () => {
      const result = await importFromUrlAsync(db, stubServer.url, '测试世界书');
      expect(result.source).toBeTruthy();
      expect(result.source.fileHash).toBeTruthy();
      expect(result.source.fileHash.length).toBe(64);
      expect(result.source.fileSize).toBeGreaterThan(0);
      expect(result.source.entryCount).toBe(2);

      const sources = listSources(db);
      expect(sources).toHaveLength(1);
      expect(sources[0].fileHash).toBe(result.source.fileHash);
      expect(sources[0].entryCount).toBe(2);
    });

    it('imports world book from entries array', async () => {
      const result = await importFromUrlAsync(db, stubServer.url, '远程世界书');
      expect(result.sourceType).toBe('world_book');
      expect(result.worldBook).toBeTruthy();
      expect(result.worldBook!.name).toBe('远程世界书');
      expect(result.source.entryCount).toBe(2);

      // Verify entries were created
      const entryCount = db.prepare('SELECT COUNT(*) as count FROM resource_world_book_entries WHERE world_book_id = ?')
        .get(result.worldBook!.id) as { count: number };
      expect(entryCount.count).toBe(2);
    });

    it('imports preset package from openai settings', async () => {
      stubServer.updateHandler(() => ({ temperature: 0.7, model: 'gpt-4', name: 'GPT-4 预设' }));
      const result = await importFromUrlAsync(db, stubServer.url, 'GPT-4 预设');
      expect(result.sourceType).toBe('preset_package');
      expect(result.presetPackage).toBeTruthy();
      expect(result.presetPackage!.name).toBe('GPT-4 预设');
    });

    it('imports character options from option arrays', async () => {
      stubServer.updateHandler(() => ({
        species: [{ name: '人类', summary: '标准人类' }],
        classes: [{ name: '战士', summary: '前线战士' }]
      }));
      const result = await importFromUrlAsync(db, stubServer.url, '角色选项');
      expect(result.sourceType).toBe('character_options');
      expect(result.draftsCount).toBe(2);
    });

    it('imports rules JSON from rules array', async () => {
      stubServer.updateHandler(() => ({
        rules: [{ title: '攻击检定', category: 'combat', summary: '攻击时掷 d20 对抗 AC。', content: '详细规则...' }]
      }));
      const result = await importFromUrlAsync(db, stubServer.url, '5e规则');
      expect(result.sourceType).toBe('rules_json');
      expect(result.draftsCount).toBe(1);
    });

    it('checkForUpdates returns hasUpdate false when hash matches', async () => {
      const result = await importFromUrlAsync(db, stubServer.url, '测试');
      const updateCheck = await checkForUpdates(db, result.source.id);
      expect(updateCheck.hasUpdate).toBe(false);
    });

    it('checkForUpdates returns hasUpdate true when content changes', async () => {
      const result = await importFromUrlAsync(db, stubServer.url, '测试');
      stubServer.updateHandler(() => ({
        entries: [{ uid: 1, key: '新内容', content: '更新后的内容' }]
      }));
      const updateCheck = await checkForUpdates(db, result.source.id);
      expect(updateCheck.hasUpdate).toBe(true);
      expect(updateCheck.newHash).toBeTruthy();
    });

    it('deleteSource removes source and cascade imports', async () => {
      const result = await importFromUrlAsync(db, stubServer.url, '测试');
      const deleted = deleteSource(db, result.source.id);
      expect(deleted).toBe(true);

      const sources = listSources(db);
      expect(sources).toHaveLength(0);

      const imports = db.prepare('SELECT COUNT(*) as count FROM remote_db_imports WHERE source_id = ?')
        .get(result.source.id) as { count: number };
      expect(imports.count).toBe(0);
    });

    it('getSource returns null for missing id', () => {
      expect(getSource(db, 'nonexistent')).toBeNull();
    });
  });

  describe('source type detection with openAiSettings key', () => {
    it('detects preset_package when openAiSettings key exists', () => {
      const json = { openAiSettings: { temperature: 0.7 } };
      expect(detectSourceType(json)).toBe('preset_package');
    });
  });

  describe('character options import handles missing option arrays', () => {
    it('detects character_options from backgrounds array only', () => {
      const json = { backgrounds: [{ name: '侍僧' }] };
      expect(detectSourceType(json)).toBe('character_options');
    });
  });
});
