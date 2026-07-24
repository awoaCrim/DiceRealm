# UI Prototype（静态壳）

双击 HTML 即可在浏览器打开（`file://`），无需安装依赖、无需启动服务器。

## 页面

- [首页](index.html) — 建房 / 房间列表
- [玩家端](player.html?token=p1) — 剧情 / 人物卡 / 背包 / DM 助手
- [管理端](admin.html?room=demo) — 跑团 / 战役库 / AI 主持 / 日志 / 设置

## 文件结构

```
ui-prototype/
  index.html
  player.html
  admin.html
  README.md
  js/
    mock.js    # 内存 mock 数据
    common.js  # 公共工具
    home.js
    player.js
    admin.js
```

每页脚本顺序：`mock.js` → `common.js` → 页面脚本。均为经典 `<script src>`，无 module / React / Tailwind / Vite。

## 说明

- 数据为内存 mock，刷新后恢复初始状态
- 仅 UI 与最基础本地交互，不接后端
- 原生 HTML 控件，默认无样式框架
- 查询参数：玩家端 `?token=`，管理端 `?room=`
