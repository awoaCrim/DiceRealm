# Campaign Memory & Session Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans.

**Goal:** Add AI-generated session summaries, structured campaign state (quests, NPCs, locations), and long-term memory retrieval so campaigns persist across sessions.

**Architecture:** `campaignMemoryService` owns summaries and structured state in new DB tables. AI is called with a dedicated summary prompt after N turns or on admin trigger. Current-campaign context is injected into AI-DM prompts. Player/admin UI shows session history, quest log, NPC journal.

**Tech Stack:** TypeScript, Express, SQLite/better-sqlite3, Zod, React, Vite, Vitest.

## Task 1: Schema, types, and campaign memory service

**Files:** server/src/domain/types.ts, server/src/db/schema.ts, server/src/services/campaignMemoryService.ts, server/src/tests/campaignMemoryService.test.ts

Add types: `SessionSummary` (id, roomId, turnStart, turnEnd, summary, questUpdates, npcUpdates, locationUpdates, characterUpdates, createdAt), `CampaignQuest` (id, roomId, title, status, description, updatedAt), `CampaignNpc` (id, roomId, name, role, attitude, notes, location, updatedAt), `CampaignLocation`, `WorldChange`.

Add tables: `session_summaries`, `campaign_quests`, `campaign_npcs`, `campaign_locations`, `world_changes`.

Implement: `createSessionSummary(db, roomId, input)`, `listSessionSummaries(db, roomId)`, `upsertCampaignQuest/Npc/Location`, `buildCampaignContext(roomId)` → string for prompt injection, `listQuests/Npcs/Locations`.

- [x] **Step 1:** Write tests: create summary, list summaries, upsert quest/NPC/location, build context string.
- [x] **Step 2:** FAIL.
- [x] **Step 3:** Add types, schema tables, implement service.
- [x] **Step 4:** Tests PASS + typecheck.

## Task 2: AI summary generation and auto-trigger

**Files:** server/src/services/campaignMemoryService.ts, server/src/routes/adminRoutes.ts, server/src/tests/integration.test.ts

In process-turn-after-completion: if `room.currentTurn % 5 === 0` or admin triggers, build summary prompt from recent logs + quests + NPCs + character states, call AI provider, parse structured summary JSON, store in `session_summaries` and upsert `campaign_quests/npcs/locations`.

- [x] **Step 1:** Integration test: process 5 turns, verify summary auto-generated, quest/NPC state updated.
- [x] **Step 2:** FAIL (no auto-summary logic).
- [x] **Step 3:** Add `generateSessionSummary` using chat provider, add auto-trigger in process-turn, handle errors gracefully.
- [x] **Step 4:** PASS + typecheck.

## Task 3: Campaign context injection into AI-DM

**Files:** server/src/services/aiContextBuilder.ts, server/src/routes/adminRoutes.ts

In `buildTurnPrompt`: add campaign context section from `buildCampaignContext(roomId)` including active quests, known NPCs, recent world changes, last session summary.

- [x] **Step 1:** Integration test: verify prompt contains campaign context after summary generated.
- [x] **Step 2:** FAIL.
- [x] **Step 3:** Integrate into prompt builder.
- [x] **Step 4:** PASS + typecheck.

## Task 4: Admin/player APIs and client UI

**Files:** server/src/routes/adminRoutes.ts, server/src/routes/playerRoutes.ts, client/src/types.ts, client/src/api.ts, client/src/pages/AdminPage.tsx, client/src/pages/PlayerPage.tsx

Admin: POST generate-summary, GET summaries, quests, NPCs, locations. Player: GET session history, quest log, NPC journal (discoverable-by-character).

Client: Admin has "战役记忆" tab with summary list, quest/NPC editor. Player has "冒险日志" with last session summary, active quests, known NPCs.

- [x] **Step 1:** API + UI tests.
- [x] **Step 2:** FAIL.
- [x] **Step 3:** Implement endpoints + UI components.
- [x] **Step 4:** PASS + typecheck.

## Task 5: Full verification

Focused tests, full test suite, typecheck, build, git clean.
