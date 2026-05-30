import { describe, expect, it } from 'vitest';
import { createMemoryDb } from '../db/connection.js';
import { migrate } from '../db/schema.js';
import {
  createResourceImportJob,
  listResourceImportDrafts,
  reviewResourceImportDraft
} from '../services/resourceReviewService.js';
import {
  indexApprovedRuleEntries,
  listRuleSummariesForRoom,
  retrieveRuleMatches,
  storeRuleContextHits
} from '../services/ruleRetrievalService.js';
import { createEmbeddingProviderFromConfig } from '../services/embeddingService.js';

function seedApprovedRules(db: ReturnType<typeof createMemoryDb>) {
  createResourceImportJob(db, {
    name: '规则检索测试抽取',
    sourceFileName: 'phb.pdf',
    drafts: [
      {
        kind: 'rule_entry',
        title: '攻击检定',
        category: 'combat',
        summary: '攻击时掷 d20 对抗 AC。',
        content: '攻击检定用于判断攻击是否命中目标 AC。',
        keys: ['攻击检定', 'AC', '命中'],
        priority: 200
      },
      {
        kind: 'rule_entry',
        title: '长休',
        category: 'rest',
        summary: '长休恢复生命值和部分资源。',
        content: '长休通常需要至少 8 小时。',
        keys: ['长休', '恢复'],
        priority: 100
      },
      {
        kind: 'character_option',
        optionType: 'class',
        title: '战士',
        summary: '擅长武器与护甲的武技专家。',
        content: '战士是不应进入规则索引的职业选项。',
        keys: ['战士'],
        priority: 300
      }
    ]
  });

  for (const draft of listResourceImportDrafts(db, { kind: 'rule_entry' })) {
    reviewResourceImportDraft(db, draft.id, { status: 'approved' });
  }
}

function mockEmbeddingProvider(dimensions = 8) {
  return createEmbeddingProviderFromConfig({
    provider: 'mock',
    baseUrl: '',
    apiKey: '',
    model: '',
    dimensions
  });
}

describe('ruleRetrievalService', () => {
  it('indexes only approved rule entries', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedApprovedRules(db);

    try {
      const result = await indexApprovedRuleEntries(db, mockEmbeddingProvider());
      const count = db.prepare('SELECT COUNT(*) as count FROM rule_entry_embeddings').get() as { count: number };

      expect(result).toEqual({ indexed: 2, skipped: 0 });
      expect(count.count).toBe(2);
    } finally {
      db.close();
    }
  });

  it('re-indexes approved rule entries when embedding provider fingerprint changes', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedApprovedRules(db);

    try {
      await expect(indexApprovedRuleEntries(db, mockEmbeddingProvider(8))).resolves.toEqual({ indexed: 2, skipped: 0 });
      await expect(indexApprovedRuleEntries(db, mockEmbeddingProvider(8))).resolves.toEqual({ indexed: 0, skipped: 2 });
      await expect(indexApprovedRuleEntries(db, mockEmbeddingProvider(4))).resolves.toEqual({ indexed: 2, skipped: 0 });

      const rows = db.prepare('SELECT embedding_json as embeddingJson FROM rule_entry_embeddings').all() as Array<{ embeddingJson: string }>;
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => (JSON.parse(row.embeddingJson) as number[]).length === 4)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('retrieves matches by keyword and semantic score', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedApprovedRules(db);

    try {
      const provider = mockEmbeddingProvider();
      await indexApprovedRuleEntries(db, provider);

      const matches = await retrieveRuleMatches(db, provider, '我挥剑攻击强盗，看看能不能命中 AC。', { limit: 5 });

      expect(matches[0]).toMatchObject({ title: '攻击检定', category: 'combat' });
      expect(matches[0].reasons).toContain('keyword');
      expect(matches[0].score).toBeGreaterThan(0);
      expect(matches.every((match) => match.score > 0)).toBe(true);
      expect(matches.map((match) => match.title)).not.toContain('战士');
    } finally {
      db.close();
    }
  });

  it('falls back to keyword matches when rules are not indexed and embedding provider fails', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedApprovedRules(db);

    try {
      const failingProvider = {
        name: 'failing',
        fingerprint: 'failing:test',
        async embed(): Promise<number[]> {
          throw new Error('embedding down');
        }
      };

      const matches = await retrieveRuleMatches(db, failingProvider, '我要长休恢复资源。', { limit: 3 });

      expect(matches[0]).toMatchObject({ title: '长休', category: 'rest' });
      expect(matches[0].reasons).toContain('keyword');
    } finally {
      db.close();
    }
  });

  it('stores short player-visible rule summaries', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedApprovedRules(db);

    try {
      db.prepare(`
        INSERT INTO rooms (id, name, system_prompt, world_info, current_turn, status, ai_config_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('room-1', '测试房间', '', '', 1, 'setup', '{}', '2026-05-30T00:00:00.000Z');
      db.prepare(`
        INSERT INTO turns (id, room_id, number, status, started_at)
        VALUES (?, ?, ?, ?, ?)
      `).run('turn-1', 'room-1', 1, 'open', '2026-05-30T00:00:00.000Z');

      const provider = mockEmbeddingProvider();
      await indexApprovedRuleEntries(db, provider);
      const matches = await retrieveRuleMatches(db, provider, '短休后还能长休吗？', { limit: 5 });

      storeRuleContextHits(db, { roomId: 'room-1', turnId: 'turn-1', matches });
      const summaries = listRuleSummariesForRoom(db, 'room-1');

      expect(summaries.length).toBeGreaterThan(0);
      expect(summaries[0].entryId).toBeTruthy();
      expect(summaries[0].reason).toContain('参考规则');
      expect(summaries[0].summary).toBeTruthy();
    } finally {
      db.close();
    }
  });
});

