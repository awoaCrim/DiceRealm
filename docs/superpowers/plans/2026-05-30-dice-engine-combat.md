# DND Dice Engine & Combat Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic dice engine (d4-d100, advantage/disadvantage, ability checks, saving throws, attack rolls, damage/healing), integrate it into the AI-DM turn pipeline so that dice results are system-generated not AI-fabricated, and build the combat foundation (initiative, turn order, HP/death saves).

**Architecture:** `diceService` is a pure-math module with no DB dependency — roll, modifier, advantage, check against DC. `combatService` uses it for initiative and attack resolution, reading character sheets and NPC stat blocks. AI-DM output contract gains `diceRequest` (what to roll) and the system injects `diceResult` (actual rolls) before returning to the AI for narration. Dice logs are public by default.

**Tech Stack:** TypeScript, Express, SQLite/better-sqlite3, Zod, React, Vite, Vitest.

---

## Scope Check

This plan covers: dice engine, ability checks, attack/save resolution, initiative, combat round state, AI-DM dice integration. It does NOT cover: battle maps, grid movement, full monster manual import, exploration/social subsystems, or campaign memory — those are separate plans.

## File Structure

- Create: `server/src/services/diceService.ts` — pure dice math
- Create: `server/src/services/combatService.ts` — combat state, initiative, attack resolution
- Create: `server/src/tests/diceService.test.ts` — dice unit tests
- Create: `server/src/tests/combatService.test.ts` — combat unit tests
- Modify: `server/src/domain/types.ts` — DiceRoll, CombatState, Combatant types
- Modify: `server/src/db/schema.ts` — combat_state table, dice_logs table
- Modify: `server/src/services/aiContextBuilder.ts` — dice output contract
- Modify: `server/src/routes/adminRoutes.ts` — dice endpoints, combat endpoints, process-turn integration
- Modify: `server/src/routes/playerRoutes.ts` — combat state in player view
- Modify: `server/src/services/visibilityService.ts` — combat state in player state
- Modify: `client/src/types.ts`, `client/src/api.ts` — mirror types/APIs
- Modify: `client/src/pages/PlayerPage.tsx` — combat panel, dice log
- Modify: `client/src/pages/AdminPage.tsx` — combat admin, roll dice UI
- Modify/Test: `server/src/tests/integration.test.ts` — E2E dice+combat+AI
- Modify/Test: `client/src/api.test.tsx`, `client/src/ui-copy.test.tsx`

## Task 1: Dice service (pure math, no DB)

Create `server/src/services/diceService.ts`, test `server/src/tests/diceService.test.ts`. Functions: `rollDice(die,count)` returns `{values,total}` for d4/d6/d8/d10/d12/d20/d100. `rollD20(advantage?)` natural d20 with adv/dis. `abilityCheck(score,dc,proficiency?,advantage?)` → `{roll,total,success,natural20,natural1}`. `attackRoll(modifier,proficiency,ac,advantage?)` → `{roll,total,hit,criticalHit,criticalMiss}`. `damageRoll(die,count,modifier)` → `{values,total}`. `abilityModifier(score)`.

## Task 2: Combat service (initiative, attack, damage via resourceService)

Add types: `CombatState` (round,turn,combatants,status), `Combatant`, `DiceLog`. Add tables: `combat_state`, `dice_logs`. Create `combatService.ts`: `createCombat`, `rollInitiative`, `nextTurn`, `processAttack`, `deathSave`.

## Task 3: AI-DM dice integration (process-turn dice request/result)

Extend `AiTurnResult` with optional `diceRequests` array. processTurn executes dice before building final result. Dice logged as public entries. Output contract updated.

## Task 4: Admin dice/combat APIs + process-turn

POST `/rooms/:roomId/dice/roll`, POST `/rooms/:roomId/combat/start|attack|next-turn`, GET `/rooms/:roomId/dice-logs`. Player state includes combat+dice.

## Task 5: Client combat UI

AdminPage: dice roller, combat panel, initiative, attack, dice log. PlayerPage: combat status panel, dice log.

## Task 6: Full verification

Focused tests, full test, typecheck, build, git clean check.