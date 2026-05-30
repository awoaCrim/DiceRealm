import { describe, expect, it } from 'vitest';
import { createMemoryDb } from '../db/connection.js';
import { migrate } from '../db/schema.js';
import {
  createResourceImportJob,
  listApprovedCharacterOptions,
  listApprovedResourceRules,
  listApprovedRuleEntries,
  listResourceImportDrafts,
  listResourceImportJobs,
  normalizeResourceImportPayload,
  reviewResourceImportDraft
} from '../services/resourceReviewService.js';

function withDb(run: (db: ReturnType<typeof createMemoryDb>) => void): void {
  const db = createMemoryDb();
  try {
    migrate(db);
    run(db);
  } finally {
    db.close();
  }
}

const samplePayload = {
  name: 'PHB 1级角色核心抽取',
  sourceType: 'phb_extraction',
  sourceFileName: '5eDnD_玩家手册PHB_中译v1.72版.pdf',
  ruleset: '5e-2014',
  language: 'zh-CN',
  drafts: [
    {
      kind: 'rule_entry',
      title: '攻击检定',
      category: 'combat',
      summary: '进行攻击时掷 d20 并加上相关调整值与熟练加值。',
      content: '攻击检定用于判断攻击是否命中目标 AC。',
      keys: ['攻击检定', 'AC', '命中'],
      sourceRef: 'PHB p.194'
    },
    {
      kind: 'character_option',
      optionType: 'class',
      title: '战士',
      summary: '擅长武器与护甲的武技专家。',
      ruleData: { hitDie: 'd10', primaryAbilities: ['str', 'dex'] },
      prerequisites: {},
      sourceRef: 'PHB p.70'
    },
    {
      kind: 'resource_rule',
      title: '生命骰',
      category: 'rest',
      summary: '短休时可消耗生命骰恢复生命值。',
      ruleData: { resource: 'hit_dice', recovery: 'long_rest_half' },
      sourceRef: 'PHB p.186'
    }
  ]
} as const;

describe('resourceReviewService', () => {
  it('normalizes structured resource import payloads with private source metadata', () => {
    const payload = normalizeResourceImportPayload(samplePayload);

    expect(payload).toMatchObject({
      name: 'PHB 1级角色核心抽取',
      sourceType: 'phb_extraction',
      sourceFileName: '5eDnD_玩家手册PHB_中译v1.72版.pdf',
      ruleset: '5e-2014',
      language: 'zh-CN',
      visibility: 'private',
      isPrivate: true
    });
    expect(payload.drafts).toHaveLength(3);
    expect(payload.drafts[1]).toMatchObject({ kind: 'character_option', optionType: 'class', status: 'pending' });
  });

  it('rejects invalid character option drafts and unknown draft kinds', () => {
    expect(() => normalizeResourceImportPayload({
      name: '非法抽取',
      drafts: [{ kind: 'character_option', title: '缺类型', summary: '缺少 optionType。' }]
    })).toThrowError('character_option drafts require optionType');

    expect(() => normalizeResourceImportPayload({
      name: '非法类型',
      drafts: [{ kind: 'feat', title: '专长', summary: '暂不支持。' }]
    })).toThrowError();

    expect(() => normalizeResourceImportPayload({
      name: '预留类型',
      drafts: [{ kind: 'spell', title: '魔法飞弹', summary: '后续阶段支持。' }]
    })).toThrowError('Unsupported resource draft kind for this import phase');
  });

  it('creates resource import tables and useful indexes during migration', () => {
    withDb((db) => {
      const tables = db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('resource_import_jobs', 'resource_import_drafts', 'rule_world_book_entries', 'character_options', 'resource_rules')
        ORDER BY name ASC
      `).all() as Array<{ name: string }>;

      expect(tables.map((table) => table.name)).toEqual([
        'character_options',
        'resource_import_drafts',
        'resource_import_jobs',
        'resource_rules',
        'rule_world_book_entries'
      ]);
      const indexColumns = (indexName: string) => (
        db.prepare(`PRAGMA index_info('${indexName}')`).all() as Array<{ name: string }>
      ).map((column) => column.name);
      expect(indexColumns('resource_import_drafts_job_id_idx')).toEqual(['job_id']);
      expect(indexColumns('resource_import_drafts_status_idx')).toEqual(['status']);
      expect(indexColumns('resource_import_drafts_kind_idx')).toEqual(['kind']);
      expect(indexColumns('resource_import_drafts_source_type_idx')).toEqual(['source_type']);
      expect(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'resource_import_drafts'").get())
        .toMatchObject({ sql: expect.stringContaining('preset_module') });
    });
  });

  it('creates a job and stores all rows as pending drafts with source metadata', () => {
    withDb((db) => {
      const result = createResourceImportJob(db, samplePayload);

      expect(result.job).toMatchObject({
        name: 'PHB 1级角色核心抽取',
        sourceType: 'phb_extraction',
        sourceFileName: '5eDnD_玩家手册PHB_中译v1.72版.pdf',
        ruleset: '5e-2014',
        language: 'zh-CN',
        visibility: 'private',
        isPrivate: true,
        status: 'imported'
      });
      expect(result.job.sourceHash).toMatch(/^[a-f0-9]{64}$/);
      expect(result.drafts).toHaveLength(3);
      expect(result.drafts.every((draft) => draft.status === 'pending')).toBe(true);
      expect(result.drafts.every((draft) => draft.contentHash.match(/^[a-f0-9]{64}$/))).toBe(true);
      expect(listResourceImportJobs(db)).toHaveLength(1);
      expect(listResourceImportDrafts(db, { status: 'pending', sourceType: 'phb_extraction', ruleset: '5e-2014', language: 'zh-CN' })).toHaveLength(3);
    });
  });

  it('approval materializes drafts into approved catalogs and excludes pending drafts', () => {
    withDb((db) => {
      const result = createResourceImportJob(db, samplePayload);
      const [ruleDraft, characterDraft, resourceDraft] = result.drafts;

      reviewResourceImportDraft(db, ruleDraft.id, { status: 'approved' });
      reviewResourceImportDraft(db, characterDraft.id, { status: 'approved' });

      expect(listApprovedRuleEntries(db)).toEqual([
        expect.objectContaining({ title: '攻击检定', category: 'combat', keys: ['攻击检定', 'AC', '命中'] })
      ]);
      expect(listApprovedCharacterOptions(db)).toEqual([
        expect.objectContaining({ optionType: 'class', name: '战士', ruleData: { hitDie: 'd10', primaryAbilities: ['str', 'dex'] } })
      ]);
      expect(listApprovedResourceRules(db)).toEqual([]);

      reviewResourceImportDraft(db, resourceDraft.id, { status: 'approved' });
      expect(listApprovedResourceRules(db)).toEqual([
        expect.objectContaining({ name: '生命骰', category: 'rest', ruleData: { resource: 'hit_dice', recovery: 'long_rest_half' } })
      ]);
    });
  });

  it('rejection does not expose data through approved catalogs', () => {
    withDb((db) => {
      const result = createResourceImportJob(db, {
        name: '拒绝样例',
        drafts: [{ kind: 'character_option', optionType: 'equipment', title: '错误装备', summary: '错误装备。' }]
      });

      const reviewed = reviewResourceImportDraft(db, result.drafts[0].id, {
        status: 'rejected',
        rejectionReason: '页码匹配错误'
      });

      expect(reviewed).toMatchObject({ status: 'rejected', rejectionReason: '页码匹配错误' });
      expect(listApprovedCharacterOptions(db)).toEqual([]);
    });
  });

  it('does not allow reviewing the same draft twice', () => {
    withDb((db) => {
      const result = createResourceImportJob(db, {
        name: '重复审核样例',
        drafts: [{ kind: 'rule_entry', title: '熟练加值', summary: '熟练时加入熟练加值。' }]
      });

      reviewResourceImportDraft(db, result.drafts[0].id, { status: 'approved' });

      expect(() => reviewResourceImportDraft(db, result.drafts[0].id, {
        status: 'rejected',
        rejectionReason: '重复审核'
      })).toThrowError('Only pending resource import drafts can be reviewed');
    });
  });
});
