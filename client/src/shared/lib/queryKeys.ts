/** 集中管理 query key：所有 campaign key 以 ['campaign', campaignId] 前缀开头，archive.restored 可单前缀全量失效。 */

export const sessionKey = ['session'] as const;

export const campaignListKey = ['campaigns'] as const;

export function campaignQueryPrefix(campaignId: string): string[] {
  return ['campaign', campaignId];
}

export function campaignDetailKey(campaignId: string): string[] {
  return ['campaign', campaignId, 'detail'];
}

export function campaignCharactersKey(campaignId: string): string[] {
  return ['campaign', campaignId, 'characters'];
}


export function campaignWorldKey(campaignId: string): string[] {
  return ['campaign', campaignId, 'world'];
}

export function campaignTurnsKey(campaignId: string): string[] {
  return ['campaign', campaignId, 'turns'];
}

export function campaignTurnKey(campaignId: string, turnId: string): string[] {
  return ['campaign', campaignId, 'turn', turnId];
}

export function campaignEntriesKey(campaignId: string, turnId: string): string[] {
  return ['campaign', campaignId, 'entries', turnId];
}

export function campaignAiRunsKey(campaignId: string, turnId: string): string[] {
  return ['campaign', campaignId, 'ai-runs', turnId];
}

export function campaignAiRunHistoryKey(campaignId: string): string[] {
  return ['campaign', campaignId, 'ai-runs', 'history'];
}

export function campaignAiRunKey(campaignId: string, runId: string): string[] {
  return ['campaign', campaignId, 'ai-run', runId];
}


export function campaignCombatKey(campaignId: string): string[] {
  return ['campaign', campaignId, 'combat'];
}

export function campaignCombatDetailKey(campaignId: string, encounterId: string): string[] {
  return ['campaign', campaignId, 'combat', encounterId];
}

export function campaignArchivesKey(campaignId: string): string[] {
  return ['campaign', campaignId, 'archives'];
}
