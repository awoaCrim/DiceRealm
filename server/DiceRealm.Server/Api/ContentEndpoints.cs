using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.AspNetCore.Http.Features;

namespace DiceRealm.Server.Api;

public static class ContentEndpoints
{
    public const int MaximumBytes = 1024 * 1024;
    private static readonly JsonSerializerOptions StrictJson = new(JsonFiles.Options) { PropertyNameCaseInsensitive = false, MaxDepth = 32 };
    private static readonly JsonSerializerOptions RequiredJson = new(StrictJson) { RespectRequiredConstructorParameters = true };
    public static void MapContent(this RouteGroupBuilder api, Func<HttpContext, string> token)
    {
        api.MapGet("/campaigns/{id}/content/library", (string id, HttpContext context, GameService game) => game.ReadAdventureLibrary(id, token(context), context.RequestAborted));
        api.MapPost("/campaigns/{id}/content/library/activate", (string id, ActivateLibraryRequest request, HttpContext context, GameService game) => game.ActivateLibrary(id, token(context), request, context.RequestAborted));
        api.MapGet("/campaigns/{id}/content", (string id, HttpContext context, GameService game) => game.ExportContent(id, token(context), context.RequestAborted));
        api.MapPost("/campaigns/{id}/content/adventure", async (string id, HttpContext context, GameService game) =>
        {
            var capability = token(context);
            var request = await Read<ImportAdventureRequest>(context);
            return await game.ImportAdventure(id, capability, request, context.RequestAborted);
        });
        api.MapPost("/campaigns/{id}/content/prompts", async (string id, HttpContext context, GameService game) =>
        {
            var capability = token(context);
            var request = await Read<ImportPromptsRequest>(context);
            return await game.ImportPrompts(id, capability, request, context.RequestAborted);
        });
        api.MapGet("/campaigns/{id}/content/prompt-history", (string id, HttpContext context, GameService game) => game.PromptsHistory(id, token(context), context.RequestAborted));
        api.MapPost("/campaigns/{id}/content/prompts-bind", (string id, BindPromptsRequest request, HttpContext context, GameService game) => game.BindPrompts(id, token(context), request, context.RequestAborted));
        api.MapPost("/campaigns/{id}/content/preflight", async (string id, HttpContext context, GameService game) =>
        {
            var capability = token(context); var request = await Read<PreflightRequest>(context);
            return await game.Preflight(id, capability, request, context.RequestAborted);
        });
        api.MapPost("/campaigns/{id}/content/trial", async (string id, HttpContext context, GameService game) =>
        {
            var capability = token(context); var request = await Read<TrialRequest>(context);
            return await game.CreateTrial(id, capability, request, context.RequestAborted);
        });
        api.MapPost("/campaigns/{id}/content/activate", (string id, ActivateContentRequest request, HttpContext context, GameService game) => game.ActivateContent(id, token(context), request, context.RequestAborted));
    }
    // Raise the limit only for content-bearing endpoints, before touching the request body.
    public static async Task<T> Read<T>(HttpContext context, int maximumBytes = MaximumBytes, bool requireConstructorParameters = false)
    {
        if (context.Request.ContentType?.Split(';')[0].Trim() != "application/json") throw new GameException("invalid_content_type", "请上传 application/json。", 415);
        var size = context.Features.Get<IHttpMaxRequestBodySizeFeature>();
        if (size is { IsReadOnly: false }) size.MaxRequestBodySize = maximumBytes;
        if (context.Request.ContentLength > maximumBytes)
        {
            if (context.Request.Protocol == "HTTP/1.1") context.Response.Headers.Connection = "close";
            throw new GameException("content_too_large", "导入内容超过此接口允许的大小。", 413);
        }
        using var buffer = new MemoryStream(); var chunk = new byte[8192]; int count;
        while ((count = await context.Request.Body.ReadAsync(chunk, context.RequestAborted)) > 0)
        {
            if (buffer.Length + count > maximumBytes)
            {
                if (context.Request.Protocol == "HTTP/1.1") context.Response.Headers.Connection = "close";
                throw new GameException("content_too_large", "导入内容超过此接口允许的大小。", 413);
            }
            buffer.Write(chunk, 0, count);
        }
        try
        {
            using var document = JsonDocument.Parse(buffer.ToArray(), new JsonDocumentOptions { MaxDepth = 32 });
            RejectDuplicates(document.RootElement);
            return document.RootElement.Deserialize<T>(requireConstructorParameters ? RequiredJson : StrictJson) ?? throw new GameException("invalid_content", "导入文档不能为空。");
        }
        catch (JsonException) { throw new GameException("invalid_content", "JSON 结构、字段名称或字段类型不合法；不接受未知字段。"); }
    }
    private static void RejectDuplicates(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Object)
        {
            var keys = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in value.EnumerateObject())
            {
                if (!keys.Add(property.Name)) throw new GameException("invalid_content", "JSON 中存在重复字段：" + property.Name);
                RejectDuplicates(property.Value);
            }
        }
        else if (value.ValueKind == JsonValueKind.Array) foreach (var item in value.EnumerateArray()) RejectDuplicates(item);
    }
}
