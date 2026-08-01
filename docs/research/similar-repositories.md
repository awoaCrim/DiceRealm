# DND AI-DM 项目：相似开源仓库调研报告

> 调研日期：2026-08-01
> 调研方法：仅使用一手来源——GitHub 仓库 README、仓库内源码/文档/LICENSE、GitHub API 仓库与搜索元数据、仓库 commits Atom feed。未引用任何二手转述。
> 数据口径：星标/提交数/最后提交日期等均以调研当日 GitHub 公开页面与 API 返回为准。
> 说明：所有"可借鉴/不可照搬"结论均为工程建议，非法律意见；涉及许可证判断时，以各仓库 LICENSE 声明为准，采用/复制前请自行复核。

---

## 1. 当前项目能力画像（用于映射候选仓库）

本项目 `dnd-ai-dm-mvp`（`G:\Users\admin\desktop\code\dnd`）为自托管 DND AI-DM：
- **技术栈**：Express + better-sqlite3 + zod（server），React + Vite（client），SSE 实时推送 + eventBus。
- **已有能力**（依据 `server/src` 与 `db/schema.ts`）：
  - `rooms`（房间=战役，含 `system_prompt`/`world_info`/`current_turn`/`status`）、`players`（每房独立 `token` 认证，`is_connected`）、`characters`（`sheet_json`、`draft_source`、`confirmed`）。
  - `rule_sources`/`resource_import_jobs`/`resource_import_drafts`：规则资源导入与审核，含 `visibility`（private/campaign/workspace/public）、`ruleset`（5e-2014/5e-2024/homebrew）、`language`、`source_license`。
  - `rule_world_book_entries`：世界书条目（key/priority/content）。
  - 服务层：`turnEngine`/`turnMaterializationService`（事务化落库）、`combatService`/`combatStateSyncService`、`worldBookService`、`ruleRetrievalService`（embedding 检索）、`campaignMemoryService`、`characterBuilderService`、`characterAuditService`、`diceService`、`sillyTavernPromptBuilder`、`aiTurnWorkflowService`、`visibilityService`、`socialService` 等。

映射结论：本项目已同时覆盖"AI DM 引擎 + 结构化回合/战斗/世界书/规则库 + 房间级私密性与账号（token）"，候选仓库按以下四个方向展开。

---

## 2. 候选仓库总览

| 仓库 | 方向 | 许可证 | 星标 | 最近提交 | 与项目相关度 |
|---|---|---|---|---|---|
| Sagesheep/NarrativeEngine-P | A. AI DM | MIT | 74 | 2026-07-30 | ★★★★★ |
| SillyTavern/SillyTavern | A/C. AI 角色扮演前端 | AGPL-3.0 | ~31.5k | 2026-07-07 | ★★★★★（本项目已深度借鉴） |
| agnaistic/agnai | D. 多用户 AI 角色扮演 | AGPL-3.0 | 766 | 2026-06-13 | ★★★★★ |
| Durtur/Dungeoneer | B/C. 5e VTT | AGPL-3.0 | 208 | 2026-01-24 | ★★★★ |
| foundryvtt/dnd5e | C. 5e 角色卡/规则数据 | MIT（内容 CC-BY-4.0） | 578 | 活跃（6.0.x） | ★★★★ |
| Farama-Foundation/ChatArena | A. 多智能体 LLM 环境 | Apache-2.0 | 1552 | 2025-08-11（已弃用） | ★★★★（架构借鉴） |
| ThaumRystra/DiceCloud | C. 5e 实时角色卡 | GPL-3.0 | 506 | 2026-05-10 | ★★★★ |
| farirpgs/fari-app | B. 开源 VTT | AGPL-3.0 | 316 | 2026-01-14 | ★★★ |
| mythal/boluo | D. 房间制 RPG 聊天 | AGPL-3.0 | 151 | 2026-08-01 | ★★★ |
| rsek/datasworn | C. 规则数据格式 | MIT + CC-BY | 162 | 2024-11-29 | ★★★ |
| TavernAI/TavernAI-v1 | A. AI 冒险聊天（ST 前身） | MIT | 2.7k | 2026-06-16 | ★★（历史参考） |
| owlbear-rodeo/owlbear-rodeo-legacy | B. VTT（仅非商业） | 自定义非商业 | 192 | 2023-12-05（已停更） | ★★（仅架构参考） |
| foundryvtt/foundryvtt | B. VTT 核心 | 闭源/商业（仅 issue 仓库） | 377（issue 仓库） | 2026-07-24 | ★★（产品模型参考，不可照搬） |

---

## 3. 分方向详述

### A. AI DM / AI GM 引擎

#### A1. Sagesheep/NarrativeEngine-P（MIT，★ 74）
- **一手证据**（README + commits feed）：自托管 AI 城主，"run extended TTRPG campaigns"，任意 OpenAI 兼容 LLM 或本地 Ollama；v1.0.4；337 commits；最近提交 2026-07-30，维护活跃。
- **功能/架构**：TypeScript + Vite/React 前端，Node 后端（`packages/engine` 核心、`server/`），better-sqlite3 + sqlite-vec + @huggingface/transformers 本地 embedding。
  - 记忆："两阶段归档检索"（LLM 章节概览 → 本地向量检索具体场景）+ 三档自动压缩（Tight 50%/Smart 75%/Deep），最近 8 条原文保留；固定记忆注入每次 GM 调用。
  - 世界状态：Divergence Register——结构化事实清单（地点、NPC 事件、承诺与债务、团队事实、传说），带语义去重与事实聚类，且带分派系可见性（`knownBy` 权限）防止 NPC 开天眼。
  - NPC 自主性：人格六边形（六轴 ±3）、三层目标引擎 + 心跳骰、关系/压力/边界/层级（Recurring/One-shot/Walk-on）。
  - 骰子与战斗公平：预掷 d20 池、三档优势、Catastrophe→Critical 分层结果、`roll_dice` 工具。
  - 一致性 QA："Lore Check" 交叉核对传说与归档并给出来源引用。
  - 安全/回滚：AES-256-GCM 密钥库、PBKDF2 口令、场景级回滚、自动备份。
- **可借鉴**：① 结构化世界状态登记（对应本项目 `campaignMemoryService` + 战役 NPC/任务/地点表），其 `knownBy` 分派系可见性与本项目 `visibilityService` 天然同构；② "两阶段记忆召回"正对应本项目 findings.md 提出的 pre-turn 记忆侧车；③ Lore Check QA 可映射到 `ruleRetrievalService` 的校验/审计；④ 场景级回滚与备份映射到 `turnMaterializationService` 的事务化落库。
- **不可照搬**：它是本地单机、离线优先模型（本地文件 + 客户端加密），没有多人共服/账号体系/实时协作；README 未提供正式玩家角色卡 UI；其世界/NPC 范式并非 D&D 5e 的结构化战斗。只借鉴理念与机制，不照搬其"无共享服务端"假设。

#### A2. SillyTavern/SillyTavern（AGPL-3.0，★ ~31.5k）
- **一手证据**（README）：本地安装的 LLM 前端，始于 2023-02 对 TavernAI 1.2.8 的分叉（AGPL-3.0，README 声明）；11,719 commits；最近提交 2026-07-07；约 300 贡献者；无账号/多人系统（单用户本地）。
- **功能/架构**：Node 后端 `server.js` + `public/` 前端；WorldInfo（世界书/lorebook）、角色卡、多 API（KoboldAI/Horde/OpenAI/OpenRouter/Claude 等）、图像/TTS、自动翻译、强提示词控制。
- **可借鉴**：本项目已深度研究其世界书、角色卡、`prompt_order` 多角色组装、`<peip>` 玩家授权边界（见 `findings.md` 与 `sillyTavernPromptBuilder.ts`）。其"世界书触发/字符预算/多段 prompt"仍是世界书与规则库注入的最佳参考。
- **不可照搬**：AGPL-3.0 强 copyleft——不可把 ST 代码并入本项目而不开放本项目源码（本项目已自研 `sillyTavernPromptBuilder`，路径正确）；其单用户、无账号/无协作模型与本项目多人共服目标相反。

#### A3. Farama-Foundation/ChatArena（Apache-2.0，★ 1552，已弃用 2025-08）
- **一手证据**（README + commits feed）：多智能体语言游戏环境；421 commits；README 明确 2025-08-11 起不再维护。
- **架构**：四概念抽象——Arena（封装环境+玩家，驱动主循环）/ Environment（持有状态、执行游戏逻辑、把状态渲染成自然语言观测）/ Language Backend（语言后端）/ Player（观测→动作的无状态策略）；游戏由 JSON 配置加载。
- **可借鉴**："Environment 不向玩家直接暴露状态，而是渲染成自然语言观测"+"Backend/Player 分离"非常适合本项目 findings.md 的三侧车（主叙事/记忆召回/表格固化）与 `aiTurnWorkflowService` 的分阶段设计。
- **不可照搬**：已弃用；无世界持久化、无 D&D 环境、无生产级 UI；研究框架（马尔可夫博弈）对生产应用过重。仅借架构思想，不借代码。

#### A4. TavernAI/TavernAI-v1（MIT，★ 2.7k，legacy）
- **一手证据**（README）："Atmospheric adventure chat for AI language models"，675 commits，最近提交 2026-06-16；README 自述"legacy repository"。
- 功能：角色创建与在线角色库、多角色群聊、故事模式、世界信息、滑动重生成。
- 定位：SillyTavern 的源头（据 SillyTavern README 所述分叉关系）。MIT 许可、功能被 ST 全面超越，仅作历史参考，不做主推荐。

#### A5.（次要，仅据 GitHub 搜索元数据，未做源码级验证）
- `nickwalton/AI-DungeonMaster`（★79）、`fedefreak92/dungeon-master-ai-project`（★31，Python 状态机 + 地图的 5e 后端）、`eeshsaxena/ai-dungeon-master`（★15，LLM + 知识图谱 + RAG）、`lguibr/daicer`（★2，LangGraph 编排的多人 AI DM）、`deusversus/aidm`（★2，多智能体 RPG 平台）。这些项目较小或过新，仅以搜索元数据确认存在，未纳入推荐。
- `Latitude-io/AIDungeon` 原始仓库已不可访问（404），不再作为可参考对象；中文社区分支 `bupticybee/ChineseAiDungeonChatGPT`（★1403）、`bupticybee/ChineseAiDungeon`（★241）同样仅经搜索元数据确认。

---

### B. 多人在线 / 自托管 TTRPG / D&D 平台（VTT）

#### B1. Durtur/Dungeoneer（AGPL-3.0，★ 208）
- **一手证据**（README + commits feed）："a virtual tabletop designed for 5e D&D"，包含地图工具（动态光照）、先攻、战斗追踪与房规管理；572 commits；最近提交 2026-01-24；可从桌面或安卓移动浏览器加入游戏，"access control"。
- **架构**：Electron 桌面应用（`main.js`、`electron-builder.yml`）+ 浏览器/移动端客户端；Node/JS，`sharp` 图像库。
- **功能**：遭遇创建（难度实时追踪）、先攻与怪物状态追踪（豁免/攻击/状态）、地图（战争迷雾、Dungeondraft 墙体导入、token、效果）、随机表与遭遇生成器、酒馆/NPC/魔法物品商店生成器、战利品生成器；内置 SRD 与自由许可怪物/法术库。
- **可借鉴**：① 战斗追踪器的先攻/状态/条件设计与 `combatService` 对齐；② "遭遇难度实时追踪"（可映射到本项目 dice/combat 校验）；③ 内置 SRD + 房规管理（映射 `rule_sources` 的 visibility/ruleset 分层）；④ 加入游戏的 access control（映射本项目房间 token 私密性）。
- **不可照搬**：AGPL-3.0 copyleft；Electron 桌面打包与地图画布/光照引擎体量巨大，超出本项目 web 优先、以文本与规则为中心的范畴。

#### B2. farirpgs/fari-app（AGPL-3.0，★ 316）
- **一手证据**（README）："The Free and Open-Source Virtual Tabletop"，521 commits，最近推送 2026-01-14；Fate 规则向；服务鸣谢含 Liveblocks（实时协作服务）；i18n（Lokalise）；Netlify 托管；Vite/React + 11ty SRD 静态站 + Cypress/Storybook。
- **可借鉴**：开源 VTT 的实时协作与本地开发/CI 流程；角色卡与 SRD 静态化的结合方式。
- **不可照搬**：Fate 专精（非 D&D 5e）；AGPL copyleft；Liveblocks 为付费托管服务，本项目以 SSE/自托管为方向，不应引入外部协作依赖。

#### B3. owlbear-rodeo/owlbear-rodeo-legacy（自定义非商业许可，★ 192，停更 2023-12）
- **一手证据**（README）：作者发布的 Owlbear Rodeo 1.0 源码，仅限"personal/non-profit use"，不提供商用许可；1,814 commits；最近推送 2023-12-05。
- **架构亮点**：实时多人地图与共享 token；物理骰子；`src/ml` 中用 TensorFlow 识别地图网格；WebRTC（STUN/TURN）点对点共享图片 + IndexedDB 本地存储；无账号/无云存储。
- **可借鉴**：WebRTC 点对点共享与实时指针插值的思想（若未来做实时地图）。本项目以规则/文本驱动，地图非核心，借鉴优先级低。
- **不可照搬**：非商业许可——任何代码/美术均不可用于商业项目；已停止维护。

#### B4. foundryvtt/foundryvtt（核心闭源/商业；仓库仅为 issue 追踪）
- **一手证据**：`foundryvtt/foundryvtt` README 明确"该仓库用于跟踪计划功能/缺陷"，不含源码，无 LICENSE 文件；README 提到支持 Win/Mac/Linux，可自托管游戏服务器、玩家免费经浏览器接入。
- **定位**："自托管服务器 + 浏览器玩家 + 账号/权限 + 战役世界隔离"是该品类的产品模型标杆，但核心闭源，无法借鉴代码。
- **不可照搬**：核心闭源且商业授权；其 dnd5e 系统虽开源（见 C1），但依赖闭源核心运行。仅可作为产品形态（房间=世界、GM 权限、玩家只读角色卡、免费客户端接入）的对照。

---

### C. 结构化角色卡 / 战斗 / 世界书 / 规则库（数据与领域建模）

#### C1. foundryvtt/dnd5e（MIT 代码 + SRD 内容 CC-BY-4.0，★ 578）
- **一手证据**（README + LICENSE）：为 Foundry 官方 5e 游戏系统，"提供 Actors/Items 角色卡、骰子与规则机制、密卷（compendium）内容"；软件部分 MIT，SRD 5.1/5.2 内容 CC-BY-4.0，图片/资产各自附带 LICENSE；6,455 commits，6.0.x 分支活跃维护。
- **可借鉴**：① 角色卡数据模型（Actor/Item 拆分）与密卷（compendium）组织结构——映射本项目 `characters.sheet_json` 与 `rule_sources`；② "SRD 内容 + CC-BY-4.0 + 资产单独 LICENSE"的内容合规组织方式；③ 规则/法术/怪物/物品的条目化、本地化（lang）结构。
- **不可照搬**：内容（文本/图像）受 CC-BY-4.0 及其资产 LICENSE 约束，须署名并保留许可声明；系统依赖闭源 Foundry 核心运行，不可整体搬走。

#### C2. ThaumRystra/DiceCloud（GPL-3.0，★ 506）
- **一手证据**（README + 仓库结构）："free, auditable, real-time character sheet for D&D 5e"；2,689 commits；最近推送 2026-05-10；Meteor + MongoDB（Docker 支持），可自托管。
- **核心思想**：可审计数字——每个派生值（AC、HP、豁免、速度）都回溯到其来源；拖拽装备（如卸下 +1 Con 板甲）自动重算 HP/AC/速度/潜行。
- **可借鉴**：把"每个派生数值可审计、可溯源"作为角色卡校验的领域原则——本项目已有 `characterAuditService`，可进一步建立"派生值→来源"的显式依赖图，强化 `turnMaterializationService` 的资源变更白名单校验。
- **不可照搬**：GPL-3.0 copyleft；Meteor 框架与 MongoDB 运维与现代 web 栈差异大，仅借数据建模思想。

#### C3. rsek/datasworn（MIT 模式 + CC-BY 内容，★ 162）
- **一手证据**（README）：把 Ironsworn/Starforged 规则以 JSON 形式发布的"语言无关 JSON schema 作为 source of truth"，v0.0.10（pre-release，随时 breaking）；1,626 commits，最近推送 2024-11-29；`@datasworn/core` 提供类型与 schema。
- **可借鉴**："以 JSON Schema 作为规则/世界数据的单一事实源，再生成各语言类型"，与 `seedRules.ts`/`rule_sources.content_json` 方向一致；"为第三方房规导入设计互换格式"也可迁移到本项目资源导入审核流。
- **不可照搬**：内容是 Ironsworn（非 D&D 5e），规则内容不可直接复用；内容许可含 CC-BY-NC-4.0（非商业）变体，商用前须逐条核对。

---

### D. 多租户 / 账号 / 战役私密性 / 实时协作（平台基础设施）

#### D1. agnaistic/agnai（AGPL-3.0，★ 766）
- **一手证据**（README + commits feed）："AI Roleplay Chat with Personalized Characters"，多用户多机器人；1,391 commits，最近提交 2026-06-13；明确支持自托管与多租户部署。
- **功能**：用户账号 + 每用户 AI 服务配置/生成预设（多租户）、群组对话（多用户多 bot）、角色卡人格格式（W++/SBF/Boostyle/纯文本）、lorebook、长时记忆/embedding 流水线、订阅。
- **架构**：SolidJS + Tailwind 前端，Node/TS API 后端，Python 服务承载模型/流水线；MongoDB（可选，无则匿名模式）+ Redis 分布式 WebSocket 消息。
- **可借鉴**：① 多租户账号模型（用户级认证、每用户预设/密钥隔离）——本项目当前是房间级 token，向"账号 + 房间（战役）私密性"演进时，agnai 是最佳参考；② 群组对话（多用户多 bot）对应本项目"多人共战役 + AI DM"；③ lorebook + 长时记忆流水线对应本项目世界书与 `campaignMemoryService`。
- **不可照搬**：AGPL-3.0 copyleft；MongoDB + Redis + Python 流水线的运维面比本项目 better-sqlite3 单库重得多，MVP 阶段不应照搬其基础设施；"为规模化设计"不是本项目当前诉求。

#### D2. mythal/boluo（AGPL-3.0，★ 151）
- **一手证据**（README + 仓库结构）："A chat application designed specifically for playing RPGs"；2,325 commits，最近推送 2026-08-01（活跃）；AGPL-3.0。
- **架构**：Turborepo monorepo：`apps/spa`（聊天 SPA）、`apps/server`（Rust + SQLx，离线查询检查）、`apps/site`、`apps/legacy`、`apps/storybook`；Docker Compose + Nix + GitHub Actions。
- **可借鉴**：房间制 RPG 聊天的实时消息与房间隔离模型（映射本项目 rooms + SSE/eventBus）；"以聊天为容器承载角色扮演"的产品形态与本项目文本驱动契合。
- **不可照搬**：Rust 后端与 Node/TS 技术栈不一致，仅借模型与产品形态；AGPL copyleft。

---

## 4. 对本项目可借鉴之处（汇总）

1. **结构化世界状态 + 分可见性**（NarrativeEngine-P 的 Divergence Register + `knownBy`）→ 深化 `campaignMemoryService` 与 `visibilityService` 的统一事实模型；其"两阶段记忆召回"落地 findings.md 已规划的 pre-turn 记忆侧车。
2. **记忆/状态侧车多阶段架构**（ChatArena 的 Arena/Environment/Backend/Player）→ 为"主叙事 + 记忆召回 + 表格固化"三管线提供干净的职责边界（findings.md 三侧车设计）。
3. **可审计角色卡派生值**（DiceCloud）→ 强化 `characterAuditService`，建立"派生值→来源"依赖图。
4. **战斗追踪与遭遇设计**（Dungeoneer 的先攻/状态/难度实时追踪）→ 对齐 `combatService` 与 `combatStateSyncService`。
5. **多租户账号 + 群组对话**（agnaistic/agnai）→ 从"房间级 token"演进到"账号 + 战役私密性 + 实时协作"时的主要参考。
6. **规则数据以 Schema 为单一事实源**（datasworn / foundryvtt-dnd5e 密卷）→ 规范 `rule_sources` 与 `seedRules` 的条目化、来源与许可证元数据。
7. **内容合规组织**（foundryvtt-dnd5e：软件 MIT + SRD CC-BY-4.0 + 资产独立 LICENSE）→ 本项目 `resource_import_jobs` 已记录 `source_license`/`source_hash`，可参照此模式完善导入内容的许可审计。

---

## 5. 不可照搬之处（汇总，含许可证风险）

- **AGPL-3.0 系**（SillyTavern、agnai、Dungeoneer、Fari、boluo）：AGPL 为强 copyleft，网络服务分发即触发源码开放义务。本项目若直接并入其代码或大面积复制，将被迫以 AGPL 开放本项目。→ 只做理念/架构借鉴，保持本项目自有实现（已如此处理 ST）。
- **GPL-3.0**（DiceCloud）：copyleft，库级引用也受传染。仅借数据建模思想。
- **MIT/Apache-2.0**（NarrativeEngine-P、ChatArena、TavernAI、dnd5e 代码部分、datasworn 模式部分）：可借鉴甚至引用，但须保留版权与许可声明。
- **CC-BY-4.0 / CC-BY-NC-4.0 内容**（dnd5e SRD、datasworn 内容）：内容复用须署名；NC 变体禁止商用，逐条核对后再用。
- **Owlbear Rodeo legacy**：自定义"仅个人/非商业"许可，不可在商业项目复用任何代码或美术。
- **Foundry 核心 / AI Dungeon 原始版**：闭源或已下线，不可作为代码来源。
- **架构不可照搬**：NarrativeEngine-P 的离线单机模型、ChatArena 的纯研究抽象、Dungeoneer 的 Electron 桌面打包、agnai 的 MongoDB/Redis/Python 多服务栈、DiceCloud 的 Meteor 旧栈——均与本项目 Express+SQLite 的轻量自托管定位不符。

---

## 6. 最终推荐参考项目（3–5 个）

1. **Sagesheep/NarrativeEngine-P**（MIT）——与本项目同类的"自托管 AI DM"，在记忆召回、结构化世界状态（Divergence Register + 可见性）、NPC 自主性、公平骰子、一致性 QA 上的工程实现是目前开源中最贴近本项目目标的，MIT 许可使其借鉴成本最低。
2. **agnaistic/agnai**（AGPL-3.0）——多租户账号、群组（多人多 bot）对话、lorebook + 长时记忆流水线的完整实现，是"账号/战役私密性/实时协作"方向（本项目当前最弱的一环）的头号参考。
3. **SillyTavern**（AGPL-3.0）——本项目已深度借鉴的世界书/角色卡/多段 prompt 构建范式源头；继续作为"世界书触发、角色卡、提示词编排"的规范参考（但保持自有实现，规避 AGPL 传染）。
4. **Durtur/Dungeoneer**（AGPL-3.0）——5e VTT 中结构化战斗追踪（先攻/状态/难度实时追踪）+ 房间接入控制 + 内置 SRD/房规管理的综合参考，与本项目 `combatService`/房间私密性直接对照。
5. **foundryvtt/dnd5e**（MIT 代码 + CC-BY-4.0 内容）——5e 角色卡数据模型（Actor/Item）、密卷组织结构、SRD 内容合规组织方式，作为规则库与角色卡领域建模的规范样本。

补充参考（按需）：Fari（实时协作 VTT 流程）、ChatArena（多智能体架构，已弃用，仅借思想）、DiceCloud（可审计派生值）、datasworn（规则数据 Schema 化）、boluo（房间制 RPG 聊天）。

---

## 7. 数据来源与验证方式

- GitHub 仓库页/README/LICENSE：SillyTavern、NarrativeEngine-P、agnai、Dungeoneer、Fari、ChatArena、DiceCloud、datasworn、TavernAI-v1、owlbear-rodeo-legacy、foundryvtt/foundryvtt、foundryvtt/dnd5e、boluo。
- GitHub API（repos / search / rate_limit）：星标、fork、默认分支、`pushed_at`、许可证 spdx_id、归档状态。
- GitHub commits Atom feed（`/commits/<branch>.atom`）：最近提交日期。
- 本项目一手资料：`server/src` 文件清单、`db/schema.ts`、`findings.md`（用于能力画像与借鉴点映射）。
- 所有"次要候选"（仅搜索元数据确认）已在正文明确标注，未作功能断言。

---

## 8. UI / 前端实现参考（已 clone 后检查源码）

本节基于以下临时 clone 的源码检查，clone 目录位于系统临时目录，不进入本仓库：

```text
C:\Users\Administrator\AppData\Local\Temp\dnd-reference-repos\
├── NarrativeEngine-P
├── agnai
├── SillyTavern
├── Dungeoneer
├── fari-app
└── boluo
```

### 8.1 NarrativeEngine-P：最适合借鉴“叙事工作台”布局

一手源码：

- `src/App.tsx`
- `src/components/Header.tsx`
- `src/components/ContextDrawer.tsx`
- `src/components/chat/ChatMessageList.tsx`
- `src/components/chat/ChatComposer.tsx`
- `src/index.css`

值得借鉴：

- `App` 明确把活动战役分成 `Header`、`ContextDrawer`、`ChatArea` 三个主要区域，适合本项目的“战役导航 / 剧情主区 / 状态与上下文”布局。
- `ContextDrawer` 使用固定侧栏 + 移动端全屏抽屉，并把 System Context、Rules、World Info、Chapters、Memory 分成明确标签，适合重构后的拥有者上下文工作区。
- `ChatMessageList` 将历史消息、工具调用、生成进度、失败重试和加载更多拆成独立展示职责，适合本项目的流式 AI 叙事区。
- `ChatComposer` 将输入、当前 AI preset、深度检索状态和发送/停止动作放在一个稳定的底部操作栏中，适合玩家行动提交区。
- `index.css` 使用统一颜色 token、浅色/深色主题、焦点样式、滚动条、动画和可读性规则，适合作为设计系统参考。

不应直接照搬：

- 该项目是单用户离线优先模型，布局中的状态假设不适用于账号、多玩家权限和服务端实时同步。
- 其聊天工作区功能密度很高，不能直接把所有调试和记忆控制项暴露给玩家。

### 8.2 agnai：最适合借鉴“多用户聊天壳”和可折叠导航

一手源码：

- `web/Layout.tsx`
- `web/Navigation.tsx`
- `web/pages/Chat/components/ChatPanes.tsx`
- `web/pages/Chat/components/InputBar.tsx`
- `web/pages/Chat/components/Message.tsx`

值得借鉴：

- 根据屏幕尺寸和页面类型决定导航抽屉是否默认展开，聊天页和设置页采用不同的导航策略。
- 使用 pane manager 处理角色、预设、参与者、记忆和聊天设置，说明复杂工作区可以通过“可深链接的侧面板”组织，而不是继续堆叠一个巨型页面。
- 输入栏处理草稿自动保存、OOC 切换、附件、重试和生成中状态，适合玩家行动编辑器和拥有者的 AI 控制栏。
- 账号、角色、聊天和成员管理在页面目录上有清晰分区，可参考未来统一 Web 应用的路由层次。

不应直接照搬：

- SolidJS、Parcel、MongoDB、Redis 和多服务模型明显重于当前小型私人群组的首阶段需求。
- 其大量聊天平台功能会把 DND 战役状态淹没，不应把产品做成通用 AI 聊天室。

### 8.3 Fari：最适合借鉴“结构化场景 + 标签页 + 卡片”的管理界面

一手源码：

- `lib/components/Scene/Scene.tsx`
- `lib/components/Scene/TabbedScreen.tsx`
- `lib/components/Scene/components/PlayerRow/PlayerRow.tsx`
- `lib/components/Scene/components/PlayerRow/CharacterCard/CharacterCard.tsx`

值得借鉴：

- 一个 Scene 页面同时提供场景名称、分组、保存动作、公开资料、私密资料和主持人笔记，和本项目的战役场景/可见性模型高度相关。
- `TabbedScreen` 将标签定义为数据结构，统一处理当前 tab、滚动内容和面板高度，适合作为战役资料、角色、规则、日志等二级页面的通用容器。
- `PlayerRow` 把玩家状态、角色卡、权限动作和私密标记放在一个明确的管理单元中，适合作为拥有者管理玩家的参考。
- 角色卡将可见字段、编辑权限、保存动作和派生数据放在同一张卡内，适合作为玩家工作区的人物卡设计参考。

不应直接照搬：

- MUI + Emotion 组件体系较重，第一版不需要引入完整 VTT 级 UI 框架。
- Fari 的 Fate 场景模型不能替代 D&D 5e 战斗状态模型。

### 8.4 boluo：最适合借鉴“房间/频道/成员”信息架构

一手源码：

- `apps/legacy/src/components/chat/Sidebar.tsx`
- `apps/legacy/src/components/chat/ChannelChat.tsx`
- `apps/legacy/src/components/atoms/*`

值得借鉴：

- 左侧栏可折叠，空间/房间、频道和成员列表有稳定层级。
- `useVisibleChannels` 在客户端再次按成员权限过滤可见频道，体现 UI 层也应该尊重服务端权限模型。
- 聊天区明确区分加载中、无权限查看、可读但不可发言和可发言状态，适合本项目的战役/回合/交互状态反馈。
- 将按钮、菜单、标签、面板标题和输入框拆成 atoms，适合构建本项目自己的基础组件层。

### 8.5 SillyTavern：最适合借鉴“高密度 Prompt/世界书工具”，不适合借界面代码

一手源码：

- `public/css/world-info.css`
- `public/css/streaming-display.css`
- `public/css/mobile-styles.css`
- `public/css/promptmanager.css`

值得借鉴：

- 世界书条目支持搜索、排序、启用/停用、次级关键词和滚动编辑。
- 流式输出和消息工具栏拥有明确的进行中、停止、重试和编辑状态。
- 长期运行的聊天工具通过密集但分层的控制面板承载大量 AI 参数。

不应直接照搬：

- 项目采用 AGPL-3.0，不能直接复制前端代码或样式。
- 其高密度工具型界面不适合玩家端；玩家端应只显示当前行动、剧情、角色状态和待处理交互。

### 8.6 Dungeoneer：最适合借鉴战斗控制台视觉，但技术和素材都偏旧

一手源码：

- `app/index.html`
- `app/css/style.css`
- `app/css/theme.css`
- `app/css/common.css`

值得借鉴：

- 顶部工具栏 + 先攻条 + 搜索规则/怪物 + 战斗控制区的优先级非常清楚。
- 战斗控制台把先攻、AC、被动感知、暗视、状态和怪物操作集中在同一工作区。
- 适合参考拥有者战斗控制台的“顶部回合条 + 中央战斗状态 + 右侧资料/操作”结构。

不应直接照搬：

- 旧式 DOM/全局脚本结构难以维护。
- AGPL 许可证和字体/图片素材需要单独审计。
- 地图、光照和桌面应用能力超出本项目第一阶段范围。

### 8.7 对本项目的 UI 结论

建议重构后的前端采用以下组合，而不是复制任何单个仓库：

```text
NarrativeEngine-P
  → 叙事工作台三栏结构、Context Drawer、流式剧情区

Fari
  → 场景标签页、结构化卡片、玩家/角色管理

boluo
  → 战役/频道/成员导航、权限状态反馈、基础组件拆分

Dungeoneer
  → 拥有者战斗控制台的先攻条和状态聚合

SillyTavern
  → 世界书、Prompt 调试和流式输出的交互理念
```

具体落地建议：

1. **拥有者工作区**：顶部战役状态与实时事件；左侧战役导航；中央剧情/回合/战斗主区；右侧玩家、角色、状态和 AI 运行面板。
2. **玩家工作区**：中央公开剧情与当前行动；右侧角色状态、背包和待确认交互；隐藏拥有者调试和完整上下文。
3. **二级内容**：统一使用可复用的 tabs、drawer、sheet 和 modal，不再让 `AdminPage` / `PlayerPage` 直接承载全部业务。
4. **每个异步区块都必须有状态**：加载、空状态、错误、重试、实时连接断开、锁定、等待其他玩家、AI 生成中和结算完成。
5. **先建立自己的设计系统**：颜色 token、排版、间距、按钮、表单、卡片、状态徽章和通知，不复制外部项目的 CSS。
6. **前端只消费领域查询模型和领域事件**：页面不自行推断回合状态，也不直接拼接后端原始响应。
