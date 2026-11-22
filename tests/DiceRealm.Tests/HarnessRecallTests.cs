using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class HarnessRecallTests
{
    private static PendingIntent Entry(int sequence, string actor = PartyEngine.HostId, string text = "旧账 CopperKey", string narrative = "最早的公开线索") => new()
    {
        Id = Id(), ActorId = actor, Text = text, RootSequence = sequence, Version = sequence + 1,
        Status = "completed", Published = true, Source = "harness", Narrative = narrative, NarrativeSource = "harness",
        Result = new("narrated", "adventure.narrate", "已保存", null, [])
    };
    private static void Error(string code, Action action)
    {
        try { action(); } catch (GameException error) { Check.Equal(code, error.Code); return; }
        throw new Exception("Expected " + code);
    }
    private static async Task Error(string code, Func<Task> action)
    {
        try { await action(); } catch (GameException error) { Check.Equal(code, error.Code); return; }
        throw new Exception("Expected " + code);
    }
    private static JsonElement Output(HarnessModelRequest request, string name) =>
        JsonDocument.Parse(request.Messages.Last(m => m.Role == "tool" && m.Name == name).Content).RootElement.Clone();

    public static Task LongHistoryPaginationAndCorrections()
    {
        var c = TestContent.Campaign("harbor", "Recall"); c.Version = 200;
        for (int i = 1; i <= 35; i++) c.PendingIntents.Add(Entry(i * 3, text: new string('中', 900) + " 旧账 CopperKey " + i,
            narrative: new string('界', 3500) + " 海灯尾注"));
        var first = c.PendingIntents.First();
        var roll = new DiceCheck("wis", "Perception", [4], 4, 2, 6, 12, false, "normal");
        first.HarnessSteps = Enumerable.Range(0, 10).Select(i => new HarnessActionStep(first.RootSequence,
            new("resolved", "investigate", "权威结果 " + i, roll, [], RollId: Id()), null)).ToList();
        first.HarnessSteps.Add(new(first.RootSequence, new("awaiting_roll", "check", "WAIT-STEP-SECRET", null, []), null));
        var other = Entry(110, "other-seat", "OTHER-SEAT-SECRET"); c.PendingIntents.Add(other);
        var hidden = Entry(111, text: "PRIVATE-SECRET"); hidden.Published = false; c.PendingIntents.Add(hidden);
        var waiting = Entry(112, text: "WAITING-SECRET"); waiting.Result = new("awaiting_roll", "check", "WAITING-SECRET", null, []); c.PendingIntents.Add(waiting);
        var cancelled = Entry(113, text: "CANCELLED-SECRET"); cancelled.Status = "cancelled"; c.PendingIntents.Add(cancelled);
        var legacy = Entry(114, text: "LEGACY-SECRET"); legacy.Source = "ai"; c.PendingIntents.Add(legacy);
        var recent = HarnessMemories.Build(c);
        Check.True(recent.Entries.Length <= 12 && recent.Entries.All(e => e.IntentId != first.Id));
        int before = 0; var ids = new List<string>(); bool byteShortened = false;
        do
        {
            var page = HarnessRecall.Search(c, new("旧账 copperkey", before));
            Check.Equal(HarnessRecall.Scope, page.Scope); Check.Equal(c.Version, page.Version);
            Check.True(Encoding.UTF8.GetByteCount(HarnessJson.Serialize(page)) <= HarnessMemories.MaximumBytes);
            Check.True(page.Entries.Length > 0); byteShortened |= page.Entries.Length < 6 && page.NextBefore is not null;
            Check.True(page.Entries.All(e => e.Input.Length <= 240 && e.Narrative.Length <= 800));
            ids.AddRange(page.Entries.Select(e => e.IntentId));
            if (page.NextBefore is null) break;
            Check.True(before == 0 || page.NextBefore.Value < before); before = page.NextBefore.Value;
        } while (true);
        Check.True(byteShortened, "UTF-8 size shortening must preserve pagination");
        Check.Equal(35, ids.Count); Check.Equal(35, ids.Distinct().Count()); Check.Equal(first.Id, ids.Last());
        Check.True(HarnessRecall.Search(c, new("海灯尾注", Limit: 1)).Entries.Length == 1, "match beyond preview clipping");
        Check.Equal(0, HarnessRecall.Search(c, new("missing-anchor")).Entries.Length);
        Check.True(HarnessRecall.Search(c, new("missing-anchor")).NextBefore is null);
        var read = HarnessRecall.Read(c, new(first.Id.ToUpperInvariant()));
        Check.Equal(first.Text, read.Entry.Input); Check.Equal(first.Narrative, read.Entry.Narrative);
        Check.Equal(10, read.Entry.TotalSteps); Check.Equal(8, read.Entry.Steps.Length);
        Check.Equal(roll, read.Entry.Steps[0].Check!); Check.Equal("权威结果 2", read.Entry.Steps[0].Summary);
        Check.Equal(first.RootSequence, read.Entry.OriginSequence); Check.Equal(first.Version, read.Entry.ResultVersion);
        Check.True(Encoding.UTF8.GetByteCount(HarnessJson.Serialize(read)) <= HarnessRecall.MaximumReadBytes);
        c.AdventureCorrections.Add(new(first.RootSequence, "公开更正：钥匙在船长处", "HOST-REASON-SECRET", PartyEngine.HostId, DateTimeOffset.UtcNow, c.Version));
        var corrected = HarnessRecall.Search(c, new("船长处")); Check.Equal(first.Id, corrected.Entries.Single().IntentId);
        Check.True(corrected.Entries[0].Corrected); Check.Equal("host_correction", corrected.Entries[0].NarrativeSource);
        Check.Equal(0, HarnessRecall.Search(c, new("海灯尾注", Before: first.RootSequence + 1)).Entries.Length);
        Check.Equal(0, HarnessRecall.Search(c, new("SECRET")).Entries.Length);
        Check.Equal(0, HarnessRecall.Search(c, new("WAIT-STEP")).Entries.Length);
        read = HarnessRecall.Read(c, new(first.Id)); Check.Equal("公开更正：钥匙在船长处", read.Entry.Narrative);
        Check.True(read.Entry.Corrected && !HarnessJson.Serialize(read).Contains("SECRET"));
        Check.Equal(roll, read.Entry.Steps[0].Check!); // correction never replaces rolled evidence
        foreach (var entry in new[] { other, hidden, waiting, cancelled, legacy })
            Error("harness_memory_unavailable", () => HarnessRecall.Read(c, new(entry.Id)));
        foreach (var args in new[] { new HarnessMemorySearchArgs(null!), new("x\n"), new(new string('x', 121)),
            new("a b c d e f g h i"), new("", -1), new("", 201), new("", Limit: 0), new("", Limit: 7) })
            Error("harness_invalid_payload", () => HarnessRecall.Search(c, args));
        Error("harness_invalid_payload", () => HarnessRecall.Read(c, new("../secret")));
        Error("harness_memory_unavailable", () => HarnessRecall.Read(c, new(Id())));
        return Task.CompletedTask;
    }

    public static Task DetailByteBudgetPreservesEvidenceOrder()
    {
        var c = TestContent.Campaign("harbor", "Read budget"); c.Version = 30;
        var intent = Entry(1, text: new string('输', 1000), narrative: new string('叙', 4096)); c.PendingIntents.Add(intent);
        // Imported/legacy stored evidence is not assumed to have today's small dice arrays.
        // Exercise byte reduction without truncating or rewriting any individual DiceCheck.
        intent.HarnessSteps = Enumerable.Range(0, 8).Select(i => new HarnessActionStep(i + 2,
            new("resolved", "check", new string('果', 240), new("wisdom", "Perception", Enumerable.Repeat(20, 2500).ToArray(),
                20, 3, 23, 12, true, "normal"), [], RollId: Id()), null)).ToList();
        var result = HarnessRecall.Read(c, new(intent.Id));
        Check.Equal(8, result.Entry.TotalSteps); Check.True(result.Entry.Steps.Length is > 0 and < 8);
        Check.Equal(9, result.Entry.Steps[^1].Version);
        Check.Equal(10 - result.Entry.Steps.Length, result.Entry.Steps[0].Version);
        Check.True(result.Entry.Steps.All(step => step.Check!.Rolls.Length == 2500));
        Check.Equal(intent.Text, result.Entry.Input); Check.Equal(intent.Narrative, result.Entry.Narrative);
        Check.True(Encoding.UTF8.GetByteCount(HarnessJson.Serialize(result)) <= HarnessRecall.MaximumReadBytes);
        Check.Equal(8, intent.HarnessSteps.Count); // reduction applies only to the projection
        return Task.CompletedTask;
    }

    public static async Task RecallPreservesExistingCandidateAuthorization()
    {
        string oldIntent = "", candidate = "";
        var model = new Model((n, request) =>
        {
            if (n == 1) return Text("先前已经观察过码头。" );
            if (n == 2) return Tool("context_read");
            if (n == 3)
            {
                candidate = Output(request, "context_read").GetProperty("context").GetProperty("intent").GetProperty("candidates")
                    .EnumerateArray().First(c => c.GetProperty("label").GetString()!.Contains("观察")).GetProperty("id").GetString()!;
                return Tool("memory_search", new { query = "" });
            }
            if (n == 4)
            {
                Check.Equal(oldIntent, Output(request, "memory_search").GetProperty("entries")[0].GetProperty("intentId").GetString());
                return Tool("memory_read", new { intentId = oldIntent });
            }
            if (n == 5) return Tool("actions_propose", new { candidateId = candidate });
            return Text("已参考旧行动并按当前候选完成观察。");
        });
        var dice = new SequenceDice(); await using var host = await Host.Start(dice: dice, configure: Configure(model)); var owner = await Create(host);
        var first = await Start(host, owner.Snapshot, "保留旧观察"); first = await Settled(host, owner.Snapshot.Id, first.Id);
        Check.Equal("completed", first.Status); oldIntent = first.IntentId;
        var run = await Start(host, (await host.Get(owner.Snapshot.Id))!, "回顾后观察"); run = await Settled(host, owner.Snapshot.Id, run.Id);
        Check.True(run.Status == "completed", run.Status + "/" + run.Error); Check.Equal(6, model.Calls); Check.Equal(0, dice.Count);
        Check.Equal(1, (await host.Get(owner.Snapshot.Id))!.Events.Count(e => e.Kind == "observe"));
    }

    public static async Task AuthorizedReadOnlyBoundary()
    {
        var model = new Model((_, _) => throw new Exception("No model calls for retrieval")); var dice = new SequenceDice();
        await using var host = await Host.Start(dice: dice, configure: Configure(model)); var owner = await Create(host); string id = owner.Snapshot.Id;
        var invite = new InviteRequest(Id(), owner.Snapshot.Version, new string('a', 64)); await Post<ActionResponse>(host, id, "invitations", invite);
        var guest = await Post<CreatedCampaign>(host, id, "join", new JoinCampaignRequest(Id(), invite.InviteToken, new string('b', 64), "Guest", Build: FullCreationTests.Named("Guest")));
        guest = await host.ApproveGuest(owner, guest);
        var store = host.App.Services.GetRequiredService<CampaignStore>();
        var own = Entry(1, text: "OWNER-PUBLIC"); var theirs = Entry(2, guest.Snapshot.Party!.SelfActorId, "GUEST-PUBLIC");
        var hidden = Entry(3, text: "PRIVATE-DRAFT"); hidden.Published = false;
        await store.Access(id, owner.AccessToken, true, c => { c.PendingIntents.AddRange([own, theirs, hidden]); return Task.FromResult(true); });
        var game = host.App.Services.GetRequiredService<GameService>(); var auth = await game.AuthorizeHarness(id, owner.AccessToken, default);
        var snapshot = (await host.Get(id))!;
        Task<HarnessToolOutcome> Call(string token, string actor, string name, object args, int version = -1, int contract = 2) =>
            game.HarnessTool(id, token, actor, Id(), "查历史", version < 0 ? snapshot.Version : version, Id(), "unused-read-fingerprint",
                new(name, args is JsonElement json ? json : HarnessJson.Element(args), "read"), [], default, auth.Profile, contract);
        var database = Path.Combine(host.Root, "campaigns", id + ".sqlite"); var before = File.ReadAllBytes(database);
        var output = await Call(owner.AccessToken, auth.ActorId, "memory_search", new { query = "" });
        Check.Equal(snapshot.Version, output.Version); Check.True(output.OfferedIds is null && output.Wait is null && !output.Reply.Stop);
        var search = HarnessJson.Read<HarnessMemorySearchResult>(JsonDocument.Parse(output.Reply.Content).RootElement);
        Check.Equal(own.Id, search.Entries.Single().IntentId);
        output = await Call(guest.AccessToken, guest.Snapshot.Party.SelfActorId, "memory_search", new { query = "" });
        Check.True(output.Reply.Content.Contains("GUEST-PUBLIC") && !output.Reply.Content.Contains("OWNER-PUBLIC"));
        await Error("harness_memory_unavailable", () => Call(owner.AccessToken, auth.ActorId, "memory_read", new { intentId = theirs.Id }));
        await Error("harness_memory_unavailable", () => Call(guest.AccessToken, guest.Snapshot.Party.SelfActorId, "memory_read", new { intentId = own.Id }));
        await Error("harness_memory_unavailable", () => Call(owner.AccessToken, auth.ActorId, "memory_read", new { intentId = hidden.Id }));
        await Error("unauthorized", () => Call(guest.AccessToken, auth.ActorId, "memory_search", new { query = "" }));
        await Error("stale_version", () => Call(owner.AccessToken, auth.ActorId, "memory_search", new { query = "" }, snapshot.Version - 1));
        await Error("harness_tool_unavailable", () => Call(owner.AccessToken, auth.ActorId, "memory_search", new { query = "" }, contract: 1));
        await Error("intent_option_unavailable", () => Call(owner.AccessToken, auth.ActorId, "actions_propose", new { candidateId = "option-0" }));
        foreach (string raw in new[] { "{}", "{\"query\":\"x\",\"actor\":\"other\"}", "{\"query\":\"x\",\"query\":\"y\"}",
            "{\"query\":null}", "{\"query\":\"\",\"limit\":1.2}", "{\"query\":\"\",\"limit\":null}" })
            await Error("harness_invalid_payload", () => Call(owner.AccessToken, auth.ActorId, "memory_search", JsonDocument.Parse(raw).RootElement));
        Check.True(before.SequenceEqual(File.ReadAllBytes(database)), "retrieval and rejection must not persist campaign changes");
        Check.Equal(0, dice.Count); Check.Equal(0, model.Calls); Check.Equal(snapshot.Version, (await host.Get(id))!.Version);
        var foreign = await Create(host);
        await Error("unauthorized", () => Call(foreign.AccessToken, auth.ActorId, "memory_read", new { intentId = own.Id }));
        host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        await Post<ActionResponse>(host, id, "seats/revoke", new RevokeSeatRequest(Id(), snapshot.Version, guest.Snapshot.Party.SelfActorId));
        await Error("unauthorized", () => Call(guest.AccessToken, guest.Snapshot.Party.SelfActorId, "memory_search", new { query = "" }));
    }

    public static async Task RealPiBusinessRecallAndRestart()
    {
        string oldestIntent = "", searchReply = "", readReply = "";
        const string oldNarrative = "旧账记载：铜钥匙交给了灯塔看守。";
        var model = new Model((n, request) =>
        {
            if (n <= 15) return Text(n == 1 ? oldNarrative : "沿途观察记录 " + n);
            if (n == 16)
            {
                using var input = JsonDocument.Parse(request.Messages.First(m => m.Role == "user").Content);
                var history = HarnessJson.Read<HarnessHistoryContext>(input.RootElement.GetProperty("memory"));
                Check.Equal("exploration", history.Scope);
                Check.True(history.Audiences.Select(a => a.Audience).SequenceEqual(new[] { "public", PartyEngine.HostId }));
                // Since contract 45, memory is audience-grouped history, not the old
                // 12-entry recent window. Relevant originals may already be present;
                // explicit recall must still return the exact old business record.
                var publicHistory = history.Audiences.Single(a => a.Audience == "public");
                var originals = publicHistory.Raw.Concat(publicHistory.RelatedOriginalSupplements.Select(s => s.Original));
                Check.True(originals.Any(f => f.Group == oldestIntent && f.Text == oldNarrative));
                return Tool("memory_search", new { query = "旧账 铜钥匙", limit = 2 });
            }
            if (n == 17)
            {
                var found = Output(request, "memory_search"); searchReply = request.Messages.Last(m => m.Name == "memory_search").Content;
                Check.Equal(oldestIntent, found.GetProperty("entries")[0].GetProperty("intentId").GetString());
                return Tool("memory_read", new { intentId = oldestIntent });
            }
            if (n == 18)
            {
                var read = Output(request, "memory_read"); readReply = request.Messages.Last(m => m.Name == "memory_read").Content;
                Check.Equal(oldNarrative, read.GetProperty("entry").GetProperty("narrative").GetString());
                return Tool("ask_player", new { question = "已找回旧线索，要去找灯塔看守吗？" });
            }
            Check.Equal(19, n);
            Check.Equal(searchReply, request.Messages.Single(m => m.Name == "memory_search").Content);
            Check.Equal(readReply, request.Messages.Single(m => m.Name == "memory_read").Content);
            return Text("按原记录，铜钥匙在灯塔看守处；尚未执行旅行。");
        });
        var configure = Configure(model, extra: builder =>
        {
            builder.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry();
            builder.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>();
        });
        var dice = new SequenceDice(); var host = await Host.Start(dice: dice, configure: configure);
        try
        {
            var response = await host.Http.PostAsJsonAsync("/api/v1/campaigns/from-content",
                new CreateCampaignFromContentRequest("召回离线回归", "Arden", TestContent.Document, Preset.SystemPrompt, [], Build: FullCreationTests.Named("Arden")));
            Check.Equal(HttpStatusCode.Created, response.StatusCode);
            var owner = (await response.Content.ReadFromJsonAsync<CreatedCampaign>())!;
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken); string id = owner.Snapshot.Id;
            int oldestSequence = 0;
            for (int i = 1; i <= 15; i++)
            {
                var snapshot = (await host.Get(id))!;
                var action = await Post<AdventureSessionView>(host, id, "adventure/actions", new AdventureActionRequest(Id(), snapshot.Version, "记录旅途 " + i));
                var finished = await Settled(host, id, action.SessionId, 3000); Check.True(finished.Status == "completed", finished.Status + "/" + finished.Error);
                if (i == 1)
                {
                    oldestIntent = finished.IntentId;
                    oldestSequence = host.App.Services.GetRequiredService<HarnessRunStore>().Read(id, PartyEngine.HostId, finished.Id)!.Version;
                }
            }
            var state = (await host.Get(id))!; int version = state.Version;
            var request = new AdventureActionRequest(Id(), version, "找回最早的旧账中铜钥匙交给谁了");
            var start = await Post<AdventureSessionView>(host, id, "adventure/actions", request);
            var run = await Settled(host, id, start.SessionId, 3000); Check.True(run.Status == "waiting", run.Status + "/" + run.Error);
            Check.Equal(18, model.Calls); Check.Equal(version, (await host.Get(id))!.Version); Check.Equal(0, dice.Count);
            var stored = host.App.Services.GetRequiredService<HarnessRunStore>().Read(id, PartyEngine.HostId, run.Id)!;
            string frozenSteps = HarnessJson.Serialize(stored.Steps); string frozenTurn = stored.Turns[0];
            Check.Equal(HarnessTools.CurrentVersion, stored.ToolContractVersion);
            string root = host.Root; await host.DisposeAsync(); host = await Host.Start(root, dice: dice, configure: configure);
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            await host.Http.GetAsync($"/api/v1/campaigns/{id}/adventure");
            await host.Http.GetAsync($"/api/v1/campaigns/{id}/adventure/memory");
            var replay = await Post<AdventureSessionView>(host, id, "adventure/actions", request);
            Check.True(replay.Replayed); Check.Equal(18, model.Calls); Check.Equal(version, (await host.Get(id))!.Version);
            var resume = new AdventureActionRequest(Id(), version, "先记住，不旅行");
            await Post<AdventureSessionView>(host, id, $"adventure/sessions/{run.Id}/continue", resume);
            run = await Settled(host, id, run.Id, 3000); Check.True(run.Status == "completed", run.Status + "/" + run.Error);
            Check.Equal(19, model.Calls); Check.Equal(0, dice.Count); Check.Equal(state.Scene, (await host.Get(id))!.Scene);
            var after = host.App.Services.GetRequiredService<HarnessRunStore>().Read(id, PartyEngine.HostId, run.Id)!;
            Check.Equal(frozenSteps, HarnessJson.Serialize(after.Steps.Take(stored.Steps.Count).ToList())); Check.Equal(frozenTurn, after.Turns[0]);
            Check.True((await Post<AdventureSessionView>(host, id, $"adventure/sessions/{run.Id}/continue", resume)).Replayed);
            // A later correction affects new reads, never previously persisted model/tool input.
            state = (await host.Get(id))!;
            await Post<ActionResponse>(host, id, "adventure/correct", new CorrectAdventureRequest(Id(), state.Version, oldestSequence,
                "公开更正：钥匙已归还", "REASON-NOT-FOR-MODEL"));
            Check.True((await Post<AdventureSessionView>(host, id, "adventure/actions", request)).Replayed);
            after = host.App.Services.GetRequiredService<HarnessRunStore>().Read(id, PartyEngine.HostId, run.Id)!;
            Check.Equal(frozenSteps, HarnessJson.Serialize(after.Steps.Take(stored.Steps.Count).ToList())); Check.Equal(19, model.Calls);
            Check.True(model.Requests.All(r => r.System == Preset.SystemPrompt));
            Console.WriteLine("RECALL real Pi/MCP: 15 completed actions; old first action recovered beyond last 12; 19 fake-model calls; 0 dice; restart exact replay");
        }
        finally { await host.DisposeAsync(); }
    }

    public static async Task FrozenCatalogV1AndRejectedUpgrade()
    {
        Check.Equal("1e9fb4d9891e507f0afa12114e9122a55fbc92fd7ad5367c4c261c17bbd05146", HarnessJson.Fingerprint(HarnessJson.Element(HarnessTools.ForVersion(0))));
        Check.Equal("6ac18cf35c4836acad2e06919c2de4b799aee31f68a67c5e082253d7efe9befb", HarnessJson.Fingerprint(HarnessJson.Element(HarnessTools.ForVersion(1))));
        var model = new Model((n, request) =>
        {
            Check.True(request.Tools.All(t => !t.Name.StartsWith("memory_", StringComparison.Ordinal)));
            if (n == 1) return Tool("context_read");
            if (n == 2) return Tool("ask_player", new { question = "旧v1暂停" });
            if (n == 3) return Text("旧v1正常继续");
            return Tool("memory_search", new { query = "" }); // provider cannot acquire a new tool in an old run
        });
        var configure = Configure(model, extra: builder =>
        {
            builder.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry();
            builder.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>();
        });
        var host = await Host.Start(configure: configure);
        try
        {
            var owner = await Create(host); string id = owner.Snapshot.Id;
            HarnessRun Legacy(int version) => new()
            {
                Id = Id(), IntentId = Id(), CampaignId = id, ActorId = PartyEngine.HostId, Fingerprint = new string('a', 64), Input = "旧版输入",
                Profile = new(Preset, HarnessJson.ProfileHash(Preset, []), []), Limits = new(), Version = version, ToolContractVersion = 1,
                Turns = [HarnessJson.Serialize(new { input = "旧版输入", ruleset = "dnd2024" })]
            };
            var legacy = Legacy(owner.Snapshot.Version); host.App.Services.GetRequiredService<HarnessRunStore>().Create(legacy);
            await Post<HarnessRunView>(host, id, $"harness/runs/{legacy.Id}/resume", new HarnessResumeRequest(Id(), legacy.Version));
            var run = await Settled(host, id, legacy.Id, 3000); Check.True(run.Status == "waiting", run.Status + "/" + run.Error);
            var saved = host.App.Services.GetRequiredService<HarnessRunStore>().Read(id, PartyEngine.HostId, run.Id)!;
            string prefix = HarnessJson.Serialize(saved.Steps), root = host.Root;
            await host.DisposeAsync(); host = await Host.Start(root, configure: configure); host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            await Post<HarnessRunView>(host, id, $"harness/runs/{legacy.Id}/resume", new HarnessResumeRequest(Id(), run.Version, "继续"));
            run = await Settled(host, id, legacy.Id, 3000); Check.True(run.Status == "completed", run.Status + "/" + run.Error);
            var restored = host.App.Services.GetRequiredService<HarnessRunStore>().Read(id, PartyEngine.HostId, run.Id)!;
            Check.Equal(1, restored.ToolContractVersion); Check.Equal(prefix, HarnessJson.Serialize(restored.Steps.Take(saved.Steps.Count).ToList())); Check.Equal(3, model.Calls);
            var forbidden = Legacy((await host.Get(id))!.Version); host.App.Services.GetRequiredService<HarnessRunStore>().Create(forbidden);
            await Post<HarnessRunView>(host, id, $"harness/runs/{forbidden.Id}/resume", new HarnessResumeRequest(Id(), forbidden.Version));
            run = await Settled(host, id, forbidden.Id, 3000); Check.Equal("unknown", run.Status); Check.Equal("harness_model_unknown", run.Error);
            Check.Equal(4, model.Calls); Check.Equal(forbidden.Version, (await host.Get(id))!.Version);
            var future = Legacy(forbidden.Version); host.App.Services.GetRequiredService<HarnessRunStore>().Create(future);
            string file = Path.Combine(root, "harness", id, JsonFiles.Hash(PartyEngine.HostId), future.Id + ".json");
            var json = JsonNode.Parse(File.ReadAllText(file))!.AsObject(); json["toolContractVersion"] = 99; File.WriteAllText(file, json.ToJsonString());
            string original = File.ReadAllText(file);
            Error("harness_corrupt_run", () => host.App.Services.GetRequiredService<HarnessRunStore>().Read(id, PartyEngine.HostId, future.Id));
            Check.Equal(original, File.ReadAllText(file));
        }
        finally { await host.DisposeAsync(); }
    }
}
