import type { CampaignNpc, CampaignQuest, CharacterRecord, CharacterResources, CombatState, DiceLog, InteractionRequest, LogEntry, Player, PlayerAction, PlayerVisibleState, Room, RuleSummary, SessionSummary } from '../domain/types.js';

export interface BuildPlayerVisibleStateInput {
  room: Room;
  player: Player;
  players: Player[];
  character: CharacterRecord | null;
  logs: LogEntry[];
  actions: PlayerAction[];
  interactions: InteractionRequest[];
  ruleSummaries?: RuleSummary[];
  resources?: CharacterResources;
  recentChanges?: Array<{ id: string; changeType: string; path: string; before: unknown; after: unknown; reason: string; createdAt: string }>;
  combatState?: CombatState;
  recentDiceLogs?: DiceLog[];
  campaignSummary?: SessionSummary | null;
  quests?: CampaignQuest[];
  npcs?: CampaignNpc[];
}

export function buildPlayerVisibleState(input: BuildPlayerVisibleStateInput): PlayerVisibleState {
  const submittedPlayerIds = new Set(input.actions.map((action) => action.playerId));

  return {
    room: {
      id: input.room.id,
      name: input.room.name,
      worldInfo: input.room.worldInfo,
      currentTurn: input.room.currentTurn,
      status: input.room.status
    },
    player: {
      id: input.player.id,
      name: input.player.name
    },
    character: input.character,
    publicLogs: input.logs.filter((log) => log.visibilityScope === 'public'),
    privateLogs: input.logs.filter((log) => log.visibilityScope === 'private' && log.playerId === input.player.id),
    pendingInteractions: input.interactions.filter(
      (interaction) => interaction.targetPlayerId === input.player.id && interaction.status === 'pending_target'
    ),
    submittedPlayers: input.players.filter((player) => submittedPlayerIds.has(player.id)).map((player) => player.name),
    waitingPlayers: input.players.filter((player) => !submittedPlayerIds.has(player.id)).map((player) => player.name),
    ruleSummaries: input.ruleSummaries ?? [],
    resources: input.resources,
    recentChanges: input.recentChanges,
    combatState: input.combatState,
    recentDiceLogs: input.recentDiceLogs,
    campaignSummary: input.campaignSummary,
    quests: input.quests,
    npcs: input.npcs,
  };
}
