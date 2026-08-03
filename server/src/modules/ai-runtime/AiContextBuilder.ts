import type { AiPrompt } from '@dnd/contracts';
import type { QueryExecutor } from '../../platform/database/DatabasePort.js';
import { CharacterRepository } from '../characters/CharacterRepository.js';
import { TurnRepository } from '../turns/TurnRepository.js';
import { WorldFactRepository } from '../world/WorldFactRepository.js';

export interface AiContextPackage {
  prompt: AiPrompt;
  /** 结构化 owner-safe context，由 claim 写入 context_json（与 prompt 一起）供 owner 调试；不含敏感字段。 */
  context: Record<string, unknown>;
}

export class AiContextBuilder {
  constructor(private readonly executor: QueryExecutor) {}

  /** claim tx 内调用时传入 tx，保证 context 快照与行锁同一事务（Postgres 必须用 tx，不能用外层池连接）。 */
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

    const context = {
      campaignId,
      ruleset: campaign.ruleset,
      campaignStatus: campaign.status,
      turn: { id: turn.id, number: turn.number, status: turn.status },
      actions: actions.map((a) => ({ playerId: a.player_id, body: a.body })),
      characters: approved,
      worldFacts: activeFacts,
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
      '请输出结构化结算（publicNarrative / privateUpdates / diceResults / stateChanges / interactionRequests）。',
    ].join('\n');

    const prompt: AiPrompt = {
      campaignId,
      audience: 'owner_only',
      // 结构化成员表（id/playerId/name）：provider 与测试脚本直接读 prompt.characters，不解析人类 prompt 字符串。
      characters: approved.map((c) => ({ id: c.id, playerId: c.playerId, name: c.name })),
      system: '你是 DND AI 地城主持人。只消费给定上下文，不得自行补写未提供的玩家行动或角色状态。privateUpdates 的 key 与 diceResults 的 targetPlayerId 必须使用上面"已批准角色状态"中括号内的真实 playerId。',
      messages: [{ role: 'system', content: '你是 DND AI 地城主持人。只消费给定上下文，不得自行补写未提供的玩家行动或角色状态。privateUpdates 的 key 与 diceResults 的 targetPlayerId 必须使用上面"已批准角色状态"中括号内的真实 playerId。' }, { role: 'user', content: userContent }],
    };
    return { prompt, context };
  }
}
