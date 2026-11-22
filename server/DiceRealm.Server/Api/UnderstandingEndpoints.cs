using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Api;

public static class UnderstandingEndpoints
{
    public static void MapUnderstanding(this RouteGroupBuilder api, Func<HttpContext, string> token)
    {
        api.MapPost("/campaigns/{id}/actions/interpret", (string id, ActionRequest request, HttpContext context, GameService game) =>
            game.InterpretAction(id, token(context), request, context.RequestAborted));
        api.MapPost("/campaigns/{id}/intents/respond", (string id, IntentResponseRequest request, HttpContext context, GameService game, HarnessRunService runs) =>
            runs.ObserveCombatCommand(id, token(context), request.RequestId, request.ExpectedVersion, game.RespondToIntent(id, token(context), request, context.RequestAborted)));
    }
}
