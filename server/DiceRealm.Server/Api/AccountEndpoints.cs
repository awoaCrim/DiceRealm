using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Server.Api;

internal static class AccountEndpoints
{
    internal sealed class LoginAdmission;

    internal static void MapAccounts(this RouteGroupBuilder api)
    {
        var accounts = api.MapGroup("/accounts");
        accounts.MapPost("/login", async (HttpContext context, AccountStore store) =>
        {
            var request = await ContentEndpoints.Read<AccountLoginRequest>(context, 2048, requireConstructorParameters: true);
            return store.Login(request.Username, request.Password);
        }).WithMetadata(new LoginAdmission()).RequireRateLimiting("account-login");
        accounts.MapGet("/me", (HttpContext context, AccountStore store) => store.Require(Token(context)));
        accounts.MapPost("/logout", (HttpContext context, AccountStore store) =>
        {
            store.Logout(Token(context));
            return new { ok = true };
        });
        accounts.MapPost("/password", async (HttpContext context, AccountStore store) =>
        {
            string token = Token(context);
            _ = store.Require(token);
            var request = await ContentEndpoints.Read<ChangeAccountPasswordRequest>(context, 2048, requireConstructorParameters: true);
            store.ChangePassword(token, request.CurrentPassword, request.Password);
            return new { ok = true };
        });
        accounts.MapGet("/campaigns", async (HttpContext context, CampaignStore store) =>
            new { campaigns = await store.ListForAccount(Token(context), context.RequestAborted) });
        accounts.MapPost("/campaigns", async (HttpContext context, AccountStore store, GameService game) =>
        {
            string token = Token(context);
            _ = store.Require(token);
            var request = await ContentEndpoints.Read<CreateRoomRequest>(context, 4096, requireConstructorParameters: true);
            var created = game.CreateRoom(request, token);
            // Never return the permanent legacy host capability to the account workbench.
            return Results.Created("/api/v1/campaigns/" + created.Snapshot.Id, new { campaignId = created.Snapshot.Id });
        });
        accounts.MapGet("/users", (HttpContext context, AccountStore store) => new { users = store.Users(Token(context)) });
        accounts.MapPost("/users", async (HttpContext context, AccountStore store) =>
        {
            string token = Token(context);
            _ = store.RequireAdmin(token);
            var request = await ContentEndpoints.Read<CreateAccountRequest>(context, 2048, requireConstructorParameters: true);
            return store.Create(token, request.Username, request.Password);
        });
        accounts.MapPost("/users/{id}/status", async (string id, HttpContext context, AccountStore store) =>
        {
            string token = Token(context);
            _ = store.RequireAdmin(token);
            var request = await ContentEndpoints.Read<AccountStatusRequest>(context, 512, requireConstructorParameters: true);
            return store.SetDisabled(token, id, request.Disabled);
        });
        accounts.MapPost("/users/{id}/password", async (string id, HttpContext context, AccountStore store) =>
        {
            string token = Token(context);
            _ = store.RequireAdmin(token);
            var request = await ContentEndpoints.Read<AccountPasswordRequest>(context, 2048, requireConstructorParameters: true);
            store.ResetPassword(token, id, request.Password);
            return new { ok = true };
        });
    }
    internal static string Token(HttpContext context)
    {
        string header = context.Request.Headers.Authorization.ToString();
        if (!header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) || header.Length != 71 || header[7..].Any(c => !char.IsAsciiHexDigit(c)))
            throw new GameException("account_unauthorized", "需要有效的账户登录会话。", 401);
        return header[7..];
    }
}
