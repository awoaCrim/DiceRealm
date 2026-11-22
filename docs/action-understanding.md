# 自然语言行动上下文与澄清

本页记录兼容的旧 `actions/interpret` / `intents/respond` 意图理解协议：即使只有一个候选也必须再次确认。**当前主输入**使用 `POST actions/input`，在同一输入框接续澄清、确认、投掷同意和角色重交，亦可产生非机械叙事与世界信息；字段与拒绝边界集中在 [输入驱动冒险协议](input-driven-adventure.md)。旧请求回执和指纹保持原样，不迁移到新端点。旧理解阶段不掷骰、不扣角色资源或推进冒险时间；模型调用可能使用文本额度。

本页不扩新 D&D 规则，不自动实现尚未支持的法术效果，不把叙事当作世界状态。

## API 与生命周期

所有路径相对 `/api/v1/campaigns/{id}`，需要当前席位 bearer。成功仍返回 `{snapshot,resolution,replayed}`，普通 JSON 请求上限仍为 16 KiB，未知字段拒绝。

`POST actions/interpret` 接收：

```json
{"requestId":"UUID","expectedVersion":7,"kind":"natural","target":"","text":"我想使用自己的能力调查这里"}
```

只允许 `kind=natural`、空 target。text 为非空、最长 1000 字符且不含控制字符。Unity 会先规范空白。命令保存自然意图根事件 `intent.request`；即使模型只提议一个操作，也需玩家确认，不直接执行。

`POST intents/respond` 接收：

```json
{"requestId":"UUID","expectedVersion":8,"intentId":"UUID","decision":"choose","optionId":"option-3","text":""}
```

- `choose`：只能提交当前意图提供的一个 optionId，text 必须为空。ID 没有可供客户端推导的规则含义，不发送操作参数或来源补丁。
- `clarify`：optionId 必须为空，text 非空且最长 1000 字符。累计最多三次补充，仍不能明确时进入主持裁定；第三次补充不再请求模型。
- `ruling` / `cancel`：optionId、text 均为空。前者保留原文与补充并进入已有裁定；后者放弃未执行意图。

快照新增可空 `pendingIntent`，只返回当前席位等待中的意图：

```text
id, text, question, source,
options[] = {id,label,category,details:{targetLabel,cost,range,note,unavailableReason}},
clarifications[] = {question,answer}, version, available, reason
```

候选最多六个；action 提议恰好一个。模型只看到经过裁剪的服务端候选，最多 32 个。可执行候选来自当前场景白名单及角色 sheet：装备、精确来源法术、物品使用请求、能力请求。不会提供任意属性检定、补记资源、消耗物品数量或准备清单编辑。

每个席位最多一个等待中的自然意图。命令在授权锁内先查询席位级回执；同请求同内容返回原判定和当前快照，不重新解释、掷骰或扣资源。旧 `actions`、`actions/propose`、`character/commands` 的请求及指纹保持不变。

意图冻结在自己的 version。继续操作既须匹配当前战役版本，又须匹配冻结版本；其他行动改变战役后，不把旧意图自动改到新状态。此时仍可用最新 expectedVersion 明确取消，再重新描述。需要掷骰的 choose 只建立现有 `pendingRoll`，按 [投掷协议](contextual-rolls.md) 确认后才生成骰点。

| 情况 | 行为 |
|---|---|
| 初次理解 / 补充成功 | `awaiting_clarification` 或 `awaiting_confirmation`，未执行 |
| 选择需要骰点的操作 | `awaiting_roll`，复用已有投掷窗口 |
| 未覆盖 / 明确转裁定 | `needs_adjudication`，复用已有主持入口 |
| 非法输入、decision 或额外字段 | HTTP 400，不执行 |
| 新请求版本不匹配 | 409 `stale_version` |
| 意图不属于当前席位或已处理 | 409 `intent_unavailable` |
| 冻结上下文已变化 | 409 `intent_context_changed`，只允许明确取消 |
| 候选未提供或现在不可用 | 409 `intent_option_unavailable` |
| 同 ID 不同内容 | 409 `idempotency_conflict` |
| 模型超时、无效结果或额度不足 | 安全的补充说明窗口，可继续、转裁定或放弃，不猜测执行 |
| 客户端未收到确认 | 保留原端点、ID、完整 JSON，提供原样重试 |

## 关联与可见性

`Resolution.intentId` 将补充、确认、投掷、取消和结果连接到唯一 `intent.request` 根事件；这些后续事件不成为新的玩家行动。`ActionOrigin.clarifications` 是可缺省的增量字段，旧存档和旧历史无需补造原文。主持裁定继续按 `originSequence` 关联；已支付的来源资源记录在原行动差异中，后续回应不重复扣费。

等待理解/确认的意图仅本人可读。服务端通过 `ActionUnderstanding.VisibleTo` 同时约束快照事件、`events`、`journal`、`activity`、活动详情及主持阅读导出，不能只隐藏 `pendingIntent`；私密正文 `privateText` 同样经 `ActionUnderstanding.ForViewer` 对非行动者与非主持席位置空。本人明确选择或进入裁定后才将这条行动及其补充公开给同战役席位；确认前直接取消的内容保持私密。已公开行动后来取消投掷不会重新变成私密。

私有聚合 `PendingIntent` 保存冻结命令、原文、补充和 Published 标记，不作为客户端操作 payload。普通事件分页先扫描原序号，再过滤可见内容；`journal` / `activity` 可能空页但 nextAfter 仍前进。旧数组 `events` 接口会跨过私有记录寻找下一条可见事件。through 冻结原序号范围，不冻结后续裁定状态或公开性。主持导出也是当前席位可读副本，可能有序号间隔，不是全库备份。

## 模型输入与导入提示词

理解入口继续原样发送用户导入的 Intent 系统提示词，没有内置系统提示词。结构化用户消息包括：

```text
player_text, clarifications, player_context, candidates, output_contract
```

`player_context` 包含当前地点/处境、当前角色身份与有限能力、活跃目标、当前地点已知人物、可见地点及最近四条相关本人行动。人物性格/经历按确定性的词语相关性选取，最多两段、每段 240 字符；不是经过评测的语义检索。集合和字段分别限长，序列化 payload 总大小不得超过 128 KiB，超限在预留外发额度前失败。

不发送整份角色表、整份剧本 `SourceText`、内部 Facts、未公开地点或主持管理事件。叙事适配器也采用同一有限玩家投影和已确认结果，停止发送旧 `script_context` / `facts`。内部 NarrativeContext 旧字段保留兼容，但不再外发。

提示词作者应让模型遵从结构化输出契约，例如：

```json
{"decision":"clarify","candidateIds":[],"question":"你指的是哪一个目标或来源？"}
```

合法 decision 为 `action|clarify|adjudicate`。action 恰好一个已提供候选，clarify 需非空问题且可带 0..6 个候选，adjudicate 不带候选；问题最多 240 字符。额外字段、伪造候选、骰点、DC、资源和执行参数均不接受。

旧提示词的严格 `{kind,target}` 响应仍可映射到当前提供的场景候选，但不足以表达新的角色来源或澄清协议。应由作者显式导入并绑定适配此契约的新提示词版本；升级程序不会修改既有提示词。

离线适配器只做有限标签/观察别名匹配，其他输入明确转裁定。`OfflineTrial` 强制走离线，不调用已配置的供应商。测试中的同义表达和能力选择使用脚本化替身，只证明流程；真实模型理解/叙事质量需要另外确认内容、供应商和预算。

## 玩家、主持与恢复

旧辅助澄清窗口保留原话、问题、已保存的补充、候选来源与成本。旧入口一个候选仍需明确确认，不再套第二层 ActionPreview；需要掷骰时保留实际投掷确认。无候选时收起列表，六个候选可滚动读取。关闭 / Esc 只隐藏窗口；轮询不重开、不清除未发送补充。**主输入接续等待态不要求弹出窗口**：问题与选择在正文可读，可直接输入，窗口只作可选辅助。隔离 Unity 新实现路径及验证边界见 [新协议](input-driven-adventure.md)。

若当前席位也是主持，其未处理请求旁提供“回应待处理行动”入口，打开已有工作台连接帮助，网页不携带凭证。工作台在原行动上下文中以纯文本呈现问题/答案与已付消耗，不增加另一套玩家意图表单。

新 `actions/interpret` / `intents/respond` 进入既有 PendingActionStore；读取不完整、未知端点、ID/版本不一致或指纹不符的本地未确认文件时，保留原文件并进入 Blocked，禁止新请求覆盖，也不允许发送损坏记录。晚返回请求只能影响捕获的原会话/待确认 store。旧无 fingerprint 的合法记录仍可恢复。

## 源码与回归

- [理解服务](../server/DiceRealm.Server/Application/ActionUnderstandingService.cs)、[候选与投影](../server/DiceRealm.Server/Domain/ActionUnderstanding.cs)、[有限上下文](../server/DiceRealm.Server/Application/IntentContext.cs)、[供应商适配](../server/DiceRealm.Server/Infrastructure/OpenAiText.cs)。
- [后端 HTTP/隐私/重启回归](../tests/DiceRealm.Tests/ActionUnderstandingTests.cs)、Unity 面板与 DTO 回归、晚完成请求隔离。
- [工作台投影测试](../client-workbench/tests/activity.test.js)、[纯文本渲染测试](../client-workbench/tests/activity-render.test.js)。
