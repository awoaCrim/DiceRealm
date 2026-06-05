import { Router, type Response } from 'express';
import { z } from 'zod';
import type { AppDatabase } from '../db/connection.js';
import {
  AiTurnWorkflowHttpError,
  applyAiTurnPreview,
  createAiTurnPreview,
  sendAiTurnPreview
} from '../services/aiTurnWorkflowService.js';
import { getTurnReadiness, StaleTurnPreviewError, TurnNotReadyError, turnNotReadyPayload } from '../services/turnReadinessService.js';
import { buildRoomPromptPreview } from '../services/promptPreviewService.js';
import { parseAiConfigJson } from '../services/aiContextBuilder.js';
import type { Room } from '../domain/types.js';

const aiTurnPreviewSchema = z.object({
  roomId: z.string().min(1)
}).strict();

const aiTurnSendPreviewSchema = z.object({
  roomId: z.string().min(1),
  previewId: z.string().min(1),
  flatPrompt: z.string().min(1)
}).strict();

const aiTurnApplyPreviewSchema = z.object({
  roomId: z.string().min(1),
  previewId: z.string().min(1),
  confirmedSuggestedStateChangeIndexes: z.array(z.number().int().nonnegative()).default([]),
  confirmedCharacterResourceChangeIndexes: z.array(z.number().int().nonnegative()).default([])
}).strict();

function mapRoomRow(row: any): Room {
  return {
    id: row.id,
    name: row.name,
    systemPrompt: row.systemPrompt,
    worldInfo: row.worldInfo,
    currentTurn: row.currentTurn,
    status: row.status,
    aiConfig: parseAiConfigJson(row.aiConfigJson),
    createdAt: row.createdAt
  };
}

function getRoom(db: AppDatabase, roomId: string): Room | null {
  const row = db.prepare('SELECT id, name, system_prompt as systemPrompt, world_info as worldInfo, current_turn as currentTurn, status, ai_config_json as aiConfigJson, created_at as createdAt FROM rooms WHERE id = ?').get(roomId) as any;
  return row ? mapRoomRow(row) : null;
}

function handleTurnReadinessError(error: unknown, res: Response): boolean {
  if (error instanceof TurnNotReadyError) {
    res.status(409).json(turnNotReadyPayload(error.readiness));
    return true;
  }
  if (error instanceof StaleTurnPreviewError) {
    res.status(409).json({
      error: 'STALE_PROMPT_PREVIEW',
      message: '当前回合已变化，请重新生成 AI 提示词。',
      currentTurnId: error.currentTurnId
    });
    return true;
  }
  return false;
}

function handleWorkflowError(error: unknown, res: Response): boolean {
  if (handleTurnReadinessError(error, res)) return true;
  if (error instanceof AiTurnWorkflowHttpError) {
    res.status(error.statusCode).json(error.payload);
    return true;
  }
  return false;
}

export function registerAdminAiTurnRoutes(router: Router, db: AppDatabase): void {
  router.get('/rooms/:roomId/ai-prompt-preview', async (req, res) => {
    const room = getRoom(db, req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const readiness = getTurnReadiness(db, room, { updateStatus: false });
    const includeCurrentTurnActions = readiness.ready;
    const { preview } = await buildRoomPromptPreview(db, room, { includeCurrentTurnActions });
    res.json(includeCurrentTurnActions
      ? preview
      : {
        ...preview,
        warnings: [
          ...preview.warnings,
          '此配置预览不会包含未完成回合的当前行动；可发送给 AI 的回合提示词只能在所有必需玩家完成后通过 AI-DM 回合调试生成。'
        ]
      });
  });

  router.post('/ai/turn-preview', async (req, res) => {
    const input = aiTurnPreviewSchema.parse(req.body);
    try {
      res.json(await createAiTurnPreview(db, input.roomId));
    } catch (error) {
      if (handleWorkflowError(error, res)) return;
      throw error;
    }
  });

  router.post('/ai/send-preview', async (req, res) => {
    const input = aiTurnSendPreviewSchema.parse(req.body);
    try {
      res.json(await sendAiTurnPreview(db, input));
    } catch (error) {
      if (handleWorkflowError(error, res)) return;
      throw error;
    }
  });

  router.post('/ai/apply-preview', async (req, res) => {
    const input = aiTurnApplyPreviewSchema.parse(req.body);
    try {
      res.json(await applyAiTurnPreview(db, input));
    } catch (error) {
      if (handleWorkflowError(error, res)) return;
      throw error;
    }
  });
}
