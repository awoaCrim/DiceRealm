# 行动、裁定与剧情后果

自由行动进入裁定后，可以沿用已保存的检定，由主持预览确认导入内容中的后果，再继续探索。本文不涉及自然语言理解、自动战斗或新规则。

---

### 使用路径

1. 玩家在 Unity 提交自由行动，或使用已有角色操作。新行动会保存原文或操作标签、角色、地点、目标、旅程时间，以及服务端确认的角色变化。消耗已经发生与效果仍待处理会分别显示。
2. 主持在工作台「剧情」页右栏的「待确认」查看原始行动，记录回应与依据，需要检定时通过 [按需投掷](contextual-rolls.md) 等待原玩家确认并保存结果；处理后的结果出现在剧情线中。主持经 `rulings/respond|resolve` 可附仅原行动者与主持可见的 `privateText`。
3. 在该记录的「让故事继续」中选择已有行动后果，或明确结束且不追加剧情变化。原始事实调整保留为高级方式。
4. 点击「预览实际变化」，检查任务、路线、场景、人物、关系、章节和物品变化；确认后才写入。预览失效时需重新核对，不会自动沿用旧版本。
5. 玩家按 J 打开「历史原文」，从新到旧查阅已保存输入、检定、消耗及角色/剧情变化。「冒险回顾」按故事记录阅读，「任务与人物」分类查看已知世界信息；独立「行动进展」和「同行伙伴」页已移除，队友资料从头像打开。

阅读旧页保留事件范围；关联裁定和后果按查询时的当前版本投影。Unity 同步发现新版本时提示刷新，不跳走正在阅读的位置。旧存档继续可读，但原本没有保存的输入、成本或目标不会被猜测补写。

---

### 后果的范围

`facts` 只接受当前导入内容已经声明或引用的事实，每次最多改动 16 项；禁止伪造 `visited:` 地点记录。主持仍需判断该事实是否符合本场叙事，这不是 AI 自动推理出的结论。

`action` 选择当前场景中已有的导入行动，应用其公共后果及指定结果分支。带检定的行动要求裁定中已经存在属性、技能、DC 相同的检定，并使用实际成败分支；不会重掷。一次性行动结算后不可再次领取。若物品成本与原行动或已记录角色效果重叠，预览拒绝，主持应改用事实确认与单独的角色调整。导入内容的物品奖励继续进入队长库存，不复制到所有席位。

`none` 明确结束而不改变世界，可用于已经换场景的旧请求。已经驳回或已经落实剧情后果的记录不再重复应用。换场景、旧战斗或撤销席位后不能借原请求改变当前世界。

原行动已付出的法术位、资源和物品不会因驳回自动退还。需要补偿时，通过主持调整另行预览确认。角色面板里的无 DC 独立检定仍是单独记录，当前没有“事后指定 DC 并转成剧情裁定”的入口；不要为了补后果随意重复掷骰。新剧情扩写、AI 上下文筛选和更广的规则执行不在此范围。

---

### 协议与实现

公共只读接口：

- `GET /api/v1/campaigns/{id}/activity?after=0&through=...&limit=50` 返回 `campaignId, version, through, after, nextAfter, hasMore, entries`。分页按原始事件序号前进，只有主持事件的一页可能没有行动条目，仍应使用返回的游标。
- `GET /api/v1/campaigns/{id}/activity/{sequence}` 读取指定原行动，包括早于快照最近历史窗口的记录。
- 条目包含 `origin, initialResult, narrative, ruling`，状态为 `awaiting_ruling / awaiting_consequence / rejected / completed`。`version` 表示关联进展的当前版本，`through` 只固定原事件范围。`ruling.privateText` 对其他席位恒为空串，规则见 [契约](../.trellis/spec/contracts.md)。

主持接口：

- `GET /api/v1/campaigns/{id}/rulings/story-options?rulingId=...` 返回允许选择的事实、行动结果和不可用原因。队员不能读取完整选项目录。
- `POST /api/v1/campaigns/{id}/rulings/story-preview` 只读计算；`POST /api/v1/campaigns/{id}/rulings/story` 正式提交。两者使用同一份 `{requestId,expectedVersion,rulingId,mode,rationale,ruleSource,contentActionId,outcome,facts:[{key,present}]}`。
- 确认及网络重试保留原预览的请求 ID、版本和载荷。完全相同的重试返回原结果，不重复扣除、掷骰或应用后果；不同载荷复用 ID 会拒绝。

服务端实现位于 [行动投影](../server/DiceRealm.Server/Domain/ActivityModels.cs)、[剧情后果计算](../server/DiceRealm.Server/Domain/StoryConsequences.cs) 和 [查询与提交服务](../server/DiceRealm.Server/Application/ActivityService.cs)。工作台的 [行动与后果界面](../client-workbench/src/activity.js) 负责选择、预览和原请求恢复，Unity 的 阅读格式 与 手记入口 只展示服务端记录。
