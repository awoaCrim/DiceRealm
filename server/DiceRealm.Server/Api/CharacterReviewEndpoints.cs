using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Api;

public static class CharacterReviewEndpoints
{
    public static void MapCharacterReviews(this RouteGroupBuilder api, Func<HttpContext, string> token)
    {
        api.MapPost("/campaigns/{id}/characters/review", (string id, ReviewCharacterRequest request, HttpContext context, GameService game) =>
            game.ReviewCharacter(id, token(context), request, context.RequestAborted));
        api.MapPost("/campaigns/{id}/character/resubmit", async (string id, HttpContext context, GameService game) =>
        {
            string accessToken = token(context);
            var request = await ContentEndpoints.Read<ResubmitCharacterRequest>(context, 65536);
            return await game.ResubmitCharacter(id, accessToken, request, context.RequestAborted);
        });
    }
}
