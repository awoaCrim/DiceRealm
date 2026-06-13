import { describe, expect, it } from 'vitest';
import { defaultAiConfig, renderDndOutputContract } from '../services/aiContextBuilder.js';
import { buildSillyTavernPromptPreview } from '../services/sillyTavernPromptBuilder.js';
import type { LogEntry, Player, PlayerAction, PromptPresetPackage, ResourceWorldBookEntry, Room, ScriptCard } from '../domain/types.js';

const dndOutputContract = renderDndOutputContract();

const room: Room = {
  id: 'room-1',
  name: 'ST Prompt Room',
  systemPrompt: 'Fair DM',
  worldInfo: 'A Candlekeep gate.',
  currentTurn: 1,
  status: 'processing',
  expectedPlayerCount: null,
  aiConfig: defaultAiConfig,
  createdAt: '2026-05-28T00:00:00.000Z'
};

const scriptCard: ScriptCard = {
  id: 'script-1',
  name: 'Gate Script',
  description: 'A sealed gate under moonlight.',
  personality: 'NPCs speak carefully.',
  scenario: 'The party stands before the Candlekeep gate.',
  firstMes: 'The gate waits.',
  mesExample: 'DM: The hinges do not move.',
  creatorNotes: 'The bell clue is hidden.',
  visibilityNotes: '',
  sourceType: 'sillytavern_character',
  rawJson: {},
  createdAt: room.createdAt,
  updatedAt: room.createdAt
};

const presetPackage: PromptPresetPackage = {
  id: 'preset-1',
  name: 'ST Preset',
  sourceType: 'sillytavern_preset_package',
  openAiSettings: {
    name: 'ST Preset',
    prompts: [
      { identifier: 'main', role: 'system', content: 'Imported main prompt.' },
      { identifier: 'charDescription', role: 'system', marker: true, content: '' },
      { identifier: 'worldInfoBefore', role: 'system', marker: true, content: '' },
      { identifier: 'scenario', role: 'system', marker: true, content: '' },
      { identifier: 'chatHistory', role: 'user', marker: true, content: '' }
    ],
    prompt_order: [{ order: [
      { identifier: 'main', enabled: true },
      { identifier: 'charDescription', enabled: true },
      { identifier: 'worldInfoBefore', enabled: true },
      { identifier: 'scenario', enabled: true },
      { identifier: 'chatHistory', enabled: true }
    ] }]
  },
  contextTemplate: null,
  instructTemplate: null,
  sysprompt: { name: 'DND Dungeon Master', content: '中文 DM 系统提示。' },
  reasoningTemplate: null,
  rawJson: {},
  createdAt: room.createdAt,
  updatedAt: room.createdAt
};

const players: Player[] = [
  { id: 'player-1', roomId: 'room-1', name: 'Ari', token: 'token', isConnected: false, createdAt: room.createdAt }
];

const actions: PlayerAction[] = [
  { id: 'action-1', roomId: 'room-1', turnId: 'turn-1', playerId: 'player-1', text: 'I inspect Candlekeep.', submittedAt: room.createdAt, status: 'submitted' }
];

const worldBookEntries: ResourceWorldBookEntry[] = [
  { id: 'entry-1', worldBookId: 'book-1', title: 'Candlekeep Gate', keys: ['Candlekeep'], secondaryKeys: [], content: 'The gate responds to silver keys.', enabled: true, constant: false, priority: 100, orderIndex: 0, position: 'before', rawJson: {}, createdAt: room.createdAt, updatedAt: room.createdAt }
];

const publicLogs: LogEntry[] = [
  { id: 'log-1', roomId: 'room-1', turnId: 'turn-0', visibilityScope: 'public', playerId: null, title: 'Previous scene', content: 'A bell rang once.', createdAt: room.createdAt }
];

function buildPreview(overrides: Partial<Parameters<typeof buildSillyTavernPromptPreview>[0]> = {}) {
  return buildSillyTavernPromptPreview({
    room,
    players,
    objectiveLogs: [],
    publicLogs: [],
    actions,
    interactions: [],
    scriptCard,
    presetPackage,
    worldBookEntries,
    ...overrides
  });
}

function withPreset(openAiSettings: unknown, sysprompt: unknown = presetPackage.sysprompt): PromptPresetPackage {
  return { ...presetPackage, openAiSettings, sysprompt };
}

function occurrenceCount(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe('buildSillyTavernPromptPreview', () => {
  it('renders ST prompt order with runtime slots and final DND contract', () => {
    const preview = buildPreview();

    expect(preview.mode).toBe('sillytavern-compatible');
    expect(preview.prompt).toContain('中文 DM 系统提示。');
    expect(preview.prompt).toContain('The gate responds to silver keys.');
    expect(preview.prompt).toContain('The party stands before the Candlekeep gate.');
    expect(preview.prompt).toContain('1. Ari [in_character_action, public]: I inspect Candlekeep.');
    expect(preview.prompt).toContain(dndOutputContract);
    expect(preview.prompt).toContain('# DND 输出契约');
    expect(preview.prompt).toContain('===STATE PATCH===');
    expect(occurrenceCount(preview.prompt, '# DND 输出契约')).toBe(1);
    expect(preview.prompt.indexOf('中文 DM 系统提示。')).toBeLessThan(preview.prompt.indexOf('The gate responds to silver keys.'));
    expect(preview.prompt.indexOf('1. Ari [in_character_action, public]: I inspect Candlekeep.')).toBeLessThan(preview.prompt.indexOf(dndOutputContract));
    expect(preview.worldBookMatches[0]).toMatchObject({ worldBookId: 'book-1', entryId: 'entry-1', reason: 'primary-key', position: 'before' });
  });

  it('uses public logs for chatHistory and keeps current actions only in dndPlayerActions', () => {
    const preview = buildPreview({ publicLogs });

    expect(preview.prompt).toContain('- Previous scene: A bell rang once.');
    expect(occurrenceCount(preview.prompt, 'I inspect Candlekeep.')).toBe(1);
    expect(preview.promptBlocks.find((block) => block.identifier === 'dndTurnState')?.content).toContain('A bell rang once.');
    expect(preview.promptBlocks.find((block) => block.identifier === 'dndTurnState')?.content).not.toContain('I inspect Candlekeep.');
  });

  it('forces dndOutputContract to system role and renders it once', () => {
    const presetWithUserContract = withPreset({
      prompts: [
        { identifier: 'dndOutputContract', role: 'user', content: 'Imported contract placeholder.' }
      ],
      prompt_order: [{ order: [{ identifier: 'dndOutputContract', enabled: true }] }]
    });

    const preview = buildPreview({ presetPackage: presetWithUserContract });
    const contractBlocks = preview.promptBlocks.filter((block) => block.identifier === 'dndOutputContract');

    expect(contractBlocks).toHaveLength(1);
    expect(contractBlocks[0]).toMatchObject({ role: 'system', source: 'dnd-contract' });
    expect(preview.messages.find((message) => message.content.includes(dndOutputContract))?.role).toBe('system');
    expect(occurrenceCount(preview.prompt, dndOutputContract)).toBe(1);
  });

  it('always appends dndOutputContract after later ST prompt blocks when prompt_order places it early', () => {
    const preview = buildPreview({
      presetPackage: withPreset({
        prompts: [
          { identifier: 'main', role: 'system', content: 'Main prompt before contract.' },
          { identifier: 'dndOutputContract', role: 'user', content: 'Imported contract placeholder.' },
          { identifier: 'laterBlock', role: 'system', content: 'Later ST block that must not dilute the contract.' }
        ],
        prompt_order: [{ order: [
          { identifier: 'main', enabled: true },
          { identifier: 'dndOutputContract', enabled: true },
          { identifier: 'laterBlock', enabled: true }
        ] }]
      })
    });
    const contractBlocks = preview.promptBlocks.filter((block) => block.identifier === 'dndOutputContract');

    expect(contractBlocks).toHaveLength(1);
    expect(preview.promptBlocks.at(-1)).toMatchObject({ identifier: 'dndOutputContract', source: 'dnd-contract', role: 'system' });
    expect(preview.messages.at(-1)?.content).toContain(dndOutputContract);
    expect(preview.prompt.indexOf('Later ST block that must not dilute the contract.')).toBeLessThan(preview.prompt.indexOf(dndOutputContract));
    expect(occurrenceCount(preview.prompt, dndOutputContract)).toBe(1);
  });

  it('returns a usable preview with warnings when openAiSettings has an invalid shape', () => {
    const preview = buildPreview({ presetPackage: withPreset({ prompts: 'not-array', prompt_order: 'not-array' }) });

    expect(preview.mode).toBe('sillytavern-compatible');
    expect(preview.prompt).toContain(dndOutputContract);
    expect(preview.messages.length).toBeGreaterThan(0);
    expect(preview.warnings).toEqual(expect.arrayContaining([
      'No SillyTavern prompt definitions found.',
      'No SillyTavern prompt order found; using prompt definition order.'
    ]));
  });

  it('skips disabled prompt_order items', () => {
    const preview = buildPreview({
      presetPackage: withPreset({
        prompts: [
          { identifier: 'enabledBlock', role: 'system', content: 'Enabled content.' },
          { identifier: 'disabledBlock', role: 'system', content: 'Disabled content.' }
        ],
        prompt_order: [{ order: [
          { identifier: 'disabledBlock', enabled: false },
          { identifier: 'enabledBlock', enabled: true }
        ] }]
      })
    });

    expect(preview.prompt).toContain('Enabled content.');
    expect(preview.prompt).not.toContain('Disabled content.');
  });

  it('falls back to prompt definition order when prompt_order is missing', () => {
    const preview = buildPreview({
      presetPackage: withPreset({
        prompts: [
          { identifier: 'firstBlock', role: 'system', content: 'First fallback content.' },
          { identifier: 'secondBlock', role: 'system', content: 'Second fallback content.' }
        ]
      })
    });

    expect(preview.prompt.indexOf('First fallback content.')).toBeLessThan(preview.prompt.indexOf('Second fallback content.'));
  });

  it('defaults invalid roles to system while preserving valid user and assistant roles', () => {
    const preview = buildPreview({
      presetPackage: withPreset({
        prompts: [
          { identifier: 'invalidRole', role: 'developer', content: 'Invalid role content.' },
          { identifier: 'userRole', role: 'user', content: 'User role content.' },
          { identifier: 'assistantRole', role: 'assistant', content: 'Assistant role content.' }
        ],
        prompt_order: [{ order: [
          { identifier: 'invalidRole', enabled: true },
          { identifier: 'userRole', enabled: true },
          { identifier: 'assistantRole', enabled: true }
        ] }]
      })
    });

    expect(preview.promptBlocks.find((block) => block.identifier === 'invalidRole')?.role).toBe('system');
    expect(preview.promptBlocks.find((block) => block.identifier === 'userRole')?.role).toBe('user');
    expect(preview.promptBlocks.find((block) => block.identifier === 'assistantRole')?.role).toBe('assistant');
  });

  it('matches and orders resource world book entries with before and after rendering', () => {
    const entries: ResourceWorldBookEntry[] = [
      { id: 'disabled', worldBookId: 'book-1', title: 'Disabled', keys: ['Candlekeep'], secondaryKeys: [], content: 'Disabled content.', enabled: false, constant: false, priority: 999, orderIndex: 0, position: 'before', rawJson: {}, createdAt: room.createdAt, updatedAt: room.createdAt },
      { id: 'constant', worldBookId: 'book-1', title: 'Constant', keys: [], secondaryKeys: [], content: 'Constant content.', enabled: true, constant: true, priority: 50, orderIndex: 0, position: 'after', rawJson: {}, createdAt: room.createdAt, updatedAt: room.createdAt },
      { id: 'missing-secondary', worldBookId: 'book-1', title: 'Missing Secondary', keys: ['Candlekeep'], secondaryKeys: ['Ruby'], content: 'Missing secondary content.', enabled: true, constant: false, priority: 500, orderIndex: 0, position: 'before', rawJson: {}, createdAt: room.createdAt, updatedAt: room.createdAt },
      { id: 'low-priority', worldBookId: 'book-1', title: 'Low Priority', keys: ['Candlekeep'], secondaryKeys: [], content: 'Low priority content.', enabled: true, constant: false, priority: 10, orderIndex: 0, position: 'before', rawJson: {}, createdAt: room.createdAt, updatedAt: room.createdAt },
      { id: 'tie-order-first', worldBookId: 'book-1', title: 'Tie First', keys: ['Candlekeep'], secondaryKeys: ['gate'], content: 'Tie first content.', enabled: true, constant: false, priority: 100, orderIndex: 1, position: 'before', rawJson: {}, createdAt: room.createdAt, updatedAt: room.createdAt },
      { id: 'tie-order-second', worldBookId: 'book-1', title: 'Tie Second', keys: ['Candlekeep'], secondaryKeys: ['gate'], content: 'Tie second content.', enabled: true, constant: false, priority: 100, orderIndex: 2, position: 'before', rawJson: {}, createdAt: room.createdAt, updatedAt: room.createdAt }
    ];

    const preview = buildPreview({
      worldBookEntries: entries,
      presetPackage: withPreset({
        prompts: [
          { identifier: 'worldInfoBefore', role: 'system', content: '' },
          { identifier: 'worldInfoAfter', role: 'system', content: '' }
        ],
        prompt_order: [{ order: [
          { identifier: 'worldInfoBefore', enabled: true },
          { identifier: 'worldInfoAfter', enabled: true }
        ] }]
      })
    });

    expect(preview.worldBookMatches.map((match) => match.entryId)).toEqual(['tie-order-first', 'tie-order-second', 'constant', 'low-priority']);
    expect(preview.prompt).not.toContain('Disabled content.');
    expect(preview.prompt).not.toContain('Missing secondary content.');
    expect(preview.prompt.indexOf('Tie first content.')).toBeLessThan(preview.prompt.indexOf('Tie second content.'));
    expect(preview.prompt.indexOf('Low priority content.')).toBeLessThan(preview.prompt.indexOf('Constant content.'));
  });

  it('uses prompt name as identifier fallback when identifier is missing', () => {
    const preview = buildPreview({
      presetPackage: withPreset({
        prompts: [{ name: 'nameOnlyPrompt', role: 'system', content: 'Name-only prompt content.' }]
      })
    });

    expect(preview.promptBlocks[0]).toMatchObject({ identifier: 'nameOnlyPrompt', content: 'Name-only prompt content.' });
  });

  it('keeps readable prompt block names instead of exposing cryptic identifiers as titles', () => {
    const preview = buildPreview({
      presetPackage: withPreset({
        prompts: [
          {
            identifier: 'plqGRxqxkIwGvcbkiYxIi',
            name: '玩家自主权',
            role: 'system',
            content: '绝不代替玩家做出关键决定。在规则范围内，玩家拥有完全的自主权。'
          },
          {
            identifier: 'mLCAugZZ91eSB65HPak_d',
            name: '战斗规则',
            role: 'system',
            content: '战斗中以轻量临场态势说明当前威胁、可见风险和关键判定参考。'
          },
          {
            identifier: 'N9_JLOcQW1sQVP9O7j9Vf',
            role: 'system',
            content: 'NPC 拥有独立动机和目标，始终为自己的利益行动。'
          }
        ],
        prompt_order: [{ order: [
          { identifier: 'plqGRxqxkIwGvcbkiYxIi', enabled: true },
          { identifier: 'mLCAugZZ91eSB65HPak_d', name: '战斗规则', enabled: true },
          { identifier: 'N9_JLOcQW1sQVP9O7j9Vf', enabled: true }
        ] }]
      })
    });

    expect(preview.promptBlocks.slice(0, 3).map((block) => block.displayName)).toEqual([
      '玩家自主权',
      '战斗规则',
      'NPC自主性'
    ]);
  });

  it('deduplicates repeated dndOutputContract runtime slots from prompt_order', () => {
    const preview = buildPreview({
      presetPackage: withPreset({
        prompts: [{ identifier: 'dndOutputContract', role: 'user', content: 'Imported contract placeholder.' }],
        prompt_order: [{ order: [
          { identifier: 'dndOutputContract', enabled: true },
          { identifier: 'dndOutputContract', enabled: true }
        ] }]
      })
    });
    const contractBlocks = preview.promptBlocks.filter((block) => block.identifier === 'dndOutputContract');

    expect(contractBlocks).toHaveLength(1);
    expect(contractBlocks[0]?.role).toBe('system');
    expect(preview.promptBlocks.at(-1)).toMatchObject({ identifier: 'dndOutputContract', source: 'dnd-contract', role: 'system' });
    expect(occurrenceCount(preview.prompt, dndOutputContract)).toBe(1);
    expect(occurrenceCount(preview.prompt, '# DND 输出契约')).toBe(1);
  });
});
