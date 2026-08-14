# Phase 4 检查点 B：owner/player 工作区浏览器验证

> 日期：2026-08-09
> 状态：PASS
> 运行入口：`npm run test:phase4-browser`

## Owner 工作区

真实浏览器已验证五页：

- **回合与 AI 运行**：开始回合、提交计数与 ID chips、行动正文、锁定、发起结算、自动进入下一回合。
- **角色审核**：看到两名玩家待审角色，分别批准，并显示批准角色摘要。
- **世界**：创建事实；存档恢复后刷新并确认后创建的事实被回滚。
- **战斗**：创建包含 `public`、`player_private`、`owner_only` 战斗员的 encounter。
- **存档**：创建手动存档、确认恢复并消费 `archive.restored` 全量失效。

## Player 工作区

真实浏览器已验证五页：

- **剧情**：公开叙事、实时 AI preview、自己的 private update。
- **行动**：waiting 时提交与编辑；最后玩家提交后自动 locked；两名玩家 editor 均禁用。
- **角色**：创建 platform draft、提交审核、刷新后看到 approved 与 derived AC。
- **背包**：由角色 sheet 安全读取 equipment/spells；组件测试覆盖错误 shape 回退。
- **战斗**：只读服务端投影，无 mutation controls。

## 隔离与错误状态

- playerA 可见 public + A private combatant；不可见 B/owner-only 内容。
- playerB 可见 public；不可见 A private 与 owner-only 内容。
- player 页面不含 owner AI run、`owner.debug`、`rawDebug` 或 context。
- test-only 500 注入只使世界 feature 显示 error/retry；Owner Header、导航和战斗页仍可用；取消注入后重试恢复。

## 证据

- `output/playwright/phase4/phase2-owner-characters-approved.png`
- `output/playwright/phase4/phase3-locked.png`
- `output/playwright/phase4/phase5-playerA-combat.png`
- `output/playwright/phase4/phase6-restored.png`
- `output/playwright/phase4/phase7-error-recovery.png`
