# 输入、错误、安全与日志

## 信任边界

- 请求 JSON、导入剧本/提示词、模型输出、上传 PNG 分别在接收边界验证。检查类型、允许字段、长度/数量和引用归属；不要每层重复实现一套解析器。
- [DiceRealmHost](../../../server/DiceRealm.Server/Api/DiceRealmHost.cs) 拒绝未知 JSON 字段，常规请求有有界大小；[ContentEndpoints.Read](../../../server/DiceRealm.Server/Api/ContentEndpoints.cs) 为大文档提供明确上限。增加端点时不要全局放宽限制。
- 校验形状不等于授权：战役 token 经存储层确认，主持操作还需 `PartyEngine.RequireHost`，角色操作以已授权席位为准，不接受客户端自称 actor。
- 使用 `Authorization: Bearer`；不通过 URL、页面 hash、日志或前端资源传递 token。普通玩家投影不能包含完整剧本、私有地图提示词和参考列表。
- 默认只监听 loopback；已有工作台账户与登录限流，但没有完整公网部署及多副本保障，不能只改监听地址就声称可上线。账户与旧席位权限见[账户协议](../../../docs/workbench-accounts.md)。

## 错误契约

可预期的输入/状态/权限错误使用 `GameException(code, message, status)`，由 HTTP 边界映射为非 2xx 的 `{code,message}`；code 稳定且表达原因，中文 message 面向操作恢复。区分输入无效、状态冲突和权限不足，不统统改成 500。

```csharp
// PartyService.HostCommand：新请求不能绕过版本检查
if (c.Version != version)
    throw new GameException("stale_version", "状态已更新，请刷新后重新选择。", 409);
```

未知异常统一返回安全的 `server_error`，不把堆栈、路径、供应商响应或密钥传到客户端。流式输出已开始时中止连接，不追加一段错误 JSON 伪装成完整导出。恢复矩阵见 [跨端契约](../contracts.md)。

## 捕获与取消

- 只在能转换错误、执行清理或提供有定义的降级边界捕获异常。避免 `catch {}` 后返回空数据/成功。
- 文本供应商不可用可以转入裁定或明确的 fallback，不能伪造数值结果、偷偷切模型或默认剧本。
- 读取和排队可响应客户端取消；行动进入权威处理后用服务端有界超时，不能因断线丢弃已掷出的、即将提交的动作。保持现有保证，不声称可以恢复进程崩溃前尚未落盘的随机流。
- 用 `using`/`finally` 释放流、锁和临时资源；不通过重新执行整个用例来掩盖失败。

## 日志与业务审计

当前使用 `ILogger` 的命名参数结构化日志，代表性安全做法是记录错误类型而非异常原始消息。新日志按需要记录操作种类、内部关联 ID、失败 code 和耗时；不要记录完整请求/响应以获得「可观测性」。

- Information：值得追踪的生命周期变化，不记录每次快照轮询。
- Warning：可恢复的供应商不可用、明确兼容异常。
- Error：未预期的请求或持久化失败；记录足够定位的安全上下文。
- Debug：局部诊断，仍遵守脱敏，不将其当审计证据。

禁止日志内容：API key、bearer/邀请 token、连接文件、完整提示词/私有剧本、参考图字节、原始模型体。错误对象也可能携带这些内容，不直接序列化它。

主持裁定/调整需要持久业务事件中的原因、来源、作用对象和结果，不能用控制台日志代替事务内审计。代表性断言见 [PartyTests.cs](../../../tests/DiceRealm.Tests/PartyTests.cs)、[RulingTests.cs](../../../tests/DiceRealm.Tests/RulingTests.cs) 和 [WorkbenchTests.cs](../../../tests/DiceRealm.Tests/WorkbenchTests.cs)。


供应商失败形状诊断采用封闭类别：例如未知finish文本一律记`other`，只保留字段`JsonValueKind`、响应字节数、HTTP状态与异常类型名；不直接记录可由供应商控制的属性值/异常对象。header构造也属于外发前校验，禁止控制字符、空白和非ASCII key，避免零HTTP的配置错误占用unknown槽位。实现与隐私哨兵见[HarnessProviderTests](../../../tests/DiceRealm.Tests/HarnessProviderTests.cs)、[HarnessGeminiTests](../../../tests/DiceRealm.Tests/HarnessGeminiTests.cs)；完整错误矩阵归[运行指南](../../../docs/harness-runtime.md#模型拒绝与未知结果)。
