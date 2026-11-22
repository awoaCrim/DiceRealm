using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;
using static DiceRealm.Tests.HarnessExecutionProtocolTests;

namespace DiceRealm.Tests;

internal static class HarnessDmChecklistTests
{
    internal static JsonElement AssertRequest(HarnessModelRequest request)
    {
        Check.Equal(Preset.SystemPrompt, request.System);
        int frames = 0;
        foreach (var message in request.Messages.Where(m => m.Role == "user"))
        {
            try
            {
                using var doc = JsonDocument.Parse(message.Content);
                if (doc.RootElement.ValueKind == JsonValueKind.Object && doc.RootElement.TryGetProperty("kind", out var kind) &&
                    kind.GetString() == "execution_state") frames++;
            }
            catch (JsonException) { }
        }
        Check.Equal(1, frames); // Parent projection must not accumulate in the SDK history.
        return AssertFrame(Frame(request));
    }

    internal static JsonElement AssertFrame(JsonElement frame)
    {
        var checklist = frame.GetProperty("dmChecklist");
        string text = checklist.GetProperty("instructions").GetString()!;
        Check.Equal(HarnessDmChecklist.Text, text);
        foreach (string boundary in new[] { "一、行动意图", "二、移动与位置", "三、检定与投掷", "四、NPC反应、遭遇与战斗状态",
            "五、信息可见性", "六、结果保存与本轮结束", "这些是检查维度，不是固定执行顺序", "已经足够接近时不重复移动",
            "是否适用当前规则下的被动判断", "未进行必要判断不等于失败", "没有造成伤害", "combat为空不单独证明现场安全",
            "公开作者动作的summary/fact不会因为后来写private而收回", "token_move", "checks_result只读取", "complete=false" })
            Check.True(text.Contains(boundary, StringComparison.Ordinal), "Missing full operating boundary: " + boundary);
        var progress = checklist.GetProperty("progress");
        Check.Equal(frame.GetProperty("version").GetInt32(), progress.GetProperty("version").GetInt32());
        Check.Equal(frame.GetProperty("self").GetProperty("actorId").GetString(), progress.GetProperty("actorId").GetString());
        Check.True(!progress.TryGetProperty("remainingActions", out _), "Do not invent a semantic plan from absent receipts");
        return progress;
    }

    public static async Task RealPiSeparatesUnspokenIntentFromCharacterKnowledge()
    {
        string[] inputs = ["直接掉头，回去搬救兵", "我大声说：我要回去搬救兵。", "我转身，想让对方误以为我要逃跑。"];
        string[] boundaries = ["输入给DM不等于角色说出口", "可观察行为", "推断可能出错", "回去搬救兵", "已经实际成立"];
        var model = new Model((call, request) =>
        {
            Check.Equal(Preset.SystemPrompt, request.System);
            var frame = Frame(request);
            string narrative = frame.GetProperty("narrativeContract").GetString()!;
            string checklist = frame.GetProperty("dmChecklist").GetProperty("instructions").GetString()!;
            foreach (string boundary in boundaries)
            {
                Check.True(narrative.Contains(boundary, StringComparison.Ordinal), "Missing narrative boundary: " + boundary);
                Check.True(checklist.Contains(boundary, StringComparison.Ordinal), "Missing checklist boundary: " + boundary);
                Check.True(HarnessDmChecklist.InstructionsFor(52, true).Contains(boundary, StringComparison.Ordinal), "Missing combat boundary: " + boundary);
                Check.True(!HarnessDmChecklist.InstructionsFor(51).Contains(boundary, StringComparison.Ordinal), "Changed frozen v51 checklist");
            }
            Check.True(request.Messages.Any(m => m.Role == "user" && m.Content.Contains(inputs[call - 1], StringComparison.Ordinal)), "Player input must remain intact");
            return Tool("world_record", new NarrativeHarnessArgs("对方仍站在原处。", []));
        });
        var dice = new SequenceDice();
        var configure = Configure(model, extra: b =>
        {
            b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry();
            b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>();
        });
        var h = await Host.Start(dice: dice, configure: configure);
        try
        {
            var owner = await Create(h); string id = owner.Snapshot.Id;
            var originals = new Dictionary<string, string>();
            foreach (string input in inputs)
            {
                var snapshot = (await h.Get(id))!;
                var run = await Settled(h, id, (await Start(h, snapshot, input)).Id, 3000);
                Check.True(run.Status == "completed", run.Status + "/" + run.Error);
                var saved = h.App.Services.GetRequiredService<HarnessRunStore>().Read(id, PartyEngine.HostId, run.Id)!;
                Check.Equal(HarnessTools.CurrentVersion, saved.ToolContractVersion);
                Check.Equal(input, saved.Input);
                originals.Add(run.Id, HarnessJson.Serialize(saved));
                var oldFrame = await h.App.Services.GetRequiredService<GameService>().ReadHarnessExecution(id, owner.AccessToken,
                    PartyEngine.HostId, saved.IntentId, input, run.Version, default, 51);
                Check.Equal("45a7f74cc5f2f1e7fc7a072394de84a7876f5d77b37f612f3fc0ed7121d68435",
                    HarnessJson.Fingerprint(HarnessJson.Element(oldFrame.NarrativeContract)));
            }
            Check.Equal(inputs.Length, model.Calls); Check.Equal(0, dice.Count);
            string root = h.Root; await h.DisposeAsync();
            h = await Host.Start(root, dice: dice, configure: Configure(model, extra: b => b.Configuration["Harness:Enabled"] = "false"));
            foreach (var original in originals)
                Check.Equal(original.Value, HarnessJson.Serialize(h.App.Services.GetRequiredService<HarnessRunStore>().Read(id, PartyEngine.HostId, original.Key)!));
            Check.Equal(inputs.Length, model.Calls); Check.Equal(0, dice.Count);
        }
        finally { await h.DisposeAsync(); }
    }

    public static async Task RulingRollKeepsExactPendingAndResolvedAssociation()
    {
        string rulingId = "", rollId = ""; int total = 0;
        var model = new Model((call, request) =>
        {
            var progress = AssertRequest(request);
            if (call == 1) return Tool("ruling_request", new { question = "这次主动侦察需要一个尚未提供的检定，请裁定。" });
            Check.Equal(2, call);
            Check.Equal(0, progress.GetProperty("pending").GetArrayLength());
            var ruling = progress.GetProperty("rulings").EnumerateArray().Single();
            Check.Equal(rulingId, ruling.GetProperty("id").GetString());
            Check.Equal("resolved", ruling.GetProperty("status").GetString());
            Check.Equal(rollId, ruling.GetProperty("rollId").GetString());
            Check.Equal(total, ruling.GetProperty("check").GetProperty("total").GetInt32());
            Check.True(!progress.GetRawText().Contains("PRIVATE_RULING_SENTINEL", StringComparison.Ordinal));
            return Tool("world_record", new NarrativeHarnessArgs("承接本次已确认的裁定检定，不重新投掷。", []));
        });
        var dice = new SequenceDice(16);
        await using var h = await Host.Start(dice: dice, configure: Configure(model, extra: b =>
        { b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry(); b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>(); }));
        var owner = await Create(h); string id = owner.Snapshot.Id;
        var run = await StartHistorical(h, id, new HarnessInputRequest(Id(), owner.Snapshot.Version, "警惕地侦察周围"), 30);
        run = await Settled(h, id, run.Id, 3000); Check.Equal("waiting", run.Status); rulingId = run.Wait!.Id;
        var requested = await Post<ActionResponse>(h, id, "rulings/respond", new ResolveRulingRequest(Id(), run.Version, rulingId,
            "check", "隔离夹具：批准本次主动察觉", "isolated fixture", "wisdom", "Perception", 12, PrivateText: "PRIVATE_RULING_SENTINEL"));
        rollId = requested.Resolution.RollId; Check.Equal(0, dice.Count);
        var saved = h.App.Services.GetRequiredService<HarnessRunStore>().Read(id, PartyEngine.HostId, run.Id)!;
        string path = Path.Combine(h.Root, "campaigns", id + ".sqlite"); byte[] before = File.ReadAllBytes(path);
        var frame = await h.App.Services.GetRequiredService<GameService>().ReadHarnessExecution(id, owner.AccessToken, PartyEngine.HostId,
            saved.IntentId, saved.Input, requested.Snapshot.Version, default, 30);
        Check.True(frame.DmChecklist!.Progress.Pending.Any(p => p.Kind == "roll" && p.Id == rollId), "Missing ruling-linked pending roll");
        Check.True(frame.DmChecklist.Progress.Pending.Any(p => p.Kind == "ruling" && p.Id == rulingId));
        Check.True(before.SequenceEqual(File.ReadAllBytes(path))); Check.Equal(0, dice.Count);
        var rolled = await Post<ActionResponse>(h, id, "rolls/respond", new RollResponseRequest(Id(), requested.Snapshot.Version, rollId, "roll"));
        total = rolled.Resolution.Check!.Total; Check.Equal(1, dice.Count);
        await Post<HarnessRunView>(h, id, $"harness/runs/{run.Id}/resume", new HarnessResumeRequest(Id(), rolled.Snapshot.Version));
        run = await Settled(h, id, run.Id, 3000); Check.Equal("completed", run.Status); Check.Equal(2, model.Calls); Check.Equal(1, dice.Count);
    }

    public static async Task RealPiProgressThroughReadsRejectionAnswerAndDice()
    {
        int initialVersion = 0;
        var model = new Model((call, request) =>
        {
            var p = AssertRequest(request);
            var steps = p.GetProperty("recordedSteps").EnumerateArray().ToArray();
            var receipts = p.GetProperty("toolReceipts").EnumerateArray().ToArray();
            Check.Equal(0, p.GetProperty("pending").GetArrayLength());
            switch (call)
            {
                case 1:
                    initialVersion = p.GetProperty("version").GetInt32();
                    Check.Equal(0, steps.Length); Check.Equal(0, receipts.Length);
                    return Tool("map_state_read");
                case 2:
                    Check.Equal(initialVersion, p.GetProperty("version").GetInt32());
                    Check.Equal(0, steps.Length); Check.Equal("map_state_read", receipts.Single().GetProperty("tool").GetString());
                    Check.True(receipts[0].GetProperty("applied").GetBoolean()); // A read is not a completed player action.
                    return Tool("ask_player", new { question = "要查看近处线索还是远处通路？" });
                case 3:
                    Check.Equal(initialVersion, p.GetProperty("version").GetInt32());
                    Check.True(request.Messages.Any(m => m.Role == "user" && m.Content.Contains("近处线索", StringComparison.Ordinal)));
                    Check.Equal("player", receipts.Last().GetProperty("waitAtCall").GetProperty("kind").GetString());
                    return Tool("actions_propose", new { candidateId = Choice(request, "观察") });
                case 4:
                    Check.Equal(initialVersion + 2, p.GetProperty("version").GetInt32());
                    Check.Equal("observe", steps.Single().GetProperty("result").GetProperty("kind").GetString());
                    return Tool("world_record", new NarrativeHarnessArgs("此非法提议不得保存。",
                        [new("invented-id", "clue", "非法引用", "不写入", "known", "harbor")], Complete: false));
                case 5:
                    Check.Equal(initialVersion + 2, p.GetProperty("version").GetInt32());
                    Check.Equal(1, steps.Length);
                    Check.True(receipts.Last().GetProperty("isError").GetBoolean());
                    Check.True(!receipts.Last().GetProperty("applied").GetBoolean());
                    return Tool("actions_propose", new { candidateId = Choice(request, "调查") });
                case 6:
                    Check.Equal(1, steps.Count(s => s.GetProperty("result").GetProperty("kind").GetString() == "observe"));
                    Check.Equal(1, steps.Count(s => s.GetProperty("result").GetProperty("check").ValueKind == JsonValueKind.Object));
                    Check.True(request.Messages.Any(m => m.Role == "user" && m.Content.Contains("confirmedResult", StringComparison.Ordinal)));
                    Check.Equal("roll", receipts.Last().GetProperty("waitAtCall").GetProperty("kind").GetString());
                    return Tool("world_record", new NarrativeHarnessArgs("按已经保存的观察与调查结果回应。", []));
                default: throw new Exception("Unexpected model call " + call);
            }
        });
        var dice = new SequenceDice(18);
        var configure = Configure(model, extra: b =>
        { b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry(); b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>(); });
        var h = await Host.Start(dice: dice, configure: configure);
        try
        {
            var owner = await Create(h); string id = owner.Snapshot.Id;
            var original = new HarnessInputRequest(Id(), owner.Snapshot.Version, "查看那个目标");
            var run = await StartHistorical(h, id, original, 30);
            run = await Settled(h, id, run.Id, 3000); Check.Equal("waiting", run.Status); Check.Equal("player", run.Wait!.Kind);
            Check.Equal(2, model.Calls); Check.Equal(0, dice.Count);
            await Post<HarnessRunView>(h, id, $"harness/runs/{run.Id}/resume", new HarnessResumeRequest(Id(), run.Version, "近处线索"));
            run = await Settled(h, id, run.Id, 3000); Check.Equal("waiting", run.Status); Check.Equal("roll", run.Wait!.Kind);
            Check.Equal(5, model.Calls); Check.Equal(0, dice.Count);
            var stored = h.App.Services.GetRequiredService<HarnessRunStore>().Read(id, PartyEngine.HostId, run.Id)!;
            var game = h.App.Services.GetRequiredService<GameService>();
            string dbPath = Path.Combine(h.Root, "campaigns", id + ".sqlite"); byte[] before = File.ReadAllBytes(dbPath);
            var waitingFrame = await game.ReadHarnessExecution(id, owner.AccessToken, PartyEngine.HostId, stored.IntentId,
                stored.Input, run.Version, default, 30);
            Check.True(waitingFrame.DmChecklist!.Progress.Pending.Any(w => w.Kind == "roll" && w.Id == run.Wait.Id));
            Check.Equal(0, dice.Count); Check.True(before.SequenceEqual(File.ReadAllBytes(dbPath)));
            var roll = new RollResponseRequest(Id(), run.Version, run.Wait.Id, "roll");
            var rolled = await Post<ActionResponse>(h, id, "rolls/respond", roll); Check.Equal(1, dice.Count);
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, dice: dice, configure: configure);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var resume = new HarnessResumeRequest(Id(), rolled.Snapshot.Version);
            await Post<HarnessRunView>(h, id, $"harness/runs/{run.Id}/resume", resume);
            run = await Settled(h, id, run.Id, 3000); Check.Equal("completed", run.Status); Check.Equal(6, model.Calls); Check.Equal(1, dice.Count);
            var saved = h.App.Services.GetRequiredService<HarnessRunStore>().Read(id, PartyEngine.HostId, run.Id)!;
            Check.Equal(30, saved.ToolContractVersion);
            Check.Equal(6, saved.Steps.Count(s => s.Kind == "model" && s.ExecutionFrame?.DmChecklist is not null));
            string savedJson = HarnessJson.Serialize(saved);
            Check.True((await Post<HarnessRunView>(h, id, "harness/runs", original)).Replayed);
            Check.True((await Post<HarnessRunView>(h, id, $"harness/runs/{run.Id}/resume", resume)).Replayed);
            Check.True((await Post<ActionResponse>(h, id, "rolls/respond", roll)).Replayed);
            Check.Equal(savedJson, HarnessJson.Serialize(h.App.Services.GetRequiredService<HarnessRunStore>().Read(id, PartyEngine.HostId, run.Id)!));
            Check.Equal(6, model.Calls); Check.Equal(1, dice.Count);
            var activity = (await h.Http.GetFromJsonAsync<ActivityPage>($"/api/v1/campaigns/{id}/activity"))!;
            Check.True(!HarnessJson.Serialize(activity).Contains("完整主持行动检查", StringComparison.Ordinal));
            Check.True(!HarnessJson.Serialize(activity).Contains("此非法提议不得保存", StringComparison.Ordinal));

            var guest = await HarnessBoundaryTests.Guest(h, owner);
            game = h.App.Services.GetRequiredService<GameService>();
            var auth = await game.AuthorizeHarness(id, guest.AccessToken, default);
            before = File.ReadAllBytes(dbPath);
            try
            {
                await game.ReadHarnessExecution(id, guest.AccessToken, auth.ActorId, saved.IntentId, saved.Input, auth.Version, default, 30);
                throw new Exception("Accepted another seat's action progress");
            }
            catch (GameException e) { Check.Equal("harness_profile_changed", e.Code); }
            var ownFrame = await game.ReadHarnessExecution(id, guest.AccessToken, auth.ActorId, Id(), "另一个本人的输入", auth.Version, default, 30);
            Check.Equal(0, ownFrame.DmChecklist!.Progress.RecordedSteps.Length);
            Check.Equal(0, ownFrame.DmChecklist.Progress.Pending.Length);
            Check.True(before.SequenceEqual(File.ReadAllBytes(dbPath))); Check.Equal(6, model.Calls);
        }
        finally { await h.DisposeAsync(); }
    }
}
