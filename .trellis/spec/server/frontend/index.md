# Server Frontend Boundary Guidelines

The `server` package has no React frontend. These documents define the server-side rules for the HTTP and SSE boundaries consumed by the client.

## Guideline index

| Guide | Purpose |
|---|---|
| [Directory Structure](./directory-structure.md) | Where browser-facing server code lives |
| [Component Guidelines](./component-guidelines.md) | Keep presentation out of the server |
| [Hook Guidelines](./hook-guidelines.md) | Coordinate endpoint changes with client hooks |
| [Quality Guidelines](./quality-guidelines.md) | HTTP/SSE contract and security checks |
| [State Management](./state-management.md) | Durable state and event ownership |
| [Type Safety](./type-safety.md) | DTO, event, and error typing |

## Before development

1. Identify the shared contract and client API/hook consuming the endpoint.
2. Keep authorization, visibility, and data projection on the server.
3. Add an HTTP/SSE test for the changed boundary.
4. Keep browser-only test proxy/TLS behavior isolated from production configuration.

## Quality check

- Route status and error envelope tests pass.
- Owner/player/private projections are asserted at the server boundary.
- SSE live and replay paths use the same projection rules.
- No React, CSS, browser state, or UI-specific presentation logic is added to `server/src`.
