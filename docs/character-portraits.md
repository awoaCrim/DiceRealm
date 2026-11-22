# 角色头像

玩家提交完整角色卡加入房间后，服务器自动登记一次人物头像生成；审核和游戏不等待图片完成。地图、队伍栏和人物资料使用同一张持久图片。图像由独立图片服务配置生成，参考 BG3 的写实头肩构图、暗背景和侧光；不上传游戏原图。没有配置、生成中或失败时，客户端使用本地非文字占位。

## 生成依据与复用

`CharacterPortraits.Describe` 从已保存的初始 `Character.Build` 和风格版本 `bg3-head-and-shoulders-v1` 生成内容身份。规范化集合顺序、换行和文字空白；不加入战役、角色实例或供应商身份。同服务端的同一初始构筑可跨房间复用。当前 HP、消耗、战利品和后续换装不改变头像；重交建卡改变构筑后生成新身份。无 Build 的旧角色只使用现存物种/职业。

图片提示只发送物种、职业、显式外观/代词、物种分支及初始装备。性格、经历等私人建卡文字仅在本机参与初始构筑身份计算，不存入头像目录或发给供应商。不发送整个战役，也不额外调用文字模型改写外貌。

`RoomService.JoinRoom`、`PartyService.Join` 与 `ResubmitCharacter` 在游戏事务提交后、锁外调用 `PortraitCatalog.Ensure`；已接受请求重放也可补登记。登记 IO 失败仍返回已成功的入场/重交结果，头像显示失败，避免将成功建卡误报为失败。原请求重放或授权 POST 可补齐登记；没有跨库原子提交承诺。

## 读取合同

`Character.portrait`、`BoardTokenView.portrait`、`BoardTokenDetail.portrait` 是可省略的尾字段。快照本人、`party.members[].character`、`character/sheet` 复用此结构；非玩家单位继续用 `iconKey`。

```json
{
  "id": "64位小写内容身份",
  "status": "ready",
  "imageUrl": "/api/v1/campaigns/{id}/characters/{actorId}/portrait/image?portraitId=...&contentHash=...",
  "contentHash": "64位PNG内容哈希",
  "width": 1024,
  "height": 1024,
  "error": "",
  "failureId": ""
}
```

状态为 `missing/unavailable/pending/generating/ready/failed/unknown`。只有 `ready` 提供图片 URL/hash/实际尺寸；不能假定供应商一定返回请求的1024×1024。`error` 为安全代码，`failureId` 标识当前失败修订。DTO 不含 prompt、供应商地址、密钥或原始异常。

路径均以 `/api/v1` 开头，使用原战役 Bearer 鉴权：

- `GET /campaigns/{id}/characters/{actorId}/portrait` 返回头像状态，纯读，不登记或启动生成。
- `GET /campaigns/{id}/characters/{actorId}/portrait/image?portraitId=...&contentHash=...` 返回 PNG，每次重新授权并核对当前角色身份和图片内容，使用 `Cache-Control: private,no-store`。
- `POST /campaigns/{id}/characters/{actorId}/portrait` 仅本人或主持可请求，返回 `{portrait,replayed}`。

未审批或被退回角色的头像只对本人和主持可见，同伴投影不附头像，直接 GET 状态或图片返回404。已批准同伴可读，不能代为请求。跨战役凭证、匿名、撤销席位或目标不取得图片权限；旧身份 URL 不能用于读取换卡后的头像。

## 补图与失败重试

已有角色在客户端显式进入/恢复冒险后，若本人状态为 `missing`，用原唯一待确认请求机制自动补登记一次；普通轮询不登记。已有其他未确认行动时优先保留原行动。新加入角色由服务端登记，无需额外客户端请求。

首次请求使用当前 GET 的 `id`：

```json
{
  "requestId": "独立UUID",
  "expectedPortraitId": "当前头像id",
  "retryFailureId": ""
}
```

已有 `pending/generating/ready` 时复用，不新增供应商调用。`failed/unknown/unavailable` 需要新 requestId 和当前 `failureId` 才明确重试一次；不得因为轮询、断线或重新加入自动重发未知调用。

原 requestId/原正文重放返回原头像身份的当前状态，`replayed=true`，不因当前构筑、归档或供应商变化而重新执行。重交后返回的原回执可能属于旧头像，客户端不能把它绑到新角色图上。

- 同请求改目标/身份/失败修订：409 `portrait_idempotency_conflict`。
- 不是当前构筑：409 `portrait_changed`。
- 失败修订缺失或不匹配：409 `portrait_failure_changed`。
- 归档/离线试跑拒绝新增生成，已就绪图片仍可读。
- 有效同伴请求别人的公开头像：403；不可见/已撤销目标：404。

## 持久化与供应商

`DataPath/portraits/{id}.json` 保存状态、请求回执及生成租约；`DataPath/portrait-images/{contentHash}.png` 保存图片。备份须连同原用量账本和存档一起包含这两处。

`PortraitWorker` 先持久化 generating/lease，再调用 `IMapImageGenerator.Generate(ImageGenerationRequest, ct)`，沿 `ConfiguredImages → OpenAiImages → ProviderBudget` 使用现有图片配置和用量。旧地图 overload 与地图 prompt 原文保持不变，不把头像塞入 MapCatalog 或旧 AssetCatalog。

每次登记只 claim 一次。服务重启将遗留 generating 转为 unknown；超时、取消等未知结果不自动补发。关闭/更换供应商不使 ready 失效。配置身份在 claim 与 HTTP 边界再次核对，变化时停止该次请求。

## 客户端与验收

头像可能在相同战役 version 内完成，刷新条件需包含 actor/character、头像 id/status/contentHash。下载必须鉴权、同源、禁重定向、校验 PNG 内容与尺寸；缓存受会话权限约束，切战役或席位清理。迟到响应不得覆盖重交或切会话后的头像。不能使用匿名资源磁盘缓存保存私人角色图。成功图片与在途读取复用；图片GET失败可用原“同步进度”重读，不重新POST生成，普通轮询不反复下载失败图片。

正确路径是入场动作登记、轮询只读、ready 绑定同一图片。把生成挂在每次 GET、用当前背包算身份，或失败后换 requestId 自动重发，都会导致重复费用或角色串图。

服务端回归入口为 `CharacterPortraitTests`：两条加入入口、重放/跨房复用、不同外貌隔离、审批隐私、真实图片 HTTP、同版 sheet/board/detail、HP/装备变化、重交与旧URL、重启 unknown、显式重试、登记 IO 恢复及原供应商协议。fake 图片只验证链路，实际画风与人物外观需要查看生成结果。
