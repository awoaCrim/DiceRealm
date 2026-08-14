# Owner 工作区：AI 接口与日志页面

状态：✅ 已实施，并于 2026-08-10 完成可编辑 Provider 配置

## 范围

新版 Owner 工作区包含：

- `AI 接口`：配置当前战役的 OpenAI-compatible Provider、Base URL、Model 与 write-only API Key；支持连接测试、AES-256-GCM 加密保存以及保存后立即切换运行时。
- `AI 日志`：展示当前战役的全部 `platform_ai_runs` 历史记录，Owner 可按需展开 context/result/rawDebug 详情。

Provider 配置的完整设计与验证记录见：[`2026-08-10-dnd-ai-dm-webui-provider-config.md`](./2026-08-10-dnd-ai-dm-webui-provider-config.md)。

## 安全边界

- 所有端点都挂在 `/api/campaigns/:campaignId/ai` 下，并由服务端 `requireOwner` 强制保护。
- Player 即使直接请求 API 也只能得到 `403`。
- Provider 状态 DTO 使用脱敏 `AiProviderPublicConfig`，不包含 API Key。
- API Key 为 write-only；保存后只返回 `apiKeyConfigured`，不会回显原值。
- API Key 由服务端自动生成并复用的本地密钥执行 AES-256-GCM 加密后保存；无需手动配置主密钥。
- API Key 不进入 AI runs、context/result/rawDebug、错误响应或浏览器 Query Cache。
- 页面没有把旧版 `AdminPage`、`global_config` 或旧版 admin 配置 API 接入新版 Owner 工作区。

## 路由

页面：

- `/campaigns/:campaignId/owner/ai-provider`
- `/campaigns/:campaignId/owner/ai-logs`

HTTP：

- `GET /api/campaigns/:campaignId/ai/provider-status`
- `PUT /api/campaigns/:campaignId/ai/provider-config`
- `POST /api/campaigns/:campaignId/ai/provider-config/test`
- `GET /api/campaigns/:campaignId/ai/runs`

Owner 侧栏包含「AI 接口」和「AI 日志」。

## 验证

- Owner 工作区前端测试覆盖导航、表单预填、连接测试、保存、密钥清空、脱敏状态、日志列表和显式展开详情。
- HTTP 测试覆盖 Owner/Player 权限、Provider 响应不含 `apiKey`、ciphertext 落库、空 key 沿用、内部加密不可用时安全失败、运行时即时切换。
- 真实三隔离浏览器场景覆盖 WebUI 填写 → 测试 → 保存 → API Key 不回显，并继续完成 AI 结算、SSE 重连、世界/遭遇创建与存档恢复；14 步通过。
- contracts/server/client typecheck、production build 与 `git diff --check` 通过。
