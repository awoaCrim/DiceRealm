# Implementation plan: 剧情历史、DM 剧情展示与规则资料清理

## Phase 0：基线与影响面

- [x] 记录当前工作树状态，确认不触碰无关的 `.mcp.json` 和用户已有修改。
- [x] 运行规则资料引用盘点：`RuleSource`、`rules/sources`、`platform_rule_sources`、`contentHash`、`INVALID_RULE_SOURCE`，区分生产代码、测试、迁移和历史文档。
- [x] 确认当前迁移/启动任务的兼容边界：默认迁移只处理精确可识别的 `011_rule_sources.sql` 旧状态，不会删除或替换用户数据库。
- [x] 为剧情 fixture 准备至少两个 active turns：一个已完成且有 public/private/dice entries，一个新的 waiting turn；准备两个玩家以验证私密投影。

## Phase 1：先固定剧情行为（测试先行）

1. [x] 在客户端 player workspace 测试中新增 RED 用例：两个回合都存在时，剧情页显示当前回合和历史回合入口。
2. [x] 新增 RED 用例：当前回合从已完成切换为新的 waiting turn 后，上一回合剧情仍可展开；不再依赖单一 `storyTurn` 回退逻辑。
3. [x] 新增 RED 用例：Player 只能看到 public 与自己的 private entry；另一个玩家的 private entry 和 owner-only entry 不显示。
4. [x] 在 Owner workspace 测试中新增 RED 用例：当前回合显示 narrative/private/dice 的可读内容，不要求展开 raw AI JSON。
5. [x] 新增 RED 用例：Owner 可以展开上一已完成回合的剧情；空 entries、未知 payload 和 entries 请求失败仍有安全/局部错误状态。
6. [x] 复用现有临时 SQLite HTTP 测试验证指定 `turnId` 的 entries 与 Owner/Player 投影；现有 `ai-routes-http`、`vertical-ai-resolution-http` 和投影单测已覆盖服务端边界，本次没有改变该 route。

## Phase 2：实现共享剧情展示

7. [x] 将 `TurnEntries` 从 Player feature 私有位置提取到 Owner/Player 都能依赖的 story/turn 组件目录，保持现有 payload 安全解析与回退文案。
8. [x] 实现按回合懒加载的历史组件：当前回合默认展开，历史回合默认收起；每个回合使用 `useTurnEntries(campaignId, turnId)` 独立缓存。
9. [x] 修改 `PlayerStoryPage` 使用完整 `useTurnList`，展示当前和 active 历史回合，保留 preview/error 区域，不改变服务端投影。
10. [x] 修改 `OwnerTurnPage` 接入共享历史/entries 组件，当前回合展示正常剧情；保留提交进度、行动、resolve、AI run 和 realtime notice。
11. [x] 确保 `turn.resolved`、`archive.restored` 的现有 query invalidation 不会清除历史列表结构；已 supersede 的回合继续由服务端 active list 排除。
12. [x] 更新必要的 CSS，保证剧情历史、entry、Owner/Player 布局在窄屏和长文本下可读；不做无关视觉重构。

## Phase 3：删除规则资料生产链路

13. [x] 删除 Owner 规则页面、导航项、路由、API client、React Query hooks、query key 和规则 envelope schemas。
14. [x] 删除 Owner workspace 测试里的 rules mock、导航断言和规则登记用例；删除规则专用 client contract 测试。
15. [x] 删除 server rules route、RulesService、RulesRepository、HTTP/service 测试，并移除 `app.ts` 的 import、实例和 mount。
16. [x] 从 contracts 删除 `rules.ts` export、rule source schemas/types 和规则专用 contract 测试。
17. [x] 删除 `INVALID_RULE_SOURCE`：从 `packages/contracts/src/errors.ts`、`server/src/platform/http/AppError.ts`、`client/src/shared/api/platformHttp.ts` 及仅为该错误存在的测试断言中移除。
18. [x] 删除规则专用 body-budget/security matrix 请求；保留其它 endpoint 的 body-budget 覆盖。
19. [x] 删除 `011_rule_sources.sql`，并从维护迁移 manifest/approved migration/temp fixture/schema inventory 中移除；如当前启动简化已切换到 clean baseline，更新 baseline 对象清单。
20. [x] 清理规则专用 CSS、活跃文档和构建/复制脚本引用；历史设计文档可以保留为历史记录，但不能继续被运行时、测试或用户文档引用。
21. [x] 全仓搜索 `RuleSource`、`rules/sources`、`platform_rule_sources`、`contentHash`、`INVALID_RULE_SOURCE`，逐项判断并删除所有生产残留；确认邀请/session/迁移用途的 SHA-256 未被误删。

### Phase 3.5：默认迁移当前旧数据库

22. [x] 增加窄化 legacy admission：只接受维护集合 + `011_rule_sources.sql` 且 `platform_rule_sources` 结构可确认的数据库；其它状态 fail closed 且不修改 live DB。
23. [x] 增加 SQLite `backup()` 预迁移副本，目标不可覆盖；存在普通 credential key 时成对复制，并验证备份完整性。
24. [x] 在一个事务中删除 `platform_rule_sources` 和精确 `011` tracking row，事务内运行 integrity/foreign-key 检查；失败回滚并阻止 listen。
25. [x] 在 `startPlatformServer` 的 database open 后、security gate 前接入默认迁移；维护集合数据库保持 no-op，并保持现有 listener/lock close 顺序。
26. [x] 增加临时数据库测试：成功迁移保留非规则数据和 key、备份是迁移前有效副本；失败/模糊集合/异常表结构不变更且不监听。
27. [x] 用当前配置的 `server/.dev/dnd.sqlite` 做一次显式启动 smoke，确认默认路径完成迁移、规则表/011 row 消失、备份可读；不触碰未配置的 `server/dnd.sqlite`。

## Phase 4：回归与质量检查

- [x] 运行 contracts 相关测试。
- [x] 运行 client player/owner workspace 测试和新增剧情历史测试。
- [x] 运行 server turn/AI entries/HTTP 投影测试、数据库 schema 测试和相关安全矩阵。
- [x] 运行 repository 的完整测试命令，必要时按项目要求使用单 worker：`env -u NODE_TLS_REJECT_UNAUTHORIZED npm test -- --maxWorkers=1`。
- [x] 运行 `npm run typecheck`。
- [x] 运行 `npm run build`。
- [x] 运行适用的浏览器验证，至少覆盖两轮剧情、玩家历史、DM 剧情和其他页面导航没有被删除规则项破坏。
- [x] 运行 `git diff --check`。
- [x] 检查测试没有创建或修改仓库根目录 `dnd.sqlite`、WAL/SHM、credential key 或 instance lock。
- [x] 最终用生产目录搜索确认：没有规则资料路由/表/contract/模块残留；Owner/Player entries 投影边界仍由服务端执行。

## 实现顺序与回滚点

1. 先完成剧情 RED 测试和共享 renderer，再接入 Player/Owner；这一阶段独立可验证，失败时不会影响规则删除。
2. 剧情展示通过后，删除规则资料 client/server/contracts；先保留数据库迁移文件直到所有生产引用清理完成。
3. 删除迁移/manifest/schema 测试条目后立即运行 fresh in-memory schema 测试；旧数据库只走 Phase 3.5 的精确、带 backup 的兼容迁移，不添加泛化 destructive conversion。
4. 最后运行全量 typecheck/build/browser 回归；不提交代码，除非用户另行明确要求提交。

## Verification record (2026-08-16)

- Focused contracts/client/server coverage: 17 files passed, 156 tests passed, 8 skipped.
- Full repository suite: 80 files passed, 733 tests passed, 8 skipped with `env -u NODE_TLS_REJECT_UNAUTHORIZED NODE_ENV=development npm test -- --maxWorkers=1`.
- `npm run typecheck` passed.
- `npm run build` passed for server and client.
- `git diff --check` passed.
- Production-source search found no rules route/module/contract/UI references outside the intentionally retained `legacyRuleSourcesMigration` bridge and its tests; the rule-source migration is absent from the maintained manifest/schema.
- The configured `server/.dev/dnd.sqlite` compatibility smoke and paired backup are recorded in `research/default-rule-removal-migration.md`; repository-root database artifacts were not used by the test suite.

## Architecture review follow-up (2026-08-17)

- Fixed Provider `resourceChoices` authority leakage: raw `advantage`/`disadvantage` values are retained as metadata but cannot select a RollPlan state; only server-owned action definitions can do so.
- Moved semantic Turn completion, `turn.resolved`, automatic archive, and next-turn creation into the coordinator-owned mechanical commit so they share one `StateRevision`; Narration finalize now writes presentation entries/run metadata only.
- Changed Narration observable effects to structured, visibility-projected `{ kind, targetId, delta, reason }` values and corrected saving-throw failure effects to target the acting actor.
- Regression coverage: advantage injection, saving-throw target, narration effect grounding, and mechanics-committed-before-narration-failure lifecycle consistency.
- Verification after the follow-up: 80 test files passed, 735 tests passed, 8 skipped; `npm run typecheck`; `npm run build`; `git diff --check`.
