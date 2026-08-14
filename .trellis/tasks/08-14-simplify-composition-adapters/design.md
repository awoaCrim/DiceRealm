# Design: remove speculative adapters and narrow composition

## 1. Database seam

`DatabasePort` remains because it provides concrete leverage:

- domain modules share one query/execute/transaction contract;
- SQLite transaction serialization stays localized in one adapter;
- in-memory SQLite and deterministic wrappers exercise the same domain interface;
- `readCommitted` gives Outbox/session readers an explicit transaction semantic.

`PostgresDatabaseAdapter` is removed because there is no production startup path or current PostgreSQL deployment requirement. Keeping a second unused adapter forces parity work without product value.

Remove PostgreSQL-only dependencies, tests, configuration, and documentation claims. Do not replace them with another future adapter.

## 2. Other seams

Retain:

- `AiProviderPort`: multiple real provider/fallback/configured/test adapters exist.
- `EventPublisherPort`: domain services publish through the current business transaction; the seam centralizes this invariant.
- `CredentialCipher`: cryptographic implementation and key material stay out of callers.

Review and remove pass-through interfaces only when deleting them makes complexity disappear rather than spread into callers.

## 3. Production composition interface

The production-facing function accepts only dependencies a real startup supplies:

```ts
createPlatformApp({
  database,
  securityConfig,
  credentialCipher,
  aiProvider,
})
```

Phase A deliberately retains the current `credentialCipher` production seam. Any change to a lazy `credentialStore` belongs to the startup/credential child in Phase C after its lifecycle is implemented. Deterministic clocks, transports, authority checkers, and short intervals never appear on the production interface.

## 4. Separate test composition seam

Use a distinct test-only construction function/module rather than a `testOverrides` property on the production interface:

```ts
createTestPlatformApp(productionDependencies, {
  identity,
  providerFetch,
  configuredAiProviderFactory,
  realtime: {
    pollIntervalMs,
    heartbeatIntervalMs,
    authorityCheckIntervalMs,
    authorityChecker,
  },
})
```

Both functions may delegate to one private/internal builder so composition logic is not duplicated. `startPlatformServer` imports only `createPlatformApp`; the HTTP/fixture test harness imports the test constructor. Lower-level unit tests continue constructing Identity, Provider, and EventStream modules directly.

No general-purpose DI container or production-visible test bag is introduced.

## 5. Composition-root locality

`app.ts` remains the application composition root. Extract a helper only when it creates a deep module, such as a realtime runtime with a small interface. Do not create one wrapper file per domain constructor.

Touched comments explain current invariants—transaction ownership, provider fallback, SSE shutdown—not historical Phase/Task implementation chronology.

## 6. Compatibility

This child changes no routes, contracts, database schema, gameplay behavior, or client behavior. It runs first so later realtime/startup children consume the narrowed interfaces.

## 7. Risks

- Some PostgreSQL tests may be the only place that currently exercises generic transaction semantics; preserve equivalent SQLite tests before deleting them.
- Provider transport/factory overrides are required by current fixture tests and must move, not disappear.
- The test constructor must not be imported by production startup, and production must never silently activate mock/scripted providers.
