# Server Frontend Hook Guidelines

The `server` package defines no React hooks. It exposes async HTTP/SSE behavior that client hooks consume.

When changing a hook-facing endpoint:

1. Update the shared request/response contract.
2. Keep the route thin and put authorization/projection in the service.
3. Add a server HTTP test for success and failure/visibility cases.
4. Update the matching client API function and React Query hook.

Do not introduce a server-side cache or hook-like abstraction merely to mirror the client query layer.
