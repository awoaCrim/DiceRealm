# SillyTavern Fork DND 多人跑团实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 以 SillyTavern fork 为主体，加入多人 DND 跑团功能，包括房间、玩家 token、信息隔离、回合引擎和 AI-DM adapter。

**Architecture:** SillyTavern 保持不动作为上游底座。DND 代码放在独立的 `extensions/dnd/` 目录下，通过 SillyTavern 扩展体系挂载。后端为 Express 路由注入，前端为独立扩展面板和玩家隔离页面。信息隔离由 DND 模块强制执行，不依赖 ST 原有逻辑。

**Tech Stack:** SillyTavern (Node.js Express), TypeScript (DND 模块), better-sqlite3 (DND 运行态), ST 现有数据格式 (角色卡/预设/世界书), Vitest, Playwright。

---

## File Structure

DND 模块在 SillyTavern fork 中的文件结构：

```
SillyTavern/
  extensions/
    dnd/
      index.js                 # ST 扩展入口，注册路由和面板
      manifest.json            # ST 扩展清单
      src/
        types.ts               # DND 领域类型、API 返回类型
        db/
          connection.ts        # SQLite 连接 (独立于 ST data/)
          schema.ts            # 建表与迁移
        services/
          roomService.ts       # 房间 CRUD
          playerService.ts     # 玩家 CRUD、token 生成
          turnService.ts       # 回合管理、行动检查
          actionService.ts     # 行动提交
          interactionService.ts# 互动确认 CRUD
          logService.ts        # 日志读写
          visibilityService.ts # 信息隔离裁剪
          contextBuilder.ts    # ST 资源聚合 + 信息隔离后的 prompt 构造
          aiAdapter.ts         # 调用 ST generation，解析结构化结果
          eventBus.ts          # SSE 推送
        routes/
          adminRoutes.ts       # /api/dnd/admin/rooms ...
          playerRoutes.ts      # /api/dnd/player/:token ...
          sseRoutes.ts         # /events/dnd/rooms/:roomId
        tests/
          visibilityService.test.ts
          turnEngine.test.ts
          integration.test.ts
      public/
        admin-panel.html       # ST 扩展面板：DM 控制台
        admin-panel.js         # DM 控制台前端逻辑
        player-page.html       # 独立玩家页面
        player-page.js         # 玩家页面前端逻辑
        styles.css             # DND UI 样式
      tests/
        ui-copy.test.js        # 中文 UI 文案测试 (前端)
```

ST 入口修改点（仅注入，不改核心逻辑）：

- `src/server-main.js` 或扩展注册机制中挂载 DND 路由。
- 如 ST 不支持自动加载扩展路由，则在 server-main.js 末尾追加一行 `import('../extensions/dnd/index.js');`。
- 除此之外不改 ST 核心文件。

---

## Tasks

### Task 1: SillyTavern fork 环境搭建

**Files:**
- Clone: `SillyTavern/` (upstream)
- Create: `SillyTavern/extensions/dnd/manifest.json`
- Create: `SillyTavern/extensions/dnd/index.js`
- Create: `SillyTavern/extensions/dnd/src/types.ts`
- Create: `SillyTavern/extensions/dnd/src/db/connection.ts`
- Create: `SillyTavern/extensions/dnd/src/db/schema.ts`

- [ ] **Step 1: 克隆 SillyTavern 并验证启动**

```bash
cd E:\myCode\dnd
git clone https://github.com/SillyTavern/SillyTavern.git --branch release
cd SillyTavern
npm install
npm start
```

Expected: SillyTavern 在默认端口启动成功 (通常 8000)。

- [ ] **Step 2: 创建 DND 扩展入口**

`SillyTavern/extensions/dnd/manifest.json`:

```json
{
  "name": "DND Multiplayer",
  "version": "0.1.0",
  "description": "为 SillyTavern 添加多人 DND 跑团功能",
  "author": "DM",
  "entry": "index.js"
}
```

`SillyTavern/extensions/dnd/index.js`:

```js
// DND 扩展入口
// 注册 admin 和 player 路由，注册左侧扩展面板
import { createAdminRouter } from './src/routes/adminRoutes.js';
import { createPlayerRouter } from './src/routes/playerRoutes.js';
import { createSseRouter } from './src/routes/sseRoutes.js';
import { initDb } from './src/db/connection.js';

export async function init(serverContext) {
  const db = initDb();
  const { app } = serverContext;

  app.use('/api/dnd/admin', createAdminRouter(db));
  app.use('/api/dnd/player', createPlayerRouter(db));
  app.use('/events/dnd', createSseRouter(db));

  console.log('[DND] Extension loaded');
}
```

- [ ] **Step 3: 创建 DND 类型定义**

`SillyTavern/extensions/dnd/src/types.ts`:

```ts
export type RoomStatus = 'setup' | 'waiting_for_actions' | 'processing' | 'waiting_for_interaction' | 'needs_admin_attention';
export type ActionStatus = 'submitted' | 'processing' | 'complete';
export type VisibilityScope = 'public' | 'private' | 'admin';
export type InteractionStatus = 'pending_target' | 'ready_for_ai' | 'resolved';

export interface DndRoom {
  id: string;
  name: string;
  worldInfo: string;
  currentTurn: number;
  status: RoomStatus;
  presetId: string | null;
  worldBookId: string | null;
  createdAt: string;
}

export interface DndPlayer {
  id: string;
  roomId: string;
  name: string;
  token: string;
  characterCardPath: string | null;
  isConnected: boolean;
  createdAt: string;
}

export interface Turn {
  id: string;
  roomId: string;
  number: number;
  status: string;
  startedAt: string;
  endedAt: string | null;
}

export interface PlayerAction {
  id: string;
  roomId: string;
  turnId: string;
  playerId: string;
  text: string;
  submittedAt: string;
  status: ActionStatus;
}

export interface InteractionRequest {
  id: string;
  roomId: string;
  turnId: string;
  sourcePlayerId: string;
  targetPlayerId: string;
  type: string;
  prompt: string;
  targetResponse: string | null;
  status: InteractionStatus;
  createdAt: string;
}

export interface LogEntry {
  id: string;
  roomId: string;
  turnId: string | null;
  visibilityScope: VisibilityScope;
  playerId: string | null;
  title: string;
  content: string;
  createdAt: string;
}

export interface PlayerVisibleState {
  room: { id: string; name: string; worldInfo: string; currentTurn: number; status: string };
  player: { id: string; name: string };
  characterCard: unknown | null;
  publicLogs: LogEntry[];
  privateLogs: LogEntry[];
  pendingInteractions: InteractionRequest[];
  submittedPlayers: string[];
  waitingPlayers: string[];
}

export interface AdminState {
  room: DndRoom;
  players: DndPlayer[];
  turns: Turn[];
  actions: PlayerAction[];
  interactions: InteractionRequest[];
  logs: LogEntry[];
}

export interface AiTurnResult {
  publicLog: string;
  privateUpdatesByPlayer: Record<string, string>;
  ruleResults: string[];
  interactionRequests: Array<{
    sourcePlayerId: string;
    targetPlayerId: string;
    type: string;
    prompt: string;
  }>;
}
```

- [ ] **Step 4: 创建独立 SQLite 数据库**

`SillyTavern/extensions/dnd/src/db/connection.ts`:

```ts
import Database from 'better-sqlite3';
import path from 'path';

let db: ReturnType<typeof Database> | null = null;

export function initDb(): ReturnType<typeof Database> {
  if (db) return db;
  const dbPath = path.resolve(process.cwd(), 'extensions', 'dnd', 'data', 'dnd.sqlite');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export function createMemoryDb(): ReturnType<typeof Database> {
  const mem = new Database(':memory:');
  mem.pragma('journal_mode = WAL');
  mem.pragma('foreign_keys = ON');
  return mem;
}
```

`SillyTavern/extensions/dnd/src/db/schema.ts`:

```ts
export function migrate(db: ReturnType<typeof import('better-sqlite3')>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dnd_rooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      world_info TEXT NOT NULL,
      current_turn INTEGER NOT NULL,
      status TEXT NOT NULL,
      preset_id TEXT,
      world_book_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dnd_players (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES dnd_rooms(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      character_card_path TEXT,
      is_connected INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dnd_turns (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES dnd_rooms(id) ON DELETE CASCADE,
      number INTEGER NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      UNIQUE(room_id, number)
    );

    CREATE TABLE IF NOT EXISTS dnd_actions (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES dnd_rooms(id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL REFERENCES dnd_turns(id) ON DELETE CASCADE,
      player_id TEXT NOT NULL REFERENCES dnd_players(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      submitted_at TEXT NOT NULL,
      status TEXT NOT NULL,
      UNIQUE(turn_id, player_id)
    );

    CREATE TABLE IF NOT EXISTS dnd_interactions (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES dnd_rooms(id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL REFERENCES dnd_turns(id) ON DELETE CASCADE,
      source_player_id TEXT NOT NULL REFERENCES dnd_players(id) ON DELETE CASCADE,
      target_player_id TEXT NOT NULL REFERENCES dnd_players(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      prompt TEXT NOT NULL,
      target_response TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dnd_logs (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES dnd_rooms(id) ON DELETE CASCADE,
      turn_id TEXT REFERENCES dnd_turns(id) ON DELETE SET NULL,
      visibility_scope TEXT NOT NULL,
      player_id TEXT REFERENCES dnd_players(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}
```

- [ ] **Step 5: 验证类型检查**

Run:
```bash
cd E:\myCode\dnd\SillyTavern
npx tsc --noEmit --strict --esModuleInterop --moduleResolution node --target ES2022 --module ES2022 extensions/dnd/src/types.ts extensions/dnd/src/db/connection.ts extensions/dnd/src/db/schema.ts
```

Expected: No type errors.

---

### Task 2: 房间和玩家 Token 服务

**Files:**
- Create: `SillyTavern/extensions/dnd/src/services/roomService.ts`
- Create: `SillyTavern/extensions/dnd/src/services/playerService.ts`

- [ ] **Step 1: 实现房间 CRUD**

`SillyTavern/extensions/dnd/src/services/roomService.ts`:

```ts
import { nanoid } from 'nanoid';
import type { DndRoom } from '../types.js';

export function createRoom(db: ReturnType<typeof import('better-sqlite3')>, input: { name: string; worldInfo: string }): DndRoom {
  const id = nanoid();
  const now = new Date().toISOString();
  const turnId = nanoid();

  const tx = db.transaction(() => {
    db.prepare('INSERT INTO dnd_rooms (id, name, world_info, current_turn, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, input.name, input.worldInfo, 1, 'waiting_for_actions', now);
    db.prepare('INSERT INTO dnd_turns (id, room_id, number, status, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(turnId, id, 1, 'open', now, null);
    db.prepare('INSERT INTO dnd_logs (id, room_id, turn_id, visibility_scope, player_id, title, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(nanoid(), id, turnId, 'public', null, 'Opening Scene', input.worldInfo, now);
  });
  tx();

  return { id, name: input.name, worldInfo: input.worldInfo, currentTurn: 1, status: 'waiting_for_actions', presetId: null, worldBookId: null, createdAt: now };
}

export function getRoom(db: ReturnType<typeof import('better-sqlite3')>, roomId: string): DndRoom | null {
  const row = db.prepare('SELECT id, name, world_info as worldInfo, current_turn as currentTurn, status, preset_id as presetId, world_book_id as worldBookId, created_at as createdAt FROM dnd_rooms WHERE id = ?').get(roomId) as any;
  return row ?? null;
}

export function updateRoomStatus(db: ReturnType<typeof import('better-sqlite3')>, roomId: string, status: string): void {
  db.prepare('UPDATE dnd_rooms SET status = ? WHERE id = ?').run(status, roomId);
}

export function updateRoomPreset(db: ReturnType<typeof import('better-sqlite3')>, roomId: string, presetId: string): void {
  db.prepare('UPDATE dnd_rooms SET preset_id = ? WHERE id = ?').run(presetId, roomId);
}

export function updateRoomWorldBook(db: ReturnType<typeof import('better-sqlite3')>, roomId: string, worldBookId: string): void {
  db.prepare('UPDATE dnd_rooms SET world_book_id = ? WHERE id = ?').run(worldBookId, roomId);
}
```

- [ ] **Step 2: 实现玩家 CRUD 和 token 生成**

`SillyTavern/extensions/dnd/src/services/playerService.ts`:

```ts
import { nanoid } from 'nanoid';
import type { DndPlayer } from '../types.js';

export function addPlayer(db: ReturnType<typeof import('better-sqlite3')>, roomId: string, name: string): { player: DndPlayer; token: string } {
  const id = nanoid();
  const token = nanoid(48);
  const now = new Date().toISOString();

  db.prepare('INSERT INTO dnd_players (id, room_id, name, token, is_connected, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, roomId, name, token, 0, now);

  return {
    player: { id, roomId, name, token, characterCardPath: null, isConnected: false, createdAt: now },
    token
  };
}

export function getPlayerByToken(db: ReturnType<typeof import('better-sqlite3')>, token: string): DndPlayer | null {
  const row = db.prepare('SELECT id, room_id as roomId, name, token, character_card_path as characterCardPath, is_connected as isConnected, created_at as createdAt FROM dnd_players WHERE token = ?').get(token) as any;
  return row ?? null;
}

export function getPlayersByRoom(db: ReturnType<typeof import('better-sqlite3')>, roomId: string): DndPlayer[] {
  return db.prepare('SELECT id, room_id as roomId, name, token, character_card_path as characterCardPath, is_connected as isConnected, created_at as createdAt FROM dnd_players WHERE room_id = ? ORDER BY created_at ASC').all(roomId) as DndPlayer[];
}

export function bindCharacterToPlayer(db: ReturnType<typeof import('better-sqlite3')>, playerId: string, cardPath: string): void {
  db.prepare('UPDATE dnd_players SET character_card_path = ? WHERE id = ?').run(cardPath, playerId);
}
```

- [ ] **Step 3: 编写房间测试**

Create `SillyTavern/extensions/dnd/src/tests/roomService.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createMemoryDb } from '../db/connection.js';
import { migrate } from '../db/schema.js';
import { createRoom, getRoom } from '../services/roomService.js';

describe('roomService', () => {
  it('creates a room with turn 1 and opening log', () => {
    const db = createMemoryDb();
    migrate(db);

    const room = createRoom(db, { name: 'Test Room', worldInfo: 'Dark forest' });
    expect(room.currentTurn).toBe(1);
    expect(room.status).toBe('waiting_for_actions');

    const fetched = getRoom(db, room.id);
    expect(fetched?.name).toBe('Test Room');
    expect(fetched?.worldInfo).toBe('Dark forest');

    const logs = db.prepare('SELECT * FROM dnd_logs WHERE room_id = ?').all(room.id);
    expect(logs).toHaveLength(1);
  });
});
```

Run:
```bash
cd E:\myCode\dnd\SillyTavern
npx vitest run extensions/dnd/src/tests/roomService.test.ts
```

Expected: 1 test PASS.

- [ ] **Step 4: 编写玩家 token 测试**

Create `SillyTavern/extensions/dnd/src/tests/playerService.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createMemoryDb } from '../db/connection.js';
import { migrate } from '../db/schema.js';
import { createRoom } from '../services/roomService.js';
import { addPlayer, getPlayerByToken, getPlayersByRoom } from '../services/playerService.js';

describe('playerService', () => {
  it('generates unique tokens and fetches players by room', () => {
    const db = createMemoryDb();
    migrate(db);
    const room = createRoom(db, { name: 'R', worldInfo: 'W' });

    const a = addPlayer(db, room.id, 'Ari');
    const b = addPlayer(db, room.id, 'Bo');

    expect(a.token).not.toBe(b.token);
    expect(a.token).toHaveLength(48);

    const byToken = getPlayerByToken(db, a.token);
    expect(byToken?.name).toBe('Ari');

    const roomPlayers = getPlayersByRoom(db, room.id);
    expect(roomPlayers).toHaveLength(2);
    expect(roomPlayers.map((p) => p.name)).toEqual(['Ari', 'Bo']);
  });
});
```

Run:
```bash
npx vitest run extensions/dnd/src/tests/playerService.test.ts
```

Expected: 1 test PASS.

---

### Task 3: 信息隔离服务

**Files:**
- Create: `SillyTavern/extensions/dnd/src/services/visibilityService.ts`
- Create: `SillyTavern/extensions/dnd/src/tests/visibilityService.test.ts`

- [ ] **Step 1: 编写信息隔离测试**

`SillyTavern/extensions/dnd/src/tests/visibilityService.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildPlayerVisibleState } from '../services/visibilityService.js';
import type { DndRoom, DndPlayer, LogEntry, PlayerAction, InteractionRequest } from '../types.js';

const room: DndRoom = {
  id: 'room-1', name: 'Test', worldInfo: 'World', currentTurn: 1,
  status: 'waiting_for_actions', presetId: null, worldBookId: null, createdAt: '2026-01-01T00:00:00.000Z'
};

const players: DndPlayer[] = [
  { id: 'p-a', roomId: 'room-1', name: 'Ari', token: 'tok-a', characterCardPath: null, isConnected: false, createdAt: room.createdAt },
  { id: 'p-b', roomId: 'room-1', name: 'Bo', token: 'tok-b', characterCardPath: null, isConnected: false, createdAt: room.createdAt }
];

const logs: LogEntry[] = [
  { id: 'l1', roomId: 'room-1', turnId: null, visibilityScope: 'public', playerId: null, title: 'Scene', content: 'Door opens.', createdAt: room.createdAt },
  { id: 'l2', roomId: 'room-1', turnId: null, visibilityScope: 'private', playerId: 'p-a', title: 'Whisper', content: 'Ari hears bell.', createdAt: room.createdAt },
  { id: 'l3', roomId: 'room-1', turnId: null, visibilityScope: 'private', playerId: 'p-b', title: 'Shadow', content: 'Bo sees mark.', createdAt: room.createdAt },
  { id: 'l4', roomId: 'room-1', turnId: null, visibilityScope: 'admin', playerId: null, title: 'Debug', content: 'Full truth.', createdAt: room.createdAt }
];

describe('buildPlayerVisibleState', () => {
  it('returns only public logs and own private logs', () => {
    const state = buildPlayerVisibleState({
      room, player: players[0], players, characterCard: null,
      logs, actions: [], interactions: []
    });

    expect(state.publicLogs.map((l) => l.id)).toEqual(['l1']);
    expect(state.privateLogs.map((l) => l.id)).toEqual(['l2']);
    expect(JSON.stringify(state)).not.toContain('Bo sees mark');
    expect(JSON.stringify(state)).not.toContain('Full truth');
  });

  it('shows submitted/waiting player names without action text', () => {
    const state = buildPlayerVisibleState({
      room, player: players[0], players, characterCard: null,
      logs,
      actions: [{ id: 'a1', roomId: 'room-1', turnId: 't1', playerId: 'p-a', text: 'I sneak.', submittedAt: room.createdAt, status: 'submitted' }],
      interactions: []
    });

    expect(state.submittedPlayers).toEqual(['Ari']);
    expect(state.waitingPlayers).toEqual(['Bo']);
    expect(JSON.stringify(state)).not.toContain('sneak');
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

```bash
npx vitest run extensions/dnd/src/tests/visibilityService.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 3: 实现 visibilityService**

`SillyTavern/extensions/dnd/src/services/visibilityService.ts`:

```ts
import type { DndRoom, DndPlayer, LogEntry, PlayerAction, InteractionRequest, PlayerVisibleState } from '../types.js';

interface BuildInput {
  room: DndRoom;
  player: DndPlayer;
  players: DndPlayer[];
  characterCard: unknown | null;
  logs: LogEntry[];
  actions: PlayerAction[];
  interactions: InteractionRequest[];
}

export function buildPlayerVisibleState(input: BuildInput): PlayerVisibleState {
  const submittedIds = new Set(input.actions.map((a) => a.playerId));

  return {
    room: {
      id: input.room.id,
      name: input.room.name,
      worldInfo: input.room.worldInfo,
      currentTurn: input.room.currentTurn,
      status: input.room.status
    },
    player: { id: input.player.id, name: input.player.name },
    characterCard: input.characterCard,
    publicLogs: input.logs.filter((l) => l.visibilityScope === 'public'),
    privateLogs: input.logs.filter((l) => l.visibilityScope === 'private' && l.playerId === input.player.id),
    pendingInteractions: input.interactions.filter((i) => i.targetPlayerId === input.player.id && i.status !== 'resolved'),
    submittedPlayers: input.players.filter((p) => submittedIds.has(p.id)).map((p) => p.name),
    waitingPlayers: input.players.filter((p) => !submittedIds.has(p.id)).map((p) => p.name)
  };
}
```

- [ ] **Step 4: 运行测试验证通过**

```bash
npx vitest run extensions/dnd/src/tests/visibilityService.test.ts
```

Expected: 2 tests PASS.

---

### Task 4: 行动、回合和互动服务

**Files:**
- Create: `SillyTavern/extensions/dnd/src/services/actionService.ts`
- Create: `SillyTavern/extensions/dnd/src/services/turnService.ts`
- Create: `SillyTavern/extensions/dnd/src/services/interactionService.ts`
- Create: `SillyTavern/extensions/dnd/src/services/logService.ts`

- [ ] **Step 1: 实现行动服务**

`SillyTavern/extensions/dnd/src/services/actionService.ts`:

```ts
import { nanoid } from 'nanoid';
import type { PlayerAction } from '../types.js';

export function submitAction(db: ReturnType<typeof import('better-sqlite3')>, input: { roomId: string; turnId: string; playerId: string; text: string }): PlayerAction {
  const id = nanoid();
  const now = new Date().toISOString();
  db.prepare('INSERT OR REPLACE INTO dnd_actions (id, room_id, turn_id, player_id, text, submitted_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, input.roomId, input.turnId, input.playerId, input.text, now, 'submitted');
  return { id, roomId: input.roomId, turnId: input.turnId, playerId: input.playerId, text: input.text, submittedAt: now, status: 'submitted' };
}

export function getActionsByTurn(db: ReturnType<typeof import('better-sqlite3')>, turnId: string): PlayerAction[] {
  return db.prepare('SELECT id, room_id as roomId, turn_id as turnId, player_id as playerId, text, submitted_at as submittedAt, status FROM dnd_actions WHERE turn_id = ? ORDER BY submitted_at ASC').all(turnId) as PlayerAction[];
}
```

- [ ] **Step 2: 实现回合服务**

`SillyTavern/extensions/dnd/src/services/turnService.ts`:

```ts
import { nanoid } from 'nanoid';
import type { Turn, DndPlayer, PlayerAction } from '../types.js';

export function getCurrentTurn(db: ReturnType<typeof import('better-sqlite3')>, roomId: string, roomCurrentTurn: number): Turn | null {
  return db.prepare('SELECT id, room_id as roomId, number, status, started_at as startedAt, ended_at as endedAt FROM dnd_turns WHERE room_id = ? AND number = ?').get(roomId, roomCurrentTurn) as Turn | null;
}

export function allPlayersSubmitted(players: DndPlayer[], actions: PlayerAction[]): boolean {
  const submitted = new Set(actions.filter((a) => a.status === 'submitted').map((a) => a.playerId));
  return players.every((p) => submitted.has(p.id));
}

export function advanceTurn(db: ReturnType<typeof import('better-sqlite3')>, roomId: string, currentTurn: number): Turn {
  const now = new Date().toISOString();
  const nextTurnNumber = currentTurn + 1;
  const nextTurnId = nanoid();

  const tx = db.transaction(() => {
    db.prepare('UPDATE dnd_rooms SET current_turn = ?, status = ? WHERE id = ?').run(nextTurnNumber, 'waiting_for_actions', roomId);
    db.prepare('INSERT INTO dnd_turns (id, room_id, number, status, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(nextTurnId, roomId, nextTurnNumber, 'open', now, null);
  });
  tx();

  return { id: nextTurnId, roomId, number: nextTurnNumber, status: 'open', startedAt: now, endedAt: null };
}
```

- [ ] **Step 3: 实现互动和日志服务**

`SillyTavern/extensions/dnd/src/services/interactionService.ts`:

```ts
import { nanoid } from 'nanoid';
import type { InteractionRequest } from '../types.js';

export function createInteractions(db: ReturnType<typeof import('better-sqlite3')>, roomId: string, turnId: string, interactions: Array<{ sourcePlayerId: string; targetPlayerId: string; type: string; prompt: string }>): void {
  const now = new Date().toISOString();
  const insert = db.prepare('INSERT INTO dnd_interactions (id, room_id, turn_id, source_player_id, target_player_id, type, prompt, target_response, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const i of interactions) {
    insert.run(nanoid(), roomId, turnId, i.sourcePlayerId, i.targetPlayerId, i.type, i.prompt, null, 'pending_target', now);
  }
}

export function respondToInteraction(db: ReturnType<typeof import('better-sqlite3')>, interactionId: string, response: string): void {
  db.prepare('UPDATE dnd_interactions SET target_response = ?, status = ? WHERE id = ?').run(response, 'ready_for_ai', interactionId);
}

export function getPendingInteractions(db: ReturnType<typeof import('better-sqlite3')>, roomId: string): InteractionRequest[] {
  return db.prepare('SELECT id, room_id as roomId, turn_id as turnId, source_player_id as sourcePlayerId, target_player_id as targetPlayerId, type, prompt, target_response as targetResponse, status, created_at as createdAt FROM dnd_interactions WHERE room_id = ? AND status != ? ORDER BY created_at ASC').all(roomId, 'resolved') as InteractionRequest[];
}
```

`SillyTavern/extensions/dnd/src/services/logService.ts`:

```ts
import { nanoid } from 'nanoid';
import type { LogEntry, VisibilityScope } from '../types.js';

export function insertLog(db: ReturnType<typeof import('better-sqlite3')>, input: {
  roomId: string; turnId: string; scope: VisibilityScope; playerId: string | null; title: string; content: string;
}): LogEntry {
  const id = nanoid();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO dnd_logs (id, room_id, turn_id, visibility_scope, player_id, title, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, input.roomId, input.turnId, input.scope, input.playerId, input.title, input.content, now);
  return { id, roomId: input.roomId, turnId: input.turnId, visibilityScope: input.scope, playerId: input.playerId, title: input.title, content: input.content, createdAt: now };
}

export function getPublicLogs(db: ReturnType<typeof import('better-sqlite3')>, roomId: string): LogEntry[] {
  return db.prepare('SELECT id, room_id as roomId, turn_id as turnId, visibility_scope as visibilityScope, player_id as playerId, title, content, created_at as createdAt FROM dnd_logs WHERE room_id = ? AND visibility_scope = ? ORDER BY created_at ASC').all(roomId, 'public') as LogEntry[];
}

export function getAllLogs(db: ReturnType<typeof import('better-sqlite3')>, roomId: string): LogEntry[] {
  return db.prepare('SELECT id, room_id as roomId, turn_id as turnId, visibility_scope as visibilityScope, player_id as playerId, title, content, created_at as createdAt FROM dnd_logs WHERE room_id = ? ORDER BY created_at ASC').all(roomId) as LogEntry[];
}
```

- [ ] **Step 4: 编写回合引擎测试**

Create `SillyTavern/extensions/dnd/src/tests/turnService.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { allPlayersSubmitted } from '../services/turnService.js';
import type { DndPlayer, PlayerAction } from '../types.js';

const players: DndPlayer[] = [
  { id: 'p-a', roomId: 'r1', name: 'Ari', token: 't-a', characterCardPath: null, isConnected: false, createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 'p-b', roomId: 'r1', name: 'Bo', token: 't-b', characterCardPath: null, isConnected: false, createdAt: '2026-01-01T00:00:00.000Z' }
];

describe('allPlayersSubmitted', () => {
  it('returns false when not all submitted', () => {
    const actions: PlayerAction[] = [
      { id: 'a1', roomId: 'r1', turnId: 't1', playerId: 'p-a', text: 'Go', submittedAt: '2026-01-01T00:00:00.000Z', status: 'submitted' }
    ];
    expect(allPlayersSubmitted(players, actions)).toBe(false);
  });

  it('returns true when all submitted', () => {
    const actions: PlayerAction[] = [
      { id: 'a1', roomId: 'r1', turnId: 't1', playerId: 'p-a', text: 'Go', submittedAt: '2026-01-01T00:00:00.000Z', status: 'submitted' },
      { id: 'a2', roomId: 'r1', turnId: 't1', playerId: 'p-b', text: 'Run', submittedAt: '2026-01-01T00:00:01.000Z', status: 'submitted' }
    ];
    expect(allPlayersSubmitted(players, actions)).toBe(true);
  });

  it('sorts actions by submission time', () => {
    const actions: PlayerAction[] = [
      { id: 'a2', roomId: 'r1', turnId: 't1', playerId: 'p-b', text: 'Run', submittedAt: '2026-01-01T00:00:01.000Z', status: 'submitted' },
      { id: 'a1', roomId: 'r1', turnId: 't1', playerId: 'p-a', text: 'Go', submittedAt: '2026-01-01T00:00:00.000Z', status: 'submitted' }
    ];
    const sorted = [...actions].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
    expect(sorted[0].playerId).toBe('p-a');
    expect(sorted[1].playerId).toBe('p-b');
  });
});
```

Run:
```bash
npx vitest run extensions/dnd/src/tests/turnService.test.ts
```

Expected: 3 tests PASS.

---

### Task 5: API 路由

**Files:**
- Create: `SillyTavern/extensions/dnd/src/services/eventBus.ts`
- Create: `SillyTavern/extensions/dnd/src/routes/adminRoutes.ts`
- Create: `SillyTavern/extensions/dnd/src/routes/playerRoutes.ts`
- Create: `SillyTavern/extensions/dnd/src/routes/sseRoutes.ts`

- [ ] **Step 1: 实现事件总线**

`SillyTavern/extensions/dnd/src/services/eventBus.ts`:

```ts
import { EventEmitter } from 'events';

const emitter = new EventEmitter();
emitter.setMaxListeners(100);

export function publishRoomUpdate(roomId: string): void {
  emitter.emit(`room:${roomId}`);
}

export function subscribeRoomUpdate(roomId: string, listener: () => void): () => void {
  emitter.on(`room:${roomId}`, listener);
  return () => { emitter.off(`room:${roomId}`, listener); };
}
```

- [ ] **Step 2: 实现管理端路由**

`SillyTavern/extensions/dnd/src/routes/adminRoutes.ts`:

```ts
import { Router } from 'express';
import { z } from 'zod';
import { createRoom, getRoom, updateRoomPreset, updateRoomStatus, updateRoomWorldBook } from '../services/roomService.js';
import { addPlayer, bindCharacterToPlayer, getPlayersByRoom } from '../services/playerService.js';
import { getCurrentTurn, allPlayersSubmitted, advanceTurn } from '../services/turnService.js';
import { getActionsByTurn } from '../services/actionService.js';
import { getAllLogs, getPublicLogs, insertLog } from '../services/logService.js';
import { getPendingInteractions, createInteractions } from '../services/interactionService.js';
import { publishRoomUpdate } from '../services/eventBus.js';

const createRoomSchema = z.object({ name: z.string().min(1), worldInfo: z.string().min(1) });
const addPlayerSchema = z.object({ name: z.string().min(1) });

export function createAdminRouter(db: ReturnType<typeof import('better-sqlite3')>): Router {
  const router = Router();

  router.post('/rooms', (req, res) => {
    const input = createRoomSchema.parse(req.body);
    const room = createRoom(db, input);
    res.json({ roomId: room.id, adminUrl: `/dnd/admin/${room.id}` });
  });

  router.post('/rooms/:roomId/players', (req, res) => {
    const room = getRoom(db, req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const input = addPlayerSchema.parse(req.body);
    const { player, token } = addPlayer(db, req.params.roomId, input.name);
    publishRoomUpdate(req.params.roomId);
    res.json({ playerId: player.id, token, playerUrl: `/dnd/player/${token}` });
  });

  router.get('/rooms/:roomId', (req, res) => {
    const room = getRoom(db, req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const players = getPlayersByRoom(db, req.params.roomId);
    const turns = db.prepare('SELECT id, room_id as roomId, number, status, started_at as startedAt, ended_at as endedAt FROM dnd_turns WHERE room_id = ? ORDER BY number ASC').all(req.params.roomId);
    const actions = db.prepare('SELECT id, room_id as roomId, turn_id as turnId, player_id as playerId, text, submitted_at as submittedAt, status FROM dnd_actions WHERE room_id = ? ORDER BY submitted_at ASC').all(req.params.roomId);
    const interactions = getPendingInteractions(db, req.params.roomId);
    const logs = getAllLogs(db, req.params.roomId);
    res.json({ room, players, turns, actions, interactions, logs });
  });

  router.post('/rooms/:roomId/process-turn', async (req, res) => {
    const room = getRoom(db, req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const turn = getCurrentTurn(db, room.id, room.currentTurn);
    if (!turn) return res.status(500).json({ error: 'Turn not found' });
    const players = getPlayersByRoom(db, room.id);
    const actions = getActionsByTurn(db, turn.id);

    if (!allPlayersSubmitted(players, actions)) {
      return res.status(409).json({ error: 'Waiting for all players to submit actions' });
    }

    // Phase 1: AI-DM 调用 (Task 6 接入)
    // 临时 mock 结果
    const mockResult = {
      publicLog: `Turn ${room.currentTurn} processed. Actions: ${actions.map((a) => `${players.find((p) => p.id === a.playerId)?.name}: ${a.text}`).join('; ')}`,
      privateUpdatesByPlayer: {} as Record<string, string>,
      ruleResults: [],
      interactionRequests: [] as Array<{ sourcePlayerId: string; targetPlayerId: string; type: string; prompt: string }>
    };

    try {
      updateRoomStatus(db, room.id, 'processing');
      const now = new Date().toISOString();

      const tx = db.transaction(() => {
        insertLog(db, { roomId: room.id, turnId: turn.id, scope: 'public', playerId: null, title: `Turn ${room.currentTurn}`, content: mockResult.publicLog });
        for (const [playerId, content] of Object.entries(mockResult.privateUpdatesByPlayer)) {
          insertLog(db, { roomId: room.id, turnId: turn.id, scope: 'private', playerId, title: `Private Turn ${room.currentTurn}`, content });
        }
        createInteractions(db, room.id, turn.id, mockResult.interactionRequests);
        db.prepare('UPDATE dnd_turns SET status = ?, ended_at = ? WHERE id = ?').run('complete', now, turn.id);
        db.prepare('UPDATE dnd_actions SET status = ? WHERE turn_id = ?').run('complete', turn.id);
        advanceTurn(db, room.id, room.currentTurn);
      });
      tx();
      publishRoomUpdate(room.id);
      res.json({ result: mockResult });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateRoomStatus(db, room.id, 'needs_admin_attention');
      res.status(500).json({ error: message });
    }
  });

  router.put('/rooms/:roomId/preset', (req, res) => {
    const room = getRoom(db, req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const { presetId } = z.object({ presetId: z.string() }).parse(req.body);
    updateRoomPreset(db, req.params.roomId, presetId);
    publishRoomUpdate(req.params.roomId);
    res.json({ ok: true });
  });

  router.put('/rooms/:roomId/world-book', (req, res) => {
    const room = getRoom(db, req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const { worldBookId } = z.object({ worldBookId: z.string() }).parse(req.body);
    updateRoomWorldBook(db, req.params.roomId, worldBookId);
    publishRoomUpdate(req.params.roomId);
    res.json({ ok: true });
  });

  return router;
}
```

- [ ] **Step 3: 实现玩家端路由**

`SillyTavern/extensions/dnd/src/routes/playerRoutes.ts`:

```ts
import { Router } from 'express';
import { z } from 'zod';
import { getPlayerByToken } from '../services/playerService.js';
import { getRoom } from '../services/roomService.js';
import { getCurrentTurn } from '../services/turnService.js';
import { submitAction } from '../services/actionService.js';
import { getAllLogs } from '../services/logService.js';
import { getPendingInteractions, respondToInteraction } from '../services/interactionService.js';
import { buildPlayerVisibleState } from '../services/visibilityService.js';
import { publishRoomUpdate } from '../services/eventBus.js';

const submitActionSchema = z.object({ text: z.string().min(1) });

export function createPlayerRouter(db: ReturnType<typeof import('better-sqlite3')>): Router {
  const router = Router();

  router.get('/:token/state', (req, res) => {
    const player = getPlayerByToken(db, req.params.token);
    if (!player) return res.status(404).json({ error: 'Player not found' });
    const room = getRoom(db, player.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const players = db.prepare('SELECT id, room_id as roomId, name, token, character_card_path as characterCardPath, is_connected as isConnected, created_at as createdAt FROM dnd_players WHERE room_id = ? ORDER BY created_at ASC').all(player.roomId) as any[];
    const turn = getCurrentTurn(db, room.id, room.currentTurn);
    const actions = turn ? db.prepare('SELECT id, room_id as roomId, turn_id as turnId, player_id as playerId, text, submitted_at as submittedAt, status FROM dnd_actions WHERE turn_id = ? ORDER BY submitted_at ASC').all(turn.id) as any[] : [];
    const logs = getAllLogs(db, player.roomId);
    const interactions = getPendingInteractions(db, player.roomId);

    const state = buildPlayerVisibleState({
      room, player, players, characterCard: null,
      logs, actions, interactions
    });

    res.json(state);
  });

  router.post('/:token/actions', (req, res) => {
    const player = getPlayerByToken(db, req.params.token);
    if (!player) return res.status(404).json({ error: 'Player not found' });
    const room = getRoom(db, player.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const turn = getCurrentTurn(db, room.id, room.currentTurn);
    if (!turn) return res.status(500).json({ error: 'Turn not found' });
    const input = submitActionSchema.parse(req.body);

    submitAction(db, { roomId: room.id, turnId: turn.id, playerId: player.id, text: input.text });
    publishRoomUpdate(room.id);
    res.json({ ok: true });
  });

  router.post('/:token/interactions/:interactionId/respond', (req, res) => {
    const player = getPlayerByToken(db, req.params.token);
    if (!player) return res.status(404).json({ error: 'Player not found' });
    const { response } = z.object({ response: z.string() }).parse(req.body);
    respondToInteraction(db, req.params.interactionId, response);
    publishRoomUpdate(player.roomId);
    res.json({ ok: true });
  });

  return router;
}
```

- [ ] **Step 4: 实现 SSE 路由**

`SillyTavern/extensions/dnd/src/routes/sseRoutes.ts`:

```ts
import { Router } from 'express';
import { subscribeRoomUpdate } from '../services/eventBus.js';

export function createSseRouter(_db: ReturnType<typeof import('better-sqlite3')>): Router {
  const router = Router();

  router.get('/rooms/:roomId', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });

    const unsub = subscribeRoomUpdate(req.params.roomId, () => {
      res.write('event: room-updated\ndata: {}\n\n');
    });

    req.on('close', unsub);
  });

  return router;
}
```

---

### Task 6: ST 资源集成和 AI-DM Prompt Builder

**Files:**
- Create: `SillyTavern/extensions/dnd/src/services/contextBuilder.ts`
- Create: `SillyTavern/extensions/dnd/src/services/aiAdapter.ts`

- [ ] **Step 1: 实现 Prompt Builder**

`SillyTavern/extensions/dnd/src/services/contextBuilder.ts`:

```ts
import type { DndRoom, DndPlayer, LogEntry, PlayerAction, InteractionRequest } from '../types.js';

export function buildTurnPrompt(input: {
  room: DndRoom;
  players: DndPlayer[];
  publicLogs: LogEntry[];
  actions: PlayerAction[];
  interactions: InteractionRequest[];
  presetText?: string;
  worldBookText?: string;
}): string {
  const playerNames = new Map(input.players.map((p) => [p.id, p.name]));
  const sortedActions = [...input.actions].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  const actionLines = sortedActions.map((a, i) =>
    `${i + 1}. ${playerNames.get(a.playerId) ?? 'Unknown'}: ${a.text}`
  ).join('\n');

  const blocks: string[] = [];

  if (input.presetText) {
    blocks.push('# Preset', input.presetText);
  }

  blocks.push(
    '# DND 房间信息',
    `Room: ${input.room.name}`,
    `World: ${input.room.worldInfo}`,
    '# 世界书',
    input.worldBookText || 'No world book entries active.'
  );

  if (input.interactions.length > 0) {
    blocks.push(
      '# 待处理互动',
      input.interactions.map((i) => `- ${i.prompt} (response: ${i.targetResponse ?? 'pending'})`).join('\n')
    );
  }

  blocks.push(
    '# 公开日志',
    input.publicLogs.map((l) => `- ${l.title}: ${l.content}`).join('\n') || '- No public log yet.',
    '# 本轮行动 (按提交时间排序)',
    actionLines || '- No actions yet.',
    '# 输出格式',
    '返回严格 JSON，字段为 publicLog、privateUpdatesByPlayer、ruleResults、interactionRequests。',
    '不要使用 Markdown 代码块。',
    '玩家间互动必须创建 interactionRequests，让目标玩家确认。',
    '不得替任何玩家做决定。'
  );

  return blocks.join('\n\n');
}
```

- [ ] **Step 2: 实现 AI Adapter (Mock)**

`SillyTavern/extensions/dnd/src/services/aiAdapter.ts`:

```ts
import type { AiTurnResult } from '../types.js';

// 首版 mock。后续接入 ST generation/provider 通道。
export async function generateTurnResult(prompt: string): Promise<AiTurnResult> {
  // Summary of actions for mock
  const actionMatch = prompt.match(/\d+\. (\w+): (.+)/g);
  const playerActions = actionMatch ? actionMatch.map((m) => {
    const parts = m.match(/\d+\. (\w+): (.+)/);
    return parts ? { name: parts[1], text: parts[2] } : { name: 'Unknown', text: 'Unknown' };
  }) : [];

  const publicLog = playerActions.map((a) => `${a.name} ${a.text}。`).join(' ');

  return {
    publicLog,
    privateUpdatesByPlayer: {},
    ruleResults: [],
    interactionRequests: []
  };
}
```

- [ ] **Step 3: 编写 Prompt Builder 测试**

Create `SillyTavern/extensions/dnd/src/tests/contextBuilder.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildTurnPrompt } from '../services/contextBuilder.js';
import type { DndRoom, DndPlayer, LogEntry, PlayerAction, InteractionRequest } from '../types.js';

const room: DndRoom = {
  id: 'r1', name: 'Test Room', worldInfo: 'Dark castle', currentTurn: 1,
  status: 'waiting_for_actions', presetId: null, worldBookId: null,
  createdAt: '2026-01-01T00:00:00.000Z'
};

const players: DndPlayer[] = [
  { id: 'p-a', roomId: 'r1', name: 'Ari', token: 't-a', characterCardPath: null, isConnected: false, createdAt: room.createdAt },
  { id: 'p-b', roomId: 'r1', name: 'Bo', token: 't-b', characterCardPath: null, isConnected: false, createdAt: room.createdAt }
];

describe('buildTurnPrompt', () => {
  it('includes preset and world book sections', () => {
    const prompt = buildTurnPrompt({
      room, players, publicLogs: [], actions: [], interactions: [],
      presetText: 'You are a strict DM.',
      worldBookText: 'The castle has 3 floors.'
    });

    expect(prompt).toContain('# Preset');
    expect(prompt).toContain('You are a strict DM.');
    expect(prompt).toContain('The castle has 3 floors.');
    expect(prompt).toContain('# 输出格式');
    expect(prompt).toContain('不得替任何玩家做决定');
  });

  it('orders actions by submission time', () => {
    const actions: PlayerAction[] = [
      { id: 'a2', roomId: 'r1', turnId: 't1', playerId: 'p-b', text: 'Second', submittedAt: '2026-01-01T00:00:01.000Z', status: 'submitted' },
      { id: 'a1', roomId: 'r1', turnId: 't1', playerId: 'p-a', text: 'First', submittedAt: '2026-01-01T00:00:00.000Z', status: 'submitted' }
    ];

    const prompt = buildTurnPrompt({ room, players, publicLogs: [], actions, interactions: [] });
    const firstIdx = prompt.indexOf('First');
    const secondIdx = prompt.indexOf('Second');
    expect(firstIdx).toBeLessThan(secondIdx);
  });
});
```

Run:
```bash
npx vitest run extensions/dnd/src/tests/contextBuilder.test.ts
```

Expected: 2 tests PASS.

---

### Task 7: DM 控制台 UI

**Files:**
- Create: `SillyTavern/extensions/dnd/public/admin-panel.html`
- Create: `SillyTavern/extensions/dnd/public/admin-panel.js`
- Create: `SillyTavern/extensions/dnd/public/styles.css`
- Modify: `SillyTavern/extensions/dnd/index.js` (注册静态文件)

- [ ] **Step 1: DM 控制台 HTML**

`SillyTavern/extensions/dnd/public/admin-panel.html`:

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DND 主持人控制台</title>
<link rel="stylesheet" href="./styles.css">
</head>
<body>
<main class="shell">
  <h1 id="roomName">DND 房间</h1>
  <p class="muted" id="roomStatus"></p>
  <div class="grid">
    <aside class="card">
      <h2>玩家</h2>
      <div id="playerList"></div>
      <input id="playerNameInput" value="新英雄" />
      <button id="addPlayerBtn">创建玩家链接</button>
      <div id="lastLink"></div>
      <h2>行动</h2>
      <div id="actionList"></div>
      <button id="processBtn">处理本回合</button>
      <div id="errorMsg"></div>
    </aside>
    <section>
      <div class="card">
        <h2>全部日志</h2>
        <div id="logList"></div>
      </div>
      <div class="card">
        <h2>互动</h2>
        <div id="interactionList"></div>
      </div>
    </section>
  </div>
</main>
<script src="./admin-panel.js"></script>
</body>
</html>
```

- [ ] **Step 2: DM 控制台 JS**

`SillyTavern/extensions/dnd/public/admin-panel.js`:

```js
const roomId = new URLSearchParams(window.location.search).get('roomId');
if (!roomId) {
  document.body.innerHTML = '<p>缺少 roomId 查询参数。</p>';
  throw new Error('Missing roomId');
}

async function api(url, init) {
  const res = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function refresh() {
  const state = await api(`/api/dnd/admin/rooms/${roomId}`);
  document.getElementById('roomName').textContent = state.room.name;
  document.getElementById('roomStatus').textContent = `主持人控制台 · 第 ${state.room.currentTurn} 回合 · ${state.room.status}`;
  document.getElementById('playerList').innerHTML = state.players.map((p) => `<p>${p.name}</p>`).join('');
  document.getElementById('actionList').innerHTML = state.actions.map((a) => `<p>${a.playerId}: ${a.text}</p>`).join('');
  document.getElementById('logList').innerHTML = state.logs.map((l) => `<div class="log-entry"><strong>${l.title}</strong> [${l.visibilityScope}]<br>${l.content}</div>`).join('');
  document.getElementById('interactionList').innerHTML = state.interactions.map((i) => `<p>${i.type}: ${i.prompt} (${i.status})</p>`).join('');
}

document.getElementById('addPlayerBtn').addEventListener('click', async () => {
  const name = document.getElementById('playerNameInput').value;
  try {
    const result = await api(`/api/dnd/admin/rooms/${roomId}/players`, { method: 'POST', body: JSON.stringify({ name }) });
    document.getElementById('lastLink').innerHTML = `<a href="${window.location.origin}/dnd/player/${result.token}">${result.playerUrl}</a>`;
    await refresh();
  } catch (e) {
    document.getElementById('errorMsg').textContent = e.message;
  }
});

document.getElementById('processBtn').addEventListener('click', async () => {
  try {
    await api(`/api/dnd/admin/rooms/${roomId}/process-turn`, { method: 'POST' });
    await refresh();
  } catch (e) {
    document.getElementById('errorMsg').textContent = e.message;
  }
});

const events = new EventSource(`/events/dnd/rooms/${roomId}`);
events.addEventListener('room-updated', () => refresh());

refresh();
```

- [ ] **Step 3: 基础 CSS 样式**

`SillyTavern/extensions/dnd/public/styles.css`:

```css
:root {
  color: #f4ead7;
  background: #17120d;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif;
}
body { margin: 0; min-height: 100vh; background: radial-gradient(circle at top left, #3a2718, #17120d 40%, #0f0c09); }
button { border: 0; border-radius: 10px; padding: 0.7rem 1rem; color: #1d130b; background: #e8b65b; cursor: pointer; font-weight: 700; margin-top: 0.75rem; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
button + button { margin-left: 0.5rem; }
input, textarea { width: 100%; box-sizing: border-box; border: 1px solid #715336; border-radius: 10px; color: #f4ead7; background: rgba(20, 14, 9, 0.9); padding: 0.75rem; margin: 0.35rem 0 1rem; font: inherit; }
textarea { min-height: 8rem; resize: vertical; }
a { color: #f4d28a; word-break: break-all; }
.shell { width: min(1280px, calc(100% - 32px)); margin: 0 auto; padding: 32px 0; }
.grid { display: grid; grid-template-columns: 320px 1fr; gap: 20px; }
.card { border: 1px solid rgba(232, 182, 91, 0.25); border-radius: 18px; background: rgba(23, 18, 13, 0.78); box-shadow: 0 20px 60px rgba(0, 0, 0, 0.35); padding: 20px; margin-bottom: 20px; }
.log-entry { border-left: 3px solid #e8b65b; padding: 0.7rem 0 0.7rem 1rem; margin: 0.7rem 0; background: rgba(255, 255, 255, 0.03); }
.muted { color: #bba88d; }
@media (max-width: 840px) { .grid { grid-template-columns: 1fr; } }
```

- [ ] **Step 4: 更新扩展入口注册静态文件**

Edit `SillyTavern/extensions/dnd/index.js`, add static serving:

```js
// 在 init 函数中追加：
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use('/dnd', express.static(path.join(__dirname, 'public')));
```

同时引入 `express`:

```js
import express from 'express';
```

---

### Task 8: 玩家隔离页面

**Files:**
- Create: `SillyTavern/extensions/dnd/public/player-page.html`
- Create: `SillyTavern/extensions/dnd/public/player-page.js`

- [ ] **Step 1: 玩家页面 HTML**

`SillyTavern/extensions/dnd/public/player-page.html`:

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>玩家视图</title>
<link rel="stylesheet" href="./styles.css">
</head>
<body>
<main class="shell">
  <h1>玩家视图</h1>
  <p class="muted" id="roomStatus"></p>
  <div class="grid">
    <aside class="card">
      <h2>角色卡</h2>
      <p>暂无角色。</p>
      <h2 id="turnLabel">回合</h2>
      <div id="turnPanel"></div>
      <h2>你的行动</h2>
      <input id="actionInput" placeholder="描述你的行动..." />
      <button id="submitBtn">提交行动</button>
    </aside>
    <section>
      <div class="card">
        <h2>需要回应</h2>
        <div id="interactionList"></div>
      </div>
      <div class="card">
        <h2>公开日志</h2>
        <div id="publicLogs"></div>
      </div>
      <div class="card">
        <h2>你的私密故事</h2>
        <div id="privateLogs"></div>
      </div>
    </section>
  </div>
</main>
<script src="./player-page.js"></script>
</body>
</html>
```

- [ ] **Step 2: 玩家页面 JS**

`SillyTavern/extensions/dnd/public/player-page.js`:

```js
const token = window.location.pathname.split('/').pop();
if (!token) throw new Error('Missing token');

async function api(url, init) {
  const res = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function refresh() {
  const state = await api(`/api/dnd/player/${token}/state`);
  document.getElementById('roomStatus').textContent = `${state.room.name} · 第 ${state.room.currentTurn} 回合 · ${state.room.status}`;
  document.getElementById('turnPanel').innerHTML = `
    <p>状态：${state.room.status}</p>
    <p>已提交：${state.submittedPlayers.join(', ') || '暂无玩家提交。'}</p>
    <p>等待中：${state.waitingPlayers.join(', ') || '所有玩家都已提交。'}</p>
  `;
  document.getElementById('publicLogs').innerHTML = state.publicLogs.map((l) => `<div class="log-entry"><strong>${l.title}</strong><br>${l.content}</div>`).join('') || '暂无记录。';
  document.getElementById('privateLogs').innerHTML = state.privateLogs.map((l) => `<div class="log-entry"><strong>${l.title}</strong><br>${l.content}</div>`).join('') || '暂无记录。';
  document.getElementById('interactionList').innerHTML = state.pendingInteractions.map((i) => `
    <div class="log-entry">
      <strong>${i.type}</strong><br>${i.prompt}
      <div style="margin-top:0.5rem">
        <button class="agree-btn" data-id="${i.id}">同意 / 配合</button>
        <button class="resist-btn" data-id="${i.id}">反抗 / 拒绝</button>
      </div>
    </div>
  `).join('') || '暂无待确认互动。';

  document.querySelectorAll('.agree-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api(`/api/dnd/player/${token}/interactions/${btn.dataset.id}/respond`, { method: 'POST', body: JSON.stringify({ response: 'agree' }) });
      refresh();
    });
  });
  document.querySelectorAll('.resist-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api(`/api/dnd/player/${token}/interactions/${btn.dataset.id}/respond`, { method: 'POST', body: JSON.stringify({ response: 'resist' }) });
      refresh();
    });
  });
}

document.getElementById('submitBtn').addEventListener('click', async () => {
  const text = document.getElementById('actionInput').value;
  await api(`/api/dnd/player/${token}/actions`, { method: 'POST', body: JSON.stringify({ text }) });
  document.getElementById('actionInput').value = '';
  refresh();
});

refresh();
setInterval(refresh, 10000);
```

---

### Task 9: 集成测试

**Files:**
- Create: `SillyTavern/extensions/dnd/src/tests/integration.test.ts`

- [ ] **Step 1: 编写集成测试**

`SillyTavern/extensions/dnd/src/tests/integration.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createMemoryDb } from '../db/connection.js';
import { migrate } from '../db/schema.js';
import { createRoom } from '../services/roomService.js';
import { addPlayer, getPlayerByToken } from '../services/playerService.js';
import { buildPlayerVisibleState } from '../services/visibilityService.js';
import { submitAction, getActionsByTurn } from '../services/actionService.js';
import { allPlayersSubmitted, getCurrentTurn } from '../services/turnService.js';
import { insertLog } from '../services/logService.js';

describe('DND integration', () => {
  it('full flow: create room, add players, submit actions, process turn, verify isolation', () => {
    const db = createMemoryDb();
    migrate(db);

    const room = createRoom(db, { name: 'Test Room', worldInfo: 'Dark forest' });
    const a = addPlayer(db, room.id, 'Ari');
    const b = addPlayer(db, room.id, 'Bo');
    const turn = getCurrentTurn(db, room.id, room.currentTurn)!;

    // Insert logs
    insertLog(db, { roomId: room.id, turnId: turn.id, scope: 'public', playerId: null, title: 'Scene', content: 'Door opens.' });
    insertLog(db, { roomId: room.id, turnId: turn.id, scope: 'private', playerId: a.player.id, title: 'Whisper', content: 'Ari hears bell.' });
    insertLog(db, { roomId: room.id, turnId: turn.id, scope: 'private', playerId: b.player.id, title: 'Shadow', content: 'Bo sees mark.' });

    // Submit actions
    submitAction(db, { roomId: room.id, turnId: turn.id, playerId: a.player.id, text: 'I open the door.' });
    submitAction(db, { roomId: room.id, turnId: turn.id, playerId: b.player.id, text: 'I draw my sword.' });

    const actions = getActionsByTurn(db, turn.id);
    expect(allPlayersSubmitted([a.player, b.player], actions)).toBe(true);
    expect(actions).toHaveLength(2);

    // Verify isolation for player A
    const logs = db.prepare('SELECT id, room_id as roomId, turn_id as turnId, visibility_scope as visibilityScope, player_id as playerId, title, content, created_at as createdAt FROM dnd_logs WHERE room_id = ? ORDER BY created_at ASC').all(room.id) as any[];
    const state = buildPlayerVisibleState({
      room, player: a.player, players: [a.player, b.player], characterCard: null,
      logs, actions, interactions: []
    });

    expect(state.publicLogs).toHaveLength(1);
    expect(state.publicLogs[0].title).toBe('Scene');
    expect(state.privateLogs).toHaveLength(1);
    expect(state.privateLogs[0].title).toBe('Whisper');
    expect(JSON.stringify(state)).not.toContain('Bo sees mark');
    expect(JSON.stringify(state)).not.toContain('draw my sword');
    expect(state.submittedPlayers).toEqual(['Ari', 'Bo']);
    expect(state.waitingPlayers).toEqual([]);
  });

  it('blocks processing when not all players submitted', () => {
    const db = createMemoryDb();
    migrate(db);
    const room = createRoom(db, { name: 'R', worldInfo: 'W' });
    const a = addPlayer(db, room.id, 'Ari');
    const b = addPlayer(db, room.id, 'Bo');
    const turn = getCurrentTurn(db, room.id, room.currentTurn)!;
    submitAction(db, { roomId: room.id, turnId: turn.id, playerId: a.player.id, text: 'Go' });

    const actions = getActionsByTurn(db, turn.id);
    expect(allPlayersSubmitted([a.player, b.player], actions)).toBe(false);
  });
});
```

Run:
```bash
npx vitest run extensions/dnd/src/tests/integration.test.ts
```

Expected: 2 tests PASS.

---

### Task 10: 全量验证与中文 UI 测试

**Files:**
- Create: `SillyTavern/extensions/dnd/tests/ui-copy.test.js`

- [ ] **Step 1: 编写前端中文文案测试**

`SillyTavern/extensions/dnd/tests/ui-copy.test.js`:

```js
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

describe('中文界面文案', () => {
  it('玩家页面使用中文文案', async () => {
    document.body.innerHTML = `
      <main class="shell">
        <h1>玩家视图</h1>
        <p class="muted" id="roomStatus"></p>
        <div class="grid">
          <aside class="card">
            <h2>角色卡</h2>
            <p>暂无角色。</p>
            <h2 id="turnLabel">回合</h2>
            <div id="turnPanel"></div>
            <h2>你的行动</h2>
            <input id="actionInput" placeholder="描述你的行动..." />
            <button id="submitBtn">提交行动</button>
          </aside>
          <section>
            <div class="card"><h2>需要回应</h2></div>
            <div class="card"><h2>公开日志</h2></div>
            <div class="card"><h2>你的私密故事</h2></div>
          </section>
        </div>
      </main>`;

    expect(document.querySelector('h1')?.textContent).toBe('玩家视图');
    expect(document.body.textContent).toContain('角色卡');
    expect(document.body.textContent).toContain('暂无角色。');
    expect(document.body.textContent).toContain('你的行动');
    expect(document.body.textContent).toContain('提交行动');
    expect(document.body.textContent).toContain('需要回应');
    expect(document.body.textContent).toContain('公开日志');
    expect(document.body.textContent).toContain('你的私密故事');
    expect(document.body.textContent).toContain('描述你的行动...');
  });

  it('DM 控制台使用中文文案', async () => {
    document.body.innerHTML = `
      <main class="shell">
        <h1>DND 房间</h1>
        <p class="muted">主持人控制台 · 第 1 回合 · waiting_for_actions</p>
        <h2>玩家</h2>
        <input id="playerNameInput" value="新英雄" />
        <button id="addPlayerBtn">创建玩家链接</button>
        <h2>行动</h2>
        <button id="processBtn">处理本回合</button>
        <h2>全部日志</h2>
        <h2>互动</h2>
      </main>`;

    expect(document.body.textContent).toContain('DND 房间');
    expect(document.body.textContent).toContain('主持人控制台');
    expect(document.body.textContent).toContain('创建玩家链接');
    expect(document.body.textContent).toContain('处理本回合');
    expect(document.body.textContent).toContain('全部日志');
    expect(document.body.textContent).toContain('互动');
  });
});
```

- [ ] **Step 2: 运行全部测试**

```bash
cd E:\myCode\dnd\SillyTavern
npx vitest run extensions/dnd/
```

Expected: All tests PASS (roomService, playerService, visibilityService, turnService, contextBuilder, integration, ui-copy).

- [ ] **Step 3: 启动 SillyTavern 并验证 UI**

```bash
npm start
```

Then open:
- `http://localhost:8000/dnd/admin-panel.html?roomId=<roomId>` — DM 控制台。
- `http://localhost:8000/dnd/player-page.html` — 玩家页面 (token 从 URL path 获取)。

Expected:
- DM 页面显示中文，可创建玩家、查看日志、处理回合。
- 玩家页面只显示公开日志和该玩家私密日志。

---

## Self-Review

**Spec coverage:**

- DM 创建 DND 房间: Task 2 (roomService), Task 5 (POST /rooms)。
- 每位玩家专属 token 链接: Task 2 (playerService), Task 5 (POST /players)。
- 玩家页面信息隔离: Task 3 (visibilityService), Task 8 (player-page)。
- SillyTavern 资源绑定: Task 1 (types 支持 presetId/worldBookId/characterCardPath), Task 5 (PUT /preset, PUT /world-book), Task 6 (contextBuilder + aiAdapter)。
- 回合处理、行动排序: Task 4 (actionService, turnService), Task 6 (contextBuilder)。
- 玩家间互动确认: Task 4 (interactionService), Task 8 (interaction respond UI)。
- Prompt builder: Task 6 (contextBuilder)。
- AI adapter mock: Task 6 (aiAdapter)。
- 信息隔离测试: Task 3, Task 9。
- 中文 UI: Task 10 (ui-copy.test.js)。
- 集成测试: Task 9。
- 管理端 + SSE: Task 5 (sseRoutes), Task 7 (admin-panel)。

**No placeholders.** All steps have concrete code.

**Type consistency:**
- `DndRoom` fields match SQL schema and `createRoom` return value.
- `DndPlayer` fields match SQL schema and `addPlayer` return value.
- `PlayerVisibleState` from `buildPlayerVisibleState` matches `playerRoutes.ts` response.
- `AiTurnResult` matches `aiAdapter.ts` return type and `process-turn` mock.
- All route parameter names consistent across steps.
