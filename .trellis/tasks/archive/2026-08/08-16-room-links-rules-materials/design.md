# Design: 剧情历史、DM 剧情展示与规则资料清理

## 1. 设计边界

本任务包含两个前端展示修复和一个完整功能删除：

- **剧情历史**：复用现有 `platform_turns`、`platform_turn_entries` 和按 turn 的 entries HTTP 接口，在客户端增加回合历史选择/展开，不改变结算写入或可见性协议。
- **DM 剧情**：复用现有 Owner 全量 entries 投影和玩家端安全 entry renderer，在 Owner 回合工作区增加正常的剧情阅读区域；AI `context/result/rawDebug` 仍是 Owner 调试辅助，不作为剧情主视图。
- **规则资料删除**：移除规则来源元数据的全部生产链路、持久化表、共享 contracts 和专用测试；不删除邀请码、session token、迁移完整性等其他用途的 SHA-256。

房间邀请链接不在本任务范围内。

## 2. 剧情数据流与可见性

现有数据流保持不变：

```text
AI formal apply
  -> platform_turn_entries（按 turn_id + entry_index 持久化）
  -> GET /api/campaigns/:campaignId/ai/turns/:turnId/entries
  -> projectEntries(subject, rows)
  -> Player/Owner 共享的可读 entry renderer
```

- `TurnRepository.listByCampaign()` 已返回所有未被 archive restore supersede 的回合，按 `number ASC` 排序。
- `TurnEntryRepository.listByTurn()` 已按 `entry_index ASC` 返回当前有效 entries。
- Player 的服务端投影继续只允许 `public` 和目标为当前玩家的 `player_private`；Owner 继续读取全部 entries。
- 不新增“把所有剧情一次性返回”的宽接口。客户端根据回合列表按需加载 entries，避免历史回合数量增长时一次请求所有正文。
- `campaignEntriesKey(campaignId, turnId)` 继续按回合分缓存。实时事件对 campaign 前缀的失效会使当前/历史已缓存 entries 在下次显示时更新，但不会从 UI 结构中删除旧回合。

## 3. 客户端剧情展示结构

### 3.1 共享组件

将现有 `client/src/features/player/story/TurnEntries.tsx` 提取到一个 Player/Owner 都能依赖的 story/turn 组件位置，并保持其安全 payload 解析行为：

- narrative → 读取 `{ text }`；
- private_update → 读取 `{ text }`；
- dice_result → 读取 `{ formula, total, label? }`；
- 未知或 malformed payload → 固定安全回退文案，不直接渲染未知对象。

新增回合历史展示组件，职责仅是：

- 接收 `TurnListEntry[]`、当前角色和可选的当前 turn；
- 显示回合编号、状态、是否为当前回合；
- 每个回合使用独立子组件按需调用 `useTurnEntries(campaignId, turnId)`；
- 展开/收起时读取该回合 entries，保留 React Query 的按 turn 缓存；
- 当前回合默认展开，历史回合默认收起，避免新回合刷新时页面跳到旧内容；
- 在当前回合尚无 entries 时显示“本回合尚未产生剧情”，而不是回退并伪装成当前回合剧情。

Player 和 Owner 共用 entry body 与历史容器的基础行为，角色差异只来自服务端投影和 Owner 页面布局。不要让 Owner 直接 import Player feature 私有组件。

### 3.2 Player 页面

`PlayerStoryPage` 不再选出单一 `storyTurn`，而是：

1. 使用 `useTurnList` 获取所有 active turns；
2. 将最新 turn 标记为当前回合；
3. 渲染当前回合与历史回合；
4. 保留 SSE AI preview 和 preview error 区域；
5. 不改变 Player 端的 entries API、query key 或安全投影。

这样进入下一回合只会增加一个新的当前回合卡片，旧回合仍能从历史列表展开。新的 waiting turn 没有 entries 时不影响上一回合历史。

### 3.3 Owner 页面

`OwnerTurnPage` 在当前回合状态/玩家行动区域之后增加剧情区域：

- 使用与 Player 相同的回合历史数据；
- 当前回合默认显示 Owner 全量 entries；
- Owner 可看到公开叙事、所有玩家私密结果和骰子结果；
- 历史回合按需展开，避免一次请求全部正文；
- `OwnerAiRunPanel` 保留并继续显示运行状态与调试详情，但不再承担剧情阅读职责。

## 4. 规则资料删除清单

### 4.1 Client

删除：

- `client/src/features/owner/rules/OwnerRulesPage.tsx`；
- `client/src/api/rules/rulesApi.ts`；
- `client/src/entities/rules/ruleQueries.ts`；
- `client/src/shared/lib/contractSchemas.ts` 中规则 envelope；
- `campaignRuleSourcesKey`；
- `AppRouter` 的 Owner rules import/route；
- `OwnerSidebar` 的“规则资料”导航项；
- Owner workspace 测试中的 rules mocks、导航断言、登记测试；
- 规则相关 CSS，仅在确认没有其他消费者后删除。

### 4.2 Server 与 contracts

删除：

- `server/src/routes/rulesRoutes.ts`；
- `server/src/modules/rules/RulesService.ts`；
- `server/src/modules/rules/RulesRepository.ts`；
- `server/src/tests/rules-routes-http.test.ts`；
- `server/src/modules/rules/rules.test.ts`；
- `packages/contracts/src/rules.ts` 及其测试；
- `packages/contracts/src/index.ts` 的 rules export；
- `server/src/app.ts` 的 RulesService/createRulesRouter import、实例化和 route mount；
- `INVALID_RULE_SOURCE` 共享错误码、HTTP status map、client retry allowlist 中的专用分支；
- 规则专用的 security/body-budget 测试调用。

删除后重新搜索 `RuleSource`、`rules/sources`、`platform_rule_sources`、`contentHash`、`INVALID_RULE_SOURCE`，允许历史设计/归档文档保留描述，但生产 TypeScript 和维护测试不应有残留引用。

### 4.3 Database / migration

- 从维护 schema/baseline 中删除 `platform_rule_sources` 表及所有相关索引与约束。
- 删除 `server/src/platform/database/migrations/011_rule_sources.sql`，并从迁移 manifest、approved migration fixture、fresh schema inventory 和数据库测试中移除对应条目。
- 为当前用户明确要求保留数据的场景增加一个窄化兼容迁移：仅当 `platform_migrations` 精确等于维护集合加 `011_rule_sources.sql`，且 `platform_rule_sources` 是带预期列的实际表时才执行。
- 兼容迁移先在数据库目录的 backup 目录中用 SQLite `backup()` 创建不可覆盖副本，并复制现有普通 credential key；然后在一个事务中只 `DROP TABLE platform_rule_sources` 和删除精确的 `011` tracking row，事务内执行 `integrity_check` / `foreign_key_check` 后才提交。
- 表缺失、列异常、迁移集合不完整/含 foreign version、tracking row 名称异常或 backup 失败时 fail closed；不删除、替换或重建数据库。
- 不动其它表，不动 `platform_ai_provider_configs`，不动 AI entries 和 archives 表。

## 5. 错误码与 SHA-256 边界

`INVALID_RULE_SOURCE` 只服务被删除的规则登记 API，因此一并删除。以下哈希用途必须保留并单独回归：

- `hashInviteCode`：邀请码摘要校验；
- `digestSessionSecret`：session/CSRF 摘要；
- migration/backup integrity hash：若当前启动链仍需要，按其所属启动任务处理；
- Provider credential fingerprint：若仍被其他维护代码引用，不能因为字段名相似而误删。

## 6. 兼容性与恢复

- 新客户端不再生成规则资料请求；旧的规则 URL 按普通未知路由处理，不保留空壳页面。
- 精确匹配的旧规则资料数据库由普通启动默认迁移；迁移前 backup 是显式恢复点，数据库/key 需要成对保管。迁移成功后旧表和 tracking row 不再存在。
- 无法确认安全的旧数据库不通过猜测式转换；启动失败并保留原文件，操作员可使用备份或显式重建处理。
- 存档恢复的 `superseded` 过滤保持不变。历史剧情展示只覆盖当前 active timeline，不新增历史分支恢复模型。
- Owner/Player entries 内容仍由同一后端投影决定，前端不可绕过接口自行过滤或补回敏感 entry。

## 7. 主要取舍

- **按回合懒加载而不是新增批量历史接口**：复用已有契约、改动小、避免一次加载大量正文；代价是首次展开每个历史回合会有独立请求。
- **共享可读 entry renderer 而不是展示 `result` JSON**：用户看到的是稳定的产品内容，调试结构仍可供 Owner 排查；代价是未来新增 entry kind 需要同时更新 renderer 和 contract。
- **删除规则资料而不是隐藏**：避免无用途的数据表、错误码和 UI 继续扩大维护面；代价是未来重新设计规则导入时需要新建功能，而不是在旧 metadata registry 上继续扩展。
- **窄化默认迁移而不是直接要求 rebuild**：保留当前用户的战役/回合数据，同时避免对任意旧库执行不可审计的 destructive conversion；代价是只支持一个可精确识别的 011 旧状态。
