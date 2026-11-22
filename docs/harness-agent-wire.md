# Agent Host wire v1（P0/P1 实现合同）

UTF-8 JSONL，每条不超过2 MiB，stdout只输出协议，stderr只输出安全错误code（无正文/路径/密钥）。父进程控制实际模型、工具和持久回执；Node只执行Pi循环与标准MCP bridge。一个Node进程串行执行run；可以cancel当前executionId。无HTTP监听、无外部模型网络、无环境凭证继承。

## Parent → Node
`{type:"run", protocol:1, executionId:string, systemPrompt:string, turns:string[], tools:[{name:string,description:string,inputSchema:object}], limits:{maxModelCalls:integer,maxToolCalls:integer,maxOutputCharacters:integer,maxContextBytes:integer,providerDefaultOutput?:boolean}}`

- executionId用于当前进程内关联，不是幂等依据。turns按顺序包含已登记的原输入/接续文本（通常是服务器序列化的数据JSON）。一次执行从turn0重建，旧段的模型/工具结果由父回调以相同槽位重放。
- tools纯schema；name只允许ASCII字母数字下划线；无任何默认coding工具。模型身份固定虚拟`dicerealm-bridge/host-model`，不是付费模型id，真正选择在父进程。
- limits应用于整条run（跨turns累计），达到上限以明确error终止。每个turn的model/tool sequence分别从0起。
`{type:"reply", executionId, id:string, result:object}` 或 `{type:"reply",executionId,id,error:{code:string}}`
`{type:"cancel",executionId}`
`{type:"shutdown"}`

契约5..44使用`contextPolicy:"parent-compact-v1"`，新45使用`"parent-history-v2"`，更早run省略。两种已知策略允许原始模型callback最多1536KiB送父进程；2MiB帧与工具callback边界不变。新45超过callback传输界限报`limit_transport_bytes`，父端映射`harness_transport_limit`，不裁原始结果；旧策略仍报原context错误。真实模型窗口与HTTP传输限制由父供应商适配器拥有，新45不沿用旧128KiB正文限制。未知/null policy拒绝，Node不得自行启用SDK压缩、token估算或模型调用。桥的虚拟模型容量不是实际供应商预算。详细规划与旧回执语义见[历史上下文](harness-long-memory.md)。

## Node → Parent
启动只发一次 `{type:"ready",protocol:1,runtime:"pi",version:"0.87.1"}`。

模型调用：
`{type:"request",executionId,id:"<turn>:model:<sequence>",kind:"model",turn:int,sequence:int,payload:{system:string,messages:[ChatMessage],tools:[ToolDescriptor],maxTokens:int}}`

ChatMessage闭集：
- `{role:"user",content:string}`
- `{role:"assistant",content:string,toolCalls:[{id,name,arguments:object}]}`（toolCalls可为空）
- `{role:"tool",content:string,toolCallId:string,name:string,isError:boolean}`
系统消息不重复进messages，使用pi-ai当前transcript helper读取最终有效system/tools。去掉timestamps、usage、cache等运行噪声以便相同run重建时请求字节语义稳定。保留原文字节与工具顺序。model payload tools采用ToolDescriptor形态（inputSchema不是parameters）。`providerDefaultOutput:true`（新run）时maxTokens为0，表示不设输出上限、由供应商默认；省略（旧run）时取min(4096,本机桥模型maxTokens)以保持精确回放。不得为重试隐式增额度。

父返回ModelReply：
`{text:string,toolCalls:[{id:string,name:string,arguments:object}],inputTokens:int,outputTokens:int}`
Node转换为真正Pi AssistantMessage事件流（完整start/text/toolcall/done终态），无需原始chain-of-thought。空text有工具合法，无文本无工具也由父/Node明确拒绝。调用onPayload/onResponse如有，禁掉agent/provider自动retry、compaction与cache warming，禁止model catalogs网络/全局资源发现。apiKey仅可用固定非秘密bridge值或native no-auth Provider，绝不可读取开发者auth。

工具调用：
`{type:"request",executionId,id:"<turn>:tool:<sequence>",kind:"tool",turn:int,sequence:int,payload:{name:string,arguments:object,toolCallId:string}}`
实际经MCP SDK Client/Server（InMemoryTransport pair）listTools/callTool往返。MCP服务实现调用父回调，schema由run.tools给出。不直接在SDK execute里跳过MCP执行。父返回ToolReply：`{content:string,isError:boolean,stop:boolean}`。content是有界结果/错误JSON字符串；stop表示等待或必须终止，不再调用后续模型/工具。SDK执行设sequential；如果模型同批给多工具且首个返回stop，后续同批工具不得向父回调或执行，返回固定已停止结果并terminate；当stop=true时当前turn正常settled，后续turn（明确接续）可继续prompt。

完成：
`{type:"complete",executionId,stopped:boolean,text:string,modelCalls:int,toolCalls:int,transcript:object[]}`
- stopped是最后一个turn因工具stop停止；若旧turn stop且后面有接续，则继续后面的turn。
- text仅最后turn最终assistant纯文本（暂停时可为空），transcript为Pi原生session header+entries或entries（说明具体选哪种，父只当私有审计，不当恢复权限）。
- 必须等SDK的prompt结束/agent_settled，不能只等agent_end便回报。
- modelCalls/toolCalls为本次重建实际回调数（包含父回执重放），不能冒充实际付费次数。
失败：`{type:"error",executionId,code:string}`。无原始异常正文。协议无效、超过界限、取消、模型/工具错误需要可测试、明确的code。清理会话、MCP连接、事件订阅；stdin断开/父退出应结束进程，不能留下悬挂运行。

## stdout 字节分帧

.NET 的 `PiHarnessRuntime.BoundedLines` 直接读 `StandardOutput.BaseStream`：先按 LF 字节找帧，再对完整帧做严格 UTF-8 解码；LF 前的 CR 作为 JSON 尾部空白保留。单帧未含 LF 的累计 bytes 最大2MiB，超限立即 `harness_wire_limit`，无效 UTF-8 为 `harness_wire_invalid`，EOF 已收到未结束帧为 `harness_wire_partial`。没有半帧的进程退出仍 `harness_runtime_eof`，调用方取消保留原优先级；已开始的模型请求继续遵守未知结果规则。

不能用大 buffer 的 `StreamReader.ReadAsync(char[])` 猜测管道消息边界。UTF-8字符恰好在当前读取边界结束、换行下一次到达时，文本 reader 可能为后续解码继续等待；父子双方都等待下一帧可形成停滞。保留 byte buffer 中 LF 后的余量供下一帧/下一运行；正确处理单字节分片、同一 chunk 多行及多字节中文/emoji。回归 `HarnessWireTests` 使用真实 Node 按128/512/4096字符边界发送、连续运行及损坏帧，并断言损坏输入零 callback；历史召回真实Pi测试验证连续15次行动后不再停滞。协议版本、模型预算、重试和业务语义不因此改变。

## 实现出口
`agent-host/src/main.ts`编译到`agent-host/dist/main.js`，.NET启动该文件。package npm scripts `build`,`typecheck`,`test`；测试使用node:test，可用编译后JS。依赖固定@earendil-works/pi-coding-agent与pi-ai 0.87.1，MCP SDK1.30.1，typebox1.3.27；独立lockfile，不依赖全局npm包。Node>=22.19，当前24.11.1。

## 实现补充

`complete.transcript` 使用 Pi session entries、不带路径 header；.NET 恢复以自己的步骤回执为准，不持久使用此数组当权限依据。MCP 转发可调整 JSON 对象键顺序：schema和回放比较需规范化对象键，不能改变数组顺序、类型、字段值或原文。模型上限等Node错误由.NET闭集映射为安全错误，不原样公开任意子进程文本。
