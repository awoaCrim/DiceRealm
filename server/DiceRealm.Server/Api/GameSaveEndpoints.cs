using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Api;

public static class GameSaveEndpoints
{
    public static void MapGameSaves(this RouteGroupBuilder api, Func<HttpContext, string> token)
    {
        var group = api.MapGroup("/campaigns/{id}/adventure");
        group.MapGet("/saves", (string id, HttpContext context, HarnessRunService runs) =>
            runs.GameSaves(id, token(context), context.RequestAborted));
        group.MapPost("/saves", async (string id, HttpContext context, HarnessRunService runs) =>
        {
            string credential = token(context);
            var request = await ContentEndpoints.Read<SaveGameRequest>(context, 16384, requireConstructorParameters: true);
            return await runs.SaveGame(id, credential, request, context.RequestAborted);
        });
        group.MapPost("/saves/{saveId}/load", async (string id, string saveId, HttpContext context, HarnessRunService runs) =>
        {
            string credential = token(context);
            var request = await ContentEndpoints.Read<LoadGameRequest>(context, 16384, requireConstructorParameters: true);
            return await runs.LoadGame(id, credential, saveId, request, context.RequestAborted);
        });
        group.MapPost("/saves/{saveId}/delete", async (string id, string saveId, HttpContext context, HarnessRunService runs) =>
        {
            string credential = token(context);
            var request = await ContentEndpoints.Read<DeleteGameSaveRequest>(context, 16384, requireConstructorParameters: true);
            return await runs.DeleteGameSave(id, credential, saveId, request, context.RequestAborted);
        });
        group.MapPost("/restart", async (string id, HttpContext context, HarnessRunService runs) =>
        {
            string credential = token(context);
            var request = await ContentEndpoints.Read<RestartGameRequest>(context, 16384, requireConstructorParameters: true);
            return await runs.RestartGame(id, credential, request, context.RequestAborted);
        });
    }
}
