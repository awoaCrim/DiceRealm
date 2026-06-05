import { nanoid } from 'nanoid';
import type { AppDatabase } from '../db/connection.js';
import type { AiTurnResult, CombatState, Combatant, GameEvent, Player, Room, Turn, TurnResolutionRun } from '../domain/types.js';

function nowISO(): string {
  return new Date().toISOString();
}

function readActiveCombatState(db: AppDatabase, roomId: string): CombatState | null {
  const row = db.prepare('SELECT state_json FROM combat_state WHERE room_id = ? AND state_json LIKE ? ORDER BY updated_at DESC LIMIT 1')
    .get(roomId, '%"status":"active"%') as { state_json: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.state_json) as CombatState;
  } catch {
    return null;
  }
}

function saveCombatState(db: AppDatabase, state: CombatState): void {
  const updatedAt = nowISO();
  const existing = db.prepare('SELECT id FROM combat_state WHERE id = ?').get(state.id) as { id: string } | undefined;
  if (existing) {
    db.prepare('UPDATE combat_state SET state_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(state), updatedAt, state.id);
  } else {
    db.prepare('INSERT INTO combat_state (id, room_id, state_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(state.id, state.roomId, JSON.stringify(state), state.startedAt, updatedAt);
  }
}

function parseSheet(row: { sheetJson: string }): Record<string, any> | null {
  try {
    return JSON.parse(row.sheetJson) as Record<string, any>;
  } catch {
    return null;
  }
}

function loadPlayerCombatants(db: AppDatabase, roomId: string): Combatant[] {
  const rows = db.prepare(`
    SELECT c.id as characterId, c.sheet_json as sheetJson, p.id as playerId, p.name as playerName
    FROM characters c
    JOIN players p ON p.id = c.player_id
    WHERE p.room_id = ? AND c.confirmed = 1
    ORDER BY p.created_at ASC
  `).all(roomId) as Array<{ characterId: string; sheetJson: string; playerId: string; playerName: string }>;

  return rows.flatMap((row) => {
    const sheet = parseSheet(row);
    if (!sheet) return [];
    const resources = sheet.resources;
    const hp = resources?.hitPoints ?? sheet.hitPoints ?? { current: 1, max: 1 };
    return [{
      id: nanoid(),
      characterId: row.characterId,
      npcId: null,
      name: sheet.name || row.playerName,
      initiative: null,
      hp: {
        current: Number(hp.current ?? hp.max ?? 1),
        max: Number(hp.max ?? hp.current ?? 1)
      },
      ac: Number(sheet.armorClass ?? 10),
      isPlayer: true,
      conditions: Array.isArray(resources?.conditions) ? resources.conditions : []
    }];
  });
}

function chineseCount(value: string | undefined): number | null {
  if (!value) return null;
  const normalized = value.trim();
  const map: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8 };
  if (/^\d+$/.test(normalized)) return Number(normalized);
  return map[normalized] ?? null;
}

function inferEnemy(text: string): { baseName: string; count: number; hp: number; ac: number } {
  const goblinMatch = text.match(/([一二两三四五六七八]|\d+)?\s*(?:只|名|个)?\s*(地精|哥布林|goblin)/i);
  if (goblinMatch) {
    return { baseName: '地精', count: Math.min(chineseCount(goblinMatch[1]) ?? 1, 8), hp: 7, ac: 15 };
  }
  const ambusherMatch = text.match(/([一二两三四五六七八]|\d+)?\s*(?:名|个)?\s*(伏击者|敌人|敌方单位)/);
  return { baseName: ambusherMatch?.[2] ?? '敌对单位', count: Math.min(chineseCount(ambusherMatch?.[1]) ?? 1, 8), hp: 1, ac: 10 };
}

function combatTriggerText(result: AiTurnResult, resolutionRun: TurnResolutionRun): string {
  return [
    result.objectiveLog ?? '',
    result.publicLog,
    ...Object.values(result.privateUpdatesByPlayer),
    ...(result.ruleResults ?? []),
    ...(result.characterResourceChanges ?? []).map((change) => `${change.path} ${String(change.before)} -> ${String(change.after)} ${change.reason}`),
    ...resolutionRun.diceLogs.map((log) => `${log.diceType} ${log.reason} ${log.publicReason ?? ''} ${log.objectiveReason ?? ''}`)
  ].join('\n');
}

function shouldSyncCombat(result: AiTurnResult, resolutionRun: TurnResolutionRun): boolean {
  if (resolutionRun.diceLogs.some((log) => ['attackRoll', 'damage', 'initiative', 'd20'].includes(log.diceType) && /(攻|attack|命中|damage|伤害|先攻|initiative|伏击)/i.test(log.reason))) {
    return true;
  }
  if ((result.characterResourceChanges ?? []).some((change) => (
    change.path === 'hitPoints.current'
    && typeof change.before === 'number'
    && typeof change.after === 'number'
    && change.after < change.before
  ))) {
    return true;
  }
  return /(攻击|命中|伤害|先攻|伏击射击|attack|damage|initiative)/i.test(combatTriggerText(result, resolutionRun));
}

function summarizeTurnEvents(result: AiTurnResult, resolutionRun: TurnResolutionRun): string[] {
  return [
    ...resolutionRun.diceLogs.map((log) => `${log.reason}: ${log.total}${log.success === null ? '' : log.success ? ' success' : ' failed'}`),
    ...(result.characterResourceChanges ?? []).map((change) => `${change.characterId} ${change.path}: ${String(change.before)} -> ${String(change.after)} (${change.reason})`)
  ].slice(0, 8);
}

function syncPlayerHpFromResult(state: CombatState, result: AiTurnResult): void {
  for (const change of result.characterResourceChanges ?? []) {
    if (change.path !== 'hitPoints.current' || typeof change.after !== 'number') continue;
    const combatant = state.combatants.find((item) => item.characterId === change.characterId);
    if (combatant) combatant.hp.current = change.after;
  }
}

function ensureNpcCombatants(state: CombatState, text: string): void {
  if (state.combatants.some((combatant) => !combatant.isPlayer)) return;
  const enemy = inferEnemy(text);
  for (let index = 0; index < enemy.count; index += 1) {
    state.combatants.push({
      id: nanoid(),
      characterId: null,
      npcId: null,
      name: enemy.count > 1 ? `${enemy.baseName} ${index + 1}` : enemy.baseName,
      initiative: null,
      hp: { current: enemy.hp, max: enemy.hp },
      ac: enemy.ac,
      isPlayer: false,
      conditions: []
    });
  }
}

function createCombatState(db: AppDatabase, room: Room, result: AiTurnResult, resolutionRun: TurnResolutionRun): CombatState {
  const text = combatTriggerText(result, resolutionRun);
  const state: CombatState = {
    id: nanoid(),
    roomId: room.id,
    round: 1,
    currentTurn: 0,
    combatants: loadPlayerCombatants(db, room.id),
    status: 'active',
    startedAt: nowISO(),
    metadata: {
      enemySummary: inferEnemy(text).baseName,
      sourceTurnNumber: room.currentTurn,
      lastTurnEvents: summarizeTurnEvents(result, resolutionRun)
    }
  };
  ensureNpcCombatants(state, text);
  syncPlayerHpFromResult(state, result);
  return state;
}

export function syncCombatStateFromAiTurnResult(
  db: AppDatabase,
  input: { room: Room; turn: Turn; players: Player[]; result: AiTurnResult; resolutionRun: TurnResolutionRun; createdAt: string }
): GameEvent[] {
  if (!shouldSyncCombat(input.result, input.resolutionRun)) return [];
  const existing = readActiveCombatState(db, input.room.id);
  const text = combatTriggerText(input.result, input.resolutionRun);
  const state = existing ?? createCombatState(db, input.room, input.result, input.resolutionRun);
  ensureNpcCombatants(state, text);
  syncPlayerHpFromResult(state, input.result);
  state.metadata = {
    ...state.metadata,
    enemySummary: state.metadata?.enemySummary ?? inferEnemy(text).baseName,
    sourceTurnNumber: input.room.currentTurn,
    lastTurnEvents: summarizeTurnEvents(input.result, input.resolutionRun)
  };
  saveCombatState(db, state);
  return [{
    id: nanoid(),
    roomId: input.room.id,
    turnId: input.turn.id,
    eventType: 'COMBAT_STATE_UPDATED',
    visibilityScope: 'admin',
    playerId: null,
    actorId: 'ai_dm',
    payload: {
      combatId: state.id,
      created: !existing,
      round: state.round,
      combatants: state.combatants.map((combatant) => ({
        id: combatant.id,
        name: combatant.name,
        characterId: combatant.characterId,
        isPlayer: combatant.isPlayer,
        hp: combatant.hp,
        ac: combatant.ac
      })),
      lastTurnEvents: state.metadata?.lastTurnEvents ?? []
    },
    causalityId: input.resolutionRun.id,
    createdAt: input.createdAt
  }];
}

export function renderActiveCombatContext(db: AppDatabase, roomId: string): string {
  const state = readActiveCombatState(db, roomId);
  if (!state) return '';
  const lines = state.combatants.map((combatant, index) => (
    `${index + 1}. ${combatant.name} (${combatant.isPlayer ? 'player' : 'npc'}, characterId=${combatant.characterId ?? 'none'}, HP ${combatant.hp.current}/${combatant.hp.max}, AC ${combatant.ac}, initiative=${combatant.initiative ?? 'not rolled'})`
  ));
  return [
    '# Active Combat State',
    `combatId=${state.id}, round=${state.round}, currentTurnIndex=${state.currentTurn}, status=${state.status}`,
    state.metadata?.enemySummary ? `Enemy summary: ${state.metadata.enemySummary}` : '',
    'Combatants:',
    ...lines,
    state.metadata?.lastTurnEvents?.length ? `Last turn events:\n${state.metadata.lastTurnEvents.map((item) => `- ${item}`).join('\n')}` : ''
  ].filter(Boolean).join('\n');
}
