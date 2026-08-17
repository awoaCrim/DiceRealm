# Server Error Handling

Server errors converge on the shared `AppErrorCode` contract and the `errorMiddleware` response envelope.

## Application errors

Use `AppError` for expected domain, authorization, validation, provider, and conflict failures:

```ts
if (member.role !== 'owner') {
  throw new AppError('FORBIDDEN', '你没有权限执行此操作。');
}
```

`AppError` supplies the default HTTP status from `DEFAULT_HTTP_STATUS`; override the status only when the route has a deliberate exception. Add new codes to `@dnd/contracts/src/errors.ts` first, then update the status map and tests.

## Route boundary

- Parse request bodies with the shared Zod schema before calling a service.
- Wrap async route handlers with `asyncHandler` so rejections reach `errorMiddleware`.
- Register `errorMiddleware` after all routes and before the JSON 404 fallback.
- Do not return raw exceptions, SQL text, stack traces, HTML, or provider responses.

The middleware maps `AppError` directly, `ZodError` and malformed client bodies to `VALIDATION_ERROR`, oversized bodies to `PAYLOAD_TOO_LARGE`, and unknown failures to a generic `INTERNAL_ERROR` response.

## Authorization and existence

Use the same safe code/message where revealing resource existence would leak information. `CampaignService.getForMember` returns `CAMPAIGN_NOT_FOUND` for a non-member instead of exposing a forbidden campaign.

## Tests

For new errors, assert both code and status in route tests, and assert the generic response for unexpected failures. Keep user-facing messages stable enough for recovery UI, but let the code be the programmatic discriminator.
