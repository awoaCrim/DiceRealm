# 休息来源选择

## 1. 范围

`AdvancementRestChoices` 拥有 High Elf、Wizard Spell Mastery、Druid Land、Energy Resistance Boon 的长休重选。只改变本人实际取得来源，不重建 Build 或取得历史，不恢复资源，不代替施法效果执行。

## 2. 签名

`CharacterPlayEngine.Resolve` 的既有 `character/commands` 接收 `operation=rest-choice,key=<key>,value=1,mode=normal,choices=<IDs>`，沿用 requestId/expectedVersion。角色卡可空 `restChoices` 为 `SheetRestChoice(Key,Label,Count,Options,Selected,Available,Reason)`；PlayState 可空 `RestChoicesUsed` 记录本次已确认的来源。旧缺省允许，不改原请求指纹。

## 3. 契约

长休由DM通过[全队休整](party-rest.md)发起，为每位有效成员清 used 和 PreparedClasses、打开其 PreparationOpen；prepare/rest-choice 保留本人尚有未处理来源或职业准备的窗口，本人其他行动关闭，队友行动不得清掉别人的窗口。法术精通是一个选择组，最多替换一个同环且动作施法的法术，需持有法术书；不能拆为两个独立确认。地貌按 Druid 等级重建唯一 subclass 来源。恩惠移除旧选择后重新合并其他来源，不能删除与种族重叠的抗性。高等精灵保留施法属性及其他同名授予。

v11 的候选冻结确切来源和选项；`CharacterActionIntent.ChoiceIds` 为服务器生成的逗号串以保持 record 值相等，不从模型接收任意参数。角色命令仍需 own PendingIntent，不能直接执行。v0..10 的候选目录不增加休息选项。工作台的逻辑端点 character-rest-choice 仅映射这一个操作；冻结本人 ID/版本/草稿修订，成功／原请求重试仅清匹配修订。

## 4. 校验与错误

无所有权、数量或选项不合法 → `invalid_rest_choice`；窗口关闭、战斗／其他等待、角色不能行动或缺法术书 → `character_unavailable`。授权后读和保存前检查 used：非空时最多四个、无重复、allowlist 且实际拥有来源；损坏 → 409 `invalid_rest_choice_state`，保留原件。既有 stale_version/idempotency_conflict 顺序保持。

## 5. 正常、兼容、拒绝

正常：长休→职业准备→精灵戏法确认，或反序；同名其他来源保留。兼容：一级角色/旧 PlayState 无 used 可读，不凭 GET 打开窗口。拒绝：队友替本人选、一次换两个精通法术、重新长休前重复确认、利用模型自动同意。

## 6. 验证

`AdvancementRestChoiceTests` 核对四来源、窗口两种顺序、未来升级、其他来源重叠、消耗不变及坏 marker；`AdvancementRestChoiceHttpTests` 核对真实 long rest、重开等待、不同 UUID 竞态、原回执与跨席位；`AdvancementRestChoicePiTests` 用真实 Node/Pi/MCP + fake 模型核对候选→本人确认→重开续接、v10 排除和 v11 指纹。工作台 rest-choice-model/API/恢复测试加真实浏览器覆盖未确认预览、提交丢响应／原样重试和服务重开；不冒充原生 Unity 验收。

## 7. 错误与正确

错误：职业准备成功即关闭所有休息来源；或把旧 Build 重跑并覆盖 HP／资源。正确：每个来源独立记已用、共享真实长休窗口，在唯一来源记录上替换并保持其他状态。错误：把无效 2xx 清 pending；正确：验证 resolution、匹配角色与递增版本，未知仍保存原端点／正文／UUID。
