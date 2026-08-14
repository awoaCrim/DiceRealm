# AI Provider 环境变量启动切片

> 状态：✅ 已实施（2026-08-09）。Provider/model 保真、OpenAI-compatible 协议适配、环境变量解析/安全工厂、正式结算垂直测试均通过；全量串行测试 794 passed / 22 skipped，server typecheck 与 root build 全绿。
>
> 后续状态：本 env-only 桥接仍作为未配置战役的安全回退；可编辑 WebUI、AES-256-GCM 凭证与即时运行时切换已在 [`2026-08-10-dnd-ai-dm-webui-provider-config.md`](./2026-08-10-dnd-ai-dm-webui-provider-config.md) 实施。
>
> 依赖：Phase 4 已完成并通过复审；[`2026-08-09-dnd-ai-dm-ai-world-encounter-creation.md`](./2026-08-09-dnd-ai-dm-ai-world-encounter-creation.md) 已让 AI-DM 能在正式结算事务中创建世界事实与发起遭遇。

## Goal

解除普通 `npm run dev` 的 AI 结算阻塞：当服务端进程通过环境变量显式配置 OpenAI-compatible Chat Completions 服务时，平台 AI runtime 使用真实 Provider；未配置、配置不完整、类型非法或显式选择 mock/scripted 时继续安全使用 `UnavailableAiProvider`，绝不默认 Mock。

本切片是 Phase 5 加密凭证管理之前的**无落库启动配置桥接**。API Key 只存在于服务端进程环境与内存，不写入 SQLite/PostgreSQL，不进入 HTTP DTO、日志、AI run context/result/debug 或前端。

## Architecture

- `createApp()` 的默认组合保持不变：没有显式注入 Provider 时仍使用 `UnavailableAiProvider`。这保证测试、fixture 与嵌入式调用不会因宿主环境变量而悄悄改变行为。
- 环境变量只在 `server/src/index.ts` composition root 读取；`index.ts` 通过工厂创建 `AiProviderPort` 并显式注入 `createApp()`。
- 新 `OpenAiCompatibleAiProvider` 只实现端口适配：调用既有且已测试的 `requestOpenAiCompatibleMessage()` HTTP 核心，返回可供 `TurnResolutionValidator` 校验的结构化对象；不持有数据库事务，不应用领域状态。
- Provider 输出的 JSON 解码属于协议适配，不属于领域校验。适配器允许纯 JSON、Markdown JSON fence、以及包含单个 JSON object 的响应；最终唯一领域真相仍是 `turnResolutionSchema` + `TurnResolutionValidator`。适配器在自己的模块内实现小型候选提取器，不导出或复用 legacy 私有 `extractJsonCandidate()`。
- 无法解码为上述 JSON object 时，适配器抛出固定、脱敏且不含原始响应正文的错误；`AiResolutionService` 将其归类为 `AI_PROVIDER_FAILED`。能解码但不符合领域 schema 的对象才归类为 `AI_OUTPUT_INVALID`。
- 预览只发送已解析对象中的非空 `publicNarrative`；无法提取安全公开叙事时不发送 delta，避免把完整 JSON（其中可能包含 private/owner-only 内容）广播到 public preview。
- `AiProviderPort` 暴露 `model`，使 `platform_ai_runs.model` 记录真实模型名，而不是重复 provider 名。

## 环境变量

| 名称 | 默认值 | 说明 |
| --- | --- | --- |
| `AI_PROVIDER` | `unavailable` | 只有 `openai-compatible` 会启用真实 Provider；其它值安全回落 unavailable |
| `AI_PROVIDER_BASE_URL` | 空 | 例如 `https://api.openai.com/v1`；必须为 HTTP(S) URL |
| `AI_PROVIDER_API_KEY` | 空 | 仅服务端环境；禁止写入示例或日志 |
| `AI_PROVIDER_MODEL` | 空 | 上游模型标识 |
| `AI_PROVIDER_TIMEOUT_MS` | `240000` | 正整数 |
| `AI_PROVIDER_MAX_ATTEMPTS` | `3` | 正整数 |
| `AI_PROVIDER_TEMPERATURE` | `0.7` | `0..2` |

解析函数必须接收显式 env 对象，便于无全局状态测试。无效数字使用安全默认值；Provider 配置不完整或 URL 非 HTTP(S) 时工厂返回 `UnavailableAiProvider`，启动本身不崩溃。

## TDD seams（已确认）

1. **Provider 端口 seam** — `OpenAiCompatibleAiProvider.stream()`：
   - 向本地 Chat Completions stub 发送原 `AiPrompt.messages`；
   - 接受纯 JSON / fenced JSON，返回结构化 `unknown`；
   - 只把 `publicNarrative` 作为 preview delta；
   - provider/model 身份正确；
   - 上游错误不泄漏 API Key。
2. **配置 seam** — `parseAiProviderEnv(env)`：
   - 完整 OpenAI-compatible 配置与 runtime 参数正确解析；
   - 缺省、非法 kind、非法数字安全回落。
3. **组合工厂 seam** — `createAiProviderFromConfig()` / `createConfiguredAiProvider(env)`：
   - 仅完整合法的 OpenAI-compatible 配置生成真实适配器；
   - incomplete/mock/scripted/unavailable/非法 URL 一律生成 `UnavailableAiProvider`；
   - 永不生成 Mock，也不导入 legacy `createAiProviderFromConfig()`（该 legacy 工厂会为非 OpenAI 配置返回 Mock）。
   - `createConfiguredAiProvider(env)` 是唯一无副作用的 env → parse → factory 入口，`index.ts` 只调用它。
4. **AI runtime seam** — `AiResolutionService`：
   - 真实适配器经本地 HTTP stub 返回合法 JSON 后，完整 formal apply 成功，run 记录 `provider === 'openai-compatible'` 与真实 model，并生成 entry / 自动存档 / 下一回合；
   - provider 失败仍归类 `AI_PROVIDER_FAILED`，持久化错误不含 API Key。
5. **生产 composition seam** — 将入口组合抽成无副作用 helper（如 `createConfiguredAiProvider(config)`）供测试证明 `index.ts` 使用 env 配置结果；不得通过导入会立即监听端口的 `index.ts` 来测试。

## Files

### Create

- `server/src/modules/ai-runtime/OpenAiCompatibleAiProvider.ts`
- `server/src/modules/ai-runtime/createAiProvider.ts`
- `server/src/modules/ai-runtime/open-ai-compatible-provider.test.ts`
- `server/src/modules/ai-runtime/create-ai-provider.test.ts`
- `server/src/tests/config.test.ts`
- `server/src/tests/open-ai-compatible-resolution.test.ts`
- `.env.example`（需同步调整 `.gitignore`，只例外允许该文件）

### Modify

- `server/src/modules/ai-runtime/AiProviderPort.ts`
- `server/src/modules/ai-runtime/UnavailableAiProvider.ts`（`model = 'unavailable'`）
- `server/src/modules/ai-runtime/ScriptedAiProvider.ts`（`model = 'scripted'`）
- `server/src/modules/ai-runtime/AiResolutionService.ts`
- `server/src/services/aiProvider.ts`（仅放宽 message role 类型；HTTP 行为不重写）
- `server/src/config.ts`
- `server/src/index.ts`
- `.gitignore`
- `docs/superpowers/plans/2026-08-02-dnd-ai-dm-rearchitecture-revised.md`：只在“阶段总览/依赖关系”后登记本启动桥接计划链接，并注明它不替代 Phase 5 的 `010`/加密凭证范围；不得重写已有 Phase 3/4 完成记录。

## Vertical TDD order

### Slice 1 — Provider identity fidelity

1. 在现有 AI resolution 测试增加断言：run 的 `model` 来自 Provider 的 `model`，而不是 `name`。
2. 测试先红。
3. 给 `AiProviderPort` 增加 `readonly model`；同步 `ScriptedAiProvider.model = 'scripted'` / `UnavailableAiProvider.model = 'unavailable'`；`AiResolutionService.claim()` 写 `this.provider.model`。
4. 跑 targeted test 变绿。

### Slice 2 — OpenAI-compatible port adapter

1. 使用本地 HTTP stub 写 adapter tests：请求消息、provider/model 身份、纯 JSON、fenced JSON、安全 preview、错误脱敏；无法解码时断言抛错不包含原始响应正文或 API Key。
2. 测试先红。
3. 实现 `OpenAiCompatibleAiProvider`，复用 `requestOpenAiCompatibleMessage()`；只做传输协议解码，不调用 legacy `parseTurnResultFromProviderText()`。
4. 跑 targeted test 变绿。

### Slice 3 — Env parsing and safe factory

1. 写 `server/src/tests/config.test.ts` 与 `create-ai-provider.test.ts`。
2. 测试先红。
3. 实现纯 `parseAiProviderEnv(env)`、runtime settings 解析及安全工厂；在同一模块导出 `createConfiguredAiProvider(env)`，内部执行 env parse + safe factory。新工厂不得导入 legacy `services/aiProvider.ts` 中会返回 `MockAiProvider` 的 `createAiProviderFromConfig()`。
4. 跑 targeted tests 变绿。

### Slice 4 — Production composition and formal-apply vertical

1. 写本地 HTTP stub + 内存 SQLite 的 AI resolution 垂直测试；断言 succeeded、真实 model、narrative entry、automatic archive、next turn。
2. 测试先红。
3. 只在 `index.ts` composition root 调用 `createConfiguredAiProvider(process.env)` 并注入结果；保持 `createApp` default 与 `startPlatformServer` 不变。若用户显式选择 `openai-compatible` 但配置不完整，可输出一行不含任何配置值/密钥的 warning，说明已安全回落 unavailable。
4. 增加 `.env.example`（空 key 占位）并为其添加 `.gitignore` 精确例外。
5. 跑 vertical test 变绿。

## 执行与提交约束

- 当前用户明确要求继续实现，但未授权 commit；因此本切片覆盖路线图模板中的 commit 步骤：**不运行 `git add`、不 commit、不 push**。
- 现有工作树包含用户/先前切片的未提交改动；只编辑本计划列出的文件，不回退、不覆盖无关改动。
- 一次只有一个 mutation worker；reviewer 保持只读。

## Non-goals / Phase 5 ownership

本切片明确**不做**：

- `010_rules_providers.sql`；
- `platform_provider_credentials`；
- AES-256-GCM、加密密钥轮换或任何凭证落库；
- Provider 配置 HTTP API、脱敏 DTO 或前端设置页面；
- `PROVIDER_NOT_CONFIGURED` / `INVALID_RULE_SOURCE` 新错误码；
- 从 legacy `global_config.ai_provider_config_json` 读取平台 Provider；
- 修改 legacy `adminConfigRoutes.ts` / `AdminPage.tsx` 的明文配置路径；
- response format、tool calls/function calling；
- 真 token streaming（本切片仍使用 `stream:false`，成功后至多发一个公开叙事 delta）；
- 初始战役世界生成、Owner approve/reject/regenerate/pause/undo 等监督动作；
- 客户端改动、浏览器场景改动、数据库文件改动。

这些仍由 Phase 5 或后续产品修正切片负责。Phase 5 的真实加密与 per-campaign credential 将来只需替换 composition/config source，继续复用本适配器。

## Verification gates

```bash
npx vitest run server/src/modules/ai-runtime/open-ai-compatible-provider.test.ts server/src/modules/ai-runtime/create-ai-provider.test.ts server/src/tests/config.test.ts server/src/tests/open-ai-compatible-resolution.test.ts
npm run typecheck --workspace server
npm test -- --maxWorkers=1 --no-file-parallelism
npm run build
git diff --check
git diff --cached --name-only
```

期望：

- targeted tests 全绿；
- 全量串行套件全绿（PostgreSQL 因 `POSTGRES_TEST_URL` 未配置的既有 skip 可保留）；
- typecheck/build 全绿；
- staged files 为空；
- 不访问真实上游、不修改 `server/dnd.sqlite` 或仓库根 `dnd.sqlite`。

## Manual non-gating validation

用户提供真实 endpoint/key 后，在 **`server/.env`**（`npm --workspace server` 的工作目录是 `server/`，`dotenv/config` 从该 cwd 读取）中配置：

```dotenv
AI_PROVIDER=openai-compatible
AI_PROVIDER_BASE_URL=https://api.openai.com/v1
AI_PROVIDER_API_KEY=replace-me
AI_PROVIDER_MODEL=gpt-4o-mini
```

运行 `npm run dev`，完成一轮 owner resolve。只记录成功/错误码与 provider/model；任何日志、截图、文档都不得包含 key。无真实凭证时，本地 HTTP stub 是自动化验收的充分证据。
