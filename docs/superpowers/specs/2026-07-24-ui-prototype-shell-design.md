# UI Prototype Shell Design

**Date:** 2026-07-24  
**Status:** Approved for implementation planning  
**Goal:** 新建几乎无依赖的静态 HTML 前端原型，只保留 UI 结构与最基础本地逻辑；不接后端、不使用 CSS 框架/组件库。

## 1. Background

现有 `client/` 约 78 个源文件、约 1.4 万行，包含 React、React Router、TanStack Query、Tailwind、Radix、SSE 与大量业务逻辑。用户希望单独抽出一套**纯 UI 壳**，便于后续重做视觉或重写逻辑，而不污染现网前端。

## 2. Goals

- 覆盖全套三页：Home、Player、Admin（高保真布局）
- 只保留 UI 分区与最基础本地交互（切 Tab、表单本地反馈、列表增删等）
- 原生 HTML 控件；默认无样式文件 / 无设计系统
- **双击 HTML 即可运行**（`file://`），无需 npm、构建或本地服务器
- 独立目录，不改现有 `client/` 业务代码

## 3. Non-Goals

- 真实 API、SSE、鉴权、React Query
- React / Vite / Tailwind / Radix / shadcn / design tokens
- AI 真调用、知识库导入、远程战役 DB 绑定
- 可拖拽三栏宽度、完整 CharacterBuilder 规则引擎
- 自动化测试
- 与 `client/` 长期双向结构同步
- 将原型加入 npm workspaces（除非后续另议）

## 4. Approach

**方案 C：纯 HTML + 经典 script（非 ES modules）**

- 独立目录 `ui-prototype/`
- 三页 HTML + 共享 `js/`（`window` 全局挂载，避免 `file://` 下 module 限制）
- Mock 数据驱动渲染；刷新回到 mock 初始态（不使用 localStorage）

曾考虑但未采用：

- **A. 独立 Vite+React 原型**：更可维护，但需要构建/开发服务器，不符合「直接打开 HTML」
- **B. 拷贝现 client 再删减**：起步快，但依赖与死代码多，与原生 HTML/无 CSS 目标冲突

## 5. Directory Layout

```
ui-prototype/
  README.md
  index.html          # Home：建房 + 房间列表
  player.html         # 玩家端
  admin.html          # 管理端
  js/
    mock.js           # window.UI_MOCK — 数据与 createInitialState()
    common.js         # window.UI_COMMON — qs、tab、label、DOM 小工具
    home.js
    player.js
    admin.js
```

每个 HTML 底部按固定顺序加载 script（无 `type="module"`）：

```html
<script src="js/mock.js"></script>
<script src="js/common.js"></script>
<script src="js/home.js"></script>  <!-- 仅对应页面 -->
```

## 6. Information Architecture

### 6.1 Shared shell (Player / Admin)

```
Topbar：标题 · 房间名 · 回合/状态 · 回首页
Sidebar | Main（当前 Tab） | Aside
```

- 无拖拽调宽；用简单多列布局（table 或 div）即可
- 控件：`button` / `input` / `select` / `textarea` / `table` / `details`+`summary`
- 默认零 CSS；若可读性必要，允许 HTML 内极少内联 style（如 `pre { white-space: pre-wrap }`），不建 css 目录

### 6.2 Home (`index.html`)

| 区块 | 内容 | 基础逻辑 |
|------|------|----------|
| 标题 | DND AI-DM + 说明 | — |
| 创建房间 | 名称、预期人数、创建、错误文案 | 内存 mock 追加房间 |
| 房间列表 | 名称、回合、状态、人数 | 进入管理/玩家链接；删除需 `confirm` |

链接约定：

- 管理：`admin.html?room=<id>`
- 玩家：`player.html?token=<token>`

### 6.3 Player (`player.html`)

**Sidebar tabs**

| Tab | 主区区块 | 基础逻辑 |
|-----|----------|----------|
| 剧情 | 公开/私密日志；日志列表；待互动回应；行动类型 + 文本 + 提交；禁用原因 | 本地追加日志/标记回应；更新本回合行动摘要 |
| 人物卡 | 建卡字段组 / 审核中只读 / 已通过人物卡分区（属性、技能、资源） | 本地 draft → pending → approved |
| 背包 | 物品表、货币、添加表单 | 本地增删改 |
| DM 助手 | 消息列表 + 输入 + 发送 | 本地 echo 或固定 mock 回复 |

**Aside**

- 角色快览（名/职级/HP）
- 本回合行动摘要
- 房间状态 + 等待中的玩家
- 战斗态势表
- 最近骰点

### 6.4 Admin (`admin.html`)

**Sidebar tabs**

| Tab | 主区区块 | 简化 |
|-----|----------|------|
| 跑团 | 状态条；玩家管理；角色审核；日志切换；AI 回合操作条；结果摘要 + 折叠 prompt；回档选择 | 按钮只改本地状态/文案 |
| 战役数据库 | 子导航（记录/数据源/世界书）；筛选搜索；列表+详情；新建到本地列表 | 2–3 条 mock，无远程 DB |
| AI 主持 | 子 Tab：风格/调试/助手；运行参数；预设块列表；prompt 预览；助手表单 | 保存/测试 → 模拟成功文案 |
| 日志 | 请求日志表 + 详情折叠；流水线简表 | 静态 mock + 展开收起 |
| 设置 | 主 AI / Embedding 表单；测试与保存 | 本地成功文案 |

**Aside 子 Tab**

- 玩家、角色（选中后摘要）、战斗、骰点；（可选）资源变更只读列表

## 7. Mock Data Minimum Set (`js/mock.js`)

- 1 个 demo 房间 + 2–3 名玩家（含 token）
- 1 个已通过角色 + 1 个待审角色
- 公开 / 私密 / 客观日志各若干
- 战斗约 3 单位 + 约 2 条骰点
- 战役记录约 3 条、AI 日志约 2 条、设置默认字段
- 导出 `createInitialState()`，页面脚本在内存中持有可变副本

## 8. Interaction Rules

| 行为 | 约定 |
|------|------|
| 切 Tab / 子 Tab | 显示对应 section；可用 hash（`#story` / `#play`）尽量保持刷新后 Tab |
| 表单提交 | `preventDefault`；仅非空校验；区块内文字提示成功/失败 |
| 危险操作 | `window.confirm` |
| 禁用 | `disabled` + 旁注原因 |
| 调试块 | `<details><summary>` + `<pre>` |
| 数据生命周期 | 刷新回到 mock 初始态（无 localStorage） |
| 文案 | 中文；状态码映射放在 `common.js` 的 label 函数 |

## 9. Engineering Conventions

| 项 | 决定 |
|----|------|
| 打开方式 | 资源管理器双击 HTML；README 仅说明此方式 |
| 构建 / 服务器 / npm | 无；根 package.json 不增加 dev 脚本 |
| monorepo | 不加入 workspaces；不修改 `client/` 业务 |
| 全局命名 | `window.UI_MOCK`、`window.UI_COMMON`；避免污染无关全局名 |
| 文件职责 | mock 无 DOM；common 无页面业务；页面 js 只绑本页 |
| 测试 | 不做 |

## 10. Success Criteria

1. 双击 `index.html`（不启服务）可打开，三页相对链接可互跳
2. Home 能增删房间并进入 Admin/Player
3. Player 四 Tab + Aside 区块齐全；行动/互动/背包/DM 有本地反馈
4. Admin 五 Tab + Aside 子 Tab 齐全；按钮有模拟反馈；复杂配置为高保真只读或本地表单
5. 无 React / Tailwind / 网络请求（控制台无跨域 API 失败）
6. 默认无独立 CSS 文件

## 11. Implementation Notes (for planning)

- 优先抄现网**信息架构与字段名**，不抄业务服务调用
- 高保真指「区块与字段在」，不是复刻全部边缘状态机
- 战役库 / AI 主持 / 日志以展示结构为主，交互保持浅层
- README 用中文，说明双击打开与目录说明即可
