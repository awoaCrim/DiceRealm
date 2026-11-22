# Harness P2：服务端工作区合同

**当前边界：**本页的 `/harness/workspace` HTTP 合同、独立版本/回执/冻结运行/内容包仍有效。工作台入口是「剧情与地图 › 叙事设定」（`#/prepare/settings`，旧 `#/content-settings` 为别名），见[业务冒险与设定](adventure-sessions.md)：分别保存草稿、发布版本、明确启用；旧请求保持原端点和原请求体重试。

本阶段接续 [P0/P1 运行器](harness-runtime.md)，为已创建的 Harness 战役提供主持工作区。更换预设或 Skill 不需要重新编译；只影响之后新接受的 Run。旧战役不会自动转换。后续已以[业务冒险接口](adventure-sessions.md)接入工作台与Unity。

## 使用流程

在工作台连接已有 Harness 战役，打开「剧情与地图 › 叙事设定」。主持可以编辑预设 ID、预设版本、system 原文以及逐项 Skill；不会填入默认故事或探索提示词；战斗默认稿见下文。工作台把本地草稿和待确认请求按服务地址、战役和凭证摘要隔离保存，关闭页面后可以恢复。服务端保存的草稿可供另一台已授权工作台读取；未保存到服务端的本地改动不会自动上传。

1. 编辑并预览，校验格式和实际原文。预览不会保存版本、推进游戏或调用模型。
2. **保存服务端草稿**。此时尚未发布，也未改变运行绑定。
3. **发布已保存草稿**，生成不可覆盖的绑定版本；尚未保存的本地编辑不在本次发布中。
4. 检查版本后明确激活。选择较早版本并激活即回退；当前草稿和已经接受的运行不因此重写。
5. 根据需要下载选定版本内容包，可明确选择包含当前服务端草稿。

探索 `systemPrompt` 与可选战斗 `combatSystemPrompt` 是两份独立正文，工作台分别编辑/导入，沿同一 draft→publish→activate 保存链采用。契约54起，未配置战斗正文时由服务端内置 `content/prompts/dm-combat.md` 提供独立默认稿，不截取探索提示词。业务设置响应的 `defaultCombatPrompt` 供工作台显示；`active/draft.combatPrompt` 仍表示实际保存的自定义稿，读取不写回预设。清空自定义稿后保存恢复默认；只编辑探索正文不会把默认稿固定为自定义稿。战斗委派时冻结实际正文、版本和哈希，已开始的战斗及旧Run不随更新替换。同一预设 ID/预设版本的任一正文不可替换；修改原文须增加预设版本。只修改 Skill 可以保留同一预设版本，但仍会发布新的绑定修订。预设版本是用户命名版本；绑定修订是服务端递增的整组内容版本；工作区 version 是保存/发布/激活命令的并发版本，三者不可混淆。

服务器拒绝旧工作区版本时，保留本地文字并显式比较/重新载入，不自动合并或换版本重发。断网、5xx 或无效成功体可能已经提交：只重试已保存的原请求，不更换 ID。工作区请求与普通游戏待确认命令分开，不能用游戏 expectedVersion 提交。

## HTTP 合同

路径前缀 `/api/v1/campaigns/{id}/harness`，使用原 `Authorization: Bearer ...`，响应 `Cache-Control: no-store`。工作区配置、历史、预览、导出只允许主持；`GET /memory` 返回当前凭证对应席位的投影，主持不能指定其他 actor。

`Profile`：`{preset:{id,version,systemPrompt,combatSystemPrompt?},hash,skills:[{id,description,content}]}`。`combatSystemPrompt` 可空且 null 省略，保持旧 profile/hash 和请求回执；提供时与探索正文一样限制为 1..32768 字符、不得全空白或含禁用控制字符，原文不 trim。

`Workspace`：`{version,activeRevision,latestRevision,draft:Profile,active:Profile}`。初始只读视图为 version=1、activeRevision=latestRevision=1，取创建战役时导入的 profile，不写工作区目录。

`CommandResult`：`{workspace:Workspace,replayed:boolean}`。同 ID 同正文重放确认原命令，返回当前工作区视图；不会再执行效果。不同正文/端点复用 ID 为 `idempotency_conflict`。

| 方法/子路径 | 请求及结果 |
|---|---|
| `GET /workspace` | Workspace |
| `POST /workspace/preview` | `{preset,skills}` → `{profile}`；纯校验 |
| `POST /workspace/draft` | `{requestId,expectedWorkspaceVersion,preset,skills}` → CommandResult |
| `POST /workspace/publish` | `{requestId,expectedWorkspaceVersion}` → CommandResult；发布服务端已保存草稿 |
| `POST /workspace/activate` | `{requestId,expectedWorkspaceVersion,revision}` → CommandResult |
| `GET /workspace/revisions?before=N&limit=20` | `{items:[Revision],nextBefore:int|null}`，降序、before 排他，limit 1..50 |
| `GET /workspace/revisions/{revision}` | `{revision:Revision,profile}` |
| `GET /workspace/export?revision=N&includeDraft=false` | `application/zip`；默认 activeRevision，不带草稿 |
| `GET /memory` | 下述只读记忆 |

`Revision` 为 `{revision,hash,presetId,presetVersion,createdAt}`；初始修订 createdAt 使用固定 Unix epoch 表示没有历史发布时间。新发布使用服务器时间。每个新成功变更将工作区 version 加1；不改变游戏 version、HP、资源、时间或事件，也不进行任何模型外发。

限制沿用原 profile：预设 id 1..80，字符为字母数字及 `._-`，version 正整数，system 1..32768 字符且不能全空白；最多16个唯一 Skill，ID同规则，description非空且≤240字符，content 1..16384字符，合计≤65536字符。正文允许 CR/LF/TAB，不允许其他控制字符。正文不 trim。相同内容 hash 已发布时返回 `workspace_already_published`，应选择已有修订，不制造重复版本。

其他错误：400形状/内容无效；401无效/撤销凭证；403非主持；409 `harness_campaign_required`、`workspace_stale_version`、`workspace_preset_conflict`、`archived`；404 `workspace_revision_not_found`；409 `workspace_corrupt/workspace_missing` 保留损坏记录并拒绝静默重建。I/O/提交未知错误为5xx，必须保留原请求恢复。身份授权在回执前，原回执在版本和归档等可变限制前。

## Run 与记忆

新 Run 在同一已授权战役 gate 内核对游戏版本并抓取当前 active profile 和记忆。Run 的 Profile 已含完整 preset/Skill；后续 `skills_list/skills_read` 从该冻结副本读取。激活不同绑定不会使已接受的运行失败，也不会偷偷替换暂停后恢复的 system 或 Skill。权限仍在每次回调重新核对；撤销席位仍会阻止执行。

v36起战斗子会话在委派时冻结独立战斗 profile，后续每条战斗输入沿此绑定及本人独立历史执行；更换工作区只影响之后新会话，不改正在进行的战斗。返回后原探索 Run 仍使用自己的冻结正文，不接收整段子代理原生工具历史。详见[持续战斗子会话](harness-runtime.md#持续战斗子会话契约3637)。

记忆是从当前席位已公开、已完成的 Harness 行动生成的有界投影，不是模型自动写入的另一套世界事实。响应：

```text
{ version, actorId, entries: [
  { intentId, originSequence, resultVersion, input, narrative,
    narrativeSource, corrected,
    steps: [{version,status,kind,summary,rollId}] }
] }
```

最多12条，input≤240字符、narrative≤800字符、每条最近最多4个已完成规则步骤（summary≤240字符），序列化整体≤24KiB，超过则移除最早条目。`originSequence` 对应原 `/activity/{sequence}`；那里可阅读完整公开行动、检定和消耗来源。规则步骤是已保存结果的摘要，叙事只是叙事，不代表当前 HP/资源，也不能据此再执行一次。

不发送其他席位输入、未公开/取消草稿、尚待投掷/确认/裁定的结果、内部 facts、完整原剧本、工具/模型内部过程或主持更正理由。已公开叙事有更正时投影采用当前公开更正文本并标记来源；不会篡改原始记录或机械结果。

新 Run 持久可空 `MemorySnapshot`，并将同一快照放在第一个用户数据 turn 的 `memory` 字段；system 仍完全等于所选预设原文。后来新行动或更正不重写旧 Run 的输入和指纹。P0旧运行没有该字段，原 turns 原样保留并兼容读取/重放；不自动重建旧上下文或调用模型总结。

## 入场与主动公开上下文（工具契约38）

v38 新运行在新模型槽位的执行帧中提供 `narrativeContract` 和 `sharedStories`：后者带公开记录总数、最近12条准确原文及原角色/来源。`story_shared_read({after,limit})` 从独立分享序号向后读取，after=0 从最早开始，limit 1..8，沿 `nextAfter` 分页；不读取未公开私人字段，不授予行动/对象引用，不写状态或另调模型。公共叙事使用第三人称，私人叙事使用第二人称；已公开引文的“你”仍指原角色，不能因此替全队建立发现、行动或已接受主线。来源：[HarnessStoryContext](../server/DiceRealm.Server/Application/HarnessStoryContext.cs)、[v38目录](../server/DiceRealm.Server/Application/HarnessTools.cs)。

启用作者开场配置的房间还会提供 `frame.opening`。受信 `Run.Opening` 生成期只允许 `opening_commit` 与 `context_read/skills_list/skills_read`，清除工作情境的 `dmOnly` 证据；公共现场只保存一次，后来入场只写本人可空补充。后续 v38 普通新模型帧把已保存公共开场和**当前角色自己的**个人补充作为历史，不读取其他角色未公开补充；当前地点与后来事实优先，不重演入场。实现：[HarnessOpenings](../server/DiceRealm.Server/Application/AdventureOpeningService.cs)、[帧捕获](../server/DiceRealm.Server/Application/HarnessExecutionService.cs)。

这些是独立的受众投影，不改变上文 `MemorySnapshot`、`GET /memory` 或历史召回“本人已公开已完成行动”的资格；普通事件/裁定的 `privateText` 不会因此自动进入长期记忆。主动公开按原字段修订保存公开副本，不自动启动模型、不推进机械版本、不重基待投掷或活跃 Run。完整HTTP/并发/恢复合同只维护在 [入场与私人分享](adventure-sessions.md#入场开场共同一份个人一次)。

用户 system 原文及已接受运行的 profile/Skill 绑定不改。工具契约0..37的目录、帧和回放指纹保持原合同；已保存模型槽位不补入新分享或个人开场。只有v38的新槽位捕获当时允许读取的上下文，不能把新的公开知识混进旧冻结请求。

## 按需历史召回（工具契约2）

以下是保留不变的关键词工具合同；新契约5的本地语义匹配、自动摘要与上下文压缩见[长期记忆](harness-long-memory.md)。

初始12条冻结记忆之外，新运行可使用 `memory_search` / `memory_read` 查询更早的**本人已公开且已结算行动**。工具由 `HarnessRecall` 在已授权战役gate内派生，不读取私有Run原文、不建立额外权威存储，也不调用另一个模型/嵌入服务。关键词检索不是语义检索、全战役总结或团队共享记忆。旧工具契约0/1没有这些工具；旧运行不自动升级，目录描述/schema/回放指纹保持不变。

### 参数与输出

`memory_search({query,before?:0,limit?:6})`：query必填，0..120字符，无控制字符；按空白分词最多8项，所有词分别在完整原输入、**当前公开更正后的**叙事或已结算步骤摘要中以OrdinalIgnoreCase匹配。空白query浏览历史。before为排他的原行动根序号，0表示最新，不能为负或超过当前读取version；limit为1..6。按根序号降序，不受近期12条限制。

```text
{version, scope:"own_completed_public_actions",
 entries:[{intentId,originSequence,resultVersion,input,narrative,narrativeSource,corrected,
           steps:[{version,status,kind,summary,rollId}]}],
 nextBefore:int|null}
```

摘要裁剪沿用上述240/800/最近4步骤；匹配在裁剪前进行，因此命中词不一定出现在摘要内，可再读取详情。序列化结果最多24KiB，因字节上限缩短页面仍返回下一游标；`nextBefore=null`表示当前查询没有更多匹配。继续分页须保留同一query，将nextBefore原样作为before；它不是event分页的through，也不冻结未来读取的全库内容。

`memory_read({intentId})`：标准UUID，大小写等价；可以读取任何符合本人公开完成条件的已知ID，不要求先search，不接受actor、战役ID或文件路径。

```text
{version, scope:"own_completed_public_actions", entry:{
 intentId,originSequence,resultVersion,input,narrative,narrativeSource,corrected,totalSteps,
 steps:[{version,status,kind,summary,rollId,check:DiceCheck|null}]
}}
```

返回完整已保存输入和当前公开叙事、最多最新8项已结算步骤（summary≤240）及**原DiceCheck**，含有无DC、规则来源、骰点/修正/总值，不推导缺失值。totalSteps为全部合格步骤数，不能把局部列表称为完整记录；48KiB上限会进一步移除最旧步骤，不编造替代结果。原根序号仍可连接 `/activity/{sequence}` 的完整公开行动和消耗来源。`resultVersion`是原行动结果版本，外层version是本次读取版本；公开更正不改原检定/结果版本。不返回更正理由或旧叙事作为搜索备用内容。

### 权限、恢复与错误

资格与初始记忆共用：当前可信席位、harness来源、published、completed且最终结果不处于投掷/确认/裁定/取消。主持作为玩家同样不能读取其他席位、私有或未结算输入。检索只依据授权数据，不以不可见记录生成计数/游标。读结果是历史数据，不是指令或当前角色状态；不提供候选ID、不赋予执行权限，后续行动仍须当前context/list及原本人确认。

每次新查询重新授权并验证run cursor；无关外部写入仍stale，不自动换版本。输出反映**工具调用时**的公开投影；成功落入当前Run步骤后原样重放。未来纠错只改变新读取，不改已有MemorySnapshot、Turns或工具回执。只读工具登记后、结果落盘前中断可在同版本重新派生；版本已变则拒绝，不能把新投影冒充旧回执。GET、重开、原请求重放均不启动查询或模型，也不取消/掷骰/写游戏事件。召回工具照常计入既有工具次数和上下文字节限额，未放宽128KiB模型上下文或累计预算。

| 条件 | 结果 |
|---|---|
| 缺query、null/重复/额外字段、非法类型/长度/词数/游标/limit/UUID | `harness_invalid_payload`，无游戏写入 |
| 不存在、他人、私有、取消、未结算的合法UUID | 同一404 `harness_memory_unavailable`，不泄露对象存在性 |
| 凭证/席位不符或撤权 | 401 `unauthorized` |
| 游戏版本变动 | 409 `stale_version`；不自动重基 |
| 旧契约调用新增工具 | `harness_tool_unavailable`；若是已发模型返回非法工具，则保持模型输出未知语义，不伪称零外发 |
| 输出或累计模型上下文越界 | `harness_context_limit`；不隐式压缩/总结/扩大预算 |

实现复用已加载聚合中的公开行动，尚未引入大规模数据库全文索引；输出有界不等于扫描成本恒定。验证入口 `HarnessRecallTests` 覆盖中文/大小写AND、摘要外关键词、长历史与字节分页、公开更正、原检定、席位/战役/撤权与零写入，真实业务API→Pi/MCP下15条行动召回第1条、等待/重开/原输出重放，以及冻结0/1目录与旧v1恢复；另覆盖48KiB缩减只移除投影最旧步骤，不改原Check/totalSteps，以及召回不破坏同版本已有合法候选授权。全部使用fake模型；未证明真实供应商一定选择最优检索词或完成长期叙事质量验收。

## 持久化与导出边界

`DataPath/workspaces/{campaignId}/documents/{profileHash}.json` 拥有不可变 profile 原文。`workspace.sqlite` schemaVersion=1 拥有 state(version/active/latest/draft/bootstrap)、不可变 revisions 与按 actor/request 索引的 receipts。版本/回执不裁剪，不设“用满若干版本就永远不能继续”的历史上限；历史分页读取。

只允许受支持的编辑/发布入口，不自动监视或执行本地文件修改。先校验并写不可变文档，再在SQLite事务内更新索引/指针/回执；失败最多留下无引用源文件，不留下半激活。已存在同hash文件必须验证，不覆盖坏原文。Campaign.Harness 保留初始导入，首次初始化在已授权战役gate内，先用独立的短 metadata 提交持久 `HarnessWorkspaceInitialized`，再写工作区目录和事务；之后目录丢失/初始化中断都会拒绝，不会退回bootstrap。标志写失败时尚未发布目录，工作区事务成功后的外层保存失败仍可原请求重放，不重复命令。已经置标志但目录没有完整发布的中断初始化需要恢复一致备份，不能自动把它视为新工作区。游戏SQLite schema不变。

导出在同一授权战役 gate 抓取一致内容后，锁外组装ZIP，包含：

- `selected/profile.json`、`selected/preset.md`、`selected/skills/01.md...`：所选绑定、system/Skill原文；原始 Skill ID/描述在profile中保留。
- 所选绑定提供战斗正文时另有 `selected/combat-preset.md`，保持原文；缺省时不补造文件。
- 可选同形状 `draft/`：当前**服务端**草稿，不含浏览器未上传的本地草稿。
- `adventure.json`：主持原冒险来源（可能含主持秘密，内容包应保护）。
- `memory.json`：导出席位当时的上述只读公共记忆投影。
- `manifest.json`：格式、schema、战役/游戏/工作区版本、选定修订、每个有效载荷文件的角色/路径/字节数/SHA256。manifest本身不自列hash。

路径完全由服务端生成，不接受文件路径。ZIP接口供带Bearer的fetch读取，不设置attachment；工作台取得完整Blob后给出下载文件名。内容包没有凭证、供应商key、其他席位Run或原始推理。**这是选定内容的可携带包，不是完整游戏备份，也没有自动导入恢复权限/完整存档的功能。** 全数据迁移仍需正常停服后备份整个DataPath，包括campaigns/harness/workspaces/额度/地图目录；不能把在线散拷称为一致备份。

## 验证与限制

回归入口 `HarnessWorkspaceTests` 覆盖原文、独立版本、并发回执/冲突、发布/回退、重启、初始化标志先落盘与丢目录拒绝、事务失败回滚、坏源文件/未来schema/丢目录拒绝、冻结运行与Skill、记忆隔离/更正/上限、旧Run兼容、导出逐文件hash与凭证排除。工作台测试覆盖专用API与本地草稿/原请求恢复；真实浏览器验证需使用重建后的嵌入资源服务端。

所有开发验证使用临时数据、独立端口与fake模型；真实Pi/MCP进程回归沿用P0/P1，不使用真实收费供应商。不将这些证据称为线上模型质量或部署验收。
