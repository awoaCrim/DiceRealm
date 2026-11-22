using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.AspNetCore.Http.Features;

namespace DiceRealm.Server.Api;

public static class MapEndpoints
{
    public static void MapMaps(this RouteGroupBuilder api, Func<HttpContext, string> token)
    {
        api.MapGet("/campaigns/{id}/maps/{mapId}/board", (string id, string mapId, HttpContext context, GameService game) => game.Board(id, token(context), mapId, context.RequestAborted));
        api.MapGet("/campaigns/{id}/board/tokens/{entityId}", (string id, string entityId, HttpContext context, GameService game) => game.BoardToken(id, token(context), entityId, context.RequestAborted));
        api.MapPost("/campaigns/{id}/board/commands", async (string id, HttpContext context, GameService game, HarnessRunService runs) =>
        {
            var credential = token(context);
            _ = await game.Get(id, credential, context.RequestAborted);
            // Batch placements and complete validated NPC builds can exceed the ordinary action body.
            var request = await ContentEndpoints.Read<BoardCommandRequest>(context, 128 * 1024, requireConstructorParameters: true);
            return await runs.ObserveCombatCommand(id, credential, request.RequestId, request.ExpectedVersion,
                game.BoardCommand(id, credential, request, context.RequestAborted));
        });
        api.MapGet("/campaigns/{id}/maps", (string id, bool? publishedOnly, HttpContext context, GameService game) => game.Maps(id, token(context), publishedOnly == true, context.RequestAborted));
        api.MapGet("/campaigns/{id}/maps/{mapId}", (string id, string mapId, HttpContext context, GameService game) => game.Map(id, token(context), mapId, context.RequestAborted));
        api.MapGet("/campaigns/{id}/maps/{mapId}/image", async (string id, string mapId, HttpContext context, GameService game) =>
        {
            var image = await game.MapImage(id, token(context), mapId, context.RequestAborted);
            context.Response.Headers.CacheControl = "private,no-store";
            return Results.File(image.Path, "image/png", enableRangeProcessing: false);
        });
        api.MapPost("/campaigns/{id}/maps", async (string id, HttpContext context, GameService game) =>
        {
            var credential = token(context);
            // Authorize before reading a large authored prompt; no active adventure is required.
            if ((await game.Get(id, credential, context.RequestAborted)).Party?.IsHost != true) throw new GameException("forbidden", "需要主持人权限。", 403);
            var request = await ContentEndpoints.Read<CreateMapRequest>(context, 128 * 1024);
            return await game.CreateMap(id, credential, request, context.RequestAborted);
        });
        api.MapPost("/campaigns/{id}/maps/{mapId}/import", (string id, string mapId, string requestId, int expectedVersion, HttpContext context, GameService game) =>
        {
            var credential = token(context);
            if (context.Request.ContentType?.Split(';')[0].Trim() != "image/png")
                throw new GameException("invalid_content_type", "请用 image/png 上传本地原图。", 415);
            var size = context.Features.Get<IHttpMaxRequestBodySizeFeature>();
            if (size is { IsReadOnly: false }) size.MaxRequestBodySize = PngGuard.MaximumMapBytes;
            if (context.Request.ContentLength > PngGuard.MaximumMapBytes)
            {
                if (context.Request.Protocol == "HTTP/1.1") context.Response.Headers.Connection = "close";
                throw new GameException("map_image_too_large", "地图 PNG 最大 32 MiB。", 413);
            }
            return game.ImportMap(id, credential, mapId, new(requestId, expectedVersion), context.Request.Body, context.RequestAborted);
        });
        api.MapPost("/campaigns/{id}/maps/{mapId}/select", (string id, string mapId, SelectMapRequest request, HttpContext context, GameService game) => game.SelectMap(id, token(context), mapId, request, context.RequestAborted));
        api.MapPost("/campaigns/{id}/maps/{mapId}/generate", (string id, string mapId, GenerateMapRequest request, HttpContext context, GameService game) => game.GenerateMap(id, token(context), mapId, request, context.RequestAborted));
        api.MapPost("/campaigns/{id}/maps/{mapId}/publish", (string id, string mapId, PublishMapRequest request, HttpContext context, GameService game) => game.PublishMap(id, token(context), mapId, request, context.RequestAborted));
        api.MapPost("/campaigns/{id}/maps/{mapId}/scenes", (string id, string mapId, ConfigureMapScenesRequest request, HttpContext context, GameService game) => game.ConfigureMapScenes(id, token(context), mapId, request, context.RequestAborted));
        api.MapPost("/campaigns/{id}/maps/{mapId}/markers", async (string id, string mapId, HttpContext context, GameService game) =>
        {
            var credential = token(context);
            if ((await game.Get(id, credential, context.RequestAborted)).Party?.IsHost != true) throw new GameException("forbidden", "需要主持人权限。", 403);
            // 128 UUID-based annotations exceed the normal 16 KiB body cap. Keep this endpoint bounded.
            var request = await ContentEndpoints.Read<ConfigureMapMarkersRequest>(context, 128 * 1024);
            return await game.ConfigureMapMarkers(id, credential, mapId, request, context.RequestAborted);
        });
        api.MapPost("/campaigns/{id}/maps/{mapId}/grid", (string id, string mapId, ConfigureMapGridRequest request, HttpContext context, GameService game) => game.ConfigureMapGrid(id, token(context), mapId, request, context.RequestAborted));
    }
}
