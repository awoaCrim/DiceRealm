# 房间创建、加入与首次设定

## 使用顺序

1. 主持在工作台只填写房间名称并创建。此时只有主持席位，没有预设玩家角色，也没有默认剧本或提示词。
2. 创建后进入内容准备，选择自己的剧本 JSON，填写或导入原叙事提示词；可选导入方法文件。明确确认后首次启用。后续叙事设定继续使用原有独立版本的保存、发布、启用功能。
3. 在工作台左侧「邀请玩家」页（`#/room`）设置共享加入密码并开启加入，已有玩家进入后仍可从此页邀请。首次开启时分配固定的8位房间号，换密码和暂时关闭加入都不换号。密码8–128字符，空格属于密码的一部分；不能只含空白或控制字符。服务器不会返回已保存密码，忘记时设置新密码。
4. 玩家首次在网页 `/play/`「加入房间」（或 Unity「冒险 → 加入房间」）填写房间号与共享密码，在客户端完整建卡、复核并采用，然后提交。所有成员使用同一房间密码，但各自取得独立的私有席位连接；仍须主持批准角色后参与冒险。
5. 未确认提交只重试原请求。关闭加入或换密码不踢出已有成员；接受过的原加入请求仍可凭原席位凭证确认结果。撤销席位后不能借旧请求恢复权限。
6. 回到玩过的房间：游戏主页「我的房间」选择对应房间，使用原角色和原席位继续，无需重输共享密码或建卡。列表是本机加入记录，不是所有服务器的公开房间目录；重启后仍保留。切换失败保持原连接，原未确认行动须先恢复。

客户端的服务器地址在设置的连接页中，与房间号分开。房间号不是互联网服务器发现服务；成员必须连接同一服务。当前运行包只监听本机，远程多人部署仍需另行配置安全的 HTTPS 服务，不自动开放监听或防火墙。

## 草稿和恢复

首次设定的表单草稿保存在当前标签页内存，切换页面可以恢复，刷新或关闭标签页不保证保留；可下载或载入显式备份。它不冒充已有内容作者的 IndexedDB 持久草稿。原文文件保留 CRLF 等原始字节所表示的文本，不因 textarea 读取而静默规范化。提交前冻结本地修订和战役版本；旧版本或确认期间编辑必须重新确认，不自动换版本。

已发送的首次设定和房间设置走工作台既有 sessionStorage 原请求队列。确认成功只清除对应修订，之后刷新失败也不复活旧稿。房间密码属于敏感信息：后端只存慢哈希和随机盐，但尚待确认的完整原请求会保存在本机恢复记录中；不要公开或分享浏览器存储、客户端 profile 或连接文件。成功后密码框清空。

Unity 建卡草稿按原本机所有者保存，重新打开编辑使旧采用失效；网页草稿与席位凭证保存在本机浏览器 localStorage，规则修订号变化时草稿重新开始。网页加入请求在发送前保存，结果未确认时只重试原请求。背景加点现在位于属性页，起源页仅选择背景及显示其授予内容；更换背景会清除旧加点，不能沿用无效采用。展示翻译不改变 canonical ID、能力来源或服务端规则。

## HTTP 契约

新端点不替换旧 `/campaigns`、`/campaigns/from-content` 或一次性邀请协议。旧战役不静默转换，旧席位与已接受回执保持。

| 方法与路径 | 字段与结果 |
|---|---|
| `POST /api/v1/rooms` | 仅 `{name}`；201返回主持连接和无角色快照，`content.initialSetup=true` |
| `POST /api/v1/campaigns/{id}/adventure/setup` | 主持：`{requestId,expectedVersion,adventure,prompt,methods}`；methods项为`{id,description,content}`；完整验证后同事务首次启用，返回ActionResponse |
| `GET /api/v1/campaigns/{id}/room` | 主持：`{roomNumber,enabled,version}`；未启用过时号码为空；GET不初始化索引或密码 |
| `POST /api/v1/campaigns/{id}/room` | 主持：`{requestId,expectedVersion,enabled,password}`；开启必须给合法新密码，关闭时password为空；返回ActionResponse，使用游戏版本 |
| `POST /api/v1/rooms/join` | 无Bearer：`{roomNumber,password,requestId,accessToken,build}`；必须完整build及客户端独立随机64hex accessToken；返回CreatedCampaign，snapshot.id才是真实战役ID |

初次创建没有幂等凭证找回合同；未知创建结果不得自动再创建。首次设定使用 `InitialAdventureSetup` 标识，仅新 `/rooms` 创建的未开始房间有资格。授权后先查原回执，再检查版本和首次资格；剧本、原prompt、方法、profile、启用和清标识同事务提交。非法输入/非主持/旧房间没有半份设定；已有玩家席位与审核状态保持。旧内容激活不能旁路新房间的首次设定。

共享密码只授权新入房，不替代席位鉴权。目录 `rooms.sqlite` 是唯一号码到战役的索引，密码存于战役；首次写预留号可能先于战役提交，失败的孤立预留无访问权，重试复用原号，不分配给别人。旧房间索引丢失拒绝，不在GET修复。停服备份整个数据目录，不单独删索引。

新加入在战役事务内检查当前密码、归档、容量、接纳地点和完整BuildEvaluator，任何拒绝均无半角色。无角色主持最多四个玩家；旧host玩家仍沿原总人数限制。接受回执绑定规范化requestId、原payload指纹和独立席位凭证，换密码/关闭后仍可确认；改payload返回409冲突，撤销席位仍拒绝。

匿名加入正文上限64KiB，每网络peer每分钟20次、进程全局每分钟120次，不信任转发头；429带Retry-After，客户端保留原请求。不存在房间、未绑定的预留、错误密码和关闭的新加入均统一401 `room_access_denied`，不返回房间或角色资料。客户端只有此明确拒绝才允许清原错密请求重填；超时、429、5xx、坏成功响应仍保留原字节。`PendingJoinStore`旧无schema记录继续原邀请路径；新schemaVersion=2显式保存`rooms/join`，不能把8位房间号当战役UUID。

## 实现与验证入口

所有者：[RoomService](../server/DiceRealm.Server/Application/RoomService.cs)、[InitialAdventureService](../server/DiceRealm.Server/Application/InitialAdventureService.cs)、[RoomDirectory](../server/DiceRealm.Server/Infrastructure/RoomDirectory.cs)、工作台`room-settings.js`/`initial-adventure.js`、Unity`AdventureParty`/`PendingJoinStore`。

自动回归：`RoomTests`、`InitialAdventureTests`、`room-settings.test.js`、`initial-adventure.test.js`、`RoomJoinSyncTests`、`FullCharacterBuilderTests`。测试使用本机供应商替身，不能作为在线语言或制图质量证明。AI按需地图的用途、未标定与恢复边界见[地图协议](maps.md)。
