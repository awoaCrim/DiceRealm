# 角色、法术与成长

> 内容导入改造：生产流程已取消内置剧本和默认提示词，新战役保持空白。下文涉及雾港、灯塔、巡守等固定内容的部分是旧版回归场景记录，不再是启动默认值。当前入口、数据格式和限制以 [剧本与提示词导入](content-import.md) 为准；检定、资源、存档和权限规则仍由服务端执行。


当前 Unity 仅在受邀加入时提供 XPHB 一级单职业八步完整建卡，不提供战役创建、角色预设或简化建卡。工作台只创建无玩家角色的主持战役；已有 Human / Fighter / Soldier、Human / Wizard / Soldier 和旧自定义角色仍保留原数据。职业、物种、背景、标准数组 / 点购、来源选择、法术、装备和人物细节的操作与草稿恢复见 [完整建卡流程](full-character-creation.md)。派生数值由服务端计算。更多职业的建卡记录不代表其全部能力已自动执行。完整建卡使用独立的[逐级成长、子职业与多职业流程](character-advancement.md)，不套用旧预设二级升级。

---

### 受限建卡

以下保留旧版受限 `creation` 的历史规则和存档说明，不是当前可用的新建入口。旧目录/预览 API 已返回 410，新建或替换角色仅接受完整 `build`；只有已经接受的旧请求按原回执恢复。Unity 当前入口已使用完整 `build` 流程，旧的「配置属性 · 技能 · 装备」面板不再是大厅入口。旧 API 从服务端读取选项。标准数组 15、14、13、12、10、8 各用一次；左右按钮交换属性上的数值。Soldier 加值只能在 STR、DEX、CON 中选择不同项 +2/+1，或三项各 +1。职业选择两个不同技能，Human 再选择一个技能；当前实现不支持与背景或其他选择重复后的熟练替换。

Fighter 保留职业装备 A + Soldier 金币方案，也可选择职业 C 与 Soldier B 的共 205 GP，购置 Chain Mail 75 GP、Greatsword 50 GP、Dagger 2 GP，剩余 78 GP；购买方案不附送旅行包。当前重甲 Fighter 只开放最终 STR ≥ 13，低力量重甲和重武器惩罚尚未开放，这是实现范围，不是通用建卡限制。Wizard 保留职业装备 A + Soldier B 的同一套装备，可以选择初始准备法器长棍或匕首。

Human、Soldier、等级 1、Alert、Savage Attacker、语言、工具、职业特性与法术书仍固定。Fighter 的 Great Weapon Fighting 与已实现武器专精不随选项改变；未自动化武器和法术仍只记录。点购、其他物种/背景、任意装备采购及更多职业尚未开放。

「服务端校验与预览」不创建存档、不掷骰、不调用模型。HP、AC、调整值、法术攻击、豁免 DC、技能与装备均展示服务端结果；修改任何选项会使旧预览失效。采用后返回新建页，点击创建才保存空白战役，服务端会再次校验。取消或迟到响应不会偷偷采用选择。原预设请求和旧存档仍兼容，已验证选择随角色保存，离线试跑会按同一选择重新建立起步角色。

当前 Unity 仅在加入队伍时完整建卡，工作台没有角色预设或建卡表单。上述初版创建操作仅为历史记录，新的角色请求不再接受旧受限选择。协议见 [客户端协议](client-contract.md#bounded-character-creation)。

---

### 角色面板

按 C 或点击队伍栏中自己的头像打开角色窗口，页签为人物、状态、能力、法术、背包、恢复。面板右侧列出服务端提供的换装、施法、恢复和成长行动。不可用选项显示原因，选择后先打开行动确认，不立即扣除资源。资源、效果到期时刻、法术攻击和豁免 DC 均直接展示快照，不在 Unity 重算。

原预设 Fighter 起步为 HP 12、Chain Mail AC 16、Greatsword。Wizard 起步为 HP 9、无甲 AC 11、INT 15、法术攻击 +4、豁免 DC 12。Wizard 的 Soldier 属性加成为 STR +1、CON +2，最终属性为 9/13/16/15/12/10；它不提供 INT 加成。背景装备选金币，合计 55 GP。

Wizard 记录 Fire Bolt、Mage Hand、Prestidigitation 戏法，法术书记录 Magic Missile、Mage Armor、Shield、Sleep、Detect Magic、Find Familiar；前四个 1 环法术已准备。施法位初始为两个 1 环位，准备与已实现自动结算是两个不同字段。

---

### 已自动结算的法术

| 法术 | 行动与资源 | 当前范围 |
|---|---|---|
| Fire Bolt | 动作，不耗法术位 | 120 尺远程法术攻击，1d10 Fire；自然 20 翻倍伤害骰，无属性伤害加值；近身可见敌人或目标 Dodge 造成劣势 |
| Magic Missile | 动作，消耗一个 1 环位 | 三枚飞弹同时命中巡守，每枚独立掷 1d4+1 Force；不掷攻击或豁免 |
| Mage Armor | 动作，消耗一个 1 环位 | 当前支持自身；无甲基础 AC 为 13+DEX，持续 8 小时，穿甲提前结束；非专注 |

Magic Missile 的逐弹骰依据是 2024 的共享伤害条款仅适用于同时强制多个目标进行豁免的效果。未把旧版“对多个目标统一一组伤害骰”的解读移植过来。

遭遇中的所有目标可见，没有掩护；施法者能发声并使用空手。Mage Armor 使用携带的 Arcane Focus (Quarterstaff) 或自己的法术书替代其无标价、非消耗材料；XPHB p165 的 Wizard Spellcasting Focus 明确允许这两种焦点。不能据此忽略其他法术的昂贵材料。客户端不能指定法术位数量、命中、骰点或效果持续时间。直接提交未开放法术或错误目标会被拒绝；自然语言请求进入裁定队列。

Shield、Sleep、仪式、其他戏法和升级新增法术只记录在法术书中，界面明确标为需 DM 裁定。当前不自动执行玩家反应窗口、专注、区域豁免、熟悉魔宠或仪式材料消耗。Human 的 Heroic Inspiration 已记录与恢复，使用它重掷仍需裁定。

---

### 装备与休息

下述原预设规则继续保留。新旧角色均可从 [通用角色操作](character-play.md) 记录已持有装备、来源施法与资源消耗；新的主持调整入口可以落实人工效果。短休按各资源恢复策略处理，长休清除临时 HP、降低一级 Exhaustion，并开放支持职业的准备清单窗口。

战斗外可以在携带的受支持武器之间切换。Wizard 的 Quarterstaff 采用双手近战 1d8、STR；Dagger 采用近战 Finesse，攻击与伤害使用同一个较高属性调整值。Savage Attacker 只影响武器骰，不影响法术。Fighter 的 Greatsword 保留 Great Weapon Fighting 与 Graze。未支持的 Flail、Javelin 投掷和双持仍作为携带物品记录。

Fighter 可以花 5 分钟卸下 Chain Mail，或花 10 分钟重新穿戴。穿戴 Chain Mail 时的 Dexterity (Stealth) 检定由服务端施加劣势，与已有优势按通常规则相消。战斗中不开放这类换装命令。武器掉落、短休醒来与起身拾回仍是独立步骤。

港口是原创安全休息地点；巡守击倒后的维修位也是安全短休地点。休整由主持发起（玩家自行发起返回 `rest_host_required`，见 [队伍休整](../.trellis/spec/backend/party-rest.md)），玩家只在休整后选择自己的生命骰和恢复方式；休整原子完成对应的安全时间，不模拟休息中遭遇。不能在战斗中提交休息来跳过敌人。

- 短休经过 1 小时，Fighter 恢复一次 Second Wind，已解锁的 Action Surge 恢复。可选择花一颗生命骰，按骰值加 CON 恢复，最低 1 HP。升到等级 2 后可在同次短休继续花下一颗，不再额外增加一小时；执行其他已结算行动后不能回头追加。
- Wizard 可以在短休时选择 Arcane Recovery，恢复一个已花费的 1 环位；等级 1 和 2 的额度都是一个法术等级，每次长休之间只能使用一次。它不会自动花掉。
- 港口长休经过 8 小时，包含至少 6 小时睡眠、至多 2 小时轻度活动。恢复全部 HP、全部生命骰、法术位和相应长休资源，Human 获得 Heroic Inspiration。完成后须等 16 小时才能开始下一次。
- 「度过长休间隔」只推进到下一次可开始长休的时刻，不恢复 HP 或资源。场景旅行每段经过 10 分钟，这是原创沿岸路线时间；每个完整战斗轮推进 6 秒。Mage Armor 随同一冒险时钟到期，读取存档或现实等待不会偷偷推进时间。

---

### 灯塔里程碑

以下成长仅适用于旧预设 / 受限 `creation` 角色，不适用于新的完整 `build` 角色。点亮灯塔后，返回港口即可选择一次等级 2 成长。它不要求打败可选巡守，也不要求消耗经验值。剧情触发条件是本项目的原创里程碑政策。

Fighter 使用固定生命值增长 `6+CON`，原预设为 +8 HP，获得 Action Surge 与 Tactical Mind。Action Surge 在使用普通动作后提供一个额外的非 Magic 动作，不花附赠动作，也不刷新同回合的 Savage Attacker 额度；短休或长休恢复。

支持的属性检定失败后，Fighter 可以立即选择 Tactical Mind 加 1d10。如果因此成功才消耗一次 Second Wind；仍失败则不消耗，也不能为同次检定继续追加。选择其他已结算行动会关闭这次机会。原检定与修正结果都保留在日志中，修正成功会通过同一剧本后果逻辑更新路线或账册，不重新掷 d20。

Wizard 使用固定生命值增长 `4+CON`，原预设为 +7 HP；玩家从已有熟练的 Arcana、History、Investigation、Medicine、Nature、Religion 中选择一个 Scholar 专精。相应检定的熟练加值翻倍。法术位上限增加至三个 1 环位；固定学习 Feather Fall、Thunderwave，并把 Feather Fall 加为第五个已准备法术。这两个新增法术均需裁定。

成长保留已有伤势与已花费资源，只增加新等级带来的 HP、生命骰和法术位。等级 3、子职、多职业、自由换准备法术和经验值分配尚未开放。

---

### 实现与规则证据

角色和时钟规则集中在 [CharacterEngine](../server/DiceRealm.Server/Domain/CharacterEngine.cs)，成长与失败检定修正在 [GrowthEngine](../server/DiceRealm.Server/Domain/GrowthEngine.cs)，战斗法术和武器结算在 [CombatEngine](../server/DiceRealm.Server/Domain/CombatEngine.cs)。对应 [角色测试](../tests/DiceRealm.Tests/CharacterTests.cs) 与 [成长测试](../tests/DiceRealm.Tests/GrowthTests.cs) 包括非法输入、资源额度、时钟、并发重试和重启恢复。

verify_spell_rules.py 与 verify_growth_rules.py 使用真实本地 stdio D&D MCP，全部显式指定 `dnd2024`。详情格式未包含的职业特性、进阶表、组件与武器属性通过同一固定 provider revision 补充核对，明确与 MCP 返回区分。完整原文仅保存在忽略的本机取证目录，不打包进游戏。

受限建卡规则与采购选项见 [CharacterCreation](../server/DiceRealm.Server/Domain/CharacterCreation.cs)，HTTP 边界、预览无写入、试跑与重启回归见 [建卡测试](../tests/DiceRealm.Tests/CharacterCreationTests.cs)。verify_creation_rules.py 通过真实 MCP 核对职业、Human、Soldier、武器、Staff 与 Chain Mail，并补充读取同修订的标准数组、起始装备与护甲字段。泛称 Arcane Focus 查询的缺失保留在取证中，使用 canonical Staff 查询，不切换到旧版规则。
