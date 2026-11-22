# 成长来源的移交与可重复身份

## 1. 范围

`AdvancementEngine` 拥有一级授予向当前职业状态的移交、祈唤来源撤销及绑定实例资格；`AdvancementSheet` 投影实际当前施法路线。取得资格不代表战斗效果自动执行。

## 2. 签名

既有 `Evaluate(Character, AdvancementDraft, maxLevel)` 和 advancement preview/apply 不变。`AdvancementClass.OptionalFeatures` 保留 string[]；普通能力为 definition ID，三种绑定祈唤为 `definitionId/cantripId`。`AdvancementBonusSpell.Mode` 增加受限 `at-will`，仅用于已拥有 Armor of Shadows/Mage Armor/self 和 Pact of the Chain/Find Familiar/magic-action 两个完整源组合。

`CharacterAdvancement` 的 schema1 追加 nullable `FeatSources`、`RetiredResources`，null 序列化省略。来源记录为 `(Id,Feats,Skills,Expertise,Tools,Weapons)`，每角色最多 11 份（permanent + 10 Lessons）；退休资源为 `(Name,Current,Maximum,RestBoundary)`，最多24份。`HitPointIncrease` 表示本次最大 HP 净差，有来源账本时可为负，客户端不能将字段名解释成始终正数。

## 3. 契约

明确升级的候选状态才执行移交：首次成长将 Thaumaturge/Magician 原额外戏法并入对应职业 Cantrips，移除唯一旧 grant；即使本次升级另一职业也执行。已有旧成长记录保留已选择职业戏法，只在新 apply 中删除重复旧 grant。原 Build、旧 Steps、其他来源不重写。

初始 Warlock 旧 invocation grant 改归当前 OptionalFeatures；替换后不保留旧法术或特性标签。无槽施法的目标/动作/材料限制保留在投影，不把所有 innate metadata 当任意施法许可。读取旧记录不做隐式写修复。

Agonizing Blast/Eldritch Spear/Repelling Blast 各实例占一个名额，同定义可重复但不能绑定相同戏法。资格使用本次 draft 的当前 Warlock 戏法；Spear 必须 point、至少 10 feet、伤害戏法；Repelling 必须攻击掷骰。替换上限比较完整实例。旧单 ID + `optional:<id>:cantrip` Choices 读兼容，明确升级候选才转为实例身份并清过期当前 Choice，旧取得步骤保留。

Lessons 以 `lessons-of-the-first-ones/<Origin-feat>` 作为实例，同祈唤不能重复同一专长。首次采用时将此前独立常驻贡献保存为 permanent；之后所有永久技能／专精／工具／武器／专长取得走 `GainTraining` / `GainFeat`，即使当前已由临时来源提供也要记录新来源。替换仅删除该实例贡献，实际属性取并集；专精只有当前仍熟练时生效，独立来源本身不删除。Tough 按新旧拥有状态的总等级差额调整最大 HP，伤势保留、当前 HP 最低0、原0HP不复苏。

Magic Initiate 用现有来源选择／每级替换，BonusSpells 与 Choices 按完整 origin 撤销，其他同名来源不动。离开当前所有权的 Lucky／免费法术计数进入退休记录，不再作为可用资源；以 `NextLongRestAtSeconds` 为实际长休周期标记。同周期重新取得保留已消耗量，新长休后允许恢复，这是本项目的防刷新策略；不得当作额外原文条款。GET 不开启窗口、不重建账本、不恢复次数；短休／仅等待长休间隔不能刷新该标记。

秘法奥秘由 `AdvancementArcanum` 在现有 `SpellChanges` 内处理：`mystic-arcanum:replace` 一个 keep／旧 origin 组，后续 `:replacement` 一个同环 Warlock 法术组；仅 Draft.ClassId=warlock 且旧职业已取得来源时开放。11/13/15/17新授予独立，替换只改当前 BonusSpells.Id，保留 origin，并由原 RenameResource／PreserveReplacedResources 转移剩余次数。旧 Build/Steps/回执不重写，不增加HTTP或工具版本。

## 4. 校验与错误

无效重复 draft → invalid_advancement；无资格绑定／非已知 Warlock 戏法 → 不完整选择，不能 apply；移除超过一个旧实例 → replacement_limit。未来/损坏状态、给普通能力伪造 slash 副本、任意 at-will 法术／条件、重复 canonical binding → invalid_advancement_state。null/重复 Choice 在读校验时不能抛未分类异常。

账本必须有且仅有一个 permanent，Lessons 与来源记录一一对应；贡献字段须符合对应专长及当前已记录选项，派生并集匹配实际角色。Magic Initiate 严格核对当前列表、属性、两戏法／一一级法术、模式／次数／恢复条件；不能把 condition 伪造为属性值来增加次数。来源缺失／越界／伪造贡献／不一致聚合统一 `invalid_advancement_state`，保存原件。退休免费次数上限为1，Luck至多6，周期不晚于当前已完成休息标记。旧无 Lessons 且无账本不需要迁移读取。

Arcanum 记录必须对应当前 Warlock 等级实际应有的6..9环来源，一环一条、相同环级且属于Warlock列表，固定arcanum模式／默认属性／一次长休资源语义。缺失、伪造来源、重复、改为known或多次／短休等状态拒绝为 `invalid_advancement_state`；`ValidateResources`在Evaluate原输入与CampaignStore授权后/Sync前及Save前核对当前池恰好一份、max1/current0..1/long；keep/兼职也不能补满缺池。State单独验证取得元数据，合法新增候选在Refresh前尚未有新池，不在中途执行持久次数检查。孤儿识别只匹配规范Free前缀/来源后缀，不能用Contains误拒合法DM自定义资源。其他职业／多来源／错环／非列表或keep附带替换值均不可apply。

## 5. 正常、兼容、拒绝

正常：一份 Agonizing Blast 绑定 Eldritch Blast，另一份绑定 Poison Spray；以后只替换后一实例，前者保留。兼容：旧单份绑定以当前记录读取，旧回执仍返回原判定。拒绝：给 Chill Touch 的接触距离提供 Spear、给 Mind Sliver 提供 Repelling、失去戏法后保留其绑定、替换初始祈唤后继续旧 grant。

## 6. 验证

`AdvancementSourceOwnershipTests` 验初始戏法移交／替换／兼职、伤势消耗、旧 ghost 只在明确升级结果清理、两种无槽路线、当前特性标签；`AdvancementInvocationTests` 验不同绑定、资格、同时改戏法／绑定、重复和过量替换、旧单绑定 JSON 兼容。`AdvancementSourceOwnershipHttpTests` 验真实创建／preview 零副作用／重开／不同 UUID 竞态／后续升级／再次重开原回执及两份绑定保存。compiler 对固定完整原文断言，生成目录字节不变。最终原生客户端验收由六线集成负责。

`AdvancementLessonTests` 验6类关键机制（重复不同 Origin、Tough 负差与0HP、后续 Mercy 固定同名技能、暂停／恢复独立 Scholar 专精、永久 Skilled 与临时 Skilled、MI/Lucky撤销和同周期消耗、工具／武器／坏来源）。`AdvancementLessonHttpTests` 真实升级1→6、次数实际调整、两次服务重开、同 UUID 并发与旧回执、实际 long rest 后再取得，并在自有已停库中注入缺失 ledger 验409与字节不改。来源元数据目录固定原文验证不联网，最终 Native Unity 的新成长业务仍由父集成验收。

`AdvancementArcanumTests` 覆盖职业限定、一次同环替换、新取得共存、伤势/资源/旧步骤、JSON重开与坏所有权；`AdvancementArcanumHttpTests` 实际创建及升级1..13、预览零副作用、不同UUID竞态、两次重开原回执、坏记录409且库字节不改。compiler固定完整XPHB11取得／恢复／替换原文。

## 7. 错误与正确

错误：职业戏法数加一，同时保留原额外 SpellGrant；或 OptionalFeatures 删除了旧祈唤但 BuildMechanics/Features 没同步。正确：在明确升级候选中移交来源、按当前所有权生成路线，其他来源及历史保持。错误：把可重复祈唤仍以唯一基础 ID 去重；正确：完整绑定是实例身份，定义元数据通过同一解析器取得。

错误：只保存新增训练的集合差，之后另一个职业取得同名熟练时不记录来源，撤销 Lessons 就删掉合法职业熟练。正确：每次授予均登记贡献，撤销后取仍在持有的来源并集；永久专精保留原授予但只对现有熟练生效。

错误：替换秘法奥秘生成全新免费次数，或总等级升级就允许替换。正确：仅Warlock升级选择一个原来源，重命名计数保持消耗；取得资格和任意法术自动执行仍分开。
