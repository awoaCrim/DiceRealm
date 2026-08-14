# DND AI-DM Phase 4：前端 App Shell、认证与 owner/player 工作区实施计划

> 状态：✅ 已完成（2026-08-09）。计划级审查、实现三审、四项 Major 修复的针对性独立复审均通过；全量测试、类型检查、构建与真实浏览器验证全绿。
>
> 用户已批准：2026-08-09 采用本计划“默认方案”。
>
> 执行方式覆盖总路线图的旧模板 commit 要求：本会话遵从用户当前指令，**不 stage、不 commit、不 push**；使用普通 npm/git 命令，不使用 `rtk` 前缀。
>
> 权威范围：[`2026-08-02-dnd-ai-dm-rearchitecture-revised.md`](./2026-08-02-dnd-ai-dm-rearchitecture-revised.md) Phase 4；前置门：Phase 3 最终独立规格/隐私与工程审查均 PASS，见 [`2026-08-09-phase-3-realtime-combat-review.md`](../reviews/2026-08-09-phase-3-realtime-combat-review.md)。

## 目标

在 Phase 1–3 已完成的平台 HTTP API、投影和 campaign SSE 之上，交付可在浏览器中操作的统一 Web 应用：

1. 登录、注册、战役列表、创建与加入；
2. owner 工作区：回合与 AI 运行、角色审核、世界、战斗、存档；
3. player 工作区：公开剧情与自己的私密结果、角色与背包、行动编辑/锁定、实时提交进度、只读战斗；
4. campaign-scoped `RealtimeSession`：SSE sequence 去重、重连、临时 AI 预览与 Query Cache 失效；
5. feature 级错误边界和明确的 loading/empty/error/retrying/realtime-disconnected/locked/waiting-for-players/ai-generating 状态。

本阶段默认**不修改服务端领域逻辑和平台 contract**。若实施中发现没有前端规避方式的真实 blocker，必须停止并升级，不得静默扩展服务端范围。

## 用户何时可以实测

本阶段按串行垂直切片交付，不等所有页面完成才第一次浏览器验证：

- **检查点 A（Task 2 完成）**：用户可实测注册 → 登录 → 战役列表 → 创建 → 复制邀请链接 → 另一会话加入 → 按角色进入 owner/player 工作区骨架。
- **检查点 B（Task 4 完成）**：用户可实测 owner 的角色审核、世界、战斗、存档基础流程，以及 player 的角色、背包和只读战斗。
- **检查点 C（Task 6 完成）**：用户可实测完整回合：owner 开始回合 → player 提交/编辑 → 最后提交自动锁定 → owner 发起 AI run → SSE 公开预览/结果刷新 → 存档恢复。

每个检查点都必须由实现者启动真实 server + Vite，并用浏览器操作实际页面；不能只以 jsdom 测试或构建成功代替实测。Task 2/4 的浏览器检查是中间证据，Task 6 的隔离浏览器验收是 Phase 4 完成门。

## 已确认的测试缝

测试只从已批准的公开缝观察行为：

- **路由缝**：`AppRouter` 在 `MemoryRouter`/真实浏览器 URL 下的认证、角色守卫和重定向。
- **HTTP 缝**：新的 `platformRequest` 解析成功 DTO 与 `{ error: { code, message } }`；feature API 模块只暴露领域操作。
- **查询缝**：query key、query/mutation hooks 和 mutation 后失效行为；不测试 TanStack Query 内部实现。
- **实时缝**：`RealtimeSession.start(campaignId)` / `stop()` 及其对 Query Cache、连接状态和 preview store 的可见结果；测试注入 `EventSourceFactory`，不 mock 私有方法。
- **工作区缝**：从 owner/player 路由渲染页面并通过可访问名称操作按钮、表单和导航。
- **浏览器缝**：真实 HTTP + cookie + SSE，owner/player 使用隔离 browser context；不通过直接写 Query Cache 伪造完整流程。

数据库直查继续只属于既有服务端隐私/原子性测试；Phase 4 前端测试不直接读数据库。

## 固定产品与架构决定

### A. 路由与 legacy 共存

新应用路由：

```text
/login
/register
/campaigns
/campaigns/new
/campaigns/join/:campaignId

/campaigns/:campaignId/owner
/campaigns/:campaignId/owner/turn
/campaigns/:campaignId/owner/characters
/campaigns/:campaignId/owner/world
/campaigns/:campaignId/owner/combat
/campaigns/:campaignId/owner/archives

/campaigns/:campaignId/player
/campaigns/:campaignId/player/story
/campaigns/:campaignId/player/character
/campaigns/:campaignId/player/inventory
/campaigns/:campaignId/player/combat
```

固定重定向：

- `/`：先做 session bootstrap；已登录 → `/campaigns`，未登录 → `/login`；
- guest 访问 protected route → `/login?returnTo=<安全站内路径>`；
- 已登录访问 `/login`、`/register` → `/campaigns`；
- `/owner` → `/owner/turn`；`/player` → `/player/story`；
- campaign detail 的当前成员角色与 URL 工作区不一致时，重定向到正确 workspace；
- 非成员/不存在 campaign 的 `CAMPAIGN_NOT_FOUND` → `/campaigns` 并显示脱敏通知；
- 未知新路由显示应用内 404，不退回 legacy 首页。

`/admin/:roomId`、`/player/:token` 和 legacy `HomePage` 的源码与测试继续保留，但不挂入新 AppRouter。Phase 5 负责 legacy adapter/cutover；Phase 4 新模块不得 import `client/src/pages/*`、旧 `client/src/api.ts` 或旧 `client/src/types.ts`。

### B. Provider 与深模块

Provider 只有：

```tsx
<QueryClientProvider client={queryClient}>
  <RouterProvider router={router} />
</QueryClientProvider>
```

不新增全局 `AuthContext`/`RealtimeContext` 超级状态。认证用户和服务端状态均在 Query Cache；路由守卫读取 session/campaign queries。表单草稿、modal、选中行、AI preview 放 feature/local state。

`PlatformHttpClient` 是 HTTP 深模块，隐藏：JSON/header/credentials、超时、204、错误 envelope、contract parse 和 401 处理。各 feature API 模块只组合 URL、input schema、response schema。

`RealtimeSession` 是实时深模块，外部接口只暴露连接生命周期与可订阅状态；EventSource、sequence、重连、事件分派和 query invalidation 都留在模块内部。

### C. 依赖和 contracts 构建

`client/package.json` 增加固定安装产生的实际版本：

- `@dnd/contracts: "*"`（npm workspace link；不手写 `workspace:*`，以当前 npm lockfile 格式为准）；
- `@tanstack/react-query`；
- `react-router-dom`；
- `lucide-react`；
- `zod`（client 直接组合/解析 HTTP envelope，必须声明直接依赖，而非依赖 workspace hoist）。

`npm install` 不使用 `latest` 浮动说明；以安装时解析出的精确 lockfile 版本为可复现依据。`client/package.json` 保存 npm 写入的 semver range，`package-lock.json` 保存精确版本与 integrity。

`client/vite.config.ts` 与 root `vitest.config.ts` 同样把 `@dnd/contracts` alias 到 `packages/contracts/src/index.ts`。因此 dev、client 单独 build 和 tests 都不依赖预先存在的 ignored `packages/contracts/dist`。生产 root build 仍保持 server 先构建 contracts，再构建 client；不修改 Node 24 与 `better-sqlite3` 版本。

### D. 认证与 401

- register 成功不自动登录；跳转 `/login`，用 navigation state 预填 login 并显示成功状态；密码不进入 URL/history。
- login 成功后 invalidate/fetch `/api/auth/me`，只允许 `returnTo` 为以 `/` 开头但不以 `//` 开头的站内路径，否则去 `/campaigns`。
- logout 成功后 `queryClient.clear()`，`RealtimeSession.stop()`，跳转 `/login`。
- session bootstrap 的 `/me` 返回 `AUTH_REQUIRED` 时视为 guest，而不是页面 error。
- protected API 在已登录期间返回 401 时，清理 Query Cache/实时连接并跳转登录；登录/注册页自身的 401 只显示表单错误，不能形成重定向循环。
- 所有 fetch 显式 `credentials: 'same-origin'`；部署基线是同源，Phase 4 不修改 CORS。

### E. 战役创建与邀请

创建向导只收集 contract 支持的：

```ts
{ name: string; ruleset: string }
```

`ruleset` 提供 `dnd5e` 默认选项和可编辑输入，不增加 Provider、预计人数或 status transition。

创建成功必须先进入“保存邀请码”完成步骤，不立即丢失 mutation result：

- 展示一次性 raw invite code；
- 复制 invite link：`new URL(`/campaigns/join/${encodeURIComponent(campaignId)}?code=${encodeURIComponent(inviteCode)}`, window.location.origin).toString()`，clipboard 不可用/拒绝时保留可选择的 code/link 和“手动复制”提示；
- 明示关闭后无法从服务端再次查看；
- 只有用户点击“我已保存，进入工作区”后才跳 owner/turn。

加入页从 path 取 campaignId，从 query 预填 code；用户确认后才 POST `/:campaignId/join`。手动入口允许填写 campaignId + code。成功后 invalidate campaigns 并进入 player/story。Phase 4 不新增 bare-code join、邀请码重置或成员管理。

### F. Owner 页面范围

owner 只有五个导航页：

1. **回合与 AI 运行**：最新 active turn、提交进度、owner 可见行动正文、start turn、run list/detail、resolve/retry；
2. **角色审核**：待审 sheet、approve/reject、批准角色安全摘要；
3. **世界**：事实 list/create/edit/delete，支持 visibility 和 player-private target IDs；
4. **战斗**：encounter list/start/detail 和十种 contract 中除 `start_encounter` 外的 owner command 表单；
5. **存档**：list/manual create/restore。

`/owner/turn` 合并 AI 运行，不另建 owner AI 导航页；不做 overview、rules 或 Provider 页面。

三栏布局固定为 `Header + Sidebar + MainPanel + Inspector`。Shell 只负责布局、campaign 标题、导航、连接状态和 Outlet；各 feature 自己查询，不把完整 campaign state 从 workspace 向下透传。

### G. Player 页面范围

player 页面：

- **剧情**：按 turn 加载 projected entries；只消费服务端返回的 public + 自己 player_private；payload 只在契约允许的 `text`/dice shape 下渲染，未知 payload 显示安全回退；
- **行动**：最新 active turn 的 `myAction`；waiting 时可创建/编辑，locked/resolving/completed/needs_owner_attention 时禁用；保留未提交本地草稿，SSE invalidation 不能覆盖正在编辑的 draft；
- **角色**：新建 platform-backed 精简编辑器，支持姓名、AC、六项属性、equipment、spells、背景/备注；create/update/submit review；不 import legacy token CharacterBuilder；
- **背包**：只读安全读取自己 approved/draft sheet 中的 `equipment` 和 `spells` 字符串数组；类型不符视为空；
- **战斗**：只读 projected encounters/combatants，不提供写按钮。

`PlayerInspector` 显示自己的角色摘要、AC、当前提交进度和实时状态。不挂 owner prompt/run detail、其他玩家 action、owner-only world fact/debug。

### H. 成员名字与交互请求

campaign member/turn progress 当前只有 userId。Phase 4 显示 `已提交 n / m` 和必要时缩写 ID（统一 helper，例如前 6 + 后 4），不声称它是玩家姓名。

`interaction.requested` 没有 platform list/answer HTTP 接口。Phase 4 只在目标玩家实时收到事件时显示“有待确认交互，当前版本暂不支持在新工作区回答”的非持久提示；不展示 prompt，不提供伪按钮，刷新后不保证保留。真正 list/answer 放 Phase 5，不能调用 legacy token route。

### I. RealtimeSession 语义

每个已挂载 campaign workspace 恰有一个 session；无 campaignId、离开 workspace、logout 或 campaign 变化时停止旧连接并清空旧 campaign 临时状态。

状态：

```ts
type RealtimeStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'retrying';
```

实现使用注入的 `EventSourceFactory`。原生 EventSource 自动携带同源 cookie和 Last-Event-ID；客户端另外保存每 campaign `lastSeenSequence` 于 session 内，并在重新创建 URL 时附 `?after=<lastSeen>`。不写 localStorage，浏览器刷新后可从 0 重放；服务端 at-least-once + sequence dedup 保证安全。

- 只处理 `event: campaign`；
- 从 `MessageEvent.lastEventId` 解析 safe non-negative integer；无法解析的 frame 丢弃并进入脱敏错误状态；
- `sequence <= lastSeen` 丢弃；对于 id 合法的新行，先推进 `lastSeen`，再解析/投影 payload；payload contract 失败时只记录脱敏错误并跳过，避免 poison row 在每次 reconnect 永久重放；
- `onerror` 进入 disconnected/retrying；指数退避 1s、2s、4s、8s、上限 15s，并加小 jitter；连接成功重置 attempt；
- `stop()` 清 timer/EventSource，后续 callback 不得更新 cache。

事件映射：

| 事件 | Query Cache / local preview 行为 |
| --- | --- |
| `player.joined` | invalidate campaign detail（虽当前服务端不 emit，客户端保持兼容） |
| `turn.action_submitted` | invalidate turns + 对应 turn view |
| `turn.locked` | invalidate turns + 对应 turn view；composer 从服务端状态锁定 |
| `ai.preview.started` | 创建 `runId` preview buffer，状态 ai-generating |
| `ai.preview.delta` | 按 sequence 去重后 append 到同 runId buffer；不写正式 entries cache |
| `ai.preview.failed` | 删除该 run preview，记录可恢复错误；invalidate turns/runs |
| `turn.resolved` | 删除所有临时 preview；invalidate turns、entries、characters、world、combat、archives、AI runs |
| `combat.updated` | invalidate combat list/detail |
| `interaction.requested` | 仅目标玩家收到；加入临时不可操作 notice |
| `archive.restored` | `invalidateQueries` 该 campaign 下全部 query keys；清 preview/notices/drafts 以外的实时临时状态；表单 draft 由页面决定提示用户后保留或重载 |
| `owner.debug` | owner invalidate 对应 run detail/list；player 不应收到，客户端也不渲染正文 |

characters/world 没有服务端事件：本客户端 mutation 成功后精确 invalidation；QueryClient 使用 `refetchOnWindowFocus: true` 补跨客户端刷新。

### J. Query key 与 mutation 规则

所有 campaign query key 以 `['campaign', campaignId, ...]` 开头，使 `archive.restored` 能做单前缀全量失效。建议：

```ts
['session']
['campaigns']
['campaign', id, 'detail']
['campaign', id, 'characters']
['campaign', id, 'world']
['campaign', id, 'turns']
['campaign', id, 'turn', turnId]
['campaign', id, 'entries', turnId]
['campaign', id, 'ai-runs', turnId]
['campaign', id, 'ai-run', runId]
['campaign', id, 'combat']
['campaign', id, 'combat', encounterId]
['campaign', id, 'archives']
```

mutation 成功只更新/失效所属 feature；restore 是唯一主动全 campaign 失效。服务端仍是权限真相，UI 隐藏写按钮只改善体验，不是授权。

### K. AI run idempotency

owner 点击 resolve 时生成 `crypto.randomUUID()`，存在该次 mutation 本地状态；同一个尚未得到 HTTP 响应的网络级重复提交复用该 key。明确收到 failed run 或 `AI_PROVIDER_FAILED`/`AI_OUTPUT_INVALID` 后，用户点击“重试”生成**新 key**。按钮 pending 时禁用，避免并行 runs。

当前生产组合通过 `server/src/app.ts` 默认选择 `UnavailableAiProvider`。因此普通 `npm run dev` 可以实测到 owner attention/可恢复错误，但无法实测 AI 成功预览。Task 6 增加**仅测试用** browser fixture server，在独立临时 SQLite + `ScriptedAiProvider` 上跑成功预览；绝不修改生产默认 Provider，也不修改默认 `DATABASE_PATH` 指向的仓库根 `dnd.sqlite`。

### L. AsyncState 与错误边界

`AsyncState` 只负责单个区块的 `loading/empty/error/retrying` 表现和 retry button；feature 自己组合 locked/waiting/ai-generating/realtime-disconnected。

`FeatureErrorBoundary` 以 route panel 为最小单位：owner/player 每个 Outlet 页面一个 boundary；复杂页内 combat detail、AI run detail/preview 再各有一个 boundary。Shell/header/sidebar 不因一个 panel throw 而卸载。错误 fallback 使用脱敏消息、重试/返回按钮，并恢复焦点。

全局只保留致命启动 fallback；不得用一个全局 boundary 替代 feature boundaries。

### M. 桌面与无障碍

桌面优先，不做 mobile bottom nav。布局在窄屏允许水平滚动或折叠 Inspector，但不承诺完整移动体验。

基础要求：语义化 header/nav/main/aside、唯一 h1、按钮/表单可访问名称、可见 focus、当前导航 `aria-current="page"`、异步消息 `role=status`、错误 `role=alert`、dialog focus/escape/return-focus、颜色不作为唯一状态编码、`prefers-reduced-motion` 关闭非必要动画。

## 计划文件布局

新增模块遵守：

```text
client/src/
├── app/
│   ├── providers/
│   ├── realtime/
│   └── router/
├── api/
│   ├── auth/
│   ├── campaigns/
│   ├── characters/
│   ├── turns/
│   ├── ai/
│   ├── world/
│   ├── combat/
│   └── archives/
├── entities/
├── features/
│   ├── auth/
│   ├── campaigns/
│   ├── owner/
│   └── player/
└── shared/
    ├── api/
    ├── lib/
    └── ui/
```

旧 `pages/`、旧 root `api.ts/types.ts` 和旧 components 仅为 Phase 5 迁移保留，不作为新模块依赖。

---

## Task 1：依赖、Platform HTTP Client、Query Client 和 Router 骨架

**Files**

- Modify: `client/package.json`
- Modify: `package-lock.json`
- Modify: `client/vite.config.ts`
- Modify: `vitest.config.ts`（把 `client/src/**/*.test.ts` 纳入普通单元测试，同时显式 exclude browser scenario）
- Modify: `client/src/main.tsx`
- Modify: `client/src/App.tsx`
- Create: `client/src/shared/api/platformHttp.ts`
- Create: `client/src/shared/api/platformHttp.test.ts`（纯逻辑测试；由 root Vitest 的 `client/src/**/*.test.ts` include 收集）
- Create: `client/src/shared/lib/contractSchemas.ts`
- Create: `client/src/shared/ui/AsyncState.tsx`
- Create: `client/src/shared/ui/FeatureErrorBoundary.tsx`
- Create: `client/src/app/providers/createQueryClient.ts`
- Create: `client/src/app/providers/AppProviders.tsx`
- Create: `client/src/app/router/AppRouter.tsx`
- Create: `client/src/app/router/RouteGuards.tsx`
- Create: `client/src/app/router/router.test.tsx`（文件首行 `// @vitest-environment jsdom`）

**依赖**

- Phase 3 完成；用户批准默认方案。

**接口**

```ts
export class PlatformHttpError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;
}

export interface PlatformRequestOptions<T> {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  responseSchema: z.ZodType<T>;
  timeoutMs?: number;
}

export function platformRequest<T>(path: string, options: PlatformRequestOptions<T>): Promise<T>;
export function createAppQueryClient(): QueryClient;
export function createAppRouter(queryClient: QueryClient): Router;
```

`contractSchemas.ts` 为 HTTP envelope 组合已有 domain schemas（例如 `{ user: authenticatedUserSchema }`），避免 API 模块把 `unknown as` 当 DTO。

**Red/Green 垂直循环**

1. `platformRequest` 成功 parse JSON、204、timeout、malformed success body、平台错误 envelope、未知/非 JSON 500；错误正文永不拼接 stack/HTML；
2. QueryClient 默认 retry：普通 query 最多 2 次；401/403/404/validation 不自动 retry；`refetchOnWindowFocus=true`；tests 每次用新 client；
3. router guest/protected/root/unknown 路由行为；先用 placeholder route elements 形成可挂载骨架；所有使用 Testing Library/render 的新增 `.test.tsx` 首行必须沿用仓库约定写 `// @vitest-environment jsdom`；
4. root `vitest.config.ts` 收集普通 client `.test.ts` 与 `.test.tsx`，但显式排除 `client/src/tests/phase4-browser-flow.test.ts`，避免全量 `npm test` 假绿或误跑浏览器场景；
5. 安装依赖后 Vite alias 在 clean contracts dist 不存在时仍能 client build；
6. `main.tsx` 只 mount `<App />`，`App` 创建稳定 queryClient/router（不得 render 时反复 new）。

**Verify**

```bash
npm install --workspace client @tanstack/react-query react-router-dom lucide-react zod @dnd/contracts --save-exact=false
npm test -- client/src/shared/api/platformHttp.test.ts client/src/app/router/router.test.tsx
npm run typecheck --workspace client
npm run build --workspace client
```

预期：focused tests、client typecheck/build 通过；旧四个 client test 文件仍通过。

---

## Task 2：认证、战役列表/创建/加入和第一个浏览器实测检查点

**Files**

- Create: `client/src/api/auth/authApi.ts`
- Create: `client/src/api/campaigns/campaignApi.ts`
- Create: `client/src/entities/user/userQueries.ts`
- Create: `client/src/entities/campaign/campaignQueries.ts`
- Create: `client/src/features/auth/LoginPage.tsx`
- Create: `client/src/features/auth/RegisterPage.tsx`
- Create: `client/src/features/auth/auth.test.tsx`
- Create: `client/src/features/campaigns/CampaignListPage.tsx`
- Create: `client/src/features/campaigns/CreateCampaignPage.tsx`
- Create: `client/src/features/campaigns/JoinCampaignPage.tsx`
- Create: `client/src/features/campaigns/campaign-flow.test.tsx`
- Create: `client/src/shared/ui/AppShell.tsx`
- Modify: `client/src/app/router/AppRouter.tsx`
- Modify: `client/src/app/router/RouteGuards.tsx`
- Modify: `client/src/styles.css`
- Create in Task 6: `docs/superpowers/validation/2026-08-09-phase-4-checkpoint-a.md`（此处先保留内存/临时记录，避免尚无 fixture 时伪造浏览器证据）

**依赖**

- Task 1 HTTP/query/router 骨架。

**Red/Green 垂直循环**

1. register 成功跳 login + prefill；login 表单 401 不 loop；login returnTo 只接受安全站内路径；logout 清 cache；
2. session bootstrap loading/guest/authenticated；protected 401 后回 login；
3. campaigns ready/empty/error/retry；owner/player 卡片进入正确 workspace；
4. create 只提交 name+ruleset；成功停在 invite step；copy link 包含 encoded campaignId/code；显式确认后跳 owner/turn；
5. join link 预填 code，确认后调用 path-param endpoint；bad code 显示 CAMPAIGN_NOT_FOUND 脱敏错误；成功跳 player/story；手动 join 表单可填 id+code；
6. campaign role guard 防止 player 挂 owner 页、owner 挂 player 页；非成员回 campaigns；
7. styles 建立 auth/campaign shell、可见 focus、status/error、desktop card grid。

**检查点 A 交付与实测边界**

Task 2 完成后，功能已经达到用户可自行实测的首个版本。用户可以用一个**全新且由自己确认可删除**的临时数据库路径启动（每次选择新的文件名；不要指向已有数据库）：

```powershell
# PowerShell（示例文件名可换成新的时间戳；确认该路径不存在）
$env:DATABASE_PATH = Join-Path $env:TEMP 'dnd-phase4-manual-new.sqlite'
npm run dev
```

访问 `http://localhost:5180`，即可人工验证注册、登录、创建、复制邀请链接、第二隔离浏览器 profile 加入、owner/player workspace 骨架、刷新保持 cookie session。该命令明确使用 TEMP 数据库，不触碰默认 `DATABASE_PATH` 指向的仓库根 `dnd.sqlite`。

agent 的**自动**检查点 A 浏览器验证必须等 Task 6 fixture/runner 就绪后回跑，并把证据写入 checkpoint A 文档；在此之前 Task 2 只能标记为“可供用户实测、组件/typecheck/build green”，不能声称 agent 已完成浏览器实测。Task 6 若发现 A 流程失败，必须回修相应 Task 2 模块。

**Verify**

```bash
npm test -- client/src/features/auth/auth.test.tsx client/src/features/campaigns/campaign-flow.test.tsx client/src/app/router/router.test.tsx
npm run typecheck --workspace client
npm run build --workspace client
```

---

## Task 3：RealtimeSession、查询实体和 feature 级错误隔离

**Files**

- Create: `client/src/api/realtime/realtimeEvents.ts`
- Create: `client/src/app/realtime/RealtimeSession.ts`
- Create: `client/src/app/realtime/RealtimeSession.test.ts`（纯逻辑测试；由 root Vitest 的 `client/src/**/*.test.ts` include 收集）
- Create: `client/src/app/realtime/RealtimeBoundary.tsx`
- Create: `client/src/entities/character/characterQueries.ts`
- Create: `client/src/entities/turn/turnQueries.ts`
- Create: `client/src/entities/ai/aiQueries.ts`
- Create: `client/src/entities/world/worldQueries.ts`
- Create: `client/src/entities/combat/combatQueries.ts`
- Create: `client/src/entities/archive/archiveQueries.ts`
- Create: `client/src/api/characters/characterApi.ts`
- Create: `client/src/api/turns/turnApi.ts`
- Create: `client/src/api/ai/aiApi.ts`
- Create: `client/src/api/world/worldApi.ts`
- Create: `client/src/api/combat/combatApi.ts`
- Create: `client/src/api/archives/archiveApi.ts`
- Create: `client/src/shared/lib/queryKeys.ts`
- Create: `client/src/shared/lib/safeSheet.ts`

**依赖**

- Task 1 QueryClient；Task 2 authenticated campaign routes。

**接口**

```ts
export interface RealtimeSnapshot {
  status: RealtimeStatus;
  attempts: number;
  lastSeenSequence: number;
  previews: ReadonlyMap<string, string>;
  previewError: { runId: string; code: string } | null;
  interactionNoticeCount: number;
}

export interface EventSourceLike {
  addEventListener(type: string, listener: EventListener): void;
  close(): void;
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
}

export class RealtimeSession {
  constructor(queryClient: QueryClient, eventSourceFactory?: EventSourceFactory, timers?: RealtimeTimers);
  start(campaignId: string): void;
  stop(): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): RealtimeSnapshot;
}
```

**Red/Green 垂直循环**

1. 无 campaignId 不连；campaign change/stop 清旧连接和 timer；
2. 合法 campaign frame parse；重复 sequence、乱序 sequence、invalid id、invalid contract；
3. started/delta/failed preview 生命周期，重复 delta 不 append；
4. 每种 event 的精确 query invalidation；archive.restore 前缀全失效；`owner.debug` 事件处理器只失效/请求 run detail，不直接展示 payload；只有 Task 4 明确展开的 owner run-detail panel 可显示服务端 owner-only detail；
5. disconnect/backoff/reconnect URL 带 after；open 重置 backoff；stopped callback 无效；`getSnapshot()` 在状态不变时保持对象引用稳定，满足 `useSyncExternalStore` 契约；
6. `RealtimeBoundary` 在 campaign workspace mount/unmount session，并用 `useSyncExternalStore` 渲染 connection status；
7. safeSheet 只读取已知 primitive/string-array，恶意对象/原型字段/错误类型安全回退；
8. API module response envelopes 全部 zod parse；world DELETE 用 204 schema；archive restore 正确解析 `{ result }` 而非错误的顶层 shape。

**Verify**

```bash
npm test -- client/src/app/realtime/RealtimeSession.test.ts client/src/shared/api/platformHttp.test.ts
npm run typecheck --workspace client
```

---

## Task 4：Owner 工作区五页和第二个浏览器实测检查点

**Files**

- Create: `client/src/features/owner/OwnerWorkspacePage.tsx`
- Create: `client/src/features/owner/components/OwnerHeader.tsx`
- Create: `client/src/features/owner/components/OwnerSidebar.tsx`
- Create: `client/src/features/owner/components/OwnerInspector.tsx`
- Create: `client/src/features/owner/turn/OwnerTurnPage.tsx`
- Create: `client/src/features/owner/turn/OwnerAiRunPanel.tsx`
- Create: `client/src/features/owner/characters/OwnerCharactersPage.tsx`
- Create: `client/src/features/owner/world/OwnerWorldPage.tsx`
- Create: `client/src/features/owner/combat/OwnerCombatPage.tsx`
- Create: `client/src/features/owner/archives/OwnerArchivesPage.tsx`
- Create: `client/src/features/owner/owner-workspace.test.tsx`
- Modify: `client/src/app/router/AppRouter.tsx`
- Modify: `client/src/styles.css`
- Create in Task 6: `docs/superpowers/validation/2026-08-09-phase-4-checkpoint-b.md`（Task 4 完成时先声明可手工实测，自动证据待 fixture 回跑）

**依赖**

- Task 3 API/query/realtime 模块。

**Red/Green 垂直循环**

1. OwnerShell 三栏语义区域、稳定 navigation、campaign name、turn/realtime status；route panel throw 只替换 main panel；
2. turn empty → start；waiting → count/ID chips；locked/attention → resolve；actions 正文只在 owner page；
3. AI run list/status/detail；resolve pending disabled；network replay key 与 failed retry new key；AI_PROVIDER_FAILED 可恢复；detail rawDebug/context 只在明确展开的 owner panel；
4. characters pending review render safe sheet + approve/reject；mutation 后 invalidation；没有旧 CharacterReviewPanel import；
5. world create/edit/delete、kind/visibility/knownBy；player_private 无 target 时表单阻止提交；
6. combat start form至少一个 combatant；preparation initiative；active command forms 按 contract kind 生成严格 payload；completed read-only；
7. archives empty/manual create/restore confirmation；restore 后全 campaign invalidation 已由 Realtime/本地 mutation双保险；
8. 各 panel loading/empty/error/retrying，combat/AI detail 子 boundary。

**检查点 B 交付与实测边界**

Task 4 完成后，用户可沿用检查点 A 的 TEMP `DATABASE_PATH` 启动方式，人工验证 owner：看到待审角色、approve、创建世界事实、创建/推进 encounter、手动存档和 restore。agent 自动验证仍由 Task 6 fixture 回跑，并把截图/步骤/发现与修复结果写入 checkpoint B 文档；在证据落盘前不得称检查点 B 已由 agent 浏览器实测。

**Verify**

```bash
npm test -- client/src/features/owner/owner-workspace.test.tsx
npm run typecheck --workspace client
npm run build --workspace client
```

---

## Task 5：Player 工作区、角色/背包、行动锁定和只读战斗

**Files**

- Create: `client/src/features/player/PlayerWorkspacePage.tsx`
- Create: `client/src/features/player/components/PlayerHeader.tsx`
- Create: `client/src/features/player/components/PlayerInspector.tsx`
- Create: `client/src/features/player/story/PlayerStoryPage.tsx`
- Create: `client/src/features/player/story/TurnEntries.tsx`
- Create: `client/src/features/player/action/PlayerActionComposer.tsx`
- Create: `client/src/features/player/character/PlayerCharacterPage.tsx`
- Create: `client/src/features/player/character/PlatformCharacterEditor.tsx`
- Create: `client/src/features/player/inventory/PlayerInventoryPage.tsx`
- Create: `client/src/features/player/combat/PlayerCombatPage.tsx`
- Create: `client/src/features/player/player-workspace.test.tsx`
- Modify: `client/src/app/router/AppRouter.tsx`
- Modify: `client/src/styles.css`

**依赖**

- Task 3 queries/realtime；Task 4 共用 shell styles。

**Red/Green 垂直循环**

1. PlayerShell 只出现 player navigation/inspector；DOM 中不存在 owner Prompt/AI context/rawDebug/other action；
2. story 按 turn 显示 narrative/private_update/dice；unknown payload 安全 fallback；SSE preview 单独标“临时生成中”，failed 后消失并提示；
3. composer waiting + required 时可编辑/提交；mutation 后保留 server-confirmed body；waiting 期间 SSE refetch 不覆盖 dirty draft；locked event/refetch 后 disabled 且显示“本回合已锁定”；无 active turn/未批准角色/owner attention 各有明确状态；
4. character create/update/submit；pending read-only；rejected 可编辑；approved 显示 derived AC；编辑字段固定为：姓名、AC、力量/敏捷/体质/智力/感知/魅力、equipment、spells、背景与备注；不调用 legacy API；
5. inventory 只读 own sheet equipment/spells；错误 shape 为空；不显示 party approved summaries 的 sheet；
6. combat 只读 projected rows；activeCombatantId null 时不推断隐藏 id；无 mutation controls；
7. public progress count + abbreviated IDs；interaction notice 明示暂不支持回答且不展示 prompt；
8. feature boundary：story throw 不卸载 header/action/inspector，combat throw 不白屏整个 workspace。

**Verify**

```bash
npm test -- client/src/features/player/player-workspace.test.tsx client/src/app/realtime/RealtimeSession.test.ts
npm run typecheck --workspace client
npm run build --workspace client
```

---

## Task 6：临时浏览器 fixture、完整真实实测和回归收口

**Files**

- Create: `server/src/tests/fixtures/phase4BrowserServer.ts`
- Create: `scripts/phase4-browser-validation.ts`
- Create: `client/src/tests/phase4-browser-flow.test.ts`
- Create: `docs/superpowers/validation/2026-08-09-phase-4-checkpoint-a.md`
- Create: `docs/superpowers/validation/2026-08-09-phase-4-checkpoint-b.md`
- Create: `docs/superpowers/validation/2026-08-09-phase-4-browser-validation.md`
- Modify: `package.json`（仅增加明确的 Phase 4 browser validation script，若测试直接由 Vitest 管理则不改）
- Modify: `docs/superpowers/plans/2026-08-02-dnd-ai-dm-rearchitecture-revised.md`
- Create: `docs/superpowers/reviews/2026-08-09-phase-4-frontend-workspaces-review.md`

**依赖**

- Tasks 1–5 全部 focused green。

**测试 fixture 约束**

`phase4BrowserServer.ts` 只能位于 tests/fixtures，不能被 `server/src/index.ts` import。`scripts/phase4-browser-validation.ts` 是唯一编排入口，并由 root npm script 通过 `tsx scripts/phase4-browser-validation.ts` 执行，因此可直接 import TypeScript fixture 与 browser scenario；它用 Vite 的 JavaScript interface 创建带临时 target proxy 的 dev/preview server，并在同一进程运行 Playwright 场景。选择 dev server 时配置 `server.proxy`，选择 preview server 时配置 `preview.proxy`；不得靠修改静态 `client/vite.config.ts` 或人工预启动服务来选择随机后端端口。runner 启动 Chromium 时显式把 `PLAYWRIGHT_BROWSERS_PATH` 指向仓库内 gitignored 的 `playwright-browsers/`，并在运行前报告缺失 browser binary 为 blocker。fixture：

- 创建临时目录和临时 SQLite，或复用 `startPlatformServer()` 的 in-memory platform；
- 注入 deterministic `ScriptedAiProvider`，按 prompt.characters 构造合法 public/private output 并发送 preview delta；
- 监听临时端口；
- 启动/对接 Vite preview/dev server，确保浏览器仍经同源 `/api` proxy 获得 cookie/SSE；
- teardown 关闭 EventSource/runtime/http/vite/db 并删除临时文件；
- 绝不读取/写入默认 `DATABASE_PATH` 指向的仓库根 `dnd.sqlite`，绝不修改 production Provider default。

若 Vitest 内管理 Playwright server 生命周期不稳定，默认使用上述独立 `tsx` runner；它必须由 npm script 单命令执行并有非零失败码，不得依赖人工提前启动服务。`client/src/tests/phase4-browser-flow.test.ts` 仅导出可由 runner 调用的场景函数，并由 root `vitest.config.ts` 显式 exclude，确保普通 `npm test` 不会在 node 环境重复执行它。

**真实浏览器验收（至少两个隔离 context；隐私步骤增加第三个 playerB）**

1. owner register/login/create，保存 invite link；
2. playerA 独立 context register/login/join；playerB 独立 context register/login/join；
3. A/B 各创建角色并 submit；owner 审核；
4. owner start turn；A 提交后 owner/A/B 实时进度更新但未锁；A 编辑仍可用；B 提交后所有 context 显示 locked，A/B editor disabled；
5. owner resolve；A/B 都看到 public preview；成功后各自看到 public narrative + 自己 private update，A DOM/文本不含 B private，B 不含 A private；player contexts 不含 owner.debug/context/rawDebug；
6. owner 创建包含 public/player_private/owner_only 战斗员的 encounter；A/B 只看到各自投影；
7. owner manual archive → 变更 world/combat → restore；页面通过 `archive.restored` 刷新恢复状态；
8. 模拟断开 EventSource/重连（或关闭再恢复 fixture stream）证明 last id 后补发、DOM 无重复 preview/entry；
9. 一个 feature 请求故意返回错误，证明 workspace shell 与其它 panel 仍可用；
10. logout 后 protected route 回 login；刷新登录 session 保持。

浏览器测试必须断言用户可见文本和隐私缺失，不只截屏。截图/trace 可作为附加证据写到 `output/playwright/phase4/`（不强制纳入业务 diff）。

**全量回归**

```bash
npm run test:phase4-browser
npm test
npm run typecheck
npm run build
git diff --check
git status --short --branch
```

验收记录必须列出命令、exit code、浏览器 contexts、关键断言、截图/trace 路径、无法运行项。若浏览器环境阻塞，Phase 4 不能宣称完整实测；必须明确标为 blocker，而不是用 jsdom 代替。

---

## Task 7：独立实现复审与缺陷闭环

**Files**

- Modify: `docs/superpowers/reviews/2026-08-09-phase-4-frontend-workspaces-review.md`
- Modify only for accepted fixes: Tasks 1–6 已列文件

**依赖**

- Task 6 全量自动化与浏览器实测证据。

并行 fresh-context 审查：

1. **规格/隐私审查**：路线范围、owner/player DOM/API/SSE 隔离、错误脱敏、无 legacy dependency、Phase 5 non-goals；
2. **工程审查**：router/query/realtime 生命周期、TDD 质量、构建、错误边界、可维护性；
3. **浏览器验收审查**：真实流程是否真的执行 changed code、是否使用隔离 context、是否存在假 mock/共享 cookie/只测截图。

任何 Blocker/Major 由单一 fix worker 修复后重跑 affected focused tests + browser flow + typecheck/build，并做针对性复审。Minor 只有明确不影响 Phase 4 验收时才可记录为 residual。

**完成 Verify**

```bash
npm test
npm run typecheck
npm run build
npm run test:phase4-browser
git diff --check
```

## 工作树与 Git 约束

- 保留已有 Node 24 改动：`.nvmrc`、root `package.json`、`package-lock.json`；只在 lockfile 上添加 Phase 4 dependencies，不回退 engines。
- 当前工作树含已批准但未提交的 Phase 3 修改；Phase 4 单写入通道必须在其上工作，不覆盖、不恢复。
- `.pi/`、`.pi-subagents/`、`.codex-tmp/` 是工具产物，不纳入业务改动。
- 不修改默认 `DATABASE_PATH` 指向的仓库根 `dnd.sqlite`；浏览器 fixture 使用内存/临时数据库。
- 不执行 `git add`、commit、push、reset、checkout、clean、stash。
- 任意时刻只有一个 mutation agent；parent 和 reviewers 在 worker 活跃时只读。

## 明确延期到 Phase 5

- rules/Provider 管理、API key 加密；
- legacy adapter、旧入口正式 cutover/删除；
- bare-code `POST /api/campaigns/join`；
- campaign member login/displayName DTO；
- interaction request list/answer HTTP；
- invite regenerate/member management/campaign delete/status transition；
- 完整 mobile experience；
- 旧规则目录驱动的 986 行 CharacterBuilder 迁移。

## 完成定义

Phase 4 只有在以下全部成立时完成：

- 登录/注册/campaign create/join/role routing 在 component tests 和真实浏览器通过；
- owner 五页与 player 五页可挂载、可操作并只查询自身 feature；
- player action 编辑/锁定和实时进度在 owner + playerA + playerB 隔离 context 通过；
- SSE sequence 去重、重连、preview failed drop、archive restore 全量失效通过；
- player 看不到他人 private、owner debug/context/rawDebug/隐藏 world/combat；
- 单 panel 失败不使 workspace 白屏；
- 新 client 无 legacy page/api/types import；旧测试仍通过；
- client/root test、typecheck、build 和 browser validation 全绿；
- 默认 `DATABASE_PATH` 指向的仓库根 `dnd.sqlite` 未改；工作树未 stage/commit；
- 独立规格/隐私、工程和浏览器验收审查无 Blocker/Major；
- 路线图 Phase 4 更新为完成，才允许编写 Phase 5 详细计划。
