using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Api;

public static class WorldMemoryEndpoints
{
    public static void MapWorldMemory(this RouteGroupBuilder api, Func<HttpContext, string> token)
    {
        api.MapGet("/campaigns/{id}/world/memory", (string id, int expectedVersion, HttpContext context, GameService game,
            string query = "", string kind = "", int offset = 0, int limit = 32, string scope = "public") =>
            game.ReadWorldMemory(id, token(context), expectedVersion, query, kind, offset, limit, scope, context.RequestAborted));
        api.MapPost("/campaigns/{id}/world/correct", (string id, CorrectWorldMemoryRequest request, HttpContext context, GameService game) =>
            game.CorrectWorldMemory(id, token(context), request, context.RequestAborted));
        api.MapPost("/campaigns/{id}/adventure/correct", (string id, CorrectAdventureRequest request, HttpContext context, GameService game) =>
            game.CorrectAdventure(id, token(context), request, context.RequestAborted));
    }
}
