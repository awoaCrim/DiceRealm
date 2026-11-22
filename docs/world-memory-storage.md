# 世界信息：有界读取与索引存储

旧战役不自动转换。世界路线与地图关联见[世界维护](world-maintenance.md)，历史个人行动召回与模型上下文压缩见[长期记忆](harness-long-memory.md)。世界检索是本地词项/子串检索，不是神经语义模型，也不向供应商发送存档。

## 读取与实际用途

人物、任务、地点、线索仍由公开叙事受限记录，或由主持针对某条记录纠错；不增加手工建库要求。上限从256条提高到8192条，正文不再随每次游戏聚合读取全部加载。`world_record` 仍每次最多6条，不改变角色、检定、奖励、事实或旅行权限。

`CampaignSnapshot.worldMemory` 最多256条，顺序为更新时间倒序、ID升序。只有可见总数超过256时附带 `worldMemoryPaging: {total,nextOffset:256}`；没有该字段兼容旧快照。它是近期窗口，不能标注为完整世界资料。

只读端点：

```text
GET /api/v1/campaigns/{id}/world/memory
    ?expectedVersion=当前战役版本
    &query=关键词
    &kind=clue
    &offset=0
    &limit=32
    &scope=public
```

- `expectedVersion` 必填。`query` 0..120字符、最多8个空白分隔词；每个完整词都必须在名称或摘要中出现，使用 invariant 大写规范化的子串匹配。空查询浏览。`kind` 空或 npc/quest/place/clue。
- `offset` 0..8192，`limit` 1..32；返回 `{version,scope,entries,total,nextOffset}`。末页 nextOffset 为 null。分页必须保持版本、查询、类型和范围相同；战役版本变化返回409，明确刷新后从头检索。
- `public` 对任何席位只返回公开、未隐藏、或已访问揭示地点的 arrival 信息；总数也只统计可见匹配项。`host` 必须是主持，包含隐藏与未揭示信息。普通模型始终只能使用 public，主持发起模型运行也不会改为 host。
- 页面记录保留原ID、修订和来源；从旧页纠错仍冻结读取版本和记录revision，不合并到客户端快照、不默默换成最新版本。检索不会创建操作许可。

`context_read` 仍最多32条并优先当前地点。地图自动关联的候选先按已知地点过滤、最多128条，再匹配该图已有锚点；未载入候选不等于记录消失。独立路线对地点记录按ID读取，不依赖它是否在近期快照里。

## 工具版本

规模扩展在契约7加入；当前新运行使用16，旧目录原文与schema冻结。v6 golden 来自改前world程序集，值为 `19c7c6a424fccd2f2ad2a84ec6d38db16a4c7579aaf0347dd2e1352936e4398f`。

契约7 `world_search` 的offset上限8192，其余仍最多6条、24KiB、公共范围和同版本分页；旧0..6中存在的world_search保持offset最大256，浏览不返回超出该旧边界的下一页。应对较大的世界使用新运行，旧运行不会升级目录或重新计算已完成步骤。

实际返回的ID仍只在同一run/version/等待续接区间有效，最多保留最近返回的256个不同ID；重新读一个ID会刷新它的位置。世界总容量不能作为每次模型上下文或已读许可集合的容量。写入、等待续接、上下文压缩仍使许可失效。

## 权威存储与迁移

`CampaignStore` SQLite新建库为 `user_version=2`。游戏聚合自身 `schemaVersion` 仍1，新私有标志 `worldMemoryStorageVersion=1`；state不再包含worldMemory数组。权威正文与字段在 `world_entries`，派生的单字符/双字符倒排词项在 `world_terms`。同类名称的规范化键有唯一索引，另有更新时间、地点与词项记录索引。

授权gate内才绑定 `IWorldMemoryIndex`。查ID、全局名称冲突和有界查询由数据库完成；查询选择少量确定的词项、以较稀疏的posting筛选候选，再验证所有完整词，不把词项命中冒充正文匹配。变更先留在请求内overlay，当前请求立即可读到，但SQL事务只在最终保存时开始；权威行、词项索引、游戏state、连续事件与回执同事务提交。任一插入失败整笔回滚，不留下旧名称索引或半份世界更新。

已有SQLite1的GET不迁移；旧JSON仍按既有授权规则导入SQLite1并保留原JSON。第一次成功的授权写路径（包括需保存元数据/回执的写路径）才采用2。迁移不复制原事件/回执，也不改它们的正文。

迁移前在原私有目录保存 `<campaign>.sqlite.pre-world-v2.<sha256>.bak`，内容与迁移前SQLite字节一致，原子发布、已存在时校验且不覆盖。保证依赖单写进程目录锁、战役gate、DELETE journal及无打开事务；Windows读取文件需允许SQLite句柄的ReadWrite/Delete共享，不因此放松写入互斥。授权失败不生成备份，迁移/事件/回执提交失败保留原schema及数据，备份保留供检查。

这份单战役迁移备份**不是完整运行数据回滚包**。正式启用前仍须停服备份整个数据目录，包括模型运行日志、额度账本、工作区、地图与客户端凭证。旧程序必须拒绝SQLite2；不能只调低版本号，不能让旧程序忽略新字段覆盖记录。完整恢复使用匹配旧程序与一致全目录备份，已尝试的供应商额度不能因回滚再使用。

### 拒绝行为

- 非法查询：`invalid_world_query`；旧版本分页：`stale_version`。
- 席位/凭证不合法：原401；非主持读取host：原403。
- 容量满：`world_memory_capacity`，整批新提议不应用。
- 不同schema/marker混用、缺表或索引、所读记录非法：`invalid_world_memory_store`，不自动建表或将其当空库覆盖；未来SQLite版本为 `unsupported_save`。
- 纠错revision变化：`world_memory_changed`；隐藏同名记录引起的冲突仍是通用 `invalid_world_memory`，不返回秘密正文。

## 客户端与测试

工作台世界手记提供检索、类型、分页和明确的可见总数；保留可选主持纠错。请求版本/范围、响应长度/游标受校验；退出、换战役、换席位或版本变化后迟到页不能落到当前界面。读失败不自动提交或重试写操作。Unity公开分页接线同理，不在客户端重算权限。

`WorldScaleTests`验证8192条、state无全文数组、真实数据库索引、有界加载、中文/ASCII检索、公开ID无重无漏分页、容量拒绝、隐藏/到达、同请求overlay、并发纠错、事件/回执失败原子回滚、迁移备份字节、重开与旧v6冻结；真实Pi/MCP v7在offset300取得旧记录并按原ID更新。
