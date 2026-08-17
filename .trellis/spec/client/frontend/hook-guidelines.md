# Client Hook Guidelines

React Query is the server-state layer. Query/mutation hooks live under `client/src/entities/<domain>/` and call pure API functions under `client/src/api/<domain>/`.

## Query pattern

```ts
export function useTurnView(campaignId?: string, turnId?: string) {
  return useQuery({
    queryKey: campaignTurnKey(campaignId ?? '', turnId ?? ''),
    queryFn: () => turnApi.getView(campaignId ?? '', turnId ?? ''),
    enabled: !!campaignId && !!turnId,
    retry: false,
  });
}
```

- Build query keys with the helpers in `shared/lib/queryKeys.ts`.
- Disable queries until required route IDs exist.
- Set `retry: false` for route detail queries where a 4xx is a terminal UI state; the global client retries ordinary transient failures at most twice.
- Invalidate the smallest affected keys after a successful mutation.

## Hook rules

- Do not call `fetch` from a component.
- Do not put domain authorization or response parsing in a hook; `platformRequest` and server projection own those boundaries.
- Keep local expansion/form state in the component unless multiple siblings truly share it.
- Preserve the global `AUTH_REQUIRED` bus behavior; do not redirect independently from every query.
