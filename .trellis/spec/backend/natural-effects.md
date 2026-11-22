# 自然输入可执行效果与已证实后果

## 1. 适用边界

新增／修改探索能力、物品、来源法术或剧情后果时适用。行为所有者为 `NaturalActions` 与 `VerifiedStoryConsequences`；模型只选择服务端已提供ID，不提交机械数值。实际支持范围及来源入口只维护在 [自然效果说明](../../../docs/natural-action-effects.md)，不要把建卡取得或资料可读当作自动效果覆盖。

## 2. 签名

- `NaturalActions.Choices(Campaign, CharacterSheetView? = null)` 纯投影；`Resolve(Campaign, CharacterPlayRequest, RulesEngine)` 只执行再次验证的完整key。
- `ActionUnderstanding.Candidates(Campaign, bool includeNatural = true, string rootId = "", bool includeStandard = true, bool includeStandardExpansion = true, bool includeRestChoices = true, bool includeRecording = true, bool includeWeaponSelection = true, bool includeLoadout = false)`；Harness仅工具契约>=8打开effect分支，0..7显式关闭。新自然解释与工具契约>=12传`includeRecording:false`，不提供通用use/spell/feature记录候选；旧冻结选项重验证保留默认true。
- `CharacterPlayEngine.View(Campaign,bool includeEffects=true)`追加可空`effects: SheetEffectOption(Key,Label,ItemId,SpellSource,Details)[]`，直接复用`NaturalActions.Choices`。Choices缺sheet时用`View(c,includeEffects:false)`避免递归。itemId是库存ID，spellSource是角色卡精确施法来源ID，不以名称/法术ID匹配。
- `VerifiedStoryPlan(RulingId, ActionId, RootSequence)` 是私有持久计划，不是客户端请求。
- `ContentItem(..., string? RulesId = null)` 仅允许已完整支持的typed条目；null省略，保持旧导入hash。

## 3. 确认／存储合同

既有actions_propose只建立待本人确认；effect／story不能走InputContinuation无确认直接执行。`CharacterPlayRequest.Operation=execute`、Value=1；Key指定完整已提供来源，不叠加任意数额。同一CampaignStore gate内授权→原回执→版本／能力→规则→state/events/receipt原子提交。所有资格和库存／资源校验在骰子之前；派生细节不是新授权。

客户端新快捷操作只提交服务端提供的完整effect key（`operation=execute,value=1`）或既有装备命令；先显示目标、来源、骰子和成本，选择来源不提交。缺effect的物品仅回填自然输入草稿，已有草稿不覆盖、不自动发送。新目录优先已实现执行或非机械叙事，缺依据先澄清，真正疑难才请求人工裁定；不声称任意D&D动作已自动化。旧use/spell/feature不重新解释为自动化，否则未确认旧选项可能产生从未同意的骰子和效果。对已保存旧回执不得以当前公式重算。新恢复骰与真实HP/成本进入权威结果和ActionOrigin；最大骰面明确记为未掷骰。

## 4. 验证及错误

未绑定同名药水、资源用尽、源法术不可用、无法行动、战斗中→不提供候选／`action_unavailable`；追加Value或模式→`invalid_character_command`。换版本沿用现有stale/intent_context_changed，不能自动重新解释选择。自动剧情要求actor、root、scene、同属性/技能/DC与真实check结果；重复Story、手工effects、负物品成本、无check→不提供／`story_action_unavailable`。手工主持Story的权限不能因新增本人后果分支而放松。

## 5. 正常／兼容／拒绝

正常：已取得来源法术→明确源与资源→本人确认→治疗+扣该池→重复请求原结果。兼容：旧0..11工具目录/指纹冻结，旧运行仍提供原手工记录候选，ContentItem缺RulesId保持hash。拒绝：模型把同名叙事物品当药水，或使用另一轮成功检定领取当前奖励。

## 6. 必需断言

保留 `NaturalActionTests` 的多职业Fighter等级、不同施法源、实际高环级、Life修正、无能力状态和不变预览。`NaturalActionHttpTests` 必须检查确认前0骰/0成本、外席不能确认、并发仅一次、cancel/stale无效果、原回执重开、原check不重掷与奖励不重复。`SheetEffectsAndRecordingCompatibility`须验证GET纯投影、精确item/source关联、新v12排除通用记录而v11保持、旧冻结命令原语义和目录golden。Unity真实JsonUtility覆盖effects缺失/null/合法，确认前0发送与多来源不默认第一条。扩充新目标必须有真实距离／视线与本人控制边界，不能只凭同场景默认触及。客户端通用选项可复用，但真实浏览器／Player验证不得互相替代。

## 显式装备组合与物品阅读

1. **范围/签名**：`EquipmentLoadout.Read/Validate/View/Commit`是装备组合所有者，`PlayCatalog.ActiveWeapon/HeldItems/SetEquipment`复用它。`CharacterPlayState.Loadout`为可空/null省略的`CharacterLoadout`；字段、槽位投影和命令完整合同归[客户端协议](../../../docs/client-contract.md#character-use-and-host-adjustments)，不在客户端另算手部规则。
2. **合同**：非空Loadout是唯一真相，ActiveWeaponId仅同步兼容桥。近远各主副手，当前组持握，另一组保留；同组同ID需两件，跨组需求取最大。2H/V双握副手只占用不复制库存；V按dmg2结算，Heavy检查真实H属性，不能把双握当Heavy。盾仅实际持握影响AC/Monk速度，所有入口（包括旧equipment.equip）通过Seconds推进穿脱时间。2H可释放一手作S，不自动满足M/focus或单手弹药装填。
3. **读写/版本**：`operation=loadout`只接受服务端完整key、value1/normal/空choices，经原gate/版本/回执原子提交。null旧档只读推导，不迁移GET；旧quarterstaff无盾默认双握保持旧伤害。标准掉落记录具体slot，拾回实际物品/数量，非当前组不掉；仅active棋盘限制掉落物，闭幕棋盘保持历史。新模型槽位事实/候选仅v20，0..19目录与v19 self冻结。`CharacterRuleDetails`继续按目录身份读取ItemDetails，不靠同名获得能力。
4. **错误矩阵**：缺物/训练/数量不足、2H或V双握副手冲突、非法slot/set/grip、失能/战斗中→不可选理由或loadout_unavailable/invalid_character_command，零部分写；扣库存不能留下悬空配置。未知物品正文明确缺口，不能从可读规则推出自动执行。
5. **正常/基线/拒绝**：短剑主手+匕首副手+短弓远程可同时配置，切组只改变实际持握；副手非轻型可合法持有，不授权Light额外攻击。旧缺loadout安全读取与原回执重放；同一件匕首占当前组两手必须拒绝。远程/投掷/装填与Light额外攻击未由此自动实现。
6. **验证**：`EquipmentLoadoutTests`覆盖手槽、数量、盾AC与时间、两用伤害、标准双掉落拾回、闭幕历史、旧入口时间、Heavy区别、HTTP拒绝零写/回执/重启、0..19 golden及真实Pi20候选/self；`ReadyWeaponsTests`与原自然/战斗/恢复测试保持旧边界。测试替换inventory时须同步真实Loadout，不能靠放松产品校验容忍夹具悬空引用。
7. **正误**：错误是用唯一ActiveWeaponId伪装副手、按库存首项选攻击、准备远程即取消盾或把所有已配置物品一起掉落；正确是按当前组和具体槽统一派生手部、AC、攻击与掉落。

## 完整穿戴与同调

1. **范围/所有者**：`WearableCatalog`拥有经过明确dnd2024取证的有限注册表，`WearableEquipment.View/Apply/Project`共享穿戴、同调资格与运行投影；详细wire归[客户端协议](../../../docs/client-contract.md#wearables-and-attunement)，效果范围归[角色使用](../../../docs/character-play.md#完整穿戴与同调)。不用物品名称授能力或把BG3槽数当D&D限制。普通长袍仅由`WearableCatalog.For`匹配legacy缺RulesId的robe或显式equipment:xphb:robe/xphb:robe，显式未知身份不回退；不能加入魔法Items/ById而改变普通获物。沿原wear通道投影动态clothing:<itemId>及空衣着槽，不增加AC/Armored/同调或限制衣物层数；固定五槽顺序不变。`WearableEquipmentTests.OrdinaryRobeIdentityNoArmorAndHttpPersistence`与`WearableUiTests`覆盖身份、无AC、穿脱回放/重启与精确候选。
2. **签名**：原`CharacterPlayRequest`新增`wear|attunement`；完整key、value1/normal/空choices。`Item.RulesId`、`CharacterPlayState.Attunements`为可空兼容增量；`CharacterSheetView.Wearables`与`Character.EquipmentStatus`只读投影，无新端点/环境开关/数据库迁移。
3. **合同**：普通wear不套SafeRest或队友pending；专注同调才消耗新3600秒、检查共享时钟阻塞，只恢复本人原短休资源/本人生命骰窗口。穿戴不自动同调、卸下不解除；0HP不等于死亡，缺库存不等于已满足离物距离/时间。缺失实物仍按同调记录提供unattune，不造库存。AC来源和数值同一公式；公开技能/豁免不能写回取得记录。issues用简短去重问题，完整未支持原因留item.notice，不合并物理实例。
4. **拒绝**：额外value/mode/choices或非提供key→invalid_character_command；槽冲突/失能/不满足专注休息/3件或同类重复→不可用理由及wearable_unavailable/409。重放先于当前资格，拒绝零部分写；缺库存结束不额外要求接触。旧v0..20拒新获物目录，不能只靠schema阻挡。
5. **正常/基线/拒绝**：正常穿靴直接生效、披风另作本人短休同调；旧无字段读取不迁移、原回执不重算；固定头槽冲突不能挤掉另一件，三戒指可同时穿戴但同类不可重复同调。
6. **验证**：`WearableEquipmentTests`覆盖五项真实效果/死亡豁免/甲盾条件/同源AC、纯读与取得记录不变、失物和他人同实例同调、仅本人恢复、HTTP并发/重启/原请求及v0..20黄金基线。真实Pi/fake须验证直接wear与attunement本人确认两种流程；Unity须验证实例含冒号、图标用规则身份、普通换装零重复确认、缺库存状态解除和原请求恢复。
7. **正误**：错误是所有穿戴都要求安全休息，或同调后将能力永久加进BuildMechanics；正确是在各行为所属门禁判断、以权威实物/同调记录临时派生，并保留原事务和单一请求通道。

## 7. 反例

错误：把旧case spell改成看见名称就治疗，模型说成功便写facts，或放松StoryConsequences.RequireHost让任何人补后果。
正确：新独立execute候选冻结具体来源并等待本人；后果使用当前root的真实检定和已导入action，复用ContentRuntime.ApplyOutcome，保留原主持任意修正权限。
