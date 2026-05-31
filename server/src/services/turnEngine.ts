import type { AiProvider } from './aiProvider.js';
import { buildTurnPrompt } from './aiContextBuilder.js';
import type { AiTurnResult, InteractionRequest, LogEntry, Player, PlayerAction, PromptBlock, Room, ScriptCard, Turn, WorldBookMatch } from '../domain/types.js';

export interface ProcessTurnActionsInput {
  room: Room;
  turn: Turn;
  players: Player[];
  actions: PlayerAction[];
  objectiveLogs?: LogEntry[];
  publicLogs: LogEntry[];
  interactions: InteractionRequest[];
  aiProvider: AiProvider;
  scriptCard?: ScriptCard | null;
  promptBlocks?: PromptBlock[];
  worldBookMatches?: WorldBookMatch[];
  promptOverride?: string;
}

export async function processTurnActions(input: ProcessTurnActionsInput): Promise<AiTurnResult> {
  const orderedActions = [...input.actions].sort((left, right) => left.submittedAt.localeCompare(right.submittedAt));
  const prompt = input.promptOverride ?? buildTurnPrompt({
    room: input.room,
    players: input.players,
    objectiveLogs: input.objectiveLogs,
    publicLogs: input.publicLogs,
    actions: orderedActions,
    interactions: input.interactions,
    scriptCard: input.scriptCard,
    promptBlocks: input.promptBlocks,
    worldBookMatches: input.worldBookMatches
  });

  return input.aiProvider.generateTurnResult(prompt);
}

export function allPlayersSubmitted(players: Player[], actions: PlayerAction[]): boolean {
  const submitted = new Set(actions.map((action) => action.playerId));
  return players.length > 0 && players.every((player) => submitted.has(player.id));
}
