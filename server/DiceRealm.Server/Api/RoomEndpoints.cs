using System.Threading.RateLimiting;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using Microsoft.AspNetCore.RateLimiting;

namespace DiceRealm.Server.Api;

internal static class RoomEndpoints
{
    private sealed class RoomJoinAdmission;
    internal static void AddRoomAdmission(this IServiceCollection services)
    {
        services.AddRateLimiter(options =>
        {
            options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
            options.OnRejected = async (rejected, ct) =>
            {
                rejected.HttpContext.Response.Headers.RetryAfter = "60";
                bool login = rejected.HttpContext.GetEndpoint()?.Metadata.GetMetadata<AccountEndpoints.LoginAdmission>() is not null;
                await rejected.HttpContext.Response.WriteAsJsonAsync(new
                {
                    code = login ? "account_login_rate_limited" : "room_join_rate_limited",
                    message = login ? "登录尝试过于频繁，请稍后重试。" : "加入尝试过于频繁，请稍后重试原请求。"
                }, ct);
            };
            // Bound password work globally as well as per network peer. Never trust forwarded headers.
            options.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, string>(context =>
                context.GetEndpoint()?.Metadata.GetMetadata<RoomJoinAdmission>() is not null
                    ? RateLimitPartition.GetFixedWindowLimiter("room-join", _ => Window(120))
                    : context.GetEndpoint()?.Metadata.GetMetadata<AccountEndpoints.LoginAdmission>() is not null
                        ? RateLimitPartition.GetFixedWindowLimiter("account-login", _ => Window(120))
                        : RateLimitPartition.GetNoLimiter("other"));
            options.AddPolicy("room-join", context => RateLimitPartition.GetFixedWindowLimiter(
                context.Connection.RemoteIpAddress?.ToString() ?? "unknown", _ => Window(20)));
            options.AddPolicy("account-login", context => RateLimitPartition.GetFixedWindowLimiter(
                context.Connection.RemoteIpAddress?.ToString() ?? "unknown", _ => Window(20)));
        });
    }
    private static FixedWindowRateLimiterOptions Window(int limit) => new()
    { PermitLimit = limit, Window = TimeSpan.FromMinutes(1), QueueLimit = 0, AutoReplenishment = true };

    internal static void MapRooms(this RouteGroupBuilder api, Func<HttpContext, string> token)
    {
        api.MapPost("/rooms", async (HttpContext context, GameService game) =>
        {
            var request = await ContentEndpoints.Read<CreateRoomRequest>(context, 4096, requireConstructorParameters: true);
            var result = game.CreateRoom(request);
            return Results.Created("/api/v1/campaigns/" + result.Snapshot.Id, result);
        });
        api.MapPost("/campaigns/{id}/adventure/setup", async (string id, HttpContext context, GameService game) =>
            await game.InitializeRoomAdventure(id, token(context), await ContentEndpoints.Read<InitializeRoomAdventureRequest>(context, 1024 * 1024, requireConstructorParameters: true), context.RequestAborted));
        api.MapGet("/campaigns/{id}/room", (string id, HttpContext context, GameService game) =>
            game.GetRoom(id, token(context), context.RequestAborted));
        api.MapPost("/campaigns/{id}/room", async (string id, HttpContext context, GameService game) =>
            await game.ConfigureRoom(id, token(context), await ContentEndpoints.Read<ConfigureRoomRequest>(context, 4096, requireConstructorParameters: true), context.RequestAborted));
        api.MapPost("/rooms/join", async (HttpContext context, GameService game) =>
            await game.JoinRoom(await ContentEndpoints.Read<JoinRoomRequest>(context, 65536, requireConstructorParameters: true), context.RequestAborted))
            .WithMetadata(new RoomJoinAdmission()).RequireRateLimiting("room-join");
    }
}
