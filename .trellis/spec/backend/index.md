# 服务端规范

适用范围：`server/DiceRealm.Server`、`agent-host`、`tests/DiceRealm.Tests`、`schemas` 及相关运行脚本。服务端拥有唯一权威游戏状态，两个前端不能替代它做判定。

## Pre-Development Checklist

- 读 [目录与职责](directory-structure.md)，找到行为所有者；新增代码按职责放置，不继续扩大入口文件。
- 写命令/DTO/权限时读 [跨端契约](../contracts.md) 与 [错误、安全及日志](error-handling.md)；账户登录、用户归属与admin权限读 [账户规范](accounts.md)。
- 改本机AI配置、用量或输出Token默认时读 [AI设置与用量](ai-settings.md)。
- 改运行包启动或日常接替时读 [运行包接替](runtime-packaging.md)。
- 改状态、回执、历史或存档时读 [持久化](database-guidelines.md)。
- 涉及 AI、内容、地图或 D&D 来源时读 [外部集成与规则边界](integrations.md)。
- 改主输入能力、物品、来源法术或已记录检定后果时读 [自然效果](natural-effects.md)。
- 改标准战斗模式、持久触发、法术/敌人执行时读 [标准战斗](standard-combat.md)。
- 改成长来源移交、祈唤身份和撤销时读 [成长来源](advancement-sources.md)。
- 改休整发起、团队时钟或本人恢复窗口时读 [DM全队休整](party-rest.md)；改长休来源重选和主输入候选时读 [休息来源选择](rest-source-choice.md)。
- 按 [验证规范](../verification.md) 选择真实失败场景，不对日常数据或真实供应商做回归。

## Quality Check

- HTTP 只负责边界；Domain 不依赖 HTTP、Unity、数据库或供应商。
- 新命令的授权、回执顺序、版本、原子提交和重试符合共享契约。
- 输入大小、枚举、身份、跨战役引用和可见性在服务端校验；不依赖按钮隐藏。
- 保存/投影/错误/日志不泄露凭证、完整私有内容或模型请求。
- 规则变化有正确版本和来源依据；不支持的操作明确拒绝或裁定。
- 运行受影响测试；共享存储/协议改变时覆盖并发、重启和双端。命令只维护在 [验证规范](../verification.md)。
