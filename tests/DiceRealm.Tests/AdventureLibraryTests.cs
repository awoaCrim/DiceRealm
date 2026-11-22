using System.Net;
using System.Net.Http.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class AdventureLibraryTests
{
    public static async Task BrowserFixture(string statePath, string libraryRoot)
    {
        statePath = Path.GetFullPath(statePath);
        if (File.Exists(statePath) || File.Exists(statePath + ".stop")) throw new InvalidOperationException("Use a fresh fixture path");
        var model = new Model((_, _) => throw new Exception("No provider calls in library UI acceptance"));
        await using var h = await Host.Start(configure: Configure(model, extra: b => b.Configuration["AdventureLibrary:Directory"] = Path.GetFullPath(libraryRoot)));
        AccountTests.SeedAdminFixture(h);
        JsonFiles.Write(statePath, new { origin = h.Http.BaseAddress!.GetLeftPart(UriPartial.Authority), dataPath = h.Root, processId = Environment.ProcessId });
        while (!File.Exists(statePath + ".stop")) await Task.Delay(250);
        JsonFiles.Write(statePath + ".result", new { modelCalls = model.Calls });
        Check.Equal(0, model.Calls);
    }

    public static async Task OpeningLibraryAcceptance(string libraryRoot)
    {
        var model = new Model((_, _) => throw new Exception("Opening package acceptance must not call a provider"));
        await using var h = await Host.Start(configure: Configure(model, extra: b => b.Configuration["AdventureLibrary:Directory"] = Path.GetFullPath(libraryRoot)));
        var library = h.App.Services.GetRequiredService<AdventureLibrary>();
        var entries = library.List(); Check.Equal(2, entries.Length);
        foreach (var entry in entries)
        {
            var loaded = library.Load(entry.Id, entry.Hash, images: true);
            Check.True(loaded.Adventure.Opening is not null);
            var room = h.App.Services.GetRequiredService<GameService>().CreateRoom(new("未接主线的候选开局验收"));
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", room.AccessToken);
            var request = new ActivateLibraryRequest(Id(), room.Snapshot.Version, entry.Id, entry.Hash);
            var result = await Post<ActionResponse>(h, room.Snapshot.Id, "content/library/activate", request);
            Check.Equal(entry.Id == "lmop" ? "stonehill" : "waystation", result.Snapshot.Scene.Id);
            Check.Equal(result.Snapshot.Scene.Id, result.Snapshot.Opening!.SceneId);
            Check.Equal(0, result.Snapshot.Opening.PublicSequence);
            Check.True(result.Snapshot.Character is null && !result.Snapshot.Content!.InitialSetup);
            Check.True(!result.Snapshot.Facts.Contains("gundren-search-accepted"));
            var catalog = h.App.Services.GetRequiredService<MapCatalog>();
            var maps = catalog.List(room.Snapshot.Id, true, true).Maps;
            Check.Equal(loaded.Maps.Length, maps.Length);
            Check.True(maps.All(m => m.Attempts == 0 && m.Status == "ready"));
            Check.True(maps.Where(m => m.Edition == "gm").All(m => !m.Published));
            if (entry.Id == "lmop")
            {
                Check.Equal(14, maps.Length); Check.Equal(7, catalog.List(room.Snapshot.Id, false, false).Maps.Length);
                Check.True(!loaded.Adventure.SourceText.Contains("角色此前已接受贡德伦的运货约定"));
                Check.True(loaded.Adventure.Quests.Any(q => q.Id == "find-gundren"));
                // The candidate's actual authored chain still requires an explicit choice.
                var player = await Create(h, loaded.Adventure);
                var game = h.App.Services.GetRequiredService<GameService>();
                var auth = await game.AuthorizeHarness(player.Snapshot.Id, player.AccessToken, default);
                await game.HarnessTool(player.Snapshot.Id, player.AccessToken, auth.ActorId, Id(), HarnessOpenings.Input,
                    auth.Version, Id(), Id(), new("opening_commit", HarnessJson.Element(new OpeningNarrativeArgs("旅店老板正在接待来客。", "")), "fixture"),
                    [], default, auth.Profile, 38, contextAlreadyRead: true, opening: true);
                var current = (await h.Get(player.Snapshot.Id))!;
                current = (await h.Act(current, "travel", "phandalin")).Snapshot;
                current = (await h.Act(current, "travel", "barthen")).Snapshot;
                current = (await h.Act(current, "talk", "ask-barthen")).Snapshot;
                Check.True(current.Facts.Contains("barthen-met") && !current.Facts.Contains("gundren-search-accepted"));
                current = (await h.Act(current, "talk", "accept-gundren-search")).Snapshot;
                Check.True(current.Facts.Contains("gundren-search-accepted") && !current.Facts.Contains("gundren-rescued"));
                h.Http.DefaultRequestHeaders.Authorization = new("Bearer", room.AccessToken);
            }
            Check.True((await Post<ActionResponse>(h, room.Snapshot.Id, "content/library/activate", request)).Replayed);
            Check.Equal(maps.Length, catalog.List(room.Snapshot.Id, true, true).Maps.Length);
            Console.WriteLine($"Opening candidate {entry.Id}: scene={result.Snapshot.Scene.Id}, maps={maps.Length}, activation/replay OK");
        }
        Check.Equal(0, model.Calls);
    }

    public static async Task LocalLibraryAcceptance(string libraryRoot)
    {
        var model = new Model((_, _) => throw new Exception("Local package acceptance must not call a provider"));
        await using var h = await Host.Start(configure: Configure(model, extra: b => b.Configuration["AdventureLibrary:Directory"] = Path.GetFullPath(libraryRoot)));
        var library = h.App.Services.GetRequiredService<AdventureLibrary>();
        var entries = library.List(); Check.Equal(3, entries.Length);
        foreach (var entry in entries)
        {
            var loaded = library.Load(entry.Id, entry.Hash, images: true);
            Check.True(loaded.Adventure.Scenes.Length > 0);
            if (entry.Id != "lmop") continue;
            Check.Equal(21, entry.SceneCount); Check.Equal(14, entry.MapCount);
            Check.True(loaded.Adventure.InitialKnowledge!.All(k => k.Visibility == "host"));
            Check.True(loaded.Adventure.Scenes.Where(s => s.Id is "agatha" or "old-owl" or "wyvern-tor")
                .All(s => loaded.Maps.All(m => !m.SceneIds.Contains(s.Id))));
            var room = h.App.Services.GetRequiredService<GameService>().CreateRoom(new("本地原图剧本验收"));
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", room.AccessToken);
            var request = new ActivateLibraryRequest(Id(), room.Snapshot.Version, entry.Id, entry.Hash);
            var timer = System.Diagnostics.Stopwatch.StartNew();
            var result = await Post<ActionResponse>(h, room.Snapshot.Id, "content/library/activate", request);
            Check.Equal("triboar-road", result.Snapshot.Scene.Id);
            Check.Equal(room.Snapshot.Version + 1, result.Snapshot.Version);
            Check.True(!result.Snapshot.Content!.InitialSetup && result.Snapshot.Character is null);
            var catalog = h.App.Services.GetRequiredService<MapCatalog>();
            var all = catalog.List(room.Snapshot.Id, true, true).Maps;
            Check.Equal(14, all.Length); Check.True(all.All(m => m.Status == "ready" && m.Attempts == 0));
            var players = catalog.List(room.Snapshot.Id, false, false).Maps;
            Check.Equal(7, players.Length); Check.True(players.All(m => m.Edition == "player" && m.Specification is null));
            Check.True(all.Where(m => m.Edition == "gm").All(m => !m.Published));
            Check.True((await Post<ActionResponse>(h, room.Snapshot.Id, "content/library/activate", request)).Replayed);
            Check.Equal(14, catalog.List(room.Snapshot.Id, true, true).Maps.Length);
            Console.WriteLine($"Local library: 3 packages, 21 scenes, 14 originals, 7 public; activation+replay {timer.Elapsed.TotalSeconds:F1}s; provider calls {model.Calls}");
        }
        Check.Equal(0, model.Calls);
    }

    public static async Task AdoptionAuthorityAndRestart()
    {
        var model = new Model((_, _) => throw new Exception("Library adoption must not call a model"));
        string libraryRoot = Path.Combine(Path.GetTempPath(), "dicerealm-library-" + Id());
        Directory.CreateDirectory(libraryRoot);
        foreach (var folder in Directory.EnumerateDirectories(Path.Combine(AppContext.BaseDirectory, "adventures")))
        {
            var target = Path.Combine(libraryRoot, Path.GetFileName(folder)); Directory.CreateDirectory(target);
            foreach (string file in Directory.EnumerateFiles(folder)) File.Copy(file, Path.Combine(target, Path.GetFileName(file)));
        }
        var configure = Configure(model, extra: b => b.Configuration["AdventureLibrary:Directory"] = libraryRoot);
        var h = await Host.Start(configure: configure);
        try
        {
            var game = h.App.Services.GetRequiredService<GameService>();
            var room = game.CreateRoom(new("剧本库测试")); var id = room.Snapshot.Id;
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", room.AccessToken);
            string path = $"/api/v1/campaigns/{id}/content/library";
            byte[] before = File.ReadAllBytes(Path.Combine(h.Root, "campaigns", id + ".sqlite"));
            var library = (await h.Http.GetFromJsonAsync<AdventureLibraryView>(path))!;
            Check.True(library.CanActivate);
            Check.True(library.Adventures.Any(e => e.Id == "rainbridge"));
            Check.True(library.Adventures.All(e => e.Id != "lighthouse"));
            Check.True(before.SequenceEqual(File.ReadAllBytes(Path.Combine(h.Root, "campaigns", id + ".sqlite"))));
            Check.True(room.Snapshot.Content!.InitialSetup && room.Snapshot.Character is null);
            foreach (var entry in library.Adventures)
                h.App.Services.GetRequiredService<AdventureLibrary>().Load(entry.Id, entry.Hash, images: true);
            var selected = library.Adventures.Single(e => e.Id == "rainbridge");
            var request = new ActivateLibraryRequest(Id(), room.Snapshot.Version, selected.Id, selected.Hash);
            Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync(path + "/activate", request with { Hash = new string('a', 64) })).StatusCode);
            Check.Equal(room.Snapshot.Version, (await h.Get(id))!.Version);
            var replies = await Task.WhenAll(Enumerable.Range(0, 2).Select(_ => h.Http.PostAsJsonAsync(path + "/activate", request)));
            foreach (var reply in replies) Check.Equal(HttpStatusCode.OK, reply.StatusCode);
            var results = await Task.WhenAll(replies.Select(r => r.Content.ReadFromJsonAsync<ActionResponse>()));
            Check.Equal(1, results.Count(r => r!.Replayed));
            var activated = results[0]!.Snapshot; Check.Equal(room.Snapshot.Version + 1, activated.Version);
            Check.Equal("waystation", activated.Scene.Id); Check.True(activated.Character is null);
            Check.Equal("rainbridge-messenger", activated.Content!.Adventure!.Id); Check.True(!activated.Content.InitialSetup);
            Check.True(!(await h.Http.GetFromJsonAsync<AdventureLibraryView>(path))!.CanActivate);
            Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync(path + "/activate", request with { RequestId = Id(), ExpectedVersion = activated.Version })).StatusCode);
            var guest = await HarnessBoundaryTests.Guest(h, room with { Snapshot = activated });
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
            Check.Equal(HttpStatusCode.Forbidden, (await h.Http.GetAsync(path)).StatusCode);
            Check.Equal(HttpStatusCode.Forbidden, (await h.Http.PostAsJsonAsync(path + "/activate", request)).StatusCode);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", room.AccessToken);
            int version = (await h.Get(id))!.Version;
            // Completed receipt is independent of installation files and the current room version.
            Directory.Move(Path.Combine(libraryRoot, "rainbridge"), Path.Combine(libraryRoot, "rainbridge-disabled"));
            Check.True((await Post<ActionResponse>(h, id, "content/library/activate", request)).Replayed);
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, configure: configure);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", room.AccessToken);
            Check.True((await Post<ActionResponse>(h, id, "content/library/activate", request)).Replayed);
            Check.Equal(version, (await h.Get(id))!.Version); Check.Equal(0, model.Calls);
        }
        finally { await h.DisposeAsync(); }
    }

    private sealed class Images : IMapImageGenerator
    {
        public bool Enabled => true;
        public string CacheIdentity => "library-map-provenance-test";
        public Task<byte[]> Generate(MapGenerationJob job, CancellationToken ct) => Task.FromResult(AssetTests.Png);
    }
    public static async Task MapPackageValidationAndRecovery()
    {
        string libraryRoot = Path.Combine(Path.GetTempPath(), "dicerealm-map-package-" + Id());
        string folder = Path.Combine(libraryRoot, "mapped"); Directory.CreateDirectory(folder);
        var adventure = TestContent.Document with { Id = "mapped", Name = "隔离地图剧本", Version = "1.0.0" };
        JsonFiles.Write(Path.Combine(folder, "adventure.json"), adventure);
        File.WriteAllText(Path.Combine(folder, "prompt.md"), "隔离测试原样提示词，不调用供应商。");
        var definitions = new[] { "gm", "player" }.Select(edition => new AdventureLibraryMap(edition + ".png", JsonFiles.Hash(AssetTests.Png),
            ImportedMapTests.Spec(edition, edition == "player" ? "PUBLIC_STYLE" : "PRIVATE_STYLE"), ["harbor"])).ToArray();
        var manifest = new AdventureLibraryManifest(1, "mapped", adventure.Name, adventure.Version, "地图隔离回归", "1级", "回归", "测试原创资料", "隔离测试专用", definitions);
        JsonFiles.Write(Path.Combine(folder, "package.json"), manifest);
        foreach (var map in definitions) File.WriteAllBytes(Path.Combine(folder, map.File), AssetTests.Png);
        var model = new Model((_, _) => throw new Exception("No model calls"));
        var configure = Configure(model, extra: b => b.Configuration["AdventureLibrary:Directory"] = libraryRoot);
        await using var h = await Host.Start(images: new Images(), configure: configure);
        var room = h.App.Services.GetRequiredService<GameService>().CreateRoom(new("地图包"));
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", room.AccessToken);
        var library = h.App.Services.GetRequiredService<AdventureLibrary>(); var entry = library.List().Single();
        var request = new ActivateLibraryRequest(Id(), room.Snapshot.Version, entry.Id, entry.Hash);
        string route = $"/api/v1/campaigns/{room.Snapshot.Id}/content/library/activate";
        File.WriteAllBytes(Path.Combine(folder, "player.png"), AssetTests.Png[..33]);
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync(route, request)).StatusCode);
        Check.Equal(room.Snapshot.Version, (await h.Get(room.Snapshot.Id))!.Version);
        var maps = h.App.Services.GetRequiredService<MapCatalog>();
        Check.Equal(0, maps.List(room.Snapshot.Id, true, true).Maps.Length);
        File.WriteAllBytes(Path.Combine(folder, "player.png"), AssetTests.Png);
        // Simulate interruption after map commits but before the game receipt, then damaged
        // cached pixels. Stage replay returns failed views and must not confirm installation.
        foreach (var definition in definitions)
        {
            string Stage(string phase) => new Guid(JsonFiles.Hash("library:" + room.Snapshot.Id + ":" + entry.Hash + ":" + definition.File + ":" + phase)[..32]).ToString();
            string mapId = Stage("create");
            maps.Create(room.Snapshot.Id, new(mapId, definition.Specification));
            maps.Import(room.Snapshot.Id, mapId, new(Stage("import"), 1), AssetTests.Png);
            maps.ConfigureScenes(room.Snapshot.Id, mapId, new(Stage("scenes"), 2, definition.SceneIds), ["harbor"]);
            if (definition.Specification.Edition == "player") maps.Publish(room.Snapshot.Id, mapId, new(Stage("publish"), 3, true, true));
        }
        string imagePath = Path.Combine(h.Root, "map-images", JsonFiles.Hash(AssetTests.Png) + ".png");
        File.WriteAllBytes(imagePath, AssetTests.Png[..33]);
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync(route, request)).StatusCode);
        Check.Equal(room.Snapshot.Version, (await h.Get(room.Snapshot.Id))!.Version);
        File.WriteAllBytes(imagePath, AssetTests.Png);
        var accepted = await h.Http.PostAsJsonAsync(route, request); Check.Equal(HttpStatusCode.OK, accepted.StatusCode);
        var result = (await accepted.Content.ReadFromJsonAsync<ActionResponse>())!;
        Check.Equal(2, maps.List(room.Snapshot.Id, true, true).Maps.Length);
        var publicMaps = maps.List(room.Snapshot.Id, false, false).Maps;
        Check.Equal(1, publicMaps.Length); Check.Equal("player", publicMaps[0].Edition);
        Check.True(publicMaps[0].Specification is null && publicMaps[0].ImportSource!.VisualStyle == "PUBLIC_STYLE");
        Check.True(maps.List(room.Snapshot.Id, true, true).Maps.All(m => m.Attempts == 0 && m.Status == "ready" && m.SceneIds!.Contains("harbor")));
        Check.True((await Post<ActionResponse>(h, room.Snapshot.Id, "content/library/activate", request)).Replayed);
        Check.Equal(result.Snapshot.Version, (await h.Get(room.Snapshot.Id))!.Version); Check.Equal(0, model.Calls);
        // Old interrupted installs retained their original spec/receipts and have no LibrarySource.
        // A broken unrelated package cannot disable optional appearance references or generation.
        Directory.CreateDirectory(Path.Combine(libraryRoot, "broken-unrelated"));
        var binding = result.Snapshot.Content!.Adventure!;
        var basis = new MapGenerationBasis(new(binding.Id, binding.Version, binding.Hash), "beacon", result.Snapshot.Version, "公开地点", "公开空间", [], []);
        var spec = AssetTests.Spec() with { Grid = new() { Uncalibrated = true }, GenerationBasis = basis };
        var originalPath = Path.Combine(h.Root, "maps", room.Snapshot.Id, publicMaps[0].Id + ".json");
        var originalBytes = File.ReadAllBytes(originalPath);
        var generated = AutomaticMapTests.CatalogCall<AutomaticMapResponse>(maps, "RequestAutomatic", room.Snapshot.Id, "beacon", result.Snapshot.Version, PartyEngine.HostId, Id(), Id(), spec, library);
        var frozen = maps.Get(room.Snapshot.Id, generated.Map.Id, true).Specification!.StyleReference!;
        Check.Equal(publicMaps[0].Id, frozen.MapId); Check.Equal(publicMaps[0].ContentHash, frozen.Snapshot!.ContentHash);
        Check.Equal(binding.Hash, frozen.Snapshot.Adventure.Hash); Check.Equal("description", frozen.Snapshot.ReferenceMode);
        Check.True(originalBytes.SequenceEqual(File.ReadAllBytes(originalPath)));
    }
}
