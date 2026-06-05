import { Router } from 'express';
import { z } from 'zod';
import type { AppDatabase } from '../db/connection.js';
import type { CampaignNpc, CampaignQuest, Room } from '../domain/types.js';
import { requestOpenAiCompatibleMessage } from '../services/aiProvider.js';
import {
  createSessionSummary,
  listCampaignLocations,
  listCampaignNpcs,
  listCampaignQuests,
  listSessionSummaries,
  upsertCampaignLocation,
  upsertCampaignNpc,
  upsertCampaignQuest
} from '../services/campaignMemoryService.js';
import { parseAiConfigJson } from '../services/aiContextBuilder.js';
import { getGlobalAiProviderConfig } from '../services/globalConfigService.js';

const questUpdateSchema = z.object({
  title: z.string().min(1),
  status: z.enum(['active', 'in_progress', 'completed', 'failed']),
  description: z.string().default(''),
}).strict();

const npcUpdateSchema = z.object({
  name: z.string().min(1),
  role: z.string().default(''),
  attitude: z.enum(['friendly', 'neutral', 'hostile', 'unknown']).default('unknown'),
  notes: z.string().default(''),
  location: z.string().default(''),
}).strict();

const locationUpdateSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
}).strict();

function getRoom(db: AppDatabase, roomId: string): Room | null {
  const row = db.prepare('SELECT id, name, system_prompt as systemPrompt, world_info as worldInfo, current_turn as currentTurn, status, ai_config_json as aiConfigJson, created_at as createdAt FROM rooms WHERE id = ?').get(roomId) as any;
  return row ? {
    id: row.id,
    name: row.name,
    systemPrompt: row.systemPrompt,
    worldInfo: row.worldInfo,
    currentTurn: row.currentTurn,
    status: row.status,
    aiConfig: parseAiConfigJson(row.aiConfigJson),
    createdAt: row.createdAt
  } : null;
}

export function registerAdminMemoryRoutes(router: Router, db: AppDatabase): void {
  router.get('/rooms/:roomId/summaries', (req, res) => {
    const room = getRoom(db, req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const summaries = listSessionSummaries(db, req.params.roomId);
    res.json({ summaries });
  });

  router.post('/rooms/:roomId/summaries', async (req, res) => {
    const room = getRoom(db, req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const providerConfig = getGlobalAiProviderConfig(db);
    if (providerConfig.provider === 'mock') {
      return res.status(400).json({ error: 'Manual summary generation requires a real AI provider (not mock).' });
    }
    try {
      const recentLogs = db.prepare(
        'SELECT content FROM log_entries WHERE room_id = ? AND visibility_scope = ? ORDER BY created_at DESC LIMIT 10'
      ).all(req.params.roomId, 'public') as Array<{ content: string }>;

      const prompt = `你是战役记录官。请根据以下公开回合日志，生成结构化战役摘要和可供管理员审核的长期状态更新建议。返回严格JSON：{summary,questUpdates,npcUpdates,locationUpdates,characterUpdates}。这些 updates 只是建议，不会自动写入任务、NPC 或地点事实。\n日志：\n${recentLogs.map((l) => l.content).join('\n')}`;

      const summaryContent = await requestOpenAiCompatibleMessage(providerConfig as { provider: 'openai-compatible'; baseUrl: string; apiKey: string; model: string }, [
        { role: 'system', content: '你是战役记录官。只返回严格JSON。' },
        { role: 'user', content: prompt }
      ]);

      const summaryData = JSON.parse(summaryContent) as {
        summary?: string;
        questUpdates?: Array<{ title: string; status: string; description: string }>;
        npcUpdates?: Array<{ name: string; role: string; attitude: string; notes: string; location: string }>;
        locationUpdates?: Array<{ name: string; description: string }>;
        characterUpdates?: Array<{ characterId: string; update: string }>;
      };

      const turnEnd = room.currentTurn;
      const turnStart = Math.max(1, turnEnd - 4);

      const summary = createSessionSummary(db, req.params.roomId, {
        turnStart,
        turnEnd,
        summary: summaryData.summary ?? '',
        questUpdates: (summaryData.questUpdates ?? []) as Array<{ title: string; status: CampaignQuest['status']; description: string }>,
        npcUpdates: (summaryData.npcUpdates ?? []) as Array<{ name: string; role: string; attitude: CampaignNpc['attitude']; notes: string; location: string }>,
        locationUpdates: summaryData.locationUpdates ?? [],
        characterUpdates: summaryData.characterUpdates ?? [],
      });

      res.json({ summary });
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/rooms/:roomId/quests', (req, res) => {
    const room = getRoom(db, req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const quests = listCampaignQuests(db, req.params.roomId);
    res.json({ quests });
  });

  router.put('/rooms/:roomId/quests', (req, res) => {
    const room = getRoom(db, req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const input = questUpdateSchema.parse(req.body);
    const quest = upsertCampaignQuest(db, req.params.roomId, input);
    res.json({ quest });
  });

  router.get('/rooms/:roomId/npcs', (req, res) => {
    const room = getRoom(db, req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const npcs = listCampaignNpcs(db, req.params.roomId);
    res.json({ npcs });
  });

  router.put('/rooms/:roomId/npcs', (req, res) => {
    const room = getRoom(db, req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const input = npcUpdateSchema.parse(req.body);
    const npc = upsertCampaignNpc(db, req.params.roomId, input);
    res.json({ npc });
  });

  router.get('/rooms/:roomId/locations', (req, res) => {
    const room = getRoom(db, req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const locations = listCampaignLocations(db, req.params.roomId);
    res.json({ locations });
  });

  router.put('/rooms/:roomId/locations', (req, res) => {
    const room = getRoom(db, req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const input = locationUpdateSchema.parse(req.body);
    const location = upsertCampaignLocation(db, req.params.roomId, input);
    res.json({ location });
  });
}
