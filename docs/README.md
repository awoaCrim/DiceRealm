# DiceRealm 文档入口

先读[当前状态与优先级](current-status.md)。本目录只放当前使用说明与协议；稳定开发约束在 [.trellis/spec](../.trellis/spec/index.md)，本轮任务与验收从协作入口进入，逐轮研究和历史结论在 `.trellis/research/`，会话摘要在 `.trellis/workspace/`。

当前视觉改造见接手文档与[视觉规范 v2](../.trellis/spec/frontend/visual-v2.md)。尚未发布的源码界面与当前日常包要分开判断。

## 运行与使用

- [本地开发与运行](development.md)：启动、供应商配置、存档保护与测试。
- [工作台账户与用户战役](workbench-accounts.md)：登录、管理员用户管理、战役归属与旧凭证兼容。
- [主持工作台](../client-workbench/README.md) / Unity 客户端 / [前端职责](frontend-separation.md)。
- [房间创建与共享密码加入](room-onboarding.md) / [一级建卡](full-character-creation.md) / [角色头像](character-portraits.md)。
- [DM一键剧本库](adventure-library.md) / [输入式开局](input-preparation.md) / [剧本与提示词导入](content-import.md) / [Gemini 3.8 中文跑团文风补充](gemini-writing-style.md)。
- [角色使用](character-play.md) / [完整角色逐级成长](character-advancement.md) / [旧预设角色与成长](characters-and-growth.md) / [协作与裁定](party-and-rulings.md)。
- [DM 存档、读档与重开](game-saves.md)：全队进度恢复、死亡观战与游戏结束。
- [工作台战况与战报](workbench-combat.md)：先攻、单位状态、等待事项和已结算结果。
- [工作台主持概览](workbench-dm-overview.md)：剧情页队伍状态、当前场景私密资料与只读DM地图。
- [AI DM自主剧情检定](ai-dm-checks.md)：判断投掷时机、难度与豁免，玩家沿原投掷窗操作。
- [标准2024战斗](standard-combat.md) / [旧非致命战斗](combat.md) / [主输入可执行效果](natural-action-effects.md)。
- [共享电子棋盘与持久单位](shared-board.md) / [敌人和NPC命名](npc-naming.md) / [地图图册](maps.md) / [世界路线与地图关联](world-maintenance.md) / [世界信息存储](world-memory-storage.md) / [长期历史与存储](history-and-storage.md) / [旧场景图兼容](scene-assets.md)。
- Prefab 与素材维护 / 界面图标与 BG3 素材。

## 业务接口与执行内核

- [业务冒险与设定](adventure-sessions.md)：Unity/工作台当前业务端点、行动、本人确认与恢复。
- [运行、工具与恢复](harness-runtime.md)：Pi/MCP 循环、配置、工具契约版本、权限、等待与恢复。
- [历史上下文与原文回查](harness-long-memory.md) / [版本化工作区](harness-workspace.md) / [Agent Host wire v1](harness-agent-wire.md)（.NET ↔ Node 内部协议的唯一维护处）。
- [客户端协议](client-contract.md) / [输入驱动冒险](input-driven-adventure.md) / [行动理解](action-understanding.md) / [按需投掷](contextual-rolls.md) / [行动连续性](adventure-continuity.md)。
- [架构](architecture.md) / [规则覆盖](rules-2024.md) / [本地中文规则库](local-chinese-rules.md)。

## 开发流程

- Trellis 入口 → 项目约定、[开发规范](../.trellis/spec/index.md)、[验证规范](../.trellis/spec/verification.md)。
- 界面视觉优先读[视觉规范 v2](../.trellis/spec/frontend/visual-v2.md)，再按职责读 [Unity 规范](../.trellis/spec/frontend/unity.md) / [工作台规范](../.trellis/spec/frontend/workbench-style.md) / [使用者流程](../.trellis/spec/frontend/user-experience.md)。
- 实机巡检与 QA 脚本：scripts/qa；运行包：macOS / Windows。

## 历史与清理

旧交付记录索引保留62份历史文字结论；早期协作记录保留此前派单与验收。历史文档不作为当前启动、恢复或新增付费调用的依据。

2026-11-05 已按用户要求删除项目内过期运行包、备份、重复构建和旧截图。历史路径可能仅作当时记录，当前保留项与实际删除范围见交接记录。
