import { nanoid } from 'nanoid';
import type { AppDatabase } from '../db/connection.js';
import type { AiTurnPromptPreviewResponse, AiTurnPromptSendResponse, AiTurnResult, Room, TurnResolutionRun } from '../domain/types.js';
import { createAiProviderFromConfig, validateAiTurnResult, validateAiTurnResultLengthWarnings } from './aiProvider.js';
import { getGlobalAiProviderConfig } from './globalConfigService.js';
import { publishRoomUpdate } from './eventBus.js';
import {
  buildAiTurnDebugPrompt,
  buildRoomPromptPreview,
  loadCharacterStatusSection
} from './promptPreviewService.js';
import { parseNarrativeLengthLimitsFromPromptBlocks } from './aiContextBuilder.js';
import type { PresetNumericConfig } from '../domain/types.js';
import { defaultPresetNumericConfig } from '../domain/types.js';
import {
  getActiveNumericConfig,
  getActiveRewriteAntiClichePrompt,
  getActiveRewriteCotPrompt,
  getActiveRewriteStylePrompt,
  getActiveRewriteTaskPrompt
} from './presetConfigService.js';
import { getGlobalRuntimeSettings } from './globalConfigService.js';
import {
  assertPreviewMatchesCurrentReadyTurn,
  assertTurnReadyForAi,
  getTurnReadiness
} from './turnReadinessService.js';
import {
  buildConfirmedAiTurnResult,
  buildResolutionNarrationSections,
  collectDiceRequestRoutingWarnings,
  createTurnResolutionRun,
  loadTurnResolutionRun,
  playerIdForCharacter
} from './turnResolutionService.js';
import {
  collectInteractionRoutingWarnings,
  collectPrivateUpdateRoutingWarnings,
  collectResourcePatchPreflightErrors,
  materializeAiTurnResult,
  normalizeSuggestedStateChanges
} from './turnMaterializationService.js';

export class AiTurnWorkflowHttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly payload: unknown
  ) {
    super(typeof payload === 'object' && payload !== null && 'message' in payload ? String((payload as { message?: unknown }).message) : 'AI turn workflow error');
  }
}

export interface AiTurnApplyInput {
  roomId: string;
  previewId: string;
  confirmedSuggestedStateChangeIndexes: number[];
  confirmedCharacterResourceChangeIndexes: number[];
}

function getRoom(db: AppDatabase, roomId: string): Room | null {
  const row = db.prepare('SELECT id, name, system_prompt as systemPrompt, world_info as worldInfo, current_turn as currentTurn, status, expected_player_count as expectedPlayerCount, ai_config_json as aiConfigJson, created_at as createdAt FROM rooms WHERE id = ?').get(roomId) as any;
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    systemPrompt: row.systemPrompt,
    worldInfo: row.worldInfo,
    currentTurn: row.currentTurn,
    status: row.status,
    expectedPlayerCount: row.expectedPlayerCount ?? null,
    aiConfig: JSON.parse(row.aiConfigJson),
    createdAt: row.createdAt
  };
}

function claimRoomTurnForProcessing(db: AppDatabase, roomId: string, turnId: string): boolean {
  return db.transaction(() => {
    const roomClaim = db.prepare('UPDATE rooms SET status = ? WHERE id = ? AND status = ?').run('processing', roomId, 'ready_to_resolve');
    if (roomClaim.changes !== 1) return false;

    const turnClaim = db.prepare('UPDATE turns SET status = ? WHERE id = ? AND status = ?').run('processing', turnId, 'ready_to_resolve');
    if (turnClaim.changes !== 1) {
      db.prepare('UPDATE rooms SET status = ? WHERE id = ? AND status = ?').run('ready_to_resolve', roomId, 'processing');
      return false;
    }

    return true;
  })();
}

function restoreRetryableApplyFailure(db: AppDatabase, roomId: string, turnId: string): void {
  db.transaction(() => {
    db.prepare('UPDATE rooms SET status = ? WHERE id = ? AND status IN (?, ?)')
      .run('ready_to_resolve', roomId, 'processing', 'needs_admin_attention');
    db.prepare('UPDATE turns SET status = ?, ended_at = NULL WHERE id = ? AND status IN (?, ?)')
      .run('ready_to_resolve', turnId, 'processing', 'needs_admin_attention');
  })();
}

function recoverReadyTurnAfterApplyFailure(db: AppDatabase, roomId: string, previewTurnId: string | null = null): void {
  const row = db.prepare(`
    SELECT
      r.id as roomId,
      r.current_turn as currentTurn,
      r.status as roomStatus,
      t.id as turnId,
      t.status as turnStatus
    FROM rooms r
    LEFT JOIN turns t ON t.room_id = r.id AND t.number = r.current_turn
    WHERE r.id = ?
  `).get(roomId) as { roomId: string; currentTurn: number; roomStatus: Room['status']; turnId: string | null; turnStatus: string | null } | undefined;
  if (!row?.turnId) return;
  if (previewTurnId && row.turnId !== previewTurnId) return;
  if (row.roomStatus !== 'needs_admin_attention' || row.turnStatus !== 'needs_admin_attention') return;

  const readiness = getTurnReadiness(db, { id: roomId, currentTurn: row.currentTurn, status: row.roomStatus }, { updateStatus: false });
  if (readiness.requiredActorIds.length > 0 && readiness.missingActorIds.length === 0) {
    restoreRetryableApplyFailure(db, roomId, row.turnId);
  }
}

function joinNarrativeParts(parts: Array<string | undefined>): string {
  return parts.map((part) => part?.trim()).filter((part): part is string => Boolean(part)).join('\n\n');
}

const DEFAULT_REWRITE_MIN_CHARS = 500;
const DEFAULT_REWRITE_MAX_CHARS = 1500;

const REWRITE_FACTUAL_SECTION_HEADINGS = [
  '## Campaign State',
  '## Character Status',
  '## Current Turn Actions',
  '## Interaction Requests',
  '## Recent Public Logs',
  '## Relevant Worldbook And Approved Rules',
  '## Campaign Memory And Plugin Database',
  '# 叙事范文（严格按照此风格和长度写作）'
];

export function extractFactualPromptSections(originalPrompt: string): string {
  if (!originalPrompt) return '';
  const lines = originalPrompt.split(/\r?\n/);
  const blocks: Array<{ heading: string; body: string[] }> = [];
  let current: { heading: string; body: string[] } | null = null;
  for (const line of lines) {
    const headingMatch = line.match(/^#{1,2}\s+\S/);
    if (headingMatch) {
      if (current) blocks.push(current);
      current = { heading: line.trim(), body: [] };
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) blocks.push(current);
  const allowed = new Set(REWRITE_FACTUAL_SECTION_HEADINGS.map((h) => h.toLowerCase()));
  const kept = blocks.filter((block) => allowed.has(block.heading.toLowerCase()));
  if (kept.length === 0) return '';
  return kept.map((block) => [block.heading, ...block.body].join('\n').trimEnd()).join('\n\n');
}

export const DEFAULT_REWRITE_TASK_PROMPT = [
  '你是中文 DND 跑团的「公开剧情重写者」。前一步 DM 已经完成本回合裁定（包括客观真相、私人剧情、骰点结果、状态变更）。你的唯一任务是把"所有玩家共同可见或共同已知的公开剧情"用生动的中文写成一段或多段叙事正文。'
].join('\n');

export const DEFAULT_REWRITE_STYLE_PROMPT = [
  '- 这是一场严肃的中文 DND 5e 跑团，画面感优先于解释。',
  '- 动词优先，少形容词。让动作本身说话："布兰横步上前，盾牌在岩壁上擦出火星" 优于 "布兰勇敢地走上前去，他的盾牌看起来很坚固"。',
  '- 感官细节具体到可观察：火光投在岩壁上的角度、潮湿空气里的铁锈味、湿泥踩下去的咕叽声、皮甲皮带摩擦的吱呀。每段至少一处感官锚点，但不要堆。',
  '- NPC 反应有性格、有立场、有局限：布兰沉默靠盾，希拉警惕治疗符记，米瑞尔蹲下查痕。NPC 不全知、不抢戏、不替玩家判断。',
  '- 节奏：呈现 → 角色反应 → 留出抉择空间。不要在段尾"那一刻她明白了""于是命运悄然改变"之类总结升华。',
  '- 对话只为线索、行动、性格服务。NPC 一段对白不超过 2 句，不写大段独白。',
  '- 失败的检定写成"风声水声盖过细微动静""火光照不到通道深处"这种环境层的"挡住了"，不要写成"角色没用"。'
].join('\n');

export const DEFAULT_REWRITE_ANTI_CLICHE_PROMPT = [
  '以下是中文 LLM 的常见套路腔，绝对避免：',
  '- ❌ "不是……而是……" / "与其说是……不如说是……" 这类反复否定句式 → ✅ 直接陈述事实。',
  '- ❌ "如蒙大赦" / "松了一大口气，仿佛卸下千斤重担" / "心头一紧" / "不可置信" → ✅ "肩头塌了下来" / "呼吸顿了一拍" / "皱起眉" 等具体身体反应。',
  '- ❌ "一丝/一抹/一缕/一股 + 抽象名词"（一丝寒意 / 一抹疑虑 / 一股不祥）→ ✅ 用具体细节替代："后颈起了鸡皮疙瘩" / "他下意识握紧了剑柄"。',
  '- ❌ "像是/仿佛要将 X 吞噬" / "宛如墨汁般浓稠的黑暗" 这种比喻堆叠 → ✅ 直接写黑暗的可观察后果："火把照不出三步外的轮廓"。严禁使用"像是"，全部用直陈或感官细节替代。',
  '- ❌ "喉结滚动" / "指节发白" / "嘴角勾起一抹弧度" → ✅ 不要写这些刻板细节。',
  '- ❌ "破折号 ——" → ✅ 严禁使用破折号，全部用逗号或句号替代。',
  '- ❌ 段尾"那一刻他明白了……" / "于是真相浮出水面" / "命运的齿轮开始转动" 这类升华 → ✅ 直接停在动作或环境反馈，把判断留给玩家。',
  '- ❌ "AI" "本回合" "上一稿" "DM" "publicLog" "objectiveLog" "玩家" "Player" 等元词汇 → ✅ 直接用角色名和场景词。',
  '- ❌ NPC 替玩家说"我们应该……吧" / "也许该……" 这种暗示性建议 → ✅ NPC 表达自己的判断或情绪，但不替玩家做决定。',
  '- ❌ 替玩家角色说话 / 做未授权动作 / 写内心独白（违反玩家自主权三档） → ✅ 严格遵守：对白不可代写、动作不可追加、思考只写外在观察不写内心。',
  '- ❌ 数字编号化分点 / Markdown 标题 / 列表符号 → ✅ 自然段落叙事。'
].join('\n');

export const DEFAULT_REWRITE_COT_PROMPT = [
  '在写公开剧情正文之前，先写一段隐藏思维链，用 `<draft_notes>` 标签包起来。这段内容只供你自己整理思路，服务端在保存前会自动剥离 `<draft_notes>...</draft_notes>` 整段，玩家与 DM 都看不到。',
  '`<draft_notes>` 内必须依次回答以下 6 点（每点 1-2 句中文）：',
  '1. 重构现状：上一回合公开剧情末尾发生了什么？玩家此次行动是否被前一幕的状态、位置、姿态合理承接？',
  '2. 玩家行动可行性：玩家提交的行动是否在角色当前能力、资源、所处环境内合理？是否被某个骰点结果约束？你的叙事是否严格遵守了玩家自主权三档（对白不可代写、动作不可追加、思考只写外在观察）？',
  '3. NPC 反应：在场 NPC 各自基于其性格、立场、知识边界，会做出什么样的可观察反应？谁先动？谁旁观？谁有保留？',
  '4. 时间与环境推进：本回合内场景时间从 X 推进到 Y；雨势 / 火光 / 通道深度 / 风向等环境元素本回合如何变化？',
  '5. 字数与文风自检：本段计划写多少字，写几段，每段的感官锚点和动词锚点准备用什么？是否绕开了套路黑名单？',
  '6. 信息隔离自检：本回合有没有 DM-only 隐藏事实需要绝对避免泄漏给玩家？有没有失败检定需要写成"未能确认"而非"确认没有"？',
  '回答完 6 点之后，写 `</draft_notes>`，然后另起一行直接开始公开剧情正文。',
  '警告：除 `<draft_notes>...</draft_notes>` 这一对标签之外，全文不得出现任何其他 XML/HTML 标签、Markdown 标题、代码块、分隔符或元说明。'
].join('\n');

export interface PublicLogRewriteOverrides {
  numericConfig?: PresetNumericConfig;
  taskPrompt?: string | null;
  stylePrompt?: string | null;
  antiClichePrompt?: string | null;
  cotPrompt?: string | null;
}

export function buildRewriteOverridesFromDb(db: AppDatabase): PublicLogRewriteOverrides {
  return {
    numericConfig: getActiveNumericConfig(db),
    taskPrompt: getActiveRewriteTaskPrompt(db),
    stylePrompt: getActiveRewriteStylePrompt(db),
    antiClichePrompt: getActiveRewriteAntiClichePrompt(db),
    cotPrompt: getActiveRewriteCotPrompt(db)
  };
}

export function buildPublicLogRewritePrompt(
  originalPrompt: string,
  finalResult: AiTurnResult,
  overrides: PublicLogRewriteOverrides = {}
): string {
  const numericConfig = overrides.numericConfig ?? defaultPresetNumericConfig;
  const minChars = numericConfig.rewriteMinChars ?? DEFAULT_REWRITE_MIN_CHARS;
  const maxChars = numericConfig.rewriteMaxChars ?? DEFAULT_REWRITE_MAX_CHARS;
  const taskPrompt = overrides.taskPrompt?.trim() || DEFAULT_REWRITE_TASK_PROMPT;
  const stylePrompt = overrides.stylePrompt?.trim() || DEFAULT_REWRITE_STYLE_PROMPT;
  const antiClichePrompt = overrides.antiClichePrompt?.trim() || DEFAULT_REWRITE_ANTI_CLICHE_PROMPT;
  const cotPrompt = overrides.cotPrompt?.trim() || DEFAULT_REWRITE_COT_PROMPT;

  const sections: string[] = [];
  sections.push('# 任务');
  sections.push(taskPrompt);
  sections.push('');
  sections.push('# 输出要求');
  sections.push(`- 直接输出公开剧情正文，不要写字段名、不要写 JSON、不要写 Markdown 代码块、不要写"publicLog:"之类前缀、不要写解释或元说明。`);
  sections.push('- 不要输出 ===STATE PATCH===、状态补丁、双段契约等任何分隔符或结构化尾段；本任务的输出从头到尾都是纯叙事正文。');
  sections.push(`- 字数：常规多人行动回合写 ${minChars}-${Math.min(900, maxChars)} 个中文字符，2-4 段可读场景；只有单人简短问答、等待/跳过或纯过场等信息极少的回合才可短于 ${minChars}，但绝不可超过 ${maxChars}。`);
  sections.push('- 视角：默认第三人称或客观陈述，例如"赛琳检查洞口"。仅 NPC 台词、引用玩家原话或自然对话中可使用"你/你们"。');
  sections.push('- 信息隔离：仅写所有玩家共同可见或共同已知的内容。绝不能透露 DM 客观日志中尚未公开的隐藏事实、隐藏敌人、陷阱、秘密动机；失败的察觉/调查只能写"未能确认/暂时无法判断"。');
  sections.push('- 不要复述上一回合的同一行动结果；本回合 publicLog 应推进剧情或给出新可见信息。');
  sections.push('- <peip> 首句扩写规则：玩家行动被包在 <peip player="角色名" type="行动类型">...</peip> 标签里。公开剧情的第一句必须从扩写该玩家的行动开始——用感官细节和环境互动将玩家的简短指令展开为角色实际做出的动作。绝对禁止跳过玩家行动直接写下一幕。每一条 <peip> 都必须在叙事中被承接和执行，不能遗漏。');
  sections.push('- 玩家自主权三档（从最严到最宽）：');
  sections.push('  ① 对白（最严）：绝对禁止替玩家角色说话。不可写玩家角色说的任何一句话，即使是"嗯""好"这种应答也不行。玩家角色的对白只能由玩家自己在下一轮提交。NPC 可以对玩家提问或等待回应，但不得代替玩家回答。');
  sections.push('  ② 动作（严格）：不可替玩家角色做出未授权的主动动作。如果 <peip> 只说"我走向门口"，你可以写走向门口途中的环境描写，但不可写"她走向门口并推开了门"——"推开"是新的主动动作，需要玩家授权。同理，"我问店主有没有空房间"只允许写到对话过程，不可替玩家掏钱、付账、拿钥匙等后续动作。"我坐下休息"只写坐下和环境描写，不可写解下物品、脱鞋、躺下等。NPC 可以对玩家的动作做出反应，但不可替玩家追加动作。');
  sections.push('  ③ 思考（宽松）：可以对玩家角色正在经历的事情做外在观察描写（"她的手在发抖""他的目光掠过桌面"），但不可写内心独白（"她心想……""他意识到……"）或替玩家做判断（"他确信这就是陷阱"）。');
  sections.push('');
  sections.push('# 文风：DND 战役 / 暗黑奇幻基调');
  sections.push(stylePrompt);
  sections.push('');
  sections.push('# 反 AI 套路（命中即重写）');
  sections.push(antiClichePrompt);
  sections.push('');
  sections.push('# DM 已确定的客观真相（仅供你写公开剧情时参考，不要直接抄写隐藏内容）');
  sections.push(finalResult.objectiveLog?.trim() || '（DM 未提供额外客观真相，依据玩家行动写作。）');
  sections.push('');
  if (finalResult.diceResults && finalResult.diceResults.length > 0) {
    sections.push('# 已确定的骰点结果');
    for (const dice of finalResult.diceResults) {
      const success = dice.success === undefined ? '' : dice.success ? '（成功）' : '（失败）';
      const reason = dice.publicReason || dice.reason || '';
      sections.push(`- ${dice.diceType} ${reason}: ${dice.total}${dice.dc !== undefined && dice.dc !== null ? ` (DC ${dice.dc})` : ''}${success}`);
    }
    sections.push('');
  }
  if (finalResult.publicLog?.trim()) {
    sections.push('# 上一稿（仅供参考，可大幅改写以达到字数和生动度要求）');
    sections.push(finalResult.publicLog.trim());
    sections.push('');
  }
  const factual = extractFactualPromptSections(originalPrompt);
  if (factual) {
    sections.push('# 事实上下文（玩家本回合行动、角色/房间状态、最近公开剧情、世界书与战役记忆）');
    sections.push(factual);
    sections.push('');
  }
  sections.push('# 输出格式（重要）');
  sections.push(cotPrompt);
  sections.push('');
  sections.push('# 现在开始：先写 <draft_notes>...</draft_notes> 思考块，再写公开剧情正文：');
  return sections.join('\n');
}

export function stripDraftNotes(text: string): string {
  return text.replace(/<draft_notes>[\s\S]*?<\/draft_notes>/gi, '').trim();
}

export function stripStatePatchTail(text: string): string {
  let trimmed = text.trim();
  if (!trimmed) return trimmed;
  const separatorMatch = trimmed.match(/={2,}\s*STATE\s*PATCH\s*={2,}/i);
  if (separatorMatch && separatorMatch.index !== undefined) {
    trimmed = trimmed.slice(0, separatorMatch.index).trim();
  }
  const fenceIndex = trimmed.search(/```|\{\s*"(?:objectiveLog|publicLog|privateUpdatesByPlayer|ruleResults|interactionRequests|diceRequests|suggestedStateChanges|characterResourceChanges)"/);
  if (fenceIndex > 0) {
    trimmed = trimmed.slice(0, fenceIndex).trim();
  }
  return trimmed;
}

const CLICHE_PATTERNS: Array<{ pattern: RegExp; label: string; replacement?: string }> = [
  { pattern: /不是[^，。；\n]{1,10}而是/g, label: '不是…而是' },
  { pattern: /与其说是[^，。；\n]{1,10}不如说是/g, label: '与其说是…不如说是' },
  { pattern: /如蒙大赦/g, label: '如蒙大赦', replacement: '肩头塌了下来' },
  { pattern: /松了一大口气，仿佛卸下千斤重担/g, label: '千斤重担', replacement: '长长地吐了口气' },
  { pattern: /心头一紧/g, label: '心头一紧', replacement: '呼吸顿了一拍' },
  { pattern: /不可置信/g, label: '不可置信', replacement: '怔住了' },
  { pattern: /一(?:丝|抹|缕|股)(?:寒意|疑虑|不祥|恐惧|不安|希望|温暖)/g, label: '一丝/一抹+抽象名词' },
  { pattern: /喉结滚动/g, label: '喉结滚动' },
  { pattern: /指节发白/g, label: '指节发白' },
  { pattern: /嘴角勾起一抹弧度/g, label: '嘴角勾起弧度' },
  { pattern: /命运的齿轮(?:开始)?转动/g, label: '命运齿轮' },
  { pattern: /那一刻(?:他|她|它|他们)(?:终于)?明白了/g, label: '那一刻他明白了' },
  { pattern: /真相浮出水面/g, label: '真相浮出水面' },
];

export function applyClicheFilter(text: string): { text: string; hits: Array<{ label: string; match: string }> } {
  const hits: Array<{ label: string; match: string }> = [];
  let result = text;
  for (const { pattern, label, replacement } of CLICHE_PATTERNS) {
    result = result.replace(pattern, (match) => {
      hits.push({ label, match });
      return replacement ? `<cliche:${label}>${replacement}</cliche>` : `<cliche:${label}>${match}</cliche>`;
    });
  }
  return { text: result, hits };
}

async function rewritePublicLog(
  aiProvider: ReturnType<typeof createAiProviderFromConfig>,
  originalPrompt: string,
  finalResult: AiTurnResult,
  warnings: string[],
  overrides: PublicLogRewriteOverrides = {}
): Promise<AiTurnResult> {
  try {
    const rewritePrompt = buildPublicLogRewritePrompt(originalPrompt, finalResult, overrides);
    const raw = (await aiProvider.generateNarrativeText(rewritePrompt)).trim();
    if (!raw) {
      warnings.push('公开剧情重写返回空内容，已保留原始 publicLog。');
      return finalResult;
    }
    const withoutDraft = stripDraftNotes(raw);
    const narrative = stripStatePatchTail(withoutDraft);
    if (!narrative) {
      warnings.push('公开剧情重写返回内容在剥离思维链和尾部 JSON 后为空，已保留原始 publicLog。');
      return finalResult;
    }
    if (looksLikeJsonOrFenced(narrative)) {
      warnings.push('公开剧情重写返回的不是叙事正文（疑似 JSON 或代码块），已保留原始 publicLog。');
      return finalResult;
    }
    const strippedSomething = narrative.length < raw.length;
    if (strippedSomething) {
      const parts: string[] = [];
      if (withoutDraft.length < raw.length) parts.push('隐藏思维链 <draft_notes>');
      if (narrative.length < withoutDraft.length) parts.push('===STATE PATCH=== 或 JSON 尾段');
      warnings.push(`公开剧情重写返回包含 ${parts.join(' 和 ')}，已自动剥离仅保留叙事正文。`);
    }
    const filtered = applyClicheFilter(narrative);
    if (filtered.hits.length > 0) {
      warnings.push(`公开剧情重写命中套路词过滤：${filtered.hits.map((h) => `${h.label}("${h.match}")`).join('、')}，已打 <cliche> 标签。`);
    }
    return { ...finalResult, publicLog: filtered.text };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`公开剧情重写失败，已保留原始 publicLog：${message}`);
    return finalResult;
  }
}

function looksLikeJsonOrFenced(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return true;
  if (trimmed.startsWith('```')) return true;
  if (/^"\s*(publicLog|objectiveLog|privateUpdatesByPlayer)\s*:/i.test(trimmed)) return true;
  return false;
}

function mergePrivateNarratives(
  preliminary: Record<string, string>,
  postResolution: Record<string, string>,
  replacePreliminaryForPlayerIds: string[] = []
): Record<string, string> {
  const playerIds = new Set([...Object.keys(preliminary), ...Object.keys(postResolution)]);
  const replacementIds = new Set(replacePreliminaryForPlayerIds);
  return Object.fromEntries([...playerIds].map((playerId) => [
    playerId,
    replacementIds.has(playerId) && postResolution[playerId]
      ? postResolution[playerId].trim()
      : joinNarrativeParts([preliminary[playerId], postResolution[playerId]])
  ]).filter(([, content]) => content));
}

function privatePlayerIdsForResolutionRun(db: AppDatabase, resolutionRun: TurnResolutionRun): string[] {
  return Array.from(new Set(resolutionRun.diceLogs.flatMap((diceLog) => {
    if (diceLog.isPublic || !diceLog.characterId) return [];
    const playerId = playerIdForCharacter(db, resolutionRun.roomId, diceLog.characterId);
    return playerId ? [playerId] : [];
  })));
}

export function buildPostResolutionNarrationPrompt(
  originalPrompt: string,
  preliminaryResult: AiTurnResult,
  resolutionRun: TurnResolutionRun,
  privatePlayerIds: string[]
): string {
  const sections = buildResolutionNarrationSections(resolutionRun);
  return [
    originalPrompt,
    '',
    '## Authoritative System Dice Results',
    sections.publicDiceBlock || '- No public dice results.',
    sections.hiddenObjectiveDiceBlock ? `\nDM-only hidden dice:\n${sections.hiddenObjectiveDiceBlock}` : '',
    privatePlayerIds.length > 0 ? `\nPrivate result target playerIds: ${privatePlayerIds.join(', ')}` : '',
    '',
    '## Preliminary AI JSON Before Dice',
    JSON.stringify({
      ...preliminaryResult,
      diceResults: resolutionRun.diceLogs
    }, null, 2),
    '',
    '## Rewrite Task',
    'The preliminary JSON requested system dice. The dice above are now authoritative and must not be rerolled.',
    'Return a complete AiTurnResult JSON object for the final post-roll outcome.',
    'Write publicLog as ONLY the post-roll consequence narrative; do not repeat the pre-roll narration and do not repeat the dice summary block.',
    'For a normal multi-player action round, write publicLog as 500-900 Chinese characters in 2-4 readable scene paragraphs; keep it under 500 only for a single brief question, waiting/skip, or very small transition.',
    'Narrative voice: write publicLog and objectiveLog in third person or objective narration, not default second-person "you/you all" narration. Write privateUpdatesByPlayer in second person for the target player.',
    'If the authoritative dice result is DM-only hidden or character-private, put that consequence in privateUpdatesByPlayer for the listed target playerIds and leave publicLog empty unless other characters can directly see, hear, or be told that consequence.',
    'Write objectiveLog as ONLY DM-facing post-roll consequences, including hidden truths that are justified by the actual dice results.',
    'privateUpdatesByPlayer should contain only post-roll private consequences, keyed by playerId.',
    'diceRequests must be []; do not request additional dice in this rewrite.',
    'Preserve or update interactionRequests, suggestedStateChanges, and characterResourceChanges according to the actual dice result.',
    'Return strict JSON only. Never include markdown fences.'
  ].filter(Boolean).join('\n');
}

export function combinePostResolutionResult(
  db: AppDatabase,
  preliminaryResult: AiTurnResult,
  postResolutionResult: AiTurnResult,
  resolutionRun: TurnResolutionRun
): AiTurnResult {
  const sections = buildResolutionNarrationSections(resolutionRun);
  const privatePlayerIds = privatePlayerIdsForResolutionRun(db, resolutionRun);
  const postResolutionPublicLog = postResolutionResult.publicLog.trim();
  const postResolutionPrivateUpdates = { ...postResolutionResult.privateUpdatesByPlayer };

  return {
    ...postResolutionResult,
    publicLog: postResolutionPublicLog || sections.publicDiceBlock || preliminaryResult.publicLog,
    objectiveLog: joinNarrativeParts([
      postResolutionResult.objectiveLog || postResolutionResult.publicLog || preliminaryResult.objectiveLog || preliminaryResult.publicLog,
      sections.objectivePublicDiceBlock,
      sections.hiddenObjectiveDiceBlock
    ]),
    privateUpdatesByPlayer: mergePrivateNarratives(
      preliminaryResult.privateUpdatesByPlayer,
      postResolutionPrivateUpdates,
      privatePlayerIds
    ),
    diceRequests: preliminaryResult.diceRequests ?? [],
    diceResults: resolutionRun.diceLogs
  };
}

function narrativeMentionsResourceImpact(result: AiTurnResult, change: NonNullable<AiTurnResult['characterResourceChanges']>[number]): boolean {
  const text = [
    result.publicLog,
    result.objectiveLog ?? '',
    ...Object.values(result.privateUpdatesByPlayer),
    change.reason,
    ...(change.ruleRefs ?? [])
  ].join('\n');
  return /(伤害|受伤|中箭|命中|扣血|失去\s*\d*\s*(?:hp|HP|生命)|治疗|恢复|回复|healing|damage|hit points?|hp)/i.test(text);
}

function collectUnconfirmedResourceConflicts(
  result: AiTurnResult,
  confirmedCharacterResourceChangeIndexes: number[]
): string[] {
  const confirmed = new Set(confirmedCharacterResourceChangeIndexes);
  return (result.characterResourceChanges ?? []).flatMap((change, index) => {
    if (confirmed.has(index)) return [];
    if (!change.path.startsWith('hitPoints.')) return [];
    if (!narrativeMentionsResourceImpact(result, change)) return [];
    return [`characterResourceChanges[${index}] 描述了 HP/伤害/治疗相关结果但未被确认。为避免剧情和角色状态不一致，请确认该资源变更，或重新生成/编辑 AI 结果。`];
  });
}

async function completePostResolutionNarration(
  db: AppDatabase,
  aiProvider: ReturnType<typeof createAiProviderFromConfig>,
  originalPrompt: string,
  preliminaryResult: AiTurnResult,
  resolutionRun: TurnResolutionRun,
  warnings: string[]
): Promise<AiTurnResult> {
  if (!preliminaryResult.diceRequests || preliminaryResult.diceRequests.length === 0 || resolutionRun.diceLogs.length === 0) {
    return preliminaryResult;
  }

  try {
    const privatePlayerIds = privatePlayerIdsForResolutionRun(db, resolutionRun);
    const postResolutionPrompt = buildPostResolutionNarrationPrompt(originalPrompt, preliminaryResult, resolutionRun, privatePlayerIds);
    const postResolutionResult = await aiProvider.generateTurnResult(postResolutionPrompt);
    return combinePostResolutionResult(db, preliminaryResult, postResolutionResult, resolutionRun);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`系统骰点后续剧情补全失败，已保留原始 AI 结果和骰点摘要：${message}`);
    return preliminaryResult;
  }
}

export async function createAiTurnPreview(db: AppDatabase, roomId: string): Promise<AiTurnPromptPreviewResponse> {
  recoverReadyTurnAfterApplyFailure(db, roomId);
  const room = getRoom(db, roomId);
  if (!room) throw new AiTurnWorkflowHttpError(404, { error: 'Room not found' });

  assertTurnReadyForAi(db, room);

  const { preview, context } = await buildRoomPromptPreview(db, room);
  const characterStatus = loadCharacterStatusSection(db, room.id);
  const { flatPrompt, contextSections } = buildAiTurnDebugPrompt(room, preview, context, characterStatus);
  const previewId = nanoid();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO ai_turn_previews (
      id, room_id, turn_id, original_prompt, suggested_state_changes_json, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(previewId, room.id, context.turn?.id ?? null, flatPrompt, '[]', 'previewed', now);

  return {
    previewId,
    roomId: room.id,
    turnId: context.turn?.id ?? null,
    flatPrompt,
    messages: [{ role: 'user', content: flatPrompt }],
    contextSections,
    warnings: preview.warnings
  };
}

export async function sendAiTurnPreview(db: AppDatabase, input: { roomId: string; previewId: string; flatPrompt: string }): Promise<AiTurnPromptSendResponse> {
  const previewRow = db.prepare('SELECT id, room_id as roomId, turn_id as turnId FROM ai_turn_previews WHERE id = ? AND room_id = ?')
    .get(input.previewId, input.roomId) as { id: string; roomId: string; turnId: string | null } | undefined;
  if (!previewRow) throw new AiTurnWorkflowHttpError(404, { error: 'Prompt preview not found' });

  const room = getRoom(db, input.roomId);
  if (!room) throw new AiTurnWorkflowHttpError(404, { error: 'Room not found' });

  recoverReadyTurnAfterApplyFailure(db, input.roomId, previewRow.turnId);
  assertPreviewMatchesCurrentReadyTurn(db, room, previewRow.turnId);

  const { context } = await buildRoomPromptPreview(db, room);
  const { turn, players } = context;
  if (!turn) throw new AiTurnWorkflowHttpError(409, { error: 'Current turn not found' });
  const narrativeLengthLimits = parseNarrativeLengthLimitsFromPromptBlocks(context.promptBlocks);

  const providerConfig = getGlobalAiProviderConfig(db);
  const sentAt = new Date().toISOString();
  let aiProviderName: string = providerConfig.provider;
  try {
    const aiProvider = createAiProviderFromConfig(providerConfig, getGlobalRuntimeSettings(db));
    aiProviderName = aiProvider.name;
    const preliminaryResult = await aiProvider.generateTurnResult(input.flatPrompt);
    const routingWarnings = [
      ...collectPrivateUpdateRoutingWarnings(players, preliminaryResult.privateUpdatesByPlayer),
      ...collectInteractionRoutingWarnings(players, preliminaryResult.interactionRequests),
      ...collectDiceRequestRoutingWarnings(db, room.id, preliminaryResult.diceRequests ?? [])
    ];
    const resolutionRun = createTurnResolutionRun(db, {
      previewId: input.previewId,
      roomId: room.id,
      turnId: turn.id,
      result: preliminaryResult,
      seed: `${room.id}:${turn.id}:${input.previewId}`
    });
    const postResolutionWarnings: string[] = [];
    const resolvedResult = await completePostResolutionNarration(
      db,
      aiProvider,
      input.flatPrompt,
      preliminaryResult,
      resolutionRun,
      postResolutionWarnings
    );
    const rewriteWarnings: string[] = [];
    const rewriteOverrides = buildRewriteOverridesFromDb(db);
    const result = await rewritePublicLog(aiProvider, input.flatPrompt, resolvedResult, rewriteWarnings, rewriteOverrides);
    const suggestedStateChanges = normalizeSuggestedStateChanges(result);
    const warnings = [
      ...validateAiTurnResultLengthWarnings(result, narrativeLengthLimits),
      ...routingWarnings,
      ...collectPrivateUpdateRoutingWarnings(players, result.privateUpdatesByPlayer),
      ...collectInteractionRoutingWarnings(players, result.interactionRequests),
      ...postResolutionWarnings,
      ...rewriteWarnings
    ];
    db.prepare(`
      UPDATE ai_turn_previews
      SET edited_prompt = ?, response_text = ?, suggested_state_changes_json = ?, raw_json = ?, status = ?, error_message = NULL, sent_at = ?, resolution_run_id = ?
      WHERE id = ?
    `).run(
      input.flatPrompt,
      result.publicLog,
      JSON.stringify(suggestedStateChanges),
      JSON.stringify(result),
      'sent',
      sentAt,
      resolutionRun.id,
      input.previewId
    );

    return {
      responseText: result.publicLog,
      suggestedStateChanges,
      raw: result,
      applied: false,
      resourceErrors: [],
      warnings: Array.from(new Set([...warnings, ...resolutionRun.warnings])),
      resolutionRunId: resolutionRun.id,
      seed: resolutionRun.seed,
      resolutionEvents: resolutionRun.events
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    db.prepare(`
      UPDATE ai_turn_previews
      SET edited_prompt = ?, status = ?, error_message = ?, sent_at = ?
      WHERE id = ?
    `).run(input.flatPrompt, 'failed', message, sentAt, input.previewId);
    throw new AiTurnWorkflowHttpError(502, { error: message });
  }
}

export async function applyAiTurnPreview(db: AppDatabase, input: AiTurnApplyInput): Promise<AiTurnPromptSendResponse> {
  const previewRow = db.prepare('SELECT id, room_id as roomId, turn_id as turnId, raw_json as rawJson, status, resolution_run_id as resolutionRunId FROM ai_turn_previews WHERE id = ? AND room_id = ?')
    .get(input.previewId, input.roomId) as { id: string; roomId: string; turnId: string | null; rawJson: string | null; status: string; resolutionRunId: string | null } | undefined;
  if (!previewRow) throw new AiTurnWorkflowHttpError(404, { error: 'Prompt preview not found' });
  if (previewRow.status !== 'sent' || !previewRow.rawJson) {
    throw new AiTurnWorkflowHttpError(409, { error: 'AI_RESULT_NOT_READY', message: 'AI 结果尚未生成，不能应用。' });
  }
  if (!previewRow.resolutionRunId) {
    throw new AiTurnWorkflowHttpError(409, { error: 'RESOLUTION_RUN_NOT_READY', message: '系统结算预览尚未生成，不能应用。请重新发送 AI 预览。' });
  }
  const resolutionRun = loadTurnResolutionRun(db, previewRow.resolutionRunId);
  if (!resolutionRun || resolutionRun.status !== 'previewed') {
    throw new AiTurnWorkflowHttpError(409, { error: 'RESOLUTION_RUN_NOT_READY', message: '系统结算预览不可应用或已应用。请重新生成 AI 预览。' });
  }

  const room = getRoom(db, input.roomId);
  if (!room) throw new AiTurnWorkflowHttpError(404, { error: 'Room not found' });

  recoverReadyTurnAfterApplyFailure(db, input.roomId, previewRow.turnId);
  assertPreviewMatchesCurrentReadyTurn(db, room, previewRow.turnId);

  const { context } = await buildRoomPromptPreview(db, room);
  const { turn, players, actions, ruleMatches } = context;
  if (!turn) throw new AiTurnWorkflowHttpError(409, { error: 'Current turn not found' });
  const narrativeLengthLimits = parseNarrativeLengthLimitsFromPromptBlocks(context.promptBlocks);

  const providerConfig = getGlobalAiProviderConfig(db);
  const providerName = providerConfig.provider;
  try {
    const result = validateAiTurnResult(JSON.parse(previewRow.rawJson), { strictRequiredFields: true });
    const preflightErrors = [
      ...collectUnconfirmedResourceConflicts(result, input.confirmedCharacterResourceChangeIndexes),
      ...collectResourcePatchPreflightErrors(
        db,
        room.id,
        (result.characterResourceChanges ?? []).filter((_change, index) => input.confirmedCharacterResourceChangeIndexes.includes(index))
      )
    ];
    if (preflightErrors.length > 0) {
      throw new AiTurnWorkflowHttpError(409, {
        error: 'AI_RESOURCE_CONFLICT',
        message: preflightErrors.join('\n'),
        resourceErrors: preflightErrors
      });
    }
    if (!claimRoomTurnForProcessing(db, input.roomId, turn.id)) {
      throw new AiTurnWorkflowHttpError(409, { error: 'Turn is already processing or no longer open' });
    }
    const materializedResult = buildConfirmedAiTurnResult(
      result,
      input.confirmedSuggestedStateChangeIndexes,
      input.confirmedCharacterResourceChangeIndexes
    );
    const suggestedStateChanges = normalizeSuggestedStateChanges(result);
    const { resourceErrors, warnings } = materializeAiTurnResult(db, {
      room,
      turn,
      players,
      actions,
      result: materializedResult,
      resolutionRun,
      providerName,
      inputSummary: `Applied preview for ${actions.length} actions`,
      ruleMatches,
      narrativeLengthLimits
    });
    const response: AiTurnPromptSendResponse = {
      responseText: result.publicLog,
      suggestedStateChanges,
      raw: result,
      applied: true,
      resourceErrors,
      warnings,
      resolutionRunId: resolutionRun.id,
      seed: resolutionRun.seed,
      resolutionEvents: resolutionRun.events
    };
    publishRoomUpdate(input.roomId);
    return response;
  } catch (error) {
    if (error instanceof AiTurnWorkflowHttpError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      db.prepare('UPDATE rooms SET status = ? WHERE id = ?').run('ready_to_resolve', input.roomId);
      db.prepare('UPDATE turns SET status = ?, ended_at = NULL WHERE id = ?').run('ready_to_resolve', turn.id);
      db.prepare('UPDATE ai_turn_previews SET error_message = ? WHERE id = ?').run(message, input.previewId);
      db.prepare('INSERT INTO ai_generations (id, room_id, turn_id, provider, input_summary, output, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(nanoid(), input.roomId, turn.id, providerName, `Failed applying preview for ${actions.length} actions`, previewRow.rawJson ?? '', message, now);
    });
    tx();
    publishRoomUpdate(input.roomId);
    throw new AiTurnWorkflowHttpError(500, { error: message });
  }
}
