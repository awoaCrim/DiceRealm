# UI Prototype Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在仓库根目录新建 `ui-prototype/`，用可双击打开的静态 HTML + 经典 script，做出 Home / Player / Admin 高保真 UI 壳与最基础本地交互。

**Architecture:** 三页 HTML 按顺序加载非 module 脚本，数据全部来自 `window.UI_MOCK.createInitialState()` 的内存副本；`window.UI_COMMON` 提供 query、Tab、文案映射与 DOM 小工具。无构建、无服务器、无 CSS 框架、不修改 `client/`。

**Tech Stack:** 原生 HTML、浏览器 JS（IIFE / 全局变量）、无 npm 依赖

**Spec:** `docs/superpowers/specs/2026-07-24-ui-prototype-shell-design.md`

**验证方式:** 无自动化测试；每任务用「双击 HTML / 在浏览器打开 file://」做手工验收（Windows 可用 `start` 打开）。

---

## File map

| 文件 | 职责 |
|------|------|
| `ui-prototype/README.md` | 中文说明：双击打开、目录、范围 |
| `ui-prototype/js/mock.js` | `window.UI_MOCK`：初始数据 + `createInitialState()` |
| `ui-prototype/js/common.js` | `window.UI_COMMON`：qs、tabs、labels、DOM helpers |
| `ui-prototype/index.html` + `js/home.js` | 首页建房与房间列表 |
| `ui-prototype/player.html` + `js/player.js` | 玩家四 Tab + Aside |
| `ui-prototype/admin.html` + `js/admin.js` | 管理五 Tab + Aside |

---

### Task 1: Scaffold + mock + common

**Files:**
- Create: `ui-prototype/README.md`
- Create: `ui-prototype/js/mock.js`
- Create: `ui-prototype/js/common.js`

- [ ] **Step 1: 创建 README**

```markdown
# UI Prototype（静态壳）

双击打开即可，无需安装依赖、无需启动服务器。

- [首页](index.html) — 建房 / 房间列表
- [玩家端](player.html?token=p1) — 剧情 / 人物卡 / 背包 / DM 助手
- [管理端](admin.html?room=demo) — 跑团 / 战役库 / AI 主持 / 日志 / 设置

## 说明

- 数据为内存 mock，刷新后恢复初始状态
- 仅 UI 与最基础本地交互，不接后端
- 原生 HTML 控件，默认无样式框架
```

- [ ] **Step 2: 创建 `js/mock.js`**

完整写入（经典 script，挂 `window.UI_MOCK`）：

```javascript
(function (global) {
  function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  var BASE = {
    rooms: [
      {
        id: 'demo',
        name: '迷雾港试玩',
        currentTurn: 3,
        status: 'waiting_for_actions',
        playerCount: 2,
        expectedPlayerCount: 4,
        createdAt: '2026-07-20T10:00:00.000Z',
        adminTokenHint: 'demo'
      }
    ],
    players: [
      { id: 'pl1', token: 'p1', name: '艾拉', roomId: 'demo' },
      { id: 'pl2', token: 'p2', name: '波林', roomId: 'demo' },
      { id: 'pl3', token: 'p3', name: '待审新兵', roomId: 'demo' }
    ],
    characters: [
      {
        id: 'ch1',
        playerId: 'pl1',
        name: '艾拉·风行',
        race: '精灵',
        className: '游侠',
        level: 3,
        background: '外乡人',
        confirmed: true,
        reviewStatus: 'approved',
        reviewComment: '',
        abilities: { str: 12, dex: 16, con: 14, int: 10, wis: 14, cha: 11 },
        skills: ['察觉', '求生', '隐匿'],
        hp: { current: 24, max: 28 },
        spellSlots: { '1': { current: 3, max: 3 } }
      },
      {
        id: 'ch2',
        playerId: 'pl2',
        name: '波林·石盾',
        race: '矮人',
        className: '战士',
        level: 3,
        background: '士兵',
        confirmed: true,
        reviewStatus: 'approved',
        reviewComment: '',
        abilities: { str: 16, dex: 12, con: 15, int: 8, wis: 11, cha: 10 },
        skills: ['运动', '威吓'],
        hp: { current: 32, max: 32 },
        spellSlots: {}
      },
      {
        id: 'ch3',
        playerId: 'pl3',
        name: '无名学徒',
        race: '人类',
        className: '法师',
        level: 1,
        background: '学者',
        confirmed: false,
        reviewStatus: 'pending_review',
        reviewComment: '',
        abilities: { str: 8, dex: 14, con: 12, int: 16, wis: 13, cha: 10 },
        skills: ['奥秘', '历史'],
        hp: { current: 8, max: 8 },
        spellSlots: { '1': { current: 2, max: 2 } }
      }
    ],
    logs: {
      public: [
        { id: 'lg1', createdAt: '2026-07-20T10:05:00.000Z', speaker: 'DM', content: '海雾吞没了码头的灯火。远处传来锚链拖地的声响。' },
        { id: 'lg2', createdAt: '2026-07-20T10:06:00.000Z', speaker: '艾拉', content: '我压低帽檐，沿着货箱阴影靠近那艘无旗双桅船。' }
      ],
      private: [
        { id: 'lg3', createdAt: '2026-07-20T10:07:00.000Z', speaker: '系统', content: '你注意到甲板上有新鲜的血迹，尚未干透。' }
      ],
      objective: [
        { id: 'lg4', createdAt: '2026-07-20T10:05:00.000Z', speaker: '系统', content: '回合 3 开始。房间状态：等待行动。' }
      ]
    },
    pendingInteractions: [
      {
        id: 'ix1',
        playerId: 'pl1',
        prompt: '哨兵回头张望——你是立刻隐入雾中，还是假装醉汉走过？',
        response: ''
      }
    ],
    currentActions: {
      pl1: { actionType: 'in_character_action', text: '沿货箱阴影接近无旗船' },
      pl2: null
    },
    combat: {
      active: true,
      units: [
        { id: 'u1', name: '艾拉', initiative: 18, status: 'healthy' },
        { id: 'u2', name: '码头打手', initiative: 12, status: 'injured' },
        { id: 'u3', name: '波林', initiative: 9, status: 'healthy' }
      ]
    },
    diceLogs: [
      { id: 'd1', createdAt: '2026-07-20T10:08:00.000Z', actor: '艾拉', expression: '1d20+5', result: 17, note: '隐匿' },
      { id: 'd2', createdAt: '2026-07-20T10:09:00.000Z', actor: 'DM', expression: '1d20+2', result: 9, note: '察觉' }
    ],
    backpack: {
      pl1: {
        currency: { gp: 42, sp: 8, cp: 15 },
        items: [
          { id: 'it1', name: '短弓', qty: 1, note: '已 equip' },
          { id: 'it2', name: '治疗药水', qty: 2, note: '标准' },
          { id: 'it3', name: '绳索 50 尺', qty: 1, note: '' }
        ]
      }
    },
    dmMessages: {
      pl1: [
        { id: 'm1', role: 'assistant', content: '需要我帮你回顾本回合可选动作，或解释某个规则吗？' }
      ]
    },
    campaignRecords: [
      { id: 'cr1', category: 'world', title: '迷雾港', summary: '终年被海雾笼罩的自由贸易港。', visibility: 'public', updatedAt: '2026-07-18' },
      { id: 'cr2', category: 'npc', title: '老舵手哈姆', summary: '知情但要价不菲的码头老人。', visibility: 'dm', updatedAt: '2026-07-19' },
      { id: 'cr3', category: 'quest', title: '无旗船的货物', summary: '查明双桅船夜间卸货的真相。', visibility: 'party', updatedAt: '2026-07-20' }
    ],
    worldBook: [
      { id: 'wb1', name: '海雾词条', content: '夜间能见度极低，远程攻击劣势。' }
    ],
    dataSources: [
      { id: 'ds1', name: '本地 PHB 摘要', type: 'file', status: 'ready' }
    ],
    aiHost: {
      styleNotes: '偏黑暗奇幻，节奏紧凑，少用陈词滥调。',
      runtime: { temperature: 0.8, maxTokens: 2048, sceneType: 'exploration' },
      presetBlocks: [
        { id: 'pb1', role: 'system', title: 'DM 核心', content: '你是严谨的 D&D 5e 地下城主……' },
        { id: 'pb2', role: 'user', title: '场景上下文', content: '（由运行时注入）' }
      ],
      promptPreview: '【system】你是严谨的 D&D 5e 地下城主……\n【user】当前场景：迷雾港码头……'
    },
    aiLogs: [
      {
        id: 'al1',
        createdAt: '2026-07-20T10:10:00.000Z',
        source: 'mainDM',
        model: 'mock-model',
        status: 'ok',
        messages: '[{"role":"system","content":"..."}]',
        response: '{"narrative":"海雾更浓了。"}'
      },
      {
        id: 'al2',
        createdAt: '2026-07-20T10:12:00.000Z',
        source: 'dmAssistant',
        model: 'mock-model',
        status: 'ok',
        messages: '[{"role":"user","content":"隐匿怎么检定？"}]',
        response: '使用敏捷（隐匿），对抗被动察觉。'
      }
    ],
    pipelineRuns: [
      { id: 'pr1', turn: 3, stage: 'narrative', status: 'done' },
      { id: 'pr2', turn: 3, stage: 'apply', status: 'pending' }
    ],
    settings: {
      aiProvider: { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-mock', model: 'gpt-mock', enabled: true },
      embeddingProvider: { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-mock', model: 'embed-mock', enabled: false }
    },
    waitingPlayers: ['波林'],
    aiTurn: {
      message: '',
      promptDraft: '请根据玩家行动推进码头潜入场景。',
      resultSummary: '（尚未生成）',
      rollbackTurns: [1, 2, 3]
    }
  };

  global.UI_MOCK = {
    BASE: BASE,
    createInitialState: function () {
      return deepClone(BASE);
    }
  };
})(window);
```

- [ ] **Step 3: 创建 `js/common.js`**

```javascript
(function (global) {
  function $(id) {
    return document.getElementById(id);
  }

  function getQuery() {
    var params = new URLSearchParams(window.location.search);
    var out = {};
    params.forEach(function (value, key) {
      out[key] = value;
    });
    return out;
  }

  function roomStatusLabel(status) {
    var map = {
      waiting_for_actions: '等待行动',
      waiting_for_interaction: '等待互动回应',
      ready_to_resolve: '待结算',
      resolving: '结算中',
      idle: '空闲'
    };
    return map[status] || status || '未知';
  }

  function combatStatusLabel(status) {
    var map = {
      healthy: '良好',
      injured: '受伤',
      bloodied: '重伤',
      defeated: '倒下'
    };
    return map[status] || status || '未知';
  }

  function actionTypeLabel(type) {
    var map = {
      in_character_action: '角色行动',
      player_question: '提问',
      observe: '观察',
      wait: '等待',
      combat_action: '战斗',
      skip: '跳过'
    };
    return map[type] || type || '行动';
  }

  function formatTime(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString('zh-CN', { hour12: false });
    } catch (e) {
      return iso;
    }
  }

  function setText(id, text) {
    var el = $(id);
    if (el) el.textContent = text == null ? '' : String(text);
  }

  function setHtml(id, html) {
    var el = $(id);
    if (el) el.innerHTML = html;
  }

  function showMessage(id, text, isError) {
    var el = $(id);
    if (!el) return;
    el.textContent = text || '';
    el.hidden = !text;
    if (text) el.setAttribute('data-kind', isError ? 'error' : 'ok');
  }

  /**
   * tabs: [{ id: 'story', buttonId: 'tab-story', panelId: 'panel-story' }, ...]
   * options.hashPrefix optional, default ''
   */
  function bindTabs(tabs, options) {
    options = options || {};
    var storageKey = options.storageKey || '';
    var defaultId = options.defaultId || (tabs[0] && tabs[0].id);

    function activate(id) {
      var found = false;
      tabs.forEach(function (tab) {
        var on = tab.id === id;
        if (on) found = true;
        var btn = $(tab.buttonId);
        var panel = $(tab.panelId);
        if (btn) {
          btn.setAttribute('aria-selected', on ? 'true' : 'false');
          if (on) btn.setAttribute('data-active', '1');
          else btn.removeAttribute('data-active');
        }
        if (panel) panel.hidden = !on;
      });
      if (!found && defaultId) return activate(defaultId);
      if (storageKey) {
        try { sessionStorage.setItem(storageKey, id); } catch (e) { /* ignore */ }
      }
      if (options.useHash) {
        var hash = '#' + id;
        if (window.location.hash !== hash) {
          history.replaceState(null, '', hash);
        }
      }
      if (typeof options.onChange === 'function') options.onChange(id);
    }

    tabs.forEach(function (tab) {
      var btn = $(tab.buttonId);
      if (!btn) return;
      btn.addEventListener('click', function () {
        activate(tab.id);
      });
    });

    var initial = defaultId;
    if (options.useHash && window.location.hash) {
      initial = window.location.hash.replace(/^#/, '') || defaultId;
    } else if (storageKey) {
      try {
        initial = sessionStorage.getItem(storageKey) || defaultId;
      } catch (e) {
        initial = defaultId;
      }
    }
    activate(initial);
    return { activate: activate };
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function uid(prefix) {
    return (prefix || 'id') + '_' + Math.random().toString(36).slice(2, 9);
  }

  global.UI_COMMON = {
    $: $,
    getQuery: getQuery,
    roomStatusLabel: roomStatusLabel,
    combatStatusLabel: combatStatusLabel,
    actionTypeLabel: actionTypeLabel,
    formatTime: formatTime,
    setText: setText,
    setHtml: setHtml,
    showMessage: showMessage,
    bindTabs: bindTabs,
    escapeHtml: escapeHtml,
    uid: uid
  };
})(window);
```

- [ ] **Step 4: 提交**

```bash
git add ui-prototype/README.md ui-prototype/js/mock.js ui-prototype/js/common.js
git commit -m "$(cat <<'EOF'
feat(ui-prototype): add scaffold, mock data, and common helpers

Introduce a file://-friendly static shell foundation with shared mock
state and DOM/tab utilities.
EOF
)"
```

---

### Task 2: Home page

**Files:**
- Create: `ui-prototype/index.html`
- Create: `ui-prototype/js/home.js`

- [ ] **Step 1: 创建 `index.html`**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>DND AI-DM · 首页（UI 壳）</title>
  <style>
    pre { white-space: pre-wrap; }
    [hidden] { display: none !important; }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>DND AI-DM</h1>
      <p>创建本地多人跑团房间，并为每位玩家隔离可见信息。（静态 UI 原型，mock 数据）</p>
    </header>

    <p id="home-message" hidden></p>

    <section aria-labelledby="create-heading">
      <h2 id="create-heading">创建房间</h2>
      <form id="create-room-form">
        <p>
          <label for="room-name">房间名称</label><br />
          <input id="room-name" name="name" required placeholder="输入房间名称" />
        </p>
        <p>
          <label for="player-count">预期玩家人数</label><br />
          <input id="player-count" name="expectedPlayerCount" type="number" min="1" max="12" value="4" />
        </p>
        <p>少于 4 名真实玩家时，系统会自动补足友好同伴 NPC。（原型仅展示文案）</p>
        <p>
          <button type="submit">创建房间</button>
        </p>
      </form>
    </section>

    <hr />

    <section aria-labelledby="list-heading">
      <h2 id="list-heading">已有房间</h2>
      <div id="room-list"></div>
    </section>
  </main>

  <script src="js/mock.js"></script>
  <script src="js/common.js"></script>
  <script src="js/home.js"></script>
</body>
</html>
```

- [ ] **Step 2: 创建 `js/home.js`**

```javascript
(function () {
  var C = window.UI_COMMON;
  var state = window.UI_MOCK.createInitialState();

  function renderRooms() {
    var root = C.$('room-list');
    if (!state.rooms.length) {
      root.innerHTML = '<p>暂无房间。</p>';
      return;
    }
    var html = '<ul>';
    state.rooms.forEach(function (room) {
      var players = state.players.filter(function (p) { return p.roomId === room.id; });
      var firstToken = players[0] ? players[0].token : 'p1';
      html += '<li>';
      html += '<p><strong>' + C.escapeHtml(room.name) + '</strong></p>';
      html += '<p>第 ' + room.currentTurn + ' 回合 · ' + C.roomStatusLabel(room.status);
      html += ' · 玩家 ' + room.playerCount + '/' + (room.expectedPlayerCount || '未设置');
      html += ' · 创建 ' + C.formatTime(room.createdAt) + '</p>';
      html += '<p>';
      html += '<a href="admin.html?room=' + encodeURIComponent(room.id) + '">进入管理</a> · ';
      html += '<a href="player.html?token=' + encodeURIComponent(firstToken) + '">进入玩家</a> · ';
      html += '<button type="button" data-delete-room="' + C.escapeHtml(room.id) + '">删除</button>';
      html += '</p>';
      html += '</li>';
    });
    html += '</ul>';
    root.innerHTML = html;

    root.querySelectorAll('[data-delete-room]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-delete-room');
        var room = state.rooms.find(function (r) { return r.id === id; });
        if (!room) return;
        if (!window.confirm('确定删除房间「' + room.name + '」？此操作会删除该房间的玩家、角色、日志和回合数据。')) return;
        state.rooms = state.rooms.filter(function (r) { return r.id !== id; });
        state.players = state.players.filter(function (p) { return p.roomId !== id; });
        C.showMessage('home-message', '已删除房间「' + room.name + '」');
        renderRooms();
      });
    });
  }

  C.$('create-room-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var name = C.$('room-name').value.trim();
    var count = Math.max(1, Number(C.$('player-count').value) || 1);
    if (!name) {
      C.showMessage('home-message', '请输入房间名称', true);
      return;
    }
    var id = C.uid('room');
    state.rooms.unshift({
      id: id,
      name: name,
      currentTurn: 0,
      status: 'idle',
      playerCount: 0,
      expectedPlayerCount: count,
      createdAt: new Date().toISOString()
    });
    C.$('room-name').value = '';
    C.showMessage('home-message', '已创建房间「' + name + '」（mock，未跳转；可用下方链接进入 demo 或手动改 URL）');
    renderRooms();
  });

  renderRooms();
})();
```

- [ ] **Step 3: 手工验收**

打开 `ui-prototype/index.html`（资源管理器双击，或 `start ui-prototype/index.html`）。

Expected:
- 看到 demo 房间与创建表单
- 创建新房间后列表增加
- 删除弹出 confirm，确认后消失
- 「进入管理 / 进入玩家」链接指向 `admin.html?room=demo` / `player.html?token=p1`（后两页本任务可 404，Task 3/4 再补）

- [ ] **Step 4: 提交**

```bash
git add ui-prototype/index.html ui-prototype/js/home.js
git commit -m "$(cat <<'EOF'
feat(ui-prototype): add home page with mock room CRUD

Static create/list/delete room UI with links into admin and player shells.
EOF
)"
```

---

### Task 3: Player page shell + all tabs

**Files:**
- Create: `ui-prototype/player.html`
- Create: `ui-prototype/js/player.js`

- [ ] **Step 1: 创建 `player.html` 骨架**

页面需包含：Topbar、Sidebar 四按钮、Main 四 panel、Aside 五块信息。要点结构如下（实现时写完整可用 HTML，id 必须与 `player.js` 一致）：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>玩家端 · UI 壳</title>
  <style>
    pre { white-space: pre-wrap; }
    [hidden] { display: none !important; }
    .shell { width: 100%; }
    .shell td { vertical-align: top; }
    .sidebar { width: 12rem; }
    .aside { width: 16rem; }
  </style>
</head>
<body>
  <p><a href="index.html">← 回首页</a></p>
  <header id="player-topbar">
    <h1>玩家端</h1>
    <p id="player-topbar-meta"></p>
  </header>
  <p id="player-message" hidden></p>

  <table class="shell">
    <tr>
      <td class="sidebar">
        <nav aria-label="玩家分区">
          <p><button type="button" id="tab-story" aria-selected="true">剧情</button></p>
          <p><button type="button" id="tab-character">人物卡</button></p>
          <p><button type="button" id="tab-backpack">背包</button></p>
          <p><button type="button" id="tab-dm">DM 助手</button></p>
        </nav>
      </td>
      <td class="main">
        <section id="panel-story">
          <h2>剧情</h2>
          <p>
            <button type="button" id="log-tab-public">公开日志</button>
            <button type="button" id="log-tab-private">私密日志</button>
          </p>
          <div id="story-log-list"></div>
          <hr />
          <h3>待回应互动</h3>
          <div id="interaction-list"></div>
          <hr />
          <h3>提交行动</h3>
          <p id="action-disabled-reason"></p>
          <p>
            <label for="action-type">行动类型</label>
            <select id="action-type">
              <option value="in_character_action">角色行动</option>
              <option value="player_question">提问</option>
              <option value="observe">观察</option>
              <option value="wait">等待</option>
              <option value="combat_action">战斗</option>
              <option value="skip">跳过</option>
            </select>
          </p>
          <p>
            <label for="action-text">行动内容</label><br />
            <textarea id="action-text" rows="4" cols="60"></textarea>
          </p>
          <p><button type="button" id="action-submit">提交行动</button></p>
        </section>

        <section id="panel-character" hidden>
          <h2>人物卡</h2>
          <div id="character-panel-body"></div>
        </section>

        <section id="panel-backpack" hidden>
          <h2>背包</h2>
          <p id="backpack-currency"></p>
          <div id="backpack-items"></div>
          <h3>添加物品</h3>
          <form id="backpack-add-form">
            <p><label>名称 <input id="item-name" required /></label></p>
            <p><label>数量 <input id="item-qty" type="number" min="1" value="1" /></label></p>
            <p><label>备注 <input id="item-note" /></label></p>
            <p><button type="submit">添加</button></p>
          </form>
        </section>

        <section id="panel-dm" hidden>
          <h2>DM 助手</h2>
          <div id="dm-messages"></div>
          <form id="dm-form">
            <p><textarea id="dm-input" rows="3" cols="60" required placeholder="向 DM 助手提问"></textarea></p>
            <p><button type="submit">发送</button></p>
          </form>
        </section>
      </td>
      <td class="aside">
        <h2>侧栏</h2>
        <section>
          <h3>角色快览</h3>
          <div id="aside-character"></div>
        </section>
        <section>
          <h3>本回合行动</h3>
          <div id="aside-action"></div>
        </section>
        <section>
          <h3>房间状态</h3>
          <div id="aside-room"></div>
        </section>
        <section>
          <h3>战斗态势</h3>
          <div id="aside-combat"></div>
        </section>
        <section>
          <h3>最近骰点</h3>
          <div id="aside-dice"></div>
        </section>
      </td>
    </tr>
  </table>

  <script src="js/mock.js"></script>
  <script src="js/common.js"></script>
  <script src="js/player.js"></script>
</body>
</html>
```

- [ ] **Step 2: 创建完整 `js/player.js`**

实现要点（写完整可运行代码，勿留 TODO）：

1. `state = UI_MOCK.createInitialState()`，`token = getQuery().token || 'p1'`
2. 解析 `player`、`character`、`room`；找不到 token 时在 `#player-message` 报错并停止
3. `bindTabs` 绑定 story/character/backpack/dm，`useHash: true`，`defaultId: 'story'`
4. `renderAll()` 调用：
   - topbar meta：玩家名、房间名、回合、状态
   - 日志列表（公开/私密切换本地变量 `logTab`）
   - 互动列表：每条 textarea + 提交 → 写入 response，从 pending 移除或标记已回应，并追加一条私密日志
   - 行动提交：无角色 confirmed 时禁用并写原因；成功则 `state.currentActions[player.id] = { actionType, text }`，提示成功
   - 人物卡：`approved` 显示属性/技能/HP；`pending_review` 只读 + 文案；否则显示简易建卡表单（姓名/种族/职业/背景 + 提交审核 → `pending_review`）
   - 背包：渲染 currency + 表格；添加 form 推入 items；每行删除按钮
   - DM：渲染 messages；发送后 push user + 固定 assistant 回复（如「（mock）已记录你的问题，正式环境将由 DM 助手回答。」）
   - Aside 五块全部从 state 填充

行动类型 label 用 `C.actionTypeLabel`。

- [ ] **Step 3: 手工验收**

打开 `ui-prototype/player.html?token=p1`。

Expected:
- 顶栏显示艾拉 / 迷雾港试玩
- 剧情可见公开日志与互动；提交行动后侧栏「本回合行动」更新
- 人物卡显示已通过角色
- 背包可添加/删除
- DM 可本地对话
- `?token=p3` 人物卡为审核中；非法 token 有错误提示
- 侧栏有战斗与骰点
- hash 切换 Tab（`#backpack`）可用

- [ ] **Step 4: 提交**

```bash
git add ui-prototype/player.html ui-prototype/js/player.js
git commit -m "$(cat <<'EOF'
feat(ui-prototype): add player shell with four tabs and aside

Mock-driven story, character, backpack, and DM assistant panels with
local-only interactions.
EOF
)"
```

---

### Task 4: Admin page shell + all tabs

**Files:**
- Create: `ui-prototype/admin.html`
- Create: `ui-prototype/js/admin.js`

- [ ] **Step 1: 创建 `admin.html`**

结构与 Player 类似，三列 shell：

**Sidebar 按钮 id：** `tab-play` / `tab-campaign` / `tab-aihost` / `tab-ailog` / `tab-settings`  
**Panel id：** `panel-play` / `panel-campaign` / `panel-aihost` / `panel-ailog` / `panel-settings`

**跑团 panel 必备区块 id：**
- `#play-status` 状态条
- `#play-players` 玩家管理（加人名输入、期望人数、列表含玩家链接、跳过按钮）
- `#play-reviews` 待审角色 通过/拒绝
- 日志切换按钮 + `#play-log-list`
- AI 操作：`#ai-prompt-draft`、`#ai-generate`、`#ai-send`、`#ai-apply`、`#ai-message`、`#ai-result`、`details#ai-prompt-details`
- 回档：`#rollback-select` + `#rollback-btn`

**战役库：** 子 Tab 按钮 records/sources/worldbook；`#campaign-search`、`#campaign-category`、`#campaign-list`、`#campaign-detail`、新建表单

**AI 主持：** 子 Tab style/debug/assistant；风格 textarea、runtime 字段、预设块列表、`#prompt-preview`、助手 provider 表单 + 保存/测试

**日志：** `#ai-log-table`、`#pipeline-list`

**设置：** AI / Embedding 字段 + 保存/测试按钮 + `#settings-message`

**Aside：** 子 Tab 按钮 players/characters/combat/dice；对应 panel；角色列表点击显示摘要

顶栏：`#admin-topbar-meta`、回首页链接、`#admin-message`

script 顺序：`mock.js` → `common.js` → `admin.js`

- [ ] **Step 2: 创建完整 `js/admin.js`**

实现要点：

1. `roomId = getQuery().room || 'demo'`；过滤 room / players / characters
2. 主 Tab `bindTabs` + `useHash: true`；战役库与 AI 主持、Aside 用各自 `bindTabs`（可不写 hash，避免冲突；主 hash 优先）
3. **跑团**
   - 加人：push player，更新 `room.playerCount`
   - 期望人数：写 `room.expectedPlayerCount`
   - 跳过：message「已模拟跳过 xxx」
   - 审核通过/拒绝：改 `reviewStatus` / `confirmed`
   - 日志切换 objective/public/player
   - AI 按钮：生成 → 改 `resultSummary` 与 message；发送/应用仅改 message；回档改 message
4. **战役库**：列表过滤 category+search；点击填详情；新建 push `campaignRecords`
5. **AI 主持**：编辑 runtime/style 仅内存；保存/测试 → 模拟成功文案；渲染 preset 与 promptPreview
6. **日志**：表格渲染 `aiLogs`，行内 `details` 显示 messages/response；pipeline 简表
7. **设置**：绑定 settings 字段；保存/测试 → `#settings-message`
8. **Aside**：玩家链接 `player.html?token=`；角色摘要；战斗表；骰点列表

- [ ] **Step 3: 手工验收**

打开 `ui-prototype/admin.html?room=demo`。

Expected:
- 五主 Tab 可切换，hash 可用
- 跑团能加人、改期望人数、审核待审角色、切换日志、点 AI 按钮有文案反馈
- 战役库能搜/筛选/新建/看详情
- AI 主持三子 Tab 与预览可见
- 日志与流水线有 mock 行
- 设置保存出成功文案
- Aside 四子 Tab 有内容；玩家链接能进 player 页

- [ ] **Step 4: 提交**

```bash
git add ui-prototype/admin.html ui-prototype/js/admin.js
git commit -m "$(cat <<'EOF'
feat(ui-prototype): add admin shell with five tabs and aside

Mock-driven play, campaign DB, AI host, logs, and settings panels for
the static UI prototype.
EOF
)"
```

---

### Task 5: End-to-end smoke + README polish

**Files:**
- Modify: `ui-prototype/README.md`（若验收中发现缺说明）
- 可能微调：任意 `ui-prototype/**` 的小 bug

- [ ] **Step 1: 端到端手测清单（全部勾过）**

1. 双击 `index.html` 打开（不启服务器）
2. 创建房间 → 列表出现 → 删除 confirm
3. 从 demo「进入管理」→ admin 加载
4. 从 demo「进入玩家」→ player 加载
5. Player：四 Tab + 行动/背包/DM 本地反馈
6. Admin：五 Tab + Aside + 审核/战役新建
7. 浏览器控制台无 failed network 到后端 API
8. 确认无 `type="module"`、无 React/Tailwind 引用

- [ ] **Step 2: 若有 bug，最小修复后提交**

```bash
git add ui-prototype
git commit -m "$(cat <<'EOF'
fix(ui-prototype): polish smoke-test findings

Keep the static shell file://-openable and aligned with the design spec.
EOF
)"
```

若无修改可跳过 commit。

- [ ] **Step 3: 最终核对 success criteria（对照 spec §10）**

全部满足即完成。

---

## Spec coverage checklist

| Spec 项 | Task |
|---------|------|
| `ui-prototype/` 独立目录 + README | 1, 5 |
| mock.js / common.js / 三页 js | 1–4 |
| file:// 经典 script 顺序 | 1–4 |
| Home 建房列表 | 2 |
| Player 四 Tab + Aside | 3 |
| Admin 五 Tab + Aside | 4 |
| 无 CSS 框架、仅极少 inline | 2–4 |
| 刷新回 mock 初始态 | mock `createInitialState` 每页新建 |
| 不改 client / 无 workspaces | 全程 |
| 手工验收 success criteria | 5 |

## Placeholder / consistency notes

- 全局名统一：`window.UI_MOCK`、`window.UI_COMMON`
- Query：`room`、`token`
- 主 Tab hash：player 用 `story|character|backpack|dm`；admin 用 `play|campaign|aihost|ailog|settings`
- 无自动化测试任务（spec 明确不做）
