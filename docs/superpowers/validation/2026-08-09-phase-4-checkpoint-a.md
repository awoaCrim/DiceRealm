# Phase 4 检查点 A：认证与战役流程浏览器验证

> 日期：2026-08-09
> 状态：PASS
> 运行入口：`npm run test:phase4-browser`

## 环境

- test-only `server/src/tests/fixtures/phase4BrowserServer.ts`
- 内存 SQLite；未读取或修改默认 `DATABASE_PATH` 下的任何运行数据库
- 随机后端端口 + 随机 Vite 端口；浏览器始终通过同源 `/api` proxy 传递 cookie 与 SSE
- Playwright Chromium；owner、playerA、playerB 三个隔离 BrowserContext

## 已验证

1. owner 注册后跳转登录，登录名预填且密码不进入 URL。
2. owner 登录并进入“我的战役”。
3. owner 创建战役，页面展示一次性邀请码与包含 `campaignId + code` 的邀请链接。
4. owner 确认已保存后进入 `/campaigns/:id/owner/turn`。
5. playerA/playerB 分别在独立 BrowserContext 注册、登录并使用邀请链接加入。
6. 两名玩家分别进入 `/campaigns/:id/player/story`；cookie/session 不共享。
7. owner 工作区和 player 工作区均显示真实 campaign 名称并建立 SSE 连接。
8. 刷新保持登录 session；logout 后受保护路由重定向到 `/login?returnTo=...`。

## 证据

- `output/playwright/phase4/phase1-owner-workspace.png`
- `output/playwright/phase4/phase1-playerA-story.png`
- `output/playwright/phase4/phase8-logout.png`
- 完整命令最终 exit code：0（见 `2026-08-09-phase-4-browser-validation.md`）

## 用户人工实测

使用全新临时数据库文件，避免触碰运行数据：

```powershell
$env:DATABASE_PATH = Join-Path $env:TEMP ("dnd-phase4-manual-" + [guid]::NewGuid() + ".sqlite")
npm run dev
```

访问 `http://localhost:5180`，并用两个隔离浏览器 profile 验证创建与加入。生产默认 Provider 为 unavailable，因此 AI 成功预览请使用自动 browser fixture；普通开发服务仍可验证认证、战役与错误恢复。
