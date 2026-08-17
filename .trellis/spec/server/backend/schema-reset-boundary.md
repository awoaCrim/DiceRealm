# Removed Schema Compatibility Boundary

## 1. Scope / Trigger

Use this contract when removing a persisted feature and its migration from the maintained local SQLite schema. The rule-material feature was intentionally removed, so `011_rule_sources.sql`, `platform_rule_sources`, and the rule-specific HTTP/contracts/modules are not maintained production surfaces.

The maintained schema does not recreate the removed table. A narrow compatibility migration may handle the one explicitly recognized legacy state described below; this is not a general legacy upgrade mechanism.

## 2. Maintained schema

The maintained migration admission set is represented by the current phase constant:

```ts
PHASE3_APPROVED_MIGRATION_FILENAMES: readonly string[];
verifyMigrationManifest(options: { migrationsDir: string; manifestPath: string }): void;
```

`PHASE2_APPROVED_MIGRATION_FILENAMES` remains the named pre-adjudication baseline for compatibility tests and bounded legacy inspection; it is not the ordinary startup schema after migration 016.

A fresh maintained fixture applies the current Phase 3 set, including `016_server_adjudication_dice.sql`, and does not create `platform_rule_sources`. The migration manifest, approved set, temporary fixtures, and schema inventory agree on the absence of `011_rule_sources.sql`.

## 3. Bounded compatibility migration

The startup bridge may remove exactly one identifiable retired-rule state:

- `platform_migrations` is exactly the current maintained set plus the row `{ version: '011', name: '011_rule_sources.sql' }`; or, for a database that has not crossed the explicit 016 boundary, exactly the pre-016 maintained set plus that row;
- `platform_rule_sources` is an actual table with the expected legacy rule-source columns.

The pre-016 form is a cleanup-only compatibility shape. The bridge never applies migration 016; after cleanup, the ordinary Phase 3 startup gate still rejects a database missing 016. It is therefore not a general schema-upgrade path.

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
| Exact current approved set + legacy `011` + expected table | Create a paired backup, remove only the rule table/tracking row atomically, then continue the startup gate. |
| Legacy marker without the expected table/columns | Fail closed; do not mutate. |
| Rule table without the exact legacy marker | Fail closed; do not mutate. |
| Incomplete, foreign, or ambiguous applied migration set | Fail closed; do not mutate. |
| Backup or migration transaction failure | Do not listen; live database remains unchanged by the transaction and backup is retained. |
| Existing database with unrelated gameplay data | Preserve all unrelated tables and rows. |

## 5. Good / Base / Bad cases

- **Good**: admit the exact old rule-source state, create a consistent backup, perform the two removal statements atomically, and verify the resulting maintained set.
- **Compatibility-only**: a pre-016 rule-source state may have the retired table removed with the same backup guarantees, but startup must then stop at the Phase 3 migration gate rather than silently applying 016.
- **Base**: a fresh maintained database never contains the removed table or migration.
- **Bad**: unconditionally drop `platform_rule_sources`, delete arbitrary migration rows, rebuild/replace the database, or accept a foreign/incomplete migration set because the table happens to exist.

## 6. Tests required

- Fresh schema inventory asserts the rule-source table is absent.
- Compatibility migration tests use temporary SQLite files and prove the backup is a valid pre-migration copy, the table/tracking row are removed, and unrelated data remains.
- A failing transaction leaves the live legacy table and tracking row intact and does not listen.
- Ambiguous or malformed legacy states fail closed without mutation.
- Production-directory search confirms no active rule route, module, contract, error code, or client navigation remains.
- Full tests, typecheck, build, and browser checks do not touch repository-root SQLite artifacts except an explicit final smoke test of the configured development database.
