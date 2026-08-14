# DND AI-DM v1 产品与架构决策

状态：✅ 已确认，作为 v1 新路线图的决策来源  
确认日期：2026-08-12  
对应路线图：[`2026-08-12-dnd-ai-dm-v1-hardening-cutover.md`](../plans/2026-08-12-dnd-ai-dm-v1-hardening-cutover.md)  
计划审查：[`2026-08-12-v1-hardening-cutover-plan-review.md`](../reviews/2026-08-12-v1-hardening-cutover-plan-review.md) — **PASS / 0 Blocker / 0 Major**  
问题来源：

- [`2026-08-12-rearchitecture-roadmap-review.md`](../reviews/2026-08-12-rearchitecture-roadmap-review.md)
- [`2026-08-12-completed-architecture-review.md`](../reviews/2026-08-12-completed-architecture-review.md)

本文冻结 v1 的产品边界和关键架构语义。后续详细计划与实现不得自行改变这些决定；如需改变，必须先更新本文和权威路线图并重新审查。

## 1. 产品与部署模型

### 1.1 私有受邀部署

- v1 面向私有服务器，不面向任意用户自由注册的公开多租户服务。
- 只有持有平台注册邀请码的用户才能注册。
- 所有被允许创建战役并成为 Campaign Owner 的用户均视为受信任管理员。
- Campaign Owner 可配置任意 HTTP(S) Provider 目标，包括 loopback、LAN、保留地址和代理 fake-IP。
- 不恢复 Provider URL 的公网 IP/DNS 限制。
- 仍必须禁止 URL credentials、禁止非 HTTP(S) 协议，并保持 Provider transport 不跟随重定向。

### 1.2 SQLite-only v1

- SQLite 是 v1 唯一正式支持的生产数据库。
- v1 只支持单实例进程访问生产 SQLite。
- 不保留 PostgreSQL adapter 或实验测试通道；如未来确有部署需求，再基于当时约束重新设计。
- 当前文档与 README 不得把 PostgreSQL 描述为受支持后端；历史计划/验证记录仅作为当时事实保留。

### 1.3 同源生产部署

- Express 直接托管 `client/dist`。
- SPA、HTTP API、Cookie、CSRF 和 SSE 保持同源。
- 最终浏览器验收必须使用真实生产构建产物，不以 Vite dev proxy 作为发布证据。
- 生产只允许 direct TLS，或只接受配置中精确 IP/CIDR 的可信反向代理 TLS 终止；忽略非可信来源的 `Forwarded`/`X-Forwarded-*`，`trust proxy` 不得使用布尔 `true`。
- CSP 最低值固定为 `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`，其中 `frame-ancestors` 必须是 CSP directive。
- 固定 `Referrer-Policy: no-referrer`、`Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()`、`X-Content-Type-Options: nosniff`；HTTPS 使用 `Strict-Transport-Security: max-age=31536000`，只有部署者确认控制所有子域时才允许 `includeSubDomains`。
- 静态托管拒绝 dotfiles、目录列表、生产 source maps 和构建清单之外的文件；构建产物必须扫描并证明不含 bootstrap secret、credential key、Provider API Key 或 server-only 环境变量。

## 2. Legacy 与 cutover

### 2.1 不迁移旧业务数据

- 现有 legacy room、player、character、turn、log、combat、rule content 和全局 Provider 配置均无须迁移到新平台。
- 取消 legacy adapter、旧身份认领、双读、shadow mapping 和新旧数据合并。
- 不编写 legacy adapter 详细计划。

### 2.2 先删除运行时，后删除旧表

- 第一实施阶段删除 legacy UI、legacy HTTP/SSE 入口及其生产运行依赖。
- 第一阶段不得删除或修改 legacy 表；旧表保持不可访问、不可写入的 inert 状态。
- legacy 表只允许在最终维护窗口中，通过显式 cutover CLI 删除。
- 普通启动迁移、MigrationRunner 和应用启动逻辑永远不得自动删除 legacy 表。

### 2.3 Forward-only cutover

- 最终切换采用维护窗口、完整备份、恢复演练和 forward-only 发布。
- cutover 后不支持重新启动旧应用处理新写入。
- legacy 表删除提交前可在同一事务中中止；删除后如发生重大数据损坏，只能保持维护模式并从已验证的数据库与凭证密钥备份整库恢复。
- 重新开放业务写入后，一般缺陷采用 forward-fix；整库恢复仅用于灾难恢复，并可能丢失 cutover 后数据。

## 3. 平台管理员与注册

### 3.1 首个平台管理员

- 新生产实例必须先通过本地初始化命令显式创建 SQLite、应用迁移、生成 database ID，并在允许的条件下创建 credential key；普通 server 不因数据库缺失而自动创建生产实例。初始化命令不创建管理员。
- 首次设置默认关闭。只有部署者显式启用一次性 bootstrap mode、配置满足最低熵要求的 secret、数据库实例 ID 与预期一致、管理员数量为零且数据库记录 `bootstrap_completed_at IS NULL` 时，Express 才提供首次设置页面。
- 生产数据库路径缺失、路径变化、实例 ID 不匹配或数据库无法读取时必须 fail closed；禁止静默创建空库后自动开放首次设置。
- 设置页面要求提交高熵 bootstrap secret、管理员登录名和密码。
- bootstrap secret contract 固定为无 padding 的 canonical base64url，解码后恰好 32 bytes（43 个 ASCII 字符）；拒绝空白、Unicode、多余 padding、等价编码和超长输入。比较前严格解码，并对固定 32-byte 值做 constant-time comparison。
- bootstrap secret 必须由 256-bit CSPRNG 在部署外部生成，来自部署配置，不由应用自动生成、不进入 URL/query、client bundle、命令行参数、数据库、日志、审计或 HTTP 响应。
- 首次设置必须经过精确 Origin 校验、严格限速和固定小体积 body parser。
- `platform_instance` 使用固定单例行保存不可逆 `bootstrap_completed_at`；数据库约束保证最多一个平台主管关系。
- 创建首个平台管理员、写入 `bootstrap_completed_at` 和安全审计必须在同一事务中完成；并发 bootstrap 只能一个成功。
- 创建成功后当前进程立即关闭首次设置接口与页面；后续即使仍配置 bootstrap secret 也不得再次创建管理员。
- 发布前必须关闭 bootstrap mode 并移除 secret；恢复数据库不会自动重新启用 bootstrap。
- 首次设置页面、请求和响应全部 `Cache-Control: no-store`；失败响应不区分 secret 错误、已关闭或已完成状态。
- 首次设置成功后不在响应中返回 session token；管理员通过正常登录进入系统。

### 3.2 平台管理员权限

- 平台管理员管理平台注册邀请码、账号状态、会话撤销、Platform Rules、运行状态和平台安全审计。
- 平台管理员不会自动成为任何战役成员。
- 平台管理员若不是战役成员，不能读取战役名称、角色、行动、世界事实、AI context/result、Provider 配置、archive 快照或其它战役内容。
- 平台管理员访问战役接口时继续遵守 `CampaignAuthContext` 和 `CAMPAIGN_NOT_FOUND` 存在性隐藏。
- v1 永远只有首次设置创建的一个平台管理员，不提供通过 WebUI、HTTP API 或注册邀请码提升第二个管理员的能力。
- 唯一平台管理员不得被停用、删除或降级；普通账号管理功能必须显式拒绝以该管理员为目标的操作。
- 唯一平台管理员忘记密码时，必须停止服务器并通过本地恢复 CLI 重设该账号密码；恢复命令不能创建第二个管理员或改变战役权限。
- 管理员密码恢复要求数据库中恰有一个平台管理员、显式数据库绝对路径、数据库实例 ID、独占锁和关闭回显的交互式密码输入。
- 密码恢复在同一事务更新密码摘要、递增账号 `auth_revision`、撤销该管理员全部 session，并写入不含密码的安全审计；重启后所有旧 Cookie 与 SSE reconnect 必须失败。

### 3.3 平台注册邀请码

- 平台管理员通过 WebUI 创建平台注册邀请码。
- 邀请码使用 CSPRNG 生成，数据库只保存摘要。
- 明文邀请码仅在创建成功响应中出现一次。
- 每个邀请码只能使用一次，默认有效期为 7 天，可在使用前撤销。
- 用户创建、邀请码消费和安全审计必须在同一事务中完成。
- 无效、过期、撤销、已消费和不存在的邀请统一返回同一外部错误，避免状态探测。
- 平台注册邀请码与 Campaign join 邀请码使用不同 contract、表、路由和错误语义。

## 4. Session 与 HTTP 安全

### 4.1 Cookie-only session

- 浏览器 session 原始 token 只进入 `HttpOnly` Cookie。
- 登录响应不得返回 `sessionId` 或其它 bearer token。
- 数据库只保存 session token digest，不保存原始 token。
- 浏览器 API 不再接受 `Authorization: Bearer` 作为 session fallback。
- 安全 session 上线时，现有原始 token session 全部失效，用户重新登录。
- Session schema 切换必须在应用开始监听前完成；旧 session 行全部删除或重建为不可用状态，不允许明文与摘要双路径长期共存。
- 切换完成后执行受控 SQLite WAL checkpoint 和离线清理步骤，避免已失效原始 token 长期残留在当前生产数据库自由页或 WAL；切换前备份仍按敏感材料保存。
- 现有数据库若仍有原始 token session，普通 server startup 必须拒绝自动跨越安全切换；部署者使用持有独占锁的专用 security-cutover CLI 执行：敏感备份 → 013 → 删除旧 session → checkpoint/离线清理 → 旧 token 失效验证。
- 013 只新增 digest、撤销和 auth revision 所需字段/索引，不删除旧行；security-cutover 只允许应用冻结的 012-014 allowlist，待 014 可写审计后，在单一事务中删除全部旧 session、记录 cutover 审计并写入 `session_security_cutover_at`。
- 全新数据库或没有旧 session 行的数据库可以通过正常迁移进入 digest-only schema。
- Session Cookie 固定使用 `__Host-dnd_session`、`Secure`、`HttpOnly`、`SameSite=Lax`、`Path=/`、不设置 `Domain`；绝对有效期 7 天、空闲有效期 12 小时，并纳入浏览器测试。
- 登录、密码修改/恢复和 `auth_revision` 变化时轮换 session token；注销必须使用完全相同的 Cookie 属性清除。

### 4.2 多设备与撤销

- 允许同一账号拥有多个设备会话。
- 用户可注销当前会话和全部会话。
- 平台管理员可撤销指定账号的会话。
- 注销、撤销、账号停用或 session 过期后，相关 SSE 连接必须立即关闭；后续重连必须失败。
- SSE 在发送响应头前绑定内部 session ID、user ID 和 auth revision；撤销事务提交后推进 revoke epoch、关闭匹配连接并丢弃未发送 live/replay 队列。
- 每次 replay/live dispatch 都重新确认连接 epoch 仍有效；撤销后的 reconnect 必须重新读取权威 session/account 状态，不依赖旧缓存。

### 4.3 Web 安全基线

- 所有状态修改请求必须通过精确 Origin 和 CSRF 校验。
- 认证请求使用与 session 绑定的高熵 synchronizer CSRF token，并随 session 轮换；bootstrap、注册和登录使用短期 pre-auth CSRF nonce，不因尚无 session 而豁免。
- Origin 缺失、`null`、端口不匹配或来自未信任代理的信息均拒绝；Origin/CSRF 检查必须先于 endpoint body parse。
- 生产同源模式不使用通配 CORS；开发模式也只能使用显式 allowlist。
- 授权顺序固定为：基础请求检查 → session → campaign/platform role → endpoint body parser → Zod → application service。
- 移除全局 `10mb` JSON parser；不同端点使用明确的小体积预算。
- bootstrap、注册、登录、邀请码尝试、Provider test、AI resolve/retry 和 SSE reconnect 必须限速。
- 外部输入和敏感输出 DTO 使用 strict contract；服务端不能依赖客户端 Zod strip 隐藏错误返回字段。

## 5. AI 生命周期与并发

### 5.1 单实例恢复模型

- v1 不实现多节点 lease ownership、heartbeat 或跨进程接管。
- Provider 调用必须具有有界 timeout 和可取消能力。
- 服务器在开始监听 HTTP 前扫描所有未 superseded `running` AI run。
- 重启发现的残留 run 自动标记为中断失败，对应 turn 转为 `needs_owner_attention`，发布脱敏失败事件并写安全审计。
- 系统不自动重试 Provider；Owner 使用新的 attempt 和 idempotency key 手动重试。
- 失败 run 永不复活或覆盖。

### 5.2 Campaign revision

- 所有会改变 AI context 或 gameplay archive 的写入必须通过统一 Campaign mutation seam。
- 每个成功 mutation 在同一事务中递增 `campaign.state_revision`。
- AI claim 保存 `claimed_revision`。
- Archive capture、Campaign Rules 变更和 Campaign Provider 变更都属于 campaign mutation；Provider/Rules 变更在 resolving 期间拒绝并递增 campaign revision。
- Platform Rules 变更递增 `platform_instance.platform_rules_revision`；AI claim 同时保存该全局 revision，formal apply 同时比较 campaign 与 platform rules revision。
- formal apply 在任何正式角色、世界、战斗、entry、archive 或下一回合写入前比较 revision。
- revision 不一致时不写任何正式状态，run 失败，turn 进入 `needs_owner_attention`。

### 5.3 Resolving 写入围栏

- AI resolving 期间，所有外部 Owner/Player 上下文写入均拒绝。
- AI formal apply 可通过明确的内部 mutation source 写入，但必须同时满足：run 有效、turn 为 resolving、maintenance 未启用、revision 未变化。
- archive restore 不得绕过 running/resolving 检查。
- 不允许通过裸 repository 创建隐式 bypass。

### 5.4 AI 角色和战斗命令

- AI 不再使用通用角色字段 patch 作为正式写入口。
- 角色状态改为伤害、治疗、状态、物品、金币、经验等明确领域命令。
- 命令只允许作用于当前战役中 approved 且进入 AI context 的角色，并集中执行数值、文本和集合预算。
- 战斗攻击、豁免和伤害的最终骰点只由服务端 RNG 产生。
- 正式 dice entries 必须由服务端战斗命令结果生成，AI 不得自报权威 `total`。

### 5.5 Buffered preview

- 真正安全的上游 token streaming 延后到 v1 之后。
- v1 Provider 使用完整响应模式；结构化结果完整解析后，可以一次发布已经确认是 public narrative 的缓冲预览。
- UI、contract、日志和文档统一使用“缓冲预览”或 `buffered preview`，不得宣称 token streaming。
- 平台 SSE live/replay 仍然保留；延期的只是上游 Provider token streaming。

## 6. 世界、战斗与 Owner 权限

- 普通 Owner 世界页和战斗页保持只读监督。
- 删除 Owner 世界 create/update/delete HTTP 端点。
- 删除 Owner 创建遭遇和执行战斗命令 HTTP 端点。
- 世界与战斗写入只允许经 AI formal apply 的内部 command ports 执行。
- 删除外部 HTTP surface 前，必须先冻结并验证 AI 内部世界、遭遇和战斗命令 seam。

## 7. Archive 语义

### 7.1 Gameplay-only

Archive 只恢复：

- 角色 gameplay state；
- 世界事实；
- 回合、行动与 requirement；
- 遭遇与战斗员；
- 为 gameplay 时间线服务的 supersede 状态。

Archive 不恢复：

- users、platform administrators、sessions；
- campaign members 和任何邀请；
- Provider 配置、API Key 或凭证密钥；
- Platform/Campaign/User Rules 来源；
- 平台安全审计、maintenance 或 cutover 状态。

恢复前后继续使用当前 Provider 配置和当前 Rules 来源。

- Archive restore 不更新、删除或恢复既有安全审计；成功时只允许在正式恢复事务中追加一个 strict allowlisted success 事件，失败时在 gameplay 事务回滚后追加一个不含 gameplay 数据的 coarse failure 事件。

### 7.2 Active-only restore

- superseded archive 保留为 Owner 审计历史，但不可恢复。
- 只有 active、未 superseded 的 archive 可以进入 restore。
- 不实现时间线分支切换或“重新激活 superseded archive”。

### 7.3 快照完整性

- restore 前必须验证根和所有嵌套 campaignId、playerId、knownBy、targetPlayerId、encounterId、characterId 和 activeCombatantId。
- 快照引用的用户必须仍是目标战役合法成员；Archive 不自动恢复成员关系。
- 恢复写入始终使用目标 `campaignId`，不得信任快照内嵌 campaignId。
- 所有验证必须在 supersede 或任何写入之前完成；失败时不允许部分状态、outbox 或审计 gameplay 记录残留。

## 8. Rules 与 Provider

### 8.1 Rules scope

- v1 正式支持 Platform scope 和 Campaign scope。
- Platform Rules 仅平台管理员可登记和查看元数据。
- Campaign Rules 仅对应 Campaign Owner 可登记。
- User scope 延后；v1 HTTP 和 UI 不提供 user-scope 创建入口。
- Rules 继续保持不可变、metadata-only，不接收、保存或返回第三方规则正文。
- Archive restore 不改变当前 Rules 来源。

### 8.2 Provider

- Provider 继续保持 campaign-scoped、Owner-only 和动态切换。
- API Key 继续使用 AES-256-GCM，HTTP DTO 和浏览器缓存只见脱敏配置。
- WebUI 与环境变量入口必须共享同一 URL shape policy。
- 允许任意 HTTP(S) 网络目标；禁止 URL credentials；禁止重定向。
- Provider 主密钥轮换延后到 v1 之后。
- v1 必须把 SQLite 数据库和 credential key 作为同一个恢复单元备份并验证；任何一方缺失都视为备份不可恢复。
- 已初始化生产数据库存在 Provider 密文时，credential key 缺失、长度/格式错误或 fingerprint 与 `platform_instance` 不匹配，必须在 HTTP listener 前 fail closed；不得自动生成、替换、尝试其它 key 或丢弃旧密文继续启动。
- 只有显式初始化的全新数据库且不存在 Provider 密文时才允许生成新 key，并将 database ID 与 key fingerprint 原子绑定。
- Key 文件与备份副本使用最小权限 ACL；恢复只接受同一个 verified manifest 绑定的数据库与 key，并在启动前离线解密全部 Provider ciphertext。
- 012 只创建 `platform_instance` schema，不由静态 SQL 猜测外部 key。显式 enrollment CLI 负责现有数据库首次绑定：有密文时先用候选 key 离线解密全部 ciphertext；无密文且无 key 时允许该 CLI 生成新 key。
- Enrollment 使用可恢复两阶段状态：事务写入 `initializing` 的 database ID/fingerprint → 原子发布 key 文件 → 事务切换为 `ready`。任一步失败时 listener 拒绝启动，CLI 只能使用同 fingerprint 恢复完成或显式回滚初始化，普通 server 不自动信任当前 key。

## 9. 平台安全审计

v1 新增独立、append-only 的平台安全审计。最低覆盖：

- bootstrap 成功/失败；
- 注册邀请码创建、撤销、消费和拒绝；
- 账号创建、停用、唯一管理员保护和离线密码恢复；
- session 创建、注销、全部撤销、管理员撤销和过期；
- Provider 配置保存、删除和连接测试结果；
- AI 中断恢复和 Owner 手动重试；v1 不提供运行中 Provider 请求的 Owner 强制终止命令；
- archive restore 成功/失败；
- maintenance 进入/退出；
- backup 创建、验证和恢复演练；
- legacy drop dry-run、开始、完成和失败。

安全审计禁止包含：

- 密码、session token、CSRF token和任意邀请码明文；
- Provider API Key、密文、Authorization header 或完整上游响应；
- AI context/result/raw debug；
- archive snapshot；
- 角色、世界、行动和剧情正文。

平台管理员只能读取上述 metadata，不得通过审计接口跳过战役权限。

- 每种审计事件必须使用独立 strict metadata allowlist schema；audit writer 不接受任意对象、原始 exception、stack、request body、headers、完整 URL/query、SQLite 参数或上游响应。
- 错误只映射为稳定 coarse reason code；字符串和数组使用小预算。
- 审计写入失败不得把原始 payload 转储到普通日志；应用运行面不提供审计 update/delete。

## 10. 运维与发布

### 10.1 Maintenance mode

- 最终 cutover 前必须由持有 InstanceLock 的 server 内平台主管 API/UI 将持久化状态从 `active` 线性化切换为 `draining`，再在完成 drain 后切换为 `quiescent`。
- `draining` 先关闭所有新写 admission，再等待活动写事务、AI run/formal apply 和 Provider 调用完成或取消；所有写入在取得事务/协调锁后、提交前再次校验 maintenance epoch。
- Drain 超时不得进入 `quiescent`，不得继续 backup/drop，并返回仍活动的脱敏 operation ID。
- `quiescent` 下只允许显式列出的 health、静态维护页、登录/me 和平台主管 maintenance status/off。Login 创建 session、固定 schema 安全审计以及 maintenance off 的状态/epoch 更新是唯一 allowlisted operational writes；它们不能开放 SSE 或其它 session 管理。注册和全部业务 mutation 禁止。
- Backup verification、restore rehearsal 和 drop plan 的详细结果不写回生产数据库，而是保存为 hash-bound immutable 外部 artifact；生产数据库只允许通过 014 追加对应 coarse 安全审计。
- 达到 `quiescent` 后停止 server，由本地离线 CLI 获取独占 SQLite 锁执行 backup/restore/drop；离线 CLI 不负责 `maintenance-on/off`。
- Maintenance smoke 后，由重新启动且仍持锁的 server 内平台主管 API/UI 从 `quiescent` 切回 `active`。
- SQLite 单实例锁和迁移 artifact 完整性校验必须在执行 012 及后续迁移前已经完成，不能等到最终 cutover 阶段才补充。

### 10.2 备份与恢复

- 备份至少包含 SQLite 一致性快照、credential key 备份和带 SHA-256 的 manifest。
- manifest 记录数据库实例 ID、版本、迁移清单、schema/table inventory、行数、数据库 hash 和 credential key fingerprint，不记录敏感明文。
- Cutover 最终备份只允许在 maintenance `quiescent`、server 停止、database adapter 关闭且离线 CLI 持有独占锁时创建。
- 备份固定使用 SQLite 官方 backup API，或在受控 WAL checkpoint 并关闭数据库后复制完整文件集；禁止裸复制仍活动的单个 `.sqlite` 文件。
- 数据库、credential key 和 manifest 先写入新的临时目录，逐文件计算名称/大小/hash并落盘同步，最后以原子 rename 发布；中断目录不能通过 verify。
- 临时目录与最终发布目录必须位于同一文件系统；禁止把跨文件系统 copy fallback 视为原子发布。
- 发布前必须使用实际备份副本在空的隔离绝对路径完成恢复演练：SQLite integrity/FK、平台启动 smoke、所有已保存 Provider 密文离线解密验证；不得调用真实 Provider。
- 恢复演练生成 immutable verification record，绑定 manifest hash、database ID、迁移/schema、integrity/FK、smoke 和 credential decrypt 结果。
- 命令前置条件严格分层：`backup create` 不要求既有 rehearsal；`backup verify` 验证 manifest/文件/hash/ID/key；`backup rehearse` 只接受已 verify 备份；`legacy-drop-plan/drop` 才要求绑定当前 pre-drop manifest 的未过期 verified rehearsal。

### 10.3 显式 legacy drop CLI

- 默认只 dry-run。
- 固定 allowlist，禁止名称模式批量删除。
- 强制验证 maintenance、独占锁、database ID、绝对路径、已验证 manifest、近期恢复演练和显式确认短语。
- legacy drop 不是 SQL migration，不提供通用 `--force` 或 `--yes`。
- Dry-run 生成不可变 plan artifact，包含 canonical database path、database ID、verified manifest ID、数据库/schema fingerprint、精确表名、每表 DDL hash/行数和全部 FK/trigger/view 依赖。
- Plan 的失效判断绑定 database ID、冻结 migration/schema hash、目标 legacy 表 DDL/行数/依赖和受保护平台表 schema；允许 014 append-only 安全审计新增行，不绑定整个数据库物理文件 hash，因此记录 plan 审计不会使 plan 自我失效。
- 实际 drop 只接受该 plan artifact；任一数据库、schema、路径或依赖变化都要求重新 dry-run 和人工复核。
- 确认短语包含 database ID、plan hash 和表数量；拒绝 unknown table、意外依赖、symlink、路径重叠和错误数据库。
- 所有 DROP、schema allowlist、FK 检查和可事务化完整性检查在同一事务提交前完成；失败整体回滚。
- 恢复演练记录必须在冻结时限内，且绑定当前 pre-drop verified manifest。
- drop 后必须执行完整 integrity/FK/schema allowlist、生产 smoke 和新的备份。

### 10.4 发布定义

- Chromium 是 v1 唯一浏览器阻断门；Firefox/WebKit 延后。
- 最终浏览器流程使用真实生产构建、Express 静态托管和磁盘临时 SQLite。
- 安全硬化、AI 恢复、revision、archive/combat 一致性、生产 SPA、备份恢复、maintenance、cutover dry-run 和 legacy 删除全部是 v1 发布阻断项。

## 11. 明确延期与取消

### 延期到 v1 之后

- PostgreSQL 正式生产支持；
- 真正安全的 Provider token streaming；
- Provider 主密钥轮换；
- User Rules scope；
- 多实例部署与横向扩容；
- Firefox/WebKit 发布阻断；
- 平台管理员紧急读取战役内容机制；
- 旧版本理解新写入的完整应用回滚。

### 明确取消

- legacy adapter；
- legacy 身份认领和旧数据迁移；
- legacy/platform 双读与 shadow mapping；
- 自动 drop legacy 表 migration；
- Owner 世界/战斗 HTTP 写端点；
- 恢复 Provider 公网 IP/DNS 限制。
