# 输入驱动冒险：角色审核、主输入与世界信息协议

后续源码增量：[可执行自身效果与检定后果](natural-action-effects.md)、[确认路线与地图关联](world-maintenance.md)、[8192条世界索引与分页](world-memory-storage.md)。后续容量／执行合同以这些模块文档为准，以下256条等数字保留原阶段背景。

> Harness 战役拒绝本页的 `/actions/input`、`/actions/interpret` 及旧意图 clarify（避免双模型执行），改用 `/harness/runs`，见 [Harness 运行](harness-runtime.md)；本页协议适用于非 Harness 战役。

本页是这批跨端增量的**字段与恢复协议**。既有按钮行动、自然语言旧入口、按需投掷和主持剧情后果分别仍见 [客户端协议](client-contract.md)、[旧意图协议](action-understanding.md)、[按需投掷](contextual-rolls.md)、[行动连续性](adventure-continuity.md)。所有路径相对 `/api/v1/campaigns/{id}`；当前席位须携带 bearer。普通命令成功返回 `{snapshot,resolution,replayed}`；JSON camelCase、拒绝未知字段。`requestId` 是 UUID，`expectedVersion` 是**战役**版本（不是地图版本）；未确认传输要保留原端点、ID、完整请求，原样重试，不重掷、不按新版本自动改写。校验请求身份/形状后，已接受原回执在版本、归档、冻结意图或记录修订等**可变条件之前**查找；同 ID 改 payload 为 409 `idempotency_conflict`，不同席位不能互用。草稿不是已发送请求。

## 角色审核与玩家权限

`GET /campaigns/{id}` 的 `snapshot.party.members[]` 带 `review:{revision,status,submission,reason,reviewedBy,reviewedAt,source}`；`status` 为 `pending|approved|returned`。新加入席位为 `pending`、修订 1；`source=host_creation` 的主持自建角色直接 `approved` 仅见于旧存档（主持连接现在不带角色，新战役不再产生）。旧存档缺失 review 视作 **legacy approved**（`revision=0,source=legacy`），只保证既有游玩权限，不冒充实际人工审核。本人及主持可读审核原文与角色建卡详情；其他席位的审核说明与私人人物经历不得下发。规则建卡合法不等于 DM 批准。待审、退回角色可阅读/补充并重交，**不能执行冒险行动**；批准后队员可在原有规则/位置/队伍条件下发起日常 `travel`、`combat.start`，并非获得管理权限、任意旅行或战斗豁免。主持仍负责批准，日常行动不用逐条审批。

- 主持 `POST characters/review`：`{requestId,expectedVersion,actorId,revision,decision:"approve"|"return",reason}`。只审核当前 pending 修订；退回时 reason 必填（最长 1000）；批准须满足安全位置、无战斗/未完成投掷等接纳条件。冲突 `character_review_changed` / `party_unavailable`；非主持 403。批准、退回的记录与回执持久化。
- 队员 `POST character/resubmit`：`{requestId,expectedVersion,revision,submission,characterName?,templateId?,creation?,build?}`。只有本人当前 returned 修订可重交；submission 必填、最多 1000 字；可仅补充说明，或提供完整新建卡所需的角色名/模板与选项，保留原席位/角色 ID，不重置已经批准的角色。审核状态转 pending、修订递增。该端点最多 64 KiB 请求正文；主输入中 `重新提交审核：说明` 仅提交说明。旧存档中的主持自建角色不能走此入口。

## 玩家主输入及等待接续

`POST actions/input`：`{requestId,expectedVersion,kind:"natural",target:"",text:"…"}`，复用 `ActionRequest` 的**五个字段**；非空文字最长 1000，不能带骰点、HP、DC、额外执行字段。新输入用单次权威事务决定续接已有状态或建立新意图，返回当前快照与原判定：

1. `重新提交审核：说明` 先走本人退回角色的重交；不是审批决定。
2. 有本人 `pendingRoll`：只有明确 `投掷` / `掷骰` / `确认投掷` / `确认掷骰` / `roll` 授权掷骰，或 `取消` 放弃；`好`、模糊说明、关闭窗口不会掷骰，也不能代队友确认。仍遵循 [按需投掷](contextual-rolls.md) 的冻结/团队生命周期。
3. 有本人 `pendingIntent`：`取消` 放弃，`交给DM` 升级；唯一候选可用 `确认`（以及明确列出的同义词）选择，多候选须输入编号/完整名称，不默认选第一项；其余有效输入为补充说明（至多 3 次）。处于过期/不可用状态时明确取消旧意图，不自动重基。候选命令仍由服务器冻结并复核，来源和成本需要显式确认；已可安全直达的部分已导入行动可直接进入规则执行或待投掷，不能把所有角色操作都视作已执行。
4. 无等待态：新描述进入有界 typed director；孤立的“确认”/“投掷”/“取消”拒绝为 `input_context_required`。无候选或模型不可用时转澄清/确需人工判断才裁定，不伪造已执行效果。

等待状态和问题/候选/投掷说明在主故事正文可读，主输入可直接续接；辅助 `Intent` / `Roll` 面板是可选阅读/操作入口，**不因新等待态强弹**。`pendingIntent` 及未发布原文/补充仅本人可读；选择或转裁定才公开。`Resolution.intentId` 关联唯一 `intent.request` 根，不创建另一条玩家行动。旧 `POST actions/interpret` + `POST intents/respond` 仍保留原指纹、单候选待确认、原请求恢复行为；旧 `/actions` 与 `/actions/propose` 同样不迁移已发请求到新端点。输入同 ID 原回执先于可变条件，重启/归档后原样重放不能再次执行或外发模型。

## Typed director 与非机械世界记忆

输入解释结果严格为 `action|clarify|narrate|adjudicate`。`action` 只指向一个**已提供**候选 ID，`clarify` 提问并可列最多 6 个候选，`adjudicate` 不带执行候选；只有 `narrate` 可给最长 4096 字非机械叙事及 `memory` 提议，不得同时提供候选或确认规则结果。动作/澄清/裁定不得预写叙事或记忆。候选、最近公共处境及已公开的 `known_memory`（最多 32 条）/`known_scenes`（最多 64 个）由服务器裁剪；模型只能更新**本次上下文已提供**的公开 memory ID、关联已提供的已知场景 ID；不传私有剧本全文、内部 facts、隐藏记录、凭证或整张角色表。上下文的序列化外发上限 128 KiB。

`narrate.memory[]` 每次最多 6 条，每条为 `{id,kind,name,summary,status,sceneId}`：`id:""` 新增（服务器产生 ID），或本次提供的现有 ID 用于同类修订；`kind=npc|quest|place|clue`，`status=known|active|resolved`；名称最多 80 字，摘要最多 800 字；`sceneId:""` 表示位置未知，不能硬落地图。战役最多 256 条，重复同类名称、未知/隐藏 ID、未公开场景、超限或不合法整组拒绝，**不写半份 memory**。`snapshot.worldMemory[]` 为公开 overlay：`id,kind,name,summary,status,sceneId,revision,originSequence,updatedSequence,actorId,source,hidden`；玩家只收到未隐藏的当前记录，主持可读隐藏记录。来源序号归于原行动，更新修订不篡改原行动/已启用的 AdventureDocument。叙事和 overlay 不能写事实、数值、HP/DC、奖励、物品、任务机械完成条件、路线或图面坐标；`place` 记录不自动变成地图节点/旅行权限，未知坐标只以文字呈现。坏输出/超时进入未执行澄清，保留输入，不伪装成功或收费调用已通过质量验收。

导入的 **Intent 和 Narration 两段 system prompts 原文**用于新 `Direct` 请求，不拼接内置默认 system prompt；旧 `{kind,target}` 响应仍可在当前合法场景候选内兼容映射，不能据此宣称它支持完整新协议。没有 `TextAi:ApiKey` 和 `TextAi:Model` 时用受限 `OfflineText`；只提供部分离线匹配/升级，不能宣称已验证在线理解与叙事质量。`OfflineTrial` 在服务端强制离线；不通过前端开关或 fake-provider 测试暗示真实供应商效果。配置真实文本模型和额度属于另行授权工作。

## 主持纠错、公开性与草稿恢复

- `POST world/correct`：`{requestId,expectedVersion,memoryId,revision,name,summary,status,hidden,reason}`。主持对**当前记录修订**更正/隐藏，reason 必填最多 1000 字；不能改来源、sceneId 或机械效果，冲突 409 `world_memory_changed`，非法记忆 400 `invalid_world_memory`。事件 `world.correct` 带 `GameEvent.HostOnly`，包括理由的审计只在主持快照、历史/导出中可读；guest 只读已过滤的当前 `worldMemory` 投影，不能仅靠前端隐藏。
- `POST adventure/correct`：`{requestId,expectedVersion,originSequence,text,reason}`，正文最多 4096、理由最多 1000；只接受**原玩家行动根**的精确序号且须已发布，禁止纠正别人的未公开 `pendingIntent` 以绕过保密。无权根 404 `activity_not_found`；`snapshot.adventureCorrections[]` 按根保存更正，在当前正文/活动中覆盖显示，可按原记录查看原叙事与原规则结果。新更正覆盖当前更正但保留先前审计事件；不重掷、退款或反转已执行状态。

主持纠错走独立权威命令，校验权限、战役版本、对象修订/精确根、理由，并存事件和原请求回执。`world.correct` 的当前投影会过滤隐藏信息，**不能保证收回此前已经公开、被客户端缓存/复制/导出的文字**；修订也不从旧事件中抹除历史。普通未发布意图不能凭主持纠错突然公开。

工作台草稿和持久待确认请求分开；发送时冻结版本、修订、表单正文及本地草稿修订（后者仅本机，不进 API）。提交已获 2xx/重放确认，即使随后 `GET` 失败也算成功，旧草稿不得复活；迟到的旧回执只清与该次发送修订/版本匹配的草稿，不能删后来新写的内容。版本或记录修订失效时给出明确 **discard 并重新读取** 的操作，禁止静默 rebase 或自动覆盖。断线/超时/5xx 则保留原 payload/端点/ID 以原样重试，直到取得明确回执。

## 可验证边界

正常：已批准队员从主输入问话→`narrate` 保存有来源的线索→玩家正文、手记与地图上下文看见未定位文字；随后主持改正叙事或隐藏记录，玩家只读新投影。兼容：旧无 review 成员仍可行动，旧 `interpret` 请求原样重放且不迁移指纹。拒绝：pending 队员发起旅行、`好`触发投骰、模型引用隐藏记忆或编造场景、主持纠正未发布根、stale 草稿直接改 expectedVersion、确认成功后 GET 失败导致重发新 ID。

验证断言按 [服务端 WorldMemoryTests](../tests/DiceRealm.Tests/WorldMemoryTests.cs)、[角色审核](../tests/DiceRealm.Tests/CharacterReviewTests.cs)、[主输入](../tests/DiceRealm.Tests/AdventureInputTests.cs)、[工作台草稿](../client-workbench/tests/world-memory.test.js)、Unity 输入/正文 选择受影响用例：授权/越权、零骰零资源、原回执并发/重启、拒绝时零世界写入、隐藏信息贯穿读面、旧数据缺省、纠错正文与规则留痕、工作台刷新失败与新草稿隔离。无真实供应商质量结论、无程序生成完整世界或图上路线的承诺。
