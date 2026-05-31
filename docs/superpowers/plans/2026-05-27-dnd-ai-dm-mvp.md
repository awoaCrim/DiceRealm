# DND AI-DM MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first local playable DND AI-DM multiplayer MVP with admin room control, per-player secret links, turn submission, visibility isolation, SQLite persistence, mockable AI, and OpenAI-compatible provider support.

**Architecture:** Use a TypeScript monorepo with a Vite React client and an Express API server. SQLite stores the full game state, while backend services (`visibilityService`, `turnEngine`, `aiContextBuilder`) enforce player isolation and turn processing. SSE pushes room/player updates to the browser.

**Tech Stack:** Node.js, TypeScript, React, Vite, Express, better-sqlite3, zod, Vitest, Testing Library, EventSource/SSE, OpenAI-compatible Chat Completions API.

---

## File Structure

Create this structure:

```text
package.json
tsconfig.base.json
vitest.config.ts
server/
  package.json
  tsconfig.json
  src/
    index.ts
    app.ts
    config.ts
    db/
      connection.ts
      schema.ts
      seedRules.ts
    domain/
      types.ts
    services/
      aiContextBuilder.ts
      aiProvider.ts
      characterService.ts
      diceService.ts
      eventBus.ts
      rulesService.ts
      turnEngine.ts
      visibilityService.ts
    routes/
      adminRoutes.ts
      playerRoutes.ts
      sseRoutes.ts
    tests/
      visibilityService.test.ts
      turnEngine.test.ts
      integration.test.ts
client/
  package.json
  tsconfig.json
  index.html
  vite.config.ts
  src/
    main.tsx
    App.tsx
    api.ts
    styles.css
    types.ts
    components/
      LogList.tsx
      CharacterCard.tsx
      TurnPanel.tsx
    pages/
      AdminPage.tsx
      HomePage.tsx
      PlayerPage.tsx
```

Responsibilities:

- `server/src/domain/types.ts`: shared domain types used by server services and API responses.
- `server/src/db/*`: SQLite connection, schema creation, and built-in SRD/open-rule seed data.
- `server/src/services/visibilityService.ts`: the only service allowed to build player-visible state.
- `server/src/services/turnEngine.ts`: turn lifecycle, all-player submission gate, submitted-at ordering, interaction request creation.
- `server/src/services/aiContextBuilder.ts`: public/private/admin AI context package construction.
- `server/src/services/aiProvider.ts`: mock provider and OpenAI-compatible provider interface.
- `server/src/routes/*`: HTTP/SSE boundaries only; business logic stays in services.
- `client/src/pages/*`: admin, player, and room creation UI.

Because this directory is not a git repository, replace commit steps with local checkpoint steps: run tests and record changed files in the task notes.

---

### Task 1: Scaffold workspace and install dependencies

**Files:**
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `vitest.config.ts`
- Create: `server/package.json`
- Create: `server/tsconfig.json`
- Create: `client/package.json`
- Create: `client/tsconfig.json`
- Create: `client/index.html`
- Create: `client/vite.config.ts`

- [ ] **Step 1: Create root package files**

`package.json`:

```json
{
  "name": "dnd-ai-dm-mvp",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "concurrently \"npm run dev --workspace server\" \"npm run dev --workspace client\"",
    "build": "npm run build --workspace server && npm run build --workspace client",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "npm run typecheck --workspace server && npm run typecheck --workspace client"
  },
  "workspaces": [
    "server",
    "client"
  ],
  "devDependencies": {
    "@testing-library/jest-dom": "latest",
    "@testing-library/react": "latest",
    "@testing-library/user-event": "latest",
    "@types/node": "latest",
    "concurrently": "latest",
    "jsdom": "latest",
    "typescript": "latest",
    "vitest": "latest"
  }
}
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  }
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['server/src/tests/**/*.test.ts', 'client/src/**/*.test.tsx'],
    globals: true
  }
});
```

- [ ] **Step 2: Create server package files**

`server/package.json`:

```json
{
  "name": "server",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "better-sqlite3": "latest",
    "cors": "latest",
    "dotenv": "latest",
    "express": "latest",
    "nanoid": "latest",
    "zod": "latest"
  },
  "devDependencies": {
    "@types/better-sqlite3": "latest",
    "@types/cors": "latest",
    "@types/express": "latest",
    "tsx": "latest"
  }
}
```

`server/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "types": ["node", "vitest/globals"]
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create client package files**

`client/package.json`:

```json
{
  "name": "client",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite --host 0.0.0.0",
    "build": "tsc -p tsconfig.json && vite build",
    "preview": "vite preview",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@vitejs/plugin-react": "latest",
    "vite": "latest",
    "react": "latest",
    "react-dom": "latest"
  },
  "devDependencies": {
    "@types/react": "latest",
    "@types/react-dom": "latest"
  }
}
```

`client/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "types": ["vite/client", "vitest/globals", "@testing-library/jest-dom"],
    "noEmit": true
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "vite.config.ts"]
}
```

`client/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>DND AI DM</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`client/vite.config.ts`:

```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/events': 'http://localhost:3000'
    }
  }
});
```

- [ ] **Step 4: Install dependencies**

Run:

```bash
rtk npm install
```

Expected: dependencies install successfully and `package-lock.json` is created.

- [ ] **Step 5: Run typecheck baseline**

Run:

```bash
rtk npm run typecheck
```

Expected: fails because source files do not exist yet or no inputs are present. This confirms scripts are wired and later tasks will make them pass.

---

### Task 2: Define domain types and database schema

**Files:**
- Create: `server/src/domain/types.ts`
- Create: `server/src/config.ts`
- Create: `server/src/db/connection.ts`
- Create: `server/src/db/schema.ts`
- Create: `server/src/db/seedRules.ts`

- [ ] **Step 1: Write domain types**

`server/src/domain/types.ts`:

```ts
export type RoomStatus = 'setup' | 'waiting_for_actions' | 'processing' | 'waiting_for_interaction' | 'needs_admin_attention';
export type TurnStatus = 'open' | 'locked' | 'processing' | 'waiting_for_interaction' | 'complete' | 'needs_admin_attention';
export type ActionStatus = 'submitted' | 'processing' | 'complete';
export type VisibilityScope = 'public' | 'private' | 'admin';
export type InteractionStatus = 'pending_target' | 'ready_for_ai' | 'resolved';

export interface Room {
  id: string;
  name: string;
  systemPrompt: string;
  worldInfo: string;
  currentTurn: number;
  status: RoomStatus;
  createdAt: string;
}

export interface Player {
  id: string;
  roomId: string;
  name: string;
  token: string;
  isConnected: boolean;
  createdAt: string;
}

export interface CharacterSheet {
  name: string;
  species: string;
  className: string;
  level: number;
  abilityScores: Record<'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha', number>;
  hitPoints: { current: number; max: number };
  armorClass: number;
  proficiencyBonus: number;
  skills: string[];
  equipment: string[];
  spells: string[];
  privateNotes: string;
}

export interface CharacterRecord {
  id: string;
  playerId: string;
  sheet: CharacterSheet;
  draftSource: 'ai' | 'manual';
  confirmed: boolean;
  updatedAt: string;
}

export interface Turn {
  id: string;
  roomId: string;
  number: number;
  status: TurnStatus;
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

export interface RuleSource {
  id: string;
  name: string;
  sourceType: 'builtin' | 'imported';
  content: unknown;
  createdAt: string;
}

export interface AiGeneration {
  id: string;
  roomId: string;
  turnId: string | null;
  provider: string;
  inputSummary: string;
  output: string;
  error: string | null;
  createdAt: string;
}

export interface PublicContext {
  room: Pick<Room, 'id' | 'name' | 'worldInfo' | 'currentTurn' | 'status'>;
  publicLogs: LogEntry[];
  submittedPlayers: string[];
  waitingPlayers: string[];
}

export interface PlayerPrivateContext {
  player: Pick<Player, 'id' | 'name'>;
  character: CharacterRecord | null;
  privateLogs: LogEntry[];
  pendingInteractions: InteractionRequest[];
}

export interface PlayerVisibleState {
  room: PublicContext['room'];
  player: Pick<Player, 'id' | 'name'>;
  character: CharacterRecord | null;
  publicLogs: LogEntry[];
  privateLogs: LogEntry[];
  pendingInteractions: InteractionRequest[];
  submittedPlayers: string[];
  waitingPlayers: string[];
}

export interface AdminState {
  room: Room;
  players: Player[];
  turns: Turn[];
  actions: PlayerAction[];
  interactions: InteractionRequest[];
  logs: LogEntry[];
  aiGenerations: AiGeneration[];
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

- [ ] **Step 2: Write config**

`server/src/config.ts`:

```ts
import 'dotenv/config';

export interface AppConfig {
  port: number;
  databasePath: string;
  aiProvider: 'mock' | 'openai-compatible';
  openAiBaseUrl: string;
  openAiApiKey: string;
  openAiModel: string;
}

export function loadConfig(): AppConfig {
  return {
    port: Number(process.env.PORT ?? 3000),
    databasePath: process.env.DATABASE_PATH ?? 'dnd.sqlite',
    aiProvider: (process.env.AI_PROVIDER as AppConfig['aiProvider']) ?? 'mock',
    openAiBaseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
    openAiApiKey: process.env.OPENAI_API_KEY ?? '',
    openAiModel: process.env.OPENAI_MODEL ?? 'gpt-4o-mini'
  };
}
```

- [ ] **Step 3: Write database connection**

`server/src/db/connection.ts`:

```ts
import Database from 'better-sqlite3';
import { loadConfig } from '../config.js';

export type AppDatabase = Database.Database;

let singleton: AppDatabase | null = null;

export function getDb(): AppDatabase {
  if (!singleton) {
    singleton = new Database(loadConfig().databasePath);
    singleton.pragma('journal_mode = WAL');
    singleton.pragma('foreign_keys = ON');
  }
  return singleton;
}

export function createMemoryDb(): AppDatabase {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  return db;
}
```

- [ ] **Step 4: Write schema**

`server/src/db/schema.ts`:

```ts
import type { AppDatabase } from './connection.js';

export function migrate(db: AppDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      world_info TEXT NOT NULL,
      current_turn INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      is_connected INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS characters (
      id TEXT PRIMARY KEY,
      player_id TEXT NOT NULL UNIQUE REFERENCES players(id) ON DELETE CASCADE,
      sheet_json TEXT NOT NULL,
      draft_source TEXT NOT NULL,
      confirmed INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rule_sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      source_type TEXT NOT NULL,
      content_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS turns (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      number INTEGER NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      UNIQUE(room_id, number)
    );

    CREATE TABLE IF NOT EXISTS actions (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
      player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      submitted_at TEXT NOT NULL,
      status TEXT NOT NULL,
      UNIQUE(turn_id, player_id)
    );

    CREATE TABLE IF NOT EXISTS interaction_requests (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
      source_player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      target_player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      prompt TEXT NOT NULL,
      target_response TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS log_entries (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
      visibility_scope TEXT NOT NULL,
      player_id TEXT REFERENCES players(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ai_generations (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
      provider TEXT NOT NULL,
      input_summary TEXT NOT NULL,
      output TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL
    );
  `);
}
```

- [ ] **Step 5: Write built-in rules seed**

`server/src/db/seedRules.ts`:

```ts
import { nanoid } from 'nanoid';
import type { AppDatabase } from './connection.js';

const builtinRules = {
  name: 'Built-in SRD-style starter rules',
  abilityChecks: 'Roll d20 + ability modifier + proficiency when applicable.',
  savingThrows: 'Roll d20 + ability modifier + proficiency when proficient.',
  combat: 'Use initiative order, armor class, attack rolls, damage rolls, and hit points.',
  note: 'This starter set is intentionally brief and only uses open, user-editable data.'
};

export function seedBuiltinRules(db: AppDatabase): void {
  const existing = db.prepare('SELECT id FROM rule_sources WHERE source_type = ? LIMIT 1').get('builtin');
  if (existing) return;

  db.prepare(`
    INSERT INTO rule_sources (id, name, source_type, content_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(nanoid(), builtinRules.name, 'builtin', JSON.stringify(builtinRules), new Date().toISOString());
}
```

- [ ] **Step 6: Run typecheck**

Run:

```bash
rtk npm run typecheck
```

Expected: may still fail because app entry files do not exist. There should be no type errors in files created by this task.

---

### Task 3: Add visibility tests and service

**Files:**
- Create: `server/src/services/visibilityService.ts`
- Create: `server/src/tests/visibilityService.test.ts`

- [ ] **Step 1: Write failing visibility tests**

`server/src/tests/visibilityService.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { LogEntry, Player, Room } from '../domain/types.js';
import { buildPlayerVisibleState } from '../services/visibilityService.js';

const room: Room = {
  id: 'room-1',
  name: 'Candlekeep Mystery',
  systemPrompt: 'Be fair.',
  worldInfo: 'A locked library at midnight.',
  currentTurn: 1,
  status: 'waiting_for_actions',
  createdAt: '2026-05-27T00:00:00.000Z'
};

const players: Player[] = [
  { id: 'player-a', roomId: 'room-1', name: 'Ari', token: 'token-a', isConnected: false, createdAt: room.createdAt },
  { id: 'player-b', roomId: 'room-1', name: 'Bo', token: 'token-b', isConnected: false, createdAt: room.createdAt }
];

const logs: LogEntry[] = [
  { id: 'public-1', roomId: 'room-1', turnId: null, visibilityScope: 'public', playerId: null, title: 'Scene', content: 'Everyone sees the sealed door.', createdAt: room.createdAt },
  { id: 'private-a', roomId: 'room-1', turnId: null, visibilityScope: 'private', playerId: 'player-a', title: 'Whisper', content: 'Ari hears a hidden bell.', createdAt: room.createdAt },
  { id: 'private-b', roomId: 'room-1', turnId: null, visibilityScope: 'private', playerId: 'player-b', title: 'Shadow', content: 'Bo sees a secret mark.', createdAt: room.createdAt },
  { id: 'admin-1', roomId: 'room-1', turnId: null, visibilityScope: 'admin', playerId: null, title: 'Debug', content: 'Full truth.', createdAt: room.createdAt }
];

describe('buildPlayerVisibleState', () => {
  it('returns public logs and only the selected player private logs', () => {
    const state = buildPlayerVisibleState({
      room,
      player: players[0],
      players,
      character: null,
      logs,
      actions: [],
      interactions: []
    });

    expect(state.publicLogs.map((log) => log.id)).toEqual(['public-1']);
    expect(state.privateLogs.map((log) => log.id)).toEqual(['private-a']);
    expect(JSON.stringify(state)).not.toContain('Bo sees a secret mark');
    expect(JSON.stringify(state)).not.toContain('Full truth');
  });

  it('shows submitted and waiting player names without exposing action text', () => {
    const state = buildPlayerVisibleState({
      room,
      player: players[0],
      players,
      character: null,
      logs,
      actions: [
        { id: 'action-a', roomId: 'room-1', turnId: 'turn-1', playerId: 'player-a', text: 'I pick the lock quietly.', submittedAt: room.createdAt, status: 'submitted' }
      ],
      interactions: []
    });

    expect(state.submittedPlayers).toEqual(['Ari']);
    expect(state.waitingPlayers).toEqual(['Bo']);
    expect(JSON.stringify(state)).not.toContain('pick the lock');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
rtk npm test -- server/src/tests/visibilityService.test.ts
```

Expected: FAIL with module not found for `visibilityService.js`.

- [ ] **Step 3: Implement visibility service**

`server/src/services/visibilityService.ts`:

```ts
import type { CharacterRecord, InteractionRequest, LogEntry, Player, PlayerAction, PlayerVisibleState, Room } from '../domain/types.js';

export interface BuildPlayerVisibleStateInput {
  room: Room;
  player: Player;
  players: Player[];
  character: CharacterRecord | null;
  logs: LogEntry[];
  actions: PlayerAction[];
  interactions: InteractionRequest[];
}

export function buildPlayerVisibleState(input: BuildPlayerVisibleStateInput): PlayerVisibleState {
  const submittedPlayerIds = new Set(input.actions.map((action) => action.playerId));

  return {
    room: {
      id: input.room.id,
      name: input.room.name,
      worldInfo: input.room.worldInfo,
      currentTurn: input.room.currentTurn,
      status: input.room.status
    },
    player: {
      id: input.player.id,
      name: input.player.name
    },
    character: input.character,
    publicLogs: input.logs.filter((log) => log.visibilityScope === 'public'),
    privateLogs: input.logs.filter((log) => log.visibilityScope === 'private' && log.playerId === input.player.id),
    pendingInteractions: input.interactions.filter(
      (interaction) => interaction.targetPlayerId === input.player.id && interaction.status === 'pending_target'
    ),
    submittedPlayers: input.players.filter((player) => submittedPlayerIds.has(player.id)).map((player) => player.name),
    waitingPlayers: input.players.filter((player) => !submittedPlayerIds.has(player.id)).map((player) => player.name)
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
rtk npm test -- server/src/tests/visibilityService.test.ts
```

Expected: PASS for both visibility tests.

- [ ] **Step 5: Checkpoint**

Run:

```bash
rtk npm run typecheck
```

Expected: no errors from visibility service or tests. If other entrypoint files are still missing, continue to the next task.

---

### Task 4: Add AI context builder and AI providers

**Files:**
- Create: `server/src/services/aiContextBuilder.ts`
- Create: `server/src/services/aiProvider.ts`

- [ ] **Step 1: Write AI context builder**

`server/src/services/aiContextBuilder.ts`:

```ts
import type { InteractionRequest, LogEntry, Player, PlayerAction, PublicContext, Room } from '../domain/types.js';

export interface BuildPublicContextInput {
  room: Room;
  players: Player[];
  logs: LogEntry[];
  actions: PlayerAction[];
}

export function buildPublicContext(input: BuildPublicContextInput): PublicContext {
  const submitted = new Set(input.actions.map((action) => action.playerId));

  return {
    room: {
      id: input.room.id,
      name: input.room.name,
      worldInfo: input.room.worldInfo,
      currentTurn: input.room.currentTurn,
      status: input.room.status
    },
    publicLogs: input.logs.filter((log) => log.visibilityScope === 'public'),
    submittedPlayers: input.players.filter((player) => submitted.has(player.id)).map((player) => player.name),
    waitingPlayers: input.players.filter((player) => !submitted.has(player.id)).map((player) => player.name)
  };
}

export function summarizeActionsInSubmissionOrder(actions: PlayerAction[], players: Player[]): string {
  const playerNames = new Map(players.map((player) => [player.id, player.name]));
  return [...actions]
    .sort((left, right) => left.submittedAt.localeCompare(right.submittedAt))
    .map((action, index) => `${index + 1}. ${playerNames.get(action.playerId) ?? 'Unknown'}: ${action.text}`)
    .join('\n');
}

export function buildTurnPrompt(input: {
  room: Room;
  players: Player[];
  publicLogs: LogEntry[];
  actions: PlayerAction[];
  interactions: InteractionRequest[];
}): string {
  return [
    'You are the AI Dungeon Master for a multiplayer DND game.',
    'Do not decide player intent, consent, dialogue, or PvP responses for any player.',
    'Process submitted actions strictly in the listed order.',
    'If an action targets another player and needs their agency, create an interaction request instead of resolving their choice.',
    'Do not reveal private information between players.',
    `Room: ${input.room.name}`,
    `World: ${input.room.worldInfo}`,
    'Public log so far:',
    input.publicLogs.map((log) => `- ${log.title}: ${log.content}`).join('\n') || '- No public log yet.',
    'Submitted actions in order:',
    summarizeActionsInSubmissionOrder(input.actions, input.players),
    'Pending interactions:',
    input.interactions.map((interaction) => `- ${interaction.prompt}`).join('\n') || '- None.',
    'Return JSON with publicLog, privateUpdatesByPlayer, ruleResults, interactionRequests.'
  ].join('\n\n');
}
```

- [ ] **Step 2: Write AI provider interface and implementations**

`server/src/services/aiProvider.ts`:

```ts
import type { AiTurnResult } from '../domain/types.js';
import type { AppConfig } from '../config.js';

export interface AiProvider {
  name: string;
  generateTurnResult(prompt: string): Promise<AiTurnResult>;
}

export class MockAiProvider implements AiProvider {
  name = 'mock';

  async generateTurnResult(prompt: string): Promise<AiTurnResult> {
    return {
      publicLog: `The party's actions echo through the scene.\n\n${prompt.slice(0, 240)}`,
      privateUpdatesByPlayer: {},
      ruleResults: ['Mock ruling: no rule conflict detected.'],
      interactionRequests: []
    };
  }
}

export class OpenAiCompatibleProvider implements AiProvider {
  name = 'openai-compatible';

  constructor(private readonly config: AppConfig) {}

  async generateTurnResult(prompt: string): Promise<AiTurnResult> {
    if (!this.config.openAiApiKey) {
      throw new Error('OPENAI_API_KEY is required when AI_PROVIDER=openai-compatible');
    }

    const response = await fetch(`${this.config.openAiBaseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.config.openAiApiKey}`
      },
      body: JSON.stringify({
        model: this.config.openAiModel,
        messages: [
          { role: 'system', content: 'Return strict JSON only. Never include markdown fences.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7
      })
    });

    if (!response.ok) {
      throw new Error(`AI provider failed with ${response.status}: ${await response.text()}`);
    }

    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('AI provider returned no content');

    const parsed = JSON.parse(content) as AiTurnResult;
    return {
      publicLog: parsed.publicLog ?? '',
      privateUpdatesByPlayer: parsed.privateUpdatesByPlayer ?? {},
      ruleResults: parsed.ruleResults ?? [],
      interactionRequests: parsed.interactionRequests ?? []
    };
  }
}

export function createAiProvider(config: AppConfig): AiProvider {
  if (config.aiProvider === 'openai-compatible') return new OpenAiCompatibleProvider(config);
  return new MockAiProvider();
}
```

- [ ] **Step 3: Run typecheck**

Run:

```bash
rtk npm run typecheck
```

Expected: no errors in AI files.

---

### Task 5: Add dice, character, rules, and event services

**Files:**
- Create: `server/src/services/diceService.ts`
- Create: `server/src/services/characterService.ts`
- Create: `server/src/services/rulesService.ts`
- Create: `server/src/services/eventBus.ts`

- [ ] **Step 1: Write dice service**

`server/src/services/diceService.ts`:

```ts
export interface DiceRoll {
  expression: string;
  rolls: number[];
  modifier: number;
  total: number;
}

export function rollDie(sides: number): number {
  return Math.floor(Math.random() * sides) + 1;
}

export function rollD20(modifier = 0): DiceRoll {
  const roll = rollDie(20);
  return {
    expression: `1d20${modifier >= 0 ? '+' : ''}${modifier}`,
    rolls: [roll],
    modifier,
    total: roll + modifier
  };
}
```

- [ ] **Step 2: Write character service**

`server/src/services/characterService.ts`:

```ts
import type { CharacterSheet } from '../domain/types.js';

export function createStarterCharacter(name: string): CharacterSheet {
  return {
    name,
    species: 'Human',
    className: 'Fighter',
    level: 1,
    abilityScores: { str: 15, dex: 13, con: 14, int: 10, wis: 12, cha: 8 },
    hitPoints: { current: 12, max: 12 },
    armorClass: 16,
    proficiencyBonus: 2,
    skills: ['Athletics', 'Perception'],
    equipment: ['Longsword', 'Shield', 'Explorer Pack'],
    spells: [],
    privateNotes: ''
  };
}
```

- [ ] **Step 3: Write rules service**

`server/src/services/rulesService.ts`:

```ts
import { nanoid } from 'nanoid';
import type { AppDatabase } from '../db/connection.js';

export function listRuleSources(db: AppDatabase): unknown[] {
  return db.prepare('SELECT id, name, source_type as sourceType, content_json as contentJson, created_at as createdAt FROM rule_sources ORDER BY created_at ASC').all();
}

export function importRuleSource(db: AppDatabase, name: string, content: unknown): string {
  const id = nanoid();
  db.prepare(`
    INSERT INTO rule_sources (id, name, source_type, content_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, name, 'imported', JSON.stringify(content), new Date().toISOString());
  return id;
}
```

- [ ] **Step 4: Write event bus**

`server/src/services/eventBus.ts`:

```ts
import { EventEmitter } from 'node:events';

export type RoomEvent = 'room-updated';

const emitter = new EventEmitter();

export function publishRoomUpdate(roomId: string): void {
  emitter.emit('room-updated', roomId);
}

export function subscribeRoomUpdate(roomId: string, listener: () => void): () => void {
  const wrapped = (updatedRoomId: string) => {
    if (updatedRoomId === roomId) listener();
  };
  emitter.on('room-updated', wrapped);
  return () => emitter.off('room-updated', wrapped);
}
```

- [ ] **Step 5: Run typecheck**

Run:

```bash
rtk npm run typecheck
```

Expected: no errors in service files.

---

### Task 6: Add turn engine tests and implementation

**Files:**
- Create: `server/src/services/turnEngine.ts`
- Create: `server/src/tests/turnEngine.test.ts`

- [ ] **Step 1: Write failing turn engine tests**

`server/src/tests/turnEngine.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { MockAiProvider } from '../services/aiProvider.js';
import { processTurnActions } from '../services/turnEngine.js';
import type { Player, PlayerAction, Room, Turn } from '../domain/types.js';

const room: Room = {
  id: 'room-1',
  name: 'Order Test',
  systemPrompt: 'Fair DM',
  worldInfo: 'A narrow bridge.',
  currentTurn: 1,
  status: 'processing',
  createdAt: '2026-05-27T00:00:00.000Z'
};

const turn: Turn = {
  id: 'turn-1',
  roomId: 'room-1',
  number: 1,
  status: 'processing',
  startedAt: room.createdAt,
  endedAt: null
};

const players: Player[] = [
  { id: 'a', roomId: 'room-1', name: 'Ari', token: 'token-a', isConnected: false, createdAt: room.createdAt },
  { id: 'b', roomId: 'room-1', name: 'Bo', token: 'token-b', isConnected: false, createdAt: room.createdAt }
];

describe('processTurnActions', () => {
  it('sorts actions by submittedAt before prompting the AI', async () => {
    const actions: PlayerAction[] = [
      { id: 'late', roomId: 'room-1', turnId: 'turn-1', playerId: 'b', text: 'I go second.', submittedAt: '2026-05-27T00:00:02.000Z', status: 'submitted' },
      { id: 'early', roomId: 'room-1', turnId: 'turn-1', playerId: 'a', text: 'I go first.', submittedAt: '2026-05-27T00:00:01.000Z', status: 'submitted' }
    ];

    let capturedPrompt = '';
    const provider = new MockAiProvider();
    provider.generateTurnResult = async (prompt) => {
      capturedPrompt = prompt;
      return { publicLog: 'Done', privateUpdatesByPlayer: {}, ruleResults: [], interactionRequests: [] };
    };

    await processTurnActions({ room, turn, players, actions, publicLogs: [], interactions: [], aiProvider: provider });

    expect(capturedPrompt.indexOf('I go first.')).toBeLessThan(capturedPrompt.indexOf('I go second.'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
rtk npm test -- server/src/tests/turnEngine.test.ts
```

Expected: FAIL with module not found for `turnEngine.js`.

- [ ] **Step 3: Implement turn engine pure processing function**

`server/src/services/turnEngine.ts`:

```ts
import type { AiProvider } from './aiProvider.js';
import { buildTurnPrompt } from './aiContextBuilder.js';
import type { AiTurnResult, InteractionRequest, LogEntry, Player, PlayerAction, Room, Turn } from '../domain/types.js';

export interface ProcessTurnActionsInput {
  room: Room;
  turn: Turn;
  players: Player[];
  actions: PlayerAction[];
  publicLogs: LogEntry[];
  interactions: InteractionRequest[];
  aiProvider: AiProvider;
}

export async function processTurnActions(input: ProcessTurnActionsInput): Promise<AiTurnResult> {
  const orderedActions = [...input.actions].sort((left, right) => left.submittedAt.localeCompare(right.submittedAt));
  const prompt = buildTurnPrompt({
    room: input.room,
    players: input.players,
    publicLogs: input.publicLogs,
    actions: orderedActions,
    interactions: input.interactions
  });

  return input.aiProvider.generateTurnResult(prompt);
}

export function allPlayersSubmitted(players: Player[], actions: PlayerAction[]): boolean {
  const submitted = new Set(actions.map((action) => action.playerId));
  return players.length > 0 && players.every((player) => submitted.has(player.id));
}
```

- [ ] **Step 4: Run turn engine tests**

Run:

```bash
rtk npm test -- server/src/tests/turnEngine.test.ts
```

Expected: PASS.

---

### Task 7: Add Express app, repositories in routes, and room APIs

**Files:**
- Create: `server/src/app.ts`
- Create: `server/src/index.ts`
- Create: `server/src/routes/adminRoutes.ts`
- Create: `server/src/routes/playerRoutes.ts`
- Create: `server/src/routes/sseRoutes.ts`

- [ ] **Step 1: Write app entry**

`server/src/app.ts`:

```ts
import cors from 'cors';
import express from 'express';
import type { AppDatabase } from './db/connection.js';
import { createAiProvider } from './services/aiProvider.js';
import { loadConfig } from './config.js';
import { createAdminRouter } from './routes/adminRoutes.js';
import { createPlayerRouter } from './routes/playerRoutes.js';
import { createSseRouter } from './routes/sseRoutes.js';

export function createApp(db: AppDatabase) {
  const app = express();
  const config = loadConfig();
  const aiProvider = createAiProvider(config);

  app.use(cors());
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/admin', createAdminRouter(db, aiProvider));
  app.use('/api/player', createPlayerRouter(db));
  app.use('/events', createSseRouter(db));

  return app;
}
```

`server/src/index.ts`:

```ts
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { getDb } from './db/connection.js';
import { migrate } from './db/schema.js';
import { seedBuiltinRules } from './db/seedRules.js';

const config = loadConfig();
const db = getDb();
migrate(db);
seedBuiltinRules(db);

createApp(db).listen(config.port, () => {
  console.log(`DND AI-DM server listening on http://localhost:${config.port}`);
});
```

- [ ] **Step 2: Write admin routes**

`server/src/routes/adminRoutes.ts`:

```ts
import { Router } from 'express';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import type { AppDatabase } from '../db/connection.js';
import type { AiProvider } from '../services/aiProvider.js';
import { createStarterCharacter } from '../services/characterService.js';
import { importRuleSource, listRuleSources } from '../services/rulesService.js';
import { allPlayersSubmitted, processTurnActions } from '../services/turnEngine.js';
import { publishRoomUpdate } from '../services/eventBus.js';

const createRoomSchema = z.object({
  name: z.string().min(1),
  worldInfo: z.string().min(1),
  systemPrompt: z.string().default('You are a fair AI Dungeon Master.')
});

const addPlayerSchema = z.object({ name: z.string().min(1) });
const submitRuleSchema = z.object({ name: z.string().min(1), content: z.unknown() });

export function createAdminRouter(db: AppDatabase, aiProvider: AiProvider): Router {
  const router = Router();

  router.post('/rooms', (req, res) => {
    const input = createRoomSchema.parse(req.body);
    const roomId = nanoid();
    const turnId = nanoid();
    const now = new Date().toISOString();

    const tx = db.transaction(() => {
      db.prepare('INSERT INTO rooms (id, name, system_prompt, world_info, current_turn, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(roomId, input.name, input.systemPrompt, input.worldInfo, 1, 'waiting_for_actions', now);
      db.prepare('INSERT INTO turns (id, room_id, number, status, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(turnId, roomId, 1, 'open', now, null);
      db.prepare('INSERT INTO log_entries (id, room_id, turn_id, visibility_scope, player_id, title, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(nanoid(), roomId, turnId, 'public', null, 'Opening Scene', input.worldInfo, now);
    });
    tx();

    res.json({ roomId, adminUrl: `/admin/${roomId}` });
  });

  router.post('/rooms/:roomId/players', (req, res) => {
    const input = addPlayerSchema.parse(req.body);
    const room = db.prepare('SELECT id FROM rooms WHERE id = ?').get(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const playerId = nanoid();
    const characterId = nanoid();
    const token = nanoid(48);
    const now = new Date().toISOString();
    const sheet = createStarterCharacter(input.name);

    const tx = db.transaction(() => {
      db.prepare('INSERT INTO players (id, room_id, name, token, is_connected, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(playerId, req.params.roomId, input.name, token, 0, now);
      db.prepare('INSERT INTO characters (id, player_id, sheet_json, draft_source, confirmed, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(characterId, playerId, JSON.stringify(sheet), 'manual', 1, now);
    });
    tx();
    publishRoomUpdate(req.params.roomId);

    res.json({ playerId, token, playerUrl: `/player/${token}` });
  });

  router.get('/rooms/:roomId', (req, res) => {
    const room = db.prepare('SELECT id, name, system_prompt as systemPrompt, world_info as worldInfo, current_turn as currentTurn, status, created_at as createdAt FROM rooms WHERE id = ?').get(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const players = db.prepare('SELECT id, room_id as roomId, name, token, is_connected as isConnected, created_at as createdAt FROM players WHERE room_id = ? ORDER BY created_at ASC').all(req.params.roomId);
    const turns = db.prepare('SELECT id, room_id as roomId, number, status, started_at as startedAt, ended_at as endedAt FROM turns WHERE room_id = ? ORDER BY number ASC').all(req.params.roomId);
    const actions = db.prepare('SELECT id, room_id as roomId, turn_id as turnId, player_id as playerId, text, submitted_at as submittedAt, status FROM actions WHERE room_id = ? ORDER BY submitted_at ASC').all(req.params.roomId);
    const interactions = db.prepare('SELECT id, room_id as roomId, turn_id as turnId, source_player_id as sourcePlayerId, target_player_id as targetPlayerId, type, prompt, target_response as targetResponse, status, created_at as createdAt FROM interaction_requests WHERE room_id = ? ORDER BY created_at ASC').all(req.params.roomId);
    const logs = db.prepare('SELECT id, room_id as roomId, turn_id as turnId, visibility_scope as visibilityScope, player_id as playerId, title, content, created_at as createdAt FROM log_entries WHERE room_id = ? ORDER BY created_at ASC').all(req.params.roomId);
    const aiGenerations = db.prepare('SELECT id, room_id as roomId, turn_id as turnId, provider, input_summary as inputSummary, output, error, created_at as createdAt FROM ai_generations WHERE room_id = ? ORDER BY created_at ASC').all(req.params.roomId);
    res.json({ room, players, turns, actions, interactions, logs, aiGenerations });
  });

  router.post('/rooms/:roomId/rules', (req, res) => {
    const input = submitRuleSchema.parse(req.body);
    const id = importRuleSource(db, input.name, input.content);
    res.json({ id });
  });

  router.get('/rules', (_req, res) => {
    res.json({ rules: listRuleSources(db) });
  });

  router.post('/rooms/:roomId/process-turn', async (req, res) => {
    const room = db.prepare('SELECT id, name, system_prompt as systemPrompt, world_info as worldInfo, current_turn as currentTurn, status, created_at as createdAt FROM rooms WHERE id = ?').get(req.params.roomId) as any;
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const turn = db.prepare('SELECT id, room_id as roomId, number, status, started_at as startedAt, ended_at as endedAt FROM turns WHERE room_id = ? AND number = ?').get(req.params.roomId, room.currentTurn) as any;
    const players = db.prepare('SELECT id, room_id as roomId, name, token, is_connected as isConnected, created_at as createdAt FROM players WHERE room_id = ? ORDER BY created_at ASC').all(req.params.roomId) as any[];
    const actions = db.prepare('SELECT id, room_id as roomId, turn_id as turnId, player_id as playerId, text, submitted_at as submittedAt, status FROM actions WHERE turn_id = ? ORDER BY submitted_at ASC').all(turn.id) as any[];

    if (!allPlayersSubmitted(players, actions)) return res.status(409).json({ error: 'Waiting for all players to submit actions' });

    const publicLogs = db.prepare('SELECT id, room_id as roomId, turn_id as turnId, visibility_scope as visibilityScope, player_id as playerId, title, content, created_at as createdAt FROM log_entries WHERE room_id = ? AND visibility_scope = ? ORDER BY created_at ASC').all(req.params.roomId, 'public') as any[];
    const interactions = db.prepare('SELECT id, room_id as roomId, turn_id as turnId, source_player_id as sourcePlayerId, target_player_id as targetPlayerId, type, prompt, target_response as targetResponse, status, created_at as createdAt FROM interaction_requests WHERE room_id = ? AND status != ? ORDER BY created_at ASC').all(req.params.roomId, 'resolved') as any[];

    try {
      db.prepare('UPDATE rooms SET status = ? WHERE id = ?').run('processing', req.params.roomId);
      const result = await processTurnActions({ room, turn, players, actions, publicLogs, interactions, aiProvider });
      const now = new Date().toISOString();
      const nextTurnId = nanoid();
      const tx = db.transaction(() => {
        db.prepare('INSERT INTO log_entries (id, room_id, turn_id, visibility_scope, player_id, title, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(nanoid(), req.params.roomId, turn.id, 'public', null, `Turn ${room.currentTurn}`, result.publicLog, now);
        for (const [playerId, content] of Object.entries(result.privateUpdatesByPlayer)) {
          db.prepare('INSERT INTO log_entries (id, room_id, turn_id, visibility_scope, player_id, title, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(nanoid(), req.params.roomId, turn.id, 'private', playerId, `Private Turn ${room.currentTurn}`, content, now);
        }
        for (const interaction of result.interactionRequests) {
          db.prepare('INSERT INTO interaction_requests (id, room_id, turn_id, source_player_id, target_player_id, type, prompt, target_response, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(nanoid(), req.params.roomId, turn.id, interaction.sourcePlayerId, interaction.targetPlayerId, interaction.type, interaction.prompt, null, 'pending_target', now);
        }
        db.prepare('UPDATE turns SET status = ?, ended_at = ? WHERE id = ?').run('complete', now, turn.id);
        db.prepare('UPDATE actions SET status = ? WHERE turn_id = ?').run('complete', turn.id);
        db.prepare('INSERT INTO turns (id, room_id, number, status, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(nextTurnId, req.params.roomId, room.currentTurn + 1, 'open', now, null);
        db.prepare('UPDATE rooms SET current_turn = ?, status = ? WHERE id = ?').run(room.currentTurn + 1, 'waiting_for_actions', req.params.roomId);
        db.prepare('INSERT INTO ai_generations (id, room_id, turn_id, provider, input_summary, output, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(nanoid(), req.params.roomId, turn.id, aiProvider.name, `Processed ${actions.length} actions`, JSON.stringify(result), null, now);
      });
      tx();
      publishRoomUpdate(req.params.roomId);
      res.json({ result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      db.prepare('UPDATE rooms SET status = ? WHERE id = ?').run('needs_admin_attention', req.params.roomId);
      db.prepare('INSERT INTO ai_generations (id, room_id, turn_id, provider, input_summary, output, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(nanoid(), req.params.roomId, turn.id, aiProvider.name, `Failed processing ${actions.length} actions`, '', message, new Date().toISOString());
      publishRoomUpdate(req.params.roomId);
      res.status(500).json({ error: message });
    }
  });

  return router;
}
```

- [ ] **Step 3: Write player routes**

`server/src/routes/playerRoutes.ts`:

```ts
import { Router } from 'express';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import type { AppDatabase } from '../db/connection.js';
import { buildPlayerVisibleState } from '../services/visibilityService.js';
import { publishRoomUpdate } from '../services/eventBus.js';

const actionSchema = z.object({ text: z.string().min(1) });
const interactionResponseSchema = z.object({ response: z.string().min(1) });

function getPlayerByToken(db: AppDatabase, token: string): any | null {
  return db.prepare('SELECT id, room_id as roomId, name, token, is_connected as isConnected, created_at as createdAt FROM players WHERE token = ?').get(token) as any | null;
}

export function createPlayerRouter(db: AppDatabase): Router {
  const router = Router();

  router.get('/:token/state', (req, res) => {
    const player = getPlayerByToken(db, req.params.token);
    if (!player) return res.status(404).json({ error: 'Not found' });

    const room = db.prepare('SELECT id, name, system_prompt as systemPrompt, world_info as worldInfo, current_turn as currentTurn, status, created_at as createdAt FROM rooms WHERE id = ?').get(player.roomId) as any;
    const players = db.prepare('SELECT id, room_id as roomId, name, token, is_connected as isConnected, created_at as createdAt FROM players WHERE room_id = ? ORDER BY created_at ASC').all(player.roomId) as any[];
    const characterRow = db.prepare('SELECT id, player_id as playerId, sheet_json as sheetJson, draft_source as draftSource, confirmed, updated_at as updatedAt FROM characters WHERE player_id = ?').get(player.id) as any;
    const character = characterRow ? { id: characterRow.id, playerId: characterRow.playerId, sheet: JSON.parse(characterRow.sheetJson), draftSource: characterRow.draftSource, confirmed: Boolean(characterRow.confirmed), updatedAt: characterRow.updatedAt } : null;
    const logs = db.prepare('SELECT id, room_id as roomId, turn_id as turnId, visibility_scope as visibilityScope, player_id as playerId, title, content, created_at as createdAt FROM log_entries WHERE room_id = ? ORDER BY created_at ASC').all(player.roomId) as any[];
    const turn = db.prepare('SELECT id FROM turns WHERE room_id = ? AND number = ?').get(player.roomId, room.currentTurn) as any;
    const actions = turn ? db.prepare('SELECT id, room_id as roomId, turn_id as turnId, player_id as playerId, text, submitted_at as submittedAt, status FROM actions WHERE turn_id = ? ORDER BY submitted_at ASC').all(turn.id) as any[] : [];
    const interactions = db.prepare('SELECT id, room_id as roomId, turn_id as turnId, source_player_id as sourcePlayerId, target_player_id as targetPlayerId, type, prompt, target_response as targetResponse, status, created_at as createdAt FROM interaction_requests WHERE room_id = ? ORDER BY created_at ASC').all(player.roomId) as any[];

    res.json(buildPlayerVisibleState({ room, player, players, character, logs, actions, interactions }));
  });

  router.post('/:token/actions', (req, res) => {
    const input = actionSchema.parse(req.body);
    const player = getPlayerByToken(db, req.params.token);
    if (!player) return res.status(404).json({ error: 'Not found' });
    const room = db.prepare('SELECT current_turn as currentTurn FROM rooms WHERE id = ?').get(player.roomId) as any;
    const turn = db.prepare('SELECT id FROM turns WHERE room_id = ? AND number = ?').get(player.roomId, room.currentTurn) as any;
    const now = new Date().toISOString();

    db.prepare('INSERT OR REPLACE INTO actions (id, room_id, turn_id, player_id, text, submitted_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(nanoid(), player.roomId, turn.id, player.id, input.text, now, 'submitted');
    publishRoomUpdate(player.roomId);
    res.json({ ok: true });
  });

  router.post('/:token/interactions/:interactionId/respond', (req, res) => {
    const input = interactionResponseSchema.parse(req.body);
    const player = getPlayerByToken(db, req.params.token);
    if (!player) return res.status(404).json({ error: 'Not found' });

    const result = db.prepare('UPDATE interaction_requests SET target_response = ?, status = ? WHERE id = ? AND target_player_id = ?')
      .run(input.response, 'ready_for_ai', req.params.interactionId, player.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Interaction not found' });
    publishRoomUpdate(player.roomId);
    res.json({ ok: true });
  });

  return router;
}
```

- [ ] **Step 4: Write SSE route**

`server/src/routes/sseRoutes.ts`:

```ts
import { Router } from 'express';
import type { AppDatabase } from '../db/connection.js';
import { subscribeRoomUpdate } from '../services/eventBus.js';

export function createSseRouter(_db: AppDatabase): Router {
  const router = Router();

  router.get('/rooms/:roomId', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);

    const unsubscribe = subscribeRoomUpdate(req.params.roomId, () => {
      res.write(`event: room-updated\ndata: ${JSON.stringify({ roomId: req.params.roomId })}\n\n`);
    });

    req.on('close', () => {
      unsubscribe();
      res.end();
    });
  });

  return router;
}
```

- [ ] **Step 5: Run server typecheck**

Run:

```bash
rtk npm run typecheck --workspace server
```

Expected: PASS.

---

### Task 8: Add integration test for room, players, isolation, and turn processing

**Files:**
- Create: `server/src/tests/integration.test.ts`

- [ ] **Step 1: Write integration test**

`server/src/tests/integration.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { createMemoryDb } from '../db/connection.js';
import { migrate } from '../db/schema.js';
import { seedBuiltinRules } from '../db/seedRules.js';

describe('DND AI-DM integration', () => {
  it('creates a room, isolates player state, accepts actions, and processes a turn', async () => {
    const db = createMemoryDb();
    migrate(db);
    seedBuiltinRules(db);
    const app = createApp(db);
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;

    try {
      const roomRes = await fetch(`${base}/api/admin/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Test Room', worldInfo: 'A moonlit gate.', systemPrompt: 'Fair DM' })
      });
      const room = await roomRes.json() as { roomId: string };

      const ariRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/players`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Ari' })
      });
      const ari = await ariRes.json() as { token: string };

      const boRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/players`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Bo' })
      });
      const bo = await boRes.json() as { token: string };

      db.prepare('INSERT INTO log_entries (id, room_id, turn_id, visibility_scope, player_id, title, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run('secret-bo', room.roomId, null, 'private', db.prepare('SELECT id FROM players WHERE token = ?').get(bo.token).id, 'Secret', 'Bo knows the passphrase.', new Date().toISOString());

      const ariStateRes = await fetch(`${base}/api/player/${ari.token}/state`);
      const ariStateText = await ariStateRes.text();
      expect(ariStateText).not.toContain('Bo knows the passphrase');

      await fetch(`${base}/api/player/${ari.token}/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'I inspect the gate.' })
      });
      await fetch(`${base}/api/player/${bo.token}/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'I watch the shadows.' })
      });

      const processRes = await fetch(`${base}/api/admin/rooms/${room.roomId}/process-turn`, { method: 'POST' });
      expect(processRes.status).toBe(200);
      const adminRes = await fetch(`${base}/api/admin/rooms/${room.roomId}`);
      const adminText = await adminRes.text();
      expect(adminText).toContain('The party');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });
});
```

- [ ] **Step 2: Run integration test**

Run:

```bash
rtk npm test -- server/src/tests/integration.test.ts
```

Expected: PASS.

---

### Task 9: Add client API layer and shared client types

**Files:**
- Create: `client/src/types.ts`
- Create: `client/src/api.ts`

- [ ] **Step 1: Write client types**

`client/src/types.ts`:

```ts
export interface LogEntry {
  id: string;
  title: string;
  content: string;
  visibilityScope: 'public' | 'private' | 'admin';
  createdAt: string;
}

export interface CharacterRecord {
  id: string;
  sheet: {
    name: string;
    species: string;
    className: string;
    level: number;
    hitPoints: { current: number; max: number };
    armorClass: number;
    skills: string[];
    equipment: string[];
    spells: string[];
    privateNotes: string;
  };
  confirmed: boolean;
}

export interface PlayerVisibleState {
  room: { id: string; name: string; worldInfo: string; currentTurn: number; status: string };
  player: { id: string; name: string };
  character: CharacterRecord | null;
  publicLogs: LogEntry[];
  privateLogs: LogEntry[];
  pendingInteractions: Array<{ id: string; prompt: string; type: string }>;
  submittedPlayers: string[];
  waitingPlayers: string[];
}

export interface AdminState {
  room: { id: string; name: string; worldInfo: string; currentTurn: number; status: string };
  players: Array<{ id: string; name: string; token: string }>;
  actions: Array<{ id: string; playerId: string; text: string; submittedAt: string }>;
  interactions: Array<{ id: string; prompt: string; status: string }>;
  logs: LogEntry[];
  aiGenerations: Array<{ id: string; provider: string; output: string; error: string | null }>;
}
```

- [ ] **Step 2: Write API helpers**

`client/src/api.ts`:

```ts
import type { AdminState, PlayerVisibleState } from './types';

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) }
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<T>;
}

export function createRoom(input: { name: string; worldInfo: string; systemPrompt: string }) {
  return jsonRequest<{ roomId: string; adminUrl: string }>('/api/admin/rooms', { method: 'POST', body: JSON.stringify(input) });
}

export function addPlayer(roomId: string, name: string) {
  return jsonRequest<{ playerId: string; token: string; playerUrl: string }>(`/api/admin/rooms/${roomId}/players`, { method: 'POST', body: JSON.stringify({ name }) });
}

export function getAdminState(roomId: string) {
  return jsonRequest<AdminState>(`/api/admin/rooms/${roomId}`);
}

export function processTurn(roomId: string) {
  return jsonRequest<{ result: unknown }>(`/api/admin/rooms/${roomId}/process-turn`, { method: 'POST' });
}

export function getPlayerState(token: string) {
  return jsonRequest<PlayerVisibleState>(`/api/player/${token}/state`);
}

export function submitAction(token: string, text: string) {
  return jsonRequest<{ ok: true }>(`/api/player/${token}/actions`, { method: 'POST', body: JSON.stringify({ text }) });
}

export function respondToInteraction(token: string, interactionId: string, response: string) {
  return jsonRequest<{ ok: true }>(`/api/player/${token}/interactions/${interactionId}/respond`, { method: 'POST', body: JSON.stringify({ response }) });
}

export function subscribeRoom(roomId: string, onUpdate: () => void): () => void {
  const events = new EventSource(`/events/rooms/${roomId}`);
  events.addEventListener('room-updated', onUpdate);
  return () => events.close();
}
```

- [ ] **Step 3: Run client typecheck**

Run:

```bash
rtk npm run typecheck --workspace client
```

Expected: may fail because React entry files are not created yet. API/types should not have type errors.

---

### Task 10: Build React pages and components

**Files:**
- Create: `client/src/main.tsx`
- Create: `client/src/App.tsx`
- Create: `client/src/styles.css`
- Create: `client/src/components/LogList.tsx`
- Create: `client/src/components/CharacterCard.tsx`
- Create: `client/src/components/TurnPanel.tsx`
- Create: `client/src/pages/HomePage.tsx`
- Create: `client/src/pages/AdminPage.tsx`
- Create: `client/src/pages/PlayerPage.tsx`

- [ ] **Step 1: Write entry and router**

`client/src/main.tsx`:

```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

`client/src/App.tsx`:

```tsx
import { AdminPage } from './pages/AdminPage';
import { HomePage } from './pages/HomePage';
import { PlayerPage } from './pages/PlayerPage';

export function App() {
  const path = window.location.pathname;
  const [, route, id] = path.split('/');

  if (route === 'admin' && id) return <AdminPage roomId={id} />;
  if (route === 'player' && id) return <PlayerPage token={id} />;
  return <HomePage />;
}
```

- [ ] **Step 2: Write styles**

`client/src/styles.css`:

```css
:root {
  color: #f4ead7;
  background: #17120d;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

body {
  margin: 0;
  min-height: 100vh;
  background: radial-gradient(circle at top left, #3a2718, #17120d 40%, #0f0c09);
}

button, input, textarea {
  font: inherit;
}

button {
  border: 0;
  border-radius: 10px;
  padding: 0.7rem 1rem;
  color: #1d130b;
  background: #e8b65b;
  cursor: pointer;
  font-weight: 700;
}

button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

input, textarea {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid #715336;
  border-radius: 10px;
  color: #f4ead7;
  background: rgba(20, 14, 9, 0.9);
  padding: 0.75rem;
}

textarea {
  min-height: 8rem;
  resize: vertical;
}

.shell {
  width: min(1280px, calc(100% - 32px));
  margin: 0 auto;
  padding: 32px 0;
}

.grid {
  display: grid;
  grid-template-columns: 320px 1fr;
  gap: 20px;
}

.card {
  border: 1px solid rgba(232, 182, 91, 0.25);
  border-radius: 18px;
  background: rgba(23, 18, 13, 0.78);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.35);
  padding: 20px;
}

.log-entry {
  border-left: 3px solid #e8b65b;
  padding: 0.7rem 0 0.7rem 1rem;
  margin: 0.7rem 0;
  background: rgba(255, 255, 255, 0.03);
}

.muted {
  color: #bba88d;
}

.pill-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.pill {
  border-radius: 999px;
  padding: 0.25rem 0.6rem;
  background: rgba(232, 182, 91, 0.16);
}

@media (max-width: 840px) {
  .grid {
    grid-template-columns: 1fr;
  }
}
```

- [ ] **Step 3: Write shared components**

`client/src/components/LogList.tsx`:

```tsx
import type { LogEntry } from '../types';

export function LogList({ title, logs }: { title: string; logs: LogEntry[] }) {
  return (
    <section className="card">
      <h2>{title}</h2>
      {logs.length === 0 ? <p className="muted">No entries yet.</p> : null}
      {logs.map((log) => (
        <article className="log-entry" key={log.id}>
          <strong>{log.title}</strong>
          <p>{log.content}</p>
          <small className="muted">{new Date(log.createdAt).toLocaleString()}</small>
        </article>
      ))}
    </section>
  );
}
```

`client/src/components/CharacterCard.tsx`:

```tsx
import type { CharacterRecord } from '../types';

export function CharacterCard({ character }: { character: CharacterRecord | null }) {
  if (!character) return <section className="card"><h2>Character</h2><p className="muted">No character assigned.</p></section>;
  const sheet = character.sheet;
  return (
    <section className="card">
      <h2>{sheet.name}</h2>
      <p>{sheet.species} {sheet.className} · Level {sheet.level}</p>
      <div className="pill-row">
        <span className="pill">HP {sheet.hitPoints.current}/{sheet.hitPoints.max}</span>
        <span className="pill">AC {sheet.armorClass}</span>
      </div>
      <h3>Skills</h3>
      <p>{sheet.skills.join(', ') || 'None'}</p>
      <h3>Equipment</h3>
      <p>{sheet.equipment.join(', ') || 'None'}</p>
      {sheet.privateNotes ? <p className="muted">Private: {sheet.privateNotes}</p> : null}
    </section>
  );
}
```

`client/src/components/TurnPanel.tsx`:

```tsx
export function TurnPanel({ currentTurn, status, submittedPlayers, waitingPlayers }: {
  currentTurn: number;
  status: string;
  submittedPlayers: string[];
  waitingPlayers: string[];
}) {
  return (
    <section className="card">
      <h2>Turn {currentTurn}</h2>
      <p>Status: <strong>{status}</strong></p>
      <h3>Submitted</h3>
      <p>{submittedPlayers.length ? submittedPlayers.join(', ') : 'No one yet.'}</p>
      <h3>Waiting</h3>
      <p>{waitingPlayers.length ? waitingPlayers.join(', ') : 'All players submitted.'}</p>
    </section>
  );
}
```

- [ ] **Step 4: Write home page**

`client/src/pages/HomePage.tsx`:

```tsx
import { useState } from 'react';
import { createRoom } from '../api';

export function HomePage() {
  const [name, setName] = useState('The Candlekeep Door');
  const [worldInfo, setWorldInfo] = useState('A sealed library door glows under moonlight.');
  const [systemPrompt, setSystemPrompt] = useState('You are a fair AI Dungeon Master. Preserve player agency.');
  const [error, setError] = useState('');

  async function submit() {
    setError('');
    try {
      const room = await createRoom({ name, worldInfo, systemPrompt });
      window.location.href = room.adminUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <main className="shell">
      <section className="card">
        <h1>DND AI-DM</h1>
        <p className="muted">Create a local multiplayer room with isolated player views.</p>
        <label>Room name<input value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label>World info<textarea value={worldInfo} onChange={(event) => setWorldInfo(event.target.value)} /></label>
        <label>AI-DM instruction<textarea value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} /></label>
        {error ? <p>{error}</p> : null}
        <button onClick={submit}>Create Room</button>
      </section>
    </main>
  );
}
```

- [ ] **Step 5: Write admin page**

`client/src/pages/AdminPage.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { addPlayer, getAdminState, processTurn, subscribeRoom } from '../api';
import { LogList } from '../components/LogList';
import type { AdminState } from '../types';

export function AdminPage({ roomId }: { roomId: string }) {
  const [state, setState] = useState<AdminState | null>(null);
  const [playerName, setPlayerName] = useState('New Hero');
  const [lastLink, setLastLink] = useState('');
  const [error, setError] = useState('');

  async function refresh() {
    setState(await getAdminState(roomId));
  }

  useEffect(() => {
    void refresh();
    return subscribeRoom(roomId, () => void refresh());
  }, [roomId]);

  async function createPlayer() {
    setError('');
    try {
      const player = await addPlayer(roomId, playerName);
      setLastLink(`${window.location.origin}${player.playerUrl}`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function advance() {
    setError('');
    try {
      await processTurn(roomId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (!state) return <main className="shell"><p>Loading...</p></main>;

  return (
    <main className="shell">
      <h1>{state.room.name}</h1>
      <p className="muted">Admin console · Turn {state.room.currentTurn} · {state.room.status}</p>
      <div className="grid">
        <aside className="card">
          <h2>Players</h2>
          {state.players.map((player) => <p key={player.id}>{player.name}</p>)}
          <input value={playerName} onChange={(event) => setPlayerName(event.target.value)} />
          <button onClick={createPlayer}>Create Player Link</button>
          {lastLink ? <p><a href={lastLink}>{lastLink}</a></p> : null}
          <h2>Actions</h2>
          {state.actions.map((action) => <p key={action.id}>{action.playerId}: {action.text}</p>)}
          <button onClick={advance}>Process Turn</button>
          {error ? <p>{error}</p> : null}
          <h2>AI Errors</h2>
          {state.aiGenerations.filter((gen) => gen.error).map((gen) => <p key={gen.id}>{gen.error}</p>)}
        </aside>
        <section>
          <LogList title="All Logs" logs={state.logs} />
        </section>
      </div>
    </main>
  );
}
```

- [ ] **Step 6: Write player page**

`client/src/pages/PlayerPage.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { getPlayerState, respondToInteraction, submitAction, subscribeRoom } from '../api';
import { CharacterCard } from '../components/CharacterCard';
import { LogList } from '../components/LogList';
import { TurnPanel } from '../components/TurnPanel';
import type { PlayerVisibleState } from '../types';

export function PlayerPage({ token }: { token: string }) {
  const [state, setState] = useState<PlayerVisibleState | null>(null);
  const [action, setAction] = useState('');
  const [error, setError] = useState('');

  async function refresh() {
    setState(await getPlayerState(token));
  }

  useEffect(() => {
    let unsubscribe = () => {};
    void getPlayerState(token).then((next) => {
      setState(next);
      unsubscribe = subscribeRoom(next.room.id, () => void refresh());
    });
    return () => unsubscribe();
  }, [token]);

  async function submit() {
    setError('');
    try {
      await submitAction(token, action);
      setAction('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function respond(interactionId: string, response: string) {
    await respondToInteraction(token, interactionId, response);
    await refresh();
  }

  if (!state) return <main className="shell"><p>Loading...</p></main>;

  return (
    <main className="shell">
      <h1>{state.room.name}</h1>
      <p className="muted">Player view · {state.player.name}</p>
      <div className="grid">
        <aside>
          <CharacterCard character={state.character} />
          <TurnPanel currentTurn={state.room.currentTurn} status={state.room.status} submittedPlayers={state.submittedPlayers} waitingPlayers={state.waitingPlayers} />
          <section className="card">
            <h2>Your Action</h2>
            <textarea value={action} onChange={(event) => setAction(event.target.value)} placeholder="Describe what your character attempts this turn." />
            <button disabled={!action.trim()} onClick={submit}>Submit Action</button>
            {error ? <p>{error}</p> : null}
          </section>
          {state.pendingInteractions.map((interaction) => (
            <section className="card" key={interaction.id}>
              <h2>Response Needed</h2>
              <p>{interaction.prompt}</p>
              <button onClick={() => respond(interaction.id, 'I consent or cooperate.')}>Consent / Cooperate</button>
              <button onClick={() => respond(interaction.id, 'I resist or refuse.')}>Resist / Refuse</button>
            </section>
          ))}
        </aside>
        <section>
          <LogList title="Public Log" logs={state.publicLogs} />
          <LogList title="Your Private Story" logs={state.privateLogs} />
        </section>
      </div>
    </main>
  );
}
```

- [ ] **Step 7: Run client typecheck**

Run:

```bash
rtk npm run typecheck --workspace client
```

Expected: PASS.

---

### Task 11: Full verification

**Files:**
- Modify only if previous tests expose issues.

- [ ] **Step 1: Run all tests**

Run:

```bash
rtk npm test
```

Expected: all server tests pass.

- [ ] **Step 2: Run full typecheck**

Run:

```bash
rtk npm run typecheck
```

Expected: server and client typecheck pass.

- [ ] **Step 3: Build both workspaces**

Run:

```bash
rtk npm run build
```

Expected: server emits `server/dist`, client emits `client/dist`, with no TypeScript or Vite errors.

- [ ] **Step 4: Start local app**

Run:

```bash
rtk npm run dev
```

Expected: server listens on `http://localhost:3000` and client listens on `http://localhost:5173`.

- [ ] **Step 5: Manual golden-path UI verification**

Open `http://localhost:5173` and verify:

1. Create a room.
2. In admin page, create two players.
3. Open both generated player links in separate tabs.
4. Submit one action from each player.
5. Return to admin page and click `Process Turn`.
6. Confirm public log updates for both players.
7. Confirm each player page does not show the other player's action text in its player state.

Expected: the first playable loop works locally with mock AI.

---

## Self-Review

Spec coverage:

- Local Web MVP: covered by Tasks 1, 7, 10, 11.
- React frontend: covered by Tasks 9 and 10.
- Node/TypeScript backend: covered by Tasks 1, 2, 7.
- SQLite persistence: covered by Task 2 and route usage in Task 7.
- OpenAI-compatible provider and provider abstraction: covered by Task 4.
- Built-in open rule data and import capability: covered by Tasks 2, 5, 7.
- AI-assisted/manual character creation: first version provides manual starter character generation in Task 5 and player creation in Task 7; full editable character UI is intentionally outside initial playable loop and should be the first follow-up.
- Admin console and player pages: covered by Task 10.
- Turn-based AI-DM flow: covered by Tasks 6, 7, 8.
- Player interaction confirmation: data model and response route covered by Tasks 2 and 7; AI-created interaction UI covered by Task 10.
- Information isolation: covered by Tasks 3, 8, 9, 10.
- Testing strategy: covered by Tasks 3, 6, 8, 11.

Placeholder scan: no TBD/TODO/fill-in placeholders remain. The plan intentionally names one follow-up outside the initial playable loop, but every included MVP task has concrete files and commands.

Type consistency: Type names and route fields are consistent across server and client for the initial loop.
