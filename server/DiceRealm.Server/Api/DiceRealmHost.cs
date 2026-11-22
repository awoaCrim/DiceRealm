using System.Text.Json;
using System.Text.Json.Serialization;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.AspNetCore.Http.Features;

namespace DiceRealm.Server.Api;

public static class DiceRealmHost
{
    public static WebApplication Build(string[] args, Action<WebApplicationBuilder>? configure = null)
    {
        var builder = WebApplication.CreateBuilder(args);
        if (string.IsNullOrWhiteSpace(builder.Configuration["urls"])) builder.WebHost.UseUrls("http://127.0.0.1:5180");
        builder.WebHost.ConfigureKestrel(options => options.Limits.MaxRequestBodySize = 16 * 1024);
        builder.Services.Configure<RouteHandlerOptions>(options => options.ThrowOnBadRequest = true);
        builder.Services.ConfigureHttpJsonOptions(options =>
        {
            options.SerializerOptions.UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow;
            options.SerializerOptions.PropertyNameCaseInsensitive = false;
        });
        builder.Services.AddSingleton<DataDirectory>();
        builder.Services.AddSingleton<AccountStore>();
        builder.Services.AddSingleton<CampaignStore>();
        builder.Services.AddRoomAdmission();
        builder.Services.AddSingleton<ProviderBudget>();
        builder.Services.AddSingleton<ModelRequestLog>();
        builder.Services.AddSingleton<AiConfigurationStore>();
        builder.Services.AddSingleton<AiConnectionTester>();
        builder.Services.AddSingleton<IDice, ServerDice>();
        builder.Services.AddSingleton<RulesEngine>();
        builder.Services.AddSingleton<CombatEngine>();
        builder.Services.AddSingleton<CharacterEngine>();
        builder.Services.AddSingleton<CharacterPlayEngine>();
        builder.Services.AddSingleton<GrowthEngine>();
        builder.Services.AddSingleton<RulingEngine>();
        builder.Services.AddSingleton<GameService>();
        builder.Services.AddSingleton<OfflineText>();
        // Callers own bounded per-operation deadlines; a second shorter HTTP timer would truncate slow models.
        builder.Services.AddHttpClient<OpenAiText>(client => client.Timeout = Timeout.InfiniteTimeSpan)
            .ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler { AllowAutoRedirect = false })
            .AddHttpMessageHandler(services => new ModelRequestLogHandler(services.GetRequiredService<ModelRequestLog>(), "OpenAiText", services.GetService<ILogger<ModelRequestLogHandler>>()));
        builder.Services.AddHttpClient<OpenAiImages>(client => client.Timeout = Timeout.InfiniteTimeSpan)
            .ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler { AllowAutoRedirect = false });
        builder.Services.AddHttpClient<OpenAiPreparation>(client => client.Timeout = Timeout.InfiniteTimeSpan)
            .ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler { AllowAutoRedirect = false })
            .AddHttpMessageHandler(services => new ModelRequestLogHandler(services.GetRequiredService<ModelRequestLog>(), "OpenAiPreparation", services.GetService<ILogger<ModelRequestLogHandler>>()));
        builder.Services.AddSingleton<SceneReferences>();
        builder.Services.AddSingleton<ConfiguredText>();
        builder.Services.AddSingleton<IIntentInterpreter>(services => services.GetRequiredService<ConfiguredText>());
        builder.Services.AddSingleton<INarrator>(services => services.GetRequiredService<ConfiguredText>());
        builder.Services.AddSingleton<OfflinePreparation>();
        builder.Services.AddSingleton<IPreparationGenerator, ConfiguredPreparation>();
        builder.Services.AddSingleton<IMapImageGenerator, ConfiguredImages>();
        builder.Services.AddSingleton<AssetCatalog>();
        builder.Services.AddSingleton<MapCatalog>();
        builder.Services.AddSingleton<PortraitCatalog>();
        builder.Services.AddSingleton<AdventureLibrary>();
        builder.Services.AddSingleton<PrivateStoryRetellings>();
        builder.Services.AddHttpClient(nameof(PrivateStoryRetellings), client => client.Timeout = Timeout.InfiniteTimeSpan)
            .ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler { AllowAutoRedirect = false })
            .AddHttpMessageHandler(services => new ModelRequestLogHandler(services.GetRequiredService<ModelRequestLog>(), nameof(PrivateStoryRetellings), services.GetService<ILogger<ModelRequestLogHandler>>()));
        builder.Services.AddSingleton<PreparationCatalog>();
        builder.Services.AddSingleton<PreparationService>();
        builder.Services.AddHttpClient<OpenAiHarnessModel>(client => client.Timeout = Timeout.InfiniteTimeSpan)
            .ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler { AllowAutoRedirect = false })
            .AddHttpMessageHandler(services => new ModelRequestLogHandler(services.GetRequiredService<ModelRequestLog>(), "OpenAiHarnessModel", services.GetService<ILogger<ModelRequestLogHandler>>()));
        builder.Services.AddHttpClient<GeminiHarnessModel>(client => client.Timeout = Timeout.InfiniteTimeSpan)
            .ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler { AllowAutoRedirect = false })
            .AddHttpMessageHandler(services => new ModelRequestLogHandler(services.GetRequiredService<ModelRequestLog>(), "GeminiHarnessModel", services.GetService<ILogger<ModelRequestLogHandler>>()));
        builder.Services.AddHttpClient(nameof(ConfiguredHarnessHistorian), client => client.Timeout = Timeout.InfiniteTimeSpan)
            .ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler { AllowAutoRedirect = false })
            .AddHttpMessageHandler(services => new ModelRequestLogHandler(services.GetRequiredService<ModelRequestLog>(), nameof(ConfiguredHarnessHistorian), services.GetService<ILogger<ModelRequestLogHandler>>()));
        builder.Services.AddSingleton<IHarnessHistorian, ConfiguredHarnessHistorian>();
        builder.Services.AddSingleton<HarnessHistoryManager>();
        builder.Services.AddHostedService(services => services.GetRequiredService<HarnessHistoryManager>());
        builder.Services.AddSingleton<IHarnessModel, ConfiguredHarnessModel>();
        builder.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>();
        builder.Services.AddSingleton<HarnessRunStore>();
        builder.Services.AddSingleton<HarnessWorkspaceCatalog>();
        builder.Services.AddSingleton<LocalRulesCatalog>();
        builder.Services.AddSingleton<HarnessRunService>();
        builder.Services.AddSingleton<AdventureSessionService>();
        builder.Services.AddHostedService(services => services.GetRequiredService<HarnessRunService>());
        builder.Services.AddHostedService<MapWorker>();
        builder.Services.AddHostedService<PortraitWorker>();
        configure?.Invoke(builder);
        var app = builder.Build();
        _ = app.Services.GetRequiredService<DataDirectory>();
        _ = app.Services.GetRequiredService<AccountStore>();
        app.Use(async (context, next) =>
        {
            if (context.Request.Path.StartsWithSegments("/api")) context.Response.Headers.CacheControl = "no-store";
            using var timeline = CampaignTimeline.Bind(context.Request.Headers["X-DiceRealm-Timeline"].ToString(),
                !HttpMethods.IsGet(context.Request.Method) && !HttpMethods.IsHead(context.Request.Method),
                context.Request.Path.Value is { } path && (path.Contains("/adventure/saves", StringComparison.Ordinal) || path.EndsWith("/adventure/restart", StringComparison.Ordinal)));
            try { await next(context); }
            catch (GameException ex)
            {
                context.Response.StatusCode = ex.Status;
                await context.Response.WriteAsJsonAsync(new { code = ex.Code, message = ex.Message });
            }
            catch (BadHttpRequestException ex)
            {
                context.Response.StatusCode = ex.StatusCode;
                await context.Response.WriteAsJsonAsync(new { code = "invalid_request", message = "请求 JSON、字段或大小不合法。" });
            }
            catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested) { }
            catch (Exception ex)
            {
                app.Logger.LogError("Request failed ({ErrorType})", ex.GetType().Name);
                // A timed-out/failed streamed export must terminate the connection, not append
                // an error JSON fragment to a superficially successful transcript download.
                if (context.Response.HasStarted) { context.Abort(); return; }
                context.Response.StatusCode = 500;
                await context.Response.WriteAsJsonAsync(new { code = "server_error", message = "服务端处理失败。请保留同一 requestId 重试。" });
            }
        });
        app.UseRateLimiter();
        app.MapWorkbench();
        app.MapGet("/health", (ConfiguredText text) => new { status = "ok", ruleset = "dnd2024", textMode = text.AnyEnabled ? "ai" : "offline", apiVersion = 1, sceneGeneration = false, imagePurpose = "maps" });
        var api = app.MapGroup("/api/v1");
        api.MapAiSettings();
        api.MapAccounts();
        api.MapModelRequests(Token);
        api.MapRooms(Token);
        api.MapContent(Token);
        api.MapPreparation(Token);
        api.MapHarness(Token);
        api.MapHarnessWorkspace(Token);
        api.MapAdventure(Token);
        api.MapGameSaves(Token);
        api.MapMaps(Token);
        api.MapPortraits(Token);
        api.MapUnderstanding(Token);
        api.MapCharacterReviews(Token);
        api.MapWorldMemory(Token);
        api.MapAdvancement(Token);
        api.MapPartyRest(Token);
        api.MapCombat(Token);
        api.MapGet("/character-build/catalog", () => BuildCatalog.Get());
        api.MapGet("/character-play/catalog", () => new { ruleset="dnd2024", source="XPHB", conditions=PlayCatalog.Conditions,
            equipment=BuildCatalog.Get().Equipment.Select(e=>new BuildOption(BuildCatalog.ItemId(e.Id),e.Name))
                .Concat(new[] {new BuildOption("gold-piece","Gold Piece"),new BuildOption("silver-piece","Silver Piece"),new BuildOption("copper-piece","Copper Piece")}).ToArray() });
        api.MapPost("/character-build/evaluate", async (HttpContext context) =>
        {
            var request = await ContentEndpoints.Read<EvaluateBuildRequest>(context, 65536);
            if (request.Build is null) throw new GameException("invalid_character_build", "缺少建卡草稿。");
            return BuildEvaluator.Evaluate(request.Build);
        });
        // Retired read-only entry points are explicit, not a hidden alternative builder.
        api.MapGet("/character-creation", () => Results.Json(new { code = "full_character_build_required", message = "简化建卡已停用，请使用完整建卡。" }, statusCode: 410));
        api.MapPost("/character-creation/preview", () => Results.Json(new { code = "full_character_build_required", message = "简化建卡已停用，请使用完整建卡。" }, statusCode: 410));
        api.MapPost("/campaigns", async (HttpContext context, GameService game) =>
        {
            var request = await ContentEndpoints.Read<CreateCampaignRequest>(context);
            var result = game.Create(request);
            return Results.Created("/api/v1/campaigns/" + result.Snapshot.Id, result);
        });
        api.MapGet("/campaigns/{id}", (string id, HttpContext context, GameService game) =>
            game.Get(id, Token(context), context.RequestAborted));
        api.MapPost("/campaigns/{id}/actions/input", (string id, ActionRequest request, HttpContext context, GameService game) =>
            game.InputAction(id, Token(context), request, context.RequestAborted));
        api.MapPost("/campaigns/{id}/actions/propose", (string id, ActionRequest request, HttpContext context, GameService game, HarnessRunService runs) =>
            runs.ObserveCombatCommand(id, Token(context), request.RequestId, request.ExpectedVersion, game.ProposeAction(id, Token(context), request, context.RequestAborted)));
        api.MapPost("/campaigns/{id}/rolls/respond", (string id, RollResponseRequest request, HttpContext context, GameService game, HarnessRunService runs) =>
            runs.ObserveCombatCommand(id, Token(context), request.RequestId, request.ExpectedVersion, game.RespondToRoll(id, Token(context), request, context.RequestAborted)));
        api.MapPost("/campaigns/{id}/rulings/respond", (string id, ResolveRulingRequest request, HttpContext context, GameService game, HarnessRunService runs) =>
            runs.ObserveCombatCommand(id, Token(context), request.RequestId, request.ExpectedVersion, game.RespondToRuling(id, Token(context), request, context.RequestAborted)));
        api.MapPost("/campaigns/{id}/actions", (string id, ActionRequest request, HttpContext context, GameService game, HarnessRunService runs) =>
            runs.ObserveCombatCommand(id, Token(context), request.RequestId, request.ExpectedVersion, game.Act(id, Token(context), request, context.RequestAborted)));
        api.MapPost("/campaigns/{id}/invitations", (string id, InviteRequest request, HttpContext context, GameService game) =>
            game.Invite(id, Token(context), request, context.RequestAborted));
        api.MapPost("/campaigns/{id}/join", async (string id, HttpContext context, GameService game) =>
            await game.Join(id, await ContentEndpoints.Read<JoinCampaignRequest>(context, 65536), context.RequestAborted));
        api.MapPost("/campaigns/{id}/seats/revoke", (string id, RevokeSeatRequest request, HttpContext context, GameService game) =>
            game.RevokeSeat(id, Token(context), request, context.RequestAborted));
        api.MapPost("/campaigns/{id}/invitations/revoke", (string id, RevokeInviteRequest request, HttpContext context, GameService game) =>
            game.RevokeInvite(id, Token(context), request, context.RequestAborted));
        api.MapPost("/campaigns/{id}/rulings/resolve", (string id, ResolveRulingRequest request, HttpContext context, GameService game, HarnessRunService runs) =>
            runs.ObserveCombatCommand(id, Token(context), request.RequestId, request.ExpectedVersion, game.ResolveRuling(id, Token(context), request, context.RequestAborted)));
        api.MapGet("/campaigns/{id}/activity", (string id, int? after, int? through, int? limit, HttpContext context, GameService game) =>
            game.Activity(id, Token(context), after ?? 0, through, limit ?? 50, context.RequestAborted));
        api.MapGet("/campaigns/{id}/activity/{sequence:int}", (string id, int sequence, HttpContext context, GameService game) =>
            game.ActivityDetail(id, Token(context), sequence, context.RequestAborted));
        api.MapGet("/campaigns/{id}/rulings/story-options", (string id, string rulingId, HttpContext context, GameService game) =>
            game.StoryOptions(id, Token(context), rulingId, context.RequestAborted));
        api.MapPost("/campaigns/{id}/rulings/story-preview", async (string id, HttpContext context, GameService game) =>
            await game.PreviewStory(id, Token(context), await ContentEndpoints.Read<StoryRequest>(context, 16384), context.RequestAborted));
        api.MapPost("/campaigns/{id}/rulings/story", async (string id, HttpContext context, GameService game, HarnessRunService runs) =>
        {
            var request = await ContentEndpoints.Read<StoryRequest>(context, 16384);
            return await runs.ObserveCombatCommand(id, Token(context), request.RequestId, request.ExpectedVersion,
                game.ApplyStory(id, Token(context), request, context.RequestAborted));
        });
        api.MapGet("/campaigns/{id}/character/sheet", (string id, HttpContext context, GameService game) =>
            game.CharacterSheet(id, Token(context), context.RequestAborted));
        api.MapGet("/campaigns/{id}/characters/{actorId}/references", (string id, string actorId, HttpContext context, GameService game) =>
            game.CharacterReferences(id, Token(context), actorId, context.RequestAborted));
        api.MapPost("/campaigns/{id}/character/commands", (string id, CharacterPlayRequest request, HttpContext context, GameService game, HarnessRunService runs) =>
            runs.ObserveCombatCommand(id, Token(context), request.RequestId, request.ExpectedVersion,
                game.PlayCharacter(id, Token(context), request, context.RequestAborted)));
        api.MapPost("/campaigns/{id}/characters/adjust-preview", (string id, AdjustCharacterRequest request, HttpContext context, GameService game) =>
            game.PreviewAdjustment(id, Token(context), request, context.RequestAborted));
        api.MapPost("/campaigns/{id}/characters/adjust", (string id, AdjustCharacterRequest request, HttpContext context, GameService game) =>
            game.AdjustCharacter(id, Token(context), request, context.RequestAborted));
        api.MapGet("/campaigns/{id}/assets/{assetId}", (string id, string assetId, HttpContext context, GameService game) =>
            game.GetAsset(id, Token(context), assetId, context.RequestAborted));
        api.MapPost("/campaigns/{id}/scene-asset", (string id, ReviseSceneAssetRequest request, HttpContext context, GameService game) =>
            game.ReviseAsset(id, Token(context), request, context.RequestAborted));
        api.MapPost("/campaigns/{id}/assets/{assetId}/retry", (string id, string assetId, RetrySceneAssetRequest request, HttpContext context, GameService game) =>
            game.RetryAsset(id, Token(context), assetId, request, context.RequestAborted));
        api.MapPost("/campaigns/{id}/assets/{assetId}/reference", (string id, string assetId, HttpContext context, GameService game) =>
            game.AssetReference(id, Token(context), assetId, context.RequestAborted));
        api.MapGet("/campaigns/{id}/references", (string id, HttpContext context, GameService game) =>
            game.References(id, Token(context), context.RequestAborted));
        api.MapPost("/campaigns/{id}/references", (string id, string? name, HttpContext context, GameService game) =>
        {
            var token = Token(context);
            if (!string.Equals(context.Request.ContentType, "image/png", StringComparison.OrdinalIgnoreCase))
                throw new GameException("invalid_content_type", "使用 image/png 上传参考图。", 415);
            var size = context.Features.Get<IHttpMaxRequestBodySizeFeature>();
            if (size is { IsReadOnly: false }) size.MaxRequestBodySize = PngGuard.MaximumBytes;
            return game.UploadReference(id, token, name ?? "参考图", context.Request.Body, context.RequestAborted);
        });
        api.MapGet("/campaigns/{id}/events", (string id, int? after, int? limit, HttpContext context, GameService game) =>
            game.Events(id, Token(context), after ?? 0, limit ?? 100, context.RequestAborted));
        api.MapGet("/campaigns/{id}/resources", (string id, HttpContext context, GameService game) =>
            game.Resources(id, Token(context), context.RequestAborted));
        api.MapPost("/campaigns/{id}/resources/pregenerate", (string id, PreGenerateScenesRequest request, HttpContext context, GameService game) =>
            game.PreGenerate(id, Token(context), request, context.RequestAborted));
        api.MapGet("/campaigns/{id}/journal", (string id, int? after, int? through, int? limit, HttpContext context, GameService game) =>
            game.Journal(id, Token(context), after ?? 0, through, limit ?? 50, context.RequestAborted));
        api.MapGet("/campaigns/{id}/recap", (string id, HttpContext context, GameService game) =>
            game.Recap(id, Token(context), context.RequestAborted));
        api.MapPost("/campaigns/{id}/archive", (string id, ArchiveCampaignRequest request, HttpContext context, GameService game) =>
            game.Archive(id, Token(context), request, context.RequestAborted));
        api.MapGet("/campaigns/{id}/journal/export", (string id, HttpContext context, GameService game) =>
            game.ExportJournal(id, Token(context), context.Response, context.RequestAborted));
        app.MapGet("/assets/{file}", (string file, AssetCatalog catalog, HttpContext context) =>
        {
            if (!file.EndsWith(".png", StringComparison.Ordinal) || !AssetCatalog.IsHash(file[..^4])) return Results.NotFound();
            var path = catalog.ImagePath(file[..^4]);
            if (!File.Exists(path)) return Results.NotFound();
            context.Response.Headers.CacheControl = "public,max-age=31536000,immutable";
            context.Response.Headers.ETag = "\"" + file[..^4] + "\"";
            return Results.File(path, "image/png", enableRangeProcessing: false);
        });
        return app;
    }

    private static string Token(HttpContext context)
    {
        var header = context.Request.Headers.Authorization.ToString();
        if (!header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) || header.Length != 71)
            throw new GameException("unauthorized", "需要战役访问凭证。", 401);
        return header[7..];
    }
}
