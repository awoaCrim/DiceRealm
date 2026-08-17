# Server Frontend State Boundary

The server owns durable domain state and event ordering; it does not own browser UI state.

- Database transactions and campaign revisions define authoritative state transitions.
- The outbox and SSE projection define ordered realtime notifications.
- Client React Query caches and local expansion/form state are responsible for presentation state.

Do not add server-side UI stores or duplicate client query invalidation logic. If a mutation changes data, return the canonical DTO/event and let the client invalidate the affected query keys.
