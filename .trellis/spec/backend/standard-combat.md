# 标准战斗与持久触发

## 1. Scope / Trigger

修改显式standard-2024遭遇、致命伤害/反应/专注/区域效果、来源法术/敌人以及公开战场时必读。行为所有者是`Domain/StandardCombat`，旧`CombatEngine`只分流，不迁移历史非致命规则。实际支持与限制只维护在[标准战斗协议](../../../docs/standard-combat.md)，不要从角色拥有某名字推断自动执行。

## 2. Signatures

Campaign可空RuntimeEncounters保存当前/历史运行时定义、来源与战术布局；v46侦察准备的Layout可空，并以ObservationMapId标明明确的新式未绑定状态。绑定后冻结BoardCombatLayout；不得改导入Adventure补敌人。ContentEncounter可空Mode须与Nonlethal配对；ContentEnemy可空Tactic/RulesId/SavingThrows在旧JSON省略。Character可空Concentration同样省略null。公开CombatState.Standard/CombatUnit.Standard不等于私有Campaign.StandardCombatFlow；流schema1，保存原触发余下步骤。Actions仍用原kind/target/version/requestId；来源spell/键为源ID+目标的SHA256，不能收取模型补充数值。

## 3. Contracts

- Choices与Resolve共享可用性；目标、动作、资源、装备与对应席位重新核验。新标准投掷从旧actions进入也强制PendingRoll；取消不清除必须回应的战斗触发，原请求先查回执。
- 精通效果保存来源：Sap/Slow在来源回合开始到期，Vex在来源下一次对目标攻击或下回合结束到期；不得以轮数或ActionSurge重置。Slow不叠加，移动减量包含已取得的Dash增量。可选Slow/Topple独立候选，缺确切NPC CON时不猜0。
- 攻击分命中与hit步骤：Shield等待在伤害骰前。NPC借机在move步骤前插入hit，不能移除/推进原move；受伤专注再插入concentration。区域共享伤害一次，各目标area-save；玩家等待在当前步骤，后续目标不得提前掷骰。流程有步骤或等待时不得提前Finish抹掉友伤/原伤害。
- Magic Missile的分配/undo/cancel没有付费或骰点，可由已提供候选直接编辑；最终missile_cast必须本人同意。所有Shield窗口先于全部伤害；逐飞弹伤害同事务完成，然后排仍有效的逐枚CON，失败/失能后不得继续无用豁免。私有来源key/分配步骤不直接发给模型。DEX区域的掩护来自区域中心并冻结在步骤，不能误用施法者位置；Dodge只对DEX给优势。
- 跨战斗效果属于Character：专注建立/替换/主动结束/时间到期/失能；不能只写历史CombatUnit。Shield至自己下回合开始，Hadar禁反应至目标下回合开始；每全局TurnSerial只可消费一个法术位（免费来源独立），ActionSurge禁止Magic。
- 自作NPC缺savingThrows不猜0；完整XMM绑定须匹配固定descriptor，不能按名字套能力。区域目标/友伤在确认前披露；完整掩护/平面格心算法是明确政策，不声称完整三维视线规则。
- 运行时遭遇先纯校验原文/图版/descriptor，再一次建立真实Board实例与NPC隐匿骰；v46必要侦察不依赖图的校准/用途或玩家棋子，初次terrain=[]、X/Y=-1，不伪造五尺距离。原encounter_prepare的encounterId用于后续一次BindLayout，复用名单/来源和全部现有状态；实际战术尺度/格位/仍隐匿单位掩护在此验证。无布局不得开战或退回旧7×5。定义和实例一一对应，不复制、不回血。战术标尺不改源PNG/原图比例。隐藏日志首次写入冻结Audience，所有读取/回忆入口复用CombatVisibility，不能等揭露后按当前可见性回放旧秘密。个人发现不等于全队知识，移动后的视线更新按实际观察席位处理；Search不能用全局Hidden=false跳过他人的发现依据。
- 保存与授权读取在导入/同步前ValidateState；未知schema/非法引用/不一致等待拒绝且保留原文件。不在GET补步骤、掷骰或推进。旧空字段/闭幕战场是历史，不强制其HP/掉落与后来角色一致。
- Harness v9公共投影只发7单位、35地形、8条有界日志/当前wait，不发flow、完整内容或胜利脚本。0..9目录冻结；v10另外提供有界精通来源/到期和分配操作说明，v9不新增可选精通/Acid Splash/Magic Missile候选。v8 canonical fingerprint `08cda1fd41df3bb3aa648a9fea35b933c90d1fd6b06851b68abd4a15b893d20e`，v9 `81934bf955282d68ef2bf3546cc7bd80447c02ca55d1b5377ed9d97293755eed`。v10 `7f6eb0ac756062120c3562733add5c2b29c33ccead09b937d478a209abe45e48`。修改工具目录/描述要冻结并升版，不能把扩充新候选倒灌旧运行。

## 4. Validation / Error Matrix

| 条件 | 结果 |
|---|---|
| mode/非致命配对、未知monster、残缺或非六项savingThrows | 导入拒绝，不启用、不改旧内容 |
| 目标/装备/成分/来源/反应/回合资源已失效 | action_unavailable，零随机与消耗 |
| 请求版本/冻结投掷上下文变化、别席位回应 | 原stale/roll/intent冲突，不能改ID或授权人重试 |
| 标准存档schema/flow/wait/角色引用损坏 | 授权后409 invalid_standard_combat；错误凭证仍先401 |
| 旧mode、新字段全部缺省 | 原路径/JSON/回执兼容，不自动致命化 |
| 运行时定义/实例来源、私有发现、战术图版引用损坏 | invalid_runtime_encounter；拒绝并保留原存档，不重建/补骰 |
| Layout缺失但没有新ObservationMapId、已有交战/attempted或格位/地形非空 | invalid_runtime_encounter，不把旧坏存档当新准备 |
| 未绑定布局开战；初次传地形/重复绑定/改变原名单 | board_combat_layout_required或encounter_setup_unavailable，零写零骰 |

## 5. Good / Base / Bad

Good：借机命中→Shield暂停→对应玩家来源确认→原hit一次→CON暂停→本人豁免→原move一次。区域中同伴先受影响时，NPC保留原HP直到同伴决定完成。

Base：旧非致命一小时恢复与历史回执保持；standard只由显式导入或有原文依据的运行时准备/开战启用。旧0..45工具目录、checklist和已经开始的运行冻结；新侦察不改旧回执。

Bad：先掷全部NPC/伤害再弹窗；因最后敌人已倒下清空尚未结算的同伴范围伤害；用nullable SavingThrows的缺失项默认为0；战斗结束清除仍有效角色专注；照旧默认Greatsword恢复替换真实掉落装备。

## 6. Tests Required

`StandardCombatTests/HttpTests/PiTests`：旧模式JSON、v8黄金、公共投影、真实Pi、借机/死亡、取消、不同ID并发、席位、重开/原回执、坏字节保留。`StandardSpellTests/HttpTests`：来源/成分、槽位经济、Shield伤害前停、专注替换/到期/失能、恢复余下移动、自己/同伴豁免及保存。`StandardAreaTests`：共享伤害/友伤与专注插队、Hadar反应期、缺省NPC拒绝、XMM Fortitude重击例外和Skeleton易伤。`StandardMasteryTests/DexAreaTests/MissileTests/MissileHttpTests`覆盖精通消费/到期、已Dash减速、中心掩护/本人Dodge、无费用分配、全部Shield在伤害前、同时伤害/CON尾部、外席位/并发/三次重开。`StandardCombatPiTests.MissilePlanToOwnConsent`必须实际Pi/MCP完成分配→本人确认→重开/原回执，不仅直接调用Domain。新增机制复测真实受影响边界；公开字段改变必须检查双端，浏览器不冒充Unity。

`MapIndependentPerceptionTests`覆盖两类地图无需玩家棋子便等待本人检定、个人发现与叙事门、重启原回执、同图/跨图一次绑定不重掷/回血、绑定后按各席位真实几何刷新视线以及旧v45拒绝。详细工具合同只维护在[契约46](../../../docs/harness-runtime.md#侦察独立于地图校准契约46)。

`RuntimeEncounterTests/HttpTests`另覆盖图版和导入内容不变、失败零骰、真实三席位先攻/重启、个人Search/移动发现、日志受众首次冻结、地精80/85尺优劣势抵消/额外骰/Shield/Nimble Escape。

来源验证脚本固定manifest/raw/book/既有术语cache SHA。只允许primitive反序列化该特定本地cache，不泛化为可加载任意pickle。源码与证据必须明确本地取证和0外发，不能把不存在的MCP响应写作依据。

## 7. v49逐行动叙事边界

1. **范围/所有者**：新Harness标准战斗；`StandardCombatNarration/Turns`拥有机械暂停，`HarnessCombatNarration/HarnessGameService`拥有授权与叙事提交，`HarnessRunService`沿原Run续接。完整字段见[契约49](../../../docs/harness-runtime.md#逐单位战斗叙述与私人增量契约49)。
2. **签名**：私有flow可空`NarratedThrough`，每输入可空`ToolContractVersion`；新`combat_continue({})`及`agent.narration`。缺省字段不写旧JSON，不改数据库schema。
3. **合同**：原Steps在下一单位advance前暂停，world_record/narrative_commit与ack同事务，公共行动须有公共正文；私有/不可见事实不强制公开。即时反应与本人投掷仍原暂停。final回执`ContinueCombat`驱动同Run内部turn，最后终局叙述先于return。新输入首段若只补交此前独立按钮动作（尚未建立本输入的intent根），保存后仍须沿同一Run读取新帧处理原输入，不能把旧动作叙述当成新输入已完成；普通final同样沿原ContinueCombat回执续接，不重复旧骰/资源。死者仅可完成已接受战斗的待叙述/原队列，不能开始新角色行动。Activity按原intent追加独立段，不能覆写旧段或重复原话。
4. **拒绝/恢复**：未交付先继续或以actions_propose/ask_player跳过，`combat_narration_required`且零骰；指针不在0..LogSequence为invalid_standard_combat。重启恢复原model/tool/final回执，unknown不重发。受众分类以原Log.Audience为准，不能拿已脱敏投影的null误标public。
5. **正常/兼容/拒绝**：敌A→叙述A→敌B→叙述B；旧null flow保持批量；v48旧输入全部结束后下一fresh采用49，更早原合同及已存槽位冻结。拒绝在旧跨席位等待仍活时启用其无法ack的新指针。
6. **验证**：`CombatNarrationTests`逐敌/Shield/CON/私有受众/重开；`CombatNarrationHttpTests`真实Pi工具与普通final、原final回执已存但turn未存的故障恢复、致命攻击/终局先于return、跨席位old48等待、冷Activity/detail及原请求重放。消费者须验证逐sequence保留与同版本读取失败重读，不以快照最终值提前展示。
7. **正误**：错误是只分割事后总述或加前端计时器；正确是后端原队列在每个行动边界停住，保存该段后再推进。错误是为隐藏行动编公共叙述；正确是原受众过滤且允许合法空公共确认。

## 8. v51结构化命令续接与布局诊断

- **所属/签名**：正常命令提交后的`HarnessCombatCommandCoordinator`拥有自动叙事调度，Domain仍只推进原Steps。可空`CombatCommandSource`关联原request/battle/sequence/root；完整字段、工具范围及历史语义见[契约51](../../../docs/harness-runtime.md#历史来源布局诊断与战斗命令续接契约51)。
- **不变量**：原自然输入拥有对应等待时不另起Run；GET/启动不推进。内部续接结果仅用关联副本绑定新intent，原事件/回执不得改写；每个HarnessStep.Result.IntentId必须匹配所属intent，否则执行帧拒绝。自动续接没有新动作候选，到实际玩家边界结束，不制造新玩家发言。
- **拒绝/恢复**：错战斗/序号/重复关联、旧合同或首输入携带Command拒绝；原命令重放不复活已有终态/unknown续接。沿原Run显式恢复已存槽位，不重掷或重复消耗。已有有效地图与位置复用，布局失败给出单位/格子/观察者与实际尺度，零副作用。
- **验证**：`CombatNarrationHttpTests.DirectCommandContinuesWithoutNewInput`与`StandaloneActionKeepsFreshInput`检查按钮自行续述、原等待不竞争、续述不吞下一输入、冷历史和故障恢复；历史祖先链与网格测试见契约51。旧0..50保持，不能靠更改golden掩盖兼容回归。
- **正误**：正确是对同一已提交命令续述并推进原队列；错误是伪造一条“结束回合”的自然输入再执行一次，或要求玩家再发一句话解锁下一敌人。

## 9. 自动死亡豁免与倒地回合（合同52）

- **所属/签名**：`GameService.PrepareAutomaticDeathSave(c,completedRollId,intentId)`只在写事务里复用`PrepareAction`；普通结算尾部与新52战斗叙事ack之后调用，GET/启动不补请求。`StandardCombatEngine.DeathSave`只在结果仍0HP时排原advance；自然20保留本人回合。详细流程与来源见[标准战斗](../../../docs/standard-combat.md#自动死亡豁免与倒地回合推进)。
- **不变量/恢复**：自动请求按battle+TurnSerial+actor固定内部requestId，一回合一次；仍本人确认才掷骰。取消保留wait且不自动重开。自然Run的本人请求必须绑定原intent，否则`HarnessContinue`以roll_unavailable拒绝；命令续述的独立请求不冒充原自然输入。跨席位不绑定发起者intent、不代投。
- **验证/正误**：新HTTP与真实Pi测试覆盖普通/叙事、按钮/自然输入、跨席位、取消、重开、原回执和自然20。错误是把死亡豁免当可选动作，或要求0HP角色手动结束回合；正确是自动发起本人待投掷，保存结果后推进原队列，不跳过苏醒后的行动。旧已存结果/回执保持，不在读路径修补卡住数据。

## 10. 移动后续接与无动作回合（合同53）

1. **范围/所有者**：`HarnessGameService`拥有叙事终止，`StandardCombatTurns.Continue`拥有原队列推进；完整合同见[运行53](../../../docs/harness-runtime.md#移动后原输入续接与空转回合契约53)。不从玩家原话或叙事关键词执行攻击。
2. **签名**：原`world_record/narrative_commit`，53战斗回执追加`inputContinues`；内部`ContinueNarrated(Campaign,bool coalesceIdleTurns=false)`只由53工具传true。HTTP/持久schema/原本人确认不变。
3. **合同**：本人新移动待叙述且仍本人回合、无规则等待时，保存叙事后必须刷新同Run候选，不凭隐藏候选的旧帧完成输入；按钮续述不获新权限。只合并原队列中待交付日志全为turn的NPC过渡，原日志/时钟/到期保留。
4. **拒绝/兼容**：待叙述时调用continue仍拒绝；任何实际动作、私有行动或玩家等待不得越过。0..52及所有已存回执保留，旧调用默认不合并；GET/启动零推进。
5. **正常/反例**：正常是三次合法移动分别确认后同输入申请攻击投掷；只走一格则刷新后结束。禁止因移动尚有余量自动攻击，也不能只跳过模型调用而漏掉原队列效果。
6. **验证**：`CombatNarrationHttpTests.MovementNarrationRefreshesOriginalInput`与`AutomaticDeathSaveContinuesNarratedBattle`验证真实Pi/MCP、同意/重启/重放；`CombatNarrationTests.IdleTurnsKeepAuditAndDeathWait`验证原日志、实际伤害、时间与旧行为；目录及52检查单保独立基线。
7. **正误/限制**：仅改大检查单不能修复待叙述帧没有后续候选的接口问题；应在保存点恢复可执行上下文。自由语义仍归DM，固定模型只证明流程，不证明真实复合意图质量；单步移动多一次模型判断，不另加审稿模型或玩家确认。

## 11. Wrong vs Correct

错误：因侦察缺战术比例而跳过必要检定，或用模型DC代替NPC真实隐匿；正确：先保存一次真实隐匿/本人对抗，仅实际开战前绑定战术布局。绑定不能仅看全局Hidden忽略每位观察者的新视线，也不能把一人的发现广播全队。

错误：玩家取消专注投掷→默认成功并继续移动；Shield关闭面板→当作pass。

正确：取消只移除那份未执行PendingRoll，公开战斗wait仍在；重新提出本人回应或明确结束专注/放弃反应，再沿持久步骤继续。队员不能替队友确认。
