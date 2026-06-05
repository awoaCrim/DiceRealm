import { nanoid } from 'nanoid';
import type { AppDatabase } from '../db/connection.js';
import type { AiTurnResult, CharacterSheet, DiceLog, GameCommand, GameEvent, Player, TurnResolutionRun } from '../domain/types.js';
import { sanitizePublicDiceReason } from './aiContextBuilder.js';
import { abilityCheck, abilityModifier, attackRoll, createSeededRng, damageRoll, rollDice } from './diceService.js';

type DiceRequest = NonNullable<AiTurnResult['diceRequests']>[number];

interface ProcessedDiceResult {
  diceLog: DiceLog;
  summary: string;
  objectiveSummary: string;
  request: DiceRequest;
  requestIndex: number;
}

export interface ResolutionNarrationSections {
  publicSummaries: string[];
  objectivePublicSummaries: string[];
  hiddenObjectiveSummaries: string[];
  publicDiceBlock: string;
  objectivePublicDiceBlock: string;
  hiddenObjectiveDiceBlock: string;
}

export interface CreateTurnResolutionRunInput {
  previewId: string;
  roomId: string;
  turnId: string;
  result: AiTurnResult;
  seed?: string;
}

const abilityLabels: Record<NonNullable<DiceRequest['ability']>, string> = {
  str: '力量',
  dex: '敏捷',
  con: '体质',
  int: '智力',
  wis: '感知',
  cha: '魅力'
};

function normalizedDiceAdvantage(value: DiceRequest['advantage']): 'advantage' | 'disadvantage' | null {
  return value === 'advantage' || value === 'disadvantage' ? value : null;
}

function diceReasonsForRequest(request: DiceRequest): { publicReason: string; objectiveReason: string } {
  const objectiveReason = (request.objectiveReason || request.reason || '系统骰点').trim();
  const publicReason = sanitizePublicDiceReason((request.publicReason || request.reason || '系统骰点').trim());
  return { publicReason: publicReason || '系统骰点', objectiveReason: objectiveReason || publicReason || '系统骰点' };
}

function inferSkillAbility(skill: string | undefined): NonNullable<DiceRequest['ability']> {
  const normalized = (skill ?? '').trim().toLowerCase();
  if (!normalized) return 'str';
  if (/(athletics|运动)/.test(normalized)) return 'str';
  if (/(acrobatics|sleight|stealth|体操|巧手|隐匿|潜行)/.test(normalized)) return 'dex';
  if (/(arcana|history|investigation|nature|religion|奥秘|历史|调查|自然|宗教)/.test(normalized)) return 'int';
  if (/(animal|handling|insight|medicine|perception|survival|驯兽|洞悉|医疗|察觉|观察|感知|生存)/.test(normalized)) return 'wis';
  if (/(deception|intimidation|performance|persuasion|欺瞒|威吓|表演|游说|说服)/.test(normalized)) return 'cha';
  return 'str';
}

function formatDiceBlock(summaries: string[], prefix?: string): string {
  return summaries.map((summary) => `（${prefix ? `${prefix}：` : ''}${summary}）`).join('\n');
}

function loadCharacterSheet(db: AppDatabase, roomId: string, characterId: string | undefined): CharacterSheet | null {
  if (!characterId) return null;
  const charRow = db.prepare(
    'SELECT c.sheet_json as sheetJson FROM characters c JOIN players p ON c.player_id = p.id WHERE c.id = ? AND p.room_id = ?'
  ).get(characterId, roomId) as { sheetJson: string } | undefined;
  if (!charRow) return null;
  try {
    return JSON.parse(charRow.sheetJson) as CharacterSheet;
  } catch {
    return null;
  }
}

export function playerIdForCharacter(db: AppDatabase, roomId: string, characterId: string): string | null {
  const playerRow = db.prepare(
    'SELECT p.id FROM players p JOIN characters c ON c.player_id = p.id WHERE c.id = ? AND p.room_id = ?'
  ).get(characterId, roomId) as { id: string } | undefined;
  return playerRow?.id ?? null;
}

function shouldKeepDiceResultPrivate(request: DiceRequest): boolean {
  if (request.isHidden) return true;
  if (!request.characterId?.trim()) return false;
  if (request.type !== 'skillCheck') return false;
  const routingText = `${request.skill ?? ''} ${request.reason ?? ''}`.toLowerCase();
  return [
    'perception',
    'investigation',
    'insight',
    'survival',
    'arcana',
    'history',
    'nature',
    'religion',
    '察觉',
    '观察',
    '调查',
    '洞悉',
    '生存',
    '奥秘',
    '历史',
    '自然',
    '宗教'
  ].some((keyword) => routingText.includes(keyword));
}

export function collectDiceRequestRoutingWarnings(
  db: AppDatabase,
  roomId: string,
  diceRequests: NonNullable<AiTurnResult['diceRequests']>
): string[] {
  const warnings: string[] = [];
  diceRequests.forEach((request, index) => {
    const characterId = request.characterId?.trim();
    if (!characterId) return;
    const character = db.prepare(
      'SELECT c.id FROM characters c JOIN players p ON c.player_id = p.id WHERE c.id = ? AND p.room_id = ?'
    ).get(characterId, roomId) as { id: string } | undefined;
    if (!character) warnings.push(`diceRequests[${index}].characterId '${characterId}' 不属于当前房间，已忽略该骰点请求。`);
  });
  return warnings;
}

export function buildGameCommands(result: AiTurnResult): GameCommand[] {
  const commands: GameCommand[] = [];
  (result.diceRequests ?? []).forEach((payload, requestIndex) => commands.push({ type: 'DICE_ROLL_REQUEST', requestIndex, payload }));
  (result.characterResourceChanges ?? []).forEach((payload, requestIndex) => commands.push({ type: 'RESOURCE_PATCH_REQUEST', requestIndex, payload }));
  (result.suggestedStateChanges ?? []).forEach((payload, requestIndex) => {
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      commands.push({ type: 'PLUGIN_DB_CHANGE_REQUEST', requestIndex, payload });
    }
  });
  (result.interactionRequests ?? []).forEach((payload, requestIndex) => commands.push({ type: 'INTERACTION_REQUEST', requestIndex, payload }));
  return commands;
}

function processDiceRequests(db: AppDatabase, diceRequests: DiceRequest[], roomId: string, turnId: string, seed: string): ProcessedDiceResult[] {
  const results: ProcessedDiceResult[] = [];
  const now = new Date().toISOString();

  diceRequests.forEach((request, requestIndex) => {
    const { publicReason, objectiveReason } = diceReasonsForRequest(request);
    const characterId = request.characterId?.trim() || undefined;
    const characterSheet = loadCharacterSheet(db, roomId, characterId);
    if (characterId && !characterSheet) return;

    const rng = createSeededRng(`${seed}:dice:${requestIndex}`);
    const isPublic = !shouldKeepDiceResultPrivate(request);
    let diceLog: DiceLog | null = null;
    let summary = '';

    switch (request.type) {
      case 'abilityCheck': {
        const ability = request.ability ?? 'str';
        const score = characterSheet?.abilityScores?.[ability] ?? 10;
        const proficiency = 0;
        const dc = request.dc ?? 15;
        const result = abilityCheck(score, dc, proficiency, normalizedDiceAdvantage(request.advantage), { rng });
        const totalMod = result.modifier + result.proficiency;
        summary = `${publicReason} — 掷出 ${result.roll} + ${totalMod} = ${result.total}，DC ${dc}，${result.success ? '成功' : '失败'}。`;
        diceLog = {
          id: nanoid(),
          roomId,
          turnId,
          combatId: null,
          characterId: characterId ?? null,
          diceType: request.type,
          values: [result.natural],
          modifier: totalMod,
          total: result.total,
          dc,
          success: result.success,
          isPublic,
          reason: publicReason,
          publicReason,
          objectiveReason,
          timestamp: now
        };
        break;
      }
      case 'savingThrow': {
        const ability = request.ability ?? 'str';
        const score = characterSheet?.abilityScores?.[ability] ?? 10;
        const proficiency = characterSheet?.proficiencyBonus ?? 0;
        const dc = request.dc ?? 15;
        const result = abilityCheck(score, dc, proficiency, normalizedDiceAdvantage(request.advantage), { rng });
        const totalMod = result.modifier + result.proficiency;
        summary = `${publicReason}（${abilityLabels[ability]}豁免）— 掷出 ${result.roll} + ${totalMod} = ${result.total}，DC ${dc}，${result.success ? '成功' : '失败'}。`;
        diceLog = {
          id: nanoid(),
          roomId,
          turnId,
          combatId: null,
          characterId: characterId ?? null,
          diceType: request.type,
          values: [result.natural],
          modifier: totalMod,
          total: result.total,
          dc,
          success: result.success,
          isPublic,
          reason: publicReason,
          publicReason,
          objectiveReason,
          timestamp: now
        };
        break;
      }
      case 'skillCheck': {
        const ability = request.ability ?? inferSkillAbility(request.skill);
        const score = characterSheet?.abilityScores?.[ability] ?? 10;
        const skill = request.skill;
        const skills = characterSheet?.skills ?? [];
        const proficiency = skill && skills.includes(skill) ? (characterSheet?.proficiencyBonus ?? 0) : 0;
        const dc = request.dc ?? 15;
        const result = abilityCheck(score, dc, proficiency, normalizedDiceAdvantage(request.advantage), { rng });
        const totalMod = result.modifier + result.proficiency;
        const skillLabel = skill ? `（${skill}）` : '';
        summary = `${publicReason}${skillLabel} — 掷出 ${result.roll} + ${totalMod} = ${result.total}，DC ${dc}，${result.success ? '成功' : '失败'}。`;
        diceLog = {
          id: nanoid(),
          roomId,
          turnId,
          combatId: null,
          characterId: characterId ?? null,
          diceType: request.type,
          values: [result.natural],
          modifier: totalMod,
          total: result.total,
          dc,
          success: result.success,
          isPublic,
          reason: publicReason,
          publicReason,
          objectiveReason,
          timestamp: now
        };
        break;
      }
      case 'attackRoll': {
        const ability = request.ability ?? 'str';
        const score = characterSheet?.abilityScores?.[ability] ?? 10;
        const mod = request.modifier ?? abilityModifier(score);
        const proficiency = characterSheet?.proficiencyBonus ?? 0;
        const ac = request.dc ?? 10;
        const result = attackRoll(mod, proficiency, ac, normalizedDiceAdvantage(request.advantage), { rng });
        const totalMod = result.modifier + result.proficiency;
        summary = `${publicReason} — 掷出 ${result.roll} + ${totalMod} = ${result.total}，AC ${ac}，${result.hit ? (result.criticalHit ? '重击命中！' : '命中') : (result.criticalMiss ? '大失败！' : '未命中')}。`;
        diceLog = {
          id: nanoid(),
          roomId,
          turnId,
          combatId: null,
          characterId: characterId ?? null,
          diceType: request.type,
          values: [result.natural],
          modifier: totalMod,
          total: result.total,
          dc: ac,
          success: result.hit,
          isPublic,
          reason: publicReason,
          publicReason,
          objectiveReason,
          timestamp: now
        };
        break;
      }
      case 'damage': {
        const die = request.die ?? 'd6';
        const count = request.count ?? 1;
        const mod = request.modifier ?? 0;
        const result = damageRoll(die, count, mod, { rng });
        const valuesStr = result.values.join(', ');
        summary = `${publicReason} — 掷出 ${valuesStr} + ${mod} = ${result.total}。`;
        diceLog = {
          id: nanoid(),
          roomId,
          turnId,
          combatId: null,
          characterId: characterId ?? null,
          diceType: request.type,
          values: result.values,
          modifier: mod,
          total: result.total,
          dc: null,
          success: null,
          isPublic,
          reason: publicReason,
          publicReason,
          objectiveReason,
          timestamp: now
        };
        break;
      }
      case 'healing': {
        const die = request.die ?? 'd8';
        const count = request.count ?? 1;
        const mod = request.modifier ?? 0;
        const { values, total } = rollDice(die, count, { rng });
        const valuesStr = values.join(', ');
        summary = `${publicReason} — 掷出 ${valuesStr} + ${mod} = ${total + mod}`;
        diceLog = {
          id: nanoid(),
          roomId,
          turnId,
          combatId: null,
          characterId: characterId ?? null,
          diceType: request.type,
          values,
          modifier: mod,
          total: total + mod,
          dc: null,
          success: null,
          isPublic,
          reason: publicReason,
          publicReason,
          objectiveReason,
          timestamp: now
        };
        break;
      }
    }

    if (diceLog) {
      const objectiveSummary = objectiveReason !== publicReason ? summary.replace(publicReason, objectiveReason) : summary;
      results.push({ diceLog, summary, objectiveSummary, request, requestIndex });
    }
  });

  return results;
}

function eventForDiceResult(roomId: string, turnId: string, processed: ProcessedDiceResult): GameEvent {
  const diceLog = processed.diceLog;
  return {
    id: nanoid(),
    roomId,
    turnId,
    eventType: 'DICE_ROLLED',
    visibilityScope: diceLog.isPublic ? 'public' : 'private',
    playerId: null,
    actorId: diceLog.characterId,
    causalityId: `diceRequests[${processed.requestIndex}]`,
    createdAt: diceLog.timestamp,
    payload: {
      requestIndex: processed.requestIndex,
      diceLogId: diceLog.id,
      diceType: diceLog.diceType,
      values: diceLog.values,
      modifier: diceLog.modifier,
      total: diceLog.total,
      dc: diceLog.dc,
      success: diceLog.success,
      isHidden: !diceLog.isPublic,
      reason: diceLog.reason,
      publicReason: diceLog.publicReason,
      objectiveReason: diceLog.objectiveReason,
      summary: processed.summary,
      objectiveSummary: processed.objectiveSummary
    }
  };
}

export function applyResolutionRunToAiTurnResult(db: AppDatabase, result: AiTurnResult, run: TurnResolutionRun): void {
  if (run.diceLogs.length === 0) {
    result.diceResults = [];
    if (!result.objectiveLog || !result.objectiveLog.trim()) result.objectiveLog = result.publicLog;
    return;
  }

  if (!result.objectiveLog || !result.objectiveLog.trim()) {
    result.objectiveLog = result.publicLog;
  }

  const {
    publicSummaries,
    objectivePublicSummaries,
    hiddenObjectiveSummaries,
    publicDiceBlock,
    objectivePublicDiceBlock,
    hiddenObjectiveDiceBlock
  } = buildResolutionNarrationSections(run);

  for (const diceLog of run.diceLogs) {
    if (diceLog.isPublic || !diceLog.characterId) continue;
    const event = run.events.find((item) => item.eventType === 'DICE_ROLLED' && String(item.payload.diceLogId) === diceLog.id);
    const summary = typeof event?.payload.summary === 'string' ? event.payload.summary : diceLog.reason;
    const playerId = playerIdForCharacter(db, diceLog.roomId, diceLog.characterId);
    if (!playerId) continue;
    const existing = result.privateUpdatesByPlayer[playerId] ?? '';
    if (existing.includes(summary)) continue;
    result.privateUpdatesByPlayer[playerId] = existing
      ? `${existing}\n（${summary}）`
      : `（${summary}）`;
  }

  if (publicSummaries.length > 0 && !result.publicLog.includes(publicDiceBlock)) {
    result.publicLog += `\n\n${publicDiceBlock}`;
  }
  if (objectivePublicSummaries.length > 0 && !result.objectiveLog.includes(objectivePublicDiceBlock)) {
    result.objectiveLog = `${result.objectiveLog}\n\n${objectivePublicDiceBlock}`;
  }
  if (hiddenObjectiveSummaries.length > 0 && !result.objectiveLog.includes(hiddenObjectiveDiceBlock)) {
    result.objectiveLog = `${result.objectiveLog}\n\n${hiddenObjectiveDiceBlock}`;
  }
  result.diceResults = run.diceLogs;
}

export function buildResolutionNarrationSections(run: TurnResolutionRun): ResolutionNarrationSections {
  const diceEventsByLogId = new Map(run.events.filter((event) => event.eventType === 'DICE_ROLLED').map((event) => [String(event.payload.diceLogId), event]));
  const publicSummaries: string[] = [];
  const objectivePublicSummaries: string[] = [];
  const hiddenObjectiveSummaries: string[] = [];

  for (const diceLog of run.diceLogs) {
    const event = diceEventsByLogId.get(diceLog.id);
    const summary = typeof event?.payload.summary === 'string' ? event.payload.summary : diceLog.reason;
    const objectiveSummary = typeof event?.payload.objectiveSummary === 'string' ? event.payload.objectiveSummary : summary;
    if (diceLog.isPublic) {
      publicSummaries.push(summary);
      objectivePublicSummaries.push(objectiveSummary);
    } else {
      hiddenObjectiveSummaries.push(objectiveSummary);
    }
  }

  return {
    publicSummaries,
    objectivePublicSummaries,
    hiddenObjectiveSummaries,
    publicDiceBlock: publicSummaries.length > 0 ? formatDiceBlock(publicSummaries) : '',
    objectivePublicDiceBlock: objectivePublicSummaries.length > 0 ? formatDiceBlock(objectivePublicSummaries) : '',
    hiddenObjectiveDiceBlock: hiddenObjectiveSummaries.length > 0 ? formatDiceBlock(hiddenObjectiveSummaries, '隐藏骰点（客观）') : ''
  };
}

export function createTurnResolutionRun(db: AppDatabase, input: CreateTurnResolutionRunInput): TurnResolutionRun {
  const now = new Date().toISOString();
  const runId = nanoid();
  const seed = input.seed ?? `${input.roomId}:${input.turnId}:${input.previewId}`;
  const diceRequests = input.result.diceRequests ?? [];
  buildGameCommands(input.result);
  const warnings = collectDiceRequestRoutingWarnings(db, input.roomId, diceRequests);
  const processedDice = processDiceRequests(db, diceRequests, input.roomId, input.turnId, seed);
  const events = processedDice.map((processed) => {
    const event = eventForDiceResult(input.roomId, input.turnId, processed);
    if (processed.diceLog.characterId) {
      event.playerId = playerIdForCharacter(db, input.roomId, processed.diceLog.characterId);
    }
    return event;
  });
  const diceLogs = processedDice.map((processed) => processed.diceLog);
  const errors = warnings;

  const run: TurnResolutionRun = {
    id: runId,
    previewId: input.previewId,
    roomId: input.roomId,
    turnId: input.turnId,
    seed,
    events,
    diceLogs,
    warnings,
    errors,
    status: 'previewed',
    createdAt: now,
    appliedAt: null
  };

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO turn_resolution_runs (
        id, preview_id, room_id, turn_id, seed, events_json, dice_logs_json,
        warnings_json, errors_json, status, created_at, applied_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.id,
      run.previewId,
      run.roomId,
      run.turnId,
      run.seed,
      JSON.stringify(run.events),
      JSON.stringify(run.diceLogs),
      JSON.stringify(run.warnings),
      JSON.stringify(run.errors),
      run.status,
      run.createdAt,
      run.appliedAt
    );
    db.prepare('UPDATE ai_turn_previews SET resolution_run_id = ? WHERE id = ?').run(run.id, input.previewId);
  });
  tx();

  return run;
}

export function loadTurnResolutionRun(db: AppDatabase, runId: string): TurnResolutionRun | null {
  const row = db.prepare(`
    SELECT
      id,
      preview_id as previewId,
      room_id as roomId,
      turn_id as turnId,
      seed,
      events_json as eventsJson,
      dice_logs_json as diceLogsJson,
      warnings_json as warningsJson,
      errors_json as errorsJson,
      status,
      created_at as createdAt,
      applied_at as appliedAt
    FROM turn_resolution_runs
    WHERE id = ?
  `).get(runId) as {
    id: string;
    previewId: string;
    roomId: string;
    turnId: string | null;
    seed: string;
    eventsJson: string;
    diceLogsJson: string;
    warningsJson: string;
    errorsJson: string;
    status: TurnResolutionRun['status'];
    createdAt: string;
    appliedAt: string | null;
  } | undefined;
  if (!row) return null;
  return {
    id: row.id,
    previewId: row.previewId,
    roomId: row.roomId,
    turnId: row.turnId,
    seed: row.seed,
    events: JSON.parse(row.eventsJson) as GameEvent[],
    diceLogs: JSON.parse(row.diceLogsJson) as DiceLog[],
    warnings: JSON.parse(row.warningsJson) as string[],
    errors: JSON.parse(row.errorsJson) as string[],
    status: row.status,
    createdAt: row.createdAt,
    appliedAt: row.appliedAt
  };
}

export function markTurnResolutionRunApplied(db: AppDatabase, runId: string, appliedAt: string): void {
  db.prepare('UPDATE turn_resolution_runs SET status = ?, applied_at = ? WHERE id = ?').run('applied', appliedAt, runId);
}

export function selectIndexedItems<T>(items: T[] | undefined, indexes: number[]): T[] {
  if (!items || indexes.length === 0) return [];
  const selected = new Set(indexes);
  return items.filter((_item, index) => selected.has(index));
}

export function buildConfirmedAiTurnResult(
  result: AiTurnResult,
  confirmedSuggestedStateChangeIndexes: number[],
  confirmedCharacterResourceChangeIndexes: number[]
): AiTurnResult {
  return {
    ...result,
    suggestedStateChanges: selectIndexedItems(result.suggestedStateChanges, confirmedSuggestedStateChangeIndexes),
    characterResourceChanges: selectIndexedItems(result.characterResourceChanges, confirmedCharacterResourceChangeIndexes)
  };
}

export function createTurnLogMaterializedEvent(roomId: string, turnId: string, payload: Record<string, unknown>, createdAt: string): GameEvent {
  return {
    id: nanoid(),
    roomId,
    turnId,
    eventType: 'TURN_LOG_MATERIALIZED',
    visibilityScope: 'objective',
    playerId: null,
    actorId: 'ai_dm',
    payload,
    causalityId: null,
    createdAt
  };
}

export function createInteractionCreatedEvent(roomId: string, turnId: string, playerId: string, payload: Record<string, unknown>, createdAt: string): GameEvent {
  return {
    id: nanoid(),
    roomId,
    turnId,
    eventType: 'INTERACTION_CREATED',
    visibilityScope: 'private',
    playerId,
    actorId: 'ai_dm',
    payload,
    causalityId: null,
    createdAt
  };
}

export function createResourcePatchEvent(roomId: string, turnId: string, applied: boolean, payload: Record<string, unknown>, createdAt: string): GameEvent {
  return {
    id: nanoid(),
    roomId,
    turnId,
    eventType: applied ? 'RESOURCE_PATCH_APPLIED' : 'RESOURCE_PATCH_REJECTED',
    visibilityScope: 'admin',
    playerId: null,
    actorId: 'ai_dm',
    payload,
    causalityId: null,
    createdAt
  };
}

export function createPluginDbChangeAppliedEvent(roomId: string, turnId: string, payload: Record<string, unknown>, createdAt: string): GameEvent {
  return {
    id: nanoid(),
    roomId,
    turnId,
    eventType: 'PLUGIN_DB_CHANGE_APPLIED',
    visibilityScope: 'admin',
    playerId: null,
    actorId: 'ai_dm',
    payload,
    causalityId: null,
    createdAt
  };
}
