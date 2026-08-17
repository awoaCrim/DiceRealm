# Contracts Error Handling

The shared error contract is the boundary between server failures and client recovery behavior. It defines codes and the JSON envelope; it does not throw server-side `AppError` instances.

## Canonical error shape

`packages/contracts/src/errors.ts` owns the complete `appErrorCodes` list and `appErrorSchema`:

```ts
export const appErrorSchema = z.object({
  error: z.object({
    code: z.enum(appErrorCodes),
    message: z.string(),
  }),
});
```

When adding a code:

1. Add it to `appErrorCodes`.
2. Add the server HTTP status mapping in `server/src/platform/http/AppError.ts`.
3. Add or update client recovery behavior/tests if the code changes retry or authentication behavior.
4. Add contract tests for the response shape.

## Contract vs implementation errors

- Shared code exports `AppErrorCode` and `AppError`; it does not import Express or log failures.
- Server code converts internal failures to the envelope through `AppError` and `errorMiddleware`.
- Client code parses the envelope into `PlatformHttpError` and must not rely on arbitrary error response fields.

## Good and bad examples

```ts
// Good: a stable, typed code shared by server and client.
throw new AppError('STATE_CONFLICT', 'The campaign state changed.');

// Bad: inventing a route-local string that the client cannot classify.
res.status(409).json({ error: { code: 'TURN_ALREADY_DONE', message: '...' } });
```

Messages are user-facing text, while codes are the stable programmatic discriminator. Never include stack traces, SQL, API keys, or raw provider output in the shared error envelope.
