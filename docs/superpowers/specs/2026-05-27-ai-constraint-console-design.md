# AI 约束控制台优化设计

## 目标

在现有 DND AI-DM MVP 上增加类似 SillyTavern 的 AI 约束能力，让创建者可以精确控制 AI-DM 的行为边界、信息隔离规则、玩家自主权规则和输出格式，并能在处理回合前预览最终发送给 AI 的 prompt。

## 范围

本次优化只做轻量可用版：

- 房间级 AI 约束配置。
- 管理员页编辑并保存约束配置。
- 管理员页预览当前回合最终 AI prompt。
- 后端处理回合时使用同一套 prompt 构造逻辑。
- 增加测试覆盖约束顺序、隔离规则和预览接口。

不做完整 SillyTavern 预设系统、token 预算、导入导出、多模型参数编辑或聊天 UI 重构。

## AI 约束配置

在 `rooms` 表增加 `ai_config_json`，存储：

- `coreRules`：AI-DM 核心身份和裁定原则。
- `playerAgencyRules`：玩家自主权规则，明确不能替玩家决定意图、台词、同意、反抗或 PvP 回应。
- `visibilityRules`：信息隔离规则，明确不能泄露、暗示或串联其他玩家私密信息。
- `interactionRules`：玩家间互动规则，要求需要目标玩家回应时创建确认请求。
- `outputFormatRules`：结构化 JSON 输出规则。
- `styleRules`：叙事风格规则。

默认配置使用中文，管理员可编辑。

## Prompt 构造顺序

`aiContextBuilder` 使用固定顺序构造 prompt：

1. 核心规则
2. 玩家自主权规则
3. 信息隔离规则
4. 玩家交互规则
5. 叙事风格规则
6. 房间世界设定
7. 公开日志
8. 本轮行动，按提交时间排序
9. 待处理互动
10. 输出格式规则

这样保证最重要的约束位于 prompt 顶部和底部，降低模型忽略约束的概率。

## 管理员界面

管理员页新增“AI 约束”卡片：

- 多个 textarea 对应每个约束块。
- “保存 AI 约束”按钮。
- “预览 AI 请求”按钮。
- 预览区域显示后端按当前回合真实数据构造的最终 prompt。

## 后端 API

新增接口：

- `GET /api/admin/rooms/:roomId/ai-config`
- `PUT /api/admin/rooms/:roomId/ai-config`
- `GET /api/admin/rooms/:roomId/ai-prompt-preview`

处理回合接口复用 prompt preview 的构造逻辑，避免预览和真实请求不一致。

## 测试策略

- 单元测试：AI prompt 包含配置约束，且顺序正确。
- 集成测试：保存 AI 配置后，prompt preview 返回新约束。
- 回归测试：回合处理使用保存后的 AI 配置。
- UI 验证：管理员页能看到 AI 约束卡片、保存配置并预览 prompt。
