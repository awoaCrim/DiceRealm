# 持久化、历史与兼容

## 当前机制

[CampaignStore](../../../server/DiceRealm.Server/Infrastructure/CampaignStore.cs) 使用 `Microsoft.Data.Sqlite`，每战役一个数据库：`state` 保存当前聚合 JSON（schema2将世界正文分离为world_entries权威行及同事务词项索引），`events(sequence)` 保存追加事件，`receipts(actor,request)` 保存席位级回执。没有 ORM，也没有「只用事件回放重建所有状态」的承诺。

[DataDirectory](../../../server/DiceRealm.Server/Infrastructure/JsonFiles.cs) 的排他目录锁只支持一个服务进程写入。进程内每战役 `SemaphoreSlim` 串行化加载、授权、判定和保存；SQLite 写事务仅覆盖最终短提交，不横跨模型 HTTP。不同战役可独立执行。

## 必须保持的保证

- 通过 `Access` 的授权上下文访问战役；API 不自己连接 SQLite，不在锁外保留可写聚合引用。
- 用参数绑定 SQL；路径和战役 ID 经所属边界验证，不拼接用户输入为 SQL 或任意文件路径。
- 状态、本次需要的事件和新回执在同一事务提交；事件序号与显式无事件版本合并必须连续覆盖本次版本推进，任一步失败不能留下半份确认结果。完整顺序见 [跨端契约](../contracts.md)。
- 不裁剪幂等回执来控制内存。按键索引查询旧回执；常规快照只加载有界尾部，历史通过索引分页。
- 不把存档的 JSON 序列化形状直接作为公开 API。投影显式过滤凭证、权限和私有内容。

代表性参数化读取：

```csharp
// CampaignStore.FindReceipt，必须在已授权聚合上下文内调用
cmd.CommandText = "SELECT json FROM receipts WHERE actor=$actor AND request=$request";
cmd.Parameters.AddWithValue("$actor", c.ActingActorId);
cmd.Parameters.AddWithValue("$request", requestId);
```

[JournalTests.cs](../../../tests/DiceRealm.Tests/JournalTests.cs) 覆盖长历史、旧回执、原子回滚及迁移拒绝；新增存储行为应断言数据库/重启结果，而不只检查返回对象。

## 无操作流水的状态提交

普通独立 `equip/loadout/wear/unpack` 与非战斗、无待结算的直接棋盘命令仅保存状态和回执。`Campaign.StateOnlyVersions` 是 `[JsonIgnore]` 的事务内版本列表；在实际成功且 `Version++` 后登记，不持久化另一套操作日志。自然语言行动、投掷、战斗、待裁定仍保留精确事件/执行步骤。

`CampaignStore.Save` 将新增事件序号与 `StateOnlyVersions` 合并校验从原版本+1到当前版本的完整覆盖；未声明缺口、重复/越界版本和乱序事件抛 `InvalidDataException` 并回滚，不能取消校验来支持无日志操作。回执仍与状态原子提交，原请求重放零写、不同payload冲突。没有新环境开关或数据库schema。

常规加载按 `ORDER BY sequence DESC LIMIT 100` 取最近100条真实事件再反转，不用 `Version-100` 代替事件数量。分页可读空尾，导出读尽即结束，不补造事件。旧棋盘历史字段只读兼容、公开投影恒为空；新操作不再保存前后快照或支持undo，详细字段见[共享棋盘](../../../docs/shared-board.md)。

正常例：连续105次自由移动后，当前位置/版本更新，先前剧情尾部仍在；兼容例：旧 `RecentOperations` 保持原值但不出现在投影中；拒绝例：只增加Version却没有事件或显式标记，整个提交失败。对应HTTP/SQLite/重启回归为 `SharedBoardBoundaryTests.StateOnlyCommandsAndLegacyHistory`；`JournalTests.AtomicRollbackAndInvalidMigration` 继续覆盖漏写事件回滚。

错误：用空剧情事件补齐每次移动，或删掉版本完整性校验；正确：行为所有者声明无事件版本，统一Save验证覆盖并提交状态/回执。未来消费者不能假设每个战役版本都有事件；内部等待的精确事件关联不能改成最近事件或无关最新版本。

## 兼容与迁移

现状：授权后可将旧 Unity 原型 JSON 导入完整临时数据库，提交成功再发布，原 JSON 保留；不是旧网页存档迁移器。当前新建SQLite `user_version`为2；首次历史摘要/工作记录写入可迁移至3。旧1授权只读保留1，首次成功写路径明确迁移，未知版本拒绝。世界信息合同见下节及[存储说明](../../../docs/world-memory-storage.md)。

新代码要求：

- 新可空字段有明确缺省意义，补齐不能重建角色 ID、回血、重置资源或伪造历史依据。
- 修改存储版本须给出支持范围、备份、迁移失败行为与恢复方案，并以旧存档夹具证明兼容。不要借 `CREATE TABLE IF NOT EXISTS` 或直接改版本号掩盖迁移。
- 新版读不了未来版本时明确拒绝，不能当空白战役覆盖。
- 不随意改已有请求指纹的序列化/缺省规则；这会破坏已保存回执的同请求判断。变化需要专门兼容方案和重启重放测试。

## 账户与归属

`AccountStore`独立原子保存数据目录`accounts.json`（schema1），持久化用户密码哈希、可撤销会话hash与稳定房间指纹密钥。`Campaign.OwnerUserId`与新建战役同次提交，旧档null；账户列表只读摘要，不触发legacy迁移。完整备份保留账户文件及战役目录，不能只恢复其中一方或重建坏账户库。权限/跨会话回执规则见[账户规范](accounts.md)。

## 游戏与外部资产分开

[MapCatalog.cs](../../../server/DiceRealm.Server/Infrastructure/MapCatalog.cs) 的地图版本、发布状态和任务回执不推进战役版本；[ProviderBudget.cs](../../../server/DiceRealm.Server/Infrastructure/ProviderBudget.cs) 的成本预留独立持久化，游戏失败不回退已经尝试的额度。不要为「统一存储」强行把这些生命周期塞进同一个游戏事务。

文件型记录沿用 [JsonFiles.Write](../../../server/DiceRealm.Server/Infrastructure/JsonFiles.cs) 的临时文件、flush 和原子发布；不直接覆盖可能中断的正文。

## 备份与验证边界

正常停服后复制完整数据目录（包括额度和地图数据），保护客户端凭证；使用 backup-data.ps1。在线文件复制不自动等于一致备份。游戏内进度保存使用下述受锁保护的存档机制；它不替代含账户、费用与供应商配置的完整停服备份。

不编辑运行中的存档、不删锁强行多开、不把阅读用 NDJSON 当可恢复备份。验证使用临时目录，至少覆盖保存前失败、提交后丢响应、同席位重放、另一席位隔离与重新启动。

Python一次性维护使用 `sqlite3` 时，连接的 `with` 只管理事务，不会关闭句柄；需要 `contextlib.closing` 或显式close，避免Windows删除/移动数据库时被自己占用。保护文件在停服阶段可逐字节比较；重启后若字节变化，先找出具体写入者，不直接放宽全部校验。例如 `AiConfigurationStore` 构造时重复设置 `PRAGMA user_version=1` 可改变SQLite头，应继续与备份核对完整schema、全部行、user_version及integrity，而不是误报配置内容被改或忽略真实数据差异。

准备记录由 [PreparationCatalog](../../../server/DiceRealm.Server/Infrastructure/PreparationCatalog.cs) 独立拥有：每战役 schemaVersion=1 的 JSON，最多128记录，先原子保存 unknown 再可能外发，完成后替换对应回执。并发门只锁准备目录操作，授权 CampaignStore 短读不能跨供应商等待；GET 原子读取已保存 unknown/终态。损坏 schema/字段/重复ID 拒绝并保留原文件。不要因准备记录满了而清除幂等历史，也不把未知结果当作未调用。其原文/提议可能私密，完整数据备份必须包含该目录并保持同等访问保护；具体合同见 [跨端准备](../contracts.md#11-输入式准备独立回执与未知位置)。


Harness运行日志独立保存于 `harness/<campaign>/<hash(actor)>/`，原子JSON发布；终态原文件重命名至 `closed/<prefix>/`，路径统一规范化UUID，直接按ID读冷/热记录，不能删除回执来解除容量。权威写工具的完整原输出在 `ActionReceipt.HarnessOutput` 随游戏事务提交，修复“游戏已写、Run日志未写”的崩溃窗口。恢复不能用当前版本快照替代原输出。本段Harness字段本身不迁移游戏schema，新增字段缺省null并忽略序列化；运行文件schema/runtime不兼容或损坏时保留并拒绝。完整备份包含运行目录，模型步骤unknown不因重启被当作未外发。详见 [Harness合同](../contracts.md#12-harness新战役工具回执与明确恢复)。


Harness工作区由 `HarnessWorkspaceCatalog` 拥有：内容寻址原文先写不可变documents，再SQLite事务提交revision/state/receipt。只有已授权的CampaignStore gate可调用，锁顺序不能反向；首次初始化先在同一已授权gate内checkpoint campaign marker，再发布目录；外层失败不能抹掉这条采用记录。已经置标志但目录丢失/初始化中断必须拒绝并恢复一致备份，不能重建bootstrap；目录已提交时可原请求重放。配置与游戏version独立，读/预览不初始化目录；历史回执不裁剪。IO/提交不确定错误不能伪装成已知拒绝。完整合同及故障回归见 [P2](../../../docs/harness-workspace.md) 与 [第13节](../contracts.md#13-harness-工作区独立版本与冻结运行)。

## DM 进度档位与跨文件恢复

- **范围/所有者**：`GameSaveService`协调调度门，`GameSaveCatalog`保存房间内档位/独立回执，`CampaignStore.GameSaves`捕获完整SQLite；详细字段和使用方法只维护在[存档协议](../../../docs/game-saves.md)。
- **持久入口**：`game-saves/<campaign>/index.json`、不可变`payloads/<id>/manifest.json`及替换日志`restore.json`；`harness-issued/<campaign>/...`保留已外发槽位，不随读档回退。
- **合同**：锁顺序为Harness scheduling→campaign gate→map catalog gate。正在执行的模型返回busy，持久等待可保存；SQLite Backup涵盖冷事件/回执/world行，连同本房间运行、地图、参考元数据和工作区一起恢复。不可变素材按引用复用；当前合法凭证/撤销/房间配置与费用不回退。替换前发布恢复档位，写日志，再替换与重建索引，最后原子提交控制receipt。启动在开放worker前按receipt选择after（已提交）或before（未提交）。
- **拒绝/恢复**：损坏清单/缺文件为`game_save_corrupt`；未完成且未提交的恢复日志使房间返回`game_restore_incomplete`，重启完成恢复，不能开放半份进度。旧地图lease不可外发/Complete/Fail；恢复pending/generating明确unknown失败，不自动排图。future-issued运行保留unknown，不能删除ledger重发。
- **正常/兼容/拒绝**：读档保留已撤销权限及新席位；旧缺timeline按初始分支兼容；拒绝只保存快照尾100条、回退账本或复制全目录覆盖当前账户。unknown委派父可整理真实return/consumed但不转running；缺失而已issued首子仅可从原session身份建终态占位，普通Create仍拒绝复用。
- **验证**：`GameSaveTests`验证完整历史/私文/工作区/真实Pi等待与重启；`GameSaveRecoveryTests`验证坏清单零替换、提交前后恢复日志及旧地图lease；`GameSaveCombatTests`覆盖未来外发后回旧档的return与缺首子接续，均断言旧身份零新增外发。
- **正误**：错误是将unknown当未发送、或因拒绝模型而阻断已结算战斗的交接；正确是保留已外发证据与终态，只整理原权威结果，玩家明确新输入使用新身份。

## 派生历史摘要（schema3）

- **范围/签名**：`CampaignStore.History`在现有战役库保存`history_summaries/history_work`，不替代原事件或Run；完整字段见[历史上下文](../../../docs/harness-long-memory.md#摘要与模型槽位分别冻结)。
- **事务/迁移**：首次需要写历史时显式2→3并保留SQLite备份，一般读取不迁移。发布在授权campaign gate复核timeline、scope、audience及精确source/part/revision，再原子保存；不同层摘要可共存，同次选择不得重复覆盖。
- **外发记号**：`harness-issued/<campaign>/history.json`不含原文，且不随读档/重开回退。先原子保存issued，再保存库内work，再允许外发；只靠会回退的work表不能防止unknown再次发送。
- **拒绝**：源修订/受众/分支变化拒绝发布，保留旧组合；损坏ledger拒绝并保留，不重建成空。当前Run与game-save仍用原恢复所有者。
- **正常/兼容/边界**：读旧schema2档后仍消费不回退issued；源未变的已发布摘要可保留；重开清派生历史但不清外发记号。旧0..44不升级历史策略。
- **验证**：`HarnessHistorySummaryTests`检查迁移备份、分层替换和读档；`HarnessHistoryPipelineTests`覆盖外发失败→读回旧档→新运行零重发；`GameSaveTests`检查完整消费者。
- **正误**：错误是读档回退摘要调用账本或把摘要当权威状态；正确是游戏派生材料随档，外发事实不回退，当前状态仍从原聚合读取。

## 世界信息行与词项索引（schema2）

`Campaign.WorldMemory`只属于legacy/纯领域构造；schema2授权gate绑定`IWorldMemoryIndex`，state带`worldMemoryStorageVersion=1`且不含该数组。新增消费者使用`WorldMemories.Find/Read/Apply`，不要枚举旧List当完整数据，更不能在GET补表/索引。`SqliteWorldMemory`保留请求内dirty overlay；读到刚修订条目，但直到短Save事务才同时写world_entries、world_terms、state、events、receipts。源ID/名称全局去重与公开计数不受最近32/256窗口影响。

首次授权写迁移1→2先在私有同目录保存带原SHA256的SQLite字节备份；原事件/回执不重写。迁移失败整笔回滚到1。Windows文件读取用ReadWrite/Delete共享以兼容已打开的SQLite句柄，安全前提仍是单writer目录锁+同战役gate+DELETE journal+无事务；不能将这个实现复制为任意在线备份。正式版本回滚需停服完整目录备份，单库迁移备份不涵盖运行、额度与地图。断言见`WorldScaleTests.MigrationBackupRollbackAndReplay`、`OverlayAndAtomicReceipts`；具体界面/工具合同见[第17节](../contracts.md#17-世界信息规模化分页与原子索引)。
