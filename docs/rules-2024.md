# D&D 2024 规则来源与自动化范围

最新源码范围补充：[逐级成长](character-advancement.md)、[可执行自然效果](natural-action-effects.md)与[标准战斗](standard-combat.md)。下文保留早期受限实现和取证历史，不能把当时“未实现”条目当作当前唯一状态；标准战斗已含5种精通、9种来源法术、3种区域效果与飞弹分配/Shield，未宣称完整D&D覆盖。

---

### 来源

规则集固定为 `dnd2024`，预设内容来源为 `XPHB`。数据检索使用本项目 D&D MCP 的 stdio 服务，固定数据修订为 `e5f3e77b303a92df10487207857200245e71957c`，与 rulesets.py 一致。不静默查询 2014。

取证时通过真实 MCP 调用了 `get_race_details(Human)`、`get_class_details(Fighter)`、`get_background_details(Soldier)`、`get_equipment_details(Chain Mail)`、`get_feat_details(Alert)`、`get_feat_details(Great Weapon Fighting)`，全部显式传入 `ruleset=dnd2024`。

原工具集没有基础检定词条入口，因此在 vendor 增加 `get_rule_details`，按版本、source 和 exact canonical name 查词条，返回 source、page 和 revision。已经查询 `D20 Test`、`Ability Check`、`Advantage`、`Disadvantage`、`Proficiency`、`Ability Score and Modifier`；不存在、版本/source 错误和数据源故障都保留结构化错误。

词条只有摘要，公式与表格另外核对了同一固定 revision 的 `data/book/book-xphb.json`，通过 vendor 的数据客户端读取。这一步是同源章节核对，不冒充新增 MCP 工具的返回。完整原文仅保存在忽略的本地取证目录，不作为项目分发数据。

---

### 已自动化

| 行为 | 核对依据 | 实现与测试 |
|---|---|---|
| d20 加属性调整值和适用熟练加值，与 DC 比较，达到即成功 | XPHB pp.10-11，D20 Tests / Ability Checks | [RulesEngine](../server/DiceRealm.Server/Domain/Rules.cs) |
| 调整值向下取整，对奇数负值正确处理 | XPHB p.10，Ability Modifiers 表 | `AbilityModifier(9) == -1` 回归 |
| 优势取较高，劣势取较低，两者同时存在相消 | MCP XPHB Advantage p.360、Disadvantage p.366 | 双骰选择与相消回归 |
| 属性检定不把自然 1/20 当自动失败/成功 | XPHB pp.10-12，自动命中/失误条文属于 Attack Rolls | 低 DC 的自然 1 成功、高 DC 的自然 20 失败回归 |
| 等级 1 熟练加值 +2 | XPHB Character Advancement 表 | 固定预设和 DTO 检查 |
| Fighter 等级 1 HP = 10 + CON modifier | XPHB p.40，Level 1 Hit Points by Class | 当前 CON 15，HP 12 |

冒险中的调查阈值、路线条件和任务结果由 [Adventure](../server/DiceRealm.Server/Domain/Adventure.cs) 与 [行动执行](../server/DiceRealm.Server/Application/GameService.cs) 定义，是原创剧本裁定，不是声称规则书规定的特定场景 DC。

---

### 战斗增量取证

verify_combat_rules.py 通过真实 stdio MCP 核对 Fighter、Greatsword、Alert、Great Weapon Fighting、Savage Attacker、Unconscious，以及 Attack Roll、Critical Hit、Initiative、Bonus Action、Reaction、Hit Points、Short Rest、Speed、Difficult Terrain 和 d20 优劣势词条。均显式使用 `dnd2024`，来源 `XPHB`。

`Opportunity Attack` 不在 MCP glossary 中，原始查询的 `rule_not_found` 已保留，没有转换为成功或切换规则版本。该条与 Attack、Dash、Disengage、Dodge 通过同一固定 provider 的 `data/actions.json` 补充核对。Second Wind 使用同 revision 的 `data/class/class-fighter.json`，Greatsword 的 Graze 使用 `data/items-base.json` 和书籍章节。补充资料在取证中明确标记为同源数据，不冒充 MCP 工具返回。

| 行为 | 核对依据 | 当前范围 |
|---|---|---|
| 先攻与回合预算 | XPHB pp.23-25、91、Alert；glossary pp.362、369、372 | 玩家 DEX+PB、独立动作/附赠动作/反应/移动；同分玩家先是本场裁定 |
| 攻击与重击 | XPHB pp.27、361、364 | 自然 1/20 攻击语义、武器伤害、重击翻倍骰不翻倍调整值 |
| Greatsword 与专长 | XPHB Greatsword p.215、Graze p.214、MCP 专长详情 | GWF 的 1/2 视为 3，Savage Attacker 双组选择，Graze 未命中固定调整值伤害 |
| 移动、困难地形、借机攻击 | XPHB pp.25、366、371、374 | 5 尺方格，斜向不穿阻挡角；离开触及前结算，反应在自身回合开始恢复 |
| Second Wind、短休 | XPHB pp.91、373 | 附赠动作 1d10+等级，短休恢复一次资源，选用生命骰+CON |
| 2024 非致命击倒 | XPHB p.28；Unconscious 条目 | 保留 1 HP、Unconscious/Prone/掉落武器，开始短休；醒来不自动起身 |

实现见 [CombatEngine](../server/DiceRealm.Server/Domain/CombatEngine.cs)，行为和 HTTP 回归见 [CombatTests](../tests/DiceRealm.Tests/CombatTests.cs)。NPC 数值、棋盘、一次性挑战、安全维修位和撤退后不追击都是原创场景规则，不能推广为所有战斗的 D&D 默认行为。

---

### 角色预设与受限建卡

以下描述旧预设与兼容 `creation` 接口。当前 Unity 已使用 [完整一级建卡流程](full-character-creation.md)，其更广的取得目录不扩大既有自动战斗的规则承诺。

模板 `human-fighter-soldier-2024` 与 `human-wizard-soldier-2024` 均可创建，名字可输入，派生数值不可由客户端提交。原预设保留；新增标准数组、背景加值、技能与受支持起始装备选项，范围见 [受限建卡](characters-and-growth.md#受限建卡)。以下先说明 Fighter，Wizard 与等级 2 见 [角色、法术与成长](characters-and-growth.md)。基础属性采用标准数组，分配为 STR 15、DEX 13、CON 14、INT 10、WIS 12、CHA 8；Soldier 分配 STR +2、CON +1，最终为 17/13/15/10/12/8。

背景熟练为 Athletics、Intimidation，职业选择 Perception、Survival，Human 额外选择 Investigation。Origin feat 为 Soldier 的 Savage Attacker 和 Human 选择的 Alert。Fighting Style 选择 Great Weapon Fighting。本次固定遭遇已自动处理 Alert 先攻加值、Great Weapon Fighting、Savage Attacker 和 Greatsword 的 Graze。其他武器专精仍不自动执行；Human Resourceful 已在长休时授予 Heroic Inspiration，消耗它重掷尚需裁定。

装备采用 Fighter 选项 A，加 Soldier 选项 B：Chain Mail、Greatsword、Flail、8 Javelins、Dungeoneer's Pack，总计 54 GP。Chain Mail 显示 AC 16，没有选择 Defense 或盾牌加值。种族体型选择 Medium，语言和工具选择记录在模板说明中；暂不展开背包组合物品、负重、价格或技能以外的熟练行为。

MCP 是检索层，不是通用角色合法性验证器。当前代码实现受限预设、已验证选择的初始化和已使用的派生值，不应宣称任意职业/背景/专长组合均已校验。

---

### 明确未自动化

早期自动化限于 [堤道遭遇战](combat.md) 和 [固定角色规则](characters-and-growth.md)；现在 [标准战斗](standard-combat.md) 已实现掩护、死亡豁免、专注及部分来源法术，[逐级成长](character-advancement.md) 支持至 20 级与多职业取得。复杂视线（高度、隐匿、黑暗、3D）、玩家反应选择、完整状态效果、未列出的法术与武器、完整装备与负重仍未实现。Second Wind 和短休现在有明确的服务端命令，法术位、长休和升级也有服务端命令，不能通过 AI 文字擅自消耗或恢复。

这些输入进入待裁定分支，不模拟掷骰，不借用 2014 规则，不把无法处理的动作叙述为已经成功。队长可通过 [授权裁定](party-and-rulings.md) 记录理由、来源、叙事与原角色检定；数值效果通过单独的 [角色调整](character-play.md) 表单落实。只开放列出的生命、状态、资源和物品变更，不接受任意状态补丁，也不自动执行完整法术。

没有把完整 XPHB/XDMG/XMM 数据嵌入游戏资源。运行时无需 MCP 在线才能掷一个基础检定；MCP 用于开发取证与后续内容导入。商业发布前必须单独审查规则内容与名称的许可边界。

---

### 重复核对

运行 verify_rules.py 可重复执行 MCP 工具查询。规则层测试在 [服务端测试](../tests/DiceRealm.Tests/Program.cs)，vendor 版本与核心规则工具测试在 test_tools_rulesets.py。修改规则前先更新取证和覆盖说明，再扩展执行能力。


---

### 施法与等级 2 取证

verify_spell_rules.py 核对 Human、Wizard、Soldier、专长、Quarterstaff/Dagger、起步法术、长短休及相关规则。Spellcasting、Arcane Recovery、法术所属职业、远程近身劣势和伤害章节使用同一固定 revision 的补充原文。Concentration glossary 查询的 `rule_not_found` 保留，没有因此借用 2014 规则；Sleep 仍不自动化。

verify_growth_rules.py 核对 Fighter/Wizard、Expertise、Chain Mail 与新增法术，补充核对 XPHB p.42 固定 HP、p.91 Action Surge/Tactical Mind、pp.165-166 Wizard 进阶与 Scholar、pp.213-214 武器属性、p.219 穿脱护甲、pp.236-237 施法组件。固定 HP 增长、技能专精双倍熟练、Action Surge 排除 Magic、Tactical Mind 失败返还以及法术位/准备数量均有自动回归。

剧情里程碑、港口安全休息和沿岸每段旅行 10 分钟是本项目原创政策。它们不应被标为书籍通用规则。


DM 检定的常规技能/属性映射另经 verify_ruling_rules.py 核验：真实 MCP 的 Ability Check/Proficiency，加同一固定 revision 的 XPHB p14 Skills 表与替代属性说明。裁定入口仅开放常规组合和 DC 5..30；这是实现范围，不是规则的通用禁止条款。


---

### 受限建卡增量取证

verify_creation_rules.py 用真实 stdio MCP 查询 Human、Fighter、Wizard、Soldier、受支持武器、Staff、Chain Mail、Mage Armor 与属性调整值条目，均为 `dnd2024` / `XPHB`。标准数组、Soldier 加值方案、职业起始装备和技能选择另核对同一固定 revision 的书籍与职业源数据。Chain Mail 的 Strength 13、Stealth 劣势和价格核对同源装备原始字段，避免依赖格式化详情中缺失的字段。原文留在忽略的取证目录，不分发完整规则书。

前一受限建卡阶段增加服务端建卡校验、HP/AC/施法派生值、重启与试跑保留；补上 Chain Mail 的 Dexterity (Stealth) 劣势，并增加 Wizard 可用自己法术书作为施法焦点的回归，依据同修订的 XPHB p165，未误用旧版限制。未开放低力量重甲/重武器惩罚、任意购买或任意物种背景。Wizard 起步装备选择只改变同一合法套装中准备的武器，不额外赠送物品。

---

### 完整一级建卡增量

当前建卡目录与八步流程见 [完整建卡记录](full-character-creation.md)。取证脚本 显式使用 `dnd2024` MCP 核对 XPHB 的基础职业、物种、背景与起源专长，再从同一固定 revision 补充职业表、一级法术、装备、语言和标准数组 / 点购规则。没有从 2014 查询结果补齐缺失字段。精简元数据由 目录生成器 产生，原文不随 Player 打包。

完整建卡的合法性与旧预设自动战斗分开。派生属性、生命值、护甲、技能、豁免、来源施法数值、初始装备预算与穿戴由服务端校验；额外职业的全部动作、法术、反应和成长未自动执行。低力量重甲的速度影响已纳入建卡与运行时；未实现的战斗组合会明确禁止自动开战，不按 Fighter 代算。


---

### 角色规则速查目录的维护

Unity 角色窗/建卡的中文名称与规则说明来自只读目录 character-rules.zh-CN.json，由 法术译名与材料表 和 规则速查源文件 生成（固定来源修订同上，不用 2014 数据填补缺项）：

同一脚本还生成工作台的 [rule-names-generated.js](../client-workbench/src/rule-names-generated.js)，主持审核角色时看到的中文名与 Unity 一致。

```bash
python scripts/build_character_reference.py          # 重新生成
python scripts/build_character_reference.py --check  # 只检查生成文件是否一致
```

生成器检查版本、完整法术 ID 集合、重复项、材料存在性及材料金额与原始 cp 值一致；材料取同一物品的最低价值，不把重复列出的 GP 与 cp 当两笔费用。名称只在展示层转换，角色名、主持自定义资源、原始 DTO、请求键与消耗来源不被翻译回写；装备 Shield 显示「盾牌」、法术 Shield 显示「护盾术」，Resistance 法术与伤害抗性按条目 ID 区分。运行时只加载精简目录，不联网查询 MCP，也不执行效果。

### 角色使用与效果记录取证

角色使用取证 显式核对 `dnd2024` / `XPHB` 的豁免、临时 HP、休息、抗性与状态词条，并补充相同 revision 的职业、物种、专长和法术数据。当前角色入口记录无 DC 检定、来源施法与消耗，不自动结算法术效果。Exhaustion 的每级检定减值、部分状态的力量 / 敏捷豁免自动失败、已支持短休资源恢复、长休清除临时 HP 与降低一级 Exhaustion 均有回归。主持伤害输入为已核算的最终值，系统不重复应用抗性。详细边界见 [角色使用](character-play.md)，本阶段不扩展自动战斗。
