# Default migration for removed rule-source schema

## Decision

The user explicitly changed the earlier reset-boundary decision: the normal startup path should help migrate the current local database instead of requiring an immediate rebuild.

This is a deliberately narrow compatibility bridge, not a general legacy upgrade system. It recognizes exactly one old state:

- `platform_migrations` contains the maintained migration set plus `011_rule_sources.sql`, with no missing, duplicate, or foreign versions;
- `platform_rule_sources` exists as the removed rule-source table with the expected legacy columns.

For that state, startup must:

1. hold the existing `InstanceLock`;
2. create a non-overwriting, SQLite-consistent backup with `better-sqlite3` `backup()` before mutation;
3. copy the local credential key into the backup when it is an existing regular file, so database/key recovery remains paired;
4. in one SQLite transaction, drop only `platform_rule_sources` and delete only the exact `011_rule_sources.sql` tracking row;
5. verify the table is gone, the tracking row is gone, `integrity_check` is `ok`, and `foreign_key_check` is empty before committing;
6. continue through the existing startup security gate.

A backup or transaction failure prevents startup. The live database is never deleted or replaced. The backup target is unique and non-overwriting.

## Fail-closed cases

Startup must not mutate when:

- the applied migration set is incomplete, has a foreign version, or has a version `011` row with another name;
- `011_rule_sources.sql` is recorded but the table is missing, is not a table, or lacks the expected columns;
- `platform_rule_sources` exists without the exact legacy tracking row;
- the database is otherwise outside the current ready schema.

Those cases retain the existing coarse startup failure and actionable rebuild/manual-recovery path.

## Why not a generic DROP

The feature was removed from the maintained schema, but an unconditional `DROP TABLE` would silently mutate arbitrary operator databases. The exact migration-set and table-shape admission check makes this a bounded, auditable compatibility migration. The pre-migration backup provides an explicit rollback artifact without introducing a broad legacy conversion layer.

## Current worktree verification

The configured development database is `server/.dev/dnd.sqlite`. It currently has the exact current approved migration rows plus `011_rule_sources.sql`, `platform_rule_sources`, a ready `platform_instance`, and an existing local credential key. The repository-root `server/dnd.sqlite` is a different older database and is not touched unless explicitly configured.
