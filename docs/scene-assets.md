# 旧场景图片兼容说明

场景生图已移除。新功能是独立的 [地图图册与生图](maps.md)，不再根据剧本场景、世界状态或行动安排图片生成。

---

### 保留与停止的行为

旧图片、视觉修订、任务文件、场景指针和历史调用计数原样保留。已经完成且文件有效的旧图片仍可显示；未完成、失败或损坏的旧资源只返回停止状态，不写回旧任务，也不会因为新服务器启动、供应商变化、启用剧本或进入场景而重新执行。

[AssetCatalog](../server/DiceRealm.Server/Infrastructure/AssetCatalog.cs) 现在只读，不依赖图片供应商，没有认领或完成任务的方法。单个损坏旧任务不会让其他战役的快照失败。没有旧图片的场景返回 `removed / scene_generation_removed`，Unity 使用中性占位，不轮询场景生成。

旧剧本的 `imagePrompt`、`preGenerate`、`styleProfile` 和 `visualConstraints` 继续接受、保存并原样导出，保证旧内容文件可读取；这些字段不再安排任何生图。不要通过填写旧字段请求地图，请在地图页填写或导入独立描述。

---

### 兼容接口

| 接口 | 当前行为 |
|---|---|
| `POST /api/v1/campaigns/{id}/scene-asset` | 鉴权和主持权限检查后返回 `410 scene_generation_removed` |
| `POST /api/v1/campaigns/{id}/assets/{assetId}/retry` | 同上，不恢复旧任务 |
| `POST /api/v1/campaigns/{id}/resources/pregenerate` | 同上，不预生成任何场景 |
| `GET /api/v1/campaigns/{id}/assets/{assetId}` | 鉴权读取旧状态；当前中性占位 ID 也可查询 |
| `POST /api/v1/campaigns/{id}/assets/{assetId}/reference` | 主持人可把旧的已就绪图片登记为当前战役参考图，不调用模型 |
| `GET /api/v1/campaigns/{id}/resources` | 保留额度与说明，`mainScenes` 为空、`canPreGenerate=false` |

旧成品的 `/assets/{hash}.png` 地址仍保持原有公开行为，以免破坏已有存档；它不适合私人素材。新地图位于独立私有目录，必须通过战役与地图 ID 鉴权下载，不会被这个兼容路由公开。

旧客户端遗留的未确认场景操作可以重发原请求，以接收明确的 410 拒绝；不能把它改成新的地图请求。新的地图生成使用自己的 UUID、版本和确认流程。

---

### 验证

[地图与兼容测试](../tests/DiceRealm.Tests/AssetTests.cs) 检查旧 pending 文件在场景进入、游戏行动及服务器重启后保持原始字节，且图片供应商调用为零；同时检查损坏旧文件隔离、停止接口、当前占位 ID 查询与存档版本不变。[资源额度测试](../tests/DiceRealm.Tests/ResourceTests.cs) 检查独立地图的权限与额度。

旧场景生图、视觉修订和预生成的验收记录保留在历史文档中，不代表当前功能仍可调用。
