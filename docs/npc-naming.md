# 敌人和 NPC 的持久个体名字（契约41）

新创建的敌人/NPC先取得个体名字，再进入地图、战斗与叙事。模型优先依据已经提供的设定拟原创中文名字或合适绰号；服务端只对明确通用标签提供小型后备，不增加独立命名模型调用，也不消费战斗 `IDice`。

## 来源与识别范围

依据 `dnd2024` / XDMG 第84页，Nonplayer Characters → Detailed NPCs → Name；固定资料 revision 为 `e5f3e77b303a92df10487207857200245e71957c`。原文允许选取、改造、组合或自行创作名字，随机表是可选方式，表按音感而非硬性种族分类。要求每个敌人/NPC具名是本产品要求。

取证经过及原文位置见任务 npc-naming-rules.md。运行包只包含原创短中文绰号组合，不分发书中姓名表，不将其标为官方中文译名。模型不能由图标、怪物类型或亡灵身份捏造文化、性别或生前经历。

`Domain/NpcNames.cs` 的有限名单覆盖地精战士、地精伏兵、地精、骷髅、僵尸、伏兵、守卫等明确通用标签及对应英文名；可带普通/全角数字编号和空白、`#＃·._-` 分隔符。例如 `伏兵1`、`地精战士 2`、`Goblin Warrior #3` 会获得后备名。此识别不会认证任意专名，也不会因任意名称末尾带数字而改名：`Twin`、`吕三2`、`Batch 0` 等仍原样保留。

只有生成的后备名避开当前棋盘、队员、同批提供的名字、所选来源/构筑名字及已分配的后备名。显式专名允许有意同名；名字不是实体身份，不合并同名单位。正常一批最多32个棋子，仍遵守原2048个棋盘实体上限。

## 创建与持久化入口

- `POST /api/v1/campaigns/{id}/board/commands` 的新 `spawn`，以及 v41 `token_spawn`，进入同一 `SharedBoard.Execute` / `Create`。新 `enemy` 模板实例与 `custom creature` 使用同一后备方案。具名作者 `npc` 来源优先保留 `ContentNpc.Name`，完整NPC建卡保留校验后的 `Build.Identity` / `Character.Name`。通用外观遇到具名敌人来源时使用来源名，模型已提供的敌人专名保留。
- 玩家始终取实际角色名字；`object`、`ExistingId`、已经建立的作者NPC来源实例与运行时遭遇实例不自动改名。重现已有实体不能换名字、回血或改来源。空/非法名称仍沿原校验拒绝，不将缺失输入伪装成成功。
- `RuntimeEncounters.Prepare` 在返回的新 `ContentEnemy.Name` 中保存个体名。`Establish` 把这个名字直接复制给 `BoardAppearance.Name`；不会在建立棋子时再次起名。开战的 `BoardCombat.Prepare` 继续从实际棋盘实例复制到 `CombatUnit.Name`。
- 没有棋盘的旧开战路径也覆盖：`CombatEngine` 和 `StandardCombatEngine` 在创建新战斗单位时为通用模板名起名，保存到 `CombatUnit.Name`，先攻和后续战报取同一名字。导入的 `Adventure` / 作者模板不改写。棋盘路径直接使用已保存外观，不在开战时替旧棋子补名。
- 名字随原战役事务及回执保存；读取、渲染、存档加载、重放不生成或补写名字。没有新数据表、命名服务、用户开关或正式存档批量迁移。

读取实际名字用棋盘响应 `board.tokens[].{id,name}` 或 `GET /api/v1/campaigns/{id}/board/tokens/{entityId}` 的 `name`。`encounter_prepare` / `encounter_read` 返回的 DM-only `encounter.definition.enemies[].name` 与 `roster[].name` 是运行时遭遇的权威创建结果；隐藏名单与个人发现继续按原受众边界处理。

## 显式改名与世界记忆

现有 HTTP `operation=update` / v41 `token_update` 只提交完整 `appearance`。显式改名不会再触发后备生成。当前匹配 `BoardEntityId` 的**非玩家活动** `CombatUnit.Name` 在同一原事务同步；不按名字查找关联，不修改已经关闭的战斗、旧 `CombatEntry` / `Presentation`、事件或回执。玩家外观名字仍由角色权威名字覆盖，其他外观字段照常更新。

v41 `world_record(memory[].kind=npc)` 要求新人物使用个体名字。明确通用的新 NPC 名称以原 `invalid_world_memory` 拒绝，整份工具事务不保存，由已有工具参数纠错流程继续本轮；不单独请求命名模型。已经存在的世界记录不因新策略自动改名。世界记忆没有实体绑定，服务端不会通过同名猜测关联，也不会自动将棋盘改名传播到世界记忆。模型应先创建必要的遭遇/棋子，再复用返回的实际名；已有世界记录仍须使用本轮提供的准确 memory ID。

## 版本门槛与服务端接口

`HarnessTools.CurrentVersion=41`；v41 从未改动的 v40 目录派生，仅补充 `encounter_prepare`、`token_spawn`、`token_update`、`world_record` 的命名说明，schema不变。`ForVersion(40)` 有独立显式分支，0..40描述及其引用的旧工具数组不改。

领域/应用私有方法尾部增加内部参数 `int namingVersion = NpcNames.Version`（当前值41），不接受HTTP/model自报版本：

- `SharedBoard.Execute(..., bool narrator=false, bool controlPlayers=false, int namingVersion=41)`。
- `RuntimeEncounters.Prepare(..., BattleCell[]? terrain=null, int namingVersion=41)`。
- `CombatEngine.Resolve(c, kind, target, int namingVersion=41)` 与 `StandardCombatEngine.Resolve(...)`。
- `WorldMemories.Plan(..., int originSequence, string source, int namingVersion=41)`。
- 应用内部 `ExecuteBoardCommand`、`PrepareAction`、`ExecuteAction` 将版本转交实际创建处。普通新HTTP使用默认新策略，Harness工具显式传入冻结的 `toolContractVersion`。

延迟确认也冻结策略：私有 `PendingIntent.NpcNamingVersion` 与 `PendingRoll.NpcNamingVersion` 只在新创建策略下记41；缺失/0是旧策略并在序列化时省略。新普通意图创建时置41；Harness行动候选按本Run版本保存；先攻组保存在组长投掷，后续全员确认从组长继续。旧棋盘确认、旧候选和旧投掷继续使用0，不能在玩家通过普通确认端点时被隐式升级。该字段不出现在公开pending DTO、请求指纹或工具schema中。

0..40运行的遭遇准备、棋盘新建/外观更新、无棋盘开战及世界记忆执行均显式走旧分支。其已有名字、原工具输出和原回执不回填。新Run遇到已经保存的旧编号实体也不会自动改名；需要改名时只走有授权的原显式更新命令。

## 验证依据

`NpcNamingTests`覆盖遭遇准备零骰、definition→地图→战斗同名及隐藏边界、HTTP同批后备避撞、作者/玩家/object/ExistingId保留、SQLite重启与回执、两种无棋盘开战、活动单位按ID同步且历史不改、延迟先攻跨重启及缺字段旧策略，以及真实Pi/MCP配合脚本模型的v40/v41执行与世界记忆纠错。

`HarnessExecutionProtocolTests`对照独立旧v40运行包导出的黄金目录，0..40保持冻结；共享棋盘、遭遇、投掷与世界记忆受影响回归通过。实际候选、真实模型与客户端验收证据统一见本机 `.trellis/research/archive/deliveries/combat-story-delivery/DELIVERY.md`，不把脚本模型回归当成真实语言质量验证。
