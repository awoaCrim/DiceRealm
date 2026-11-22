using DiceRealm.Server.Application;

namespace DiceRealm.Server.Api;

public static class CombatEndpoints
{
    public static void MapCombat(this RouteGroupBuilder api, Func<HttpContext, string> token)
    {
        api.MapGet("/campaigns/{id}/dm/overview", (string id, HttpContext context, GameService game) =>
            game.DmOverview(id, token(context), context.RequestAborted));
        api.MapGet("/campaigns/{id}/combat/overview", (string id, HttpContext context, GameService game) =>
            game.CombatOverview(id, token(context), context.RequestAborted));
    }
}
