import type { AiTurnPromptSendResponse, PromptBlock, PromptPreset, PromptPresetPackage } from '../../types';

export interface PromptPackageBlockView {
  identifier: string;
  name: string;
  role: string;
  enabled: boolean;
  content: string;
}

export interface NarrativeLengthLimits {
  objectiveMax: number;
  publicMax: number;
  privateMax: number;
}

export const defaultNarrativeLengthLimits: NarrativeLengthLimits = {
  objectiveMax: 300,
  publicMax: 300,
  privateMax: 150
};

export function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function readJsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function parseJsonArrayText(value: string): unknown[] {
  try {
    return readJsonArray(JSON.parse(value));
  } catch {
    return [];
  }
}

export function renderJsonValue(value: unknown) {
  return <pre>{JSON.stringify(value, null, 2)}</pre>;
}

export function renderTextValue(value: unknown, emptyText: string) {
  const text = readString(value).trim();
  return text ? <pre>{text}</pre> : <p className="muted">{emptyText}</p>;
}

export function renderJsonArraySection(items: unknown[], emptyText: string) {
  return items.length > 0 ? renderJsonValue(items) : <p className="muted">{emptyText}</p>;
}

export function eventTypeLabel(type: string): string {
  switch (type) {
    case 'DICE_ROLLED': return '骰点';
    case 'RESOURCE_PATCH_APPLIED': return '资源变更已应用';
    case 'RESOURCE_PATCH_REJECTED': return '资源变更被拒绝';
    case 'PLUGIN_DB_CHANGE_APPLIED': return '插件数据库变更';
    case 'INTERACTION_CREATED': return '互动请求';
    case 'TURN_LOG_MATERIALIZED': return '回合日志';
    case 'COMBAT_STATE_UPDATED': return '战斗状态更新';
    default: return type;
  }
}

export function visibilityScopeLabel(scope: string): string {
  switch (scope) {
    case 'objective': return '客观';
    case 'public': return '公开';
    case 'private': return '私人';
    case 'admin': return '管理员';
    default: return scope;
  }
}

export function aiResultHasInteractionRequests(result: AiTurnPromptSendResponse | null): boolean {
  if (!result || !isJsonRecord(result.raw)) return false;
  return readJsonArray(result.raw.interactionRequests).length > 0;
}

export function appliedAiResultMessage(result: AiTurnPromptSendResponse): string {
  return aiResultHasInteractionRequests(result)
    ? '已写入本回合客观剧情、公开剧情和私人剧情；当前回合正在等待目标玩家回应互动请求。'
    : '已写入本回合客观剧情、公开剧情、私人剧情并推进到下一回合。';
}

export function actionTypeLabel(type: string | undefined): string {
  switch (type) {
    case 'player_question': return '玩家问题';
    case 'meta_question': return '场外问题';
    case 'observe': return '观察';
    case 'wait': return '等待';
    case 'skip': return '跳过';
    case 'ready': return '准备';
    case 'follow': return '跟随';
    case 'combat_action':
    case 'combat': return '战斗行动';
    case 'exploration': return '探索行动';
    case 'social': return '社交行动';
    case 'ooc': return '场外说明';
    default: return '角色行动';
  }
}

export function actionVisibilityLabel(visibility: string | undefined): string {
  switch (visibility) {
    case 'private': return '私人';
    case 'dm_only': return '仅主持人';
    default: return '公开';
  }
}

export function actionStatusLabel(status: string | undefined): string {
  switch (status) {
    case 'complete': return '已结算';
    case 'processing': return '处理中';
    default: return '已提交';
  }
}

const runtimePromptSlotIds = new Set([
  'worldInfoBefore',
  'worldInfoAfter',
  'charDescription',
  'charPersonality',
  'scenario',
  'dialogueExamples',
  'chatHistory',
  'dndTurnState',
  'dndPlayerActions',
  'dndPendingInteractions',
  'dndOutputContract'
]);

export function promptPackageBlocks(presetPackage: PromptPresetPackage | null): PromptPackageBlockView[] {
  if (!presetPackage || !isJsonRecord(presetPackage.openAiSettings)) return [];
  const prompts: Record<string, unknown>[] = Array.isArray(presetPackage.openAiSettings.prompts)
    ? presetPackage.openAiSettings.prompts.filter(isJsonRecord) as Record<string, unknown>[]
    : [];
  const firstOrder = Array.isArray(presetPackage.openAiSettings.prompt_order)
    ? presetPackage.openAiSettings.prompt_order.filter(isJsonRecord)[0] as Record<string, unknown> | undefined
    : undefined;
  const order = firstOrder ? firstOrder['order'] : undefined;
  const orderItems: Record<string, unknown>[] = Array.isArray(order) ? order.filter(isJsonRecord) as Record<string, unknown>[] : [];
  const enabledByIdentifier = new Map<string, boolean>();
  orderItems.forEach((item) => {
    const identifier = (readString(item.identifier) || readString(item.name)).trim();
    if (identifier) enabledByIdentifier.set(identifier, item.enabled !== false);
  });

  return prompts
    .map((prompt) => {
      const identifier = (readString(prompt.identifier) || readString(prompt.name)).trim();
      return {
        identifier,
        name: (readString(prompt.name) || identifier || '未命名块').trim(),
        role: readString(prompt.role) || 'system',
        enabled: enabledByIdentifier.get(identifier) ?? true,
        content: readString(prompt.content).trim()
      };
    })
    .filter((block) => block.identifier.length > 0 || block.content.length > 0);
}

export function promptPackageBlockContent(block: PromptPackageBlockView): string {
  if (block.content) return block.content;
  if (runtimePromptSlotIds.has(block.identifier)) {
    return '运行时槽位：实际内容由当前房间、剧本卡、世界书、日志或输出契约生成。点击“预览 AI 请求”查看最终内容。';
  }
  return '空内容';
}

export function buildNarrativeLengthRuleContent(limits: NarrativeLengthLimits): string {
  return [
    '剧情字数硬上限：控制 AI 本回合输出的三层剧情长度。超过上限属于格式错误。',
    `- objectiveLog：最多 ${limits.objectiveMax} 个中文字符，写 DM 需要追踪的客观事实、隐藏细节和裁定依据。`,
    `- publicLog：最多 ${limits.publicMax} 个中文字符，只写所有玩家共同可见或共同已知的公开剧情。`,
    `- privateUpdatesByPlayer：每名玩家最多 ${limits.privateMax} 个中文字符，只写该玩家本人可见的私人信息。`,
    '- ruleResults：每条最多 120 个中文字符。',
    '- interactionRequests：每条 prompt 最多 120 个中文字符。',
    '- suggestedStateChanges.reason：最多 120 个中文字符。',
    '- characterResourceChanges.reason：最多 80 个中文字符。',
    '- diceRequests.reason：最多 80 个中文字符。',
    '信息量少时可以更短，不要为了达到字数而填充内容。'
  ].join('\n');
}

export function readNarrativeLengthLimits(preset: PromptPreset | null): NarrativeLengthLimits {
  const block = preset?.blocks.find((item) => item.name === '剧情字数限制');
  const content = block?.content ?? '';
  const objective = content.match(/objectiveLog：(?:最多|建议\s*\d+-)\s*(\d+)/);
  const publicLog = content.match(/publicLog：(?:最多|建议\s*\d+-)\s*(\d+)/);
  const privateLog = content.match(/privateUpdatesByPlayer：(?:每名玩家)?(?:最多|建议\s*\d+-)\s*(\d+)/);
  return {
    objectiveMax: objective ? Number(objective[1]) : defaultNarrativeLengthLimits.objectiveMax,
    publicMax: publicLog ? Number(publicLog[1]) : defaultNarrativeLengthLimits.publicMax,
    privateMax: privateLog ? Number(privateLog[1]) : defaultNarrativeLengthLimits.privateMax
  };
}

export function upsertNarrativeLengthBlock(preset: PromptPreset, limits: NarrativeLengthLimits): PromptPreset {
  const content = buildNarrativeLengthRuleContent(limits);
  const blocks = preset.blocks.some((block) => block.name === '剧情字数限制')
    ? preset.blocks.map((block) => block.name === '剧情字数限制' ? { ...block, enabled: true, role: 'system' as const, position: 'final' as const, orderIndex: 850, content } : block)
    : [...preset.blocks, { name: '剧情字数限制', role: 'system' as const, position: 'final' as const, enabled: true, orderIndex: 850, content } as PromptBlock];
  return { ...preset, blocks };
}
