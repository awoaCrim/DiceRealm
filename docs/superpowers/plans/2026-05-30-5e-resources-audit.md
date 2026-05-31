# 5e Structured Resources & Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the next 5e slice: structured character resources (HP, hit dice, spell slots, ammo, consumables, currency, conditions), short/long rest operations, AI-DM auto-patching with mandatory audit log, and admin rollback.

**Architecture:** Server adds `characterResourceService` for resource CRUD and rest ops, `characterAuditService` for change logging and rollback. AI output contract gains optional `resourceChanges`. Admin APIs expose audit history and rollback. Player UI shows current resources, recent changes, and rest buttons. Rollback restores one atomic audit record.

**Tech Stack:** TypeScript, Express, SQLite/better-sqlite3, Zod, React, Vite, Vitest, Testing Library.


## Scope Check

This plan covers Phase 4 (structured resources + rest) and Phase 5 (audit/rollback) from the approved spec. It does NOT implement the dice/rule engine, combat, exploration, or database center URL imports.

## Task 1: Resource types, schema, and service

**Files:** server/src/domain/types.ts, server/src/db/schema.ts, server/src/services/characterResourceService.ts, server/src/tests/characterResourceService.test.ts

- [x] **Step 1:** Write failing test: create memory DB, seed approved resource_rules (hit_dice, spell_slots), create character, test `getCharacterResources` returns default HP/hitDice/spellSlots/ammo/consumables/currency/conditions, `applyResourcePatch` validates path/value/before, `shortRest` recovers hitDice→HP, `longRest` full HP + half hitDice + spellSlots.
- [x] **Step 2:** Run `rtk npm test -- server/src/tests/characterResourceService.test.ts`, expect fail.
- [x] **Step 3:** Add `CharacterResources` type. Add `character_resource_changes` table. Implement service with resource model: HP, tempHP, maxHP, hitDice, spellSlots, ammo, consumables, currency(gp/sp/cp), conditions, short/long rest functions, applyResourcePatch with path validation (allowlisted paths, value checks, before verification).
- [x] **Step 4:** Tests pass, typecheck pass.

## Task 2: Audit service and rollback

**Files:** server/src/services/characterAuditService.ts, server/src/tests/characterAuditService.test.ts

- [x] **Step 1:** Write failing test: apply resource change, verify audit row created with before/after/reason/ruleRefs. Rollback restores before value and marks revertedAt.
- [x] **Step 2:** Run `rtk npm test -- server/src/tests/characterAuditService.test.ts`, expect fail.
- [x] **Step 3:** Implement `recordResourceChange(db,{roomId,characterId,actorType,actorId,changeType,before,after,reason,ruleRefs})`, `listCharacterResourceChanges(db,roomId,{characterId?,limit?})`, `rollbackResourceChange(db,changeId,revertedBy)` — single row, idempotent guard (already reverted).
- [x] **Step 4:** Tests pass, typecheck pass.

## Task 3: Admin APIs for resources and audit

**Files:** server/src/routes/adminRoutes.ts, server/src/routes/playerRoutes.ts, server/src/routes/adminResourceRoutes.ts, server/src/tests/integration.test.ts

- [x] **Step 1:** Integration test: player creates confirmed character, admin POST rest op, admin GET resource changes, admin POST rollback, player state reflects.
- [x] **Step 2:** Run focused test, expect fail.
- [x] **Step 3:** Add routes: `POST /rooms/:roomId/characters/:charId/rest` (action=short|long), `GET /rooms/:roomId/character-resource-changes`, `POST /rooms/:roomId/character-resource-changes/:changeId/rollback`. Player state includes resource snapshot + recent changes. Admin state includes resource changes.
- [x] **Step 4:** Tests pass, typecheck pass.

## Task 4: AI-DM resource contract

**Files:** server/src/domain/types.ts (AiTurnResult), server/src/services/turnEngine.ts, server/src/services/aiContextBuilder.ts, server/src/tests/integration.test.ts

- [x] **Step 1:** Integration test: use mock AI that returns resourceChanges `[{characterId,path:'hitPoints.current',before:12,after:8,reason:'盗贼砍伤',ruleRefs:['PHB p.194']}]`. Verify resource updated, audit row created, player state reflects.
- [x] **Step 2:** Extend AiTurnResult with optional `characterResourceChanges`. Extend processTurnActions to validate and apply AI resource patches via resourceService (validate characterId belongs to room, path allowed, before matches, value in range). Record audit. Report rejected patches as errors in ai_generations.
- [x] **Step 3:** Extend prompt-build to include resource contract in output format rules.
- [x] **Step 4:** Tests pass, typecheck pass.

## Task 5: Client UI for resources, rest, and changes

**Files:** client/src/types.ts, client/src/api.ts, client/src/pages/PlayerPage.tsx, client/src/pages/AdminPage.tsx, client/src/ui-copy.test.tsx

- [x] **Step 1:** API test for resource/rest/audit client functions.
- [x] **Step 2:** Add types and API functions.
- [x] **Step 3:** Player UI: resource panel (HP bar, hit dice, spell slots, currency, conditions), short/long rest buttons, recent changes list.
- [x] **Step 4:** Admin UI: character resource changes list, rollback button per change.
- [x] **Step 5:** UI tests pass, typecheck pass.

## Task 6: Full verification

- [x] **Step 1:** Focused server tests: `characterResourceService.test.ts characterAuditService.test.ts integration.test.ts`.
- [x] **Step 2:** Focused client tests: `api.test.tsx ui-copy.test.tsx`.
- [x] **Step 3:** Full test suite, typecheck, build, git status, check-ignore PDFs.
- [x] **Step 4:** Do not commit unless explicitly requested.

---

**Follow-up:** After this plan, the design doc's 5e phases are complete. Next major subsystems per the /goal: dice/rule engine, combat/exploration/social mechanics, database management center URL imports, long-term campaign memory.
