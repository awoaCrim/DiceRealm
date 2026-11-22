using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class StoryIntentContextTests
{
    private static AdventureDocument Document() => TestContent.Document with
    {
        SourceText = "NEVER_FULL_PRIVATE_SOURCE",
        Scenes = TestContent.Document.Scenes.Select(s => s.Id == "harbor" ? s with
        {
            Arrival = "雾里露出一座白色灯塔。莫娜站在码头边。",
            ImagePrompt = "NEVER_PRIVATE_IMAGE",
            Variants = [new(new() { All = ["changed"] }, s.Title, "天已放晴，船驶进港湾。", s.ImagePrompt)]
        } : s with { Arrival = "OTHER_SCENE_ARRIVAL_" + s.Id }).ToArray()
    };

    public static async Task CurrentSceneVersionsAndTravel()
    {
        await using var h = await Host.Start(configure: Configure(new Model((_, _) => throw new Exception("No provider expected"))));
        var owner = await Create(h, Document(), skills: []);
        var game = h.App.Services.GetRequiredService<GameService>();
        async Task<HarnessExecutionFrame> Read(int contract) => await game.ReadHarnessExecution(owner.Snapshot.Id, owner.AccessToken,
            PartyEngine.HostId, Id(), "观察周围", owner.Snapshot.Version, default, contract);
        string database = Path.Combine(h.Root, "campaigns", owner.Snapshot.Id + ".sqlite");
        var before = File.ReadAllBytes(database);
        var old = await Read(23); string oldBytes = HarnessJson.Serialize(old);
        Check.True(!oldBytes.Contains("scenePresentation") && !oldBytes.Contains("hasImportedSkills"));
        Check.True(old.AvailableTools.Contains("skills_list"));
        var frame = await Read(24); HarnessExecutionProtocol.Validate(frame, frame.Version, 24);
        Check.Equal(Document().Scenes.Single(s => s.Id == "harbor").Arrival, frame.ScenePresentation!.Arrival);
        Check.True(!frame.AvailableTools.Contains("skills_list") && !frame.AvailableTools.Contains("skills_read"));
        Check.Equal(oldBytes, HarnessJson.Serialize(await Read(23)));
        var prior = await Read(28); string priorBytes = HarnessJson.Serialize(prior);
        var current = await Read(29);
        Check.True(!prior.WorkingContext!.Guidance.Contains("不表示攻击已经发生"));
        Check.True(current.WorkingContext!.Guidance.Contains("不表示攻击已经发生"));
        Check.True(current.WorkingContext.Guidance.Contains("缺意图/目标先问玩家"));
        Check.Equal(priorBytes, HarnessJson.Serialize(await Read(28)));
        Check.True(before.SequenceEqual(File.ReadAllBytes(database)), "Capture must be pure");
        Check.Throws<InvalidDataException>(() => HarnessExecutionProtocol.Validate(frame with { ScenePresentation = null }, frame.Version, 24));
        Check.Throws<InvalidDataException>(() => HarnessExecutionProtocol.Validate(frame with { HasImportedSkills = null }, frame.Version, 24));
        Check.Throws<InvalidDataException>(() => HarnessExecutionProtocol.Validate(frame with { ScenePresentation = frame.ScenePresentation with { SceneId = "secret" } }, frame.Version, 24));
        var store = h.App.Services.GetRequiredService<CampaignStore>();
        await store.Access(owner.Snapshot.Id, owner.AccessToken, true, c => { c.Facts.Add("changed"); return Task.FromResult(0); });
        frame = await Read(24);
        Check.Equal("天已放晴，船驶进港湾。", frame.ScenePresentation!.CurrentSummary);
        Check.True(frame.ScenePresentation.Arrival.Contains("白色灯塔") && frame.ScenePresentation.Notice.Contains("take precedence"));
        await store.Access(owner.Snapshot.Id, owner.AccessToken, true, c => { c.SceneId = "causeway"; c.VisitedScenes.Add("causeway"); return Task.FromResult(0); });
        frame = await Read(24);
        Check.Equal("OTHER_SCENE_ARRIVAL_causeway", frame.ScenePresentation!.Arrival);
        Check.True(!HarnessJson.Serialize(frame.ScenePresentation).Contains("白色灯塔"));
        await store.Access(owner.Snapshot.Id, owner.AccessToken, true, c => { c.VisitedScenes.Remove("causeway"); return Task.FromResult(0); });
        Check.Equal("", (await Read(24)).ScenePresentation!.Arrival);
    }

    public static async Task RealPiUsesActiveSkillsAndQuestionScope()
    {
        Exception? failure = null;
        var model = new Model((_, request) =>
        {
            try
            {
                var frame = HarnessExecutionProtocolTests.Frame(request);
                Check.True(!frame.GetProperty("hasImportedSkills").GetBoolean());
                Check.True(request.Tools.All(t => t.Name is not ("skills_list" or "skills_read")));
                // Contract 56: complete entry prose is present in every exploration frame, not only the first.
                Check.True(frame.GetProperty("scenePresentation").GetProperty("arrival").GetString()!.Contains("白色灯塔"));
                Check.True(request.Tools.Single(t => t.Name == "actions_propose").Description.Contains("full labeled action"));
                string record = request.Tools.Single(t => t.Name == "world_record").Description;
                Check.True(record.Contains("agreements or accepted quests"), "world_record description: " + record);
                // v29 wording ("not evidence of an attack") was rewritten in v35/v44; the same rule now reads:
                Check.True(request.Tools.Single(t => t.Name == "ruling_request").Description.Contains("genuinely unsupported mechanical event"));
                Check.True(request.Messages.Any(m => m.Content.Contains("口头威胁或关系敌对，不自动等于已经开战")), "checklist keeps threats from counting as attacks");
                return Tool("world_record", new NarrativeHarnessArgs("莫娜回答了当前问题，没有替你决定接下委托。", []));
            }
            catch (Exception e) { failure = e; throw; }
        });
        var configure = Configure(model, extra: b =>
        {
            b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry();
            b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>();
        });
        var h = await Host.Start(configure: configure);
        try
        {
            // Bootstrap has a method, active workspace does not. The run profile must win.
            var owner = await Create(h, Document()); string id = owner.Snapshot.Id;
            var draft = await Post<HarnessWorkspaceResult>(h, id, "harness/workspace/draft", new SaveHarnessDraftRequest(Id(), 1, Preset with { Version = 2 }, []));
            var published = await Post<HarnessWorkspaceResult>(h, id, "harness/workspace/publish", new PublishHarnessRequest(Id(), draft.Workspace.Version));
            await Post<HarnessWorkspaceResult>(h, id, "harness/workspace/activate", new ActivateHarnessRequest(Id(), published.Workspace.Version, 2));
            HarnessInputRequest? last = null; string? lastRun = null;
            foreach (string input in new[] { "观察周围", "观察莫娜", "你就是村长吗", "你知道我是谁？" })
            {
                var snapshot = (await h.Get(id))!;
                last = new(Id(), snapshot.Version, input);
                var started = await Post<HarnessRunView>(h, id, "harness/runs", last);
                var run = await Settled(h, id, started.Id, 3000); lastRun = run.Id;
                Check.True(run.Status == "completed", run.Status + "/" + run.Error + " " + failure);
            }
            Check.Equal(4, model.Calls);
            var saved = h.App.Services.GetRequiredService<HarnessRunStore>().Read(id, PartyEngine.HostId, lastRun!)!;
            Check.Equal(HarnessTools.CurrentVersion, saved.ToolContractVersion); Check.True(saved.Steps[0].ExecutionFrame!.HasImportedSkills == false);
            var after = (await h.Get(id))!;
            Check.True(after.Events.All(e => e.Kind != "talk"), "Scripted conversation must not automatically execute a story candidate");
            Check.Equal(0, after.PendingRulings.Length);
            Check.True(after.Facts.SequenceEqual(owner.Snapshot.Facts), "Scripted ordinary dialogue cannot unlock discovery facts");
            string original = HarnessJson.Serialize(saved), root = h.Root;
            await h.DisposeAsync(); h = await Host.Start(root, configure: configure);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            Check.True((await Post<HarnessRunView>(h, id, "harness/runs", last!)).Replayed);
            Check.Equal(4, model.Calls);
            Check.Equal(original, HarnessJson.Serialize(h.App.Services.GetRequiredService<HarnessRunStore>().Read(id, PartyEngine.HostId, lastRun!)!));
        }
        finally { await h.DisposeAsync(); }
    }

    private sealed class Wire : HttpMessageHandler
    {
        public JsonElement Body;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(ct)).RootElement.Clone();
            return new(HttpStatusCode.OK) { Content = JsonContent.Create(new { candidates = new[] { new { finishReason = "STOP", content = new { role = "model", parts = new[] { new { text = "已看见白色灯塔。" } } } } } }) };
        }
    }

    public static async Task NativeBodyIncludesOnlyCurrentArrival()
    {
        await using var h = await Host.Start(configure: Configure(new Model((_, _) => throw new Exception("No real provider"))));
        var owner = await Create(h, Document(), skills: []);
        var game = h.App.Services.GetRequiredService<GameService>();
        var frame = await game.ReadHarnessExecution(owner.Snapshot.Id, owner.AccessToken, PartyEngine.HostId, Id(), "观察周围", owner.Snapshot.Version, default, 24);
        var initial = HarnessJson.Serialize(new { input = "观察周围", ruleset = "dnd2024", memory = new { } });
        var request = HarnessExecutionProtocol.Project(new(Preset.SystemPrompt, [new("user", initial)], HarnessTools.ForVersion(24), 4096), frame, 24);
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["DataPath"] = Path.Combine(Path.GetTempPath(), "scene-provider-" + Id()),
            ["HarnessAi:BaseUrl"] = "http://127.0.0.1:1/v1", ["HarnessAi:Endpoint"] = "gemini",
            ["HarnessAi:Model"] = "isolated-model", ["HarnessAi:ApiKey"] = "fake", ["HarnessAi:RetryCount"] = "0"
        }).Build();
        using var data = new DataDirectory(config); using var wire = new Wire(); using var http = new HttpClient(wire);
        var adapter = new GeminiHarnessModel(http, config, new ProviderBudget(data, config));
        await adapter.Complete(request, Id(), default);
        string actual = wire.Body.GetRawText();
        Check.True(actual.Contains("白色灯塔"));
        Check.True(!actual.Contains("OTHER_SCENE_ARRIVAL") && !actual.Contains("NEVER_"));
        Check.True(!actual.Contains("\"name\":\"skills_list\"") && !actual.Contains("\"name\":\"skills_read\""));
        var store = h.App.Services.GetRequiredService<CampaignStore>();
        foreach (bool visited in new[] { true, false })
        {
            await store.Access(owner.Snapshot.Id, owner.AccessToken, true, c =>
            {
                c.SceneId = "causeway";
                if (visited) c.VisitedScenes.Add("causeway"); else c.VisitedScenes.Remove("causeway");
                return Task.FromResult(0);
            });
            frame = await game.ReadHarnessExecution(owner.Snapshot.Id, owner.AccessToken, PartyEngine.HostId, Id(), "观察周围", owner.Snapshot.Version, default, 24);
            request = HarnessExecutionProtocol.Project(new(Preset.SystemPrompt, [new("user", initial)], HarnessTools.ForVersion(24), 4096), frame, 24);
            await adapter.Complete(request, Id(), default);
            actual = wire.Body.GetRawText();
            Check.Equal(visited, actual.Contains("OTHER_SCENE_ARRIVAL_causeway"));
            Check.True(!actual.Contains("白色灯塔") && !actual.Contains("NEVER_"));
        }
    }
}
