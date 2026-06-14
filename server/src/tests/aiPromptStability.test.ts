import { describe, expect, it } from 'vitest';
import { buildTurnPrompt, parseNarrativeLengthLimitsFromPromptBlocks, renderDndOutputContract, sanitizePublicDiceReason } from '../services/aiContextBuilder.js';
import { validateAiTurnResult, validateAiTurnResultLengthWarnings } from '../services/aiProvider.js';
import { matchWorldBookEntries } from '../services/worldBookService.js';
import type { Player, PlayerAction, PromptBlock, Room, WorldBookEntry } from '../domain/types.js';

const room: Room = {
  id: 'room-1',
  name: 'Test Room',
  systemPrompt: '',
  worldInfo: 'High Road goblin ambush. Two dead horses block the road.',
  currentTurn: 1,
  status: 'ready_to_resolve',
  expectedPlayerCount: null,
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
    expect(renderDndOutputContract()).toContain('===STATE PATCH===');
    expect(renderDndOutputContract()).toContain('分隔符之后的 JSON 字段必须包含 objectiveLog、privateUpdatesByPlayer、ruleResults、interactionRequests、diceRequests、suggestedStateChanges、characterResourceChanges');
  });

  it('includes default narrative length limits in the output contract', () => {
    const contract = renderDndOutputContract();

    expect(contract).toContain('objectiveLog 最多 300 个中文字符');
    expect(contract).toContain('publicLog 最多 1500 个中文字符');
    expect(contract).toContain('常规多人行动回合的 publicLog 写 500-900 个中文字符');
    expect(contract).toContain('privateUpdatesByPlayer 每名玩家最多 300 个中文字符');
    expect(contract).toContain('超过上限属于格式错误');
    expect(contract).toContain('publicLog 和 objectiveLog 默认使用第三人称或客观陈述');
    expect(contract).toContain('privateUpdatesByPlayer 默认使用第二人称');
  });

  it('uses active narrative length limits in the output contract and validation warnings', () => {
    const promptBlocks: PromptBlock[] = [{
      id: 'length-block',
      presetId: 'preset-1',
      name: '剧情字数限制',
      role: 'system',
      position: 'final',
      enabled: true,
      orderIndex: 1,
      content: [
        '剧情字数硬上限：控制 AI 本回合输出的三层剧情长度。超过上限属于格式错误。',
        '- objectiveLog：最多 1000 个中文字符。',
        '- publicLog：最多 1500 个中文字符。',
        '- privateUpdatesByPlayer：每名玩家最多 800 个中文字符。'
      ].join('\n')
    }];
    const limits = parseNarrativeLengthLimitsFromPromptBlocks(promptBlocks);
    const contract = renderDndOutputContract(limits);

    expect(contract).toContain('objectiveLog 最多 1000 个中文字符');
    expect(contract).toContain('publicLog 最多 1500 个中文字符');
    expect(contract).toContain('privateUpdatesByPlayer 每名玩家最多 800 个中文字符');
    expect(contract).not.toContain('objectiveLog 最多 300 个中文字符、publicLog 最多 1500 个中文字符');

    const prompt = buildTurnPrompt({
      room,
      players,
      objectiveLogs: [],
      publicLogs: [],
      actions: [action({})],
      interactions: [],
      promptBlocks
    });
    expect(prompt).toContain('objectiveLog 最多 1000 个中文字符');
    expect(prompt).not.toContain('objectiveLog 最多 300 个中文字符、publicLog 最多 1500 个中文字符');

    const parsed = validateAiTurnResult({
      objectiveLog: '客'.repeat(301),
      publicLog: '公'.repeat(1500),
      privateUpdatesByPlayer: { tk: '私'.repeat(301) },
      ruleResults: [],
      interactionRequests: [],
      diceRequests: [],
      suggestedStateChanges: [],
      characterResourceChanges: []
    }, { strictRequiredFields: true });
    expect(validateAiTurnResultLengthWarnings(parsed, limits)).toEqual([]);
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

  it('reports hard length limit warnings after parsing AI JSON', () => {
    const parsed = validateAiTurnResult({
      objectiveLog: '客'.repeat(301),
      publicLog: '公'.repeat(1501),
      privateUpdatesByPlayer: { tk: '私'.repeat(301) },
      ruleResults: ['规'.repeat(121)],
      interactionRequests: [],
      diceRequests: [{ type: 'skillCheck', reason: '骰'.repeat(81) }],
      suggestedStateChanges: [{ reason: '状'.repeat(121) }],
      characterResourceChanges: [{
        characterId: 'char-1',
        path: 'hitPoints.current',
        before: 10,
        after: 8,
        reason: '资'.repeat(81),
        ruleRefs: []
      }]
    }, { strictRequiredFields: true });

    expect(validateAiTurnResultLengthWarnings(parsed)).toEqual(expect.arrayContaining([
      'objectiveLog 长度 301/300，超过上限。',
      'publicLog 长度 1501/1500，超过上限。',
      'privateUpdatesByPlayer.tk 长度 301/300，超过上限。',
      'ruleResults[0] 长度 121/120，超过上限。',
      'diceRequests[0].reason 长度 81/80，超过上限。'
    ]));
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

    expect(prompt).toContain('tk [player_question, private]: <peip player="tk" type="player_question">我是谁？</peip>');
    expect(prompt).toContain('wk [observe, public]: <peip player="wk" type="observe">观察四周</peip>');
  });

  it('summarizes skipped actors as pacing control instead of raw admin text', () => {
    const prompt = buildTurnPrompt({
      room,
      players,
      publicLogs: [],
      actions: [
        action({
          playerId: 'tk',
          text: '主持人标记 tk 本回合跳过。',
          actionType: 'skip',
          submittedAt: '2026-05-31T00:00:03.000Z'
        })
      ],
      interactions: []
    });

    expect(prompt).toContain('tk [skip, public]: 本回合暂不主动行动');
    expect(prompt).toContain('不要写进 publicLog');
    expect(prompt).not.toContain('主持人标记 tk 本回合跳过');
  });

  it('shows explicit action order and infers legacy narrative action types in prompt summaries', () => {
    const prompt = buildTurnPrompt({
      room,
      players,
      publicLogs: [],
      actions: [
        action({ playerId: 'wk', text: '观察四周', actionType: 'narrative', submittedAt: '2026-05-31T00:00:04.000Z' }),
        action({ playerId: 'tk', text: '我是谁？', actionType: 'narrative', submittedAt: '2026-05-31T00:00:03.000Z' })
      ],
      interactions: []
    });

    expect(prompt).toContain('1. tk [player_question, private]: <peip player="tk" type="player_question">我是谁？</peip>');
    expect(prompt).toContain('2. wk [observe, public]: <peip player="wk" type="observe">观察四周</peip>');
    expect(prompt.indexOf('1. tk [player_question, private]:')).toBeLessThan(prompt.indexOf('2. wk [observe, public]:'));
  });

  it('contains private routing and public dice safety rules', () => {
    const contract = renderDndOutputContract();

    expect(contract).toContain('Private Update Routing');
    expect(contract).toContain('key 必须是 playerId');
    expect(contract).toContain('player_question/meta_question 默认只回复给提交者');
    expect(contract).toContain('diceRequests.reason/publicReason 如果会进入公开日志，必须使用玩家安全描述');
    expect(contract).toContain('不要写“发现地精伏兵失败”');
  });

  it('warns against expanding wait actions into invented posture or thoughts', () => {
    expect(renderDndOutputContract()).toContain('“静观其变”只表示原地等待/观察');
  });

  it('tells the AI to use system-computed modifiers for character dice requests', () => {
    expect(renderDndOutputContract()).toContain('modifier 使用 null');
  });

  it('sanitizes public dice reasons that mention hidden ambushers', () => {
    const reason = sanitizePublicDiceReason('发现林线中的地精伏兵');

    expect(reason).toContain('隐藏威胁');
    expect(reason).not.toContain('地精');
    expect(reason).not.toContain('伏兵');
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
