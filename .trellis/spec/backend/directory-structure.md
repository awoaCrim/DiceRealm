# 目录与职责

| 位置 | 拥有的行为 | 不应放入 |
|---|---|---|
| `server/DiceRealm.Server/Api` | HTTP 路由、传输上限、反序列化、错误映射、静态工作台托管 | 游戏判定、直接修改存档 |
| `server/DiceRealm.Server/Application` | 用例协调、权限/回执/版本顺序、服务端投影、外部能力接口 | UI 布局、任意 JSON patch |
| `server/DiceRealm.Server/Domain` | 规则、内容校验、角色、战斗、剧情后果及领域数据 | 文件/SQL、HTTP、Unity、模型调用 |
| `server/DiceRealm.Server/Infrastructure` | SQLite/文件、供应商适配器、额度、地图任务与图片校验 | 代替 Domain 决定游戏结果 |
| `tests/DiceRealm.Tests`、`tests/Fixtures` | 控制台测试、真实本机 HTTP、替身与显式导入夹具 | 生产默认故事和提示词 |
| `schemas` | 已发布导入格式的描述 | 未实现格式的承诺 |

## 新代码要求

- 能在 Domain 内用显式输入计算的行为，不写进路由。纯预览和实际执行共享规则，不能分别实现两份判断。
- API 按功能扩展端点模块；参考 [ContentEndpoints.cs](../../../server/DiceRealm.Server/Api/ContentEndpoints.cs) 和 [MapEndpoints.cs](../../../server/DiceRealm.Server/Api/MapEndpoints.cs)。路由只做传输/鉴权入口并调用用例。
- Application 调用具体基础设施是当前规模的务实选择；仅在替换/测试确有收益时抽接口，不补空转发的 repository/service 层。
- 复杂领域功能按业务模块聚合模型、校验和执行，参考 [Creation](../../../server/DiceRealm.Server/Domain/Creation/) 与 [CharacterPlay](../../../server/DiceRealm.Server/Domain/CharacterPlay/)。不要因命名相同就把所有 Validator/Helper 聚到一个大目录。
- public 类型、字段与方法使用清楚的业务名；依照当前 C# 命名和 nullable 约束。现代服务端语言特性不能直接复制到 Unity 工程。

## 示例与现状

[ActivityService.cs](../../../server/DiceRealm.Server/Application/ActivityService.cs) 示范：用例从已授权存储读取原事件，再生成玩家可读投影；[StoryConsequences.cs](../../../server/DiceRealm.Server/Domain/StoryConsequences.cs) 拥有剧情后果的验证与应用。

当前多个 `*Service.cs` 实际是 `GameService` 的 partial，不是互相独立的服务。可利用既有事务入口，不能误以为移动到另一个 partial 就完成了职责隔离。提取新模块时优先传入明确依赖和数据，避免依赖整个大协调器；只在本任务必要范围内迁移。

本项目没有 ORM、CQRS 框架、消息总线或多节点数据库。没有现实需求前不引入这些层，也不把现有命名写成必须复制的架构。
