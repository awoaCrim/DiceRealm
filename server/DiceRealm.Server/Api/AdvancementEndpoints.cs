using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Api;

public static class AdvancementEndpoints
{
    public static void MapAdvancement(this RouteGroupBuilder api, Func<HttpContext, string> token)
    {
        api.MapGet("/campaigns/{id}/character/advancement", (string id, HttpContext context, GameService game) =>
            game.Advancement(id, token(context), context.RequestAborted));
        api.MapPost("/campaigns/{id}/character/advancement/preview", async (string id, HttpContext context, GameService game) =>
        {
            string credential = token(context);
            return await game.PreviewAdvancement(id, credential, await ContentEndpoints.Read<PreviewAdvancementRequest>(context, 65536), context.RequestAborted);
        });
        api.MapPost("/campaigns/{id}/character/advancement/apply", async (string id, HttpContext context, GameService game) =>
        {
            string credential = token(context);
            return await game.ApplyAdvancement(id, credential, await ContentEndpoints.Read<ApplyAdvancementRequest>(context, 65536), context.RequestAborted);
        });
        api.MapPost("/campaigns/{id}/characters/advancement/award", async (string id, HttpContext context, GameService game) =>
        {
            string credential = token(context);
            return await game.AwardAdvancement(id, credential, await ContentEndpoints.Read<AwardAdvancementRequest>(context, 8192), context.RequestAborted);
        });
    }
}
