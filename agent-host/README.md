# DiceRealm Agent Host

P0/P1 Harness 的**通用 Node 代理宿主**：在真实上游 Pi SDK 上跑多步工具循环，通过 JSONL 协议把**模型调用与工具调用全部交还父进程**（.NET 协调器）决定。

- 只包含通用 runtime 与 MCP 桥，**不含任何 D&D / 游戏逻辑**。
- 不读取开发者凭证、不访问模型目录网络、不做全局资源发现。
- 父进程是唯一权威：模型回复、工具结果、预算与持久回执都在父侧。

合同原文：[`../docs/harness-agent-wire.md`](../docs/harness-agent-wire.md)。`dist/main.js` 即 .NET 启动入口。

## 固定依赖

| 依赖 | 版本 |
|---|---|
| `@earendil-works/pi-coding-agent` | 0.87.1 |
| `@earendil-works/pi-ai` | 0.87.1 |
| `@modelcontextprotocol/sdk` | 1.30.1 |
| `typebox` | 1.3.27 |
| dev: `typescript` / `@types/node` | 5.9.3 / 24.13.6 |

独立 `package-lock.json`，不依赖全局 npm 包。Node ≥ 22.19（当前验证 24.11.1）。
安装（TLS 环境需逐条命令处理，不改全局配置）：

```bash
NODE_TLS_REJECT_UNAUTHORIZED=1 npm ci --ignore-scripts
```

## 构建与验证

```bash
npm run typecheck   # src + test 类型检查（tsc --noEmit）
npm run build       # src → dist/，入口 dist/main.js
npm test            # 先 build，再编译 test → dist-test/，node:test 跑全部用例
```

`npm test` 会真的 spawn `dist/main.js` 子进程并用 JSONL 驱动它，覆盖真实 Pi SDK + MCP 往返。

## 传输与帧

UTF-8 JSONL，单行 ≤ **2 MiB**（超出报 `line_too_large` 并丢弃该行后继续）。stdout 只出协议帧；stderr 只出安全 code（`agent-host: <code>`，无正文/路径/密钥）。进程启动只发一次：

```json
{"type":"ready","protocol":1,"runtime":"pi","version":"0.87.1"}
```

`ready` 在加载 Pi SDK 之前就写出（实测启动约 80 ms）；SDK 约 2.8 s 的 barrel 加载在后台预热，第一个 `run` 到达时等待完成。

### 父 → Node

```json
{"type":"run","protocol":1,"executionId":"...","systemPrompt":"...","turns":["..."],
 "tools":[{"name":"get_context","description":"...","inputSchema":{...}}],
 "limits":{"maxModelCalls":8,"maxToolCalls":8,"maxOutputCharacters":20000,"maxContextBytes":262144}}
{"type":"reply","executionId":"...","id":"0:model:0","result":{...}}
{"type":"reply","executionId":"...","id":"0:tool:0","error":{"code":"tool_denied"}}
{"type":"cancel","executionId":"..."}
{"type":"shutdown"}
```

- `tools[].name` 仅允许 `[A-Za-z0-9_]+`，不得重复；`inputSchema` 是原始 JSON Schema。
- `limits` 四项必填、非负整数，**整条 run 跨 turns 累计**。
- 一个进程同时只跑一条 run；重复提交报 `busy`。

### Node → 父

```json
{"type":"request","executionId":"...","id":"<turn>:model:<seq>","kind":"model","turn":0,"sequence":0,
 "payload":{"system":"...","messages":[...],"tools":[{"name":"...","description":"...","inputSchema":{...}}],"maxTokens":4096}}
{"type":"request","executionId":"...","id":"<turn>:tool:<seq>","kind":"tool","turn":0,"sequence":0,
 "payload":{"name":"get_context","arguments":{...},"toolCallId":"..."}}
{"type":"complete","executionId":"...","stopped":false,"text":"...","modelCalls":2,"toolCalls":1,"transcript":[...]}
{"type":"error","executionId":"...","code":"cancelled"}
```

`payload.messages` 是归一化 transcript（闭集 `user` / `assistant` / `tool`）：不含时间戳、usage、cache、thinking，保留原文字节与工具顺序，便于同一 run 重建时请求字节稳定。模型每次回调的 `maxTokens = min(4096, 桥模型 maxTokens)`。

`complete.transcript` 选用 **Pi 原生 session entries**（`SessionManager.getEntries()`，不含 header，避免把宿主路径写进游戏侧持久化）；它只是父侧私有审计，不作为恢复权限。父侧恢复依据始终是自己保存的 model/tool 回执按 `id` 槽位重放。

`ModelReply` = `{text,toolCalls:[{id,name,arguments}],inputTokens,outputTokens}`；`ToolReply` = `{content,isError,stop}`。`stop:true` 表示暂停/必须终止。

## 错误码

| code | 触发 |
|---|---|
| `invalid_frame` | 行不是合法 JSON 对象 |
| `line_too_large` | 单行 > 2 MiB（丢弃后继续读） |
| `unsupported_protocol` | `protocol` ≠ 1 |
| `invalid_run` | run 字段形状非法（turns/tools/limits/名字等） |
| `busy` | 已有 run 在跑 |
| `unknown_message_type` | 未知帧类型 |
| `invalid_reply` | reply 形状非法，或模型/工具回复不合法 |
| `unknown_reply` | reply 的 id 与当前 run 的挂起请求不匹配 |
| `unsupported_message_role` | transcript 出现闭集外的角色 |
| `system_prompt_mismatch` | 有效 system prompt ≠ run.systemPrompt（兜底保护） |
| `tool_declaration_mismatch` | 有效工具声明 ≠ run.tools（兜底保护） |
| `limit_model_calls` / `limit_tool_calls` / `limit_output_characters` / `limit_context_bytes` | 对应上限触顶 |
| `model_reply_empty` | 模型回复既无文本也无工具调用 |
| `model_reply_unknown_tool` | 模型调用了未声明的工具 |
| `model_request_failed` / `tool_request_failed` | 父回执 `error` 未带 code 时的兜底 |
| `cancelled` | 收到 `cancel`（或 shutdown/EOF 时静默取消） |
| `internal_error` | 未预期内部错误（stderr 同名 code） |

父回执里 `error.code` 会经白名单化（`[A-Za-z0-9_]{1,64}`）后原样回传，因此领域错误码（如 `tool_denied`）可直接被 .NET 消费。

## 关键实现点

- **有效 system prompt 逐字节等于预设**：`DefaultResourceLoader` 全部 `no*` 关闭发现 + 一个 inline 扩展在 `before_agent_start` 强制 `systemPrompt`，从而绕过 Pi 自动追加的 `<cwd>` 段；每次模型回调都用 pi-ai `getCurrentSystemPrompt` 复核，不等则 `system_prompt_mismatch` 终止而不是静默替换。
- **工具集只来自 run**：`tools: [...run 工具名]` 白名单既关掉内置 read/bash/edit/write，又启用 `customTools`；schema 原样注册，模型回调里的 `inputSchema` 与 `run.tools` 规范化对象键后逐字段比对；MCP可能重排键，不能因键序不同误拒绝合法声明。
- **MCP 是真往返**：真实 `Client` + `Server` + `InMemoryTransport.createLinkedPair()`；Pi 侧注册用的工具清单来自 `listTools()`，工具执行走 `callTool()`，返回文本取自 MCP 回包，`stop` 由服务端 handler 记录。
- **停止门**：`session.agent.toolExecution = "sequential"`，并链式包装 `beforeToolCall`；同批首个返回 `stop` 后，其余同批工具被 `{block:true, terminate:true}` 拦住，**不进 MCP、不回调父进程**，结果为固定文案，整批 terminate，当前 turn 正常 settle。
- **等真正 settle**：`prompt()` 之后仍显式 `waitForIdle()`，不只看 `agent_end`。
- **禁用自动化**：`compaction.enabled=false`、`retry.enabled=false`（含 provider retries）、`cacheWarming="off"`；`ModelRuntime.create({modelsPath:null, allowModelNetwork:false})` + `InMemoryCredentialStore`，桥 provider 使用无密钥 auth；`SessionManager.inMemory()`。
- **退出清理**：`shutdown` 或 stdin EOF 时关闭 stdout 写队列、取消当前 run、dispose session 与 MCP，然后 `exit 0`；EOF 后不再产帧。

## 与 .NET 集成的注意事项

1. **父必须按槽位回执**：`id` 形如 `<turn>:model:<seq>` / `<turn>:tool:<seq>`，每个 turn 序号从 0 重新开始，run 内累计预算。父重放旧回执时按同 id 返回即可重建同样的请求字节。
2. **`ready` 可作握手**，约 80 ms 到达；首个 run 会等 SDK 预热（约 2.8 s），超时应覆盖这一段。
3. **stdin 要写完整行**，单行 ≤ 2 MiB；帧本身没有长度前缀。
4. **env 由父侧清理**：宿主不读凭证，但父进程仍应按约定 scrub（测试用 `scrubbedEnv()` 模拟）。
5. **不要在同一进程并发提交 run**，会得到 `busy`；需要并行就多起进程。
6. `dist/` 与 `dist-test/` 是构建产物，入口固定 `agent-host/dist/main.js`。
