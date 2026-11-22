using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Server.Api;

// Admin sees every LLM request; a campaign host sees the requests of that campaign only.
internal static class ModelRequestEndpoints
{
    internal static void MapModelRequests(this RouteGroupBuilder api, Func<HttpContext, string> token)
    {
        api.MapGet("/accounts/model-requests", (long? before, int? limit, bool? failed, HttpContext context, AccountStore accounts, ModelRequestLog log) =>
        {
            _ = accounts.RequireAdmin(AccountEndpoints.Token(context));
            return log.List(null, before, limit ?? 50, failed == true);
        });
        api.MapGet("/accounts/model-requests/{requestId:long}", (long requestId, HttpContext context, AccountStore accounts, ModelRequestLog log) =>
        {
            _ = accounts.RequireAdmin(AccountEndpoints.Token(context));
            return log.Get(requestId, null) ?? throw NotFound();
        });
        api.MapGet("/campaigns/{id}/model-requests", async (string id, long? before, int? limit, bool? failed, string? runId, bool? unresolved, HttpContext context, CampaignStore store, ModelRequestLog log) =>
            log.List(await Host(store, id, token(context), context.RequestAborted), before, limit ?? 50, failed == true, runId, unresolved == true));
        api.MapGet("/campaigns/{id}/model-requests/{requestId:long}", async (string id, long requestId, bool? publicOnly, HttpContext context, CampaignStore store, ModelRequestLog log) =>
        {
            var detail = log.Get(requestId, await Host(store, id, token(context), context.RequestAborted)) ?? throw NotFound();
            return publicOnly == true ? ModelRequestPresentation.Public(detail) : detail;
        });
    }
    private static Task<string> Host(CampaignStore store, string id, string token, CancellationToken ct) =>
        store.Access(id, token, false, c => { PartyEngine.RequireHost(c); return Task.FromResult(c.Id); }, ct);
    private static GameException NotFound() => new("not_found", "未找到这条请求记录，可能已被较新的记录替换。", 404);
}
