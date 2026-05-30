import { describe, expect, it } from 'vitest';
import type { LogEntry, Player, Room } from '../domain/types.js';
import { defaultAiConfig } from '../services/aiContextBuilder.js';
import { buildPlayerVisibleState } from '../services/visibilityService.js';

const room: Room = {
  id: 'room-1',
  name: 'Candlekeep Mystery',
  systemPrompt: 'Be fair.',
  worldInfo: 'A locked library at midnight.',
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
    expect(JSON.stringify(state)).not.toContain('Bo sees a secret mark');
    expect(JSON.stringify(state)).not.toContain('Full truth');
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
});
