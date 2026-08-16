# Turn Entry Projection Contract

## 1. Scope / Trigger

Use this contract when changing the AI turn-entry route, `TurnEntryRepository`, `projectEntries`, or any client that displays story history. The route is the source of truth for audience visibility and returns a safe DTO rather than database JSON columns.

## 2. Signatures

```text
GET /api/campaigns/:campaignId/ai/turns/:turnId/entries
  -> { entries: TurnEntry[] }

projectEntries(
  subject: { role: 'owner' | 'player'; playerId: string | null },
  rows: TurnEntryRow[],
): TurnEntryRow[]
```

The route first verifies that `turnId` belongs to `campaignId`, then loads entries for that turn and applies `projectEntries` before mapping rows to the public contract.

## 3. Contracts

- Owners can read all entries belonging to an authorized campaign turn.
- Players can read public entries and `player_private` entries targeted at their own user ID. `owner_only` entries and another player's private entries are never returned.
- The response contains contract fields such as `entryKind`, `visibility`, `targetPlayerId`, and parsed `payload`; internal `*_json` database columns and raw AI diagnostics are not exposed.
- Active turn history is read through the normal turn list. Superseded branches remain excluded by the server's active-list query.
- Rule-material provenance, routes, contracts, and `platform_rule_sources` are not part of this contract or the maintained schema.

## 4. Validation & Error Matrix

| Condition | Required result |
|---|---|
| Unauthenticated request | Existing authentication error. |
| Campaign/turn mismatch | `404`/not-found behavior; do not reveal the other campaign's turn. |
| Authorized Owner | Full projected entries for that turn. |
| Authorized Player | Public plus own targeted private entries only. |
| Malformed persisted payload | Preserve the safe contract boundary; the UI renders a per-entry fallback rather than raw JSON. |

## 5. Good / Base / Bad Cases

- **Good**: two active turns are requested by their own IDs; each response contains only that turn's entries and the correct audience projection.
- **Base**: an empty turn returns `{ entries: [] }` and the client shows an empty-state message.
- **Bad**: query all entries for a campaign and filter in React, or return `payload_json`, `raw_debug_json`, or another player's private row to the browser.

## 6. Tests Required

- Repository projection unit tests for Owner, Player A, and Player B, including `owner_only`.
- HTTP AI-route test for explicit turn-entry lookup, player projection, DTO non-leakage, and cross-campaign not-found behavior.
- Client Player/Owner tests that use projected DTO fixtures and assert historical turn rendering without duplicating server visibility logic.

## 7. Wrong vs Correct

### Wrong

```ts
const rows = await repository.listByCampaign(campaignId);
res.json({ entries: rows });
```

This mixes turns and bypasses the audience boundary.

### Correct

```ts
await requireTurnInCampaign(executor, campaignId, turnId);
const rows = await new TurnEntryRepository(executor).listByTurn(turnId);
const projected = projectEntries({ role: ctx.role, playerId: ctx.playerId }, rows);
res.json({ entries: projected.map(toEntry) });
```
