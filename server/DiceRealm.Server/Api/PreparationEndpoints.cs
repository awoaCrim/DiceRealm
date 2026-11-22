using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Api;

// Host-only input-driven preparation. It never modifies the bound adventure, prompts, events or
// characters: results live in the separate preparation catalog until the host adopts them through
// the existing import/check/trial/activate chain.
public static class PreparationEndpoints
{
    public static void MapPreparation(this RouteGroupBuilder api, Func<HttpContext, string> token)
    {
        api.MapGet("/campaigns/{id}/content/preparation/status", (string id, HttpContext context, PreparationService preparation) =>
            preparation.Status(id, token(context), context.RequestAborted));
        api.MapPost("/campaigns/{id}/content/preparation", async (string id, HttpContext context, PreparationService preparation) =>
        {
            var capability = token(context);
            var request = await ContentEndpoints.Read<PreparationRequest>(context, PreparationService.MaximumRequestBytes, requireConstructorParameters: true);
            return await preparation.Prepare(id, capability, request, context.RequestAborted);
        });
        api.MapGet("/campaigns/{id}/content/preparation/requests/{requestId}", (string id, string requestId, HttpContext context, PreparationService preparation) =>
            preparation.GetRequest(id, token(context), requestId, context.RequestAborted));
        api.MapPost("/campaigns/{id}/content/preparation/inspect", async (string id, HttpContext context, PreparationService preparation) =>
        {
            var capability = token(context);
            var request = await ContentEndpoints.Read<PreparationInspectRequest>(context, PreparationService.MaximumRequestBytes, requireConstructorParameters: true);
            return await preparation.Inspect(id, capability, request, context.RequestAborted);
        });
    }
}
