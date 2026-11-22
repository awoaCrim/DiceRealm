using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using SkiaSharp;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class SharedBoardTests
{
    internal static byte[] MapPng(int width = 512, int height = 384)
    {
        using var bitmap = new SKBitmap(width, height); using var canvas = new SKCanvas(bitmap);
        canvas.Clear(new SKColor(230, 220, 190)); using var paint = new SKPaint { Color = SKColors.DarkOliveGreen };
        canvas.DrawRect(0, 0, width / 2f, height, paint);
        using var image = SKImage.FromBitmap(bitmap); using var data = image.Encode(SKEncodedImageFormat.Png, 100); return data.ToArray();
    }
    internal static MapAssetView Install(Host h, string id, string edition = "player", byte[]? png = null)
    {
        var maps = h.App.Services.GetRequiredService<MapCatalog>();
        var map = maps.Create(id, new(Id(), ImportedMapTests.Spec(edition)));
        map = maps.Import(id, map.Id, new(Id(), map.Version), png ?? MapPng());
        map = maps.ConfigureScenes(id, map.Id, new(Id(), map.Version, ["harbor", "watch-road"]), ["harbor", "watch-road"]);
        if (edition == "player") map = maps.Publish(id, map.Id, new(Id(), map.Version, true, true));
        return map;
    }
    private static BoardSpawn Custom(string name, double x, double y, string visibility = "player", BoardStatistics? stats = null) =>
        new("", "creature", new("custom"), new(name, Visibility: visibility), x, y, Statistics: stats);
    private static Task<BoardCommandResponse> Command(Host h, string id, BoardCommandRequest request) => BoardPost<BoardCommandResponse>(h, id, "board/commands", request);
    internal static Task<T> BoardPost<T>(Host h, string id, string path, object request)
    {
        if (request is BoardCommandRequest board && board.ExpectedMapVersion == 0)
            request = board with { ExpectedMapVersion = h.App.Services.GetRequiredService<MapCatalog>().Get(id, board.MapId, true).Version };
        return HarnessTests.Post<T>(h, id, path, request);
    }
    private static Task<BoardView?> Board(Host h, string id, string mapId) => h.Http.GetFromJsonAsync<BoardView>($"/api/v1/campaigns/{id}/maps/{mapId}/board");

    public static async Task PersistentIdentityAuthorityAndReplay()
    {
        var dice = new SequenceDice(); var h = await Host.Start(dice: dice);
        try
        {
            var owner = await h.Create(); string id = owner.Snapshot.Id; var map = Install(h, id);
            var request = new BoardCommandRequest(Id(), owner.Snapshot.Version, map.Id, "spawn", Spawns:
                [Custom("Twin", .2, .3, stats: new(7, 12, 13, 30)), Custom("Twin", .6, .3, stats: new(12, 12, 13, 30)), Custom("SECRET_NPC", .9, .8, "gm")]);
            var created = await Command(h, id, request); Check.Equal("applied", created.Result.Status);
            Check.Equal(3, created.Board.Tokens.Length); Check.Equal(3, created.Result.EntityIds.Distinct().Count());
            string a = created.Result.EntityIds[0], b = created.Result.EntityIds[1];
            var read = await h.Http.GetFromJsonAsync<BoardTokenDetail>($"/api/v1/campaigns/{id}/board/tokens/{a}");
            Check.Equal(7, read!.Statistics!.HitPoints); Check.Equal(12, (await h.Http.GetFromJsonAsync<BoardTokenDetail>($"/api/v1/campaigns/{id}/board/tokens/{b}"))!.Statistics!.HitPoints);
            var replay = await Command(h, id, request); Check.True(replay.Replayed); Check.True(replay.Result.EntityIds.SequenceEqual(created.Result.EntityIds));
            Check.Equal(created.Board.Version, replay.Board.Version);
            Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/board/commands", request with { Spawns = [Custom("Other", .1, .1)] })).StatusCode);
            int version = created.Board.Version;
            var moved = await Command(h, id, new(Id(), version, map.Id, "move", a, Destination: new(.4, .5), Path: [new(.3, .4)]));
            Check.Equal(.4, moved.Board.Tokens.Single(t => t.Id == a).X);
            Check.Equal(0, moved.Board.RecentOperations.Length);
            var undo = new BoardCommandRequest(Id(), moved.Board.Version, map.Id, "undo", OperationId: moved.Result.OperationId, ExpectedMapVersion: map.Version);
            Check.Equal(HttpStatusCode.BadRequest, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/board/commands", undo)).StatusCode);
            Check.Equal(moved.Board.Version, (await Board(h, id, map.Id))!.Version);
            var removed = await Command(h, id, new(Id(), moved.Board.Version, map.Id, "remove", a));
            Check.True(!removed.Board.Tokens.Single(t => t.Id == a).OnMap);
            var returned = await Command(h, id, new(Id(), removed.Board.Version, map.Id, "spawn", Spawns:
                [new(a, "creature", new("existing"), new("Ignored override"), .7, .7)]));
            Check.Equal(a, returned.Result.EntityIds.Single()); Check.Equal(7, returned.Board.Tokens.Single(t => t.Id == a).HitPoints);
            Check.Equal("Twin", returned.Board.Tokens.Single(t => t.Id == a).Name);
            var player = await Command(h, id, new(Id(), returned.Board.Version, map.Id, "spawn", Spawns:
                [new("", "creature", new("player", "player"), new("ignored"), .1, .1, "player")]));
            string playerId = player.Result.EntityIds.Single();
            var store = h.App.Services.GetRequiredService<CampaignStore>();
            // State owners update an existing character; token details must not cache a second HP copy.
            await store.Access(id, owner.AccessToken, true, c =>
            {
                c.Character = c.Character! with { HitPoints = c.Character.HitPoints - 2 }; c.Version++;
                c.Events.Add(new(Id(), c.Version, "fixture.damage", "isolated rule-owner update", "", "test", DateTimeOffset.UtcNow, null));
                return Task.FromResult(true);
            }, default);
            var detail = (await h.Http.GetFromJsonAsync<BoardTokenDetail>($"/api/v1/campaigns/{id}/board/tokens/{playerId}"))!;
            Check.Equal((await h.Get(id))!.Character!.HitPoints, detail.Statistics!.HitPoints);
            // Read-only board/detail requests do not create events or change the campaign bytes.
            string db = Directory.GetFiles(h.Root, "*.sqlite", SearchOption.AllDirectories).First(p => p.Contains(id));
            string hash = JsonFiles.Hash(File.ReadAllBytes(db));
            _ = await Board(h, id, map.Id); _ = await h.Http.GetStringAsync($"/api/v1/campaigns/{id}/board/tokens/{a}");
            Check.Equal(hash, JsonFiles.Hash(File.ReadAllBytes(db)));
            var guest = await HarnessBoundaryTests.Guest(h, owner with { Snapshot = (await h.Get(id))! });
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
            var publicBoard = (await Board(h, id, map.Id))!; Check.True(publicBoard.Tokens.All(t => t.Name != "SECRET_NPC"));
            Check.True(!publicBoard.Tokens.Single(t => t.Id == playerId).CanControl);
            Check.Equal(HttpStatusCode.NotFound, (await h.Http.GetAsync($"/api/v1/campaigns/{id}/board/tokens/{created.Result.EntityIds[2]}")).StatusCode);
            Check.Equal(HttpStatusCode.Forbidden, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/board/commands", new BoardCommandRequest(Id(), publicBoard.Version, map.Id, "move", a, Destination: new(.2, .2), ExpectedMapVersion: map.Version))).StatusCode);
            var gm = Install(h, id, "gm");
            Check.Equal(HttpStatusCode.NotFound, (await h.Http.GetAsync($"/api/v1/campaigns/{id}/maps/{gm.Id}/board")).StatusCode);
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, dice: dice);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            replay = await Command(h, id, request); Check.True(replay.Replayed); Check.Equal(4, replay.Board.Tokens.Length);
            Check.Equal(7, replay.Board.Tokens.Single(t => t.Id == a).HitPoints); Check.Equal(.7, replay.Board.Tokens.Single(t => t.Id == a).X);
            Check.Equal(0, dice.Count);
        }
        finally { await h.DisposeAsync(); }
    }

    public static async Task RealPiBatchRefreshAndRestart()
    {
        var imageHashes = new List<string>(); string mapId = ""; string[] ids = [];
        var model = new Model((call, request) =>
        {
            var progress = HarnessDmChecklistTests.AssertRequest(request);
            var frame = HarnessExecutionProtocolTests.Frame(request); var board = frame.GetProperty("board");
            Check.Equal(call == 1 ? 0 : call == 2 ? 1 : 2, progress.GetProperty("recordedSteps").GetArrayLength());
            Check.Equal("ready", board.GetProperty("status").GetString());
            var state = board.GetProperty("state"); var tokens = state.GetProperty("tokens");
            Check.Equal(0, state.GetProperty("recentOperations").GetArrayLength());
            Check.Equal(frame.GetProperty("version").GetInt32(), state.GetProperty("version").GetInt32());
            Check.Equal(1, request.Messages.Last().Images.Length);
            imageHashes.Add(JsonFiles.Hash(Convert.FromBase64String(request.Messages.Last().Images.Single().Base64)));
            Check.Equal(imageHashes.Last(), board.GetProperty("images")[0].GetProperty("hash").GetString());
            if (call == 1)
            {
                Check.Equal(0, tokens.GetArrayLength());
                return Tool("token_spawn", new { mapId, spawns = Enumerable.Range(0, 4).Select(i => new
                { existingId = "", kind = "creature", source = new { kind = "custom" }, appearance = new { name = "Batch " + i }, x = .2 + i * .15, y = .4 }).ToArray() });
            }
            Check.Equal(4, tokens.GetArrayLength());
            ids = tokens.EnumerateArray().Select(t => t.GetProperty("id").GetString()!).ToArray();
            Check.Equal(4, ids.Distinct().Count());
            if (call == 2) return Tool("token_move", new { mapId, entityId = ids[0], destination = new { x = .3, y = .7 } });
            if (call == 3)
            {
                Check.Equal(.3, tokens.EnumerateArray().Single(t => t.GetProperty("id").GetString() == ids[0]).GetProperty("x").GetDouble());
                Check.Equal("board.move", progress.GetProperty("recordedSteps")[1].GetProperty("result").GetProperty("kind").GetString());
                return Tool("token_read", new HarnessTokenArgs(ids[0]));
            }
            Check.Equal(4, call);
            var detail = JsonDocument.Parse(request.Messages.Last(m => m.Role == "tool").Content).RootElement;
            Check.Equal(ids[0], detail.GetProperty("id").GetString()); Check.True(!detail.GetProperty("hasStatistics").GetBoolean());
            return Tool("world_record", new NarrativeHarnessArgs("四个独立单位已摆放，其中一个已移动。", []));
        });
        var configure = Configure(model, extra: b =>
        {
            b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry();
            b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>();
        });
        var h = await Host.Start(configure: configure);
        try
        {
            var owner = await Create(h); string id = owner.Snapshot.Id; mapId = Install(h, id).Id;
            var input = new HarnessInputRequest(Id(), owner.Snapshot.Version, "在当前图放四个测试单位，再移动第一个并查看详情。");
            var run = await StartHistorical(h, id, input, 30);
            run = await Settled(h, id, run.Id, maximumPolls: 2400); Check.Equal("completed", run.Status); Check.Equal(4, model.Calls);
            Check.True(imageHashes[0] != imageHashes[1] && imageHashes[1] != imageHashes[2]); Check.Equal(imageHashes[2], imageHashes[3]);
            var board = (await Board(h, id, mapId))!; Check.Equal(4, board.Tokens.Length); Check.Equal(.3, board.Tokens.Single(t => t.Id == ids[0]).X);
            var activity = (await h.Http.GetFromJsonAsync<ActivityPage>($"/api/v1/campaigns/{id}/activity"))!;
            var entry = activity.Entries.Single(e => e.ActionId == run.IntentId);
            Check.Equal("intent.request", entry.Kind); Check.Equal("四个独立单位已摆放，其中一个已移动。", entry.Narrative);
            Check.True(entry.Steps!.Select(s => s.Result.Kind).SequenceEqual(new[] { "board.spawn", "board.move" }));
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, configure: configure);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var replay = await Post<HarnessRunView>(h, id, "harness/runs", input); Check.True(replay.Replayed); Check.Equal(4, model.Calls);
            Check.True((await Board(h, id, mapId))!.Tokens.Select(t => t.Id).SequenceEqual(ids));
            activity = (await h.Http.GetFromJsonAsync<ActivityPage>($"/api/v1/campaigns/{id}/activity"))!;
            var restored = activity.Entries.Single(e => e.ActionId == run.IntentId);
            Check.Equal(entry.Sequence, restored.Sequence); Check.Equal(entry.Narrative, restored.Narrative);
            Check.Equal(2, restored.Steps!.Length);
            var detail = (await h.Http.GetFromJsonAsync<ActivityEntry>($"/api/v1/campaigns/{id}/activity/{entry.Sequence}"))!;
            Check.Equal(entry.Narrative, detail.Narrative);
        }
        finally { await h.DisposeAsync(); }
    }

    private sealed class Wire(bool gemini) : HttpMessageHandler
    {
        public List<JsonElement> Bodies { get; } = [];
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            using var doc = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(ct)); Bodies.Add(doc.RootElement.Clone());
            string body = gemini ? """{"candidates":[{"content":{"role":"model","parts":[{"text":"ok"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2}}"""
                : """{"choices":[{"finish_reason":"stop","message":{"content":"ok"}}],"usage":{"prompt_tokens":10,"completion_tokens":2}}""";
            return new(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        }
    }
    public static async Task FrozenImagesReachBothProviders()
    {
        var noModel = new Model((_, _) => throw new Exception("No live model"));
        await using var h = await Host.Start(configure: Configure(noModel)); var owner = await Create(h); string id = owner.Snapshot.Id;
        var map = Install(h, id, png: MapPng(1600, 900)); _ = Install(h, id, "gm");
        var spawned = await Command(h, id, new(Id(), owner.Snapshot.Version, map.Id, "spawn", Spawns:
            [Custom("Visible", .25, .5) with { Appearance = new("Visible", IconKey: "goblin") }, Custom("SECRET_NPC", .8, .5, "gm")]));
        var sheet = (await h.Http.GetFromJsonAsync<CharacterSheetView>($"/api/v1/campaigns/{id}/character/sheet"))!;
        var gear = sheet.Equipment.First(e => e.Available);
        var equipped = await Post<ActionResponse>(h, id, "character/commands", new CharacterPlayRequest(Id(), spawned.Board.Version, "equip", gear.Id, gear.Equipped ? 0 : 1));
        var game = h.App.Services.GetRequiredService<GameService>();
        var frame = await game.ReadHarnessExecution(id, owner.AccessToken, "player", Id(), "查看当前棋盘", equipped.Snapshot.Version, default, 27, true);
        Check.Equal(!gear.Equipped, frame.Self!.Inventory.Single(i => i.Id == gear.Id).Equipped);
        Check.Equal(equipped.Snapshot.Character!.ArmorClass, frame.Self.ArmorClass);
        Check.Equal("ready", frame.Board!.Status); Check.Equal(2, frame.Board.Images.Length); Check.Equal(1, frame.Board.State!.Tokens.Length);
        Check.Equal(map.Id, frame.Board.State.Map.Id); Check.Equal(map.ContentHash, frame.Board.State.Map.ContentHash);
        Check.Equal(0, frame.Board.State.RecentOperations.Length);
        Check.True(!HarnessJson.Serialize(frame.Board).Contains("SECRET_NPC"));
        var request = new HarnessModelRequest(Preset.SystemPrompt, [new("user", HarnessJson.Serialize(new { input = "查看当前棋盘", ruleset = "dnd2024", memory = new { } }))], HarnessTools.ForVersion(27), 4096);
        request = HarnessExecutionProtocol.Project(request, frame, 27);
        Check.Equal(2, request.Messages.Last().Images.Length); Check.True(!request.Messages.Last().Content.Contains("base64"));
        Check.True(!HarnessJson.Serialize(request).Contains(frame.Board.Images[0].Base64));
        var frozen = HarnessJson.Serialize(frame);
        var noIcon = await Command(h, id, new(Id(), equipped.Snapshot.Version, map.Id, "update", spawned.Result.EntityIds[0], Appearance: new("Visible")));
        var noIconFrame = await game.ReadHarnessExecution(id, owner.AccessToken, "player", Id(), "查看当前棋盘", noIcon.Board.Version, default, 27, true);
        // The BG3 token art is local only (never published); without it the renderer draws the plain marker.
        if (File.Exists(Path.Combine(AppContext.BaseDirectory, "board-icons", "goblin.png")))
            Check.True(frame.Board.Images[0].Hash != noIconFrame.Board!.Images[0].Hash, "Registered BG3 appearance must change the actual screenshot");
        else Check.Equal(frame.Board.Images[0].Hash, noIconFrame.Board!.Images[0].Hash);
        var moved = await Command(h, id, new(Id(), noIcon.Board.Version, map.Id, "move", spawned.Result.EntityIds[0], Destination: new(.6, .5)));
        Check.Equal(frozen, HarnessJson.Serialize(frame));
        var newer = await game.ReadHarnessExecution(id, owner.AccessToken, "player", Id(), "查看当前棋盘", moved.Board.Version, default, 27, true);
        Check.Equal(moved.Board.Version, newer.Board!.Version); Check.Equal(.6, newer.Board.State!.Tokens.Single().X);
        Check.True(frame.Board.Images[0].Hash != newer.Board.Images[0].Hash);
        foreach (bool gemini in new[] { false, true })
        {
            var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["DataPath"] = Path.Combine(Path.GetTempPath(), "board-image-provider-" + Id()), ["HarnessAi:RetryCount"] = "0",
                ["HarnessAi:BaseUrl"] = "http://127.0.0.1:1/", ["HarnessAi:Endpoint"] = gemini ? "gemini" : "openai-chat",
                ["HarnessAi:ApiKey"] = "fake-not-live", ["HarnessAi:Model"] = "fake-vision"
            }).Build();
            using var data = new DataDirectory(config); var budget = new ProviderBudget(data, config);
            using var wire = new Wire(gemini); using var http = new HttpClient(wire);
            IHarnessModel model = gemini ? new GeminiHarnessModel(http, config, budget) : new OpenAiHarnessModel(http, config, budget);
            await model.Complete(request, id, default); var body = wire.Bodies.Single();
            JsonElement parts = gemini ? body.GetProperty("contents").EnumerateArray().Last().GetProperty("parts") : body.GetProperty("messages").EnumerateArray().Last().GetProperty("content");
            Check.Equal(3, parts.GetArrayLength());
            for (int i = 0; i < 2; i++)
            {
                string encoded = gemini ? parts[i + 1].GetProperty("inlineData").GetProperty("data").GetString()! : parts[i + 1].GetProperty("image_url").GetProperty("url").GetString()!.Split(',')[1];
                var bytes = Convert.FromBase64String(encoded); Check.Equal(frame.Board.Images[i].Hash, JsonFiles.Hash(bytes));
                using var decoded = SKBitmap.Decode(bytes); Check.Equal(frame.Board.Images[i].Width, decoded.Width);
            }
            var bad = request with { Messages = [new("assistant", "bad") { Images = [new("image/jpeg", frame.Board.Images[0].Base64)] }] };
            bool rejected = false;
            try { await model.Complete(bad, id, default); } catch (HarnessModelNotSentException ex) { rejected = ex.Code == "harness_model_contract"; }
            Check.True(rejected); Check.Equal(1, wire.Bodies.Count);
            Check.Equal(1, budget.Read("text", id, true).Total);
            var largeText = request with { System = new string('x', 131073) };
            rejected = false;
            try { await model.Complete(largeText, id, default); } catch (HarnessModelNotSentException ex) { rejected = ex.Code == "harness_context_limit"; }
            Check.True(rejected); Check.Equal(1, wire.Bodies.Count); // Images cannot exempt arbitrary text from its existing bound.
        }
        Check.Equal(0, noModel.Calls);
    }
}
