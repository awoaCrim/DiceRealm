# 本机 AI 配置与用量

## 1. 范围
工作台全局主/辅助文字模型及独立图片服务设置、运行时模型快照、供应商用量与新运行输出Token行为。用户已明确取消人工解锁、重复确认和应用额度；不要按旧任务记录恢复这些门槛。配置服务是唯一所有者，战役host token不代表全局权限。

## 2. 签名
`GET/POST /api/v1/operator/ai-settings`；`POST /api/v1/operator/ai-settings/test`；`GET /api/v1/operator/ai-settings/tests/{requestId}`。请求自动携带公开固定头`X-DiceRealm-Local-Settings: 1`，不是密码。前端`createOperatorApi({fetchImpl,accessToken}={})`冻结已登录管理员账户会话并携带Bearer；不使用战役token。保存字段和探测请求以`AiSettingsEdit`、`AiProbeRequest`为准；独立requestId、expectedVersion和原回执不变。

## 3. 合同
- `AiSettingsEdit.Image` 是可空独立 `AiImageEdit`，只配置 OpenAI-compatible Images 的完整生成/编辑 endpoint、model、enabled、key action、参考上传与 response_format；不套文字 provider 协议。保存不探测/不生图，实际地图队列才外发；工作台不为测试配置多生成一张图片。GET仅返回 `hasApiKey`。旧请求 Image=null 时省略序列化以保留指纹；旧存档无Image继续原ImageAi bootstrap，省略图片编辑保留原图片设置。`ConfiguredImages`在调用时捕获不可变快照，Claim之后供应商身份若改变，Generate在HTTP与预算前拒绝`image_provider_changed`，在途调用保持旧快照；缓存身份算法不变。
- 主模型与辅助模型均可选择`openai-chat`或`gemini`，以明确Provider选择决定协议，不按模型名猜测，也不强制辅助走OpenAI。Gemini使用Base URL + `/models/{model}:generateContent`、`x-goog-api-key`及`contents`；OpenAI使用`/chat/completions`、Bearer及`messages`，已有完整OpenAI Endpoint仍兼容。选择Gemini时清除完整Endpoint模式，地址由用户明确填写，不偷偷改代理前缀。
- `TextProviderProtocol`复用`HarnessProviderSettings`的地址/认证规则，统一辅助文本、内容准备与连通探测的请求格式和正文提取，不拥有重试或业务状态。Gemini结构化辅助请求用`systemInstruction`保留作者system各段原文、`responseMimeType=application/json`要求JSON；过滤thought分段，不将思考当正文，按Gemini usageMetadata记Token。实际准备仍按完整wire正文检查字节上限并严格解析proposal；切换Provider不改变已捕获的请求配置。
- 页面打开自动GET，直接编辑/保存，保存和连通测试各自点击即执行，不加解锁或二次确认。保存不外发；测试只测试已保存的配置，一次真实请求，未知结果不自动重发。`confirmProviderUse:true`由明确测试按钮携带，不要求额外弹窗。
- peer和Host必须本机，Origin存在时必须同源，加自动自定义头阻止跨站简单表单，并在服务端验证当前账户为admin；不开放跨源CORS。不生成或读取旧operator access-token文件。已有旧文件留在原处但不作为鉴权依据。
- 密钥仅服务端持久化，不回显。新请求冻结配置；已在途请求保持原快照；替换模型不强行续接不兼容旧运行。keep/replace/clear明确，GET不返回secret。冲突/未知保留原requestId与原正文；页内密钥不写浏览器持久存储。
- `ProviderBudget`默认全部-1不限额，`ProviderUsage.Unlimited=true`且`RemainingToday=-1`；0和正数只兼容显式旧配置。不限额仍持久记录尝试与供应商实际Token，不重置账本。新版统一Test入口显式传三项文字-1，避免继承旧日常的小额度。无已保存图片配置时仍默认关闭；包启动器不能因未传图片bootstrap开关而强制图片额度0，否则工作台显式启用后仍不可用。图片限额始终沿明确参数（默认-1），保存的enabled决定启用，显式0仍有效。
- 新`HarnessLimits.ProviderDefaultOutput=true`使宿主发送`MaxTokens=0`，OpenAI/Gemini仅在正值时分别写`max_tokens`/`maxOutputTokens`；辅助生成/测试同样不写输出上限。旧运行缺标记时沿用旧协议，保持精确回放。取消累计100000 Token续发拦截；供应商限制、上下文容量、运行防失控循环/超时及传输大小边界仍存在，不宣称无限上下文。

## 4. 校验与错误
远程peer/Host→403 `operator_local_only`；跨站Origin→403 `operator_origin`；无自动头→403 `operator_same_origin_required`。账户会话缺失/失效→401，普通账户→403。配置格式、版本冲突及原请求正文冲突仍按存储边界拒绝，错误不打印密钥。限额小于-1无效；不限额不能因剩余额度-1被错误拒绝。

## 5. 正常、兼容与拒绝
正常：本机打开设置→读取→编辑→直接保存，后续调用使用新配置。兼容：旧调用回执/用量账本/显式日常额度保留；旧运行按原Token字段重放。拒绝：远程战役主持修改服务器密钥、跨站提交、保存后自动发收费探测、切模型清零用量。

## 6. 验证
`AiSettingsTests.ImageSettingsAndFrozenCalls`覆盖图片bootstrap、文本保存不覆盖图片、密钥不回显、旧字段省略/回执、在途切配置不变、Claim后身份变化零外发、重启与clear；工作台图片卡保存/原正文重试不发probe。`AiSettingsTests.NativeHelperProtocolAcrossConsumers`覆盖Gemini helper实际探测/叙事/准备三路径的URI、认证头、contents、原prompt、JSON模式、thought过滤、无输出cap、用量及切回OpenAI后旧准备快照不变；工作台另断言辅助可选Gemini并持久发送真实选择。`AiSettingsTests`覆盖本机自动头、跨站拒绝、无新access-token文件、密钥不回显、CAS/回执、在途快照及OpenAI无输出cap；`ResourceTests.UnlimitedUsageRemainsDurable`超过旧上限并重建保持用量；`HarnessBudgetTests`覆盖累计Token超过旧阈值继续及幂等；`HarnessGeminiTests.TransportPartsAndPrivateMetadata`断言0时省略输出字段；agent-host测试覆盖新0/旧4096；工作台`ai-settings.test.js`覆盖自动读取、无确认和未知原请求恢复。浏览器须用新嵌入资源验证，不以磁盘JS代替；不调用真实供应商作自动回归。

## 7. 正误
错误：把固定自动头变成新密码，去掉UI确认但后端仍要求operator secret，或用`max_tokens:null`冒充省略。正确：已登录admin在本机同源自动访问、直接保存/测试；用量继续记录，新请求完全省略输出上限字段。
