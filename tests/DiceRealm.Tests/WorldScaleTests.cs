using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class WorldScaleTests
{
    private const string Token = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private static WorldMemoryEntry Entry(int i) => new("large-" + i.ToString("D5"), i % 2 == 0 ? "clue" : "npc",
        "远地 CopperKey " + i, "旅人留下海灯尾注，口令不是通行许可。序号 " + i, "known", i % 3 == 0 ? "harbor" : "", 1, 0, 1, "player", "fixture");
    private static Campaign Fixture(int count)
    {
        var c = TestContent.Campaign("harbor", "Large world fixture", tokenHash: Token);
        c.Events.Add(new(Id(), 1, "arrival", "隔离夹具", "", "fixture", DateTimeOffset.UtcNow, null));
        c.WorldMemory.AddRange(Enumerable.Range(0, count).Select(Entry)); return c;
    }
    private static object? Sql(string root, string id, string sql)
    {
        using var db = new SqliteConnection($"Data Source={Path.Combine(root, "campaigns", id + ".sqlite")};Pooling=False");
        db.Open(); using var cmd = db.CreateCommand(); cmd.CommandText = sql; return cmd.ExecuteScalar();
    }
    private static void Error(string code, Action action)
    {
        try { action(); } catch (GameException e) { Check.Equal(code, e.Code); return; }
        throw new Exception("Expected " + code);
    }
    private static async Task Reject(Func<Task> action)
    {
        try { await action(); } catch (SqliteException) { return; }
        throw new Exception("Expected injected SQLite rollback");
    }
    private static void Advance(Campaign c)
    {
        c.Version++; c.Events.Add(new(Id(), c.Version, "fixture", "隔离状态", "", "fixture", DateTimeOffset.UtcNow, null));
    }
    public static async Task LargeIndexedWorldAndPaging()
    {
        await using var h = await Host.Start(); var store = h.App.Services.GetRequiredService<CampaignStore>();
        var c = Fixture(WorldMemories.MaximumEntries);
        c.WorldMemory[0] = c.WorldMemory[0] with { Visibility = "host", Name = "HOST-SENTINEL" };
        c.WorldMemory[1] = c.WorldMemory[1] with { Hidden = true, Name = "HIDDEN-SENTINEL" };
        c.WorldMemory[2] = c.WorldMemory[2] with { Visibility = "arrival", RevealSceneId = "beacon", Name = "FUTURE-SENTINEL" };
        store.Create(c); h.Http.DefaultRequestHeaders.Authorization = new("Bearer", Token);
        Check.Equal(2L, (long)Sql(h.Root, c.Id, "PRAGMA user_version")!);
        var json = (string)Sql(h.Root, c.Id, "SELECT json FROM state")!;
        using (var state = JsonDocument.Parse(json))
        {
            Check.True(!state.RootElement.TryGetProperty("worldMemory", out _));
            Check.Equal(1, state.RootElement.GetProperty("worldMemoryStorageVersion").GetInt32());
        }
        Check.True(json.Length < 150000, "cold knowledge must not inflate the state document");
        var s = (await h.Get(c.Id))!; Check.Equal(256, s.WorldMemory!.Length);
        Check.Equal(8192, s.WorldMemoryPaging!.Total); Check.Equal(256, s.WorldMemoryPaging.NextOffset!.Value);
        await store.Access(c.Id, Token, false, loaded =>
        {
            Check.Equal(0, loaded.WorldMemory.Count); var index = (SqliteWorldMemory)loaded.WorldMemoryIndex!;
            var page = WorldMemories.Read(loaded, ["COPPERKEY", "海灯尾注"], offset: 4096, limit: 6);
            Check.Equal(6, page.Entries.Length); Check.Equal(8189, page.Total); Check.Equal(6, index.LoadedEntries);
            Check.Equal(0, WorldMemories.Read(loaded, ["SENTINEL"]).Entries.Length);
            Check.Equal(1, WorldMemories.Read(loaded, ["远地 CopperKey 8188"], limit: 1).Entries.Length);
            Check.Equal(32, AdventureDirecting.Build(loaded, IntentContexts.Build(loaded, "观察世界", [], [])).KnownMemory.Length);
            Check.True(index.LoadedEntries < 45, "search/context must not hydrate 8192 bodies");
            Error("world_memory_capacity", () => WorldMemories.Plan(loaded, [new("", "clue", "不能越界", "新内容", "known", "")], new HashSet<string>(), new HashSet<string>(), 1, "fixture"));
            var ids = new HashSet<string>(); int offset = 0;
            while (true)
            {
                var part = WorldMemories.Read(loaded, offset: offset, limit: 32, localFirst: false);
                foreach (var e in part.Entries) Check.True(ids.Add(e.Id), "stable pages must not repeat an id");
                if (part.NextOffset is not int next) break;
                offset = next;
            }
            Check.Equal(8189, ids.Count); loaded.VisitedScenes.Add("beacon");
            Check.Equal(1, WorldMemories.Read(loaded, ["FUTURE-SENTINEL"]).Entries.Length);
            return Task.FromResult(true);
        });
        string endpoint = $"/api/v1/campaigns/{c.Id}/world/memory?expectedVersion=1";
        var publicPage = (await h.Http.GetFromJsonAsync<WorldMemoryPage>(endpoint + "&offset=4096&limit=32"))!;
        Check.Equal(8189, publicPage.Total); Check.Equal(32, publicPage.Entries.Length);
        var hostPage = (await h.Http.GetFromJsonAsync<WorldMemoryPage>(endpoint + "&query=SENTINEL&scope=host"))!;
        Check.Equal(3, hostPage.Total); Check.Equal(3, hostPage.Entries.Length);
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.GetAsync(endpoint.Replace("expectedVersion=1", "expectedVersion=2"))).StatusCode);
        Check.Equal(HttpStatusCode.BadRequest, (await h.Http.GetAsync(endpoint + "&limit=33")).StatusCode);
        using var db = new SqliteConnection($"Data Source={Path.Combine(h.Root, "campaigns", c.Id + ".sqlite")};Pooling=False");
        db.Open(); using var command = db.CreateCommand(); command.CommandText = "EXPLAIN QUERY PLAN SELECT entryId FROM world_terms WHERE token='u0041'";
        using var rows = command.ExecuteReader(); Check.True(rows.Read()); Check.True(rows.GetString(3).Contains("PRIMARY KEY"), "token posting must use its index");
        Console.WriteLine("WORLD SCALE: 8192 authoritative rows; bounded snapshot 256/context 32/search 6; 8189 public IDs paged exactly once; indexed Chinese/ASCII substring queries.");
    }

    public static async Task MigrationBackupRollbackAndReplay()
    {
        var h = await Host.Start();
        try
        {
            var c = Fixture(20); string id = c.Id, originalPath = Path.Combine(h.Root, "campaigns", id + ".json");
            JsonFiles.Write(originalPath, c); byte[] original = File.ReadAllBytes(originalPath);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", "wrong");
            Check.Equal(HttpStatusCode.Unauthorized, (await h.Http.GetAsync($"/api/v1/campaigns/{id}")).StatusCode);
            Check.True(!File.Exists(Path.ChangeExtension(originalPath, ".sqlite")));
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", Token); await h.Get(id);
            Check.Equal(1L, (long)Sql(h.Root, id, "PRAGMA user_version")!);
            string database = Path.ChangeExtension(originalPath, ".sqlite"); byte[] beforeRead = File.ReadAllBytes(database);
            await h.Http.GetFromJsonAsync<WorldMemoryPage>($"/api/v1/campaigns/{id}/world/memory?expectedVersion=1");
            Check.True(beforeRead.SequenceEqual(File.ReadAllBytes(database)), "GET must not migrate or rebuild");
            Sql(h.Root, id, "CREATE TRIGGER fail_new_event BEFORE INSERT ON events WHEN NEW.sequence>1 BEGIN SELECT RAISE(ABORT,'fixture'); END;");
            byte[] before = File.ReadAllBytes(database);
            var request = new CorrectWorldMemoryRequest(Id(), 1, "large-00000", 1, "迁移后海灯", "已核对的新消息", "active", false, "隔离纠错测试");
            var store = h.App.Services.GetRequiredService<CampaignStore>();
            await Reject(() => store.Access(id, Token, true, loaded =>
            {
                WorldMemories.Correct(loaded, request); Advance(loaded); return Task.FromResult(true);
            }));
            Check.Equal(1L, (long)Sql(h.Root, id, "PRAGMA user_version")!);
            Check.Equal(0L, (long)Sql(h.Root, id, "SELECT COUNT(*) FROM sqlite_master WHERE name='world_entries'")!);
            Check.True(before.SequenceEqual(File.ReadAllBytes(database)), "failed migration must preserve exact original database");
            string[] backups = Directory.GetFiles(Path.GetDirectoryName(database)!, id + ".sqlite.pre-world-v2.*.bak");
            Check.Equal(1, backups.Length); Check.True(before.SequenceEqual(File.ReadAllBytes(backups[0])));
            Sql(h.Root, id, "DROP TRIGGER fail_new_event");
            var result = await Post<ActionResponse>(h, id, "world/correct", request); Check.Equal(2, result.Snapshot.Version);
            Check.Equal(2L, (long)Sql(h.Root, id, "PRAGMA user_version")!);
            Check.Equal(20L, (long)Sql(h.Root, id, "SELECT COUNT(*) FROM world_entries")!);
            Check.True(original.SequenceEqual(File.ReadAllBytes(originalPath)));
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root); h.Http.DefaultRequestHeaders.Authorization = new("Bearer", Token);
            var replay = await Post<ActionResponse>(h, id, "world/correct", request);
            Check.True(replay.Replayed); Check.Equal(HarnessJson.Serialize(result.Resolution), HarnessJson.Serialize(replay.Resolution));
            Check.Equal(2, replay.Snapshot.Version); Check.Equal(2L, (long)Sql(root, id, "SELECT COUNT(*) FROM events")!);
        }
        finally { await h.DisposeAsync(); }
    }
    public static async Task OverlayAndAtomicReceipts()
    {
        await using var h = await Host.Start(); var store = h.App.Services.GetRequiredService<CampaignStore>();
        var c = Fixture(600); c.WorldMemory[599] = c.WorldMemory[599] with { Hidden = true, Name = "隐藏名称" };
        store.Create(c); h.Http.DefaultRequestHeaders.Authorization = new("Bearer", Token);
        string id = c.Id; var request = new CorrectWorldMemoryRequest(Id(), 1, "large-00598", 1, "新港灯塔", "别名 SUNRISE 与海灯尾注", "active", false, "确认变更");
        await store.Access(id, Token, true, loaded =>
        {
            WorldMemories.Correct(loaded, request);
            Check.Equal(0, WorldMemories.Read(loaded, ["CopperKey 598"]).Total);
            var pending = WorldMemories.Read(loaded, ["sunrise"]); Check.Equal("large-00598", pending.Entries.Single().Id);
            Check.Equal(600, WorldMemoryIndex.For(loaded).Count);
            Error("invalid_world_memory", () => WorldMemories.Plan(loaded, [new("", "npc", "隐藏名称", "不应泄露既有记录", "known", "")], new HashSet<string>(), new HashSet<string>(), 1, "fixture"));
            Advance(loaded); loaded.Receipts.Add(new(request.RequestId, "fixture", new("resolved", "fixture", "saved", null, []))); return Task.FromResult(true);
        });
        string database = Path.Combine(h.Root, "campaigns", id + ".sqlite"); byte[] before = File.ReadAllBytes(database);
        await Reject(() => store.Access(id, Token, true, loaded =>
        {
            var current = WorldMemories.Find(loaded, "large-00598")!;
            WorldMemories.Apply(loaded, [current with { Summary = "必须回滚的词项", Revision = 3, UpdatedSequence = 3 }]);
            Advance(loaded); loaded.Receipts.Add(new(request.RequestId, "duplicate", new("resolved", "fixture", "bad", null, [])));
            return Task.FromResult(true);
        }));
        Check.True(before.SequenceEqual(File.ReadAllBytes(database)));
        await store.Access(id, Token, false, loaded =>
        {
            Check.Equal(2, loaded.Version); Check.Equal(1, WorldMemories.Read(loaded, ["SUNRISE"]).Total);
            Check.Equal(0, WorldMemories.Read(loaded, ["必须回滚"]).Total); Check.Equal(2, WorldMemories.Find(loaded, "large-00598")!.Revision);
            Check.Equal(599, WorldMemories.Read(loaded, limit: 0).Total); return Task.FromResult(true);
        });
        // Different requests racing for the same version cannot both rename the record.
        var first = request with { RequestId = Id(), ExpectedVersion = 2, Revision = 2, Name = "确认第一份", Hidden = true };
        var second = first with { RequestId = Id(), Name = "确认第二份" };
        var results = await Task.WhenAll(h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/world/correct", first), h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/world/correct", second));
        Check.Equal(1, results.Count(r => r.IsSuccessStatusCode)); Check.Equal(1, results.Count(r => r.StatusCode == HttpStatusCode.Conflict));
        var page = (await h.Http.GetFromJsonAsync<WorldMemoryPage>($"/api/v1/campaigns/{id}/world/memory?expectedVersion=3&query=SUNRISE"))!;
        Check.Equal(0, page.Total); Check.Equal(3L, (long)Sql(h.Root, id, "SELECT COUNT(*) FROM events")!);
    }

    public static async Task CorruptionAuthorizationAndFrozenContract()
    {
        Check.Equal("19c7c6a424fccd2f2ad2a84ec6d38db16a4c7579aaf0347dd2e1352936e4398f", HarnessJson.Fingerprint(HarnessJson.Element(HarnessTools.ForVersion(6))));
        Check.True(HarnessTools.Supports(7));
        Check.Equal(256, HarnessTools.ForVersion(6).Single(t => t.Name == "world_search").InputSchema.GetProperty("properties").GetProperty("offset").GetProperty("maximum").GetInt32());
        Check.Equal(8192, HarnessTools.ForVersion(7).Single(t => t.Name == "world_search").InputSchema.GetProperty("properties").GetProperty("offset").GetProperty("maximum").GetInt32());
        var c = Fixture(600);
        Error("harness_invalid_payload", () => HarnessWorldSearch.Search(c, new("", Offset: 257), 6));
        Check.Equal(6, HarnessWorldSearch.Search(c, new("", Offset: 300), 7).Entries.Length);
        await using var h = await Host.Start(); h.App.Services.GetRequiredService<CampaignStore>().Create(c);
        Sql(h.Root, c.Id, "DROP TABLE world_terms");
        string file = Path.Combine(h.Root, "campaigns", c.Id + ".sqlite"); byte[] before = File.ReadAllBytes(file);
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", "wrong");
        Check.Equal(HttpStatusCode.Unauthorized, (await h.Http.GetAsync($"/api/v1/campaigns/{c.Id}")).StatusCode);
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", Token);
        var result = await h.Http.GetAsync($"/api/v1/campaigns/{c.Id}"); Check.Equal(HttpStatusCode.Conflict, result.StatusCode);
        using var error = JsonDocument.Parse(await result.Content.ReadAsStringAsync()); Check.Equal("invalid_world_memory_store", error.RootElement.GetProperty("code").GetString());
        Check.True(before.SequenceEqual(File.ReadAllBytes(file)));
        // Corrupt legacy bodies must fail after authentication but before import/key extraction.
        foreach (string shape in new[] { "name", "entry", "list", "marker" })
        {
            var legacy = Fixture(1);
            var node = JsonSerializer.SerializeToNode(legacy, JsonFiles.Options)!.AsObject();
            if (shape == "name") node["worldMemory"]![0]!["name"] = null;
            if (shape == "entry") node["worldMemory"]![0] = null;
            if (shape == "list") node["worldMemory"] = null;
            if (shape == "marker") node["worldMemoryStorageVersion"] = 2;
            string original = Path.Combine(h.Root, "campaigns", legacy.Id + ".json");
            File.WriteAllText(original, node.ToJsonString(JsonFiles.Options));
            byte[] originalBytes = File.ReadAllBytes(original);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", "wrong");
            Check.Equal(HttpStatusCode.Unauthorized, (await h.Http.GetAsync($"/api/v1/campaigns/{legacy.Id}")).StatusCode);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", Token);
            var rejected = await h.Http.GetAsync($"/api/v1/campaigns/{legacy.Id}");
            Check.Equal(HttpStatusCode.Conflict, rejected.StatusCode);
            using var detail = JsonDocument.Parse(await rejected.Content.ReadAsStringAsync());
            Check.Equal("invalid_world_memory_store", detail.RootElement.GetProperty("code").GetString());
            Check.True(!File.Exists(Path.ChangeExtension(original, ".sqlite")));
            Check.True(originalBytes.SequenceEqual(File.ReadAllBytes(original)));
        }
        // SQLite1 is equally strict and never upgrades a corrupt body.
        var old = Fixture(1); string oldFile = Path.Combine(h.Root, "campaigns", old.Id + ".json");
        JsonFiles.Write(oldFile, old); await h.Get(old.Id);
        Sql(h.Root, old.Id, "UPDATE state SET json=json_set(json,'$.worldMemory[0].name',null)");
        string oldDatabase = Path.ChangeExtension(oldFile, ".sqlite"); byte[] oldBytes = File.ReadAllBytes(oldDatabase);
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.GetAsync($"/api/v1/campaigns/{old.Id}")).StatusCode);
        Check.True(oldBytes.SequenceEqual(File.ReadAllBytes(oldDatabase)));
        Check.Equal(0, Directory.GetFiles(Path.GetDirectoryName(oldDatabase)!, old.Id + ".sqlite.pre-world-v2.*.bak").Length);
    }
    public static async Task RealPiBeyondLegacyCursor()
    {
        WorldMemoryEntry? selected = null;
        var model = new Model((n, r) =>
        {
            if (n == 1) return Tool("context_read");
            if (n == 2) return Tool("world_search", new { query = "CopperKey", offset = 300, limit = 6 });
            if (n == 3)
            {
                using var output = JsonDocument.Parse(r.Messages.Last(m => m.Name == "world_search").Content);
                selected = HarnessJson.Read<WorldMemoryEntry>(output.RootElement.GetProperty("entries")[0]);
                return Tool("world_record", new NarrativeHarnessArgs("重新核对了较早的公开世界信息。",
                    [new(selected.Id, selected.Kind, selected.Name, "远行书信已经核实；未获得通行许可或奖励。", "active", selected.SceneId)]));
            }
            Check.Equal(4, n); return Text("较早的记录已更新，身份保持不变。");
        });
        var configure = Configure(model, extra: b =>
        {
            b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry();
            b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>();
        });
        var dice = new SequenceDice(); var h = await Host.Start(dice: dice, configure: configure);
        try
        {
            var owner = await Create(h); string id = owner.Snapshot.Id;
            await h.App.Services.GetRequiredService<CampaignStore>().Access(id, owner.AccessToken, true, c =>
            {
                WorldMemories.Apply(c, Enumerable.Range(0, 600).Select(i => Entry(i) with { UpdatedSequence = c.Version + 1 }).ToArray());
                Advance(c); return Task.FromResult(true);
            });
            var guest = await HarnessBoundaryTests.Guest(h, owner);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
            var state = (await h.Get(id))!;
            Check.Equal(600, state.WorldMemoryPaging!.Total);
            Check.Equal(HttpStatusCode.Forbidden, (await h.Http.GetAsync($"/api/v1/campaigns/{id}/world/memory?expectedVersion={state.Version}&scope=host")).StatusCode);
            var request = new HarnessInputRequest(Id(), state.Version, "核对远地的旧书信");
            var run = await Post<HarnessRunView>(h, id, "harness/runs", request);
            run = await Settled(h, id, run.Id, 3000); Check.True(run.Status == "completed", run.Status + "/" + run.Error);
            Check.Equal(3, model.Calls); Check.Equal(0, dice.Count); Check.True(selected is not null);
            var changed = (await h.Get(id))!;
            Check.Equal(2, changed.WorldMemory!.Single(e => e.Id == selected!.Id).Revision);
            Check.Equal(600, changed.WorldMemoryPaging!.Total); Check.Equal(state.ElapsedSeconds, changed.ElapsedSeconds);
            Check.Equal(HarnessJson.Serialize(state.Character), HarnessJson.Serialize(changed.Character));
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, dice: dice, configure: configure);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
            var replay = await Post<HarnessRunView>(h, id, "harness/runs", request); Check.True(replay.Replayed);
            Check.Equal(3, model.Calls); Check.Equal(2, (await h.Get(id))!.WorldMemory!.Single(e => e.Id == selected!.Id).Revision);
            Console.WriteLine("WORLD SCALE real Pi/MCP: offset 300 -> old record update and final -> reopen/replay; 3 fake model calls, 0 real calls/dice/resources/travel.");
        }
        finally { await h.DisposeAsync(); }
    }
}
