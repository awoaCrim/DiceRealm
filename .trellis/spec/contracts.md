# 跨端契约与恢复

## 1. 适用范围

修改 HTTP、DTO、行动/裁定、状态同步、预览、历史或权限时必读。详细字段以 [客户端协议](../../docs/client-contract.md)、[行动连续性](../../docs/adventure-continuity.md)、[地图协议](../../docs/maps.md) 及对应源码为准；本文件只规定不能丢失的语义。

## 2. 接口与数据所有权

- 既有运行路径（非 Harness 自然输入）：新玩家按钮行动用 `POST /api/v1/campaigns/{id}/actions/propose`；自然语言**主入口**为 `/actions/input`（同一输入框承接等待态）。旧 `/actions/interpret` 与 `/intents/respond` 按原指纹和单候选确认语义兼容，旧 `/actions` 保留原请求恢复。上述 actions 入口均接收 `requestId, expectedVersion, kind, target, text`；返回 `snapshot, resolution, replayed`。角色审核、世界纠错和主持命令走各自明确端点，不能转换成任意状态补丁。详细字段/恢复边界见 [输入驱动冒险](../../docs/input-driven-adventure.md)；按需投掷的 `/rolls/respond`、主持 `/rulings/respond` 见 [协议](../../docs/contextual-rolls.md)。
- 显式 Harness 战役使用第12–13节与 [Harness Run 协议](../../docs/harness-runtime.md)，拒绝旧自然语言入口以免双执行；结构化行动和本人确认仍复用领域端点。
- 服务端 Domain 拥有规则和状态变化；应用层连接授权、执行和提交。客户端的 DTO/展示模型不能引用服务端 Domain 程序集或重新执行规则。
- `expectedVersion` 属于被修改的聚合：游戏命令用战役版本，地图命令用地图版本。不能用一个全局版本替代。私人信息公开以精确来源正文修订作并发边界，不接 expectedVersion、不递增机械版本，见第20节。
- JSON 使用 camelCase，字段缺失/null/空/零要有明确意义。请求只发送允许字段；新增响应字段要兼容旧记录，并检查两个客户端。
- DM全队休整使用独立host-only `GET/POST /campaigns/{id}/party/rest`，POST仅`requestId,expectedVersion,kind`；无actor/时长/数值字段、无新存档schema，原回执优先。发起权限、个人窗口与测试合同唯一维护在[全队休整](backend/party-rest.md)。
- 角色卡可空`effects:[{key,label,itemId,spellSource,details}]`来自同一权威自然效果投影。客户端只确认完整key，旧use/spell/feature请求不自动升级，缺失/null兼容为空；版本目录与具体来源匹配见[自然效果](backend/natural-effects.md)。

## 3. 提交、预览与读取

### 权威命令

1. 请求身份和形状通过后，在授权的聚合锁内先查询席位级回执。
2. 同 ID 同内容返回原判定与当前快照；同 ID 不同内容拒绝。回执重放在版本过期、已完成或归档等可变业务限制之前，不绕过身份和权限检查。
3. 只有新请求检查版本、可用性并执行；状态、本次需要的事件和回执一起持久化后才确认成功。普通换装/棋盘摆位允许显式无事件版本，覆盖校验见[持久化规范](backend/database-guidelines.md#无操作流水的状态提交)。
4. 客户端发送前保存端点、原请求 ID 和完整 payload。断线/超时/5xx/不完整成功响应都可能已执行，不改 ID、不刷新版本后自动重发、不重掷。

实现依据：[GameService.Act](../../server/DiceRealm.Server/Application/GameService.cs)、[HostCommand](../../server/DiceRealm.Server/Application/PartyService.cs)、PendingActionStore、[工作台 pending](../../client-workbench/src/pending.js)。

### 纯预览

预览不写入、掷骰或扣费，也不预留版本。编辑表单、换目标、版本变化、失败或晚到响应都要使旧预览失效；确认提交已预览的同一份请求，服务端仍重新验证。

Unity 的普通行动确认使用服务端 action metadata；主持调整与剧情后果有单独的 preview POST。不要为形式统一给每个只读页面制造确认弹窗。

### 读取

- 查询不推进游戏时间、不补充资源、不触发模型或图片生成。现存首次授权读取可能执行旧存档迁移；不要把这个受控兼容例外扩展成一般读副作用。
- 异步结果须校验会话/席位、版本和当前视图代次；旧结果不能覆盖新操作。
- 普通快照只有最近一段事件。历史通过序号和冻结 `through` 分页，不以当前数组长度猜测完整性。
- `/activity` 的 `entries` 可能为空而 `nextAfter` 仍前进；`through` 冻结原事件范围，关联裁定反映响应 `version` 的状态，不能声称冻结了所有后续信息。
- `/activity` 与 `/journal` 的历史窗口可能早于经明确授权清空后的首条保留事件。按过滤前的存储页判断读尽：`events.Length < limit` 时 `nextAfter=through, hasMore=false`；满页按最后原事件序号推进，不能按公开条目数提前结束。原 `after>=0`、`after<=through<=version`、`limit=1..100` 校验及权限不变。例如version51只保留45起的历史，`after=0&through=1`合法返回空页且nextAfter=1，不能返回nextAfter=0/hasMore=true。读取不补造事件或更改回执；普通换装/棋盘摆位产生的显式无事件版本也适用此分页语义，不能因此放宽未声明的漏写检测。回归 `JournalTests.ResetHistoryWindowsTerminateWithoutWriting` 覆盖旧空窗口、无公开根的满页、最新窗口、终点与数据库字节不变；维护后还须通过真实Player的向后窗口读取验证，不能仅检查默认最新页。
- 行动原文、已付消耗、裁定和剧情结果按真实关联连接；旧数据缺失时明示未知，不找另一条事件补齐。按需投掷使用 rollId，主持对旧行动的回应按 originSequence 读取，不替换成最近的其他检定。
- 新投掷生命周期必须先持久化未执行请求，确认后才执行一次；关闭 UI 不是取消，更新 expectedVersion 不能绕过冻结上下文。团队行动逐席位确认，不能用队长确认代替队友。字段/状态由 [ContextualRollService](../../server/DiceRealm.Server/Application/ContextualRollService.cs) 管理，后续新掷骰行动须同步声明与零骰起始回归。

## 4. 失败处理

| 情况 | 服务端/传输表现 | 客户端下一步 |
|---|---|---|
| 同请求重放 | 2xx，`replayed=true` | 接受原结果，清除已确认请求 |
| 同 ID 不同内容 | 409 `idempotency_conflict` | 停止重试，说明冲突；不自动换 ID |
| 新请求版本过期 | 409 `stale_version` | 刷新，让使用者重新选择 |
| 缺失/撤销凭证 | 401；主持权限不足为 403 | 不执行；引导恢复正确连接/权限 |
| 断线、超时、5xx、无效成功体 | 执行结果未知 | 保留原请求并提供原样重试 |
| 无 DC 的检定或旧记录 | 有结果但缺少相应依据 | 显示未指定/未记录，不推导成功或 DC 0 |

具体业务 code 在所属功能中维护，UI 不解析错误中文文案判断状态。

## 5. 正常、兼容和拒绝例

- 正常：主持预览失败分支，确认后玩家读到该次检定关联的后果；不再掷骰。
- 兼容：旧事件没有 `origin`，仍能阅读记录，明确没有原文/消耗依据。
- 拒绝：玩家传入 HP 或骰点；跨席位复用回执；把地图版本当战役版本；把过期预览改成最新版本后直接提交。

## 6. 必要验证

对受影响路径覆盖首次执行、同请求重放、不同 payload 冲突、并发旧版本、重启后重放和席位权限。按需投掷另验证确认前零骰/零消耗、关闭/取消/过期、全队确认与原行动关联，见 [ContextualRollTests](../../tests/DiceRealm.Tests/ContextualRollTests.cs)。预览覆盖零副作用与编辑后失效；分页覆盖超出快照尾部以及空根页面；新可空 DTO 在真实 Unity 中验证。

参考：[ContinuityTests.cs](../../tests/DiceRealm.Tests/ContinuityTests.cs)、[ContinuityBoundaryTests.cs](../../tests/DiceRealm.Tests/ContinuityBoundaryTests.cs)、StoryFlowTests.cs、[activity.test.js](../../client-workbench/tests/activity.test.js)。命令见 [验证规范](verification.md)。

## 7. 错误与正确示例

```text
错误：超时 → new UUID + 最新 expectedVersion → 再提交同一意图
正确：超时 → 保留 endpoint/requestId/payload → 重试原请求 → 读取原回执
错误：先掷骰再弹确认；队长替全队确认；给过期 rollId 填最新版本强行提交
正确：先保存未执行请求 → 对应席位确认 → 再校验上下文 → 执行一次并保存结果
```

Unity 的 `PendingActionStore.TryLoad` 对损坏文件返回 false，但将状态置为 `Blocked`（`HasPending=true, CanRetry=false`），保留文件并阻止新请求覆盖；不能再把 false 当作没有未确认操作。恢复校验端点、原 payload 中 requestId / 正版本与可选 fingerprint，旧无指纹合法记录兼容。损坏 legacy 文件不会被迁移或由队员领走。回归见 CoreInvariants 的 ContextualPending 和 Unity Archive/Party 恢复测试。

## 8. 自然意图：候选确认、私有续答与发布

### 范围与入口

本节记录旧 `interpret/respond` 的兼容协议；**新主输入的续接/自动叙事**见第 10 节及 [输入驱动冒险](../../docs/input-driven-adventure.md)。旧字段见 [行动理解协议](../../docs/action-understanding.md)。按钮仍走原 propose，不另建执行引擎。

### 签名

- `POST actions/interpret(ActionRequest)`，只接收 natural / 空 target。
- `POST intents/respond(IntentResponseRequest)`：`requestId, expectedVersion, intentId, decision, optionId, text`。
- `snapshot.pendingIntent` 可空；`Resolution.intentId`、`ActionOrigin.clarifications` 可缺省。`PendingIntent` 的冻结命令不进入快照。

### 契约

解释和补充只保存等待状态；choose 只选服务端冻结且重新验证仍可用的 ID。需要骰点时复用 PendingRoll，不能提前投掷。补充上限三次；不提供任意检定、资源补账或模型执行参数。模型上下文只取有界玩家投影；系统提示词原样导入，不替换成内置指令。

意图冻结版本，不自动重基。原 ID / payload 的回执查询在可变版本校验前，旧端点指纹不变。所有后续事件通过 intentId 归于唯一 intent.request，不各自产生新的行动根。

等待中的原文/补充仅本人可读；选择或进入裁定后才公开。`ActionUnderstanding.VisibleTo(c,e)` 必须用于 snapshot、events、journal、activity/detail 和阅读导出。只隐藏 pendingIntent 不构成隐私边界。

旧单行动者私密正文（16..42兼容合同；43实际收件扩展见第20节）：`GameEvent.PrivateText`（AI 主持经 harness 合约 v16 `world_record.private` 写入，≤1024）与 `PendingRuling.PrivateText`（人类主持经 `rulings/respond|resolve` 的 `privateText` 写入，≤1000，可换行）只给该行动者席位与主持。所有出口必须经 `ActionUnderstanding.ForViewer`（snapshot events/pendingRulings、/events、/journal 与导出、/activity 及其内嵌 ruling），其他席位收到 `""`。不得写进 `Resolution.Summary`、事件 Text/Narrative、投掷说明等公开字段；取消主持要求的投掷时一并清空。v15 及更早工具目录冻结，仍拒绝 `private`。未主动公开的普通事件/裁定私密文本不进入公共记忆或召回；v38新模型帧仅另取本人已保存的开场补充和本人主动公开后全房可读的分享，不能读取他人未公开补充，旧0..37和已冻结槽位不回填。精确分享见第20节。`PrivateStoryTests` 覆盖三类席位、五个出口与重启。确认前取消仍私密；投掷前已经公开的行动即使后来取消也不撤回公开性。分页游标按原序号推进后过滤，空页不能被当成历史结束；through 不冻结后续公开性。

### 主持问题与玩家结果

裁定请求的`PendingRuling.Reason`是主持问题，不是玩家已获知的剧情。新`ReferIntent`公开结果只写通用等待摘要；原问题保留主持记录。`needs_adjudication + adjudicate`的旧`Resolution.Summary`、事件Text与活动步骤通过`ActionUnderstanding.ForViewer`只读遮蔽，覆盖本人和其他玩家、snapshot/events/journal/activity及旧行动回执；主持原文和存储字节不改。已公开的真实裁定结果/普通剧情不一律遮蔽。回归见`HarnessFlowRepairTests.RulingQuestionNeverPublicIncludingLegacy`，不能只修玩家UI或新写入。

作者动作先写共享fact/公开摘要时，后补private不能撤回。新增个人发现必须在首次结果所属处明确受众，不能把ActorId当作世界记录读权限。v43在原记录上增加实际收件消息与每槽位已知正文投影，详见第20节；旧私人动作流水不因此进入公共长期记忆。

### 拒绝矩阵

| 输入 / 状态 | 结果 |
|---|---|
| 额外执行字段、错误 decision / 字段组合 | 400，不执行 |
| 未提供候选、候选已不可用 | 409 intent_option_unavailable |
| 别的席位或已处理 intentId | 409 intent_unavailable |
| 当前版本不符 / 冻结版本不符 | stale_version / intent_context_changed；允许明确取消过期意图 |
| 模型超时、额度不足、无效输出 | 未执行的可继续澄清，不猜测行动 |
| 跨席位读取私有活动详情 | 404 activity_not_found；主持也不能旁路 |
| 损坏本地 pending | Blocked，保留原文件，禁新提交及损坏重试 |

### 正常、兼容与拒绝例

正常：补充目标 → 选择 Wizard 的确切来源 → 原来源扣一次 → 同一活动内等待主持效果。兼容：没有新字段的旧存档仍可读，旧请求按原端点/指纹重放。拒绝：选择模型自造 optionId、将旧意图版本改成当前版本强行执行，或从导出绕过私有意图过滤。

### 必要测试

[ActionUnderstandingTests](../../tests/DiceRealm.Tests/ActionUnderstandingTests.cs) 覆盖解释/补充零效果、回执并发/重启、席位/冻结版本、全部读取投影的隐私哨兵、公开后可读和取消后仍私密、外发上下文与原提示词。Unity 需真实 JsonUtility 空对象归一化、关闭/轮询/草稿/候选来源，以及 晚完成提交 对会话和 pending-store 的隔离。纯上下文/DOM 测试不证明真实供应商质量或原生输入。

### 错误与正确

错误：`pendingIntent=null` 对其他席位隐藏完毕，却将 intent.request 原文放进未过滤历史。

正确：持久保存公开性，在每个用户可读投影执行同一策略；本人能恢复，未确认内容不经其他读取面泄露。

## 9. 地图关联标记：可见投影与独立地图版本

### 范围与触发

修改地图标记、编辑器或玩家读取时适用。标记属于地图元数据，不是生图规格或游戏位置；完整字段和使用说明只维护在 [地图协议](../../docs/maps.md)。

### 签名

`POST /api/v1/campaigns/{id}/maps/{mapId}/markers(ConfigureMapMarkersRequest)`：`requestId, expectedVersion, markers`；标记为 `id, kind, targetId, x, y, visibility`。地图响应新增 `markers`；主持图册另含 `markerOptions`。源码：[MapAssets](../../server/DiceRealm.Server/Domain/MapAssets.cs)、[MapService](../../server/DiceRealm.Server/Application/MapService.cs)。

### 契约

- `expectedVersion` 是地图版本；完整替换标记与原请求回执原子持久化，并置 `Published=false`，重新发布须明确审核。空数组移除全部，旧记录缺失字段默认为空。新端点使用独立 `markers` 指纹，不改变旧端点指纹或图片缓存身份。
- 最多128项，非空唯一 UUID；类型/目标须属于本战役已启用内容，`x/y` 为实际图片左上角起算的有限归一坐标。不能用请求宽高定位实际图片，也不能把坐标换算为角色移动。
- 服务层在已授权战役锁内取得 [MapMarkers.Targets](../../server/DiceRealm.Server/Domain/MapMarkers.cs)，显式传给所有地图响应投影。玩家必须同时满足地图已发布且为玩家版、标记 visibility=player、目标当前公开；没有目标上下文时拒绝下发玩家标记。队员列表/单图和主持 publishedOnly 列表不能有旁路。
- 地点复用 Adventure.Map 的已知节点；说明用公共 hint 或当前场景说明，不能泄露尚未到达地点的剧本 summary。人物/任务复用 ContentRuntime.World；人物坐标是主持标注，不暴露私有当前位置。主持可删除已失效引用，玩家过滤掉该标记。markerOptions 仅主持可见。
- 标记没有任意执行命令；地点选择仅查找当前快照既有合法 travel，复用原预览与确认。人物/任务只读。公开目标变化不要求重生成图片或重保存标记。

### 校验与错误矩阵

| 条件 | 结果 |
|---|---|
| 非主持写入 | 403 forbidden；读取有权访问的公开地图仍可用 |
| 非法/重复ID、目标类型不匹配、坐标越界或超过128项 | 400 invalid_map_markers，不写入 |
| 请求超过128 KiB | 413；入口鉴权后有界读取，不沿用16 KiB一般正文限制截断合法128项 |
| 新请求地图版本过期 | 409 stale_map，不自动替换版本 |
| 同ID不同内容 | 409 map_idempotency_conflict |
| 已接受原请求重放 | 授权后先查回执，归档/版本/新引用校验之前返回当前地图，不再次递增版本 |
| 私有/隐藏/失效目标，或缺少目标上下文 | 玩家 markers 中不存在，不仅隐藏客户端控件 |

### 正常、兼容和拒绝例

正常：主持保存尚未公开地点标记，审核发布后仍不下发；合法路线出现时随读取自动可见。兼容：旧地图无 markers，原生图/网格请求重放和图片哈希不变。拒绝：客户端自行给隐藏目标附加标题，或将 stale_map 草稿改成最新版本直接覆盖。

### 必要测试

[MapMarkerTests](../../tests/DiceRealm.Tests/MapMarkerTests.cs) 覆盖授权、私密哨兵、列表/单图、动态条件、并发/丢响应重放、归档后确认、重启、空数组/旧记录、128项正文与413。两端另验同图标记刷新不丢缩放/测量、旧回调失效、草稿冻结版本、共享原请求重试只清对应修订；端到端预览/取消零版本变化，确认旅行只执行一次。

### 错误与正确

错误：把 SavedMap.Markers 和全剧本名称直接序列化给玩家，再在 Unity 隐藏 gm 标记。

正确：先在服务端用当前权威公开投影过滤，再返回允许的信息；Unity 只为当前仍合法的旅行提供现有预览入口。

## 10. 场景：主输入、角色审核与世界信息跨端增量

### 1. Scope / Trigger

更改玩家自然语言主输入、角色参与权限、世界记忆、主持纠错或双端恢复时适用。本节只固定不可破坏的跨端行为；**完整字段和示例归 [输入驱动冒险协议](../../docs/input-driven-adventure.md) 所有**，旧输入兼容见第 8 节。

### 2. Signatures

- `POST actions/input(ActionRequest)`；旧 `actions/interpret(ActionRequest)` / `intents/respond(IntentResponseRequest)` 不迁移已发请求。
- `POST characters/review(ReviewCharacterRequest)`、`POST character/resubmit(ResubmitCharacterRequest)`；`POST world/correct(CorrectWorldMemoryRequest)`、`POST adventure/correct(CorrectAdventureRequest)`。
- 源码：[主输入](../../server/DiceRealm.Server/Application/AdventureInputService.cs)、[审核](../../server/DiceRealm.Server/Domain/CharacterReview.cs)、[世界信息](../../server/DiceRealm.Server/Domain/WorldMemory.cs)。

### 3. Contracts

`actions/input` 用原 `ActionRequest` 五字段；依据当前本人 review/pendingRoll/pendingIntent 状态处理，不从客户文字接收规则参数。新队员 pending，退回 returned 可重交，批准 approved 才能参与日常世界行动；旧记录缺 review 按 legacy approved 授权，但不伪称曾被人工审核。`narrate` 单独允许受限 npc/quest/place/clue 非机械 overlay；已知场景引用由服务器给出，不能代替路线、地图坐标、HP、资源、奖励或剧本 facts。更正需要版本与对象修订或精确行动根及理由，保留原叙事/规则。`world.correct` 事件 `HostOnly`，玩家只读过滤后的当前投影；过去已公开内容无法追溯删除。导入 Intent + Narration system prompts 原文，不设隐式默认；离线替身不证明在线模型质量。

### 4. Validation & Error Matrix

| 条件 | 结果/恢复 |
|---|---|
| 原 ID/端点/payload 重放 | 身份和形状验证后先取原回执（早于过期版本/归档/记录修订），只清对应 pending/草稿 |
| 相同 ID 改正文、错误版本或修订 | `idempotency_conflict`、`stale_version` / `world_memory_changed`；不得自动 rebase |
| pending/returned 队员行动；非主持纠错 | `character_review_required` 或 403；无状态/骰点变化 |
| 等待投掷时模糊确认，或未提供执行候选 | 明确要求 roll consent / 候选；绝不暗掷或取第一项 |
| 隐藏记录/私有意图尝试外发或纠错 | 拒绝/过滤；未 published 根纠错 `activity_not_found`，不能靠 UI 隐藏 |
| 非法 typed memory、模型超时 | 不应用半份世界记录，不造机械结果；澄清/明确升级 |

### 5. Good / Base / Bad Cases

Good：本人批准后输入交谈，非机械 narration 保存有来源的线索；DM 更正后客户看到新的公开投影。Base：旧成员 review 缺失、旧 interpret 指纹和回执保持可用。Bad：玩家说“好”触发投掷；模型造地图路线/私有引用；stale 草稿默默改成最新版本再次发送。

### 6. Tests Required

[AdventureInputTests](../../tests/DiceRealm.Tests/AdventureInputTests.cs) 断言主输入状态/consent/回执；[CharacterReviewTests](../../tests/DiceRealm.Tests/CharacterReviewTests.cs) 断言 pending 权限及 legacy；[WorldMemoryTests](../../tests/DiceRealm.Tests/WorldMemoryTests.cs) 断言原子性、隐私、纠错精确根和重启；[world-memory.test.js](../../client-workbench/tests/world-memory.test.js) 断言确认后 GET 失败不复活、旧回执不清新草稿、stale 明确 discard。Unity 的 InputAdventureTests 及 StoryFlow/UI 消费者须检查旧 DTO、正文/投掷说明、不强弹辅助面板和不伪造地图节点；引擎自动测试、原生输入与真实双端验证分别记录，不能相互替代。

### 7. Wrong vs Correct

```text
错误：理解结果 narrate 的一段“发现道路”文字 → 新增可旅行节点；纠错时覆盖旧事件或泄露隐藏理由给 guest。
正确：只保存有来源的非机械 overlay；已有合法 travel 仍由规则决定；更正保留审计并由服务端过滤公开投影。
错误：提交成功 → 后续 GET 失败 → 旧草稿复活并用新 requestId 再扣费。
正确：已确认回执先清匹配修订的待提交；刷新错误单独报告；未确认才原样重试。
```

## 11. 输入式准备、独立回执与未知位置

### 1. Scope / Trigger

更改内容整理、准备草稿、初始世界知识或未知位置展示时适用。完整字段与配置只维护在 [输入式准备](../../docs/input-preparation.md)，不把普通游玩 API 扩大为任意内容生成入口。

### 2. Signatures

`content/preparation` 下的 `GET status`、`POST (PreparationRequest)`、`GET requests/{id}`、`POST inspect(PreparationInspectRequest)` 均要求主持权限。所有者为 [PreparationService](../../server/DiceRealm.Server/Application/PreparationService.cs)、[PreparationCatalog](../../server/DiceRealm.Server/Infrastructure/PreparationCatalog.cs)；`inspect` 只读，无供应商调用。

### 3. Contracts

整理只使用显式输入与独立作者 prompt；不改变既有 PromptBundle 指纹。生成前原子保存 unknown，授权后先重放原 ID/指纹，早于归档、离线、配置等可变限制；并发同 ID 和重启不得第二次外发。准备调用不长期持有 CampaignStore 游戏锁，不修改游戏版本或绑定。缺失数值字段不能悄悄变成0：供应商解析和准备 HTTP 的 `ContentEndpoints.Read(..., requireConstructorParameters:true)` 都要求必需构造参数，旧内容端点维持原缺省合同。

`initialKnowledge` 缺省 null 和 `unlocated` 缺省 false 均忽略序列化以保持旧内容指纹。指纹、内容绑定和请求回执都对 `JsonFiles.Options` 的输出求哈希，因此其换行固定为 LF（`NewLine = "\n"`），同一数据在各平台哈希一致；不要对含平台换行或其他环境相关文本的内容求持久哈希。2026-11-21 之前 Windows 上记录的哈希是 CRLF 版本，与 macOS 计算结果不同，不做双哈希兼容（影响见项目审查）。初始知识是非机械 WorldMemory，`host/public/arrival` 由 `WorldMemories.IsPublic/Public` 统一过滤；普通 AI 即使由主持游玩也不能拿到 host/尚未访问知识。不能只过滤 Hidden。未知位置的列表消费者忽略所有坐标，不能补 (0,0) 或把布局当地理证据。

### 4. Validation & Error Matrix

| 条件 | 行为 |
|---|---|
| 错/无凭证、非主持 | 401/403，不读取准备资料或调用供应商 |
| 缺同意、非法输入、重复/额外/缺失字段 | 明确4xx；整份拒绝 |
| ID 复用不同输入/prompt | `preparation_conflict`，不替换原结果 |
| 记录损坏/未知schema | 保留原文件，拒绝；不能初始化空库覆盖 |
| 生成失败/未知结果 | 无半份绑定、不自动重试；浏览器保留原请求或终态回执 |
| 缺起点/地点/路线耗时或有问题 | `needs_clarification`，无可采用document |

### 5. Good / Base / Bad Cases

Good：来源摘录通过，主持整体采用→检查→独立试跑→明确导入启用。Base：旧文档与回执保持哈希，旧坐标地图照常展示。Bad：用任意摘录声称语义必然正确；把生成的 quest 写成空 complete 条件；让无坐标场景落针；用新 ID 自动补发已可能计费的操作。

### 6. Tests Required

[PreparationTests](../../tests/DiceRealm.Tests/PreparationTests.cs)、[BoundaryTests](../../tests/DiceRealm.Tests/PreparationBoundaryTests.cs)、[ConcurrencyTests](../../tests/DiceRealm.Tests/PreparationConcurrencyTests.cs) 覆盖完整外发字节数（包含 prompt/转义）、严格 JSON、来源/缺口、旧指纹、跨席位、并发等待时游戏可读、重启、unknown 与坏记录。双端需真实浏览器 CAS/关页/丢响应及真实 Unity DTO/未知列表/旅行确认/到达公开验证，不以 fake 结果宣称在线质量。

### 7. Wrong vs Correct

错误：只看本页 localRevision 或 BroadcastChannel 通知，就在确认框后导入旧草稿。

正确：冻结两份文档与视图/输入代次；提交前等待保存、核对 IndexedDB 持久修订，再核对本地代次。准备采用另外检查 input key 和 operationRevision，迟到旧检查不能覆盖新生成。


## 12. Harness：新战役、工具回执与明确恢复

### 1. Scope / Trigger

修改多步运行、Pi/MCP边界、席位私有日志、候选/投掷续接或活动投影时适用。完整 API、配置和限制只维护在 [Harness P0/P1](../../docs/harness-runtime.md)。普通旧输入和旧回执合同不迁移。

### 2. Signatures

`POST /api/v1/harness/campaigns(CreateHarnessCampaignRequest)`；战役下 `POST harness/runs(HarnessInputRequest)`、`GET harness/runs/active`、`GET harness/runs/{id}`、`POST .../resume(HarnessResumeRequest)`、无正文 `POST .../cancel`。所有者为 [HarnessRunService](../../server/DiceRealm.Server/Application/HarnessRunService.cs)、[HarnessGameService](../../server/DiceRealm.Server/Application/HarnessGameService.cs)、[HarnessRunStore](../../server/DiceRealm.Server/Infrastructure/HarnessRunStore.cs) 和 `agent-host/`。

### 3. Contracts

- 新战役才可绑定原样 preset/只读 Skill，`Harness:Enabled=false` 默认关闭；模型用独立 `HarnessAi` 显式配置。旧 AI 入口在 Harness 战役拒绝，结构化确认不额外调用旧 narrator；OfflineTrial不能发真实模型。
- 请求 UUID在新入口统一规范化，按战役+可信席位隔离。授权后先查原请求/续接回执，再检查可变版本。内部 intentId由服务端另建，不能拿两个席位复用的 requestId当全局活动根。
- 模型等待在战役锁外；每个工具重新授权。写工具先有稳定commandId，领域状态/事件/**完整原工具输出**同事务提交。Pi按固定槽位重建已存模型和工具回复，不重复外发或把当前新快照冒充旧回执。
- 模型可能外发前持久started；当前活跃槽位可按服务端配置有限重试暂态模型失败，每次重新授权/检查版本与上限、持久计次并预留额度，不重跑游戏工具，详见[供应商重试](../../docs/harness-runtime.md#供应商中文思考与有限重试)。终态未知结果不自动重发；GET和重启不自动启动模型。只由自身写入或匹配的明确同意结果推进版本，不能自动rebase。
- 外发前确定拒绝只能由受信模型适配器提供阶段证明，并关联到当前槽位；failed仍保留started/尝试计数，不伪造结果或重发。终态落盘前崩溃仍按旧未知规则；供应商响应/异常字符串不构成未发送证明，预留成功后不退款。累计报告/估计tokens是下一请求的续发阈值，允许已返回回复越过，等待/重启/回放不重置或重复计入。具体原因/数值见运行文档。
- 同意必须走本人原roll/intent端点。停止工具阻止同批后续工具；模型没有确认工具。Run取消只停止生成，保留已提交领域请求，`notice`必须给出原wait.id对应的明确放弃路径。
- 候选授权不仅在工具写入改变版本时失效：现有 `HarnessRunService.Resume` 在原 `Wait` 非空时也清空 `OfferedIds`，包括游戏版本未变的玩家答复。旧0..14需要再提议行动时，先重新 `context_read` **或** `actions_list`；不得从历史模型消息复用旧候选。当前 `context_read` 已含候选，无状态/等待变化时不必紧接着再读同一份列表。此为现有边界说明，不改变旧回执或自动恢复语义。
- 普通行动/世界记忆使用有界PUBLIC投影，即使操作者是主持；模型执行上下文按冻结契约另行授权，v38本人开场补充及已公开分享见第20节，不能泛化为读取所有私人资料。日志按席位私有。契约3的公共世界检索与本Run实际对象引用见[世界检索协议](../../docs/harness-runtime.md#公开世界检索与更新引用契约3)：契约3..14由context_read/search授对象更新引用，v15也可由新模型槽位实际提供的PUBLIC执行帧授予，写入或wait续接清除，done回放不重新授予；公开世界共享与仅本人历史分别授权。运行终态冷存不删除回执，不把活动容量变成终身输入次数上限。活动`steps`保存权威步骤，最终叙事不得抹掉检定、来源及消耗。
- 契约4按需读取本地中文资料，`RulesCatalogVersion`在新Run接受时绑定并持久化；旧0..3不升级，done回放不查当前库。规则查读不给行动或世界对象引用，不把规则全文等同能力/结算支持；出处留内部不进前端，详见[规则查读协议](../../docs/harness-runtime.md#本地中文规则查读契约4)。
- 完成意图由Domain在同事务同步 `intent.Version=c.Version`。旧多步marker落后时，所有历史读取统一通过 `HarnessMemories.ResultVersion` 从已存步骤最大版本派生，不能在GET迁移、改旧Run记忆/回执或clamp未来坏版本。源与回归见 `ActionUnderstanding.Complete`、`HarnessContinuationRegressionTests`；具体投影语义见[故障恢复](../../docs/harness-runtime.md#5-持久化与故障恢复)。
- v15父端在每个新模型槽位自动只读校验并提供PUBLIC执行帧、当前候选enum及可用工具，外发前持久started+frame；旧done回放不重新授引用。写入或等待清引用，同批后续受保护写入返回零副作用refresh_required，下一model自动给新帧，不自动重做工具。用户system原文/native parts、领域确认、旧0..14目录与unknown边界不变。完整字段和状态见[执行协议](../../docs/harness-runtime.md#父端执行帧与短工具协议契约15)。
- v22仅对新运行提供当前公开场景地图状态`frame.map`，HTTP图册共用三字段白名单；仅missing+generationEnabled提供并执行map_request，旧原回执优先。读取/打开页面不排图，0..21目录/帧冻结，详见[地图状态合同](backend/integrations.md#当前场景地图状态契约22)。角色sheet的可空weight为服务器只读库存投影，来源/未知计重与旧响应兼容见[客户端负重合同](../../docs/client-contract.md#carried-inventory-weight)，不改变库存/容量或加惩罚。
- v14地图缺最新情境只返回无副作用的恢复结果，不能扩大到其他错误；旧0..13冻结、map原回执仍优先。具体反馈与不执行边界见[地图情境刷新](../../docs/harness-runtime.md#地图情境刷新契约14)。
- active发现先绑定可信actor，只读有界未结束热记录，不接受客户端actor、不在GET恢复/升级。Run进度只投影白名单步骤元数据与冻结绑定标识，绝不序列化Result/Outcome/原始模型消息；旧Step无toolName显示通用步骤。调度后执行器拥有可变实例，HTTP从原子存储副本投影，不能并发枚举执行器的Steps。
- interrupted不必然可恢复：仍有started模型槽位时禁止补发。新创建无请求回执/凭证找回合同，未知创建不得自动重试或假称已有防重放。已收到凭证但浏览器保存失败与响应未知须区分，前者保留收到的连接供明确下载。
- 浏览器本人行动页遵守[工作台本人行动合同](frontend/workbench.md#本人行动页)。活动记录可能多于一条；Run取消后若wait未落盘而本人快照仍有待确认，UI只可清楚列出具体事项供单独放弃，不能猜关联或代同意。

### 4. Validation & Error Matrix

| 条件 | 行为 |
|---|---|
| 同ID同正文（含UUID大小写等价） | 原回执，不新启执行 |
| 同ID不同正文、回放槽位不符 | `harness_run_conflict` / `harness_replay_mismatch`，不静默替换 |
| 未提供候选、额外机械字段、引用隐藏记忆 | 拒绝；不能产生半份状态 |
| 旧0..14等待答复/确认后未经重新读取就提议旧候选 | `intent_option_unavailable`；零领域效果，不能自动换ID重试已失败运行 |
| v15同批受保护写入缺当前执行帧 | `refresh_required`且applied=false；零副作用，下一新model自动获得当前帧，不自动重发工具 |
| v14合法地图参数但缺本段最新情境 | `context_required`工具反馈；零排图/费用/游戏写/引用，重读后新工具调用 |
| 旧13地图缺情境、未来历史步骤版本 | 原拒绝；不能升级旧Run或截断坏数据 |
| 外部状态变化、投掷尚未本人同意 | `stale_version` / `harness_waiting_consent` |
| 未完成模型槽位且无可靠的外发前拒绝证明 | `unknown` / `harness_model_unknown`；禁止补发 |
| 受信适配器确定外发前拒绝 | `failed`及封闭原因码；保留槽位/效果，不可resume或原请求重发 |
| 撤权或跨席位读取 | 401 / 404；主持无旁路 |
| 损坏或未知schema运行文件 | `harness_corrupt_run`，保留原文件 |
| 已取消Run仍关联未取消roll/intent | 保留Wait及notice，明确去原端点cancel；不宣称原行动已撤销 |

### 5. Good / Base / Bad Cases

Good：Pi读上下文→提议检定→本人同意→重启→只重放旧槽位→读取真实结果/记忆/叙事。Base：旧campaign无Harness字段，指纹和自然输入照旧。Bad：把工具toolCallId当唯一幂等键、取消生成当撤销骰点、清理已完成Run时删除旧回执。

### 6. Tests Required

[HarnessContinuationRegressionTests](../../tests/DiceRealm.Tests/HarnessContinuationRegressionTests.cs) 验证多步结算标记、只读旧投影、未来版本拒绝、重启原回执无新增；`AutomaticMapTests`验证真实Pi/MCP恢复与旧目录冻结。
[HarnessReadTests](../../tests/DiceRealm.Tests/HarnessReadTests.cs) 覆盖发现与安全进度的本人/跨席位/撤权、零写入、旧标签、unknown和坏记录。
[HarnessPiTests](../../tests/DiceRealm.Tests/HarnessPiTests.cs) 必须跑真实Pi/MCP/子进程与重启，不可只测fake loop；[HarnessTests](../../tests/DiceRealm.Tests/HarnessTests.cs)、[BoundaryTests](../../tests/DiceRealm.Tests/HarnessBoundaryTests.cs)、[AuthorityTests](../../tests/DiceRealm.Tests/HarnessAuthorityTests.cs) 覆盖确认前零骰、原回执崩溃窗口、后续失败保留效果、PUBLIC投影、候选失效、撤权/取消、超过64条已终结运行、UUID大小写及活动规则结果保留。供应商用 [HarnessProviderTests](../../tests/DiceRealm.Tests/HarnessProviderTests.cs) 验证原文和尝试额度，不使用真实配置。[HarnessBudgetTests](../../tests/DiceRealm.Tests/HarnessBudgetTests.cs) 区分真实Pi/fake HTTP下的外发前拒绝与外发后未知，检查已提交效果、重启/原请求重放、终态不可续接和累计tokens阈值。

### 7. Wrong vs Correct

错误：领域工具已提交，运行文件未写完 → 刷新到最新版本再执行；最终叙事覆盖唯一规则结果。

正确：重建Pi命中原commandId的完整输出；活动步骤与原检定保留，最新叙事只作为非机械文字。

v23 `world_record`默认最终提交，只有`complete:false`继续。完成标记来自领域同事务回执，不相信模型自报完成；父端直接交付接受正文并停止同批，不再让模型复述或重复final保存。done工具已存但终态丢失时，授权/回执检查后可无外发恢复，即使游戏已有后来版本也不重基或重写；unknown/取消不借此重试。完整标记校验、空文本resume和兼容边界归[契约23](../../docs/harness-runtime.md#最终回应来源与工作情境契约23)，真实Pi两类崩溃回归见`HarnessFinalNarrativeTests`。


v36起探索通过 `combat_delegate` 在先攻等待之前持久化稳定战斗子会话，父 Run 的 `delegated` 是非终态；每条战斗输入仍有自己的 Run/sessionId，不能将其替换为 CombatSessionId。独立正文/本人历史与共用权威规则分离，跨席位不搬运私人原生历史。权威结束冻结回传并幂等接回原父，每次重新验证原可撤销身份；未知外发不补发。v37 `Agent.AfterCombat` 只绑定该次精确回传，新探索输入不能继承临时指令；旧0..36保持原合同。详细字段归[运行合同](../../docs/harness-runtime.md#持续战斗子会话契约3637)，回归见 `CombatAgentSessionTests` / `CombatAgentRecoveryTests`。

## 13. Harness 工作区：独立版本与冻结运行

### 范围与签名
修改预设/Skill、工作区命令、跨运行记忆或内容导出时适用。`/harness/workspace` 的 draft/publish/activate 命令使用 `requestId,expectedWorkspaceVersion`，返回 `workspace,replayed`，不走普通 `snapshot,resolution` 或游戏 expectedVersion。完整字段见 [P2协议](../../docs/harness-workspace.md)。

### 合同
- 配置/历史/导出仅主持；memory仅当前席位。授权先于回执，回执先于版本/归档，丢响应原样重放。工作区操作不推进游戏状态、不调用模型。
- 保存、发布、激活分开。探索/战斗两份system同ID/预设版本不可替换；可空combatSystemPrompt省略保持旧hash，不用探索正文暗补。战斗在交接时冻结独立profile，设置变更不替换已开始会话。Skill修改仍产生不可变整组修订；回退只改新绑定，不改历史。
- Run开始在同一campaign gate捕获游戏版本、active profile、有来源的本人公共记忆；后续Skill读取用冻结Run.Profile，不能读当前Campaign bootstrap/active。权限仍每次复核。
- 记忆是有界只读投影，非另一个权威源。更正只替换新投影的公开叙事，不发更正理由/主持秘密/其他席位输入，不重写旧Run.Turns。旧无MemorySnapshot记录保持原文和指纹。契约2的按需历史召回复用同一资格，不受近期12条截断；查询时重新授权/检查cursor，已存工具输出冻结重放，不授予候选权限。详细字段和限制只维护在[P2历史召回](../../docs/harness-workspace.md#按需历史召回工具契约2)。
- 导出锁内抓一致数据、锁外压缩传输；带payload路径/字节/hash清单、选定修订与可选草稿。不是完整备份，不含凭证/私有运行；主持冒险源仍是私密内容。

### 校验与错误
非主持403；旧战役409 harness_campaign_required；旧配置版本409 workspace_stale_version；同预设名版本异文409 workspace_preset_conflict；已发布hash409 workspace_already_published；坏/丢目录409 workspace_corrupt/workspace_missing保留文件；不确定提交/传输5xx保留原请求。UI不能把workspace version注入游戏请求，也不能凭换requestId绕过未知结果。

### 正常、兼容与拒绝
正常：保存草稿→发布→激活，暂停Run仍读旧Skill，新Run取新绑定。兼容：P0记录没有记忆字段仍原样重放。拒绝：改同名预设版本原文、从另一席位/导出取得私有输入、丢工作区后静默退回初始绑定。

### 必需验证与正误
[HarnessWorkspaceTests](../../tests/DiceRealm.Tests/HarnessWorkspaceTests.cs) 覆盖竞态/重启/事务失败/初始化双提交窗口、冻结Skill与记忆、跨席位、旧记录和导出hash；工作台同时验证本地CAS/晚响应/未知请求与真实浏览器。错误：激活后回调按当前profile hash比较并使旧Run失败。正确：激活只决定下次接受的profile；当前Run用持久冻结副本、继续重新授权和核对游戏cursor。

## 14. 业务冒险与设定前端边界

[业务冒险与设定](../../docs/adventure-sessions.md) 定义 `/campaigns/from-content` 与 `/campaigns/{id}/adventure/*` 的完整字段；[工作台规范](frontend/workbench.md) 定义客户端状态与回归。前端呈现战役、行动、本人确认、结果和内容准备；仅主持可在剧情页读取安全执行步骤，成功后默认折叠并保留历史入口，精确actor/action索引、按run过滤的HTTP日志及publicOnly服务端投影的权限/失败矩阵见[只读进度合同](../../docs/adventure-sessions.md#主持执行进度只读)。不提供 Run/hash 管理或执行引擎选择；工作台仅面向 PC 桌面。`AdventureSessionService` 无状态转交，第12–13节继续拥有权威与回执。

旧 pending 原端点/ID/完整正文重试，不改路由；创建无 requestId，结果未知不自动重建。保存草稿、发布、启用独立：发送前冻结内容身份和设定版本，重试不按当前状态重算。`matchesActive` 不等于已发布，fingerprint 不显示。GET/继续/停止不代同意；停止保留已提交效果及领域等待，未确认模型结果不补发。

自动续接只认精确 wait.id 的已保存完成事件；同一 intent 多次确认时，用该意图最新完成事件序号区分已处理的确认，不能用整个 snapshot.version 让无关事件触发重试。原未知 pending 优先原字节恢复，不从 pending 消失猜已同意。聊天中的父回传/首条委派输入以 `continuationOf` 保留连续顺序并避免重复原话，审计仍保留原输入与actionId。实现与回归：`AdventureProtocol` / `AdventureBusinessSyncTests`、`ActivityService` / `StoryChatTests`。

## 15. 完整角色成长：取得历史与冻结选择

### 1. Scope / Trigger
修改 Build 成长、机会授予、多职业准备/休整或成长客户端恢复时适用。完整字段与实际支持边界归[角色成长协议](../../docs/character-advancement.md)；不把取得记录当作全部主动能力已经自动结算。

### 2. Signatures
战役下 `GET character/advancement`、`POST character/advancement/preview(PreviewAdvancementRequest)`、`POST character/advancement/apply(ApplyAdvancementRequest)`、主持 `POST characters/advancement/award(AwardAdvancementRequest)`。Character.Advancement / Campaign.AdvancementAwards 可空追加，旧 Build 和回执不重写。

### 3. Contracts
preview 只读且不带 requestId；apply 只接原修订和来源选项，由授权席位确定角色，不接派生数值。服务端同一 evaluator 负责预览和应用，保留伤势/消耗/身份、追加连续取得历史。回执返回当前快照而非冻结的下一版本，客户端验证命令/战役/角色及结构，不能强求 `expectedVersion+1`。未知请求只原样重试；正常和共享重试 ACK 只清自己的草稿修订。

两端的草稿版本与当前快照分离；编辑、换席位、关闭视图、较新的预览响应或失败重查使旧预览不能被采用。Unity 用真实 JsonUtility 验证 null/missing，不能把 materialized 空成长对象当有效记录；重建面板读取焦点时使用 Unity 的原生 null 判断，不能对已销毁 GameObject 直接 `?.name`。

成长后的休整复用原动作与按需投掷。生命骰 target 选具体已有骰池，奥术回想 target 选当前已花费槽位组合；候选由服务器生成，不能从客户端传骰面/治疗量/任意资源补账。新取得法术来源列表不得在升级时混合旧列表；单独的休息/替换流程需自己的来源校验。

Magic Initiate 替换按已有专长实例而非此次职业归属：`spell-change:<origin>` 选择 keep 或旧法术，`:replacement` 仅同列表同环级且不同于该实例现有法术；每实例最多一个，默认 keep。当前取得来源与相应免费池一起更名并保留已用量，不能重建满次数池；其他来源同名法术与原 Build 不变。Elf/Tiefling 血统法术按人物等级、Ranger 免费次数按职业等级、Forest Gnome 次数按 PB，不能统一使用总等级或 PB。

### 4. Validation & Error Matrix
未审核角色 403；版本过期 `stale_version`；同席位 ID 异文 `idempotency_conflict`；资格/地点/等待状态阻止 apply；不完整选择 `advancement_incomplete`；坏/未来成长记录拒绝而不初始化；各职业当前法术按职业列表/等级/法术书检查，逐级子职业与取得特性不能借保存记录越级或改换；撤权后连旧回执也拒绝。无效成功体、断线和 5xx 不清 pending。完整矩阵见所属协议。

### 5. Good / Base / Bad Cases
Good：本人预览→明确确认→丢响应→同字节重试仅一级提交；多职业短休同意后只花所选骰池。Base：无 advancement 的旧角色仍走旧路径；旧短休 target 语义保留。Bad：默默将未发送草稿换成最新版本、客户端自动选择首项专长、升级恢复全部伤势或扣错主职业生命骰。

### 6. Tests Required
`AdvancementTests`/`AdvancementFeatTests` 验真实取得与派生，不以路径可完成代替效果断言；`AdvancementStateTests` 验坏职业法术资格/子职业历史拒绝且原件不改；`AdvancementSpellChangeTests`/`AdvancementSpellChangeHttpTests` 验跨职业替换、不同来源同名保留、花费守恒、六血统总等级授予、来源次数成长与重启旧回执；`AdvancementAuthorityTests` 验审核、授奖、不同 ID 竞态、席位回执和撤权；`AdvancementRestHttpTests` 验确认前零骰/零时钟/零消耗、选池、并发与重开。Unity `AdvancementInvariants`/`AdvancementTests`/`AdvancementSyncTests` 验深拷贝、malformed 2xx、精确重试及关闭/换席位/新版本晚响应；工作台需对应逻辑和真实浏览器业务验证。规则编译器负例须证明 `python -O` 不能绕过固定源哈希。

### 7. Wrong vs Correct
错误：重复取得 Magic Initiate 沿用已拥有列表；Skilled 只加名字；恩惠抗性只存在表单选择里。正确：按已有来源排除重复列表，把确认的技能/工具/抗性写入服务端派生并保留来源步骤，未实现主动效果仍明确区分。

## 16. 明确世界路线与派生地图信息

1. **范围**：Domain `WorldRoutes`拥有拓扑，`Adventure.Exits`供显示成本和实际travel共用；应用层接本人intent确认，MapMarkers只派生可见关联。详细字段归[世界维护](../../docs/world-maintenance.md)，不修改导入文档或把叙事当机械成功。
2. **签名**：工具契约6新增`world_routes(offset,limit)`、`world_route_propose(routeId,sceneId,memoryId,seconds,bidirectional,open,reason)`；私有可空`Campaign.WorldAtlas` schema1、ActionCandidate可空WorldRoutePlan；旧0..5目录冻结。确认复用intents/respond。地图响应新增只读`automaticMarkers`，人工输入字段不变。
3. **合同**：新路线从当前位置开始，仅已读knownScenes或本run实际读过的独立公开place；先fresh context_read，再完整验证/冻结候选。确认前仅保存私有等待，不产生atlas/时间/骰/资源。choose同版本重新验证后一次提交，确认不自动旅行；任何导入端点对均禁止动态覆盖（含关闭/单向/条件路线）。地点源名/摘要动态投影，未知位置unlocated，无安全休息或奖励授权；隐藏目的地不旅行，已在隐藏地点可中性展示并返回公开端点。路线字段自身未迁移SQLite；后续世界信息规模化采用第17节schema2。采用新字段后的存档不能拿旧程序忽略字段当安全回滚。
4. **校验/错误**：缺fresh context→harness_context_required；秘密/未读/错类型/重复对/导入覆盖/坏seconds或源revision→invalid_world_route；不改变路线→world_route_unchanged；过期确认→intent_context_changed/stale_version；存储坏版本/引用/重复/来源→invalid_world_atlas。授权先于存储领域检查，坏存档保留。自动标记没有可见锚点不产生；不能以memory kind提交人工地图接口，invalid_map_markers。
5. **例**：公开place→本人确认180秒往返→后续travel实际180秒；旧无atlas和自动字段仍可读；拒绝复制隐藏场景同名place、从模型文字直接改visited、把自动标记抄入手工列表、用旧版本继续确认。
6. **测试**：WorldRouteTests/WorldMapTests断言计划前后相等、权限与引用、开闭/方向/隐藏、并发与重开零重复、取消/过期、未来schema保留、MapCatalog字节/版本/发布/图片不变、自动标记128界限。真实Pi/MCP fake链与真实浏览器本人输入/确认/继续/重开必须区分供应商质量。Unity DisplayMarkers合并显示但人工markers数组不变；memory不允许MarkerTravel；旧null归一化需Editor验证。当前Unity实现为隔离暂存、尚未落地/Editor验证，不能报双端完成。
7. **正误**：错误是把记忆SceneId当新像素位置或从叙事数字造travelSeconds；正确是明确秒数的受限提议经本人确认，图面仅沿用既有公开地点锚点。错误是提高WorldMemory常量就声称规模化；正确是另外实现有授权与兼容证据的索引/分页存储。

## 17. 世界信息规模化：分页与原子索引

### 1. 范围
世界非机械信息从全聚合数组改为独立权威行；不改变行动确认、旅行、奖励或地图发布权限。源码与测试已更新，日常启用和Unity真实交付仍由父任务验收。

### 2. 签名
`GET campaigns/{id}/world/memory?expectedVersion&query&kind&offset&limit&scope`返回`WorldMemoryPage(version,scope,entries,total,nextOffset)`；`IWorldMemoryIndex`提供Count/Find/NameExists/Read/Upsert，仅在授权CampaignStore gate内使用。SQLite user_version2的world_entries/world_terms与state/events/receipts同事务保存；私有storage marker1。

### 3. 合同
8192条全局上限；snapshot.worldMemory最多256，超出时附worldMemoryPaging(total,nextOffset)。HTTP query≤120字符/8词、kind空或npc/quest/place/clue、offset0..8192、limit1..32、scope public或主持host；page版本必须与expectedVersion一致，末页cursor=null。模型world_search永远public；v23私有执行帧的当前导入host白名单见[契约23](../../docs/harness-runtime.md#最终回应来源与工作情境契约23)，不得转为公共引用。context32、地图关联候选128、工具search6/24KiB仍各自有界。新工具版本7仅升级世界查询游标边界；旧0..6目录冻结（v6 golden来自改前world程序集）。每run最多保留最近已读256个不同世界ID，写/等待/压缩照旧过期。

### 4. 错误
非法HTTP查询invalid_world_query；版本变化stale_version；guest host范围原403；容量world_memory_capacity；未来SQLite unsupported_save；混合marker/缺表索引/非法已读记录invalid_world_memory_store。名称冲突不暴露隐藏正文。未授权不初始化/迁移/修复/备份。

### 5. 正常、兼容、拒绝
正常：同版分页找到cold ID后以该revision纠错，同事务更新权威行及词项。兼容：SQLite1 GET不升级；首次成功授权写才备份旧库并迁移；旧JSON保留，旧回执原样查读。拒绝：丢失索引不可当空库重建；客户端不把前256标为全部，不把翻页响应合入权威snapshot；迟到页面不能进入另一席位/战役/版本。

### 6. 验证
`WorldScaleTests`覆盖8192行state体积/有界实际加载/词项索引查询计划、公开分页无重无漏、隐藏到达和名称冲突、overlay读己写、事件回执故障原子回滚、备份字节/迁移失败/重开、旧v6冻结、真实Pi/MCP的offset300旧ID更新。工作台world-memory-paging回归检查严格GET/版本范围/冷记录纠错/晚响应/IME；真实浏览器检查搜索纠错与重开。UnityCore及EditMode暂存tests不能冒充已合并Editor/Player。

### 7. 错误与正确做法
错误：只把256改8192，继续每次反序列化全文；或另建无事务同步的缓存作为新真相。正确：独立权威行、同事务派生词项索引、请求内overlay和授权分页。错误：只恢复SQLite而重置或丢掉外发额度/Run unknown；正确：正式切换前完整一致备份，保存已尝试外发的事实。完整说明归[世界信息存储](../../docs/world-memory-storage.md)。

## 18. 完整建卡唯一入口与无角色主持

### 1. 范围与触发
新角色接纳、战役创建、审核、队伍遍历及可空角色消费必须遵守本节。工作台只创建/准备战役、邀请与审核，玩家只在 Unity 邀请页完整建卡；不恢复预设旁路或在网页复制建卡器。具体字段归[客户端协议](../../docs/client-contract.md#full-level-one-character-build)。

### 2. 签名与所有者
`GameService.CreateCore`区分无角色主持和显式完整build兼容创建；所有新角色接纳统一用`CharacterEngine.CreateComplete`。`PartyService.Join`与角色replacement在原已接受回执之后检查新建门禁。`Campaign.HostOnlySeat`缺省false且false不写出；`Campaign.Character/HostReview`在true时必须为null，`PartyEngine.ValidateSeats`在授权读取/保存检查，不将坏旧档猜成新主持。旧模板默认值与请求序列化不能随UI删除而改动，否则旧fingerprint会失效。

### 3. 契约
- 工作台新建只发name及可选内容，不发characterName/templateId/creation/build；新host快照`character=null`、`party.isHost=true`，成员只包含真实角色。服务端保留显式合法完整build创建的协议兼容，不提供前端入口；不是允许preset fallback。
- 新Join/实际replacement必须含完整Build，姓名匹配并重验。仅补充退回说明不算创建新角色；旧角色不迁移、不重建或回血。已接受的旧预设请求按原endpoint/body/ID恢复，尚未接受的旧请求明确拒绝。
- `CanAdmitCharacter`统一邀请/加入/批准的门禁：不在战斗中且没有人倒地即可，不再要求剧本安全休息地点（2026-11-22，后来的玩家由契约58入场句介绍）；仍受归档/待投掷（批准）/容量限制。新host最多四个玩家，旧host玩家仍四人总数；撤销记录仍占容量。
- 玩家行动权限先要求实际角色，再审核。无角色host没有本人行动/成长/角色卡，管理读取仍可用。试跑需真实已批准玩家，隔离深拷贝当前状态而非按一级build重建；原伤势、等级和已耗资源不能被重置。新host战役物品后果归实际行动者，裁定归原ruling.actor；旧host库存语义保留。
- 空队伍rest是合法读取，participants为空时三种选项全部不可用且有原因，不推进时间。工作台snapshot只接受明确host的null角色，不能放宽guest/missing响应；空角色纠错不造目标或发空命令。
- Unity `ApiJson`按character.id恢复真实null；`RequirePlayerConnection`在Import/Switch/Refresh保存或BindPending前拒绝主持连接，保留原session/pending/库/草稿。加入页无角色时主动作进入全屏建卡，不发送空build；新建独立空稿，关闭自动保存，恢复后重验。复核末步直接加入；有效成功回执后保存完整本机角色，跨房间选档合法即可加入。已发送pending独立保留；本机失败先恢复已确认回执，不新发加入。数据合同见[建卡与本机角色](frontend/character-creation.md)。

### 4. 校验与错误矩阵
| 条件 | 结果 |
|---|---|
| 新角色缺build；旧简化目录/预览 | `full_character_build_required`；新请求400，退役端点410 |
| 混合旧creation、非兼容模板、姓名不符或无效build | `invalid_character_build`，0席位/邀请消耗/版本变化 |
| 无角色host调用玩家功能 | 403 `player_character_required`，0模型/骰/资源/Run变化 |
| host-only标志与角色字段矛盾；旧无标志却丢character | 409 `invalid_save`，原档保留，不读时迁移 |
| 无批准角色试跑 | 409 `trial_character_required`，正常内容准备仍可用 |
| 原已接受请求 | 身份/授权/指纹核对后回原结果，新build政策不得截断恢复 |

### 5. 正常、兼容与拒绝
正常：空白host→邀请→Unity完整采用→pending→工作台批准→玩家行动。兼容：旧host有真实角色且HP已减少，读取/重启仍保留；旧已接受join原回执可恢复。拒绝：给DM造默认战士、把第一个玩家当共享背包、未采用就提交、遇null主持连接覆盖当前玩家。

### 6. 必需验证
`FullBuildOnlyTests`覆盖缺失/非法/混合、零副作用、接受前后旧请求及replacement；`HostOnlyCampaignTests`覆盖三创建路径、空管理/休整、首次邀请批准、非安全地点加入/容量、管理与玩家权限、试跑当前状态、物品实际归属、重启及损坏旧档。Unity真实JsonUtility与`HostConnectionSyncTests`覆盖null/missing/object、导入/切换/刷新1GET/0POST及所有原本机状态不变；`PartyUiTests`覆盖无预设、空白新建与单次完成加入；`LocalCharacterTests`和`RoomJoinSyncTests`覆盖草稿恢复、完整归档及成功后本机写失败恢复零重复POST。工作台`host-only.test.js`/`party-rest.test.js`覆盖无角色载荷、空响应、无composer和空目标。最终需实际浏览器设置房间→原生Player空白完整建卡/采用/加入→审核，并从重建的嵌入资源页面检查，不以磁盘JS或DOM替身冒充运行包。

### 7. 错误与正确
错误：删UI模板按钮但保留无build发送；或在旧回执之前拒绝所有preset请求。正确：新请求唯一完整构筑入口，原接受回执优先；主持创建无角色，由真实玩家独立建卡加入。

## 19. 房间共享加入与创建后首次设定

- 范围：创建/房间凭证/新玩家入房/首次设定与两端恢复。详细字段唯一维护在[房间协议](../../docs/room-onboarding.md)。
- 新`POST /rooms`只有名称且创建无角色主持；InitialAdventureSetup缺省false，旧`/campaigns`不获得转换资格。新`adventure/setup`复用ChangeContent：授权→原回执→版本/资格→完整内容+原prompt/profile/启用/清标识同事务。已有席位审核保持，非主持/旧战役/非法输入零提交。创建本身没有请求回执，不伪造未知创建恢复。
- 固定号只在host首次开启room写入时Reserve，GET不分配；目录唯一号与campaign双向唯一，孤立预留无权限，重试复用。RoomCredentials慢PBKDF2盐哈希；host room命令指纹用高熵host capability HMAC密码，不能通过无密钥快哈希绕过慢密码验证。不得将RoomSettings下发快照。
- 新room join严格完整build；共享密码只允许新admission，每席位仍独立token。已接受回执凭原token可越过换密/关闭，不能越过撤席位；改正文冲突、坏构筑/容量/地点拒绝均零副作用。未知/错密统一拒绝，有界正文及真实peer/全局限流。
- Unity旧pending无schema保持原邀请路径，新schema2明确rooms/join，actual snapshot.id才是campaign；429/未知结果保留原字节，迟到响应重验会话/代次。工作台首次设定与room配置仍走唯一pending，确认只清匹配修订；首次设定是标签页内存草稿，别宣称为IDB持久化。
- Good：name→设定→固定号/密码→客户端采用→加入→审核。Base：旧邀请/旧已接受请求及旧角色不变。Bad：把房间密码当所有人的席位token、GET创建索引、把普通旧空白战役静默转新内核、超时换requestId补入房。
- 验证：`RoomTests`覆盖轮换/关闭/并发/重启/回执/匿名枚举/413/预留故障窗口，`InitialAdventureTests`覆盖首次原子性/旧拒绝/原prompt/重启；工作台与RoomJoinSyncTests另测迟到、原请求、草稿和真实双端。

## 20. 自动地图、持久开场与实际知情范围

1. **范围**：修改自动选图、入场生成、私人来源/公开记录、模型受众或双端恢复时适用。HTTP字段唯一归[业务冒险](../../docs/adventure-sessions.md#入场开场共同一份个人一次)，地图展示归[地图协议](../../docs/maps.md#与游玩地点关联)，v38上下文归[工作区协议](../../docs/harness-workspace.md#入场与主动公开上下文工具契约38)。
2. **签名与所有者**：战役下 `POST adventure/opening`、`POST adventure/story/share`、`GET adventure/story/shared`；可空 `Campaign.Opening/SharedStories` 与对应快照投影。选址由 [AdventureOpenings](../../server/DiceRealm.Server/Domain/AdventureOpening.cs) 拥有，叙事提交/精确分享分别由 [AdventureOpeningService](../../server/DiceRealm.Server/Application/AdventureOpeningService.cs)、[PrivateStoryService](../../server/DiceRealm.Server/Application/PrivateStoryService.cs) 拥有；不另建执行器或客户端事实源。
3. **合同**：地图使用当前场景有效选择，无显式选择时才回退最新合格图，活动战斗锁原图；读取不生图。开场沿原队列/冻结绑定/回执保存共同阶段一次及本人入场一次，公共和个人均可空，不造秘密或接受任务。v43消息保存在原事件，按实际收件人授权，可非行动者/多人；主持代读不能转述，真实主持角色若为收件人则可。事件/裁定/活动/opening逐片段输出privateParts，不顺带发原输入/判定/Origin，无关席位不发空壳。新空公共根持久PrivateRoot，后续Published不得重开原输入或整组steps；公共续接只投影本事件，非行动者Origin.Input/Label/Clarifications清空，continuationOf指原根，冷历史/详情/更正/战斗召回遵守同一边界。手写转述提交精确source+text（≤1024）；快速转述提交source+quick:true，由现有辅助模型单次生成立即公开，不增加预览或确认；只有明确快速请求可外发，生成回执不随游戏读档回退，模型等待不持战役锁，发布前复核授权/来源/时间线。两种转述只发布所说文字；source修订仍绑定原文，同源不同文字可重复转述，不把源标为全文公开，不授地图权限。原缺省quick且无text的全文请求及回执保留，不向旧pending补新字段。公开副本/席位回执同事务、独立序号，不递增机械Version或重基Run/roll。v43的knownInformation每model slot从原存储读取本人已知相关正文，无host旁路，不建私人流水；0..42目录/旧帧/已开始Run不回填。精确DTO、选择边界归[契约43](../../docs/harness-runtime.md#当前契约43按实际知情范围交付)。
4. **拒绝与恢复**：非法来源 `invalid_story_source`，空白/超长/非法控制字符转述 `invalid_story_text`；非收件人/伪造/不可见/已变且未公开来源统一 `private_story_unavailable`；同请求异文 `idempotency_conflict`。快速请求不可兼有text；disabled/failed/unknown及时间线错误详见业务协议，完整失败无公开、未知外发不补发，generated只重试发布；同ID并发与重启不得重调模型。新工具未知或重复收件人、空消息、无依据discoveryIds、非空新旧私文混用为 `harness_invalid_payload`，全部原子拒绝。普通新行动缺入场 `opening_required`，重复入场 `opening_completed`，现场已变/战斗 `opening_context_changed`；GET不调模型，已失败/未知开场不自动新建重发。共享原回执先于可变限制，但始终先鉴权；来源修订代替机械版本校验。迟到地图/消息响应须按连接、场景/席位和视图代次丢弃。
5. **正常/兼容/拒绝例**：正常为A行动、B/C共同读信、D收不到；B手写或快速转述一句，D只见该句、不见剩余信文/位置。兼容为旧内容缺Opening、旧privateText/无text全文分享及原pending原字节恢复。拒绝按职业编秘密、把主持未揭露资料任意私发、主持代他人转述、让空公共变秘密提醒、借转述授发现或任务。
6. **验收要点**：`KnowledgeVisibilityTests`覆盖多实际收件人各投影/空分页/冷历史/重启、明确转述、真实Pi空完成与相关旧知识、空开场及精确地图释放；同Run私→公→私与后续公开机械步骤，验证即时交付、无原输入泄漏、公共变化保留、冷历史与原请求重放。`QuickRetellingTests`验证单外发、并发、重启、权限/时间线及failed/unknown；`AdventureOpeningTests`、`PrivateStorySharingTests`、`PrivateStoryTests`和v42golden守护旧合同。双端验非行动者canShare、多个PartId、空编辑/取消零写、同源再次转述、同版本同步与原pending/回执；实际Player/headless浏览器另验阅读/焦点/提交/丢响应重载原样retry。fake模型只证明链路，不替代供应商语义质量。
7. **正误**：错误是全文预填后单击广播、给分享增加expectedVersion、以host身份读取所有人的模型知识，或普通私聊释放全部待发现目标；正确是实际收件人手写明确正文，或明确点击快速转述生成一次后直接发布；原请求和生成回执保留，已知快照按实际角色取源，发现逐recipient+discoveryId核验。既有system、旧目录与已冻结槽位不因新合同重写。

## 21. 存档时间线与死亡终局

1. **范围**：战役写入、跨端缓存/待确认请求、存档控制和AI续接。完整API归[DM存档](../../docs/game-saves.md)，跨文件事务归[持久化规范](backend/database-guidelines.md#dm-进度档位与跨文件恢复)。
2. **签名**：快照新增可空`timelineId`与`lifecycle:{status,message,canAct}`；战役变更用`X-DiceRealm-Timeline`。所有存档/读档/重开端点只给DM，不新增模型工具版本。
3. **合同**：每次load/restart生成新timeline；不同timeline允许版本下降，必须清旧活动/地图/运行/分享/等待缓存并使迟到读取失效。pending冻结原header/body，过期不得跨分支重发。服务端授权后在真实campaign gate检查；存档控制原回执先于timeline/版本，首次房号/邀请接纳无header但保留当前权限校验。死亡以权威Dead判定，0HP/Stable不等于Dead；有效已批准队伍非空且全dead才GameEnded，结束后撤销席位不解除。canAct只表示角色生命/终局，不代替审核、归档权限。
4. **拒绝/恢复**：旧分支写409 `campaign_timeline_changed`；死人新行动/roll及普通resume/model外发前拒`character_dead`或`game_over`。v49唯一例外是已接受的战斗主持仍有待交付动作/原队列：允许沿原Run生成已结算动作和终局叙述，不能发起角色新行动；叙述与队列耗尽后恢复拒绝。保留只读、取消、已提交回执和战斗return整理，不允许unknown变回生成。非DM存档403；并发档位修订`game_save_changed`、执行中`game_save_busy`。
5. **正常/兼容/拒绝**：初始缺timeline保持旧契约；新timeline低版本读取可用，旧pending保留过期证据；审核退回仍可重交，不能标成死亡。禁止仅隐藏按钮或把全灭当归档。
6. **验证**：GameSaveTests/GameSaveCombatTests/CampaignLifecycleTests覆盖HTTP权限、丢响应原样重放、未来外发隔离、死者零AI与倒地/空房；Unity真实JsonUtility、pending与新timeline缓存；工作台game-saves测试与真实双端保存→死亡→重开→原席位新行动。
7. **正误**：错误是读档后自动给旧请求换header，或用较大version压住恢复快照；正确是按timeline换分支、只重读当前状态、保留旧请求身份供明确处理。

## 22. 投前难度、交接发言与本地预准备

1. **范围**：修改检定预览、战斗交接业务投影或Harness启动时适用。详细版本合同见[Harness运行](../../docs/harness-runtime.md)与[按需投掷](../../docs/contextual-rolls.md)。
2. **签名**：契约50的`check_request`；`RollPreview/DiceCheck.difficultyClasses?:int[]`；`HarnessRunView.firstCombatInput?:bool`；`IHarnessRuntime.Prepare(CancellationToken)`。
3. **合同**：普通主动检定先有DC；隐匿对抗从真实成功且尚未发现的Stealth结果冻结去重阈值，预览与结果一致且不带身份。作者动作/标准战斗预览复用实际规则。首战斗Run继承父输入仅用于执行/审计，`actionText`与主持progress.input为空；后续独立请求即使同文也展示。Prepare只启动可复用本地worker、预载不可变目录/检查单，不创建Run/场景状态、不外发供应商；实际执行仍重新获取当前上下文。
4. **错误/恢复**：v50普通主动检定缺DC返回`invalid_ruling_check`，零骰零状态变更；全部隐匿失败时沿零骰观察流程登记发现，不拒绝、不制造DC。旧0..49与缺数组旧记录保持原合同，UI不填DC0。预准备失败安全告警，实际行动仍可重新启动worker。
5. **正常/兼容/拒绝**：DC15投前/投后相同；多个真实对抗阈值并列显示；无依据旧记录明确未知。拒绝从检定总值倒推DC、凭正文相同删独立输入或提前调用模型冒充本地准备。
6. **验证**：`NarrativeCheckTests`覆盖缺DC后同轮纠正；`MapIndependentPerceptionTests`覆盖多阈值重启及全失败发现；`HarnessPiTests`覆盖真实进程预准备、复用/失效恢复与作者预览；`RuntimeEncounterHttpTests`覆盖标准搜寻投前/投后；`CombatAgentSessionTests`及`StoryChatTests`覆盖首交接/重启/相同新文；双端验证新增数组与显示。
7. **正误**：错误是前端隐藏所有相同文本、用游戏累计秒数当聊天发送时间；正确是服务端按持久交接标记投影，客户端使用已有`createdAt`显示本地具体时间，缺失/无效时间显示未记录，不补造当前时间。
