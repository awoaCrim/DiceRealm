# 全屏建卡与本机角色

## 1. 范围与触发
Unity玩家加入房间、新建/恢复草稿、跨房间选择归档角色。此合同覆盖历史「关闭丢弃、不持久化建卡」约定。服务器拥有规则、角色派生、新席位与审核；客户端不迁移成长、伤势或游玩后战利品。

## 2. 所有者与签名
- `CharacterBuilderPanel.Show(..., BuildDraftEnvelopeDto restored, Action<BuildDraftEnvelopeDto> saveDraft, Action onClose)`恢复本次编辑，`CaptureDraft/PersistDraft`保存；`Accept`留在复核等待真实加入，`CompleteJoin`关闭但不复活已清稿。
- `CharacterLibrary`拥有`characters/drafts`与`characters/archive`；`SaveDraft/LoadDraft`、`ArchiveJoined(receiptKey,build,character,sourceArchiveId)`、`RemoveSubmittedDraft(id,version,build)`。
- `AdventureCharacterCreation.OpenLocalCharacter`读取目录及导入检查，await后核对`alive`、Party的`ReadVersion`和连接地址。`PartyPanel`拥有房间信息/本地列表；`AdventureParty.RetryJoin`拥有回执与本机后处理。
- `PendingJoinStore.BeginRoom`可带本机草稿关联；`RecordAccepted`冻结首个有效成功响应。HTTP请求仍是既有五字段，不新增本机元数据。

## 3. 数据与界面合同
- 人物外貌、性格、经历是多行原文。公共`UiKit.Input`先设置`lineType`再加载`text`，否则uGUI会在默认SingleLine模式下删除换行；测试必须检查首次呈现、跨页重建与草稿恢复后的实际InputField.text，而不只核磁盘JSON。`FullCharacterBuilderTests.MultilineIdentitySurvivesPageRebuildAndDraftRestore`覆盖三字段。
- 复核背包优先用精确目录ID，目录未含某项时将服务端`ItemDto.name`作为现有`RuleReference.BuildName`的回退名称；货币/起始包不一定在可购目录，不能丢掉已有名称只展示`gold-piece`或`scholars-pack`。保留未知自定义名称，不改ID或数量。回归`ReviewUsesServerItemNamesForPackAndCoinsOutsideThePurchaseCatalog`。
- 草稿schema2：完整build、独立id、sourceArchiveId、activeStep、visited/needsReview、choiceSource/choiceGroup/equipmentPage、editVersion/savedAt。每次编辑与导航保存；新建独立空稿，关闭保留。恢复后重验，不能把已保存complete当有效结果或覆盖手动属性。
- 角色归档schema1：id/savedAt/receiptKey/build/完整CharacterDto；不含密码、token、完整snapshot。只有有效加入成功后创建；相同回执去重，未改归档跨房间复用不重复保存，改动另存。
- 原pending可含私有凭证和首成功响应，但不能复制到角色库。顺序：验证有效加入回执→持久首响应→保存连接/库/角色→清匹配修订草稿→清pending→更新UI。归档失败不重新发加入。
- 全屏向导在主root下，不经辅助页UiPageFit，不修改用户显示/密度偏好；背后的加入页退场且禁止交互。最终动作直接加入，不再「采用→回加入页再提交」。
- 来源按真实key分类：languages通用；species:/background:/class:及其子分支保持父来源，$classSkills/$expertise属职业。固定来源Tab（BG3页签）和独立组导航（BG3行样式），仅展开当前组。角标用服务端complete，检查期间显示检查中。左下可展开漏项卡与复核共用`GoToIssue`：切步骤/来源/组、清筛选、显式定位与聚焦；漏项卡展开拥有Tab焦点，Esc只收卡。普通评估不抢外部焦点。
- 移除冗余上/下一步；左侧导航离开当前步骤前执行`AcknowledgeStep`，未验证/仍缺项不伪装通过。关闭入口为「保存草稿并退出」，仅真实保存成功显示「草稿已自动保存」。
- 所有选项组均不提供「清除此组选择」或同义批量清组按钮，包括来源、法术、装备中的单选和多选。当前服务端group.count为必须达到的精确数量：count==1重复点击保持已选；count>1可逐项取消。失效来源的专用恢复与上游依赖失效清理仍保留，不用它们给合法组重建清空入口。以后若协议引入可选组，按显式合同支持逐项取消，不靠标签猜测。
- 法术分组仍使用服务端key，仅展开当前组（组页签用`UiKit.Tab`）。BG3式“选中/可用”图标格：按钮只画图标与金框选中标记（无任何图时显示首字），名称、环级·学派与完整详情（时间/射程/专注/持续/学派/效果，来源为锁定2024规则包）在该按钮`UiHint`的`Title/Subtitle/Explanation`提示卡里；悬停/聚焦只读，不改draft版本或选择。不再有右侧法术详情栏。150%沿用全页放大与外层滚动，不能假称所有栏同时在视口内。
- 真正加入与本机归档完成后展示本人角色高光页，可进入冒险或伙伴页；仍显示真实待审核状态，不把开始冒险按钮当作绕过主持批准的授权。
- 装备主页面按实际目录并排所有方案，不能假设只有A/B（战士有C）。职业/背景两排，包内/购物/穿戴独立子页，顶部装备面包屑返回；购物名称/价钱/购买按钮分列对齐。钱只显示一次，省略0币种，全零显示0金币。保持真实中文行高；窄卡末件长名称独占整行，禁止缩字或截掉物品。

## 4. 校验与错误矩阵
| 情形 | 行为 |
|---|---|
| 草稿/归档损坏 | 原件保留、该条不可选，不挡其他角色；不覆盖坏文件 |
| 目录修订变化 | 保存前自动保留原稿修订副本，当前副本重验；不是直接当坏档 |
| 保存草稿失败 | 当前输入留在内存，明确重试；不能虚报已保存或关闭丢输入 |
| 加入明确拒绝 | 按原协议清请求并保留草稿供纠正 |
| 加入未知/429/不匹配响应 | 保留原端点/ID/payload，只恢复原请求 |
| 加入成功、本机后处理失败 | 明确已加入但保存未完成；首响应在pending中，恢复不发新POST |
| 导入合法一级归档 | 目标服务重验后直接明确加入；原归档不改 |
| 导入非一级归档 | 明确当前协议不支持成长迁移，不静默降级 |
| 迟到目录/评估/加入响应 | 核对读取代次、连接、会话、草稿修订；不覆盖新上下文 |

## 5. 正常、空白与错误示例
正常：新建→保存关闭→继续→直接加入→自动归档→重启→另一房间选归档→目标房间重新审核。空白：无本机记录仍可新建；没有手选法术不制造空页。错误：canCreate就归档、草稿存token、原成功后本机失败用新UUID加入、导入旧actorId/HP作为权威值。

## 6. 验证
`LocalCharacterTests`覆盖独立草稿、手动属性保留、修订备份、坏档、完整归档、去重和匹配清稿；`RoomJoinSyncTests`真实loopback HTTP覆盖未知原字节重放、迟到回执与归档写失败恢复仅一次join POST；`CharacterWizardNavigationTests`覆盖来源父级/长组隔离、两处精确定位、中文搜索、第三装备方案与子页；`CharacterBuilderFocusTests`逐帧断言固定属性实例与位置。测试全屏几何必须明确画布尺寸，不能沿用默认100×100并误诊为产品问题。

真实验收另走独立Windows Player + headless工作台：空稿完整建卡、批准回读、重启选档跨房间；1920/1280/宽屏、150%与真实最长方案。鼠标/键盘程序事件不等于OS IME验收。正常交付禁Pipeline，QA在独立非输入desktop，不抢用户焦点。

## 7. 错误与正确
错误：成功响应后先清pending，再尝试归档；磁盘失败就失去依据。正确：首成功响应先落入原pending，本机后处理全部完成才清；重启恢复时只读首响应完成归档，不重复接纳角色。
