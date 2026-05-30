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
      if (entry.constant) return { entry, matchedKeys: ['常驻'] };
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
    .sort((left, right) => right.entry.priority - left.entry.priority || left.entry.title.localeCompare(right.entry.title));
}

export function matchResourceWorldBookEntries(entries: ResourceWorldBookEntry[], scanText: string): ResourceWorldBookMatch[] {
  return entries
    .filter((entry) => entry.enabled)
    .map((entry) => {
      if (entry.constant) return { entry, matchedKeys: ['常驻'], reason: 'constant' as const };
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

export function renderResourceWorldBookMatches(matches: ResourceWorldBookMatch[], position: 'before' | 'after'): string {
  const positioned = matches.filter((match) => match.entry.position === position);
  if (positioned.length === 0) return '';
  return positioned.map((match) => `## ${match.entry.title}\n触发：${match.matchedKeys.join(', ')}\n${match.entry.content}`).join('\n\n');
}

export function renderWorldBookMatches(matches: WorldBookMatch[]): string {
  if (matches.length === 0) return '- No active world book entries.';
  return matches
    .map((match) => `## ${match.entry.title}\n触发：${match.matchedKeys.join(', ')}\n${match.entry.content}`)
    .join('\n\n');
}
