# Owner WebUI AI Provider 配置与加密凭证

状态：✅ 已实施（2026-08-10）

## 目标

把 Owner 工作区的「AI 接口」从只读状态页改成完整可用的战役级配置页：

1. Owner 在 WebUI 填写 Provider / Base URL / Model / API Key。
2. 可先执行真实的 Chat Completions 连接测试。
3. API Key 使用服务端自动持久化的本地密钥进行 AES-256-GCM 加密后保存。
4. 保存后后续新 AI run 立即使用新 Provider，无需编辑 `.env` 或重启。
5. API Key 为 write-only：保存后永不回显；留空保存/测试表示沿用已保存密钥。

本切片拉取了 Phase 5 的 Provider 凭证管理能力，但不包含规则资料库、legacy adapter 或完整 cutover。

## 安全边界

- 新端点全部位于 `/api/campaigns/:campaignId/ai`，先经过 `requireCampaignMember`，再由服务端 `requireOwner` 强制授权；Player 直接调用返回 `403`。
- 服务端首次启动时自动生成 32-byte 随机本地密钥文件，后续启动自动复用；用户无需配置任何主密钥环境变量。密钥文件与 `DATABASE_PATH` 位于同一目录、使用 exclusive create，并在支持 POSIX 权限的平台收紧为 `0600`。
- 本地密钥文件若被删除，服务端会在下次启动自动生成新的随机密钥；此前保存的 Provider 凭证无法用新密钥解密，需要在 WebUI 重新填写 API Key。密钥文件损坏时不会被静默覆盖。
- Provider URL 不再执行 DNS/IP 公网判定：loopback、LAN、保留地址及代理 fake-IP 均可由 Owner 配置。仍只允许 HTTP(S)、禁止 URL credentials，且 Provider transport 不跟随重定向。由于 Owner 可让服务器向任意 HTTP(S) 目标发起请求，部署方必须把 Owner 视为受信任的管理权限。
- `CredentialCipher` 使用 AES-256-GCM，每次加密生成独立 96-bit IV，并保存版本、IV、认证标签与 ciphertext envelope。
- 数据库表只保存 `encrypted_api_key`；HTTP DTO、AI run、日志、debug、错误响应与浏览器 Query Cache 均不包含 API Key。
- 解密失败返回固定脱敏错误 `CREDENTIAL_DECRYPTION_FAILED`，不包含 ciphertext、密钥、URL 或堆栈。
- Provider 连接测试将密钥只放入上游 `Authorization: Bearer` 请求头；任意上游错误统一收敛为固定 `AI_PROVIDER_FAILED` 文案。修改 API 地址时必须重新填写 API Key，避免把旧密钥误发给新端点。
- 不复用 legacy `AdminPage`、`global_config` 或会回退到 Mock 的 legacy Provider factory。

## 数据与迁移

新增 `server/src/platform/database/migrations/010_ai_provider_credentials.sql`：

- `platform_ai_provider_configs`
- 每战役唯一：`campaign_id` 为主键与 `campaigns(id)` 外键
- 字段：`provider`、`base_url`、`model`、`encrypted_api_key`、`created_at`、`updated_at`
- SQL 同时兼容 SQLite/PostgreSQL，不使用方言函数

## 运行时设计

- 环境变量 Provider 保留为未配置战役的 fallback。
- `CampaignScopedAiProvider` 是注入 `AiResolutionService` 的稳定 facade。
- 每个新 run 在 claim 前按 `campaignId` 解析一次真实 Provider，并固定该实例完成 run identity 与 stream 调用，避免进行中配置变更造成 provider/model 撕裂。
- WebUI 保存写入数据库后，下一次新 run 立即解析到新 Provider。
- 幂等 replay 不重新调用 Provider。

## HTTP API

- `GET /api/campaigns/:campaignId/ai/provider-status`
  - Owner-only
  - 返回脱敏配置：provider/baseUrl/model/configured/apiKeyConfigured/source
- `PUT /api/campaigns/:campaignId/ai/provider-config`
  - Owner-only
  - 写入式 `apiKey`；已有密钥时空字符串表示沿用
  - 返回脱敏配置
- `POST /api/campaigns/:campaignId/ai/provider-config/test`
  - Owner-only
  - 使用表单密钥；空字符串可沿用已保存密钥
  - 成功返回 `{ "ok": true }`

## WebUI

`OwnerAiProviderPage` 提供：

- OpenAI-compatible Provider 选择
- API 地址、模型、密码型 API Key 输入
- 「测试连接」
- 「保存并立即启用」
- 当前来源与脱敏状态
- 保存成功后清空 API Key 输入框
- 明确展示凭证安全说明

## 验证

- `CredentialKeyStore`：首次生成、重启复用、`0600` 权限、损坏文件拒绝自动替换。
- `CredentialCipher`：round-trip、随机 IV、严格 canonical base64 序列化密钥、非法密钥、篡改检测。
- `ProviderUrlPolicy`：公网域名、无 DNS 域名、loopback/LAN/保留/fake-IP 地址均可通过；非法 URL、非 HTTP(S) 与 URL credentials 仍拒绝；Provider adapter 验证 3xx 不跟随。
- 数据库：迁移 010 建表、只应用一次、只保存 ciphertext。
- Service：保存前 fallback，保存后立即动态切换；Provider factory 获得解密后的密钥而非 ciphertext。
- HTTP：Owner/Player 权限、测试连接、加密保存、write-only 密钥、内部加密不可用时安全失败、保存后下一次 run 立即使用新 Provider。
- Client：表单预填、测试、保存、清空密钥、日志详情按需读取；Provider 请求直接发出，不进入 TanStack Query mutation cache，只有脱敏响应写入 Query Cache。
- 真实浏览器：三隔离 context 场景在 Owner WebUI 完成填写 → 测试 → 保存；验证密钥不回显；原 Phase 4/AI 创建世界与遭遇完整流程继续通过，共 14 步。
- contracts/server/client typecheck、root build、`git diff --check` 通过。
