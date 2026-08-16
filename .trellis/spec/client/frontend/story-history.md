# Story History UI Contract

## 1. Scope / Trigger

Use this contract when changing the Player story page, Owner turn page, turn-entry rendering, or the React Query reads that feed those views. Story history is a cross-layer read path: the server supplies the active turn list and an audience-projected entry list for each turn; the client must not recreate visibility rules.

## 2. Signatures

```ts
useTurnList(campaignId?: string): UseQueryResult<TurnListEntry[]>;
useTurnEntries(campaignId?: string, turnId?: string): UseQueryResult<TurnEntry[]>;

TurnStoryHistory(props: {
  campaignId: string;
  turns: TurnListEntry[];
  audience: 'owner' | 'player';
}): JSX.Element;
```

`useTurnEntries` is enabled only when both identifiers are present. Its query key includes both `campaignId` and `turnId`, so expanding one historical turn cannot overwrite another turn's cached entries.

## 3. Contracts

- `useTurnList` consumes the complete active campaign list. The server orders it by turn number and excludes superseded branches.
- The active turn is the item with the highest domain `turn.number`; do not assume the response array is ordered. The current card is expanded by default; historical cards are collapsed until the user opens them.
- `TurnStoryHistory` renders the same `TurnEntries` component for Player and Owner. `audience` changes copy/labels only; it does not alter the entry payload or visibility policy.
- `TurnEntries` renders only the known `narrative`, `private_update`, and `dice_result` shapes. Payload values are `unknown` at the rendering boundary and must pass through safe readers.
- A Player receives public entries and that Player's private entries from the server. An Owner receives the Owner projection. The client must never filter raw owner data to simulate the Player view.

## 4. Validation & Error Matrix

| Condition | Required UI behavior |
|---|---|
| No turns | Show `尚未有剧情回合。` and keep the page usable. |
| Expanded turn has no entries | Show `本回合尚未产生剧情。`. |
| Entries request fails | Show an error inside that turn card and offer retry; other cards remain usable. |
| Known entry has malformed payload | Show a safe unavailable message for that entry only. |
| Unknown entry kind | Show a safe unavailable message; never render raw JSON. |
| Player lacks access to another player's private entry | Rely on the server projection; do not infer or bypass it in the client. |

## 5. Good / Base / Bad Cases

- **Good**: a new waiting turn appears while the completed turn remains in the active list; the new card is visible and the previous card can still be expanded.
- **Good**: restoring an archive invalidates and refreshes the campaign turn query before the UI chooses the current turn; turns superseded by the restore disappear from the active timeline.
- **Base**: only one completed turn exists; its entries load in the current card and remain cached by turn ID.
- **Bad**: select a single `storyTurn` fallback and drop older list items, trust array position after a restore/refetch, or share one mutable entries query between all cards. These make history disappear or show the wrong turn's content.

## 6. Tests Required

- Player workspace test with a completed turn and a newer waiting turn; assert the previous narrative remains expandable.
- Player entry test with narrative, own private, dice, and malformed payload fixtures; assert safe rendering and no raw JSON.
- Owner workspace test with current private/narrative/dice content, an expandable historical turn, and an out-of-order turn list.
- Archive mutation test asserts `campaignTurnsKey` is invalidated after restore.
- Existing server HTTP/projection tests must continue to assert public/own-private/owner-only boundaries and explicit `turnId` lookup.

## 7. Wrong vs Correct

### Wrong

```tsx
const storyTurn = turns.find((item) => item.turn.status !== 'completed') ?? turns.at(-1);
return <TurnEntries entries={storyTurnEntries} />;
```

This drops completed turns as soon as a new turn exists.

### Correct

```tsx
return (
  <TurnStoryHistory
    campaignId={campaignId}
    turns={turns}
    audience="player"
  />
);
```

Each card owns its expanded state and requests entries with its own `turnId`.
