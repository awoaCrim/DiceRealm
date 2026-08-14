# Phase 4 完整浏览器验证记录

> 日期：2026-08-09
> 状态：PASS（含独立三审后缺陷修复重跑）
> 编排入口：`npm run test:phase4-browser`

## 测试拓扑

- `scripts/phase4-browser-validation.ts`：唯一自动编排入口。
- `server/src/tests/fixtures/phase4BrowserServer.ts`：内存 SQLite + deterministic `ScriptedAiProvider`，随机端口；暴露 `disconnectViewer(campaignId, viewer)` 用于真实断开指定观看者的服务端 SSE 订阅与响应。
- Vite JavaScript API：随机前端端口；`/api` 与 `/events` 同源代理到 fixture。
- `PLAYWRIGHT_BROWSERS_PATH`：仓库内 gitignored `playwright-browsers/`。
- Context：owner、playerA、playerB，三套完全隔离 cookie jar。
- 场景：`client/src/tests/phase4-browser-flow.test.ts`，由 tsx runner 导入；普通 Vitest 显式 exclude。

## 最终成功输出

```text
[phase4-browser] owner register/login/create campaign
[phase4-browser] playerA/playerB register/login then join via invite link
[phase4-browser] players create and submit characters; owner reviews
[phase4-browser] turn start / submit / edit / auto-lock
[phase4-browser] resolve with real SSE disconnect/reconnect on playerA
[phase4-browser] playerA 重连请求：http://127.0.0.1:<vite-port>/api/campaigns/<id>/events?after=3
[phase4-browser] playerA preview rebuilt without duplication
[phase4-browser] projected combat
[phase4-browser] archive restore
[phase4-browser] feature error boundary
[phase4-browser] session refresh and logout
[phase4-browser] all browser scenarios passed
[phase4-browser] 全部场景通过（12 步）
```

Exit code：0。

## 关键断言

1. 真实 UI 完成 register/login/create/invite/join/role routing；未直接写 Query Cache。
2. 两个玩家创建并提交角色；owner 审核；玩家刷新后看到 approved/derived AC。
3. owner 开始回合；A 提交后仍可编辑；B 最后提交触发服务端自动锁定；owner/A/B 实时更新。
4. **真实断连与重连**：在 playerA context 记录 `/events` 请求 URL。owner 点击“发起 AI 结算”后，runner 调用 `fixture.disconnectViewer(campaignId, { role: 'player', playerId })`（断言关闭数量 ≥ 1），服务端对该 viewer 的 SSE 订阅先关闭、SSE 响应干净结束（`res.end()`，代理可转发终帧；曾实测 socket `res.destroy()` 无法经 Vite dev proxy 传播，故采用干净结束）。浏览器 EventSource 收到流结束 → 客户端按 per-campaign 高水位发起新请求，实测为 `events?after=3`（断言存在 after>0 的新请求）。随后 preview 在 DOM 中恰好出现一次且完整（`临时生成中：前方危险！`），证明 sequence 去重与重放正确。**不再依赖 route abort（已证明 route abort 无法打断已建立的 EventSource）。**
5. 结算后 A/B 均看到 public narrative；A 只看到 A private update，B 只看到 B private update；缺失断言用 `waitUntil(count===0)` 防延迟泄漏竞态。
6. 玩家 DOM 不含另一玩家 private、owner AI 面板、`owner.debug`、`rawDebug`、context。
7. encounter 包含 public、A-private、owner-only combatants；A/B 各自只见服务端投影。
8. manual archive → world mutation → restore；world 页面通过失效/refetch 回到快照状态。
9. 世界 API 500 只使 feature 显示 error；shell/其它导航仍可用；取消注入并重试后恢复。
10. 刷新保持 session；logout 后 protected route 跳转登录并保留安全 `returnTo`。

## 缺陷修复（独立三审后）

- **M1 会话过期**：已登录期间 protected query/mutation 返回 AUTH_REQUIRED → QueryCache/MutationCache `onError` → 全局总线 → 清 Query Cache 并跳 `/login?returnTo=<安全路径>`；实时连接随 workspace unmount 停止；登录表单 401 只显示错误不循环；`/me` 瞬时网络错误显示可重试状态而非当 guest。新增 `client/src/app/auth/authRequired.test.tsx`。
- **M2 idempotency**：`OwnerTurnPage` 结算成功（onSuccess）与回合切换（effect on turn id）均释放 key；跨两回合 regression 断言第二回合用新 key 且按新 turnId 提交。
- **M3 owner combat**：补齐 `apply_attack`、`apply_saving_throw`、`apply_healing`、`add_condition`、`remove_condition` 五种白名单命令表单（严格 payload、唯一 aria-label），与既有 `apply_damage` 共六种目标型表单 + `roll_initiative/advance_turn/end_encounter`，覆盖除 `start_encounter` 外的全部 9 种命令。
- **M4 浏览器断连真实性**：见关键断言 4；同时为 `EventStreamRuntime` 增加通用 `registerClient/closeViewer` 能力（仅测试/运维路径）。
- **Minor OwnerAiRunPanel**：`useAiRunDetail` 改为 details 展开才 enabled（未展开不发 owner-only detail 请求），并加测试。

## 截图

位于 `output/playwright/phase4/`：

- `phase1-owner-workspace.png`
- `phase1-playerA-story.png`
- `phase2-owner-characters-approved.png`
- `phase3-locked.png`
- `phase4-resolved.png`
- `phase5-playerA-combat.png`
- `phase6-restored.png`
- `phase7-error-recovery.png`
- `phase8-logout.png`

## 回归命令

| 命令 | 结果 |
| --- | --- |
| `npm run test:phase4-browser` | PASS，exit 0（12 步） |
| `npm test -- --maxWorkers=1 --no-file-parallelism` | PASS；77 files / 756 tests，另 2 files / 14 tests skipped |
| `npm run typecheck` | PASS，server + client |
| `npm run build` | PASS，contracts/server/client |
| `git diff --check` | PASS（仅 line-ending warnings） |
| `git diff --name-only --cached` | 空，无 staged 文件 |

## 数据安全

fixture 只调用 `createMemoryDb()`，没有读取或写入默认数据库。验证后的现有数据库时间戳仍为历史时间：仓库根 `dnd.sqlite` 为 2026-08-01，`server/dnd.sqlite` 为 2026-07-19；本次 runner 未触碰它们。
