# Contracts Frontend State Management Guidelines

The contracts package owns no state. It describes values that may be stored in server state, local component state, URL state, or an event stream.

- React Query cache policy belongs in `client/src/entities` and `client/src/app/providers/createQueryClient.ts`.
- Local form state belongs in the feature component.
- URL parameters and navigation state belong to React Router code.
- Event payload visibility belongs to `events.ts` and server projection helpers, not to a client store.

When a stateful UI needs a new field, first decide whether it is a domain contract field or a client-only view model. Only the former belongs here.
