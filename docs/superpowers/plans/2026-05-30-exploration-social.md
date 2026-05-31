# Exploration & Social Structured Subsystems

**Goal:** Build independent exploration (search, stealth, lockpick, trap, track, puzzle, item-use) and social (persuade, deceive, intimidate, insight, haggle, interrogate, negotiate, ally) skill-check services using the existing dice engine, with structured outcomes and NPC attitude tracking.

**Architecture:** `explorationService` + `socialService` are pure logic layers over diceService + character sheets. Each action type maps to a DND ability+skill, sets a DC, rolls with advantage/penalty, and returns structured results with automatic log entries and resource impacts.

## Task 1: Exploration service

**server/src/services/explorationService.ts** + test:
- `skillCheck(characterSheet, skill, dc, advantage? )` → {roll,total,success,critical,description}
- `searchArea(dc, proficiency?)` → investigation check
- `stealthCheck(dexMod, proficiency?, advantage?)` → dex+stealth vs passive perception
- `lockpick(dexMod, proficiency?, dc)` → thieves' tools dex check
- `disarmTrap(dexMod, proficiency?, dc)` → same pattern
- `trackTarget(wisMod, proficiency?, dc)` → survival check
- `solvePuzzle(intMod, dc)` → pure INT check
- `useItemLog` → for consumable usage tracking

Each returns `{success, criticalSuccess, criticalFail, resultText, resourceCost?}`.

## Task 2: Social service + NPC attitude

**server/src/services/socialService.ts** + test:
- `socialCheck(skill, modifier, npcAttitude, dc)` → attitude modifies DC (+5 hostile, 0 neutral, -5 friendly)
- `persuade` → charisma + persuasion
- `deceive` → charisma + deception
- `intimidate` → charisma + intimidation
- `insight` → wisdom + insight
- `haggle` → charisma + persuasion with price modifier
- `negotiate` → complex multi-check with attitude tracking
- `updateNpcAttitude(npcId, newAttitude, reason)` → integrates with campaign NPCs

NPC attitude scale: hostile (-2) → unfriendly (-1) → neutral (0) → friendly (+1) → allied (+2).

## Task 3: Multi-player action types

Extend PlayerAction with `actionType: 'narrative'|'exploration'|'social'|'combat'|'ooc'` and `visibilityScope: 'public'|'party'|'dm_only'`. Support hidden rolls (dice request flagged as private → only appear in privateLogs).

## Task 4: Integration + client UI + tests

Admin dice panel gets exploration/social quick-roll buttons. Player action form gets action type selector. Combat panel stays existing. Full verification.
