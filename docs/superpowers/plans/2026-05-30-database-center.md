# Database Management Center — URL Import Implementation Plan

> **Goal:** Add remote URL database import with source tracking, versioning, hash verification, and JS sandboxing.

**Architecture:** `remoteDbImportService` downloads JSON/JS from URLs, validates format, auto-detects type, stores source metadata (URL/hash/version), and exposes via admin API. JS-type databases are parsed safely without execution.

## Task 1: Remote import service + schema

**Files:** server/src/domain/types.ts, server/src/db/schema.ts, server/src/services/remoteDbImportService.ts, server/src/tests/remoteDbImportService.test.ts

Types: `RemoteDbSource` (id, url, resolvedUrl, name, type, version, fileHash, fileSize, entryCount, lastChecked, createdAt), `RemoteDbImport` (sourceId, resourceType, resourceId, localEdits).

Tables: `remote_db_sources`, `remote_db_imports`.

Service: `fetchRemoteDbJson(url)` → fetch + validate JSON. `importRemoteDb(db, url, fallbackName)` → detect type (world_book/preset/character_options/rules), save source, convert entries, return preview. `checkForUpdates(db, sourceId)` → compare hash, list changes. `importJsDatabase(url)` → evaluate in isolated Function() sandbox with only `module={exports:{}}`, read exports, reject any I/O calls.

## Task 2: Admin APIs

**Files:** server/src/routes/adminRoutes.ts, server/src/tests/integration.test.ts

POST `/db/import-from-url` → importRemoteDb. GET `/db/sources` → list sources. POST `/db/sources/:id/check-updates`. POST `/db/sources/:id/update`. DELETE `/db/sources/:id`.

## Task 3: Client UI

AdminPage: "数据库管理" tab with URL input, import button, source list with status/version/hash, check-updates/update/delete actions. Import preview before confirmation.

## Task 4: Full verification

Tests, typecheck, build, git clean.
