import type { AiPrompt, Authority, ContextBlock, ContextTrace, ContextVisibility } from '@dnd/contracts';
import type { QueryExecutor } from '../../platform/database/DatabasePort.js';
import { CharacterRepository } from '../characters/CharacterRepository.js';
import { TurnRepository } from '../turns/TurnRepository.js';
import { WorldFactRepository } from '../world/WorldFactRepository.js';
import { CombatRepository } from '../combat/CombatRepository.js';

const TURN_RESOLUTION_JSON_TEMPLATE = JSON.stringify({
  publicNarrative: '非空公开叙事',
  privateUpdates: [],
  diceResults: [],
  stateChanges: [],
  interactionRequests: [],
  worldFactCreations: [],
  encounterStarts: [],
}, null, 2);

const TURN_RESOLUTION_OUTPUT_INSTRUCTIONS = [
  '输出格式是强制契约：只返回一个 JSON 对象。',
  '不要输出解释、前后缀、Markdown 或 ``` 代码围栏。',
  '必须包含以下完整顶层模板；除 publicNarrative 外，没有条目时使用空数组 []：',
  TURN_RESOLUTION_JSON_TEMPLATE,
  'privateUpdates 每项为 { playerId, content }。',
  'diceResults 每项为 { id, formula, total, visibility, targetPlayerId }。',
  'stateChanges 每项为 { kind, targetId, patch, visibility }，只能修改上下文中已有的稳定 id。',
  'interactionRequests 每项为 { id, targetPlayerId, prompt }。',
].join('\n');

const SYSTEM_INSTRUCTIONS = [
  '你是 DND AI 地城主持人。只消费给定上下文，不得自行补写未提供的玩家行动或角色状态。',
  'privateUpdates 的 playerId 与 diceResults 的 targetPlayerId 必须使用用户消息“已批准角色状态”中的真实 playerId。',
  'worldFactCreations / encounterStarts 的 knownBy / targetPlayerId / characterId 同样必须使用真实成员或已批准角色 id；新创建条目的 id 由服务端生成，同一份结算内禁止引用尚未落库的新 id；骰子与先攻由服务端权威掷出，不要自报。',
  TURN_RESOLUTION_OUTPUT_INSTRUCTIONS,
].join('\n');

export interface AiContextBuildOptions {
  /** Context audience is independent from persisted turn-entry Visibility. */
  audience?: ContextVisibility;
  /** Required when constructing an actor-specific context. */
  actorId?: string;
  /** Stable logical action identity; current turn is the Phase 1 aggregate. */
  actionId?: string;
}

export interface AiContextPackage {
  prompt: AiPrompt;
  /** 结构化 owner-safe context，由 claim 写入 context_json（与 prompt 一起）供 owner 调试；不含敏感字段。 */
  context: Record<string, unknown>;
  blocks: ContextBlock[];
  trace: ContextTrace;
}

/**
 * Deterministic context filtering. Permission is evaluated before rendering;
 * a denied block can therefore never reach Provider messages.
 */
export function filterContextBlocks(
  blocks: readonly ContextBlock[],
  audience: ContextVisibility,
  actionId: string,
  actorId?: string,
  actorPrivateSourceRefs?: ReadonlySet<string>,
): { blocks: ContextBlock[]; trace: ContextTrace } {
  const included: ContextBlock[] = [];
  const entries = [] as ContextTrace['entries'];
  for (const block of blocks) {
    const allowed = isAudienceAllowed(block.visibility, audience)
      && (block.visibility !== 'actor_private'
        || audience === 'gm_only'
        || Boolean(actorId && (block.audienceActorIds?.includes(actorId) || actorPrivateSourceRefs?.has(block.sourceRefs[0]))));
    included.push(...(allowed ? [block] : []));
    for (const sourceRef of block.sourceRefs) {
      entries.push({
        actionId,
        blockId: block.id,
        sourceRef,
        included: allowed,
        reason: allowed ? (block.priority === 'P0' ? 'required' : 'scope_match') : 'visibility_denied',
        estimatedTokens: block.estimatedTokens,
      });
    }
  }
  return { blocks: included, trace: { actionId, entries } };
}

/** Pure renderer: it does not perform permission checks or read the database. */
export function renderContextBlocks(
  campaignId: string,
  characters: Array<{ id: string; playerId: string; name: string }>,
  blocks: readonly ContextBlock[],
): AiPrompt {
  const system = blocks.find((block) => block.type === 'system_policy');
  const userBlocks = blocks.filter((block) => block.type !== 'system_policy');
  return {
    campaignId,
    audience: 'owner_only',
    characters,
    messages: [
      // If the system policy is denied for an actor-scoped context, keep the
      // required single system message empty instead of injecting untraced
      // policy text that was absent from ContextTrace.
      { role: 'system', content: system?.content ?? '' },
      { role: 'user', content: userBlocks.map((block) => block.content).join('\n') },
    ],
  };
}

export class AiContextBuilder {
  constructor(private readonly executor: QueryExecutor) {}

  /** claim tx 内调用时传入 tx，保证 context 快照与 claim 写入使用同一事务执行器。 */
  async buildForTurn(
    campaignId: string,
    turnId: string,
    executor: QueryExecutor = this.executor,
    options: AiContextBuildOptions = {},
  ): Promise<AiContextPackage> {
    const campaign = (await executor.query<{ id: string; name: string; ruleset: string; status: string }>(
      'SELECT id, name, ruleset, status FROM campaigns WHERE id = ?', [campaignId],
    ))[0];
    if (!campaign) throw new Error('campaign not found');
    const turns = new TurnRepository(executor);
    const characters = new CharacterRepository(executor);
    const facts = new WorldFactRepository(executor);
    const turn = (await turns.findTurnById(turnId));
    if (!turn) throw new Error('turn not found');
    const actions = await turns.listActionsByTurn(turnId);
    const approved = (await characters.listByCampaign(campaignId))
      .filter((row) => row.status === 'approved')
      .map((row) => ({
        id: row.id, playerId: row.player_id, name: row.name,
        sheet: JSON.parse(row.sheet_json) as Record<string, unknown>,
        derived: JSON.parse(row.derived_json) as Record<string, unknown>,
      }));
    const allFacts = (await facts.listByCampaign(campaignId)).map((row) => ({
      id: row.id, title: row.title, kind: row.kind, content: row.content,
      visibility: row.visibility, knownBy: JSON.parse(row.known_by_json) as string[],
    }));

    // 战斗摘要：当前 active/preparation encounter 的 owner 投影（owner 可见全部 unsuperseded 战斗员，
    // player HTTP/SSE 投影规则不得反向污染 DM 上下文）。
    const combatRepo = new CombatRepository(executor);
    const encounters = await combatRepo.listEncountersByCampaign(campaignId);
    const combat = await Promise.all(encounters.map(async (encounter) => {
      const combatants = await combatRepo.listCombatantsByEncounter(encounter.id);
      return {
        id: encounter.id,
        name: encounter.name,
        status: encounter.status,
        round: encounter.round,
        activeCombatantId: encounter.active_combatant_id,
        combatants: combatants.map((c) => ({
          id: c.id, name: c.name, visibility: c.visibility, targetPlayerId: c.target_player_id,
          hpCurrent: c.hp_current, hpMax: c.hp_max, ac: c.ac,
          initiative: c.initiative, initiativeBonus: c.initiative_bonus,
          conditions: JSON.parse(c.conditions_json) as string[],
        })),
      };
    }));

    const audience = options.audience ?? 'gm_only';
    const actionId = options.actionId ?? turnId;
    const sourceBlocks: ContextBlock[] = [
      makeBlock('system-policy', 'system_policy', SYSTEM_INSTRUCTIONS, ['system:runtime-contract'], 'system', 'server_only', 'P0'),
      makeBlock('ruleset-policy', 'ruleset_policy', `规则集身份：${campaign.ruleset}`, [`ruleset:${safeRefPart(campaign.ruleset)}`], 'ruleset', 'campaign', 'P0'),
      makeBlock('campaign-runtime', 'campaign_runtime', `战役：${campaign.name}（规则集 ${campaign.ruleset}）\n战役状态：${campaign.status}`, [`campaign:${campaignId}`], 'campaign', 'campaign', 'P0'),
      makeBlock('turn-runtime', 'scene_state', `当前回合 #${turn.number}，已锁定。`, [`turn:${turnId}`], 'scene', 'party', 'P0'),
      ...actions.map((action) => makeBlock(
        `recent-action-${action.id}`,
        'recent_action',
        `玩家行动：\n- ${action.player_id}: ${action.body}`,
        [`action:${action.id}`],
        'actor',
        'actor_private',
        'P0',
        [action.player_id],
      )),
      makeBlock(
        'approved-character-roster',
        'actor_state',
        ['已批准角色：', ...approved.map((c) => `- ${c.name} (${c.playerId})`)].join('\n'),
        approved.length > 0 ? approved.map((c) => `character:${c.id}`) : [`campaign:${campaignId}`],
        'actor',
        'party',
        'P0',
      ),
      ...approved.map((character) => makeBlock(
        `approved-character-${character.id}`,
        'actor_state',
        `角色状态：\n- ${character.name} (${character.playerId}): ${JSON.stringify(character.sheet)}`,
        [`character:${character.id}`],
        'actor',
        'actor_private',
        'P1',
        [character.playerId],
      )),
      ...allFacts.map((fact) => makeBlock(
        `world-fact-${fact.id}`,
        fact.visibility === 'player_private' ? 'actor_knowledge' : 'scene_state',
        `活跃世界事实：\n- [${fact.visibility}] ${fact.title}: ${fact.content}`,
        [`world-fact:${fact.id}`],
        fact.visibility === 'owner_only' ? 'gm' : 'world',
        fact.visibility === 'owner_only' ? 'gm_only' : fact.visibility === 'player_private' ? 'actor_private' : 'public',
        fact.visibility === 'owner_only' ? 'P1' : 'P2',
        fact.visibility === 'player_private' ? fact.knownBy : undefined,
      )),
      ...combat.map((encounter) => makeBlock(
        `encounter-${encounter.id}`,
        'scene_state',
        `当前战斗（owner 视角）：\n- ${encounter.name} [${encounter.status}] 回合${encounter.round} 行动者${encounter.activeCombatantId ?? '无'}: ${encounter.combatants.map((c) => `${c.name}(${c.hpCurrent}/${c.hpMax} hp, ${c.initiative ?? '未掷先攻'})`).join(', ')}`,
        [`encounter:${encounter.id}`], 'scene', 'gm_only', 'P1',
      )),
      makeBlock('resolution-contract', 'resolution_contract', [
        '请严格按照 system 消息中的完整 JSON 模板输出结构化结算。',
        '可选世界创建 worldFactCreations：每条 { title, kind, content, visibility, knownBy }；player_private 必须给出 knownBy 为上面已批准角色里的真实成员 playerId，public/owner_only 留空。',
        '可选战斗发起 encounterStarts：每条 { name, combatants, rollInitiative }；combatants 每项 { name, characterId, initiativeBonus, hpCurrent, hpMax, ac, conditions, visibility, targetPlayerId }；characterId 只能引用上面已批准角色列表中的 id（非玩家 NPC 为 null）；player_private 战斗员必须给出 targetPlayerId 为真实成员 playerId，public/owner_only 为 null。',
        '所有新创建的事实/遭遇/战斗员 id 都由服务端生成：不要在输出里写任何 id；同一份结算内不得引用你刚创建的事实/遭遇/战斗员 id（stateChanges 只能指向已有的稳定 id）。',
        '骰子（先攻/攻击/豁免/伤害）由服务端权威掷出：AI 发起遭遇时 rollInitiative 默认 true，服务端会在结算事务内掷先攻并排定行动顺序，不要输出战斗员 initiative 值。',
      ].join('\n'), ['system:resolution-contract'], 'system', 'server_only', 'P0'),
    ];
    const actorPrivateRefs = new Set(
      allFacts.filter((fact) => options.actorId && fact.knownBy.includes(options.actorId))
        .map((fact) => `world-fact:${fact.id}`),
    );
    const filtered = filterContextBlocks(sourceBlocks, audience, actionId, options.actorId, actorPrivateRefs);
    const visibleFacts = allFacts.filter((fact) => {
      const visibility = persistedToContextVisibility(fact.visibility);
      const actorScopedAllowed = visibility !== 'actor_private'
        || audience === 'gm_only'
        || Boolean(options.actorId && fact.knownBy.includes(options.actorId));
      return isAudienceAllowed(visibility, audience) && actorScopedAllowed;
    });
    // Keep the long-standing owner-safe context shape for existing Owner tooling,
    // while adding structured blocks/trace as a separate boundary.
    const visibleActions = audience === 'gm_only'
      ? actions
      : actions.filter((action) => Boolean(options.actorId && action.player_id === options.actorId));
    const visibleCharacters = audience === 'gm_only'
      ? approved
      : approved.filter((character) => Boolean(options.actorId && character.playerId === options.actorId));
    const context = {
      campaignId,
      ruleset: campaign.ruleset,
      campaignStatus: campaign.status,
      turn: { id: turn.id, number: turn.number, status: turn.status },
      actions: visibleActions.map((a) => ({ playerId: a.player_id, body: a.body })),
      characters: visibleCharacters,
      worldFacts: visibleFacts,
      combat,
      blocks: filtered.blocks,
      trace: filtered.trace,
    };
    const prompt = renderContextBlocks(campaignId, approved.map((c) => ({ id: c.id, playerId: c.playerId, name: c.name })), filtered.blocks);
    return { prompt, context, blocks: filtered.blocks, trace: filtered.trace };
  }
}

function makeBlock(
  id: string,
  type: ContextBlock['type'],
  content: string,
  sourceRefs: string[],
  authority: Authority,
  visibility: ContextVisibility,
  priority: ContextBlock['priority'],
  audienceActorIds?: string[],
): ContextBlock {
  return {
    id, type, content, sourceRefs, authority, visibility, priority,
    ...(audienceActorIds && audienceActorIds.length > 0 ? { audienceActorIds: [...new Set(audienceActorIds)] } : {}),
    estimatedTokens: estimateTokens(content),
  };
}

function estimateTokens(content: string): number {
  // Conservative bounded approximation; no provider/tokenizer dependency in Phase 1.
  return Math.min(100000, Math.max(1, Math.ceil(content.length / 4)));
}

function safeRefPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 120) || 'unknown';
}

function persistedToContextVisibility(visibility: 'public' | 'player_private' | 'owner_only'): ContextVisibility {
  if (visibility === 'owner_only') return 'gm_only';
  if (visibility === 'player_private') return 'actor_private';
  return 'public';
}

function isAudienceAllowed(blockVisibility: ContextVisibility, audience: ContextVisibility): boolean {
  // The Provider call is made by the server, so server-only policy may be
  // included in any server-rendered actor/party context. GM-only content still
  // remains restricted to the GM audience, while actor/party contexts fail closed.
  if (blockVisibility === 'server_only') return true;
  if (audience === 'gm_only' || audience === 'server_only') return audience === 'server_only'
    ? false
    : true;
  if (blockVisibility === 'gm_only') return false;
  const rank: Record<ContextVisibility, number> = {
    actor_private: 1, party: 2, campaign: 3, public: 4,
    server_only: 0, gm_only: 0,
  };
  return rank[blockVisibility] >= rank[audience];
}

export { persistedToContextVisibility };
