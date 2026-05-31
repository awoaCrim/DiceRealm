import { describe, it, expect, beforeEach } from 'vitest';
import { createMemoryDb } from '../db/connection.js';
import { migrate } from '../db/schema.js';
import { nanoid } from 'nanoid';
import {
  createSessionSummary,
  listSessionSummaries,
  upsertCampaignQuest,
  upsertCampaignNpc,
  upsertCampaignLocation,
  listCampaignQuests,
  listCampaignNpcs,
  listCampaignLocations,
  buildCampaignContext,
} from '../services/campaignMemoryService.js';

function seedRoom(db: ReturnType<typeof createMemoryDb>, name = '记忆房间') {
  const roomId = nanoid();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO rooms (id, name, system_prompt, world_info, current_turn, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(roomId, name, '', '', 0, 'setup', now);
  return roomId;
}

describe('campaignMemoryService', () => {
  describe('createSessionSummary', () => {
    it('stores AI-generated summary with structured fields', () => {
      const db = createMemoryDb();
      migrate(db);
      try {
        const roomId = seedRoom(db);

        const summary = createSessionSummary(db, roomId, {
          turnStart: 1,
          turnEnd: 5,
          summary: '队伍击败了地精，找到了秘密通道。',
          questUpdates: [
            {
              title: '救援矿工',
              status: 'in_progress' as const,
              description: '矿工被地精困在矿井深处。',
            },
          ],
          npcUpdates: [
            {
              name: '格拉克',
              role: '地精首领',
              attitude: 'hostile' as const,
              notes: '被击败后逃跑，发誓复仇。',
              location: '矿井入口',
            },
          ],
          locationUpdates: [
            {
              name: '废弃矿井',
              description: '一处被地精占据的旧矿井，深处有异常声响。',
            },
          ],
          characterUpdates: [
            {
              characterId: 'char-1',
              update: '洛林用长剑击败了格拉克。',
            },
          ],
        });

        expect(summary.id).toBeTruthy();
        expect(summary.turnStart).toBe(1);
        expect(summary.turnEnd).toBe(5);
        expect(summary.summary).toBe('队伍击败了地精，找到了秘密通道。');
        expect(JSON.parse(summary.questUpdatesJson)).toEqual([
          {
            title: '救援矿工',
            status: 'in_progress',
            description: '矿工被地精困在矿井深处。',
          },
        ]);
        expect(db.prepare('SELECT COUNT(*) as count FROM campaign_quests').get()).toMatchObject({ count: 0 });
        expect(db.prepare('SELECT COUNT(*) as count FROM campaign_npcs').get()).toMatchObject({ count: 0 });
        expect(db.prepare('SELECT COUNT(*) as count FROM campaign_locations').get()).toMatchObject({ count: 0 });
      } finally {
        db.close();
      }
    });
  });

  describe('listSessionSummaries', () => {
    it('returns ordered by createdAt DESC', () => {
      const db = createMemoryDb();
      migrate(db);
      try {
        const roomId = seedRoom(db);

        createSessionSummary(db, roomId, {
          turnStart: 1,
          turnEnd: 2,
          summary: '第一条摘要',
        });

        createSessionSummary(db, roomId, {
          turnStart: 3,
          turnEnd: 4,
          summary: '第二条摘要',
        });

        const summaries = listSessionSummaries(db, roomId);
        expect(summaries).toHaveLength(2);
        expect(summaries[0].summary).toBe('第二条摘要');
        expect(summaries[1].summary).toBe('第一条摘要');
      } finally {
        db.close();
      }
    });
  });

  describe('upsertCampaignQuest', () => {
    it('inserts new and updates existing', () => {
      const db = createMemoryDb();
      migrate(db);
      try {
        const roomId = seedRoom(db);

        // First upsert
        upsertCampaignQuest(db, roomId, {
          title: '救援矿工',
          status: 'in_progress',
          description: '矿工被地精困在矿井深处。',
        });

        const quests1 = listCampaignQuests(db, roomId);
        expect(quests1).toHaveLength(1);
        expect(quests1[0].title).toBe('救援矿工');
        expect(quests1[0].status).toBe('in_progress');

        // Second upsert with same title updates existing
        upsertCampaignQuest(db, roomId, {
          title: '救援矿工',
          status: 'completed',
          description: '矿工已被成功救出。',
        });

        const quests2 = listCampaignQuests(db, roomId);
        expect(quests2).toHaveLength(1);
        expect(quests2[0].status).toBe('completed');
        expect(quests2[0].description).toBe('矿工已被成功救出。');
      } finally {
        db.close();
      }
    });
  });

  describe('upsertCampaignNpc', () => {
    it('inserts new and updates existing NPC', () => {
      const db = createMemoryDb();
      migrate(db);
      try {
        const roomId = seedRoom(db);

        // First upsert
        upsertCampaignNpc(db, roomId, {
          name: '格拉克',
          role: '地精首领',
          attitude: 'hostile',
          notes: '被击败后逃跑。',
          location: '矿井入口',
        });

        const npcs1 = listCampaignNpcs(db, roomId);
        expect(npcs1).toHaveLength(1);
        expect(npcs1[0].name).toBe('格拉克');
        expect(npcs1[0].attitude).toBe('hostile');

        // Second upsert with same name updates existing
        upsertCampaignNpc(db, roomId, {
          name: '格拉克',
          role: '地精首领',
          attitude: 'neutral',
          notes: '与队伍达成了临时协议。',
          location: '幽暗森林',
        });

        const npcs2 = listCampaignNpcs(db, roomId);
        expect(npcs2).toHaveLength(1);
        expect(npcs2[0].attitude).toBe('neutral');
        expect(npcs2[0].location).toBe('幽暗森林');
      } finally {
        db.close();
      }
    });
  });

  describe('upsertCampaignLocation', () => {
    it('inserts new and updates existing location', () => {
      const db = createMemoryDb();
      migrate(db);
      try {
        const roomId = seedRoom(db);

        // First upsert
        upsertCampaignLocation(db, roomId, {
          name: '废弃矿井',
          description: '一处被地精占据的旧矿井。',
        });

        const locs1 = listCampaignLocations(db, roomId);
        expect(locs1).toHaveLength(1);
        expect(locs1[0].name).toBe('废弃矿井');

        // Second upsert with same name updates existing
        upsertCampaignLocation(db, roomId, {
          name: '废弃矿井',
          description: '矿井已被清理，矿工正在恢复作业。',
        });

        const locs2 = listCampaignLocations(db, roomId);
        expect(locs2).toHaveLength(1);
        expect(locs2[0].description).toBe('矿井已被清理，矿工正在恢复作业。');
      } finally {
        db.close();
      }
    });
  });

  describe('buildCampaignContext', () => {
    it('returns injected prompt string with campaign memory sections', () => {
      const db = createMemoryDb();
      migrate(db);
      try {
        const roomId = seedRoom(db);

        // Create summary
        createSessionSummary(db, roomId, {
          turnStart: 1,
          turnEnd: 3,
          summary: '队伍进入废弃矿井，击败了一群地精。',
          questUpdates: [
            {
              title: '救援矿工',
              status: 'in_progress',
              description: '矿工被地精困在矿井深处。',
            },
          ],
          npcUpdates: [
            {
              name: '格拉克',
              role: '地精首领',
              attitude: 'hostile',
              notes: '被击败后逃跑，发誓复仇。',
              location: '矿井入口',
            },
          ],
          locationUpdates: [
            {
              name: '废弃矿井',
              description: '一处被地精占据的旧矿井，深处有异常声响。',
            },
          ],
        });
        upsertCampaignQuest(db, roomId, {
          title: '救援矿工',
          status: 'in_progress',
          description: '矿工被地精困在矿井深处。',
        });
        upsertCampaignNpc(db, roomId, {
          name: '格拉克',
          role: '地精首领',
          attitude: 'hostile',
          notes: '被击败后逃跑，发誓复仇。',
          location: '矿井入口',
        });
        upsertCampaignLocation(db, roomId, {
          name: '废弃矿井',
          description: '一处被地精占据的旧矿井，深处有异常声响。',
        });

        const context = buildCampaignContext(db, roomId);

        expect(context).toContain('# 战役记忆');
        expect(context).toContain('## 最近事件');
        expect(context).toContain('队伍进入废弃矿井，击败了一群地精。');
        expect(context).toContain('## 进行中任务');
        expect(context).toContain('救援矿工');
        expect(context).toContain('## 已知 NPC');
        expect(context).toContain('格拉克');
        expect(context).toContain('## 已探索地点');
        expect(context).toContain('废弃矿井');
      } finally {
        db.close();
      }
    });
  });
});
