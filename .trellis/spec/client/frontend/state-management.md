# Client State Management

Use the smallest state mechanism that matches the lifetime of the data.

## State categories

- **Server state:** TanStack Query under `client/src/entities`. Cache keys include resource IDs; mutations invalidate affected queries.
- **Local UI/form state:** `useState` in the owning feature/page (`LoginPage`, `OwnerArchivesPage`, `TurnStoryHistory`).
- **URL state:** React Router params/search params for campaign IDs, return paths, and route selection.
- **Realtime state:** `RealtimeSession`/`RealtimeBoundary` owns the connection lifecycle and invalidates or refreshes queries; it is not a second domain store.

There is no global Redux-style store and no global auth context. `AppProviders` provides the Query client and router, while `authRequiredBus` coordinates protected-query logout behavior.

## Mutation rule

After a successful mutation, invalidate the canonical query keys rather than manually patching several copies of server data. For restore operations, invalidate turns, campaign data, and archives together because the server may supersede history.

## Common mistakes

- Treating array position as the current turn; use domain sequence (`currentTurnEntry`).
- Dropping completed story turns when a waiting turn appears.
- Keeping stale private data in a cache after authentication changes; clear the Query cache on `AUTH_REQUIRED`.
