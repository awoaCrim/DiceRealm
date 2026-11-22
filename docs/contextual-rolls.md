# 按需投掷协议

玩家提出行动，后端判断是否需要投掷。需要时先保存待投掷请求并通知原玩家；玩家明确确认后，后端才生成骰点、结算并保存。任务、目标、已知信息与角色数值始终是后端投影，客户端没有自由记账或任意掷骰入口。

2026-11-03 U1源码（待验收）：本人投掷在收到已确认的保存回执后，短暂展示d20转动、实际骰面及取用值，再显示加值和原结果。消息流的新增检定使用同一演出；历史/重复回执不重播，点击或按键可跳过，“减少动画”关闭演出。2026-11-04验收修正：同批检定后面的叙事等骰子及成败完整显示后再开始；跳过骰子启动后续叙事，减少动画全部立即显示。成功/失败使用不同状态色，自然20/1强调取用骰子和结果行；自然20但服务器判失败仍显示失败色，不在客户端改判。

## 玩家与主持流程

1. Unity 的新行动提交到 `POST /api/v1/campaigns/{id}/actions/propose`。字段仍为 `{requestId,expectedVersion,kind,target,text}`；按钮选项来自当前快照，未知自由行动仍进入主持裁定。
2. 不含骰子的行动直接执行。需要投掷时返回 `resolution.status=awaiting_roll` 和本席位的 `snapshot.pendingRoll`。此时只保存请求/事件/回执并推进版本，不产生骰点、角色消耗、时间或剧情后果。
3. 本人新的有效投掷自动打开一次，不必先点入口；业务同意状态尚未读到或前序战斗仍在呈现时延后打开。关闭或 Esc 只是收起，轮询不会重新打开同一请求，可从正文旁「投掷」恢复。确认或明确放弃分别提交同一受限协议；发送之前持久保存端点与原请求。
4. 主持使用 `/rulings/respond`（与原 `/rulings/resolve` 相同字段，另可带可选 `privateText`，仅原行动者与主持可见；取消主持要求的投掷时一并清空）要求检定。条件、理由和来源由主持明确填写；检定尚未发生时，裁定为 `awaiting_roll`，工作台单独显示等待原玩家，不提供第二份处理表单。原玩家确认后才记录结果并进入后果处理；取消退回待主持回应。
5. 状态导致的自动豁免失败没有骰子，沿用原规则直接保存，不显示虚假的投掷确认。敌人回合及机会攻击沿用已有自动结算，不要求玩家替敌人确认。

自然行动的解释仍是玩家提交行动时的既有能力；解析结果保存在后端，确认投掷不会重新解释。实际执行与叙事复用原行动链，没有试掷或客户端规则计算。

## 字段与权限

所有路径均以 `/api/v1/campaigns/{id}` 为前缀，要求席位 bearer；主持回应另需主持权限。

```json
{
  "requestId": "UUID",
  "expectedVersion": 8,
  "rollId": "后端返回的待投掷 ID",
  "decision": "roll"
}
```

`POST /rolls/respond` 仅接受以上字段；`decision` 为 `roll` 或 `cancel`。不能传 actor、DC、骰点、加值、属性、目标或新的行动。响应仍为 `{snapshot,resolution,replayed}`。

`snapshot.pendingRoll` 可空；存在时形状为 `{id,label,description,version,available,reason,battleSessionId?,preview?}`，只公开当前认证席位的待投掷。可选 `preview` 为 `{ability,skill,testKind,modifier,mode,hasDc,dc,opposed,difficultyClasses?}`，由服务端只读投影当前场景/主持/作者检定，以及标准战斗搜寻、急救、区域/专注/死亡豁免；复用实际规则的修正与优势/劣势，不产生骰点。对抗检定保留 `hasDc=false,dc=0,opposed=true`，新式预览以`difficultyClasses`显示实际去重阈值（如16 / 20），结果DiceCheck带同一数组，不合并为虚构单个DC、不披露目标。v0..49场景检定及旧结果没有数组时仍未知；上下文过期或暂不支持的多骰动作不提供预览。客户端不从中文描述提取DC或猜修正。私有 continuation（原请求、已解析意图、主持检定条件）持久保存在战役，不由客户端回传。`Resolution.rollId` 关联请求及结果。旧存档缺少 `pendingRolls` 按空列表处理；没有更换数据库版本。

开始、确认、取消均先在已授权聚合锁内检查本席位回执。相同 ID/内容重放原结果和当前快照；不同内容冲突。未知字段由严格 JSON 边界拒绝。确认的新请求既检查 `expectedVersion`，也检查保存的投掷上下文版本；改成最新版本不能强行继续旧投掷。明确取消可在当前版本释放过期请求，不伪造失败结果，也不自动退款此前另一条施法命令已经支付的资源。

| 情况 | 行为 |
|---|---|
| 同请求确认、丢包、重启后重放 | 原结果；不重掷、不重复扣除 |
| 同 ID 不同内容 | `idempotency_conflict` |
| 请求版本旧 | `stale_version` |
| 投掷上下文已变化 | `roll_context_changed`，取消后重新选择 |
| 新行动/角色命令前仍有自己的待投掷 | `roll_pending` |
| 他人或已处理的投掷 | `roll_unavailable` |
| 已确认团队请求再次新确认 | `roll_already_confirmed` |

多人先攻为一个确认组：每位有效席位只确认自己；全员确认前不掷任何先攻、不开始战斗。组内确认会同步各成员的上下文版本，其他战役变更仍使组过期。最后一人确认后以原发起者权限执行已有遭遇逻辑；任一成员明确取消会取消整组，不产生部分先攻。

## 历史、界面与兼容

活动流以原行动为根，通过 `rollId` 更新等待、取消和最终结果；确认事件不重复成为另一条玩家行动。主持对较早行动的投掷回应仍回到该行动；原记录在快照尾部之外时读取精确 `/activity/{originSequence}`，不拼接另一条较新的行动结果。

角色查看与使用合并为一个窗口，详见 [角色使用](character-play.md)。技能/豁免与资源只读；物品 `use` 只执行服务端列出的 `execute` 效果；不受支持的物品 `use` 回到未发送的行动草稿，不预扣数量、不自动提交，装备、来源施法、准备和休整仍由后端结算。按需投掷窗口拥有最高的 Tab/Esc 层级，加载角色资料不能把它盖住。窗口采用集中骰子视觉，确认前显示权威预览与“未投掷”，未知响应显示原请求恢复；收到原 `rolls/respond` 的已确认结果后，复用 `StoryChatPresentation.PresentRoll` 展示真实总值、骰点/修正、结果及DC。攻击显示本人的权威命中、骰点与伤害；死亡豁免保留`combatLog[].check`中的骰面、修正、总值，并同窗显示成功/失败累计或自然20恢复1生命的后果，`skill=Death Saving Throw`且ability为空仍是有效结果。没有单骰结果时显示本人的简短结构化战斗记录，不把整批NPC技术日志塞入窗口。继续按钮只收窗，模型自动接续可在后台进行；读者关闭当前结果后才接下一个等待，关闭等待窗后迟到结果不抢开窗口。仅轮询发现pending消失不能制造一个结果页。投掷是唯一显著主操作，放弃为次要文字操作；正常等待不再在正文重复生成机制说明。

旧 `/actions`、`/rulings/resolve` 和 `character/commands` 的 `check/spend/consume` 保留已有客户端及持久请求兼容，指纹规则不变；新 Unity/工作台不再生成这些自由检定/补账请求。不要将旧待确认请求迁移到新端点重放。

客户端与服务端需成对升级；新客户端依赖新增端点。回滚须使用升级前的完整数据备份与原包配对；旧版本不能处理新 continuation，也不能覆盖升级后新产生的进度。

## 实现与测试

- 后端：[ContextualRolls](../server/DiceRealm.Server/Domain/ContextualRolls.cs)、[ContextualRollService](../server/DiceRealm.Server/Application/ContextualRollService.cs)、[GameService](../server/DiceRealm.Server/Application/GameService.cs)、[RulingEngine](../server/DiceRealm.Server/Domain/RulingEngine.cs)。
- Unity：ContextualRollPanel、StoryFlowPresentation；工作台：[回应表单](../client-workbench/src/ruling-editor.js)。
- [HTTP 回归](../tests/DiceRealm.Tests/ContextualRollTests.cs) 检查请求前零骰/零消耗、重放/重启/并发、跨席位、上下文变化、取消、原主持归属、团队先攻与生命骰。
- Unity 回归 检查真实 JSON null、权威预览/无DC、确认与结果分离、关闭/迟到响应/新等待、请求恢复及原行动关联；[工作台回归](../client-workbench/tests/contextual-roll.test.js) 检查新端点与等待状态。

错误做法：先执行并掷骰，再弹窗让玩家「确认投掷」。正确做法：先保存未执行 continuation；用户确认后执行一次，重试只读原回执。
