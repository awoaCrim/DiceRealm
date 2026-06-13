import { describe, expect, it } from 'vitest';
import { MockAiProvider } from '../services/aiProvider.js';
import { processTurnActions } from '../services/turnEngine.js';
import { defaultAiConfig } from '../services/aiContextBuilder.js';
import type { Player, PlayerAction, Room, Turn } from '../domain/types.js';

const room: Room = {
  id: 'room-1',
  name: 'Order Test',
  systemPrompt: 'Fair DM',
  worldInfo: 'A narrow bridge.',
  currentTurn: 1,
  status: 'processing',
  expectedPlayerCount: null,
  aiConfig: defaultAiConfig,
  createdAt: '2026-05-27T00:00:00.000Z'
};

const turn: Turn = {
  id: 'turn-1',
  roomId: 'room-1',
  number: 1,
  status: 'processing',
  startedAt: room.createdAt,
  endedAt: null
};

const players: Player[] = [
  { id: 'a', roomId: 'room-1', name: 'Ari', token: 'token-a', isConnected: false, createdAt: room.createdAt },
  { id: 'b', roomId: 'room-1', name: 'Bo', token: 'token-b', isConnected: false, createdAt: room.createdAt }
];

describe('processTurnActions', () => {
  it('sorts actions by submittedAt before prompting the AI', async () => {
    const actions: PlayerAction[] = [
      { id: 'late', roomId: 'room-1', turnId: 'turn-1', playerId: 'b', text: 'I go second.', submittedAt: '2026-05-27T00:00:02.000Z', status: 'submitted' },
      { id: 'early', roomId: 'room-1', turnId: 'turn-1', playerId: 'a', text: 'I go first.', submittedAt: '2026-05-27T00:00:01.000Z', status: 'submitted' }
    ];

    let capturedPrompt = '';
    const provider = new MockAiProvider();
    provider.generateTurnResult = async (prompt) => {
      capturedPrompt = prompt;
      return { publicLog: 'Done', privateUpdatesByPlayer: {}, ruleResults: [], interactionRequests: [] };
    };

    await processTurnActions({ room, turn, players, actions, publicLogs: [], interactions: [], aiProvider: provider });

    expect(capturedPrompt.indexOf('I go first.')).toBeLessThan(capturedPrompt.indexOf('I go second.'));
  });

  it('places AI constraint blocks in a strong fixed order', async () => {
    const actions: PlayerAction[] = [
      { id: 'action', roomId: 'room-1', turnId: 'turn-1', playerId: 'a', text: 'I open the door.', submittedAt: '2026-05-27T00:00:01.000Z', status: 'submitted' }
    ];
    let capturedPrompt = '';
    const provider = new MockAiProvider();
    provider.generateTurnResult = async (prompt) => {
      capturedPrompt = prompt;
      return { publicLog: 'Done', privateUpdatesByPlayer: {}, ruleResults: [], interactionRequests: [] };
    };

    await processTurnActions({
      room,
      turn,
      players,
      actions,
      publicLogs: [],
      interactions: [],
      aiProvider: provider,
      promptBlocks: [
        { id: 'core', presetId: 'preset', name: '核心约束', role: 'system', position: 'before_world', enabled: true, orderIndex: 10, content: '核心约束：你是严格的 AI-DM。' },
        { id: 'agency', presetId: 'preset', name: '玩家自主权', role: 'system', position: 'before_world', enabled: true, orderIndex: 20, content: '玩家自主权：不得替玩家决定。' },
        { id: 'visibility', presetId: 'preset', name: '信息隔离', role: 'system', position: 'before_world', enabled: true, orderIndex: 30, content: '信息隔离：不得泄露私密信息。' },
        { id: 'interaction', presetId: 'preset', name: '互动规则', role: 'system', position: 'before_world', enabled: true, orderIndex: 40, content: '互动规则：需要目标玩家确认。' },
        { id: 'style', presetId: 'preset', name: '叙事风格', role: 'system', position: 'before_world', enabled: true, orderIndex: 50, content: '叙事风格：中文、克制、清晰。' },
        { id: 'output', presetId: 'preset', name: '输出格式', role: 'system', position: 'final', enabled: true, orderIndex: 900, content: '输出格式：只返回 JSON。' }
      ]
    });

    expect(capturedPrompt.indexOf('核心约束')).toBeLessThan(capturedPrompt.indexOf('玩家自主权'));
    expect(capturedPrompt.indexOf('玩家自主权')).toBeLessThan(capturedPrompt.indexOf('信息隔离'));
    expect(capturedPrompt.indexOf('信息隔离')).toBeLessThan(capturedPrompt.indexOf('互动规则'));
    expect(capturedPrompt.indexOf('互动规则')).toBeLessThan(capturedPrompt.indexOf('叙事风格'));
    expect(capturedPrompt.indexOf('叙事风格')).toBeLessThan(capturedPrompt.indexOf('Room: Order Test'));
    expect(capturedPrompt.indexOf('I open the door.')).toBeLessThan(capturedPrompt.indexOf('输出格式'));
  });

  it('injects matched world book entries before submitted actions', async () => {
    const actions: PlayerAction[] = [
      { id: 'action', roomId: 'room-1', turnId: 'turn-1', playerId: 'a', text: 'I inspect Candlekeep.', submittedAt: '2026-05-27T00:00:01.000Z', status: 'submitted' }
    ];
    let capturedPrompt = '';
    const provider = new MockAiProvider();
    provider.generateTurnResult = async (prompt) => {
      capturedPrompt = prompt;
      return { publicLog: 'Done', privateUpdatesByPlayer: {}, ruleResults: [], interactionRequests: [] };
    };

    await processTurnActions({
      room,
      turn,
      players,
      actions,
      publicLogs: [],
      interactions: [],
      aiProvider: provider,
      worldBookMatches: [{
        matchedKeys: ['Candlekeep'],
        entry: {
          id: 'entry-1',
          worldBookId: 'book-1',
          title: 'Candlekeep Secret',
          keys: ['Candlekeep'],
          secondaryKeys: [],
          content: 'The silver key reveals the sealed shelf.',
          enabled: true,
          constant: false,
          selective: false,
          priority: 100,
          position: 'after_world',
          createdAt: room.createdAt,
          updatedAt: room.createdAt
        }
      }]
    });

    expect(capturedPrompt).toContain('Candlekeep Secret');
    expect(capturedPrompt.indexOf('The silver key reveals')).toBeLessThan(capturedPrompt.indexOf('I inspect Candlekeep.'));
  });
});
