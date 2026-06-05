import type { CampaignNpc, CampaignQuest, CharacterRecord, CharacterResources, CombatState, InteractionRequest, LogEntry, Player, PlayerAction, PlayerRulesSummary, PlayerVisibleCombatState, PlayerVisibleDiceLog, PlayerVisibleState, Room, RuleSummary, SessionSummary } from '../domain/types.js';

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
  recentDiceLogs?: PlayerVisibleDiceLog[];
  campaignSummary?: SessionSummary | null;
  quests?: CampaignQuest[];
  npcs?: CampaignNpc[];
  rules?: PlayerRulesSummary;
}

function sanitizeCampaignSummary(summary: SessionSummary | null | undefined): SessionSummary | null {
  if (!summary) return null;
  return {
    ...summary,
    summary: sanitizePlayerVisibleText(summary.summary),
    questUpdatesJson: '[]',
    npcUpdatesJson: '[]',
    locationUpdatesJson: '[]',
    characterUpdatesJson: '[]'
  };
}

function sanitizeCampaignQuests(quests: CampaignQuest[] | undefined): CampaignQuest[] | undefined {
  if (!quests) return undefined;
  return quests.map((quest) => ({
    ...quest,
    title: sanitizePlayerVisibleText(quest.title),
    description: sanitizePlayerVisibleText(quest.description)
  }));
}

function sanitizeCampaignNpcs(npcs: CampaignNpc[] | undefined): Array<Omit<CampaignNpc, 'notes'>> | undefined {
  if (!npcs) return undefined;
  return npcs.map(({ notes: _notes, ...npc }) => ({
    ...npc,
    name: sanitizePlayerVisibleText(npc.name),
    role: sanitizePlayerVisibleText(npc.role),
    location: sanitizePlayerVisibleText(npc.location)
  }));
}

function sanitizePlayerVisibleText(text: string): string {
  return text
    .replace(/地精伏兵|地精埋伏者|goblin ambushers?|goblin ambush/gi, '隐藏威胁')
    .replace(/伏兵|ambushers?/gi, '隐藏威胁')
    .replace(/陷阱机关|trap mechanism/gi, '隐藏机关')
    .replace(/黑蜘蛛|Black Spider/gi, '未公开人物')
    .trim();
}

function sanitizeRecentChanges(input: BuildPlayerVisibleStateInput['recentChanges']): BuildPlayerVisibleStateInput['recentChanges'] {
  return input?.map((change) => ({
    ...change,
    reason: sanitizePlayerVisibleText(change.reason)
  }));
}

function healthLabelFor(current: number, max: number): PlayerVisibleCombatState['participants'][number]['healthLabel'] {
  if (max <= 0) return 'unknown';
  if (current <= 0) return 'defeated';
  const ratio = current / max;
  if (ratio <= 0.5) return 'bloodied';
  if (ratio < 1) return 'injured';
  return 'healthy';
}

function sanitizeCombatState(state: CombatState | undefined): PlayerVisibleCombatState | undefined {
  if (!state) return undefined;
  return {
    id: state.id,
    roomId: state.roomId,
    round: state.round,
    currentTurnIndex: state.currentTurn,
    status: state.status,
    participants: state.combatants.map((combatant) => {
      const isNpc = !combatant.isPlayer;
      return {
        id: combatant.id,
        name: combatant.name,
        hp: isNpc ? null : combatant.hp.current,
        maxHp: isNpc ? null : combatant.hp.max,
        ac: isNpc ? null : combatant.ac,
        initiative: combatant.initiative,
        isNpc,
        healthLabel: healthLabelFor(combatant.hp.current, combatant.hp.max)
      };
    })
  };
}

export function buildPlayerVisibleState(input: BuildPlayerVisibleStateInput): PlayerVisibleState {
  const submittedPlayerIds = new Set(input.actions.map((action) => action.playerId));
  const currentAction = [...input.actions]
    .sort((left, right) => right.submittedAt.localeCompare(left.submittedAt))
    .find((action) => action.playerId === input.player.id) ?? null;

  return {
    room: {
      id: input.room.id,
      name: input.room.name,
      worldInfo: '',
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
    currentAction,
    submittedPlayers: input.players.filter((player) => submittedPlayerIds.has(player.id)).map((player) => player.name),
    waitingPlayers: input.players.filter((player) => !submittedPlayerIds.has(player.id)).map((player) => player.name),
    ruleSummaries: input.ruleSummaries ?? [],
    resources: input.resources,
    recentChanges: sanitizeRecentChanges(input.recentChanges),
    combatState: sanitizeCombatState(input.combatState),
    recentDiceLogs: input.recentDiceLogs,
    campaignSummary: sanitizeCampaignSummary(input.campaignSummary),
    quests: sanitizeCampaignQuests(input.quests),
    npcs: sanitizeCampaignNpcs(input.npcs),
    rules: input.rules,
  };
}
