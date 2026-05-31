import { describe, expect, it } from 'vitest';
import type { CampaignNpc, LogEntry, Player, Room, SessionSummary } from '../domain/types.js';
import { defaultAiConfig } from '../services/aiContextBuilder.js';
import { buildPlayerVisibleState } from '../services/visibilityService.js';

const room: Room = {
  id: 'room-1',
  name: 'Candlekeep Mystery',
  systemPrompt: 'Be fair.',
  worldInfo: 'DM-only truth: the locked library hides a lich phylactery.',
  currentTurn: 1,
  status: 'waiting_for_actions',
  aiConfig: defaultAiConfig,
  createdAt: '2026-05-27T00:00:00.000Z'
};

const players: Player[] = [
  { id: 'player-a', roomId: 'room-1', name: 'Ari', token: 'token-a', isConnected: false, createdAt: room.createdAt },
  { id: 'player-b', roomId: 'room-1', name: 'Bo', token: 'token-b', isConnected: false, createdAt: room.createdAt }
];

const logs: LogEntry[] = [
  { id: 'public-1', roomId: 'room-1', turnId: null, visibilityScope: 'public', playerId: null, title: 'Scene', content: 'Everyone sees the sealed door.', createdAt: room.createdAt },
  { id: 'private-a', roomId: 'room-1', turnId: null, visibilityScope: 'private', playerId: 'player-a', title: 'Whisper', content: 'Ari hears a hidden bell.', createdAt: room.createdAt },
  { id: 'private-b', roomId: 'room-1', turnId: null, visibilityScope: 'private', playerId: 'player-b', title: 'Shadow', content: 'Bo sees a secret mark.', createdAt: room.createdAt },
  { id: 'admin-1', roomId: 'room-1', turnId: null, visibilityScope: 'admin', playerId: null, title: 'Debug', content: 'Full truth.', createdAt: room.createdAt }
];

describe('buildPlayerVisibleState', () => {
  it('returns public logs and only the selected player private logs', () => {
    const state = buildPlayerVisibleState({
      room,
      player: players[0],
      players,
      character: null,
      logs,
      actions: [],
      interactions: []
    });

    expect(state.publicLogs.map((log) => log.id)).toEqual(['public-1']);
    expect(state.privateLogs.map((log) => log.id)).toEqual(['private-a']);
    expect(state.room.worldInfo).toBe('');
    expect(JSON.stringify(state)).not.toContain('Bo sees a secret mark');
    expect(JSON.stringify(state)).not.toContain('Full truth');
    expect(JSON.stringify(state)).not.toContain('lich phylactery');
  });

  it('shows submitted and waiting player names without exposing action text', () => {
    const state = buildPlayerVisibleState({
      room,
      player: players[0],
      players,
      character: null,
      logs,
      actions: [
        { id: 'action-a', roomId: 'room-1', turnId: 'turn-1', playerId: 'player-a', text: 'I pick the lock quietly.', submittedAt: room.createdAt, status: 'submitted' }
      ],
      interactions: []
    });

    expect(state.submittedPlayers).toEqual(['Ari']);
    expect(state.waitingPlayers).toEqual(['Bo']);
    expect(JSON.stringify(state)).not.toContain('pick the lock');
  });

  it('strips unconfirmed campaign memory update suggestions from player state', () => {
    const campaignSummary: SessionSummary = {
      id: 'summary-1',
      roomId: 'room-1',
      turnStart: 1,
      turnEnd: 5,
      summary: 'The party reached the old road and heard a rumor about the Black Spider.',
      questUpdatesJson: JSON.stringify([{ title: 'Secret quest', status: 'active', description: 'Hidden DM-only clue.' }]),
      npcUpdatesJson: JSON.stringify([{ name: 'Secret NPC', notes: 'Not confirmed.' }]),
      locationUpdatesJson: JSON.stringify([{ name: 'Secret location', description: 'Not confirmed.' }]),
      characterUpdatesJson: JSON.stringify([{ characterId: 'char-1', update: 'Not confirmed.' }]),
      createdAt: room.createdAt
    };

    const state = buildPlayerVisibleState({
      room,
      player: players[0],
      players,
      character: null,
      logs,
      actions: [],
      interactions: [],
      campaignSummary
    });

    expect(state.campaignSummary?.summary).toBe('The party reached the old road and heard a rumor about the 未公开人物.');
    expect(state.campaignSummary?.questUpdatesJson).toBe('[]');
    expect(state.campaignSummary?.npcUpdatesJson).toBe('[]');
    expect(state.campaignSummary?.locationUpdatesJson).toBe('[]');
    expect(state.campaignSummary?.characterUpdatesJson).toBe('[]');
    expect(JSON.stringify(state)).not.toContain('Secret quest');
    expect(JSON.stringify(state)).not.toContain('Secret NPC');
    expect(JSON.stringify(state)).not.toContain('Black Spider');
  });

  it('does not expose DM NPC notes in player-visible campaign memory', () => {
    const npcs: CampaignNpc[] = [{
      id: 'npc-1',
      roomId: 'room-1',
      name: 'Sildar',
      role: 'ally',
      attitude: 'friendly',
      notes: 'Secretly knows the map points to Wave Echo Cave.',
      location: 'Phandalin',
      updatedAt: room.createdAt
    }];

    const state = buildPlayerVisibleState({
      room,
      player: players[0],
      players,
      character: null,
      logs,
      actions: [],
      interactions: [],
      npcs
    });

    expect(state.npcs).toEqual([{
      id: 'npc-1',
      roomId: 'room-1',
      name: 'Sildar',
      role: 'ally',
      attitude: 'friendly',
      location: 'Phandalin',
      updatedAt: room.createdAt
    }]);
    expect(JSON.stringify(state)).not.toContain('Wave Echo Cave');
    expect(JSON.stringify(state)).not.toContain('Secretly knows');
  });

  it('sanitizes player-visible campaign quest and NPC text', () => {
    const state = buildPlayerVisibleState({
      room,
      player: players[0],
      players,
      character: null,
      logs,
      actions: [],
      interactions: [],
      quests: [{
        id: 'quest-1',
        roomId: 'room-1',
        title: '调查地精伏兵',
        status: 'in_progress',
        description: '确认陷阱机关是否与黑蜘蛛有关。',
        updatedAt: room.createdAt
      }],
      npcs: [{
        id: 'npc-1',
        roomId: 'room-1',
        name: 'Black Spider',
        role: '陷阱机关幕后人物',
        attitude: 'unknown',
        notes: 'This note is DM-only.',
        location: 'goblin ambush trail',
        updatedAt: room.createdAt
      }]
    });

    expect(state.quests).toEqual([{
      id: 'quest-1',
      roomId: 'room-1',
      title: '调查隐藏威胁',
      status: 'in_progress',
      description: '确认隐藏机关是否与未公开人物有关。',
      updatedAt: room.createdAt
    }]);
    expect(state.npcs).toEqual([{
      id: 'npc-1',
      roomId: 'room-1',
      name: '未公开人物',
      role: '隐藏机关幕后人物',
      attitude: 'unknown',
      location: '隐藏威胁 trail',
      updatedAt: room.createdAt
    }]);
    expect(JSON.stringify(state)).not.toContain('Black Spider');
    expect(JSON.stringify(state)).not.toContain('goblin ambush');
    expect(JSON.stringify(state)).not.toContain('陷阱机关');
    expect(JSON.stringify(state)).not.toContain('DM-only');
  });

  it('projects combat state to the player UI shape without exposing NPC internals', () => {
    const state = buildPlayerVisibleState({
      room,
      player: players[0],
      players,
      character: null,
      logs,
      actions: [],
      interactions: [],
      combatState: {
        id: 'combat-1',
        roomId: 'room-1',
        round: 2,
        currentTurn: 1,
        status: 'active',
        startedAt: room.createdAt,
        combatants: [
          {
            id: 'pc-combatant',
            characterId: 'char-a',
            npcId: null,
            name: 'Ari',
            initiative: 15,
            hp: { current: 8, max: 12 },
            ac: 16,
            isPlayer: true,
            conditions: []
          },
          {
            id: 'npc-combatant',
            characterId: null,
            npcId: 'npc-secret-id',
            name: 'Goblin Scout',
            initiative: 12,
            hp: { current: 3, max: 7 },
            ac: 15,
            isPlayer: false,
            conditions: []
          }
        ]
      }
    });

    expect(state.combatState).toMatchObject({
      id: 'combat-1',
      roomId: 'room-1',
      round: 2,
      currentTurnIndex: 1,
      status: 'active'
    });
    expect(state.combatState?.participants).toEqual([
      {
        id: 'pc-combatant',
        name: 'Ari',
        hp: 8,
        maxHp: 12,
        ac: 16,
        initiative: 15,
        isNpc: false,
        healthLabel: 'injured'
      },
      {
        id: 'npc-combatant',
        name: 'Goblin Scout',
        hp: null,
        maxHp: null,
        ac: null,
        initiative: 12,
        isNpc: true,
        healthLabel: 'bloodied'
      }
    ]);
    expect(JSON.stringify(state)).not.toContain('npc-secret-id');
    expect(JSON.stringify(state)).not.toContain('"ac":15');
    expect(JSON.stringify(state)).not.toContain('"hp":{"current":3');
  });

  it('sanitizes player-visible resource change reasons without changing the audit shape', () => {
    const state = buildPlayerVisibleState({
      room,
      player: players[0],
      players,
      character: null,
      logs,
      actions: [],
      interactions: [],
      recentChanges: [{
        id: 'change-1',
        changeType: 'resource_patch',
        path: 'hitPoints.current',
        before: 12,
        after: 7,
        reason: '地精伏兵砍伤',
        createdAt: room.createdAt
      }]
    });

    expect(state.recentChanges).toEqual([{
      id: 'change-1',
      changeType: 'resource_patch',
      path: 'hitPoints.current',
      before: 12,
      after: 7,
      reason: '隐藏威胁砍伤',
      createdAt: room.createdAt
    }]);
    expect(JSON.stringify(state)).not.toContain('地精');
    expect(JSON.stringify(state)).not.toContain('伏兵');
  });
});
