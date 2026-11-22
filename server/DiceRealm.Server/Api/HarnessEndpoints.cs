using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Api;

public static class HarnessEndpoints
{
    public static void MapHarness(this RouteGroupBuilder api, Func<HttpContext, string> token)
    {
        api.MapPost("/harness/campaigns", async (HttpContext context, GameService game) =>
        {
            var request = await ContentEndpoints.Read<CreateHarnessCampaignRequest>(context, 1024 * 1024, requireConstructorParameters: true);
            var result = game.CreateHarness(request);
            return Results.Created("/api/v1/campaigns/" + result.Snapshot.Id, result);
        });
        api.MapPost("/campaigns/{id}/harness/runs", async (string id, HttpContext context, HarnessRunService harness) =>
        {
            string credential = token(context);
            var request = await ContentEndpoints.Read<HarnessInputRequest>(context, 16384, requireConstructorParameters: true);
            var result = await harness.Start(id, credential, request, context.RequestAborted);
            return Results.Accepted($"/api/v1/campaigns/{id}/harness/runs/{result.Id}", result);
        });
        api.MapGet("/campaigns/{id}/harness/runs/active", (string id, HttpContext context, HarnessRunService harness) =>
            harness.ListActive(id, token(context), context.RequestAborted));
        api.MapGet("/campaigns/{id}/harness/runs/{runId}", (string id, string runId, HttpContext context, HarnessRunService harness) =>
            harness.Get(id, token(context), runId, context.RequestAborted));
        api.MapPost("/campaigns/{id}/harness/runs/{runId}/resume", async (string id, string runId, HttpContext context, HarnessRunService harness) =>
        {
            string credential = token(context);
            var request = await ContentEndpoints.Read<HarnessResumeRequest>(context, 16384, requireConstructorParameters: true);
            var result = await harness.Resume(id, credential, runId, request, context.RequestAborted);
            return Results.Accepted($"/api/v1/campaigns/{id}/harness/runs/{runId}", result);
        });
        api.MapPost("/campaigns/{id}/harness/runs/{runId}/cancel", (string id, string runId, HttpContext context, HarnessRunService harness) =>
        {
            string credential = token(context);
            if (context.Request.ContentLength is > 0 || context.Request.Headers.ContainsKey("Transfer-Encoding"))
                throw new GameException("invalid_input", "取消不接受额外参数；已提交的游戏效果不会回滚。");
            return harness.Cancel(id, credential, runId, context.RequestAborted);
        });
    }
}
