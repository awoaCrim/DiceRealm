# Design: simplify realtime session lifecycle

## 1. Current problem

The current SSE path protects a narrow logout race by binding a detailed session-authority tuple, provisionally registering the response before final header flush, querying session authority before each poll batch, and querying it again before each visible frame. The runtime also exposes viewer and maintenance closures that are not backed by a current product workflow.

For a single-process small-group deployment, this costs database reads, test seams, and maintenance complexity disproportionate to the privacy benefit.

## 2. Target authority model

### Connection-time admission

The existing middleware chain remains the authoritative admission point:

```text
RequestSecurityPolicy
  -> cookie SessionMiddleware
  -> requireCampaignMember
  -> build viewer/session client identity
  -> establish SSE response
```

No second provisional final-header race protocol is required. A session revoked during the small middleware-to-registration window may remain until the periodic check; reconnect is always rejected by current middleware.

### Established-client registry

Keep a process-local registry with the minimum identity needed for post-commit revocation:

```ts
{
  internalSessionId: string;
  userId: string;
  campaignId: string;
  close(): void;
}
```

The runtime interface is reduced to:

- `registerClient(...) -> unregister`
- `revokeSession(internalSessionId)`
- `revokeUser(userId)`
- `closeAll()`

Remove production `closeViewer` and `closeAllForMaintenance`; current-worktree inspection found no production caller. The Phase 4 fixture still needs to simulate a network disconnect without revoking the session, so the separate test constructor may return a test-only connection control that can close a matching viewer stream without adding that method back to the production runtime interface.

### Periodic fallback

`SessionAuthority` remains a small side-effect-free checker, but it is invoked at most once every 60 seconds per subscription. The interval is configurable only through the separate test constructor or lower-level EventStream test seam.

The checker may continue to verify current user/session status and expiry; it does not run before each frame. A subscription records its next authority-check deadline separately from the 250ms Outbox poll schedule.

If the periodic check fails or throws, the stream closes fail-safe. The browser reconnect then receives normal HTTP authentication failure.

## 3. Event delivery

`EventStreamService` continues to own:

- single-flight Outbox polling;
- batch/cursor progress including invisible or malformed rows;
- viewer projection;
- backpressure closure;
- deterministic test flush;
- close-all-before-database-shutdown.

Authority checking is a subscription-lifecycle concern, not a per-event condition. `onFrame` performs no database auth read. The delivery loop still checks the in-memory `state.closed` flag before each frame so an in-process revocation arriving while an Outbox batch is being read prevents queued frames from being written.

## 4. Revocation data flow

```text
logout/logout-all/disable transaction commits
  -> IdentityService invokes best-effort notifier
  -> EventStreamRuntime closes matching established clients
  -> browser reconnects
  -> current session middleware rejects revoked credentials
```

Notifier failure does not roll back an already durable logout. The 60-second periodic checker bounds the fallback window; established streams normally close immediately through the notifier.

Session expiry discovered through normal HTTP resolution may continue to emit a session revocation notification. Pure time passage without another request is handled by the periodic checker.

## 5. Maintenance simplification

The product uses process shutdown rather than a platform maintenance state machine. Remove runtime maintenance closure and identity repository checks for `quiescent` when the final clean schema no longer contains that state.

Normal shutdown remains:

```text
stop accepting requests -> realtimeRuntime.closeAll() -> close DB -> release lock
```

## 6. Tests

Delete tests whose only contract is:

- no frame in the exact logout/final-header race;
- a database authority query immediately before each frame;
- close-before-destroy linearization across deliberately throwing callbacks;
- maintenance-specific realtime closure without a reachable operation.

Replace them with tests proving:

- invalid/revoked/expired/non-member sessions cannot establish or reconnect;
- established streams close after normal logout and logout-all;
- notifier failure leaves durable logout intact and periodic fallback closes the stream;
- authority checker call count is bounded to at most once per configured interval, not event count;
- replay, privacy projection, poison-row progress, heartbeat, backpressure, and shutdown remain correct.

## 7. Risks

- There is a documented maximum 60-second window for an in-flight, notifier-failure, or externally revoked stream.
- The interval must not be tied to Outbox poll frequency.
- Tests must use deterministic short intervals without exposing those intervals as normal production options.
- Simplifying authority must not simplify event projection; projection remains per event.
