# Phase 4 前端工作区实施复审记录

> 日期：2026-08-09
> 当前状态：✅ APPROVED。初次独立规格/隐私、工程与浏览器证据三审提出的四项 Major 已按最小闭环修复；修复后全量验证通过，三路 fresh-context 针对性复审均确认原 Major CLOSED，无 Blocker/Major。
>
> 三审发现（详见 `.pi-subagents/artifacts/57d99752_reviewer_0_output.md`、`4d8c6d4c_reviewer_0_output.md`、`42283a82_reviewer_0_output.md`）：
> 1. 规格/隐私 Major-1：会话过期 401 全局处理缺失；Major-2：owner 战斗缺少 5/9 命令表单；Minor：/me 瞬时网络错误被当 guest。
> 2. 工程 Major-1：idempotency key 成功/换回合后未释放；Major-2：同 401 缺失；Minor：OwnerAiRunPanel 未展开仍请求 detail。
> 3. 浏览器证据 Major-1：SSE 断连注入无效（route abort 不能打断已建立的 EventSource），断言空洞通过；Minor：private 缺失断言单次检查。

## 实施范围

- 新 App Shell 与 React Router 权限路由。
- Platform HTTP client、Zod envelope 解析、TanStack Query keys/hooks。
- 登录/注册、战役列表/创建/邀请/加入。
- campaign-scoped `RealtimeSession`。
- Owner 五页：turn+AI、characters、world、combat、archives。
- Player 五页：story、action、character、inventory、read-only combat。
- test-only browser fixture、Vite same-origin proxy 与三隔离 context Playwright 流程。

## 设计约束落实

- `client/src/App.tsx` 只挂新 `AppProviders` + router；旧 `pages/`/root `api.ts`/`types.ts`/legacy components 未被新 app/features import。
- 旧 `/admin/:roomId`、`/player/:token` 只显示 Phase 5 迁移提示，不调用 legacy API。
- 服务器状态由 Query Cache 管理；没有 giant global store。
- RealtimeSession 隐藏 EventSource、cursor、backoff、preview 与 invalidation；`getSnapshot()` 引用稳定。
- poison SSE payload 先推进 sequence 再解析；replay/live 通过 sequence 去重。
- owner/player 权限仍由服务端 route/middleware/ProjectionPolicy 强制；UI 隐藏不是权限边界。
- Task 6 仅新增 `server/src/tests/fixtures/phase4BrowserServer.ts` 与 `EventStreamRuntime.registerClient/closeViewer`（测试/运维路径的通用能力，不参与正常投递），未修改服务端领域逻辑或 contract。

## 缺陷修复记录（独立三审 CHANGES_REQUIRED 后，2026-08-09）

- **M1 会话过期（规格/隐私 Major-1 + 工程 Major-2）**：`createAppQueryClient` 增加 `onAuthRequired`（QueryCache/MutationCache `onError`，仅 AUTH_REQUIRED；防御性排除 auth login/register mutation key）；App 接线到新 `authRequiredBus`；`AppProviders` 订阅 → `queryClient.clear()` + `router.navigate('/login?returnTo=<安全路径>')`；实时连接随 workspace unmount 停止。`useSessionQuery` 对瞬时网络错误重试至多 2 次；三个路由守卫对 `/me` error 显示可重试状态而非当 guest。新增 `client/src/app/auth/authRequired.test.tsx`（6 用例：跳转+returnTo+缓存清空+不循环、登录表单 401 不循环、/me 瞬时网络错误不跳转、query/mutation 触发、auth mutation 排除）。
- **M2 idempotency（工程 Major-1）**：`OwnerTurnPage.handleResolve` 在 `onSuccess` 释放 key，另加 `useEffect([turn?.id])` 换回合即释放；保留“尚无 HTTP 响应的网络级重复提交复用 key”语义。新增跨两回合 regression：第二次结算以新 key 且按 `t2` 提交。
- **M3 owner combat（规格/隐私 Major-2）**：补齐 `apply_attack`、`apply_saving_throw`、`apply_healing`、`add_condition`、`remove_condition` 五种白名单命令表单（严格 contract payload、fieldset legend + 唯一 aria-label）；与 `apply_damage`/`roll_initiative`/`advance_turn`/`end_encounter` 合计覆盖除 `start_encounter` 外全部 9 种命令。新增 5 个 exact payload 测试。
- **M4 浏览器断连真实性（浏览器证据 Major-1）**：移除无效 route abort；fixture 暴露 `disconnectViewer(campaignId, viewer)`，runner 注入 `disconnectRealtime` callback；场景在 playerA context 记录 `/events` 请求 URL，结算中真实关闭 A 的服务端 SSE（先 `res.end()` 干净结束——已实测 `res.destroy()` 无法经 Vite dev proxy 传播——再兜底 destroy），断言关闭数 ≥ 1、出现新的 `events?after>0` 请求（实测 `?after=3`）、preview 完整且仅一次。private 缺失断言改为 `waitUntil(count===0)`。
- **Minor OwnerAiRunPanel**：`useAiRunDetail` 改为 details 展开（受控 summary onClick）才 enabled；新增“未展开不请求、展开后调用”测试。

## 修复后验证（重跑）

- Focused：`npm test -- client/src/app/auth/authRequired.test.tsx client/src/app/router/router.test.tsx client/src/features/owner/owner-workspace.test.tsx client/src/app/realtime/RealtimeSession.test.ts client/src/shared/api/platformHttp.test.ts` → 5 files / 61 tests PASS。
- `npm run test:phase4-browser`：12 步 PASS（含真实服务端关闭 playerA SSE、随后 `events?after=3` 重连、preview 无重复），exit 0。
- 全量串行 `npm test -- --maxWorkers=1 --no-file-parallelism`：77 files PASS、2 skipped；756 tests PASS、14 skipped。
- `npm run typecheck`：server/client PASS。
- `npm run build`：contracts/server/client PASS。
- `git diff --check`：PASS（只有 CRLF 提示）；`git diff --name-only --cached` 为空。
- 默认数据库未触碰：仓库根 `dnd.sqlite` mtime 仍为 2026-08-01，`server/dnd.sqlite` mtime 仍为 2026-07-19。

## 测试证据

### Focused

- Platform HTTP/router/auth/campaign：41 tests PASS。
- RealtimeSession + owner：30 tests PASS。
- RealtimeSession + owner + player：47 tests PASS。
- Router/auth/campaign 回归：30 tests PASS。

### 完整（修复后）

- `npm run test:phase4-browser`：12 browser steps PASS，owner/playerA/playerB 三隔离 context；真实 SSE 断连重连（`?after=3`）断言成立。
- `npm test`：见“最终全量回归”。
- `npm run typecheck`：server/client PASS。
- `npm run build`：contracts/server/client PASS。
- `git diff --check`：PASS。
- staged diff：空。

完整浏览器断言与截图见 [`../validation/2026-08-09-phase-4-browser-validation.md`](../validation/2026-08-09-phase-4-browser-validation.md)。

## 最终全量回归（缺陷修复后）

| 命令 | 结果 |
| --- | --- |
| `npm test -- --maxWorkers=1 --no-file-parallelism` | PASS；77 files / 756 tests，另 2 files / 14 tests skipped |
| `npm run typecheck` | PASS；server + client |
| `npm run build` | PASS；contracts + server + client |
| `npm run test:phase4-browser` | PASS；12 步，真实重连请求 `events?after=3` |
| `git diff --check` | PASS（仅 line-ending warnings） |
| `git diff --name-only --cached` | 空；无 staged 文件 |

## 最终 Major 针对性独立复审

2026-08-09 使用三路 fresh-context reviewer 对修复后的工作树做只读复审：

1. **M1/M2（会话过期 + 幂等键）**：APPROVED，原 Major CLOSED；确认 AUTH_REQUIRED 清 cache/安全跳转/工作区卸载停止 realtime、auth 表单不循环、`/me` 网络错误不伪装 guest，以及无响应重试复用 key、成功/换回合生成新 key。
2. **M3（owner combat）**：APPROVED，原 Major CLOSED；确认 UI 覆盖除 `start_encounter` 外 9 种命令，payload 由 contract discriminated union 约束，服务器继续执行 owner 权限和 strict schema 校验。
3. **M4（真实 SSE 重连证据）**：APPROVED，原 Major CLOSED；确认断连由服务端结束既有 SSE，而非 Playwright route abort；浏览器随后请求 `events?after=N` 且 `N>0`，关闭数量和 preview 无重复均有断言，投影语义未改变。

复审只留下非门控 Minor：导航 rejection 未显式捕获、401→EventSource.close 缺少单条端到端断言、combat 数值范围未全部镜像到 client、浏览器重连请求次数未限制为恰好一次、浏览器套件需专用命令运行。这些不影响 Phase 4 验收。

## 已知残余风险

1. 生产 composition 仍默认 `UnavailableAiProvider`，符合 Phase 4/5 边界；用户普通 `npm run dev` 可实测 UI 与失败恢复，但 AI 成功预览需要测试 fixture 或 Phase 5 Provider 配置。
2. Phase 3 的 PostgreSQL live suite 仍受 `POSTGRES_TEST_URL` 未配置限制；Phase 4 未修改服务端 domain SQL。
3. 全量 Vitest 首次并行运行出现一次 legacy UI test 5 秒超时；单跑与完整重跑均通过，保留为非门控资源波动。
4. interaction request 仅显示非持久、不可操作 notice；list/answer API 与 UI 明确延期 Phase 5。
5. campaign member DTO 没有 displayName，进度使用计数与缩写 ID，符合用户批准的默认方案。

## Git/数据安全

- 未执行 `git add`、commit、push、reset、checkout、clean 或 stash。
- 没有 staged 文件。
- browser fixture 只用内存 SQLite；未修改默认运行数据库。
