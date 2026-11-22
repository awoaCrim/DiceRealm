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

internal static class HarnessWorldSearchTests
{
    private const string OldNpc = "Old.NPC", OldQuest = "Old.Quest";
    private static AdventureDocument Document() => TestContent.Document with { InitialKnowledge =
    [
        new(OldNpc, "npc", "旧船长", "CopperKey 旧地图保存在船舱。", "", "public"),
        new(OldQuest, "quest", "旧委托", "寻找灯塔的来信。", "", "public"),
        .. Enumerable.Range(0, 40).Select(i => new InitialKnowledgeEntry("local-" + i, "clue", "港口记录" + i, "近期公开信息。", "harbor", "public")),
        new("host-secret", "clue", "HOST-SECRET", "HOST-SECRET-BODY", "", "host"),
        new("future-secret", "clue", "FUTURE-SECRET", "FUTURE-SECRET-BODY", "", "arrival", "beacon")
    ] };
    private static WorldMemoryProposal Update(string id = OldNpc, string summary = "船长已经核对了旧地图。") =>
        id == OldQuest ? new(id, "quest", "旧委托", summary, "active", "") : new(id, "npc", "旧船长", summary, "active", "");
    private static HarnessModelReply Record(params WorldMemoryProposal[] memory) => Tool("world_record", new NarrativeHarnessArgs("记录新的公开交谈。", memory));
    private static HarnessModelReply Intermediate(params WorldMemoryProposal[] memory) => Tool("world_record", new NarrativeHarnessArgs("记录新的公开交谈。", memory, Complete: false));
    private static JsonElement Output(HarnessModelRequest request, string name) =>
        JsonDocument.Parse(request.Messages.Last(m => m.Role == "tool" && m.Name == name).Content).RootElement.Clone();
    private static async Task Error(string code, Func<Task> action)
    {
        try { await action(); } catch (GameException error) { Check.Equal(code, error.Code); return; }
        throw new Exception("Expected " + code);
    }
    private static void Error(string code, Action action)
    {
        try { action(); } catch (GameException error) { Check.Equal(code, error.Code); return; }
        throw new Exception("Expected " + code);
    }

    public static Task PublicSearchPaginationAndBounds()
    {
        var c = TestContent.Campaign("harbor", "World lookup"); c.Version = 50;
        for (int i = 0; i < 253; i++) c.WorldMemory.Add(new("public-" + i.ToString("D3"), i % 2 == 0 ? "npc" : "clue",
            "公开 CopperKey " + i, new string('文', 790) + " 海灯尾注", "known", i % 3 == 0 ? "harbor" : "", 1, 0,
            2, i % 2 == 0 ? "another-seat" : PartyEngine.HostId, "fixture"));
        c.WorldMemory.AddRange([
            new("host", "npc", "HOST-SECRET", "HOST-BODY", "known", "", 1, 0, 2, "other", "fixture", Visibility: "host"),
            new("hidden", "npc", "HIDDEN-SECRET", "HIDDEN-BODY", "known", "", 1, 0, 2, "other", "fixture", Hidden: true),
            new("arrival", "npc", "FUTURE-SECRET", "FUTURE-BODY", "known", "", 1, 0, 2, "other", "fixture", Visibility: "arrival", RevealSceneId: "beacon")
        ]);
        c.Facts.Add("PRIVATE-FACT"); c.Adventure = c.Adventure! with { SourceText = "PRIVATE-SCRIPT" };
        int offset = 0; bool shortened = false; var ids = new List<string>();
        do
        {
            var page = HarnessWorldSearch.Search(c, new("公开 copperkey 海灯尾注", Offset: offset));
            Check.Equal("shared_public_world", page.Scope); Check.Equal(c.Version, page.Version);
            Check.True(page.Entries.Length > 0); Check.True(Encoding.UTF8.GetByteCount(HarnessJson.Serialize(page)) <= HarnessWorldSearch.MaximumBytes);
            shortened |= page.Entries.Length < 6 && page.NextOffset is not null;
            ids.AddRange(page.Entries.Select(e => e.Id));
            Check.True(!HarnessJson.Serialize(page).Contains("SECRET"));
            if (page.NextOffset is null) break;
            Check.Equal(offset + page.Entries.Length, page.NextOffset.Value); offset = page.NextOffset.Value;
        } while (true);
        Check.True(shortened); Check.Equal(253, ids.Count); Check.Equal(253, ids.Distinct().Count());
        var expected = WorldMemories.Public(c).OrderByDescending(e => e.SceneId == c.SceneId).ThenByDescending(e => e.UpdatedSequence)
            .ThenBy(e => e.Id, StringComparer.Ordinal).Select(e => e.Id).ToArray();
        Check.True(expected.SequenceEqual(ids), "same update sequence must not lose any entries");
        var npc = HarnessWorldSearch.Search(c, new("COPPERKEY", "npc")); Check.True(npc.Entries.All(e => e.Kind == "npc" && e.ActorId == "another-seat"));
        Check.Equal(0, HarnessWorldSearch.Search(c, new("SECRET")).Entries.Length);
        c.VisitedScenes.Add("beacon"); var revealed = HarnessWorldSearch.Search(c, new("FUTURE")); Check.Equal("arrival", revealed.Entries.Single().Id);
        Check.Equal("arrival", revealed.Entries[0].Visibility); Check.Equal("beacon", revealed.Entries[0].RevealSceneId);
        Check.True(HarnessWorldSearch.Search(c, new("missing")).NextOffset is null);
        Check.Equal(0, HarnessWorldSearch.Search(c, new("", Offset: 256)).Entries.Length);
        foreach (var args in new[] { new HarnessWorldSearchArgs(null!), new("", null!), new("", "NPC"), new("x\n"), new(new string('a', 121)),
            new("a b c d e f g h i"), new("", Offset: -1), new("", Offset: 257), new("", Limit: 0), new("", Limit: 7) })
            Error("harness_invalid_payload", () => HarnessWorldSearch.Search(c, args));
        return Task.CompletedTask;
    }

    public static async Task SharedAuthorityAndAtomicRejection()
    {
        var dice = new SequenceDice(); var model = new Model((_, _) => throw new Exception("No provider for tool reads"));
        await using var host = await Host.Start(dice: dice, configure: Configure(model)); var owner = await Create(host, Document()); string id = owner.Snapshot.Id;
        var guest = await HarnessBoundaryTests.Guest(host, owner); // already approved by the shared fixture
        var game = host.App.Services.GetRequiredService<GameService>(); var auth = await game.AuthorizeHarness(id, owner.AccessToken, default);
        var state = (await host.Get(id))!; int version = state.Version;
        Task<HarnessToolOutcome> Call(string name, object args, string[]? refs = null, int contract = 3, string? token = null, string? actor = null, int? cursor = null) =>
            game.HarnessTool(id, token ?? owner.AccessToken, actor ?? auth.ActorId, Id(), "调查公开世界", cursor ?? version, Id(), Id(),
                new(name, args is JsonElement raw ? raw : HarnessJson.Element(args), "world"), [], default, auth.Profile, contract, offeredMemoryIds: refs);
        var path = Path.Combine(host.Root, "campaigns", id + ".sqlite"); byte[] before = File.ReadAllBytes(path);
        var context = await Call("context_read", new { }); Check.True(context.OfferedMemoryIds is { Length: 32 });
        Check.True(!context.OfferedMemoryIds!.Contains(OldNpc));
        var found = await Call("world_search", new { query = "旧船长 copperkey" });
        Check.True(found.OfferedIds is null && found.Wait is null && !found.Reply.Stop);
        Check.True(found.OfferedMemoryIds!.SequenceEqual([OldNpc]));
        var result = HarnessJson.Read<HarnessWorldSearchResult>(JsonDocument.Parse(found.Reply.Content).RootElement);
        Check.Equal(OldNpc, result.Entries.Single().Id);
        var args = new NarrativeHarnessArgs("将更新原对象。", [Update()]);
        await Error("invalid_world_memory", () => Call("world_record", args));
        await Error("invalid_world_memory", () => Call("world_record", args, context.OfferedMemoryIds));
        var top = state.WorldMemory!.Single(m => m.Id == "local-0");
        await Error("invalid_world_memory", () => Call("world_record", new NarrativeHarnessArgs("猜到当前top32也无权。", [new(top.Id, top.Kind, top.Name, "不应写入", top.Status, top.SceneId)])));
        foreach (var proposals in new[]
        {
            new[] { Update(), Update(OldQuest) }, new[] { Update(), Update() }, new[] { Update() with { Id = "old.npc" } },
            new[] { Update() with { Kind = "quest" } }, new[] { Update() with { SceneId = "beacon" } },
            new[] { Update() with { Id = "" } }, new[] { Update() with { Status = "rewarded" } }
        }) await Error("invalid_world_memory", () => Call("world_record", new NarrativeHarnessArgs("整批都不能写入。", proposals), found.OfferedMemoryIds));
        foreach (string raw in new[] { "{}", "{\"query\":\"\",\"actor\":\"other\"}", "{\"query\":\"\",\"query\":\"x\"}", "{\"query\":null}", "{\"query\":\"\",\"limit\":1.5}" })
            await Error("harness_invalid_payload", () => Call("world_search", JsonDocument.Parse(raw).RootElement));
        await Error("harness_invalid_payload", () => Call("world_record", new { narrative = "机械补丁", memory = new[] { Update() }, hp = 99 }, found.OfferedMemoryIds));
        await Error("harness_tool_unavailable", () => Call("world_search", new { query = "" }, contract: 2));
        await Error("invalid_world_memory", () => Call("world_record", args, found.OfferedMemoryIds, contract: 2));
        Check.True(before.SequenceEqual(File.ReadAllBytes(path)), "read or any rejected batch must not modify campaign storage");
        Check.Equal(0, model.Calls); Check.Equal(0, dice.Count);
        string guestActor = guest.Snapshot.Party!.SelfActorId;
        var guestRead = await Call("world_search", new { query = "旧船长" }, token: guest.AccessToken, actor: guestActor);
        var committed = await Call("world_record", args, guestRead.OfferedMemoryIds, token: guest.AccessToken, actor: guestActor);
        version = committed.Version;
        host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        var current = (await host.Get(id))!; var changed = current.WorldMemory!.Single(m => m.Id == OldNpc);
        Check.Equal(2, changed.Revision); Check.Equal(0, changed.OriginSequence); Check.Equal(guestActor, changed.ActorId); Check.Equal("harness", changed.Source);
        Check.Equal(state.WorldMemory!.Length, current.WorldMemory!.Length); Check.Equal(state.ElapsedSeconds, current.ElapsedSeconds);
        Check.Equal(HarnessJson.Serialize(state.Character), HarnessJson.Serialize(current.Character)); Check.Equal(HarnessJson.Serialize(state.Facts), HarnessJson.Serialize(current.Facts));
        Check.Equal(HarnessJson.Serialize(state.Map), HarnessJson.Serialize(current.Map)); Check.Equal(0, dice.Count);
        // Same object update requires a fresh read; an identical proposal retains provenance.
        var fresh = await Call("world_search", new { query = "旧船长" });
        version = (await Call("world_record", args, fresh.OfferedMemoryIds)).Version;
        Check.Equal(changed, (await host.Get(id))!.WorldMemory!.Single(m => m.Id == OldNpc));
        var hidden = await Post<ActionResponse>(host, id, "world/correct", new CorrectWorldMemoryRequest(Id(), version, changed.Id, changed.Revision,
            "NOW-HIDDEN-SECRET", "NOW-HIDDEN-BODY", "active", true, "PRIVATE-DM-REASON"));
        await Error("stale_version", () => Call("world_record", args, fresh.OfferedMemoryIds, cursor: version)); version = hidden.Snapshot.Version;
        var hiddenRead = await Call("world_search", new { query = "SECRET" });
        Check.Equal(0, HarnessJson.Read<HarnessWorldSearchResult>(JsonDocument.Parse(hiddenRead.Reply.Content).RootElement).Entries.Length);
        await Error("invalid_world_memory", () => Call("world_record", args, fresh.OfferedMemoryIds)); // public check still applies to supplied refs
        var revoked = await Post<ActionResponse>(host, id, "seats/revoke", new RevokeSeatRequest(Id(), version, guestActor)); version = revoked.Snapshot.Version;
        await Error("unauthorized", () => Call("world_search", new { query = "" }, token: guest.AccessToken, actor: guestActor));
        var foreign = await Create(host, Document());
        await Error("unauthorized", () => Call("world_search", new { query = "" }, token: foreign.AccessToken));
    }

    public static async Task SearchPreservesOnlyExistingCandidateAuthorization()
    {
        foreach (bool useWorldId in new[] { false, true })
        {
            string candidate = "";
            var model = new Model((n, request) =>
            {
                if (n == 1) return Tool("context_read");
                if (n == 2)
                {
                    candidate = Output(request, "context_read").GetProperty("context").GetProperty("intent").GetProperty("candidates")
                        .EnumerateArray().First(c => c.GetProperty("label").GetString()!.Contains("观察")).GetProperty("id").GetString()!;
                    return Tool("world_search", new { query = "旧船长", kind = "npc" });
                }
                if (n == 3)
                {
                    Check.Equal(OldNpc, Output(request, "world_search").GetProperty("entries")[0].GetProperty("id").GetString());
                    return Tool("actions_propose", new { candidateId = useWorldId ? OldNpc : candidate });
                }
                Check.Equal(4, n); return Text("查阅船长记录后，按已有候选观察码头。");
            });
            var dice = new SequenceDice(); await using var host = await Host.Start(dice: dice, configure: Configure(model));
            var owner = await Create(host, Document()); string id = owner.Snapshot.Id;
            var run = await Start(host, owner.Snapshot, "查阅旧船长记录后观察码头"); run = await Settled(host, id, run.Id);
            Check.True(run.Status == (useWorldId ? "failed" : "completed"), run.Status + "/" + run.Error);
            Check.Equal(useWorldId ? "intent_option_unavailable" : "", run.Error);
            Check.Equal(useWorldId ? 3 : 4, model.Calls); Check.Equal(0, dice.Count);
            var state = (await host.Get(id))!;
            Check.Equal(useWorldId ? 0 : 1, state.Events.Count(e => e.Kind == "observe"));
            Check.Equal(HarnessJson.Serialize(owner.Snapshot.WorldMemory), HarnessJson.Serialize(state.WorldMemory));
            if (useWorldId) Check.Equal(owner.Snapshot.Version, state.Version);
            var saved = host.App.Services.GetRequiredService<HarnessRunStore>().Read(id, PartyEngine.HostId, run.Id)!;
            var search = saved.Steps.Single(s => s.ToolName == "world_search").Outcome!;
            Check.True(search.OfferedIds is null && search.OfferedMemoryIds!.SequenceEqual([OldNpc]));
        }
    }

    public static async Task ReferenceLeasesExpireAndNeverCrossRuns()
    {
        foreach (string mode in new[] { "wait", "write", "other-run", "history" })
        {
            var model = new Model((n, request) =>
            {
                if (request.Messages.LastOrDefault(m => m.Role == "tool") is { IsError: true } rejected)
                {
                    using var response = JsonDocument.Parse(rejected.Content);
                    Check.Equal("invalid_world_memory", response.RootElement.GetProperty("code").GetString());
                    Check.True(!response.RootElement.GetProperty("protocol").GetProperty("applied").GetBoolean());
                    return Tool("ask_player", new { question = "此引用已失效，下一步？" });
                }
                if (n == 1) return Tool(mode == "history" ? "memory_search" : "world_search", new { query = "旧船长" });
                if (n == 2 && mode is "wait" or "other-run") return Tool("ask_player", new { question = "下一步？" });
                if (n == 2 && mode == "write") return Intermediate();
                // OldNpc is outside the bounded automatic frame; replayed search must not regrant it.
                return Record(Update());
            });
            await using var host = await Host.Start(configure: Configure(model)); var owner = await Create(host, Document()); string id = owner.Snapshot.Id;
            var run = await Start(host, owner.Snapshot); run = await Settled(host, id, run.Id);
            if (mode is "wait" or "other-run")
            {
                Check.Equal("waiting", run.Status);
                if (mode == "wait") await Post<HarnessRunView>(host, id, $"harness/runs/{run.Id}/resume", new HarnessResumeRequest(Id(), run.Version, "继续"));
                else
                {
                    await host.Http.PostAsync($"/api/v1/campaigns/{id}/harness/runs/{run.Id}/cancel", null);
                    run = await Start(host, (await host.Get(id))!);
                }
                run = await Settled(host, id, run.Id);
            }
            Check.Equal("waiting", run.Status); Check.Equal("", run.Error);
            Check.Equal("此引用已失效，下一步？", run.Wait!.Question);
            var snapshot = (await host.Get(id))!; Check.Equal(1, snapshot.WorldMemory!.Single(m => m.Id == OldNpc).Revision);
            Check.Equal(owner.Snapshot.Version + (mode == "write" ? 1 : 0), snapshot.Version);
            var saved = host.App.Services.GetRequiredService<HarnessRunStore>().Read(id, PartyEngine.HostId, run.Id)!;
            Check.Equal(1, saved.Steps.Count(s => s.ToolName == "world_record" && s.Outcome?.Reply.IsError == true));
            Check.True(!(saved.OfferedMemoryIds ?? []).Contains(OldNpc), mode + " must not regrant replayed references");
        }
    }

    public static async Task RealPiBusinessUpdateAndRestart()
    {
        string oldReply = "";
        var model = new Model((n, request) =>
        {
            if (n == 1) return Tool("context_read");
            if (n == 2)
            {
                var context = Output(request, "context_read").GetProperty("context");
                Check.True(context.GetProperty("knownMemory").EnumerateArray().All(m => m.GetProperty("id").GetString() != OldNpc));
                return Tool("world_search", new { query = "旧船长 copperkey", kind = "npc" });
            }
            if (n == 3)
            {
                Check.Equal(OldNpc, Output(request, "world_search").GetProperty("entries")[0].GetProperty("id").GetString());
                return Intermediate(Update());
            }
            if (n == 4) return Tool("world_search", new { query = "旧委托", kind = "quest" });
            if (n == 5)
            {
                oldReply = request.Messages.Last(m => m.Name == "world_search").Content;
                return Tool("ask_player", new { question = "是否继续整理委托线索？" });
            }
            if (n == 6)
            {
                Check.Equal(oldReply, request.Messages.Last(m => m.Name == "world_search").Content);
                return Tool("world_search", new { query = "旧委托", kind = "quest" }); // must refresh after the wait
            }
            if (n == 7) return Record(Update(OldQuest, "已经收到公开的灯塔回信，尚未结算奖励。"));
            Check.Equal(8, n); return Text("船长记录和旧委托均已更新；没有旅行、检定或奖励结算。");
        });
        var configure = Configure(model, extra: b => { b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry(); b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>(); });
        var dice = new SequenceDice(); var host = await Host.Start(dice: dice, configure: configure);
        try
        {
            var create = await host.Http.PostAsJsonAsync("/api/v1/campaigns/from-content", new CreateCampaignFromContentRequest("世界检索回归", "Arden", Document(), Preset.SystemPrompt, [], Build: FullCreationTests.Named("Arden")));
            Check.Equal(HttpStatusCode.Created, create.StatusCode); var owner = (await create.Content.ReadFromJsonAsync<CreatedCampaign>())!;
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken); string id = owner.Snapshot.Id;
            var request = new AdventureActionRequest(Id(), owner.Snapshot.Version, "找旧船长核对地图，再整理早期委托。");
            var start = await Post<AdventureSessionView>(host, id, "adventure/actions", request);
            var run = await Settled(host, id, start.SessionId, 3000); Check.True(run.Status == "waiting", run.Status + "/" + run.Error);
            Check.Equal(5, model.Calls); Check.Equal(owner.Snapshot.Version + 1, run.Version); Check.Equal(0, dice.Count);
            var store = host.App.Services.GetRequiredService<HarnessRunStore>(); var saved = store.Read(id, PartyEngine.HostId, run.Id)!;
            Check.True(saved.OfferedMemoryIds is null); // waiting revokes even same-version frame/search references
            string prefix = HarnessJson.Serialize(saved.Steps); int prefixCount = saved.Steps.Count;
            string root = host.Root; await host.DisposeAsync(); host = await Host.Start(root, dice: dice, configure: configure);
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            Check.True((await Post<AdventureSessionView>(host, id, "adventure/actions", request)).Replayed); Check.Equal(5, model.Calls);
            var resume = new AdventureActionRequest(Id(), run.Version, "继续整理，但不要结算奖励");
            await Post<AdventureSessionView>(host, id, $"adventure/sessions/{run.Id}/continue", resume);
            run = await Settled(host, id, run.Id, 3000); Check.True(run.Status == "completed", run.Status + "/" + run.Error);
            var state = (await host.Get(id))!;
            Check.Equal(2, state.WorldMemory!.Single(m => m.Id == OldNpc).Revision); Check.Equal(2, state.WorldMemory!.Single(m => m.Id == OldQuest).Revision);
            Check.Equal(owner.Snapshot.WorldMemory!.Length, state.WorldMemory!.Length); Check.Equal(7, model.Calls); Check.Equal(0, dice.Count);
            Check.Equal(HarnessJson.Serialize(owner.Snapshot.Character), HarnessJson.Serialize(state.Character));
            Check.Equal(HarnessJson.Serialize(owner.Snapshot.Map), HarnessJson.Serialize(state.Map)); Check.Equal(owner.Snapshot.ElapsedSeconds, state.ElapsedSeconds);
            saved = host.App.Services.GetRequiredService<HarnessRunStore>().Read(id, PartyEngine.HostId, run.Id)!;
            Check.True(saved.OfferedMemoryIds is null); Check.Equal(prefix, HarnessJson.Serialize(saved.Steps.Take(prefixCount).ToList()));
            Check.True((await Post<AdventureSessionView>(host, id, $"adventure/sessions/{run.Id}/continue", resume)).Replayed);
            Check.Equal(7, model.Calls); Check.Equal("记录新的公开交谈。", run.Text); Check.True(model.Requests.All(r => r.System == Preset.SystemPrompt));
            foreach (var r in model.Requests)
                foreach (string secret in new[] { "HOST-SECRET", "FUTURE-SECRET", "PRIVATE-DM-REASON" })
                    Check.True(!HarnessJson.Serialize(r).Contains(secret));
            Console.WriteLine("WORLD real Pi/MCP: 44 imported objects, two outside context updated by original ID; 7 fake model calls; restart replay, 0 dice/resources/routes");
        }
        finally { await host.DisposeAsync(); }
    }

    private sealed class DisconnectAfter(string name) : IHarnessRuntime
    {
        public Task<HarnessCompletion> Execute(HarnessExecution execution, Func<HarnessCallback, CancellationToken, Task<JsonElement>> callback, CancellationToken ct) =>
            new Loop().Execute(execution, async (call, token) =>
            {
                var reply = await callback(call, token);
                if (call.Kind == "tool" && HarnessJson.Read<HarnessToolRequest>(call.Payload).Name == name) throw new IOException("fixture child disconnect");
                return reply;
            }, ct);
    }
    public static async Task InterruptedReadAndCommittedWriteRecovery()
    {
        foreach (string at in new[] { "world_search", "world_record" })
        {
            var model = new Model((n, _) => n switch { 1 => Tool("world_search", new { query = "旧船长" }), 2 => Record(Update()), _ => Text("原对象已经更新一次。") });
            var host = await Host.Start(configure: Configure(model, new DisconnectAfter(at)));
            try
            {
                var owner = await Create(host, Document()); string id = owner.Snapshot.Id;
                var run = await Start(host, owner.Snapshot); run = await Settled(host, id, run.Id); Check.Equal("interrupted", run.Status);
                var store = host.App.Services.GetRequiredService<HarnessRunStore>(); var saved = store.Read(id, PartyEngine.HostId, run.Id)!;
                int version = saved.Version; string? original = null;
                if (at == "world_record")
                {
                    var step = saved.Steps.Single(s => s.ToolName == at); original = step.Result!.Value.GetRawText();
                    step.Status = "started"; step.Result = null; step.Outcome = null;
                    saved.Version = owner.Snapshot.Version; saved.OfferedMemoryIds = [OldNpc];
                    store.Save(saved); // campaign committed, Run journal lost only the write output
                }
                else
                {
                    Check.True(saved.OfferedMemoryIds!.Contains(OldNpc));
                    var frameIds = saved.Steps.Last(s => s.Kind == "model").ExecutionFrame!.Context.KnownMemory.Select(m => m.Id);
                    Check.True(saved.OfferedMemoryIds!.All(x => x == OldNpc || frameIds.Contains(x)));
                }
                string root = host.Root; await host.DisposeAsync(); host = await Host.Start(root, configure: Configure(model));
                host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
                await Post<HarnessRunView>(host, id, $"harness/runs/{run.Id}/resume", new HarnessResumeRequest(Id(), version));
                run = await Settled(host, id, run.Id); Check.True(run.Status == "completed", run.Status + "/" + run.Error);
                Check.Equal(2, model.Calls); Check.Equal(2, (await host.Get(id))!.WorldMemory!.Single(m => m.Id == OldNpc).Revision);
                saved = host.App.Services.GetRequiredService<HarnessRunStore>().Read(id, PartyEngine.HostId, run.Id)!;
                Check.True(saved.OfferedMemoryIds is null);
                if (original is not null) Check.Equal(original, saved.Steps.Single(s => s.ToolName == "world_record").Result!.Value.GetRawText());
            }
            finally { await host.DisposeAsync(); }
        }
    }

    public static async Task FrozenV2AndCorruptReferencePreservation()
    {
        Check.Equal("488b5eeb31b64448e403574ff6e6ed577e3eb03695275d3b241a01223c51ad25", HarnessJson.Fingerprint(HarnessJson.Element(HarnessTools.ForVersion(2))));
        Check.True(!HarnessJson.Element(new HarnessToolOutcome(1, new("old"))).TryGetProperty("offeredMemoryIds", out _));
        var model = new Model((n, request) =>
        {
            Check.True(request.Tools.All(t => t.Name != "world_search"));
            if (n == 1) return Record(new WorldMemoryProposal("local-0", "clue", "港口记录0", "旧契约不强制新引用。", "known", "harbor"));
            if (n == 2) return Tool("ask_player", new { question = "旧v2等待。" });
            if (n == 3) return Tool("memory_search", new { query = "" });
            Check.Equal(4, n); return Text("旧v2历史召回和恢复保持。");
        });
        var configure = Configure(model, extra: b => { b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry(); b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>(); });
        var host = await Host.Start(configure: configure);
        try
        {
            var owner = await Create(host, Document()); string id = owner.Snapshot.Id;
            var game = host.App.Services.GetRequiredService<GameService>(); var auth = await game.AuthorizeHarness(id, owner.AccessToken, default);
            var legacy = new HarnessRun { Id = Id(), IntentId = Id(), CampaignId = id, ActorId = auth.ActorId, Fingerprint = new string('a', 64), Input = "旧v2",
                Profile = auth.Profile, Limits = new(), Version = owner.Snapshot.Version, ToolContractVersion = 2, Turns = [HarnessJson.Serialize(new { input = "旧v2", ruleset = "dnd2024" })] };
            host.App.Services.GetRequiredService<HarnessRunStore>().Create(legacy);
            await Post<HarnessRunView>(host, id, $"harness/runs/{legacy.Id}/resume", new HarnessResumeRequest(Id(), legacy.Version));
            var run = await Settled(host, id, legacy.Id, 3000); Check.True(run.Status == "waiting", run.Status + "/" + run.Error);
            var saved = host.App.Services.GetRequiredService<HarnessRunStore>().Read(id, auth.ActorId, legacy.Id)!;
            Check.True(saved.OfferedMemoryIds is null && saved.Steps.All(s => s.Outcome?.OfferedMemoryIds is null));
            string prefix = HarnessJson.Serialize(saved.Steps); int count = saved.Steps.Count; string root = host.Root;
            await host.DisposeAsync(); host = await Host.Start(root, configure: configure); host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            await Post<HarnessRunView>(host, id, $"harness/runs/{run.Id}/resume", new HarnessResumeRequest(Id(), run.Version, "继续"));
            run = await Settled(host, id, run.Id, 3000); Check.True(run.Status == "completed", run.Status + "/" + run.Error); Check.Equal(4, model.Calls);
            saved = host.App.Services.GetRequiredService<HarnessRunStore>().Read(id, auth.ActorId, legacy.Id)!;
            Check.Equal(prefix, HarnessJson.Serialize(saved.Steps.Take(count).ToList())); Check.Equal(2, saved.ToolContractVersion);
            string file = Path.Combine(root, "harness", id, JsonFiles.Hash(auth.ActorId), "closed", legacy.Id[..2], legacy.Id + ".json");
            string original = File.ReadAllText(file);
            var invalid = new (int Version, string[] Refs)[] { (2, [OldNpc]), (3, [OldNpc, OldNpc]), (3, ["../file"]), (3, [""]), (3, Enumerable.Range(0, 257).Select(i => "id-" + i).ToArray()), (99, []) };
            foreach (var entry in invalid)
            {
                var json = JsonNode.Parse(original)!.AsObject(); json["toolContractVersion"] = entry.Version; json["offeredMemoryIds"] = JsonSerializer.SerializeToNode(entry.Refs);
                File.WriteAllText(file, json.ToJsonString()); string corrupt = File.ReadAllText(file);
                Error("harness_corrupt_run", () => host.App.Services.GetRequiredService<HarnessRunStore>().Read(id, auth.ActorId, legacy.Id));
                Check.Equal(corrupt, File.ReadAllText(file));
            }
            File.WriteAllText(file, original);
        }
        finally { await host.DisposeAsync(); }
    }
}
