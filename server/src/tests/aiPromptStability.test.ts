import { describe, expect, it } from 'vitest';
import { buildTurnPrompt, renderDndOutputContract } from '../services/aiContextBuilder.js';
import { validateAiTurnResult } from '../services/aiProvider.js';
import { matchWorldBookEntries } from '../services/worldBookService.js';
import type { Player, PlayerAction, Room, WorldBookEntry } from '../domain/types.js';

const room: Room = {
  id: 'room-1',
  name: 'Test Room',
  systemPrompt: '',
  worldInfo: 'High Road goblin ambush. Two dead horses block the road.',
  currentTurn: 1,
  status: 'ready_to_resolve',
  aiConfig: {} as Room['aiConfig'],
  createdAt: '2026-05-31T00:00:00.000Z'
};

const players: Player[] = [
  { id: 'tk', roomId: room.id, name: 'tk', token: 't1', isConnected: true, createdAt: '2026-05-31T00:00:00.000Z' },
  { id: 'wk', roomId: room.id, name: 'wk', token: 't2', isConnected: true, createdAt: '2026-05-31T00:00:01.000Z' }
];

function action(overrides: Partial<PlayerAction>): PlayerAction {
  return {
    id: `action-${overrides.playerId ?? 'p'}`,
    roomId: room.id,
    turnId: 'turn-1',
    playerId: 'tk',
    text: '观察四周',
    submittedAt: '2026-05-31T00:00:02.000Z',
    status: 'submitted',
    actionType: 'observe',
    ...overrides
  };
}

function worldBookEntry(overrides: Partial<WorldBookEntry>): WorldBookEntry {
  return {
    id: `entry-${overrides.title ?? 'x'}`,
    worldBookId: 'book-1',
    title: 'High Road',
    keys: ['High Road'],
    secondaryKeys: [],
    content: 'The current road ambush is quiet and tense.',
    enabled: true,
    constant: false,
    selective: false,
    priority: 100,
    position: 'after_world',
    createdAt: '2026-05-31T00:00:00.000Z',
    updatedAt: '2026-05-31T00:00:00.000Z',
    ...overrides
  };
}

describe('AI-DM prompt stability', () => {
  it('requires characterResourceChanges in the output contract', () => {
    expect(renderDndOutputContract()).toContain('characterResourceChanges');
    expect(renderDndOutputContract()).toContain('JSON 字段必须包含 objectiveLog、publicLog、privateUpdatesByPlayer、ruleResults、interactionRequests、diceRequests、suggestedStateChanges、characterResourceChanges');
  });

  it('accepts empty characterResourceChanges and diceRequests arrays', () => {
    const parsed = validateAiTurnResult({
      objectiveLog: '',
      publicLog: '公开叙事',
      privateUpdatesByPlayer: {},
      ruleResults: [],
      interactionRequests: [],
      diceRequests: [],
      suggestedStateChanges: [],
      characterResourceChanges: []
    }, { strictRequiredFields: true });

    expect(parsed.characterResourceChanges).toEqual([]);
    expect(parsed.diceRequests).toEqual([]);
  });

  it('rejects missing characterResourceChanges in strict mode', () => {
    expect(() => validateAiTurnResult({
      objectiveLog: '',
      publicLog: '公开叙事',
      privateUpdatesByPlayer: {},
      ruleResults: [],
      interactionRequests: [],
      diceRequests: [],
      suggestedStateChanges: []
    }, { strictRequiredFields: true })).toThrow(/characterResourceChanges/);
  });

  it('includes action type next to submitted actions', () => {
    const prompt = buildTurnPrompt({
      room,
      players,
      publicLogs: [],
      actions: [
        action({ playerId: 'tk', text: '我是谁？', actionType: 'player_question' }),
        action({ playerId: 'wk', text: '观察四周', actionType: 'observe', submittedAt: '2026-05-31T00:00:03.000Z' })
      ],
      interactions: []
    });

    expect(prompt).toContain('tk [player_question]: 我是谁？');
    expect(prompt).toContain('wk [observe]: 观察四周');
  });

  it('tells the AI to use system-computed modifiers for character dice requests', () => {
    expect(renderDndOutputContract()).toContain('modifier 使用 null');
  });

  it('does not inject unrelated future campaign worldbook constants', () => {
    const matches = matchWorldBookEntries([
      worldBookEntry({ title: 'Current Ambush', keys: ['dead horses'], content: 'Goblin ambush details.' }),
      worldBookEntry({ title: 'Wave Echo Cave', keys: ['Wave Echo Cave'], content: 'Final battle details.', constant: true, priority: 1000 })
    ], 'High Road dead horses');

    expect(matches.map((match) => match.entry.title)).toContain('Current Ambush');
    expect(matches.map((match) => match.entry.title)).not.toContain('Wave Echo Cave');
  });
});
