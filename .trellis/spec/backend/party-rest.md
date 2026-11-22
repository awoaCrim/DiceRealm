# DM发起的全队休整

## 1. 范围与所有者

改变休整发起、团队时钟、个人恢复窗口或客户端入口时适用。`PartyRest`拥有全队资格与恢复，`GameService.RestParty`复用`HostCommand`的权限/回执/事务；个人生命骰、奥术回想、准备与来源重选仍由本人原命令所有者执行。来源选择细节只在[休息来源选择](rest-source-choice.md)维护。

## 2. 签名

- `GET /api/v1/campaigns/{id}/party/rest` → `PartyRestView(Version, Options, Participants)`。
- `POST`同路径，严格JSON且上限8192字节：`{requestId,expectedVersion,kind}`，kind仅`short|long|wait`；没有actor、时长、骰点或恢复数值。
- `PartyRestOption(Kind,Label,Seconds,Available,Reason)`；参与者仅当前有效角色姓名。响应为原`ActionResponse`，resolution.kind为`party.rest.<kind>`。
- `PartyRest.RequirePlayerAction(kind)`拒绝玩家发起`rest.short|rest.long|rest.wait`。`rest.hit_die`、`rest.arcane`只使用已完成短休的本人窗口，不再推进一小时。

## 3. 合同

GET必须主持权限、纯投影，不初始化持久状态。POST先认证/主持权限，再原回执、版本、资格和原子保存；沿用原actor-scoped回执与存档schema，无新持久字段或环境变量。原请求重放不再次推进时间、恢复、清窗口或调用模型。

参与者为队长与审核批准且未撤权的席位；共享时钟只推进一次：短休3600秒、长休28800秒、wait为全队最大剩余长休间隔。短休按原资源策略恢复并为每人打开生命骰/奥术回想窗口，不自动治疗、不代掷骰；长休恢复各人生命/资源并打开其准备/来源选择窗口；wait只推进时钟、关闭窗口，不恢复生命/资源。非致命恢复沿用现有条件，不替玩家自动起身或捡武器。

队友的个人命令不能关闭其他成员的恢复窗口；本人普通已结算行动关闭本人窗口，恢复选择保留剩余可选项；共享旅行/开战等环境转换关闭全队窗口。窗口不是地点/战斗权限：每次命令仍重验当前环境与行动资格。旧成功回执保持原语义；升级前未确认的发起休整请求只可明确取消，不可继续或悄悄转换成DM全队休整。

`WearableEquipment`的本人专注同调/解除是独立的物品规则动作，不是绕过host-only的全队休整：每次新耗3600秒、检查安全地点与有效成员pending，只恢复本人原短休资源并打开本人生命骰/奥术回想窗口，不恢复队友。普通瞬时wear不继承这套休整门禁；详见[穿戴同调规范](natural-effects.md#完整穿戴与同调)。

## 4. 校验与错误

| 情况 | 结果 |
|---|---|
| 非主持GET/POST | `forbidden` / 403，无读写或骰子副作用 |
| 额外actor/时间字段、坏正文 | 原严格JSON 400；kind非allowlist为`invalid_rest` / 400 |
| 玩家新/旧发起路径 | `rest_host_required` / 409；本人已成功原回执先重放 |
| 战役归档 | 原HostCommand的`campaign_archived` / 409；GET投影不可用 |
| 内容未启用、战斗、有效成员仍有pending意图/骰子、不安全地点、0HP/致死Exhaustion或不符合恢复条件的昏迷 | `rest_unavailable` / 409，无部分成员恢复、无时钟/骰子变化 |
| 长休间隔未完、wait无剩余间隔 | `rest_unavailable` / 409 |
| 过期版本、UUID换正文 | 原`stale_version`、`idempotency_conflict`，不能自动新建请求 |

## 5. 正常、兼容与拒绝

正常：DM短休→每人独立决定是否投生命骰/奥术回想→只扣本人池，队伍时间仅增加3600秒。兼容：旧已成功休整回执原样恢复，旧未确认请求可取消。拒绝：客人冒用主持端点、在自然候选或`/actions/propose`里发起休整、替队友投骰、把一次全队长休循环成多人倍数时长。

## 6. 必需验证

`PartyRestTests`覆盖纯读、批准/撤权席位、单次时钟、短休0自动HP/骰子、非致命恢复、长休及独立来源窗口、wait、资格拒绝与原子性。真实HTTP须覆盖host/guest、额外字段、旧入口/未确认旧roll、本人骰子前0消耗、跨席拒绝、取消、并发、重启原回执与旧成功回执。`AdvancementRestHttpTests` / `AdvancementRestChoiceHttpTests`继续验证本人选择和来源不串用。

工作台`party-rest.test.js`断言独立只读logical key、冻结版本、取消0写与dispose；真实浏览器另验丢响应→刷新→同字节重试以及guest403。Unity只显示本人后续选择，不增加DM发起按钮。包验证须针对最终嵌入JS和程序集，磁盘源码不等于日常服务。

## 7. 错误与正确

错误：把旧`rest.short`调用自动改发全队休整，或只在Unity隐藏按钮；每个角色执行旧休整导致时间增加N次。

正确：独立主持端点先整体验证，统一推进时间后按原恢复策略更新成员；旧玩家入口权威拒绝，个人确认与原请求恢复各保留唯一通道。
