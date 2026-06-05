import { nanoid } from 'nanoid';
import type { AppDatabase } from '../db/connection.js';
import type { AiTurnPromptPreviewResponse, AiTurnPromptSendResponse, AiTurnResult, Room, TurnResolutionRun } from '../domain/types.js';
import { createAiProviderFromConfig, validateAiTurnResult, validateAiTurnResultLengthWarnings } from './aiProvider.js';
import { getGlobalAiProviderConfig } from './globalConfigService.js';
import { publishRoomUpdate } from './eventBus.js';
import {
  buildAiTurnDebugPrompt,
  buildRoomPromptPreview,
  loadCharacterStatusSection
} from './promptPreviewService.js';
import { parseNarrativeLengthLimitsFromPromptBlocks } from './aiContextBuilder.js';
import {
  assertPreviewMatchesCurrentReadyTurn,
  assertTurnReadyForAi
} from './turnReadinessService.js';
import {
  buildConfirmedAiTurnResult,
  buildResolutionNarrationSections,
  collectDiceRequestRoutingWarnings,
  createTurnResolutionRun,
  loadTurnResolutionRun,
  playerIdForCharacter
} from './turnResolutionService.js';
import {
  collectInteractionRoutingWarnings,
  collectPrivateUpdateRoutingWarnings,
  collectResourcePatchPreflightErrors,
  materializeAiTurnResult,
  normalizeSuggestedStateChanges
} from './turnMaterializationService.js';

export class AiTurnWorkflowHttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly payload: unknown
  ) {
    super(typeof payload === 'object' && payload !== null && 'message' in payload ? String((payload as { message?: unknown }).message) : 'AI turn workflow error');
  }
}

export interface AiTurnApplyInput {
  roomId: string;
  previewId: string;
  confirmedSuggestedStateChangeIndexes: number[];
  confirmedCharacterResourceChangeIndexes: number[];
}

function getRoom(db: AppDatabase, roomId: string): Room | null {
  const row = db.prepare('SELECT id, name, system_prompt as systemPrompt, world_info as worldInfo, current_turn as currentTurn, status, ai_config_json as aiConfigJson, created_at as createdAt FROM rooms WHERE id = ?').get(roomId) as any;
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    systemPrompt: row.systemPrompt,
    worldInfo: row.worldInfo,
    currentTurn: row.currentTurn,
    status: row.status,
    aiConfig: JSON.parse(row.aiConfigJson),
    createdAt: row.createdAt
  };
}

function claimRoomTurnForProcessing(db: AppDatabase, roomId: string, turnId: string): boolean {
  return db.transaction(() => {
    const roomClaim = db.prepare('UPDATE rooms SET status = ? WHERE id = ? AND status = ?').run('processing', roomId, 'ready_to_resolve');
    if (roomClaim.changes !== 1) return false;

    const turnClaim = db.prepare('UPDATE turns SET status = ? WHERE id = ? AND status = ?').run('processing', turnId, 'ready_to_resolve');
    if (turnClaim.changes !== 1) {
      db.prepare('UPDATE rooms SET status = ? WHERE id = ? AND status = ?').run('ready_to_resolve', roomId, 'processing');
      return false;
    }

    return true;
  })();
}

function joinNarrativeParts(parts: Array<string | undefined>): string {
  return parts.map((part) => part?.trim()).filter((part): part is string => Boolean(part)).join('\n\n');
}

function mergePrivateNarratives(
  preliminary: Record<string, string>,
  postResolution: Record<string, string>
): Record<string, string> {
  const playerIds = new Set([...Object.keys(preliminary), ...Object.keys(postResolution)]);
  return Object.fromEntries([...playerIds].map((playerId) => [
    playerId,
    joinNarrativeParts([preliminary[playerId], postResolution[playerId]])
  ]).filter(([, content]) => content));
}

function privatePlayerIdsForResolutionRun(db: AppDatabase, resolutionRun: TurnResolutionRun): string[] {
  return Array.from(new Set(resolutionRun.diceLogs.flatMap((diceLog) => {
    if (diceLog.isPublic || !diceLog.characterId) return [];
    const playerId = playerIdForCharacter(db, resolutionRun.roomId, diceLog.characterId);
    return playerId ? [playerId] : [];
  })));
}

function buildPostResolutionNarrationPrompt(
  originalPrompt: string,
  preliminaryResult: AiTurnResult,
  resolutionRun: TurnResolutionRun,
  privatePlayerIds: string[]
): string {
  const sections = buildResolutionNarrationSections(resolutionRun);
  return [
    originalPrompt,
    '',
    '## Authoritative System Dice Results',
    sections.publicDiceBlock || '- No public dice results.',
    sections.hiddenObjectiveDiceBlock ? `\nDM-only hidden dice:\n${sections.hiddenObjectiveDiceBlock}` : '',
    privatePlayerIds.length > 0 ? `\nPrivate result target playerIds: ${privatePlayerIds.join(', ')}` : '',
    '',
    '## Preliminary AI JSON Before Dice',
    JSON.stringify({
      ...preliminaryResult,
      diceResults: resolutionRun.diceLogs
    }, null, 2),
    '',
    '## Rewrite Task',
    'The preliminary JSON requested system dice. The dice above are now authoritative and must not be rerolled.',
    'Return a complete AiTurnResult JSON object for the final post-roll outcome.',
    'Write publicLog as ONLY the post-roll consequence narrative; do not repeat the pre-roll narration and do not repeat the dice summary block.',
    'If the authoritative dice result is DM-only hidden or character-private, put that consequence in privateUpdatesByPlayer for the listed target playerIds and leave publicLog empty unless other characters can directly see, hear, or be told that consequence.',
    'Write objectiveLog as ONLY DM-facing post-roll consequences, including hidden truths that are justified by the actual dice results.',
    'privateUpdatesByPlayer should contain only post-roll private consequences, keyed by playerId.',
    'diceRequests must be []; do not request additional dice in this rewrite.',
    'Preserve or update interactionRequests, suggestedStateChanges, and characterResourceChanges according to the actual dice result.',
    'Return strict JSON only. Never include markdown fences.'
  ].filter(Boolean).join('\n');
}

function combinePostResolutionResult(
  db: AppDatabase,
  preliminaryResult: AiTurnResult,
  postResolutionResult: AiTurnResult,
  resolutionRun: TurnResolutionRun
): AiTurnResult {
  const sections = buildResolutionNarrationSections(resolutionRun);
  const privatePlayerIds = privatePlayerIdsForResolutionRun(db, resolutionRun);
  const postResolutionPublicLog = postResolutionResult.publicLog.trim();
  const shouldRoutePostResolutionPublicLogToPrivate =
    privatePlayerIds.length > 0
    && sections.publicSummaries.length === 0
    && postResolutionPublicLog.length > 0;
  const postResolutionPrivateUpdates = { ...postResolutionResult.privateUpdatesByPlayer };
  if (shouldRoutePostResolutionPublicLogToPrivate) {
    for (const playerId of privatePlayerIds) {
      postResolutionPrivateUpdates[playerId] = joinNarrativeParts([
        postResolutionPrivateUpdates[playerId],
        postResolutionPublicLog
      ]);
    }
  }

  return {
    ...postResolutionResult,
    publicLog: joinNarrativeParts([
      preliminaryResult.publicLog,
      sections.publicDiceBlock,
      shouldRoutePostResolutionPublicLogToPrivate ? '' : postResolutionResult.publicLog
    ]),
    objectiveLog: joinNarrativeParts([
      preliminaryResult.objectiveLog || preliminaryResult.publicLog,
      sections.objectivePublicDiceBlock,
      sections.hiddenObjectiveDiceBlock,
      postResolutionResult.objectiveLog || postResolutionResult.publicLog
    ]),
    privateUpdatesByPlayer: mergePrivateNarratives(
      preliminaryResult.privateUpdatesByPlayer,
      postResolutionPrivateUpdates
    ),
    diceRequests: preliminaryResult.diceRequests ?? [],
    diceResults: resolutionRun.diceLogs
  };
}

function narrativeMentionsResourceImpact(result: AiTurnResult, change: NonNullable<AiTurnResult['characterResourceChanges']>[number]): boolean {
  const text = [
    result.publicLog,
    result.objectiveLog ?? '',
    ...Object.values(result.privateUpdatesByPlayer),
    change.reason,
    ...(change.ruleRefs ?? [])
  ].join('\n');
  return /(伤害|受伤|中箭|命中|扣血|失去\s*\d*\s*(?:hp|HP|生命)|治疗|恢复|回复|healing|damage|hit points?|hp)/i.test(text);
}

function collectUnconfirmedResourceConflicts(
  result: AiTurnResult,
  confirmedCharacterResourceChangeIndexes: number[]
): string[] {
  const confirmed = new Set(confirmedCharacterResourceChangeIndexes);
  return (result.characterResourceChanges ?? []).flatMap((change, index) => {
    if (confirmed.has(index)) return [];
    if (!change.path.startsWith('hitPoints.')) return [];
    if (!narrativeMentionsResourceImpact(result, change)) return [];
    return [`characterResourceChanges[${index}] 描述了 HP/伤害/治疗相关结果但未被确认。为避免剧情和角色状态不一致，请确认该资源变更，或重新生成/编辑 AI 结果。`];
  });
}

async function completePostResolutionNarration(
  db: AppDatabase,
  aiProvider: ReturnType<typeof createAiProviderFromConfig>,
  originalPrompt: string,
  preliminaryResult: AiTurnResult,
  resolutionRun: TurnResolutionRun,
  warnings: string[]
): Promise<AiTurnResult> {
  if (!preliminaryResult.diceRequests || preliminaryResult.diceRequests.length === 0 || resolutionRun.diceLogs.length === 0) {
    return preliminaryResult;
  }

  try {
    const privatePlayerIds = privatePlayerIdsForResolutionRun(db, resolutionRun);
    const postResolutionPrompt = buildPostResolutionNarrationPrompt(originalPrompt, preliminaryResult, resolutionRun, privatePlayerIds);
    const postResolutionResult = await aiProvider.generateTurnResult(postResolutionPrompt);
    return combinePostResolutionResult(db, preliminaryResult, postResolutionResult, resolutionRun);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`系统骰点后续剧情补全失败，已保留原始 AI 结果和骰点摘要：${message}`);
    return preliminaryResult;
  }
}

export async function createAiTurnPreview(db: AppDatabase, roomId: string): Promise<AiTurnPromptPreviewResponse> {
  const room = getRoom(db, roomId);
  if (!room) throw new AiTurnWorkflowHttpError(404, { error: 'Room not found' });

  assertTurnReadyForAi(db, room);

  const { preview, context } = await buildRoomPromptPreview(db, room);
  const characterStatus = loadCharacterStatusSection(db, room.id);
  const { flatPrompt, contextSections } = buildAiTurnDebugPrompt(room, preview, context, characterStatus);
  const previewId = nanoid();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO ai_turn_previews (
      id, room_id, turn_id, original_prompt, suggested_state_changes_json, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(previewId, room.id, context.turn?.id ?? null, flatPrompt, '[]', 'previewed', now);

  return {
    previewId,
    roomId: room.id,
    turnId: context.turn?.id ?? null,
    flatPrompt,
    messages: [{ role: 'user', content: flatPrompt }],
    contextSections,
    warnings: preview.warnings
  };
}

export async function sendAiTurnPreview(db: AppDatabase, input: { roomId: string; previewId: string; flatPrompt: string }): Promise<AiTurnPromptSendResponse> {
  const previewRow = db.prepare('SELECT id, room_id as roomId, turn_id as turnId FROM ai_turn_previews WHERE id = ? AND room_id = ?')
    .get(input.previewId, input.roomId) as { id: string; roomId: string; turnId: string | null } | undefined;
  if (!previewRow) throw new AiTurnWorkflowHttpError(404, { error: 'Prompt preview not found' });

  const room = getRoom(db, input.roomId);
  if (!room) throw new AiTurnWorkflowHttpError(404, { error: 'Room not found' });

  assertPreviewMatchesCurrentReadyTurn(db, room, previewRow.turnId);

  const { context } = await buildRoomPromptPreview(db, room);
  const { turn, players } = context;
  if (!turn) throw new AiTurnWorkflowHttpError(409, { error: 'Current turn not found' });
  const narrativeLengthLimits = parseNarrativeLengthLimitsFromPromptBlocks(context.promptBlocks);

  const providerConfig = getGlobalAiProviderConfig(db);
  const sentAt = new Date().toISOString();
  let aiProviderName: string = providerConfig.provider;
  try {
    const aiProvider = createAiProviderFromConfig(providerConfig);
    aiProviderName = aiProvider.name;
    const preliminaryResult = await aiProvider.generateTurnResult(input.flatPrompt);
    const routingWarnings = [
      ...collectPrivateUpdateRoutingWarnings(players, preliminaryResult.privateUpdatesByPlayer),
      ...collectInteractionRoutingWarnings(players, preliminaryResult.interactionRequests),
      ...collectDiceRequestRoutingWarnings(db, room.id, preliminaryResult.diceRequests ?? [])
    ];
    const resolutionRun = createTurnResolutionRun(db, {
      previewId: input.previewId,
      roomId: room.id,
      turnId: turn.id,
      result: preliminaryResult,
      seed: `${room.id}:${turn.id}:${input.previewId}`
    });
    const postResolutionWarnings: string[] = [];
    const result = await completePostResolutionNarration(
      db,
      aiProvider,
      input.flatPrompt,
      preliminaryResult,
      resolutionRun,
      postResolutionWarnings
    );
    const suggestedStateChanges = normalizeSuggestedStateChanges(result);
    const warnings = [
      ...validateAiTurnResultLengthWarnings(result, narrativeLengthLimits),
      ...routingWarnings,
      ...collectPrivateUpdateRoutingWarnings(players, result.privateUpdatesByPlayer),
      ...collectInteractionRoutingWarnings(players, result.interactionRequests),
      ...postResolutionWarnings
    ];
    db.prepare(`
      UPDATE ai_turn_previews
      SET edited_prompt = ?, response_text = ?, suggested_state_changes_json = ?, raw_json = ?, status = ?, error_message = NULL, sent_at = ?, resolution_run_id = ?
      WHERE id = ?
    `).run(
      input.flatPrompt,
      result.publicLog,
      JSON.stringify(suggestedStateChanges),
      JSON.stringify(result),
      'sent',
      sentAt,
      resolutionRun.id,
      input.previewId
    );

    return {
      responseText: result.publicLog,
      suggestedStateChanges,
      raw: result,
      applied: false,
      resourceErrors: [],
      warnings: Array.from(new Set([...warnings, ...resolutionRun.warnings])),
      resolutionRunId: resolutionRun.id,
      seed: resolutionRun.seed,
      resolutionEvents: resolutionRun.events
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    db.prepare(`
      UPDATE ai_turn_previews
      SET edited_prompt = ?, status = ?, error_message = ?, sent_at = ?
      WHERE id = ?
    `).run(input.flatPrompt, 'failed', message, sentAt, input.previewId);
    throw new AiTurnWorkflowHttpError(502, { error: message });
  }
}

export async function applyAiTurnPreview(db: AppDatabase, input: AiTurnApplyInput): Promise<AiTurnPromptSendResponse> {
  const previewRow = db.prepare('SELECT id, room_id as roomId, turn_id as turnId, raw_json as rawJson, status, resolution_run_id as resolutionRunId FROM ai_turn_previews WHERE id = ? AND room_id = ?')
    .get(input.previewId, input.roomId) as { id: string; roomId: string; turnId: string | null; rawJson: string | null; status: string; resolutionRunId: string | null } | undefined;
  if (!previewRow) throw new AiTurnWorkflowHttpError(404, { error: 'Prompt preview not found' });
  if (previewRow.status !== 'sent' || !previewRow.rawJson) {
    throw new AiTurnWorkflowHttpError(409, { error: 'AI_RESULT_NOT_READY', message: 'AI 结果尚未生成，不能应用。' });
  }
  if (!previewRow.resolutionRunId) {
    throw new AiTurnWorkflowHttpError(409, { error: 'RESOLUTION_RUN_NOT_READY', message: '系统结算预览尚未生成，不能应用。请重新发送 AI 预览。' });
  }
  const resolutionRun = loadTurnResolutionRun(db, previewRow.resolutionRunId);
  if (!resolutionRun || resolutionRun.status !== 'previewed') {
    throw new AiTurnWorkflowHttpError(409, { error: 'RESOLUTION_RUN_NOT_READY', message: '系统结算预览不可应用或已应用。请重新生成 AI 预览。' });
  }

  const room = getRoom(db, input.roomId);
  if (!room) throw new AiTurnWorkflowHttpError(404, { error: 'Room not found' });

  assertPreviewMatchesCurrentReadyTurn(db, room, previewRow.turnId);

  const { context } = await buildRoomPromptPreview(db, room);
  const { turn, players, actions, ruleMatches } = context;
  if (!turn) throw new AiTurnWorkflowHttpError(409, { error: 'Current turn not found' });
  const narrativeLengthLimits = parseNarrativeLengthLimitsFromPromptBlocks(context.promptBlocks);

  const providerConfig = getGlobalAiProviderConfig(db);
  const providerName = providerConfig.provider;
  try {
    const result = validateAiTurnResult(JSON.parse(previewRow.rawJson), { strictRequiredFields: true });
    const preflightErrors = [
      ...collectUnconfirmedResourceConflicts(result, input.confirmedCharacterResourceChangeIndexes),
      ...collectResourcePatchPreflightErrors(
        db,
        room.id,
        (result.characterResourceChanges ?? []).filter((_change, index) => input.confirmedCharacterResourceChangeIndexes.includes(index))
      )
    ];
    if (preflightErrors.length > 0) {
      throw new AiTurnWorkflowHttpError(409, {
        error: 'AI_RESOURCE_CONFLICT',
        message: preflightErrors.join('\n'),
        resourceErrors: preflightErrors
      });
    }
    if (!claimRoomTurnForProcessing(db, input.roomId, turn.id)) {
      throw new AiTurnWorkflowHttpError(409, { error: 'Turn is already processing or no longer open' });
    }
    const materializedResult = buildConfirmedAiTurnResult(
      result,
      input.confirmedSuggestedStateChangeIndexes,
      input.confirmedCharacterResourceChangeIndexes
    );
    const suggestedStateChanges = normalizeSuggestedStateChanges(result);
    const { resourceErrors, warnings } = materializeAiTurnResult(db, {
      room,
      turn,
      players,
      actions,
      result: materializedResult,
      resolutionRun,
      providerName,
      inputSummary: `Applied preview for ${actions.length} actions`,
      ruleMatches,
      narrativeLengthLimits
    });
    const response: AiTurnPromptSendResponse = {
      responseText: result.publicLog,
      suggestedStateChanges,
      raw: result,
      applied: true,
      resourceErrors,
      warnings,
      resolutionRunId: resolutionRun.id,
      seed: resolutionRun.seed,
      resolutionEvents: resolutionRun.events
    };
    publishRoomUpdate(input.roomId);
    return response;
  } catch (error) {
    if (error instanceof AiTurnWorkflowHttpError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      db.prepare('UPDATE rooms SET status = ? WHERE id = ?').run('needs_admin_attention', input.roomId);
      db.prepare('UPDATE turns SET status = ? WHERE id = ?').run('needs_admin_attention', turn.id);
      db.prepare('INSERT INTO ai_generations (id, room_id, turn_id, provider, input_summary, output, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(nanoid(), input.roomId, turn.id, providerName, `Failed applying preview for ${actions.length} actions`, previewRow.rawJson ?? '', message, now);
    });
    tx();
    publishRoomUpdate(input.roomId);
    throw new AiTurnWorkflowHttpError(500, { error: message });
  }
}
