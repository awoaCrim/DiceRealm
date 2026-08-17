# Server Backend Directory Structure

The server is an Express application composed from feature modules and platform primitives. Keep domain behavior below the route layer and keep production construction in one composition root.

## Layout

```text
server/src/
├── app.ts                         # production/test composition root
├── index.ts                       # thin process entry point
├── config.ts                      # environment parsing and validated config
├── routes/                        # HTTP parsing, auth middleware, DTO responses
├── modules/<domain>/               # services, repositories, ports, focused tests
├── platform/database/              # DatabasePort, SQLite adapter, migrations
├── platform/events/                # transactional outbox
├── platform/http/                  # security, sessions, errors, request limits
├── platform/realtime/              # SSE and outbox tailing
├── platform/startup/               # lock, migrations, credentials, listen lifecycle
└── tests/                          # HTTP/vertical fixtures and cross-module tests
```

## Module organization

- A feature module owns domain service/repository code and its unit tests (`modules/campaigns`, `modules/turns`, `modules/ai-runtime`).
- A repository accepts `QueryExecutor`/`QueryReader`; it must not reach into Express or the raw SQLite driver.
- A service owns authorization, domain validation, transactions, and mapping from repository rows to `@dnd/contracts` views.
- A route factory wires a service and translates HTTP input/output. `routes/campaignRoutes.ts` is the reference: parse with a shared schema, call the service, return a contract-shaped DTO.
- `app.ts` wires concrete implementations. `startPlatformServer.ts` is the production startup path; test-only overrides use `createTestPlatformApp`.

## Naming and imports

Use PascalCase for class files (`CampaignService.ts`), lowercase names for route factories and test files (`campaignRoutes.ts`, `campaign.test.ts`), and explicit `.js` suffixes in ESM imports. Keep platform imports below feature modules; do not create a general DI container.

## Example

```ts
export function createCampaignRouter(
  executor: QueryExecutor,
  campaigns: CampaignService,
): Router {
  const router = Router();
  router.post('/', jsonBodyBudget('campaigns'), asyncHandler(async (req, res) => {
    const input = createCampaignInputSchema.parse(req.body);
    res.status(201).json({ campaign: await campaigns.create(getAuthContext(req).userId, input) });
  }));
  return router;
}
```
