# AI Constraint Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a SillyTavern-like AI constraint console with editable prompt blocks, persisted room-level AI config, and final prompt preview.

**Architecture:** Store AI constraints in `rooms.ai_config_json`, expose admin APIs to read/save/preview config, and make `aiContextBuilder` use one shared prompt construction path for both preview and actual turn processing. The React admin page adds an AI constraint card without changing player isolation rules.

**Tech Stack:** Node.js, TypeScript, Express, SQLite, React, Vitest, Testing Library, Playwright.

---

## File Structure

- Modify `server/src/domain/types.ts`: add `AiConfig` and `Room.aiConfig`.
- Modify `server/src/db/schema.ts`: add `ai_config_json` column migration.
- Modify `server/src/services/aiContextBuilder.ts`: add default config and prompt-block composition.
- Modify `server/src/routes/adminRoutes.ts`: add AI config read/save/preview endpoints and use config in turn processing.
- Modify `server/src/tests/turnEngine.test.ts`: assert prompt order uses AI config.
- Modify `server/src/tests/integration.test.ts`: assert saving config changes prompt preview.
- Modify `client/src/types.ts`: add `AiConfig`.
- Modify `client/src/api.ts`: add AI config and prompt preview API calls.
- Modify `client/src/pages/AdminPage.tsx`: add AI constraint editor and preview panel.
- Modify `client/src/ui-copy.test.tsx`: assert Chinese AI constraint UI labels.

## Tasks

### Task 1: Backend AI config types and schema

- Add `AiConfig` type with fields `coreRules`, `playerAgencyRules`, `visibilityRules`, `interactionRules`, `outputFormatRules`, `styleRules`.
- Add `aiConfig: AiConfig` to `Room`.
- Add `ai_config_json TEXT NOT NULL DEFAULT '{}'` to `rooms` creation.
- Add migration guard that adds column if an existing SQLite DB lacks it.
- Verification: `rtk npm run typecheck --workspace server`.

### Task 2: Prompt builder with ordered constraint blocks

- Export `defaultAiConfig` from `aiContextBuilder.ts`.
- Add `normalizeAiConfig(value)` that merges saved partial config with defaults.
- Update `buildTurnPrompt` to accept optional `aiConfig`.
- Prompt order must be: core, agency, visibility, interaction, style, room, logs, actions, pending interactions, output format.
- Verification: add/extend `turnEngine.test.ts` and run `rtk npm test -- server/src/tests/turnEngine.test.ts`.

### Task 3: Admin AI config and prompt preview APIs

- Add helpers in `adminRoutes.ts` to parse room rows with `aiConfig`.
- Add `GET /api/admin/rooms/:roomId/ai-config`.
- Add `PUT /api/admin/rooms/:roomId/ai-config`.
- Add `GET /api/admin/rooms/:roomId/ai-prompt-preview`.
- Update `process-turn` to pass saved `aiConfig` into `processTurnActions`.
- Verification: extend integration test and run `rtk npm test -- server/src/tests/integration.test.ts`.

### Task 4: Client API/types and admin UI

- Add client `AiConfig` type.
- Add `getAiConfig`, `saveAiConfig`, `previewAiPrompt` API helpers.
- Add admin page state for config and prompt preview.
- Add an “AI 约束” card with six textareas, save button, preview button, and preview `<pre>`.
- Verification: update UI copy test and run `rtk npm test -- client/src/ui-copy.test.tsx`.

### Task 5: Full verification

- Run `rtk npm test`.
- Run `rtk npm run typecheck`.
- Run `rtk npm run build`.
- Run local dev server and Playwright UI flow: create room, confirm AI 约束 card, edit a constraint, save, preview prompt, confirm preview includes edited constraint and processing still works.

## Self-Review

Spec coverage:

- Room-level AI config: Tasks 1 and 3.
- Admin edit/save: Tasks 3 and 4.
- Prompt preview: Tasks 3 and 4.
- Shared prompt construction for preview and processing: Tasks 2 and 3.
- Tests: Tasks 2, 3, 4, 5.

No placeholders remain. Types are consistent: `AiConfig` is used on server and client, while serialized DB storage remains `ai_config_json`.
