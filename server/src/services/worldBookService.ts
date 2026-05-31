import type { LogEntry, Player, PlayerAction, ResourceWorldBookEntry, ResourceWorldBookMatch, WorldBookEntry, WorldBookMatch } from '../domain/types.js';

function normalizeKeyList(value: string[]): string[] {
  return value.map((key) => key.trim()).filter(Boolean);
}

function includesAnyKeyword(text: string, keys: string[]): string | null {
  const lowerText = text.toLocaleLowerCase();
  for (const key of normalizeKeyList(keys)) {
    if (lowerText.includes(key.toLocaleLowerCase())) return key;
  }
  return null;
}

const futureCampaignKeywords = [
  'Redbrands',
  'Glassstaff',
  'Agatha',
  'Old Owl Well',
  'Thundertree',
  'Cragmaw Castle',
  'Wave Echo Cave',
  'Black Spider',
  '红标帮',
  '玻璃杖',
  '阿加莎',
  '旧枭井',
  '雷树镇',
  '克拉格玛城堡',
  '浪涛回音洞',
  '黑蜘蛛'
];

function looksLikeFutureCampaignNode(entry: { title: string; content: string; keys: string[] }): boolean {
  const text = [entry.title, entry.content, ...entry.keys].join('\n').toLocaleLowerCase();
  return futureCampaignKeywords.some((keyword) => text.includes(keyword.toLocaleLowerCase()));
}

export function buildWorldBookScanText(input: {
  roomWorldInfo: string;
  publicLogs: LogEntry[];
  actions: PlayerAction[];
  players: Player[];
}): string {
  const playerNames = new Map(input.players.map((player) => [player.id, player.name]));
  return [
    input.roomWorldInfo,
    ...input.publicLogs.map((log) => `${log.title}\n${log.content}`),
    ...input.actions.map((action) => `${playerNames.get(action.playerId) ?? 'Unknown'}\n${action.text}`)
  ].join('\n\n');
}

export function matchWorldBookEntries(entries: WorldBookEntry[], scanText: string): WorldBookMatch[] {
  return entries
    .filter((entry) => entry.enabled)
    .map((entry) => {
      if (entry.constant) {
        const explicitKey = includesAnyKeyword(scanText, entry.keys);
        if (!explicitKey && looksLikeFutureCampaignNode(entry)) return null;
        return { entry, matchedKeys: explicitKey ? ['常驻', explicitKey] : ['常驻'] };
      }
      const primaryKey = includesAnyKeyword(scanText, entry.keys);
      if (!primaryKey) return null;
      if (entry.selective && entry.secondaryKeys.length > 0) {
        const secondaryKey = includesAnyKeyword(scanText, entry.secondaryKeys);
        if (!secondaryKey) return null;
        return { entry, matchedKeys: [primaryKey, secondaryKey] };
      }
      return { entry, matchedKeys: [primaryKey] };
    })
    .filter((match): match is WorldBookMatch => Boolean(match))
    .sort((left, right) => right.entry.priority - left.entry.priority || left.entry.title.localeCompare(right.entry.title))
    .slice(0, 6);
}

export function matchResourceWorldBookEntries(entries: ResourceWorldBookEntry[], scanText: string): ResourceWorldBookMatch[] {
  return entries
    .filter((entry) => entry.enabled)
    .map((entry) => {
      if (entry.constant) {
        const explicitKey = includesAnyKeyword(scanText, entry.keys);
        if (!explicitKey && looksLikeFutureCampaignNode(entry)) return null;
        return { entry, matchedKeys: explicitKey ? ['常驻', explicitKey] : ['常驻'], reason: 'constant' as const };
      }
      const primaryKey = includesAnyKeyword(scanText, entry.keys);
      if (!primaryKey) return null;
      if (entry.secondaryKeys.length > 0) {
        const secondaryKey = includesAnyKeyword(scanText, entry.secondaryKeys);
        if (!secondaryKey) return null;
        return { entry, matchedKeys: [primaryKey, secondaryKey], reason: 'primary-and-secondary-key' as const };
      }
      return { entry, matchedKeys: [primaryKey], reason: 'primary-key' as const };
    })
    .filter((match): match is ResourceWorldBookMatch => Boolean(match))
    .sort((left, right) => right.entry.priority - left.entry.priority || left.entry.orderIndex - right.entry.orderIndex || left.entry.title.localeCompare(right.entry.title));
}

export function renderResourceWorldBookMatches(matches: ResourceWorldBookMatch[], position: 'before' | 'after', limit = 6): string {
  const positioned = matches.filter((match) => match.entry.position === position);
  if (positioned.length === 0) return '';
  const required = positioned.filter((match) => match.reason === 'constant').slice(0, 3);
  const triggered = positioned.filter((match) => match.reason !== 'constant');
  const selected = [...required, ...triggered.slice(0, Math.max(0, limit - required.length))];
  return selected.map((match) => {
    const content = match.entry.content
      .replace('AI 不直接掷骰，必须用 diceRequests 请求系统骰点。', '需要随机结果时用 diceRequests 让系统内部自动骰点，不要求玩家手动投掷。')
      .replace('AI 只输出 suggestedStateChanges，由管理员或系统应用。', 'AI 只输出 suggestedStateChanges 或可校验的 characterResourceChanges，由系统应用合法变更。');
    return `## ${match.entry.title}\n触发：${match.matchedKeys.join(', ')}\n${content}`;
  }).join('\n\n');
}

export function renderWorldBookMatches(matches: WorldBookMatch[]): string {
  if (matches.length === 0) return '- No active world book entries.';
  return matches
    .slice(0, 6)
    .map((match) => `## ${match.entry.title}\n触发：${match.matchedKeys.join(', ')}\n${match.entry.content}`)
    .join('\n\n');
}
