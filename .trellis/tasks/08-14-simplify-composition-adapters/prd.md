# Remove speculative adapters and narrow composition

## Goal

Make the production architecture honestly SQLite-only and reduce the amount of test and future-platform knowledge exposed through the main app composition interface.

## Requirements

### R1. Remove speculative PostgreSQL support

- Remove the unused PostgreSQL adapter and PostgreSQL-only tests/configuration unless inspection finds a currently executed production path.
- Remove documentation or package dependencies that imply PostgreSQL is a supported deployment target.
- Do not replace it with another future-facing abstraction.

### R2. Keep useful seams deep

- Keep `DatabasePort` or a smaller equivalent where it centralizes query, transaction, and test behavior used by real callers.
- Keep AI-provider seams because multiple real providers/fallbacks/test adapters exist.
- Keep the Outbox publication seam where it enforces same-transaction event publication.
- Remove pass-through seams that have only one implementation and provide no test or locality leverage.

### R3. Narrow production composition

- Reduce `CreatePlatformAppOptions` to production-relevant dependencies and configuration.
- Move clocks, short polling intervals, transport replacements, authority checkers, and provider factories behind a separate test constructor or lower-level module test seams; do not expose a test-override bag on the production function.
- Prevent invalid combinations of test-only options from looking like supported production configuration.
- Replace historical `Phase N`/`Task N` production comments with short invariant-focused comments where explanation is still needed.

### R4. Preserve behavior

- Route paths, contracts, authorization, domain transactions, realtime behavior, and AI-provider selection must remain unchanged unless owned by another child task.
- Avoid broad renaming or unrelated directory restructuring.

## Acceptance Criteria

- [x] No production or test code imports `PostgresDatabaseAdapter`.
- [x] Dependencies and current documentation no longer imply supported PostgreSQL deployment.
- [x] Production app creation has a small, understandable interface.
- [x] Test setup can still inject deterministic clocks, AI providers/transports, and realtime timing without changing production call sites.
- [x] Database, Outbox, and AI seams retained by the design each have concrete leverage documented in `design.md`.
- [x] Production code in the touched composition/adapters no longer depends on historical Phase/Task narration to explain current behavior.
- [x] Focused server tests, full tests, typecheck, and build pass.

## Out of Scope

- Reorganizing every server module.
- Rewriting repositories or SQL query style.
- Changing frontend architecture.
- Adding a general-purpose dependency injection container.
