# 2026-08-02 阶段二 A（世界事实、事务性 outbox、回合与行动）实现复审

> 复审对象：`docs/superpowers/plans/2026-08-02-dnd-ai-dm-phase-2a-world-outbox-turns.md`（阶段二 A 详细计划）的 5 个小任务实现结果。
> 复审结论：**READY_FOR_PHASE_2B**。
> 依据：`docs/superpowers/plans/2026-08-02-dnd-ai-dm-rearchitecture-revised.md`（权威总路线图）、`docs/superpowers/reviews/2026-08-02-phase-1-access-characters-review.md`（阶段一复审）。

## 一、阶段二 A 提交记录

| 任务 | 提交 | 说明 |
| --- | --- | --- |
| Task 1 共享 HTTP harness | `b12059c` | `test: extract shared HTTP test harness for platform verticals`——`server/src/tests/httpTestHarness.ts`（`startPlatformServer` 返回 `platformDb`、`close()` 先关 server 再关 platformDb；`registerAndLogin` 合并 `authCampaignRoutes` 与 `vertical-characters-http` 两个既有断言；`jsonHeaders`），两个既有测试文件机械重构、断言体逐字不变（纯 refactor） |
| Task 2 世界事实 | `f297f65` | `feat: add campaign world facts with visibility projection`——`packages/contracts/src/world.ts` + `world.test.ts`；`004_world_state.sql`（`platform_world_facts`）；`WorldFactRepository`/`WorldFactService`/`worldRoutes`；`app.ts` 挂 `/api/campaigns/:campaignId/world` |
| Task 3 事件契约 + outbox | `53fe438` | `feat: add campaign event contract and transactional outbox`——`packages/contracts/src/events.ts` 收敛（每 variant 带 `campaignId`、`interaction.requested` 补 `targetPlayerId`、新增 `owner.debug`、`eventDefaultAudience`/`canReadEvent`）；`005_events_outbox.sql`（`platform_outbox_sequences` + `platform_outbox_events`，`published_at` 可空）；`EventPublisherPort` 端口 + `OutboxRepository` 具体实现（原子 upsert 计数器 + `RETURNING`，绝不用“读取后 MAX+1”） |
| Task 4 回合与行动 | `6b9e9ed` | `feat: add turn and action lifecycle with atomic outbox events`——`006_turns_actions.sql`（`platform_turns` + `platform_actions` + `platform_turn_requirements`）；`TurnRepository`/`TurnService`/`turnRoutes`；`packages/contracts/src/turn.ts` 追加 action/summary/player/owner view contract；`CharacterRepository` 只读新增 `countApproved`/`listApprovedPlayerIds`；`app.ts` 追加 turn 路由 |
| 状态机修复 | `f6d5eb2` | `fix: prevent overlapping active turns`——实现复审发现 `locked` 回合可被新回合覆盖（原 `findActiveTurn` 只挡 `waiting_for_actions`）；改为 `findUnfinishedTurn`（`waiting_for_actions | locked | resolving | needs_owner_attention` 均视为进行中，只有 `completed` 才允许下一回合），并同步 Phase 2A 计划的进行中回合定义与验收门、补 4 个测试用例 |
| Task 5 HTTP 垂直验收 | `4d57bd7` | `test: verify world/outbox/turn HTTP vertical flow with three actors`——`server/src/tests/vertical-world-outbox-turns-http.test.ts`（owner/playerA/playerB 三 cookie jar 完整流程：建战役→加入→建/审角色→四类 world fact→投影隔离→开回合→A 提交/编辑→B 提交→锁定→锁后 409 `TURN_LOCKED`→outbox 直查 sequence/types/payload/published_at） |

阶段二 A 提交范围：`b12059c` → `4d57bd7`，共 6 个 commit（5 个小任务 + 1 个复审修复），每个任务一个只含该任务文件的 commit，trailer 均为 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

## 二、最终基线（2026-08-02 实测）

### 测试与构建（全量实测）

- 相关测试：9 个相关测试文件（`authCampaignRoutes`、`vertical-characters-http`、`vertical-world-outbox-turns-http`、world 模块 + contract、events contract、outbox、turn 模块、contracts）→ **9 files / 49 tests passed**。
- 全量测试：`rtk npm test` → **49 files passed / 1 skipped，489 tests passed / 4 skipped**（493 总）。1 个 skipped 文件为 `server/src/platform/database/postgres-contract.test.ts`（`POSTGRES_TEST_URL` 未配置被 `describe.skipIf` 门控，含其 4 个用例）。
- 类型检查：`rtk npm run typecheck`（server + client）通过。
- 构建：`rtk npm run build` 通过；`004_world_state.sql`/`005_events_outbox.sql`/`006_turns_actions.sql` 已复制进 `server/dist/platform/database/migrations/`（实测 dist 目录含 `001_initial_platform.sql` 至 `006_turns_actions.sql` 六份连续迁移）。
- 工作树：干净（`rtk git status` 无已跟踪/未跟踪修改）。

### 迁移与契约

- `001` → `006` 连续创建，编号无跳号；`004/005/006` 均被复制进 `dist`。
- 每战役 outbox sequence 用原子 upsert 计数器 + `RETURNING` 在写事务内分配；回滚测试确认 counter 与事件同滚、下次发布 sequence 从 1 开始。
- 回合最后一名必需玩家提交自动锁定（条件锁定防重复）；锁定后 `TURN_LOCKED`；A 锁前编辑不重复发事件；并发 A/B 只发一次 `turn.locked`；outbox `sequence=[1,2,3]`。
- world 投影：player 只见 public + 自己 knownBy 的 player_private，knownBy 收敛为 `[]`/自己的 playerId，`owner_only` 不外泄；update 保留原 `created_at`（仅 `updated_at` 前进）。
- 全程内存 SQLite，无真实 `server/dnd.sqlite` 写入。

## 三、验收门逐项核对

| 验收门 | 状态 | 核对结果 |
| --- | --- | --- |
| 共享 HTTP harness 抽取（纯 refactor） | ✅ | `startPlatformServer` 返回 `platformDb`；`close()` 先关 server 再关 platformDb；既有 `authCampaignRoutes`/`vertical-characters-http` 断言行为不变、相关测试全绿 |
| 世界事实（`004_world_state.sql`） | ✅ | owner 写、player 只读投影、knownBy 收敛 `[]`/自己、owner_only 不外泄、非成员 knownBy 拒绝；update 保留原 `created_at`（仅 `updated_at` 前进）；contract + service + route 测试通过 |
| 事件契约 + 事务性 outbox（`005_events_outbox.sql`） | ✅ | `campaignEventSchema` 每 variant 带 `campaignId`；`owner.debug` 已定义未 emit；`eventDefaultAudience`/`canReadEvent` 就绪；outbox 每战役 sequence 并发安全（原子 upsert + `RETURNING`）、回滚无残留（counter 与事件同滚）、`published_at` 可空 |
| 回合与行动（`006_turns_actions.sql`） | ✅ | 最后一名提交自动锁定；锁定后 `TURN_LOCKED`；未批准 `CHARACTER_NOT_APPROVED`；A 编辑不重复发事件；并发 A/B 只发一次 `turn.locked`；`sequence=[1,2,3]` |
| 状态机修复（`f6d5eb2`） | ✅ | `locked`/`resolving`/`needs_owner_attention` 均视为进行中，只有 `completed` 才允许下一回合；修复后无重叠进行中回合，新增测试用例全绿 |
| HTTP 垂直验收（world + outbox + turns，owner/playerA/playerB） | ✅ | 建战役→加入→建/审角色→四类 world fact→投影隔离与 knownBy 不泄漏→开回合→A 提交/编辑→B 提交→锁定→锁后 409 `TURN_LOCKED`→outbox 直查 sequence/types/payload/published_at→turn 视图隐私→DTO 无 `*_json`/内部字段 |

## 四、计划偏差记录（全部判定合理，纳入后续阶段基线）

1. **状态机审查发现 locked 后可开新回合，`f6d5eb2` 修复并同步计划**：Task 4 落地时回合状态机只把 `waiting_for_actions` 视为进行中（`findActiveTurn`），导致 `locked`/`resolving`/`needs_owner_attention` 状态下 owner 仍可再开新回合，产生重叠的进行中回合。最终复审发现该缺陷，修复为 `findUnfinishedTurn`——四态均视为进行中，只有 `completed` 才允许开启下一回合；锁定后回合只能经 AI 结算或 owner 处理前进（与产品规格一致）。同一 commit 同步更新 Phase 2A 计划的进行中/未终结回合定义与验收门，并补 4 个测试用例完整锁定该语义：
   - **locked 阻挡**：A、B 均提交后回合锁定，再 `startTurn` → `STATE_CONFLICT`；
   - **resolving/needs_owner_attention 阻挡**：手动置 `resolving` 或 `needs_owner_attention` 后 `startTurn` → `STATE_CONFLICT`；
   - **completed 后允许下一回合**：置 `completed`（含 `completed_at`）后 `startTurn` 成功且 `number = 2`；
   - **并发 startTurn 恰一成功**：两个并发 `startTurn` 恰一个 fulfilled，失败方 `STATE_CONFLICT`，库内仅一条 `platform_turns` 且 status 为 `waiting_for_actions`。
   判定合理。
2. **`countApproved` 只读方法预留**：`CharacterRepository` 按计划新增 `countApproved` 与 `listApprovedPlayerIds`；`listApprovedPlayerIds` 被 `TurnService.startTurn` 消费，`countApproved` 本阶段未消费（预留，供后续阶段统计用途）。属于计划内声明的只读新增，未改既有方法，判定合理。

## 五、非阻断观察（不阻塞进入 Phase 2B，后续阶段与测试需留意）

1. **Postgres contract 仍需配置 URL 跑一次**：`POSTGRES_TEST_URL` 未配置，`postgres-contract.test.ts` 4 个用例跳过；契约套件代码已就绪，建议在部署 Postgres 环境后实际跑一次确认占位符重写与驱动行为。
2. **`owner.debug` 事件已定义未 emit**：契约与 outbox 已支持（`owner_only` 受众、无 target），本阶段不发射，Phase 3 由 AI 结算写入；SSE live/replay（Phase 3）复用同一 `canReadEvent` 投影函数。
3. **`ai.preview.*`/`ai.preview.failed` 对 player 可见的语义已固化**：体现在 `eventDefaultAudience`/`canReadEvent`，Phase 2B AI runtime 与 Phase 3 SSE 需保持一致。
4. **时间戳精度为毫秒**：world `update` 保留原 `created_at`、仅 `updated_at` 前进；`updatedAt` 变化断言依赖测试内 5ms sleep 保证落在不同毫秒。后续阶段涉及时间戳比较的断言需注意同一精度限制。

## 六、复审结论

- **READY_FOR_PHASE_2B**：阶段二 A 5 个小任务全部完成、6 个 commit 落地；最终基线可复现（9 相关文件 / 49 tests 全绿；全量 489 passed / 4 skipped；typecheck/build 通过；`001`–`006` 迁移进 dist；工作树干净）；HTTP 垂直验收锁定 world 投影隔离、knownBy 不泄漏、回合锁定与 outbox 顺序/内容/未发布、DTO 无 `*_json`/内部字段、玩家行动正文对其它玩家不可见。
- 偏差 2 项均判定合理且改善长期可维护性（状态机修复消除重叠进行中回合）。
- 非阻断观察 4 项已记录，供 Phase 2B 详细计划与后续全量回归参考。

## 七、下一步

- 按总路线图，**只有 Phase 2A 完成并通过复审后才编写 Phase 2B 详细计划**；现满足该条件，**Phase 2B 详细计划已编写（[`2026-08-02-dnd-ai-dm-phase-2b-archives-ai-runtime.md`](../plans/2026-08-02-dnd-ai-dm-phase-2b-archives-ai-runtime.md)，⏭ 待执行，尚未实现）**。
- **Phase 2B 实现范围**（archives + AI runtime + 服务端 AI 垂直流程，迁移 `007_archives.sql` → `008_ai_runtime.sql`）：`007_archives.sql`（真实快照 + 真实恢复 + `archive.restored` 系统事件）、`008_ai_runtime.sql`（AI 状态机 `locked → resolving → completed` / `needs_owner_attention`，失败不写半截日志、不重复应用，短事务 lifecycle + idempotency）与 `ScriptedAiProvider` 注入的服务端 AI 垂直流程 `create → join → approve → submit → lock → resolve → archive → project`；实现完成后需通过本阶段两级 review，Phase 2 总体验收方告完成。
