# Removed Schema Compatibility Boundary

## 1. Scope / Trigger

Use this contract when removing a persisted feature and its migration from the maintained local SQLite schema. The rule-material feature was intentionally removed, so `011_rule_sources.sql`, `platform_rule_sources`, and the rule-specific HTTP/contracts/modules are not maintained production surfaces.

The maintained schema does not recreate the removed table. A narrow compatibility migration may handle the one explicitly recognized legacy state described below; this is not a general legacy upgrade mechanism.

## 2. Maintained schema

The maintained migration admission set is represented by:

```ts
PHASE2_APPROVED_MIGRATION_FILENAMES: readonly string[];
verifyMigrationManifest(options: { migrationsDir: string; manifestPath: string }): void;
```

A fresh maintained fixture does not create `platform_rule_sources`. The migration manifest, approved set, temporary fixtures, and schema inventory agree on the absence of `011_rule_sources.sql`.

## 3. Bounded compatibility migration

Normal startup may migrate exactly one identifiable old state:

- `platform_migrations` is exactly the maintained approved set plus the row `{ version: '011', name: '011_rule_sources.sql' }`;
- `platform_rule_sources` is an actual table with the expected legacy rule-source columns.

The migration must:

1. run while the instance lock is held;
2. create a non-overwriting SQLite `backup()` copy before mutation;
3. pair the backup with the existing local credential key when that key is a regular file;
4. drop only `platform_rule_sources` and delete only the exact `011` tracking row in one transaction;
5. run integrity and foreign-key checks inside that transaction before commit;
6. continue startup only after the transaction succeeds.

The database is never deleted or replaced automatically. The backup remains available if later startup checks fail.

## 4. Admission and fail-closed matrix

| Condition | Required result |
|---|---|
| Fresh temporary database | Maintained schema initializes without rule-source objects. |
| Exact approved set + legacy `011` + expected table | Create a paired backup, remove only the rule table/tracking row atomically, then continue startup. |
| Legacy marker without the expected table/columns | Fail closed; do not mutate. |
| Rule table without the exact legacy marker | Fail closed; do not mutate. |
| Incomplete, foreign, or ambiguous applied migration set | Fail closed; do not mutate. |
| Backup or migration transaction failure | Do not listen; live database remains unchanged by the transaction and backup is retained. |
| Existing database with unrelated gameplay data | Preserve all unrelated tables and rows. |

## 5. Good / Base / Bad cases

- **Good**: admit the exact old rule-source state, create a consistent backup, perform the two removal statements atomically, and verify the resulting maintained set.
- **Base**: a fresh maintained database never contains the removed table or migration.
- **Bad**: unconditionally drop `platform_rule_sources`, delete arbitrary migration rows, rebuild/replace the database, or accept a foreign/incomplete migration set because the table happens to exist.

## 6. Tests required

- Fresh schema inventory asserts the rule-source table is absent.
- Compatibility migration tests use temporary SQLite files and prove the backup is a valid pre-migration copy, the table/tracking row are removed, and unrelated data remains.
- A failing transaction leaves the live legacy table and tracking row intact and does not listen.
- Ambiguous or malformed legacy states fail closed without mutation.
- Production-directory search confirms no active rule route, module, contract, error code, or client navigation remains.
- Full tests, typecheck, build, and browser checks do not touch repository-root SQLite artifacts except an explicit final smoke test of the configured development database.
