# Simplify realtime session lifecycle

## Goal

Keep reliable private Campaign SSE for a small single-process deployment while removing per-event authority checks, provisional race machinery, and dormant maintenance lifecycle complexity.

## Requirements

### R1. Preserve realtime behavior

- Authenticate and authorize every SSE connection before event delivery.
- Preserve Outbox sequence replay through `after`/`Last-Event-ID`.
- Preserve Owner/Player event projection and poison-row isolation.
- Preserve heartbeat, backpressure closure, client deduplication, reconnect, and safe shutdown.

### R2. Simplify authority checks

- Perform authoritative validation at connection establishment.
- Keep immediate in-process closure for normal logout, logout-all, and user disable operations initiated by the current server.
- Use at most one authority recheck per connection every 60 seconds as a fallback for expiry, notifier failure, or external database changes.
- Do not query session authority before each individual event frame.

### R3. Remove dormant lifecycle machinery

- Remove `draining`/`quiescent` runtime behavior and maintenance-only realtime hooks unless code inspection finds a currently reachable operator workflow that requires them.
- Keep shutdown behavior local to the server lifecycle instead of a generalized platform state machine.

### R4. Preserve security properties proportionate to the product

- A revoked or expired session must eventually lose the stream and be unable to reconnect.
- A reconnect must always perform fresh authentication and Campaign membership checks.
- No event may be projected to a viewer role that is not authorized for it.

## Acceptance Criteria

- [ ] SSE establishment rejects invalid, expired, revoked, disabled-user, or non-member sessions.
- [ ] Logout and logout-all close matching live connections in the current process.
- [ ] Session expiry, notifier failure, or external revocation is detected within 60 seconds; established same-process logout/logout-all paths normally close immediately.
- [ ] Event delivery performs no per-frame session database query.
- [ ] Disconnect/reconnect replay and client sequence deduplication remain green.
- [ ] Owner-only and player-private events remain correctly projected.
- [ ] Normal server shutdown closes all subscriptions before database close.
- [ ] Dormant maintenance realtime hooks/state are removed or explicitly justified by reachable behavior.
- [ ] The deliberate maximum 60-second in-flight/notifier-failure fallback window is recorded as an accepted local-first trade-off rather than an accidental security regression.

## Out of Scope

- Cross-process revocation broadcasts.
- Multi-instance SSE fanout.
- Millisecond-level revocation guarantees for in-flight races, notifier failure, or changes made outside the current process.
- Replacing transactional Outbox or SSE.
