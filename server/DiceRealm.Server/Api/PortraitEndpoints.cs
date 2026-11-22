using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Api;

public static class PortraitEndpoints
{
    public static void MapPortraits(this RouteGroupBuilder api, Func<HttpContext, string> token)
    {
        api.MapGet("/campaigns/{id}/characters/{actorId}/portrait", (string id, string actorId, HttpContext context, GameService game) =>
            game.CharacterPortrait(id, token(context), actorId, context.RequestAborted));
        api.MapPost("/campaigns/{id}/characters/{actorId}/portrait", async (string id, string actorId, HttpContext context, GameService game) =>
        {
            var credential = token(context);
            var request = await ContentEndpoints.Read<RequestCharacterPortrait>(context, 16384, requireConstructorParameters: true);
            return await game.RequestPortrait(id, credential, actorId, request, context.RequestAborted);
        });
        api.MapGet("/campaigns/{id}/characters/{actorId}/portrait/image", async (string id, string actorId,
            string portraitId, string contentHash, HttpContext context, GameService game) =>
        {
            var image = await game.PortraitImage(id, token(context), actorId, portraitId, contentHash, context.RequestAborted);
            // Authorize EVERY fetch, even an ETag hit. Never put private character images under
            // the historical anonymous /assets route or a credential-bearing URL.
            context.Response.Headers.CacheControl = "private,no-store";
            context.Response.Headers.ETag = "\"" + image.ContentHash + "\"";
            return Results.File(image.Path, "image/png", enableRangeProcessing: false);
        });
    }
}
