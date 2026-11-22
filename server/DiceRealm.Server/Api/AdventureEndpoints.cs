using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Api;

// 中立业务路由：前端产品边界只表达战役、内容准备、行动、回答、本人确认与结果。
// 旧的 /harness/* 兼容端点保持原样，供旧客户端与旧 pending 原样重放。
public static class AdventureEndpoints
{
    public static void MapAdventure(this RouteGroupBuilder api, Func<HttpContext, string> token)
    {
        api.MapPost("/campaigns/from-content", async (HttpContext context, AdventureSessionService adventure) =>
        {
            var request = await ContentEndpoints.Read<CreateCampaignFromContentRequest>(context, 1024 * 1024, requireConstructorParameters: true);
            var result = adventure.CreateFromContent(request);
            return Results.Created("/api/v1/campaigns/" + result.Snapshot.Id, result);
        });
        api.MapPost("/campaigns/{id}/adventure/story/share", async (string id, HttpContext context, GameService game) =>
        {
            var request = await ContentEndpoints.Read<SharePrivateStoryRequest>(context, 16 * 1024, requireConstructorParameters: true);
            return await game.SharePrivateStory(id, token(context), request, context.RequestAborted);
        });
        api.MapGet("/campaigns/{id}/adventure/story/shared", (string id, int? after, int? limit, HttpContext context, GameService game) =>
            game.SharedStories(id, token(context), after ?? 0, limit ?? 50, context.RequestAborted));
        api.MapPost("/campaigns/{id}/adventure/opening", async (string id, HttpContext context, HarnessRunService runs) =>
        {
            var request = await ContentEndpoints.Read<StartOpeningRequest>(context, 2048, requireConstructorParameters: true);
            var run = await runs.Start(id, token(context), new HarnessInputRequest(request.RequestId, request.ExpectedVersion, HarnessOpenings.Input), context.RequestAborted, opening: true);
            var result = AdventureSessions.View(run);
            return Results.Accepted($"/api/v1/campaigns/{id}/adventure/sessions/{result.SessionId}", result);
        });
        api.MapGet("/campaigns/{id}/adventure/progress", (string id, string? actorId, string? actionId, HttpContext context, HarnessRunService runs) =>
            runs.HostProgress(id, token(context), context.RequestAborted, actorId, actionId));
        api.MapGet("/campaigns/{id}/adventure/progress/steps/{number:int}", (string id, string actorId, string actionId, int number, HttpContext context, HarnessRunService runs) =>
            runs.HostStep(id, token(context), actorId, actionId, number, context.RequestAborted));
        api.MapGet("/campaigns/{id}/adventure", (string id, HttpContext context, AdventureSessionService adventure) =>
            adventure.Board(id, token(context), context.RequestAborted));
        api.MapGet("/campaigns/{id}/adventure/sessions/{sessionId}", (string id, string sessionId, HttpContext context, AdventureSessionService adventure) =>
            adventure.Session(id, token(context), sessionId, context.RequestAborted));
        api.MapPost("/campaigns/{id}/adventure/actions", async (string id, HttpContext context, AdventureSessionService adventure) =>
        {
            var request = await ContentEndpoints.Read<AdventureActionRequest>(context, 16384, requireConstructorParameters: true);
            var result = await adventure.Act(id, token(context), request, context.RequestAborted);
            return Results.Accepted($"/api/v1/campaigns/{id}/adventure/sessions/{result.SessionId}", result);
        });
        api.MapPost("/campaigns/{id}/adventure/sessions/{sessionId}/continue", async (string id, string sessionId, HttpContext context, AdventureSessionService adventure) =>
        {
            var request = await ContentEndpoints.Read<AdventureActionRequest>(context, 16384, requireConstructorParameters: true);
            var result = await adventure.Continue(id, token(context), sessionId, request, context.RequestAborted);
            return Results.Accepted($"/api/v1/campaigns/{id}/adventure/sessions/{sessionId}", result);
        });
        api.MapPost("/campaigns/{id}/adventure/sessions/{sessionId}/stop", (string id, string sessionId, HttpContext context, AdventureSessionService adventure) =>
        {
            // 与旧 cancel 相同：不接受正文，不撤回已提交效果。
            if (context.Request.ContentLength is > 0 || context.Request.Headers.ContainsKey("Transfer-Encoding"))
                throw new GameException("invalid_input", "停止不接受额外参数；已提交的游戏效果不会回滚。");
            return adventure.Stop(id, token(context), sessionId, context.RequestAborted);
        });
        api.MapGet("/campaigns/{id}/adventure/settings", (string id, HttpContext context, AdventureSessionService adventure) =>
            adventure.Settings(id, token(context), context.RequestAborted));
        api.MapGet("/campaigns/{id}/adventure/memory", (string id, HttpContext context, AdventureSessionService adventure) =>
            adventure.Memory(id, token(context), context.RequestAborted));
        api.MapPost("/campaigns/{id}/adventure/settings/preview", async (string id, HttpContext context, GameService game, AdventureSessionService adventure) =>
        {
            var request = await AuthorizedRead<AdventureSettingsPreviewRequest>(id, context, game, token, 1024 * 1024);
            return await adventure.PreviewSettings(id, token(context), request, context.RequestAborted);
        });
        api.MapPost("/campaigns/{id}/adventure/settings/draft", async (string id, HttpContext context, GameService game, AdventureSessionService adventure) =>
        {
            var request = await AuthorizedRead<SaveAdventureSettingsDraftRequest>(id, context, game, token, 1024 * 1024);
            return await adventure.SaveDraft(id, token(context), request, context.RequestAborted);
        });
        api.MapPost("/campaigns/{id}/adventure/settings/publish", async (string id, HttpContext context, GameService game, AdventureSessionService adventure) =>
        {
            var request = await AuthorizedRead<PublishAdventureSettingsRequest>(id, context, game, token, 8192);
            return await adventure.Publish(id, token(context), request, context.RequestAborted);
        });
        api.MapPost("/campaigns/{id}/adventure/settings/activate", async (string id, HttpContext context, GameService game, AdventureSessionService adventure) =>
        {
            var request = await AuthorizedRead<ActivateAdventureSettingsRequest>(id, context, game, token, 8192);
            return await adventure.Activate(id, token(context), request.Revision, request, context.RequestAborted);
        });
        api.MapGet("/campaigns/{id}/adventure/settings/history", (string id, int? before, int? limit, HttpContext context, AdventureSessionService adventure) =>
            adventure.SettingsHistory(id, token(context), before, limit ?? 20, context.RequestAborted));
        api.MapGet("/campaigns/{id}/adventure/settings/history/{revision:int}", (string id, int revision, HttpContext context, AdventureSessionService adventure) =>
            adventure.SettingsRevision(id, token(context), revision, context.RequestAborted));
        api.MapGet("/campaigns/{id}/adventure/settings/export", async (string id, int? revision, bool? includeDraft, HttpContext context, AdventureSessionService adventure) =>
            Results.File(await adventure.ExportSettings(id, token(context), revision, includeDraft ?? false, context.RequestAborted), "application/zip"));
    }

    // 身份与主持权限先于请求体解析：无效凭证/非主持不进入 JSON 解析，也不读取正文。
    // 命令内部仍会重新授权（同一战役锁内复核）。与旧工作区端点的既有保证一致。
    private static async Task<T> AuthorizedRead<T>(string id, HttpContext context, GameService game, Func<HttpContext, string> token, int maximum)
    {
        await game.AuthorizeHarnessWorkspace(id, token(context), context.RequestAborted);
        return await ContentEndpoints.Read<T>(context, maximum, requireConstructorParameters: true);
    }
}
