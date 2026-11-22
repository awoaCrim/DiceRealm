using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class EncounterContinuationTests
{
    private static async Task<HarnessToolOutcome> Call(Host h, CreatedCampaign owner, string name, object args,
        string? intent = null, MapAssetView? map = null, string? command = null, int contract = 47)
    {
        var game = h.App.Services.GetRequiredService<GameService>();
        var auth = await game.AuthorizeHarness(owner.Snapshot.Id, owner.AccessToken, default);
        var json = HarnessJson.Element(args);
        return await game.HarnessTool(owner.Snapshot.Id, owner.AccessToken, auth.ActorId, intent ?? Id(), "隔离实际行动", auth.Version,
            command ?? Id(), HarnessJson.Fingerprint(json), new(name, json, "fixture"), [], default, auth.Profile, contract, contextAlreadyRead: true,
            suppliedBoardMap: map is null ? null : new(map.Id, map.Title, map.Version, map.ContentHash, map.ImageUrl, map.Width, map.Height, map.Grid));
    }

    private static async Task Refused(Func<Task<HarnessToolOutcome>> call, string code)
    {
        try { await call(); throw new Exception("Expected rejection: " + code); }
        catch (GameException e) { Check.Equal(code, e.Code); }
    }

    public static async Task SingleAttemptAcrossInputsAndRestart()
    {
        const string first = "木门上的细小刻痕需DC 12 Wisdom (Perception)。", second = "石箱底部的缝隙需DC 12 Wisdom (Perception)。", legacyQuote = "墙面的纹理需DC 12 Wisdom (Perception)。";
        var model = new Model((_, _) => throw new Exception("No provider calls"));
        var dice = new SequenceDice(16, 15, 14, 13);
        var configure = Configure(model); var h = await Host.Start(dice: dice, configure: configure);
        try
        {
            var owner = await Create(h, TestContent.Document with { InitialKnowledge = [new("objects", "clue", "两个独立目标", first + second + legacyQuote, "harbor", "host")] });
            var peer = await HarnessBoundaryTests.Guest(h, owner); string id = owner.Snapshot.Id;
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var spec = new HarnessCheckV44Args("wisdom", "Perception", "normal", "objects", first, Dc: 12);
            string intent = Id();
            var passive = await Call(h, owner, "check_request", spec with { Passive = true }, intent);
            Check.Equal(0, dice.Count); Check.True(passive.Wait is null);
            var active = await Call(h, owner, "check_request", spec, intent); // Same input: passive does not consume the first active attempt.
            var roll = new RollResponseRequest(Id(), active.Version, active.Wait!.Id, "roll");
            await Post<ActionResponse>(h, id, "rolls/respond", roll); Check.Equal(1, dice.Count);
            Check.True((await Post<ActionResponse>(h, id, "rolls/respond", roll)).Replayed); Check.Equal(1, dice.Count);
            foreach (bool isPassive in new[] { false, true })
                await Refused(() => Call(h, owner, "check_request", spec with { Passive = isPassive, Mode = "advantage" }), "check_already_requested");
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, dice: dice, configure: configure);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            await Refused(() => Call(h, owner, "check_request", spec), "check_already_requested"); Check.Equal(1, dice.Count);
            // A different concrete task in the same source is not locked out. Cancellation consumes no attempt.
            var other = spec with { Quote = second };
            var cancelled = await Call(h, owner, "check_request", other);
            await Post<ActionResponse>(h, id, "rolls/respond", new RollResponseRequest(Id(), cancelled.Version, cancelled.Wait!.Id, "cancel"));
            var retried = await Call(h, owner, "check_request", other);
            await Post<ActionResponse>(h, id, "rolls/respond", new RollResponseRequest(Id(), retried.Version, retried.Wait!.Id, "roll"));
            Check.Equal(2, dice.Count);
            // Separate save triggers remain valid even with identical source and ability.
            for (int i = 0; i < 2; i++)
            {
                var save = await Call(h, owner, "check_request", spec with { Ability = "dexterity", Skill = "", CheckType = "save" });
                await Post<ActionResponse>(h, id, "rolls/respond", new RollResponseRequest(Id(), save.Version, save.Wait!.Id, "roll"));
            }
            Check.Equal(4, dice.Count);
            await Refused(() => Call(h, owner, "check_request", spec with { Reason = "换一种说法再次查看同一刻痕。" }), "check_already_requested");
            await h.App.Services.GetRequiredService<CampaignStore>().Access(id, owner.AccessToken, true, c =>
            {
                c.ActingCharacter = c.ActingCharacter with { Inventory = [.. c.ActingCharacter.Inventory, new("fixture-lens", "放大镜", 1, false)] };
                return Task.FromResult(true);
            }, default);
            var changed = await Call(h, owner, "check_request", spec with { Reason = "现在取得放大镜，可辨认原先无法分辨的细小刻痕；这是实际改变的观察条件。" });
            Check.Equal("roll", changed.Wait!.Kind);
            await Post<ActionResponse>(h, id, "rolls/respond", new RollResponseRequest(Id(), changed.Version, changed.Wait.Id, "cancel"));
            var history = await Call(h, owner, "checks_result", new { scope = "scene", offset = 0, limit = 2 });
            using var own = JsonDocument.Parse(history.Reply.Content);
            Check.Equal(2, own.RootElement.GetProperty("entries").GetArrayLength());
            Check.True(own.RootElement.GetProperty("nextOffset").GetInt32() == 2);
            var privateHistory = await Call(h, peer, "checks_result", new { scope = "scene" });
            using var empty = JsonDocument.Parse(privateHistory.Reply.Content);
            Check.Equal(0, empty.RootElement.GetProperty("total").GetInt32());
            var legacy = await Call(h, owner, "check_request", spec with { Quote = legacyQuote }, contract: 46);
            await Post<ActionResponse>(h, id, "rolls/respond", new RollResponseRequest(Id(), legacy.Version, legacy.Wait!.Id, "roll"));
            await Refused(() => Call(h, owner, "check_request", spec with { Quote = legacyQuote, Reason = "换句话查看原纹理。" }), "check_already_requested");
            Check.Equal(5, dice.Count);
            var independent = await Call(h, peer, "check_request", spec);
            Check.Equal("roll", independent.Wait!.Kind); Check.Equal(5, dice.Count); Check.Equal(0, model.Calls);
        }
        finally { await h.DisposeAsync(); }
    }

    public static async Task MapFailureCancellationAndRestartDoNotRegenerate()
    {
        foreach (string terminal in new[] { "failed", "withheld", "cancel", "restart" })
        {
            string originalMap = ""; int originalVersion = 0; Exception? failure = null;
            var images = new Images();
            var model = new Model((call, request) =>
            {
                try
                {
                    if (call is 1 or 3) return Tool("map_request", new { kind = "battle", purpose = "tactical", tacticalScale = new { longEdgeFeet = 120 } });
                    var previous = request.Messages.Last(m => m.Role == "tool");
                    if (call == 2)
                    {
                        Check.True(previous.IsError == true); Check.True(previous.Content.Contains("map_selection_required"));
                        return Tool("map_select", new { mapId = originalMap, mapVersion = originalVersion });
                    }
                    Check.Equal(4, call); Check.True(previous.IsError == true);
                    using var response = JsonDocument.Parse(previous.Content);
                    Check.Equal(terminal == "withheld" ? "withheld" : "failed", response.RootElement.GetProperty("map").GetProperty("status").GetString());
                    return Tool("world_record", new NarrativeHarnessArgs("补充地图未能就绪；现有处境和地图保持不变。", []));
                }
                catch (Exception error) { failure = error; throw; }
            });
            var configure = Configure(model); var h = await Host.Start(images: images, configure: configure);
            try
            {
                var owner = await Create(h); string id = owner.Snapshot.Id;
                var catalog = h.App.Services.GetRequiredService<MapCatalog>();
                var map = SharedBoardTests.Install(h, id, png: SharedBoardTests.MapPng(768, 512));
                map = catalog.ConfigureGrid(id, map.Id, new(Id(), map.Version, new() { Type = "none", Uncalibrated = true }, "schematic"));
                map = catalog.Publish(id, map.Id, new(Id(), map.Version, true, true)); originalMap = map.Id; originalVersion = map.Version;
                var input = new HarnessInputRequest(Id(), (await h.Get(id))!.Version, "补充局部地图，保留当前图。");
                var run = await Post<HarnessRunView>(h, id, "harness/runs", input);
                await AssetTests.Until(() =>
                {
                    if (failure is not null) throw failure;
                    return Task.FromResult(images.Calls == 1);
                });
                Check.Equal(3, model.Calls);
                var library = (await h.Http.GetFromJsonAsync<MapLibraryView>($"/api/v1/campaigns/{id}/maps"))!;
                Check.Equal(originalMap, library.SelectedMapId);
                var pendingMap = library.Maps.Single(m => m.Id != originalMap);
                if (terminal == "failed") images.Result.SetException(new ImageGenerationException("isolated_failure", false));
                else if (terminal == "withheld") catalog.Publish(id, pendingMap.Id, new(Id(), pendingMap.Version, false, true));
                else if (terminal == "cancel")
                {
                    Check.True((await h.Http.PostAsync($"/api/v1/campaigns/{id}/harness/runs/{run.Id}/cancel", null)).IsSuccessStatusCode);
                    run = await Settled(h, id, run.Id);
                    Check.True(run.Status is "cancelled" or "interrupted", run.Status + "/" + run.Error);
                    images.Result.SetResult(SharedBoardTests.MapPng(1200, 800));
                    await AssetTests.Until(() => Task.FromResult(catalog.Get(id, pendingMap.Id, true).Status == "ready"));
                    Check.Equal(3, model.Calls); Check.Equal(1, images.Calls);
                    Check.Equal(originalMap, (await h.Http.GetFromJsonAsync<MapLibraryView>($"/api/v1/campaigns/{id}/maps"))!.SelectedMapId);
                    continue;
                }
                else
                {
                    string data = h.Root; await h.DisposeAsync(); h = await Host.Start(data, images: images, configure: configure);
                    h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
                    // Graceful service shutdown cancels this Run; it is not permission to\n                    // silently replay the player's input. A fresh tool sees the same failed job.\n                    Check.Equal(System.Net.HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/harness/runs/{run.Id}/resume",\n                        new HarnessResumeRequest(Id(), (await h.Get(id))!.Version))).StatusCode);
                    var next = await Call(h, owner, "map_request", new { kind = "battle", purpose = "tactical", tacticalScale = new { longEdgeFeet = 120 } });
                    Check.True(next.Reply.IsError);
                    using var status = JsonDocument.Parse(next.Reply.Content);
                    Check.Equal("failed", status.RootElement.GetProperty("map").GetProperty("status").GetString());
                    Check.Equal(3, model.Calls); Check.Equal(1, images.Calls);
                    Check.Equal(originalMap, (await h.Http.GetFromJsonAsync<MapLibraryView>($"/api/v1/campaigns/{id}/maps"))!.SelectedMapId);
                    continue;
                }
                run = await Settled(h, id, run.Id);
                if (failure is not null) throw new Exception("Scripted model failed", failure);
                Check.Equal("completed", run.Status); Check.Equal(4, model.Calls); Check.Equal(1, images.Calls);
                Check.Equal(originalMap, (await h.Http.GetFromJsonAsync<MapLibraryView>($"/api/v1/campaigns/{id}/maps"))!.SelectedMapId);
                string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, images: images, configure: configure);
                h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
                Check.True((await Post<HarnessRunView>(h, id, "harness/runs", input)).Replayed);
                Check.Equal(1, images.Calls); Check.Equal(4, model.Calls);
            }
            finally { images.Result.TrySetCanceled(); await h.DisposeAsync(); }
        }
    }

    private sealed class PrematureDelegate : IHarnessRuntime
    {
        public async Task<HarnessCompletion> Execute(HarnessExecution execution, Func<HarnessCallback, CancellationToken, Task<JsonElement>> callback, CancellationToken ct)
        {
            async Task<HarnessToolReply> Invoke(int sequence, string name, object args) => HarnessJson.Read<HarnessToolReply>(await callback(
                new($"0:tool:{sequence}", "tool", 0, sequence, HarnessJson.Element(new HarnessToolRequest(name, HarnessJson.Element(args), "injected-" + sequence))), ct));
            await Invoke(0, "context_read", new { });
            var refused = await Invoke(1, "combat_delegate", new CombatDelegateArgs("runtime-" + Id(), "错误的提前委派", []));
            Check.True(refused.IsError); Check.True(refused.Content.Contains("encounter_setup_unavailable"));
            var final = await Invoke(2, "world_record", new NarrativeHarnessArgs("尚未建立交锋，继续处理现场。", []));
            return new(final.Stop, "", 0, 3);
        }
    }

    public static async Task PrematureDelegateIsRecoverable()
    {
        var dice = new SequenceDice(); var model = new Model((_, _) => throw new Exception("No model expected"));
        await using var h = await Host.Start(dice: dice, configure: Configure(model, new PrematureDelegate()));
        var response = await h.Http.PostAsJsonAsync("/api/v1/harness/campaigns", new CreateHarnessCampaignRequest("隔离越界工具调用", "Arden", TestContent.Document,
            Preset with { CombatSystemPrompt = "隔离战斗主持" }, Build: FullCreationTests.Named("Arden", CharacterEngine.Fighter)));
        Check.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        var owner = (await response.Content.ReadFromJsonAsync<CreatedCampaign>())!; h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        var run = await Start(h, owner.Snapshot); run = await Settled(h, owner.Snapshot.Id, run.Id);
        Check.True(run.Status == "completed", run.Status + "/" + run.Error);
        Check.Equal(0, dice.Count); Check.Equal(0, model.Calls); Check.True((await h.Get(owner.Snapshot.Id))!.Combat is null);
    }

    private sealed class Images : IMapImageGenerator
    {
        public bool Enabled => true;
        public string CacheIdentity => "encounter-continuation-isolated";
        public int Calls;
        public TaskCompletionSource<byte[]> Result { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public Task<byte[]> Generate(MapGenerationJob job, CancellationToken ct)
        { Interlocked.Increment(ref Calls); return Result.Task.WaitAsync(ct); }
    }

    public static async Task RealPiWaitsForMapThenEngagesOriginalEncounter()
    {
        const string source = "ambush", quote = "PRIVATE_CONTINUATION_SOURCE", battlePrompt = "隔离独立战斗主持原文";
        string originalMap = "", tacticalMap = "", player = "", encounter = "", enemy = "", actor = ""; int mapVersion = 0;
        Exception? failure = null;
        var images = new Images();
        var model = new Model((call, request) =>
        {
            try
            {
                var frame = HarnessExecutionProtocolTests.Frame(request);
                var prior = request.Messages.LastOrDefault(m => m.Role == "tool");
                Check.True(prior?.IsError != true, prior?.Content ?? "No previous tool");
                if (call == 1)
                {
                    Check.True(!request.Tools.Any(t => t.Name == "combat_delegate"));
                    Check.Equal(originalMap, frame.GetProperty("board").GetProperty("state").GetProperty("map").GetProperty("id").GetString());
                    return Tool("map_request", new { kind = "battle", purpose = "tactical", tacticalScale = new { longEdgeFeet = 120 } });
                }
                if (call == 2)
                {
                    using var result = JsonDocument.Parse(prior!.Content);
                    Check.Equal("ready", result.RootElement.GetProperty("map").GetProperty("status").GetString());
                    tacticalMap = result.RootElement.GetProperty("map").GetProperty("id").GetString()!;
                    Check.Equal(originalMap, frame.GetProperty("board").GetProperty("state").GetProperty("map").GetProperty("id").GetString());
                    mapVersion = frame.GetProperty("board").GetProperty("maps").EnumerateArray().Single(m => m.GetProperty("id").GetString() == tacticalMap).GetProperty("version").GetInt32();
                    return Tool("map_select", new { mapId = tacticalMap, mapVersion });
                }
                if (call == 3) return Tool("token_spawn", new { mapId = tacticalMap, spawns = new[] {
                    new { existingId = player, kind = "creature", source = new { kind = "existing" }, appearance = new { name = "本人" }, x = 1.5 / 24, y = 2.5 / 16 } } });
                if (call == 4) return Tool("encounter_prepare", new HarnessEncounterPrepareV46(tacticalMap, source, quote, "按新局部图原实例和实际掩护绑定。",
                    [new("xmm:goblin-warrior", "枯牙", "ranged", 5.5 / 24, 2.5 / 16)], [new(3, 2, "three-quarters-cover")], encounter));
                if (call == 5)
                {
                    Check.True(request.Tools.Any(t => t.Name == "combat_delegate"));
                    return Tool("combat_delegate", new CombatDelegateArgs(encounter, "玩家已经明确发起射击，先进入真实先攻。", []));
                }
                Check.Equal(6, call); Check.Equal(battlePrompt, request.System);
                Check.Equal("combat", frame.GetProperty("agent").GetProperty("role").GetString());
                return Tool("encounter_engage", new HarnessEncounterEngage(encounter, "现在发生真实敌对交锋。", []));
            }
            catch (Exception e) { failure = e; throw; }
        });
        var dice = new SequenceDice(10, 20, 18, 4);
        var configure = Configure(model, extra: b =>
        { b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry(); b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>(); });
        var h = await Host.Start(images: images, dice: dice, configure: configure);
        try
        {
            var document = TestContent.Document with { InitialKnowledge = [new(source, "clue", "伏兵依据", quote, "harbor", "host")] };
            var created = await h.Http.PostAsJsonAsync("/api/v1/harness/campaigns", new CreateHarnessCampaignRequest("隔离战斗衔接", "Arden", document,
                Preset with { CombatSystemPrompt = battlePrompt }, Build: FullCreationTests.Named("Arden", CharacterEngine.Fighter)));
            Check.True(created.IsSuccessStatusCode, await created.Content.ReadAsStringAsync());
            var owner = (await created.Content.ReadFromJsonAsync<CreatedCampaign>())!;
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            string id = owner.Snapshot.Id; actor = owner.Snapshot.Party!.SelfActorId;
            var catalog = h.App.Services.GetRequiredService<MapCatalog>();
            var map = SharedBoardTests.Install(h, id, png: SharedBoardTests.MapPng(768, 512));
            map = catalog.ConfigureGrid(id, map.Id, new(Id(), map.Version, new() { Type = "none", Uncalibrated = true }, "schematic"));
            map = catalog.Publish(id, map.Id, new(Id(), map.Version, true, true)); originalMap = map.Id;
            var placed = await SharedBoardTests.BoardPost<BoardCommandResponse>(h, id, "board/commands", new BoardCommandRequest(Id(), (await h.Get(id))!.Version,
                map.Id, "spawn", Spawns: [new("", "creature", new("player", actor), new("本人"), .1, .3, actor)], ExpectedMapVersion: map.Version));
            player = placed.Result.EntityIds.Single();
            var prepared = await Call(h, owner, "encounter_prepare", new HarnessEncounterPrepareV46(map.Id, source, quote, "原图只供观察，不推算距离。",
                [new("xmm:goblin-warrior", "枯牙", "ranged", .5, .3, "three-quarters-cover", "作者明确灌木后脱离视线。")], []), map: map);
            using (var parsed = JsonDocument.Parse(prepared.Reply.Content)) encounter = parsed.RootElement.GetProperty("encounter").GetProperty("definition").GetProperty("id").GetString()!;
            Check.Equal(1, dice.Count);
            var spec = new HarnessCheckV44Args("wisdom", "Perception", "normal", source, quote, EncounterId: encounter);
            string search = Id();
            await Call(h, owner, "check_request", spec with { Passive = true }, search);
            var pending = await Call(h, owner, "check_request", spec, search);
            await Post<ActionResponse>(h, id, "rolls/respond", new RollResponseRequest(Id(), pending.Version, pending.Wait!.Id, "roll"));
            Check.Equal(2, dice.Count);
            string stealth = "", discoveries = "";
            await h.App.Services.GetRequiredService<CampaignStore>().Access(id, owner.AccessToken, true, c =>
            {
                var instance = c.Board!.Entities.Single(e => e.Source.Kind == "enemy"); enemy = instance.Id;
                c.Board.Entities[c.Board.Entities.IndexOf(instance)] = instance with { Statistics = instance.Statistics! with { HitPoints = 3, TemporaryHitPoints = 2, Conditions = ["Poisoned"] } };
                return Task.FromResult(true);
            }, default);
            await Call(h, owner, "world_record", new NarrativeHarnessArgs("仔细观察了周围。", [], PrivateMessages: [new([actor], "你发现了灌木后的枯牙。", [enemy])]), search);
            await Refused(() => Call(h, owner, "check_request", spec), "check_already_requested");
            await h.App.Services.GetRequiredService<CampaignStore>().Access(id, owner.AccessToken, false, c =>
            {
                stealth = HarnessJson.Serialize(RuntimeEncounters.Current(c)!.Concealment);
                discoveries = HarnessJson.Serialize(RuntimeEncounters.Current(c)!.Observations);
                return Task.FromResult(true);
            }, default);
            var input = new HarnessInputRequest(Id(), (await h.Get(id))!.Version, "躲入阴影处，朝着最近的那个身影射出一箭。");
            var run = await Post<HarnessRunView>(h, id, "harness/runs", input);
            using var startup = new CancellationTokenSource(TimeSpan.FromSeconds(100));
            while (images.Calls != 1)
            {
                if (failure is not null) throw new Exception("Scripted model failed before image", failure);
                var progress = (await h.Http.GetFromJsonAsync<HarnessRunView>($"/api/v1/campaigns/{id}/harness/runs/{run.Id}"))!;
                Check.True(progress.Status == "running", progress.Status + "/" + progress.Error + "/calls=" + model.Calls);
                await Task.Delay(75, startup.Token);
            }
            await Task.Delay(TimeSpan.FromSeconds(62)); // Cross the MCP SDK default 60s deadline.
            Check.Equal(1, model.Calls); Check.Equal(2, dice.Count);
            var library = (await h.Http.GetFromJsonAsync<MapLibraryView>($"/api/v1/campaigns/{id}/maps"))!;
            Check.Equal(originalMap, library.SelectedMapId);
            var stored = h.App.Services.GetRequiredService<HarnessRunStore>().Read(id, actor, run.Id)!;
            var step = stored.Steps.Single(s => s.ToolName == "map_request"); Check.Equal("started", step.Status);
            AutomaticMapResponse Receipt()
            {
                foreach (string path in Directory.GetFiles(Path.Combine(h.Root, "maps", id), "*.json"))
                {
                    using var record = JsonDocument.Parse(File.ReadAllText(path));
                    if (!record.RootElement.TryGetProperty("automaticReceipts", out var receipts) ||
                        !receipts.TryGetProperty(JsonFiles.Hash(actor + ":" + step.CommandId), out var receipt)) continue;
                    Check.Equal("harness:" + step.Fingerprint, receipt.GetProperty("fingerprint").GetString());
                    return HarnessJson.Read<AutomaticMapResponse>(receipt.GetProperty("response"));
                }
                throw new Exception("Missing queue receipt");
            }
            // Original map queue receipt stays pending even after the Run's eventual ready output.
            var queued = Receipt();
            Check.True(queued.Map.Status is "pending" or "generating");
            images.Result.SetResult(SharedBoardTests.MapPng(1200, 800));
            run = await Settled(h, id, run.Id, 3000);
            Check.Equal("delegated", run.Status);
            var session = await h.App.Services.GetRequiredService<CampaignStore>().Access(id, owner.AccessToken, false,
                c => Task.FromResult(CombatAgentSessions.Current(c)!));
            var child = await Settled(h, id, session.Inputs[0].RunId, 3000);
            Check.True(child.Status == "waiting" && child.Wait?.Kind == "roll", child.Status + "/" + child.Error);
            if (failure is not null) throw new Exception("Scripted model failed", failure);
            Check.True(model.Calls == 6, run.Status + "/" + run.Error + "/calls=" + model.Calls); Check.Equal(1, images.Calls);
            var state = (await h.Get(id))!;
            Check.True(state.PendingRoll is not null && state.Combat is null, run.Status + "/" + run.Error);
            Check.Equal(2, dice.Count);
            Check.Equal(HarnessJson.Serialize(queued), HarnessJson.Serialize(Receipt()));
            var initiative = new RollResponseRequest(Id(), state.Version, state.PendingRoll!.Id, "roll");
            var started = await Post<ActionResponse>(h, id, "rolls/respond", initiative);
            Check.True(started.Snapshot.Combat is not null); Check.Equal(4, dice.Count);
            Check.True((await Post<ActionResponse>(h, id, "rolls/respond", initiative)).Replayed); Check.Equal(4, dice.Count);
            await h.App.Services.GetRequiredService<CampaignStore>().Access(id, owner.AccessToken, false, c =>
            {
                var current = RuntimeEncounters.Current(c)!;
                Check.Equal(encounter, current.Definition.Id); Check.Equal(tacticalMap, current.Layout!.MapId);
                Check.Equal(stealth, HarnessJson.Serialize(current.Concealment)); Check.Equal(discoveries, HarnessJson.Serialize(current.Observations));
                var unit = c.Combat!.Units.Single(u => u.Id == enemy); Check.Equal(3, unit.HitPoints); Check.Equal(2, unit.Standard!.TemporaryHitPoints);
                Check.True(unit.Standard.Conditions.Contains("Poisoned"));
                Check.Equal(.1, SharedBoard.PlacementOn(c.Board!.Entities.Single(e => e.Id == player), originalMap)!.X);
                Check.Equal(1, c.Board.Entities.Count(e => e.Source.Kind == "enemy"));
                RuntimeEncounters.ValidateState(c); SharedBoard.ValidateState(c); return Task.FromResult(true);
            }, default);
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, images: images, dice: dice, configure: configure);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            Check.True((await Post<ActionResponse>(h, id, "rolls/respond", initiative)).Replayed);
            Check.True((await Post<HarnessRunView>(h, id, "harness/runs", input)).Replayed);
            Check.Equal(1, images.Calls); Check.Equal(6, model.Calls); Check.Equal(4, dice.Count);
        }
        finally { images.Result.TrySetCanceled(); await h.DisposeAsync(); }
    }
}
