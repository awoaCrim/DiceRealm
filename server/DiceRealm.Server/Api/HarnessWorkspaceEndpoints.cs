using DiceRealm.Server.Application;

namespace DiceRealm.Server.Api;

public static class HarnessWorkspaceEndpoints
{
    private static async Task<T> Read<T>(string id, HttpContext ctx, GameService game, Func<HttpContext, string> token, int maximum)
    {
        await game.AuthorizeHarnessWorkspace(id, token(ctx), ctx.RequestAborted);
        // Service reauthorizes inside its final gate after the body has arrived.
        return await ContentEndpoints.Read<T>(ctx, maximum);
    }
    public static void MapHarnessWorkspace(this RouteGroupBuilder api, Func<HttpContext, string> token)
    {
        var group = api.MapGroup("/campaigns/{id}/harness");
        group.MapGet("/workspace", (string id, HttpContext ctx, GameService game) => game.GetHarnessWorkspace(id, token(ctx), ctx.RequestAborted));
        group.MapPost("/workspace/preview", async (string id, HttpContext ctx, GameService game) =>
            await game.PreviewHarnessProfile(id, token(ctx), await Read<HarnessProfileRequest>(id, ctx, game, token, 1024 * 1024), ctx.RequestAborted));
        group.MapPost("/workspace/draft", async (string id, HttpContext ctx, GameService game) =>
            await game.SaveHarnessDraft(id, token(ctx), await Read<SaveHarnessDraftRequest>(id, ctx, game, token, 1024 * 1024), ctx.RequestAborted));
        group.MapPost("/workspace/publish", async (string id, HttpContext ctx, GameService game) =>
            await game.PublishHarness(id, token(ctx), await Read<PublishHarnessRequest>(id, ctx, game, token, 8192), ctx.RequestAborted));
        group.MapPost("/workspace/activate", async (string id, HttpContext ctx, GameService game) =>
            await game.ActivateHarness(id, token(ctx), await Read<ActivateHarnessRequest>(id, ctx, game, token, 8192), ctx.RequestAborted));
        group.MapGet("/workspace/revisions", (string id, int? before, int? limit, HttpContext ctx, GameService game) =>
            game.HarnessRevisions(id, token(ctx), before, limit ?? 20, ctx.RequestAborted));
        group.MapGet("/workspace/revisions/{revision:int}", (string id, int revision, HttpContext ctx, GameService game) =>
            game.HarnessRevision(id, token(ctx), revision, ctx.RequestAborted));
        group.MapGet("/workspace/export", async (string id, int? revision, bool? includeDraft, HttpContext ctx, GameService game) =>
            Results.File(await game.ExportHarnessWorkspace(id, token(ctx), revision, includeDraft ?? false, ctx.RequestAborted), "application/zip"));
        group.MapGet("/memory", (string id, HttpContext ctx, GameService game) => game.GetHarnessMemory(id, token(ctx), ctx.RequestAborted));
    }
}
