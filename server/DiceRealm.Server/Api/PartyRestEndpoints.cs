using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Api;

public static class PartyRestEndpoints
{
    public static void MapPartyRest(this RouteGroupBuilder api, Func<HttpContext, string> token)
    {
        api.MapGet("/campaigns/{id}/party/rest", (string id, HttpContext context, GameService game) =>
            game.ReadPartyRest(id, token(context), context.RequestAborted));
        api.MapPost("/campaigns/{id}/party/rest", async (string id, HttpContext context, GameService game) =>
        {
            string credential = token(context);
            return await game.RestParty(id, credential, await ContentEndpoints.Read<PartyRestRequest>(context, 8192), context.RequestAborted);
        });
    }
}
