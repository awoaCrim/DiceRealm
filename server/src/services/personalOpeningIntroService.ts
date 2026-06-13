import { nanoid } from 'nanoid';
import type { AppDatabase } from '../db/connection.js';
import type { CharacterSheet } from '../domain/types.js';
import { getGlobalAiProviderConfig } from './globalConfigService.js';
import { requestOpenAiCompatibleMessage } from './aiProvider.js';

export const PERSONAL_OPENING_TITLE = '个人开场';

export class PersonalOpeningIntroError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

export interface PreparedPersonalOpeningIntro {
  id: string;
  roomId: string;
  turnId: string | null;
  playerId: string;
  title: typeof PERSONAL_OPENING_TITLE;
  content: string;
  createdAt: string;
}

interface PlayerCharacterRow {
  playerId: string;
  playerName: string;
  characterId: string;
  sheetJson: string;
  confirmed: number;
  createdAt: string;
}

interface PlayerCharacterSummary {
  playerId: string;
  playerName: string;
  characterId: string;
  sheet: CharacterSheet;
  confirmed: boolean;
  createdAt: string;
}

function parseSheet(json: string): CharacterSheet {
  return JSON.parse(json) as CharacterSheet;
}

function compact(value: string | undefined): string {
  return value?.trim() || '未填写';
}

function publicOpeningScene(db: AppDatabase, roomId: string): string {
  const row = db.prepare(`
    SELECT content
    FROM log_entries
    WHERE room_id = ? AND visibility_scope = 'public' AND title IN ('公开开场', 'Opening Scene')
    ORDER BY created_at ASC
    LIMIT 1
  `).get(roomId) as { content: string } | undefined;
  if (row?.content?.trim()) return row.content.trim();
  const fallback = db.prepare(`
    SELECT content
    FROM log_entries
    WHERE room_id = ? AND visibility_scope = 'public'
    ORDER BY created_at ASC
    LIMIT 1
  `).get(roomId) as { content: string } | undefined;
  return fallback?.content?.trim() || '开场地点尚未明确，请根据房间信息写成自然、可承接的开场。';
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const candidates = [
    trimmed,
    trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/)?.[1],
    trimmed.match(/\{[\s\S]*\}/)?.[0]
  ].filter((item): item is string => Boolean(item));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
    }
  }
  return null;
}

function normalizeIntroResponse(raw: string, playerIds: string[]): Record<string, string> {
  const parsed = parseJsonObject(raw);
  const intros = parsed?.introsByPlayerId;
  if (!intros || typeof intros !== 'object' || Array.isArray(intros)) {
    throw new PersonalOpeningIntroError(502, 'AI 个人开场返回格式不合法：缺少 introsByPlayerId。');
  }

  const record = intros as Record<string, unknown>;
  const result: Record<string, string> = {};
  for (const playerId of playerIds) {
    const value = record[playerId];
    if (typeof value !== 'string' || !value.trim()) {
      throw new PersonalOpeningIntroError(502, `AI 个人开场返回缺少玩家 ${playerId} 的内容。`);
    }
    result[playerId] = sanitizeIntroText(value);
  }
  return result;
}

function sanitizeIntroText(value: string): string {
  return value
    .trim()
    .replace(/(?:^|\n)\s*第\s*\d+\s*段[。.]?\s*$/u, '')
    .replace(/^([\p{Script=Han}A-Za-z0-9_·]{1,16})，你，\1[，,]/u, '$1，')
    .replace(/^你，([\p{Script=Han}A-Za-z0-9_·]{1,16})，\1[，,]/u, '$1，')
    .replace(/^你([\p{Script=Han}A-Za-z0-9_·]{1,16})(?=(?:出身|生于|出生|来自|原本|曾经|曾|是|在|从小|少年|幼年|年轻时))/u, '$1')
    .trim();
}

function renderCharacterSummary(player: PlayerCharacterSummary): string {
  const sheet = player.sheet;
  return [
    `playerId: ${player.playerId}`,
    `玩家名: ${player.playerName}`,
    `角色名: ${compact(sheet.name)}`,
    `种族/亚种: ${compact(sheet.species)} / ${compact(sheet.subSpecies)}`,
    `职业/细节: ${compact(sheet.className)} / ${compact(sheet.classDetail)}`,
    `背景: ${compact(sheet.background)}`,
    `概念: ${compact(sheet.concept)}`,
    `性格: ${compact(sheet.personality)}`,
    `理想: ${compact(sheet.ideal)}`,
    `牵绊: ${compact(sheet.bond)}`,
    `缺点: ${compact(sheet.flaw)}`,
    `私密备注: ${compact(sheet.privateNotes)}`
  ].join('\n');
}

function buildPrompt(input: {
  roomName: string;
  openingScene: string;
  allPlayers: PlayerCharacterSummary[];
  targetPlayers: PlayerCharacterSummary[];
}): string {
  return [
    '你是 D&D 5e 中文跑团的主持人助手。请为每位目标玩家生成私人可见的个人开场介绍。',
    '',
    '严格输出 JSON，不能包含 Markdown、解释或额外文本。格式必须是：',
    '{ "introsByPlayerId": { "playerId": "300-500字中文叙事" } }',
    '',
    '写作要求：',
    '- 每位目标玩家一段 300-500 字中文叙事。',
    '- 使用第二人称写给该玩家本人，默认用“你……”描述个人经历、感知和来到此处的过程。',
    '- 内容包含：个人经历、如何与队伍相遇、如何来到当前开场地点。',
    '- 只写该玩家本人可见的信息，不揭露其他玩家私密备注。',
    '- 可以提到队伍成员的公开角色印象，但不要替任何玩家决定未来行动。',
    '- 首句称呼要自然，不要写“你{角色名}出身/生于/来自...”这种缺少停顿的句式；可写“{角色名}出身于...”或“你，{角色名}，...”。',
    '- 不要写资源变化、骰点、规则结算或奖励。',
    '',
    `房间名：${input.roomName}`,
    `公开 Opening Scene：${input.openingScene}`,
    '',
    '所有玩家/角色摘要：',
    input.allPlayers.map(renderCharacterSummary).join('\n\n---\n\n'),
    '',
    '需要生成个人开场的目标 playerId：',
    input.targetPlayers.map((player) => `- ${player.playerId} (${player.playerName} / ${player.sheet.name})`).join('\n')
  ].join('\n');
}

export async function preparePersonalOpeningIntrosForConfirmation(
  db: AppDatabase,
  input: { roomId: string; playerId: string; builtSheet: CharacterSheet }
): Promise<PreparedPersonalOpeningIntro[]> {
  const room = db.prepare('SELECT id, name, current_turn as currentTurn, expected_player_count as expectedPlayerCount FROM rooms WHERE id = ?')
    .get(input.roomId) as { id: string; name: string; currentTurn: number; expectedPlayerCount: number | null } | undefined;
  if (!room) throw new PersonalOpeningIntroError(404, 'Room not found');
  if (room.expectedPlayerCount === null) {
    throw new PersonalOpeningIntroError(409, '旧房间需要先由管理员补填预期玩家人数，才能确认角色并生成个人开场。');
  }

  const rows = db.prepare(`
    SELECT p.id as playerId, p.name as playerName, p.created_at as createdAt,
           c.id as characterId, c.sheet_json as sheetJson, c.confirmed
    FROM players p
    JOIN characters c ON c.player_id = p.id
    WHERE p.room_id = ?
    ORDER BY p.created_at ASC
  `).all(input.roomId) as PlayerCharacterRow[];

  if (rows.length < room.expectedPlayerCount) return [];
  if (rows.length > room.expectedPlayerCount) {
    throw new PersonalOpeningIntroError(409, `当前玩家数 ${rows.length} 已超过预期人数 ${room.expectedPlayerCount}，请先调整房间数据。`);
  }

  const players = rows.map((row) => ({
    playerId: row.playerId,
    playerName: row.playerName,
    characterId: row.characterId,
    sheet: row.playerId === input.playerId ? input.builtSheet : parseSheet(row.sheetJson),
    confirmed: row.playerId === input.playerId ? true : Boolean(row.confirmed),
    createdAt: row.createdAt
  }));

  const confirmedCount = players.filter((player) => player.confirmed).length;
  if (confirmedCount < room.expectedPlayerCount) return [];

  const existingIntroRows = db.prepare(`
    SELECT player_id as playerId
    FROM log_entries
    WHERE room_id = ? AND visibility_scope = 'private' AND title = ?
  `).all(input.roomId, PERSONAL_OPENING_TITLE) as Array<{ playerId: string | null }>;
  const existingIntroPlayerIds = new Set(existingIntroRows.map((row) => row.playerId).filter((id): id is string => Boolean(id)));
  const targetPlayers = players.filter((player) => player.confirmed && !existingIntroPlayerIds.has(player.playerId));
  if (targetPlayers.length === 0) return [];

  const config = getGlobalAiProviderConfig(db);
  if (config.provider === 'mock') {
    throw new PersonalOpeningIntroError(409, '个人开场需要真实 AI provider。请在全局 AI 接口中配置 openai-compatible 后重试。');
  }

  const prompt = buildPrompt({
    roomName: room.name,
    openingScene: publicOpeningScene(db, input.roomId),
    allPlayers: players,
    targetPlayers
  });
  let output: string;
  try {
    output = await requestOpenAiCompatibleMessage(config, [
      { role: 'system', content: '你只输出严格 JSON。' },
      { role: 'user', content: prompt }
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PersonalOpeningIntroError(502, `AI 个人开场生成失败：${message}`);
  }

  const introsByPlayerId = normalizeIntroResponse(output, targetPlayers.map((player) => player.playerId));
  const turn = db.prepare('SELECT id FROM turns WHERE room_id = ? AND number = ?')
    .get(input.roomId, room.currentTurn) as { id: string } | undefined;
  const now = new Date().toISOString();
  return targetPlayers.map((player) => ({
    id: nanoid(),
    roomId: input.roomId,
    turnId: turn?.id ?? null,
    playerId: player.playerId,
    title: PERSONAL_OPENING_TITLE,
    content: introsByPlayerId[player.playerId],
    createdAt: now
  }));
}
