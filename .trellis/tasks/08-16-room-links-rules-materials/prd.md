# 剧情历史、DM 剧情展示与规则资料清理

## Goal

解决两个直接影响可玩性的剧情展示问题，并彻底删除当前没有实际产品用途的规则资料功能：

1. 玩家可以查看当前剧情以及之前各回合的历史剧情，而不是每次只看到最近一个回合。
2. DM/Owner 可以在自己的工作区看到已经生成的公开叙事、玩家私密结果和骰子结果，而不是只能看到 AI 调试 JSON。
3. 删除规则资料登记、SHA-256 内容哈希及其持久化、接口、页面和文档，避免保留一个不会参与 AI 或规则判定的误导性占位功能。

房间链接恢复暂不处理：玩家登录后可以从战役列表中看到此前加入的战役，本任务不新增邀请码恢复、链接轮换或重启后的重新分享流程。

## 已确认的代码事实

### 房间链接

- 房间对应 `campaign`。
- 创建时生成 128-bit 随机邀请码，数据库只保存邀请码的 SHA-256 摘要，原始邀请码不会落库。
- 玩家登录后可以通过战役列表进入已经加入的战役，因此重启后重新获取邀请链接不纳入本任务。

### 规则资料清理边界

- Owner 当前可以在 `client/src/features/owner/rules/OwnerRulesPage.tsx` 登记来源名、版本、许可证、署名、外部文件 SHA-256 和适用范围。
- 该功能由 `client/src/api/rules/`、`client/src/entities/rules/`、`server/src/routes/rulesRoutes.ts`、`server/src/modules/rules/`、规则相关 contracts 和 `platform_rule_sources` 表支撑。
- `platform_rule_sources` 只保存来源元数据，不保存规则正文；`RulesRepository.listEffective()` 聚合 platform、campaign、user scope。
- `AiContextBuilder` 没有读取规则来源，规则登记不会影响 AI 结算、游戏规则或判定。因此本任务删除整个规则资料功能，而不是继续解释或扩展 metadata-only 行为。
- 只删除规则资料的 `contentHash`/来源登记链路；邀请码校验、session token 摘要、数据库/迁移完整性校验等仍有实际安全或运维用途的 SHA-256 不得删除。
- 删除规则资料不应通过静默删除用户数据库或破坏其他业务表实现；维护的 schema/baseline、迁移和临时测试 fixture 必须同步清理，历史数据库兼容性遵循项目既定 reset boundary。

### 玩家剧情端

- AI 结算时服务端已经把公开叙事、玩家私密结果和骰子结果写入 `platform_turn_entries`。
- `GET /api/campaigns/:campaignId/ai/turns/:turnId/entries` 已支持按可见性投影：玩家可见 public 和自己的 `player_private`，Owner 可见全部。
- `PlayerStoryPage` 只根据最新回合选择一个 `turnId` 并请求一次 entries；当最新回合是等待行动状态时，最多回退到上一个回合。因此页面没有历史回合选择或历史剧情列表。
- 这不是每轮剧情被数据库覆盖，而是前端只展示一个回合；新回合查询替换了旧回合的展示。

### DM/Owner 剧情端

- `OwnerTurnPage` 当前显示最新回合状态、提交进度和玩家行动。
- Owner 页面没有调用 entries 查询，也没有可读的剧情组件。
- `OwnerAiRunPanel` 只展示 AI run 状态，并在展开后以原始 JSON 展示 `context`、`result`、`rawDebug`；这不是正常的剧情阅读界面。
- 服务端已有 Owner 全量 entries 投影和稳定的 entry 数据，因此主要缺口是 Owner 端的查询接入与展示，而不是重新设计剧情存储。

## 需求

### R1. 玩家端保留并展示历史剧情

- 剧情页必须展示当前回合可见剧情，并提供之前已完成回合的历史剧情。
- 每个历史回合至少显示回合编号、状态和该回合的可见 entries；玩家只能看到 public 和自己的 private update，不得看到其他玩家私密结果或 Owner-only 内容。
- 新回合开始、SSE 事件刷新或重新登录后，历史回合仍可展开查看；不能因为当前回合变化而从界面和查询状态中丢失旧剧情。
- 保持现有 entries 的顺序、可见性投影和未知 payload 安全降级。
- 存档恢复后继续尊重现有 superseded 语义：被恢复操作作废的剧情不应重新显示为当前有效剧情，除非另行定义历史分支查看功能。

### R2. DM/Owner 端展示正常剧情

- Owner 在回合工作区可以直接看到当前回合的公开叙事、玩家私密结果和骰子结果，按 entry 顺序以可读文本展示。
- Owner 可以查看已完成回合的历史剧情，至少不应因为进入下一回合而失去上一回合叙事。
- Owner 的剧情展示可以复用服务端的全量 entries 接口和客户端安全 entry renderer；AI 调试详情保留为辅助信息，不再作为唯一剧情展示入口。
- 不向 Player 暴露 Owner-only AI context、result、rawDebug 或其他玩家的私密内容。

### R3. 彻底删除规则资料功能

- 删除规则资料的 Owner 页面、Owner 导航项、路由、API client、React query、server route、service、repository、contracts、迁移表、索引、初始化/seed 调用、专用测试和文档说明。
- 从维护的 schema/baseline 中移除 `platform_rule_sources` 及其相关约束和索引；如果历史迁移文件仍被保留作归档，必须保证生产代码、构建、迁移清单和测试不再依赖它们，并遵循项目既定 reset boundary。
- 删除规则资料专用的 `contentHash` 字段、SHA-256 格式校验和“登记外部文件”的 UI 文案；不影响其他确有用途的 SHA-256 实现。
- 删除后 Owner/Player 工作区、AI context、Campaign 创建和正常启动流程不得再引用规则资料模块。
- 不以“隐藏页面但保留后端接口/表”的半删除方式收尾；代码搜索、类型检查、构建和相关测试应证明没有生产引用残留。

### R4. 保持既有安全与数据边界

- 保留邀请码只存摘要、战役成员权限和错误信息隐藏行为。
- 保留 `TurnEntryRepository.projectEntries()` 的 Owner/Player 可见性边界。
- 所有剧情历史、可见性和清理测试使用临时数据库或现有测试 fixture，不读取仓库根目录数据库。
- 不重写 AI 结算、可见性策略、Outbox 或实时事件协议；只在历史展示所需的查询失效行为上做最小调整。

### R5. 默认迁移已删除规则资料的现有数据库

- 普通 Server 启动默认识别当前本地数据库中唯一可确认的旧状态：维护中的完整迁移集合加 `011_rule_sources.sql`，并且存在原规则资料表。
- 迁移前必须使用 SQLite 一致性 backup 创建不可覆盖的恢复副本；如果本地 credential key 是普通文件，则把它与数据库一起备份，保持数据库/key 配对。
- 迁移必须在一个事务中只删除 `platform_rule_sources` 及精确的 `011_rule_sources.sql` tracking row，并在提交前完成完整性和外键检查；其它战役、用户、回合、存档和凭证数据不得改变。
- 备份失败、事务失败、表结构不符合预期或迁移集合无法精确识别时，必须拒绝继续监听，不得删除、替换或重建用户数据库。
- 迁移成功后继续现有启动安全门；已经是维护集合的数据库不重复备份或修改。

## 暂定不在范围内

- 房间重启后的邀请码恢复、链接轮换和重新分享流程。
- 规则正文上传、版权内容存储、全文检索、自动规则解析或完整规则引擎；未来如需这些能力另建任务。
- 存档恢复后的历史分支浏览器；本任务只保留现有 active/superseded 语义。
- 将 AI 调试 context/result/rawDebug 改造成玩家可见内容。
- 重新设计 turn entry 数据模型或改变现有玩家/Owner 可见性规则。

## 验收标准

- [x] 玩家剧情页可以打开当前回合和至少一个之前已完成回合，并看到各自的可见剧情内容。
- [x] 玩家新回合刷新后，上一回合剧情仍可从历史区域查看；其他玩家私密内容和 Owner-only 内容始终不可见。
- [x] Owner 回合工作区直接显示当前回合的公开叙事、私密结果和骰子结果，不需要展开 raw JSON 才能阅读剧情。
- [x] Owner 可以查看之前已完成回合的剧情，或通过明确的历史入口进入这些回合。
- [x] 前端测试覆盖：多回合列表、回合切换后历史保留、玩家可见性、Owner 全量展示、空内容和未知 payload 安全回退。
- [x] HTTP/服务测试覆盖：entries 按指定 turn 查询、Owner/Player 投影边界，以及历史回合不会被错误覆盖。
- [x] 规则资料页面、导航、路由、API、server module、contracts、表和专用迁移/测试被删除；生产代码搜索不到规则资料引用（仅保留受限 legacy cleanup bridge）。
- [x] 邀请码、session token、其他仍有用途的 SHA-256、AI 结算和存档 superseded 行为不回退。
- [x] 对当前旧数据库执行默认启动迁移后，规则资料表/011 tracking row 被移除，已有非规则数据和 credential key 不变，并保留可验证的迁移前备份。
- [x] 备份失败、事务失败和不明确的旧数据库状态均 fail closed，且不监听、不静默替换数据库。
- [x] `npm run typecheck`、`npm run build`、相关 client/server 测试和 `git diff --check` 通过。

## 阻塞性开放问题

无。剧情历史展示使用现有 entries 数据和可见性契约；规则资料按用户确认彻底删除。