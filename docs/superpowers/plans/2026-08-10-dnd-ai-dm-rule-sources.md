# Phase 5 规则资料迁移

**日期：** 2026-08-10  
**状态：** 已实现，待并入 Phase 5 总 cutover

## 目标

建立规则来源与许可证登记边界，为后续规则检索/导入审核提供稳定 provenance；在获得明确许可证和署名边界之前，系统不上传、不保存、也不返回第三方规则正文。

## 数据模型

`011_rule_sources.sql` 创建不可变 `platform_rule_sources`，只保存：

- `source_name`
- `version`
- `license`
- `attribution`
- `content_hash`（外部文件 SHA-256）
- `scope`：`platform` / `campaign` / `user`
- 适用目标与创建审计元数据

表中没有 `content`、`body`、`text`、JSON 正文等列。scope/target 由 CHECK 约束配对；每个 scope 分别建立“来源名称 + 版本”和“内容哈希”两个 partial unique index，避免同范围重复版本或同一外部内容被换名重复登记。

## 适用范围

- `platform`：全局平台来源；只允许可信服务端入口登记，战役 HTTP 接口不能创建。
- `campaign`：只适用于当前战役。
- `user`：属于当前 Owner，在该 Owner 的所有战役中可见。

Owner 页的有效列表为：全部 platform 来源 + 当前 campaign 来源 + 当前 Owner 的 user 来源。Player 无权读取或写入。

## HTTP 与客户端

- `GET /api/campaigns/:campaignId/rules/sources`
- `POST /api/campaigns/:campaignId/rules/sources`
- Owner 路由：`/campaigns/:campaignId/owner/rules`
- 导航名称：`规则资料`

POST 只接受 metadata-only 严格 contract。额外字段（包括规则正文）或缺失/非法 provenance 统一返回 `INVALID_RULE_SOURCE`（422）。页面只提供来源、版本、范围、许可证、署名、SHA-256 输入，不提供正文输入或上传入口。

## 不可变与哈希语义

本切片没有 update/delete 路由。需要修订来源时必须登记新的版本/哈希记录，已有战役绑定语义不会被静默改写。

`content_hash` 是由用户在本机对外部文件计算的 SHA-256 身份标识；因为正文不会进入服务端，服务端只能验证格式与重复身份，不能重新计算文件哈希。

## 错误码

- contracts：`packages/contracts/src/errors.ts`
- HTTP map：`server/src/platform/http/AppError.ts`
- 新码：`INVALID_RULE_SOURCE` → HTTP 422

## 验证覆盖

- Contracts：metadata-only 严格输入/输出、错误码同步。
- Migration：表列、无正文列、scope/target CHECK、SHA-256 CHECK、partial unique、011 单次应用。
- Service：platform/campaign/user 有效投影、跨战役隔离、owner-only、非法/重复来源映射。
- HTTP：owner/player 权限、正文额外字段拒绝、脱敏 DTO、422 错误 envelope。
- Client：Owner 导航、来源列表、登记表单、无规则正文输入。
- Browser：真实 Owner 页面登记 metadata 并验证页面不存在规则正文输入。
