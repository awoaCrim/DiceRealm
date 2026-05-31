# AI DM Structured Preset Engine

**Goal:** Add preset-type categorization (新手教学/规则严格/剧情优先 etc.) with module-based injection per scene type, and preset templates/quick-switch UI.

**Strategy:** Extend existing `prompt_presets`/`prompt_blocks` with preset type tags and scene-type triggers. Keep backward compatibility.

## Task 1: Preset types and module categories

**Files:** server/src/domain/types.ts, server/src/db/schema.ts

Add `PresetType` enum ('tutorial'|'rules_strict'|'story_first'|'combat_first'|'casual'|'dark_fantasy'|'sandbox'|'epic'). Add `ModuleCategory` enum ('core_identity'|'player_boundary'|'npc_autonomy'|'anti_omniscience'|'style'|'perspective'|'pacing'|'rules_judgment'|'status_update'|'summary'|'worldbook_injection').

Add `category` and `scene_type` columns to `prompt_blocks` via ALTER TABLE (or nullable new columns).

## Task 2: Preset templates

Create `server/src/services/dmPresetService.ts`: predefined templates for each PresetType with default blocks per category. `applyPresetTemplate(db, type)` → creates preset + blocks. `listPresetTemplates()` → returns template metadata. `switchActivePreset(db, presetId)` → activate with clean deactivation.

## Task 3: Scene-type triggered injection

Extend prompt builder: when building prompt, check current scene type (exploration/social/combat). Inject blocks matching scene_type or 'all'. Scene type auto-detected from combat state or player action context.

## Task 4: Admin UI + client

AdminPage: "预设模板" section with preset type cards, template preview, "应用模板" button, "当前预设" indicator. PlayerPage: no preset visibility (AI behavior is transparent to players per silent injection rule).

## Task 5: Tests + verification
