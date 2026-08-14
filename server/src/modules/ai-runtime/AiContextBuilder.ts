import type { AiPrompt } from '@dnd/contracts';
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

export interface AiContextPackage {
  prompt: AiPrompt;
  /** 结构化 owner-safe context，由 claim 写入 context_json（与 prompt 一起）供 owner 调试；不含敏感字段。 */
  context: Record<string, unknown>;
}

export class AiContextBuilder {
  constructor(private readonly executor: QueryExecutor) {}

  /** claim tx 内调用时传入 tx，保证 context 快照与 claim 写入使用同一事务执行器。 */
  async buildForTurn(campaignId: string, turnId: string, executor: QueryExecutor = this.executor): Promise<AiContextPackage> {
    const campaign = (await executor.query<{ id: string; name: string; ruleset: string; status: string }>(
      'SELECT id, name, ruleset, status FROM campaigns WHERE id = ?', [campaignId],
    ))[0];
    const turns = new TurnRepository(executor);
    const characters = new CharacterRepository(executor);
    const facts = new WorldFactRepository(executor);

    const turn = (await turns.findTurnById(turnId))!;
    const actions = await turns.listActionsByTurn(turnId);
    const approved = (await characters.listByCampaign(campaignId))
      .filter((row) => row.status === 'approved')
      .map((row) => ({
        id: row.id, playerId: row.player_id, name: row.name,
        sheet: JSON.parse(row.sheet_json) as Record<string, unknown>,
        derived: JSON.parse(row.derived_json) as Record<string, unknown>,
      }));
    const activeFacts = (await facts.listByCampaign(campaignId)).map((row) => ({
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

    const context = {
      campaignId,
      ruleset: campaign.ruleset,
      campaignStatus: campaign.status,
      turn: { id: turn.id, number: turn.number, status: turn.status },
      actions: actions.map((a) => ({ playerId: a.player_id, body: a.body })),
      characters: approved,
      worldFacts: activeFacts,
      combat,
    };

    const userContent = [
      `战役：${campaign.name}（规则集 ${campaign.ruleset}）`,
      `当前回合 #${turn.number}，已锁定。玩家行动：`,
      ...actions.map((a) => `- ${a.player_id}: ${a.body}`),
      // 人读文本里的 playerId 用于叙事可读性，不是 provider 取 id 的来源；
      // provider/测试脚本一律读结构化 prompt.characters（见 Task 2 决策，杜绝文本解析脆弱性）。
      '已批准角色状态：',
      ...approved.map((c) => `- ${c.name} (${c.playerId}): ${JSON.stringify(c.sheet)}`),
      '活跃世界事实：',
      ...activeFacts.map((f) => `- [${f.visibility}] ${f.title}: ${f.content}`),
      '当前战斗（owner 视角）：',
      ...combat.map((e) => `- ${e.name} [${e.status}] 回合${e.round} 行动者${e.activeCombatantId ?? '无'}: ${e.combatants.map((c) => `${c.name}(${c.hpCurrent}/${c.hpMax} hp, ${c.initiative ?? '未掷先攻'})`).join(', ')}`),
      '请严格按照 system 消息中的完整 JSON 模板输出结构化结算。',
      '可选世界创建 worldFactCreations：每条 { title, kind, content, visibility, knownBy }；player_private 必须给出 knownBy 为上面已批准角色里的真实成员 playerId，public/owner_only 留空。',
      '可选战斗发起 encounterStarts：每条 { name, combatants, rollInitiative }；combatants 每项 { name, characterId, initiativeBonus, hpCurrent, hpMax, ac, conditions, visibility, targetPlayerId }；characterId 只能引用上面已批准角色列表中的 id（非玩家 NPC 为 null）；player_private 战斗员必须给出 targetPlayerId 为真实成员 playerId，public/owner_only 为 null。',
      '所有新创建的事实/遭遇/战斗员 id 都由服务端生成：不要在输出里写任何 id；同一份结算内不得引用你刚创建的事实/遭遇/战斗员 id（stateChanges 只能指向已有的稳定 id）。',
      '骰子（先攻/攻击/豁免/伤害）由服务端权威掷出：AI 发起遭遇时 rollInitiative 默认 true，服务端会在结算事务内掷先攻并排定行动顺序，不要输出战斗员 initiative 值。',
    ].join('\n');

    const prompt: AiPrompt = {
      campaignId,
      audience: 'owner_only',
      // 结构化成员表（id/playerId/name）：provider 与测试脚本直接读 prompt.characters，不解析人类 prompt 字符串。
      characters: approved.map((c) => ({ id: c.id, playerId: c.playerId, name: c.name })),
      // system 指令以唯一一条 role=system message 发送并持久化，避免 context_json 双份保存。
      messages: [{ role: 'system', content: SYSTEM_INSTRUCTIONS }, { role: 'user', content: userContent }],
    };
    return { prompt, context };
  }
}
