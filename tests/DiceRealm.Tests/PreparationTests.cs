using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace DiceRealm.Tests;

internal static class PreparationTests
{
    private static string Id() => Guid.NewGuid().ToString();
    private const string Source = "潮雾笼罩旧港。断崖边有人提到废弃灯室与失踪的守夜人。";
    private const string IntentText = "从港口开始寻找灯室线索。";

    // A fake provider proves the engineering contract only; it says nothing about language quality.
    private sealed class FakePreparation : IPreparationGenerator
    {
        public int Calls;
        public bool Enabled { get; set; } = true;
        public Func<PreparationGenerationRequest, PreparationProposal>? Next;
        public Exception? Failure;
        public string? SystemPrompt;
        public string? SourceText;
        public string Model => "fake-preparation";
        public Task<PreparationProposal> Generate(PreparationGenerationRequest request, CancellationToken cancellationToken, string campaignId)
        {
            Calls++;
            SystemPrompt = request.SystemPrompt;
            SourceText = request.SourceText;
            if (Failure is not null) throw Failure;
            return Task.FromResult((Next ?? throw new Exception("No proposal configured"))(request));
        }
    }

    private static PreparationEvidence Ev(string quote, string field = "sourceText")
    {
        string text = field == "sourceText" ? Source : IntentText;
        int start = text.IndexOf(quote, StringComparison.Ordinal);
        if (start < 0) throw new Exception("Test quote is not in the source: " + quote);
        return new(field, start, quote.Length, quote);
    }

    private static PreparationProposal ValidProposal() => new(
        "harbor",
        [
            new("harbor", "雾港", "潮雾中的旧港", "你站在码头，潮雾未散。", [Ev("潮雾")]),
            new("cliff", "断崖", "风蚀的断崖", "你沿路抵达断崖。", [Ev("断崖")])
        ],
        [new("harbor", "cliff", [Ev("断崖")])],
        [new("fog-clue", "clue", "灯室线索", "有人提到废弃灯室", "harbor", "public", "", [Ev("灯室")])],
        []);

    private static PreparationInput Input(int? travelSeconds = 600) =>
        new(Source, IntentText, "雾港余火", "prepared-fog", "1", true, travelSeconds);

    private static PreparationRequest Request(string id, int? travelSeconds = 600) =>
        new(id, Input(travelSeconds), new("prep-1", "1", "你负责把原文整理成有来源的结构。"), true);

    private static void Auth(Host h, string token) => h.Http.DefaultRequestHeaders.Authorization = new("Bearer", token);

    private sealed class CapturingHandler(string content) : HttpMessageHandler
    {
        public int Calls;
        public string? Body;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Calls++;
            Body = request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellationToken);
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(content) };
        }
    }

    private static object WireProposal(object[]? scenes = null) => new
    {
        startSceneId = "harbor",
        scenes = scenes ?? new object[]
        {
            new { id = "harbor", title = "雾港", summary = "潮雾", arrival = "抵达", evidence = new object[] { new { field = "sourceText", start = 0, length = 2, quote = "潮雾" } } }
        },
        routes = Array.Empty<object>(), knowledge = Array.Empty<object>(), questions = Array.Empty<string>()
    };

    // The live adapter must send the host's system prompt verbatim, stay off the wire when no model
    // is configured, and refuse mechanical model output before projection. A fake handler proves
    // this transport contract only; it says nothing about online language quality.
    public static async Task ProviderAdapterContract()
    {
        string root = Path.Combine(Path.GetTempPath(), "dicerealm-prep-ai-" + Guid.NewGuid());
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["TextAi:Model"] = "test-model", ["TextAi:ApiKey"] = "not-a-real-key",
            ["TextAi:Endpoint"] = "http://127.0.0.1:1/v1/chat/completions"
        }).Build();
        using var directory = new DataDirectory(new ConfigurationBuilder().AddInMemoryCollection(
            new Dictionary<string, string?> { ["DataPath"] = root }).Build());
        var budget = new ProviderBudget(directory, config);
        string campaign = Guid.NewGuid().ToString();

        var handler = new CapturingHandler(FakeHandler.Chat(WireProposal()));
        var ai = new OpenAiPreparation(new HttpClient(handler), config, budget);
        Check.True(ai.Enabled); Check.Equal("test-model", ai.Model);
        var proposal = await ai.Generate(new(Source, IntentText, "作者提供的系统提示原文"), default, campaign);
        Check.Equal(1, handler.Calls);
        using (var sent = JsonDocument.Parse(handler.Body!))
        {
            var messages = sent.RootElement.GetProperty("messages");
            Check.Equal("作者提供的系统提示原文", messages[0].GetProperty("content").GetString());
            using var userPayload = JsonDocument.Parse(messages[1].GetProperty("content").GetString()!);
            Check.Equal(Source, userPayload.RootElement.GetProperty("source_text").GetString());
            Check.Equal(IntentText, userPayload.RootElement.GetProperty("intent").GetString());
            Check.True(userPayload.RootElement.TryGetProperty("output_contract", out _));
        }
        Check.Equal("潮雾", proposal.Scenes[0].Evidence[0].Quote);
        Check.Equal(1, budget.Read("text", campaign, true).Total);

        // Mechanical fields in provider output are refused by strict deserialization.
        handler = new CapturingHandler(FakeHandler.Chat(new
        {
            startSceneId = "harbor",
            scenes = new object[] { new { id = "harbor", title = "雾港", summary = "潮雾", arrival = "抵达", hitPoints = 99,
                evidence = new object[] { new { field = "sourceText", start = 0, length = 2, quote = "潮雾" } } } },
            routes = Array.Empty<object>(), knowledge = Array.Empty<object>(), questions = Array.Empty<string>()
        }));
        ai = new OpenAiPreparation(new HttpClient(handler), config, budget);
        try { await ai.Generate(new(Source, IntentText, "作者提示"), default, campaign); throw new Exception("accepted mechanical provider output"); }
        catch (JsonException) { }
        Check.Equal(1, handler.Calls);

        // Over-bounded outbound payloads fail before any HTTP call or reservation.
        handler = new CapturingHandler(FakeHandler.Chat(WireProposal()));
        ai = new OpenAiPreparation(new HttpClient(handler), config, budget);
        try { await ai.Generate(new(new string('x', PreparationLimits.MaximumOutboundBytes + 1024), IntentText, "作者提示"), default, campaign); throw new Exception("sent an over-bounded payload"); }
        catch (InvalidDataException) { }
        Check.Equal(0, handler.Calls);

        // Missing configuration disables the adapter before any request or reservation.
        var unconfigured = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>()).Build();
        handler = new CapturingHandler(FakeHandler.Chat(WireProposal()));
        ai = new OpenAiPreparation(new HttpClient(handler), unconfigured, budget);
        Check.True(!ai.Enabled);
        try { await ai.Generate(new(Source, IntentText, "作者提示"), default, campaign); throw new Exception("called a disabled provider"); }
        catch (InvalidOperationException) { }
        Check.Equal(0, handler.Calls);
    }

    private static async Task<CreatedCampaign> Join(Host h, CreatedCampaign owner)
    {
        Auth(h, owner.AccessToken);
        var s = (await h.Get(owner.Snapshot.Id))!;
        var invite = new InviteRequest(Id(), s.Version, new string('a', 64));
        var inviteResponse = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/invitations", invite);
        Check.Equal(HttpStatusCode.OK, inviteResponse.StatusCode);
        var join = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/join",
            new JoinCampaignRequest(Id(), invite.InviteToken, new string('b', 64), "新队员", Build: FullCreationTests.Named("新队员")));
        Check.Equal(HttpStatusCode.OK, join.StatusCode);
        return (await join.Content.ReadFromJsonAsync<CreatedCampaign>())!;
    }

    public static async Task ContractAndProjection()
    {
        var fake = new FakePreparation();
        await using var h = await Host.Start(configure: b => b.Services.AddSingleton<IPreparationGenerator>(fake));
        var created = await h.Create();
        var s = created.Snapshot;

        var status = (await h.Http.GetFromJsonAsync<PreparationStatus>($"/api/v1/campaigns/{s.Id}/content/preparation/status"))!;
        Check.True(status.Enabled); Check.Equal("fake-preparation", status.Model);
        Check.Equal(PreparationLimits.MaximumSourceCharacters, status.MaximumSourceCharacters);
        Check.Equal(PreparationLimits.MaximumRequestBytes, status.MaximumInputBytes);
        Check.True(status.Notice.Length > 0);

        fake.Next = _ => ValidProposal();
        var request = Request(Id());
        var response = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/content/preparation", request);
        Check.Equal(HttpStatusCode.OK, response.StatusCode);
        var result = (await response.Content.ReadFromJsonAsync<PreparationResult>())!;
        Check.Equal("ready", result.Status); Check.Equal("fake-preparation", result.ProviderModel);
        Check.Equal(request.RequestId, result.RequestId);
        Check.Equal(1, fake.Calls);
        // The host's own system prompt and source text travel verbatim; the adapter owns no prompt.
        Check.Equal("你负责把原文整理成有来源的结构。", fake.SystemPrompt);
        Check.Equal(Source, fake.SourceText);

        var document = result.Document!;
        Check.Equal("prepared-fog", document.Id); Check.Equal("1", document.Version);
        Check.Equal("雾港余火", document.Name); Check.Equal("harbor", document.StartSceneId);
        Check.Equal(Source, document.SourceText);
        Check.Equal(2, document.Scenes.Length);
        Check.True(document.Scenes.All(x => x.Unlocated), "prepared scenes have no position evidence");
        Check.True(document.Scenes.Single(x => x.Id == "harbor").SafeRest);
        Check.True(!document.Scenes.Single(x => x.Id == "cliff").SafeRest, "safe rest is only the chosen start");
        var exit = document.Scenes.Single(x => x.Id == "harbor").Exits.Single();
        Check.Equal("cliff", exit.Target); Check.Equal(600, exit.Seconds);
        Check.True(exit.When.All.Length + exit.When.Any.Length + exit.When.None.Length == 0, "prepared routes carry no conditions");
        Check.Equal(1, document.InitialKnowledge!.Length);
        Check.Equal("fog-clue", document.InitialKnowledge[0].Id);
        Check.Equal("public", document.InitialKnowledge[0].Visibility);
        // No mechanical content is synthesized.
        Check.Equal(0, document.Items.Length); Check.Equal(0, document.Quests.Length);
        Check.Equal(0, document.Npcs.Length); Check.Equal(0, document.Factions.Length); Check.Equal(0, document.Branches.Length);

        var replay = (await (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/content/preparation", request))
            .Content.ReadFromJsonAsync<PreparationResult>())!;
        Check.Equal(1, fake.Calls); Check.Equal(JsonSerializer.Serialize(result), JsonSerializer.Serialize(replay));
        var stored = (await h.Http.GetFromJsonAsync<PreparationResult>(
            $"/api/v1/campaigns/{s.Id}/content/preparation/requests/{request.RequestId}"))!;
        Check.Equal(JsonSerializer.Serialize(result), JsonSerializer.Serialize(stored));

        var conflict = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/content/preparation",
            request with { Prompt = request.Prompt with { Text = "另一个提示词" } });
        Check.Equal(HttpStatusCode.Conflict, conflict.StatusCode);
        Check.Equal(1, fake.Calls);

        // Preparation is read-only over the live campaign: no version, content or world change.
        var after = (await h.Get(s.Id))!;
        Check.Equal(s.Version, after.Version);
        Check.Equal(s.Content!.Adventure!.Hash, after.Content!.Adventure!.Hash);
        Check.Equal(0, after.WorldMemory!.Length);
        Check.Equal(HttpStatusCode.NotFound, (await h.Http.GetAsync(
            $"/api/v1/campaigns/{s.Id}/content/preparation/requests/{Id()}")).StatusCode);

        // /inspect re-projects the same input and proposal without contacting a provider.
        var inspect = (await (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/content/preparation/inspect",
            new PreparationInspectRequest(Input(), ValidProposal()))).Content.ReadFromJsonAsync<PreparationInspectResult>())!;
        Check.Equal("ready", inspect.Status); Check.True(inspect.Document is not null);
        Check.Equal(1, fake.Calls);

        // The proposal schema ships with the server and is served from the workbench origin.
        var schema = await h.Http.GetAsync("/workbench/schemas/preparation-proposal.schema.json");
        Check.Equal(HttpStatusCode.OK, schema.StatusCode);
        Check.True((await schema.Content.ReadAsStringAsync()).Contains("\"startSceneId\"", StringComparison.Ordinal));
    }

    public static async Task ValidationFailuresAndClarification()
    {
        var fake = new FakePreparation();
        await using var h = await Host.Start(configure: b => b.Services.AddSingleton<IPreparationGenerator>(fake));
        var created = await h.Create();
        var s = created.Snapshot;

        async Task<PreparationResult> Post(Func<PreparationGenerationRequest, PreparationProposal> proposal, int? travelSeconds = 600)
        {
            fake.Next = proposal;
            var response = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/content/preparation", Request(Id(), travelSeconds));
            Check.Equal(HttpStatusCode.OK, response.StatusCode);
            return (await response.Content.ReadFromJsonAsync<PreparationResult>())!;
        }

        // Evidence that does not quote the exact source slice is a whole-proposal rejection.
        var mismatched = ValidProposal() with
        {
            Scenes = [ValidProposal().Scenes[0] with { Evidence = [new("sourceText", 0, 2, "不存在")] }, ValidProposal().Scenes[1]]
        };
        var bad = await Post(_ => mismatched);
        Check.Equal("failed", bad.Status); Check.True(bad.Document is null);
        Check.True(bad.Issues.Any(i => i.Path.Contains("evidence")), "evidence mismatch must be reported");

        // Unknown references are rejected; a partial document is never produced.
        var unknown = await Post(_ => ValidProposal() with { Routes = [new("harbor", "missing", [Ev("断崖")])] });
        Check.Equal("failed", unknown.Status); Check.True(unknown.Document is null);

        // Missing reveal scene for arrival knowledge is rejected.
        var arrival = await Post(_ => ValidProposal() with
        {
            Knowledge = [new("k", "clue", "线索", "摘要", "harbor", "arrival", "", [Ev("灯室")])]
        });
        Check.Equal("failed", arrival.Status); Check.True(arrival.Document is null);

        // Questions and an unset travel choice produce clarification instead of a guess.
        var questions = await Post(_ => ValidProposal() with { Questions = ["守夜人现在在哪里？"] });
        Check.Equal("needs_clarification", questions.Status); Check.True(questions.Document is null);
        Check.True(questions.Issues.All(i => i.Severity == PreparationProjection.ClarificationSeverity));
        var noSeconds = await Post(_ => ValidProposal(), travelSeconds: null);
        Check.Equal("needs_clarification", noSeconds.Status); Check.True(noSeconds.Document is null);
        Check.True(noSeconds.Issues.Any(i => i.Path == "input.travelSeconds"));
        // Without routes there is no blocked travel value, so the draft is complete.
        var noRoutes = await Post(_ => ValidProposal() with { Routes = [] });
        Check.Equal("ready", noRoutes.Status);
        var noRoutesNoSeconds = await Post(_ => ValidProposal() with { Routes = [] }, travelSeconds: null);
        Check.Equal("ready", noRoutesNoSeconds.Status);
        Check.Equal(0, noRoutesNoSeconds.Document!.Scenes.SelectMany(x => x.Exits).Count());

        // Provider failure/timeout is a failed record with a generic message, never provider body text.
        fake.Failure = new InvalidDataException("private provider payload should not leak");
        var failure = (await (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/content/preparation", Request(Id())))
            .Content.ReadFromJsonAsync<PreparationResult>())!;
        Check.Equal("failed", failure.Status); Check.True(failure.Document is null);
        Check.True(failure.Issues.Any(i => i.Path == "provider"));
        Check.True(!JsonSerializer.Serialize(failure).Contains("private provider payload"));

        // Disabled configuration refuses generation but keeps status/inspect usable.
        fake.Enabled = false; fake.Failure = null; fake.Next = _ => ValidProposal();
        var disabledStatus = (await h.Http.GetFromJsonAsync<PreparationStatus>($"/api/v1/campaigns/{s.Id}/content/preparation/status"))!;
        Check.True(!disabledStatus.Enabled); Check.Equal("", disabledStatus.Model);
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/content/preparation", Request(Id()))).StatusCode);
        var inspect = (await (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/content/preparation/inspect",
            new PreparationInspectRequest(Input(), ValidProposal()))).Content.ReadFromJsonAsync<PreparationInspectResult>())!;
        Check.Equal("ready", inspect.Status);
        fake.Enabled = true;

        // Offline trials can never reach a provider.
        int beforeTrial = fake.Calls;
        var trial = (await (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/content/trial",
            new TrialRequest(Id(), s.Version, new string('d', 64), TestContent.Document, TestContent.Prompts)))
            .Content.ReadFromJsonAsync<TrialResponse>())!.Trial;
        Auth(h, trial.AccessToken);
        var trialStatus = (await h.Http.GetFromJsonAsync<PreparationStatus>($"/api/v1/campaigns/{trial.Snapshot.Id}/content/preparation/status"))!;
        Check.True(!trialStatus.Enabled);
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{trial.Snapshot.Id}/content/preparation", Request(Id()))).StatusCode);
        Check.Equal(beforeTrial, fake.Calls);

        // Shape rejections are 4xx and consume no attempt.
        Auth(h, created.AccessToken);
        int beforeShape = fake.Calls;
        var oversized = Request(Id()) with { Input = Input() with { SourceText = new string('x', PreparationLimits.MaximumSourceCharacters + 1) } };
        Check.Equal(HttpStatusCode.BadRequest, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/content/preparation", oversized)).StatusCode);
        Check.Equal(HttpStatusCode.BadRequest, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/content/preparation", Request(Id()) with { ConfirmProviderUse = false })).StatusCode);
        var forged = new StringContent(JsonSerializer.Serialize(new
        {
            requestId = Id(), input = Input(), prompt = new { id = "p", version = "1", text = "x" }, confirmProviderUse = true, dice = 20
        }), System.Text.Encoding.UTF8, "application/json");
        Check.Equal(HttpStatusCode.BadRequest, (await h.Http.PostAsync($"/api/v1/campaigns/{s.Id}/content/preparation", forged)).StatusCode);
        Check.Equal(beforeShape, fake.Calls);
    }

    public static async Task DurabilityCatalogAndRecovery()
    {
        var fake = new FakePreparation();
        string root = Path.Combine(Path.GetTempPath(), "dicerealm-prep-" + Guid.NewGuid());
        string campaignId;
        string token;
        PreparationResult first;
        var request = Request(Id());
        fake.Next = _ => ValidProposal();
        await using (var h = await Host.Start(root, configure: b => b.Services.AddSingleton<IPreparationGenerator>(fake)))
        {
            var created = await h.Create();
            campaignId = created.Snapshot.Id; token = created.AccessToken;
            var file = Path.Combine(root, "campaigns", campaignId + ".sqlite");
            var before = File.ReadAllBytes(file);
            first = (await (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{campaignId}/content/preparation", request))
                .Content.ReadFromJsonAsync<PreparationResult>())!;
            Check.Equal("ready", first.Status); Check.Equal(1, fake.Calls);
            Check.True(before.SequenceEqual(File.ReadAllBytes(file)), "preparation must not write the campaign");
        }

        // Restart replays the stored result without a second provider call.
        var restart = new FakePreparation();
        await using (var h = await Host.Start(root, configure: b => b.Services.AddSingleton<IPreparationGenerator>(restart)))
        {
            Auth(h, token);
            var replay = (await (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{campaignId}/content/preparation", request))
                .Content.ReadFromJsonAsync<PreparationResult>())!;
            Check.Equal(0, restart.Calls);
            Check.Equal(JsonSerializer.Serialize(first), JsonSerializer.Serialize(replay));

            // An interrupted request left as unknown is replayed as unknown and is never re-sent.
            var path = Path.Combine(root, "preparation", campaignId + ".json");
            var document = JsonFiles.Read<PreparationCatalogDocument>(path);
            var resumed = Request(Id());
            string fingerprint = JsonFiles.Hash("preparation:" + JsonSerializer.Serialize(resumed, JsonFiles.Options));
            document.Records.Add(new(resumed.RequestId, fingerprint,
                new PreparationResult(resumed.RequestId, "unknown", JsonFiles.Hash(JsonSerializer.Serialize(resumed.Input, JsonFiles.Options)), JsonFiles.Hash(JsonSerializer.Serialize(resumed.Prompt, JsonFiles.Options)), null, null, [], "fake-preparation"), DateTimeOffset.UtcNow));
            JsonFiles.Write(path, document);
            var unknown = (await (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{campaignId}/content/preparation", resumed))
                .Content.ReadFromJsonAsync<PreparationResult>())!;
            Check.Equal("unknown", unknown.Status); Check.Equal(0, restart.Calls);

            // A full catalog refuses a new id instead of dropping unreviewed results.
            document = JsonFiles.Read<PreparationCatalogDocument>(path);
            while (document.Records.Count < PreparationCatalog.MaximumRecords)
            {
                var filler = Id();
                document.Records.Add(new(filler, JsonFiles.Hash("filler-" + document.Records.Count),
                    new PreparationResult(filler, "failed", JsonFiles.Hash("input"), JsonFiles.Hash("prompt"), null, null, [], "fake-preparation"), DateTimeOffset.UtcNow));
            }
            JsonFiles.Write(path, document);
            Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync(
                $"/api/v1/campaigns/{campaignId}/content/preparation", Request(Id()))).StatusCode);
            Check.Equal(0, restart.Calls);
        }
    }

    public static async Task KnowledgeSeedingVisibilityAndAdoption()
    {
        var fake = new FakePreparation();
        await using var h = await Host.Start(configure: b => b.Services.AddSingleton<IPreparationGenerator>(fake));

        var knowledge = new[]
        {
            new InitialKnowledgeEntry("fog-host", "clue", "主持线索", "只有主持可见", "", "host"),
            new InitialKnowledgeEntry("fog-public", "place", "旧港", "公开的港口", "harbor", "public"),
            new InitialKnowledgeEntry("fog-late", "npc", "守夜人", "抵达相邻地点后出现", "harbor", "arrival", "causeway")
        };
        var document = TestContent.Document with { InitialKnowledge = knowledge };
        var create = await h.Http.PostAsJsonAsync("/api/v1/campaigns",
            new CreateCampaignRequest("Knowledge", "Arden", CharacterEngine.Fighter, document, TestContent.Prompts, StartImmediately: true, Build: FullCreationTests.Named("Arden")));
        Check.Equal(HttpStatusCode.Created, create.StatusCode);
        var owner = (await create.Content.ReadFromJsonAsync<CreatedCampaign>())!;
        var s = owner.Snapshot;
        Check.True(s.WorldMemory!.Length == 3, "activation seeds prepared knowledge as world memory");
        Check.True(s.WorldMemory.Single(m => m.Id == "fog-late").RevealSceneId == "causeway");

        var guest = await Join(h, owner);
        Auth(h, guest.AccessToken);
        var guestView = (await h.Get(s.Id))!;
        Check.Equal(1, guestView.WorldMemory!.Length);
        Check.Equal("fog-public", guestView.WorldMemory[0].Id);
        Check.True(guestView.WorldMemory.All(m => m.Id != "fog-host"), "host-only knowledge never leaks to players");

        Auth(h, owner.AccessToken);
        var host = (await h.Get(s.Id))!;
        host = (await h.Act(host, "talk")).Snapshot;
        host = (await h.Act(host, "travel", "causeway")).Snapshot;
        Check.True(host.WorldMemory!.Length == 3, "the host sees every prepared entry");
        Auth(h, guest.AccessToken);
        var afterVisit = (await h.Get(s.Id))!;
        Check.True(afterVisit.WorldMemory!.Length == 2, "arrival knowledge becomes player-visible only after the reveal scene");
        Check.True(afterVisit.WorldMemory.Any(m => m.Id == "fog-late"));

        // Full adoption path: prepare a fresh blank campaign, import the draft, activate, then map.
        Auth(h, "");
        var blank = (await (await h.Http.PostAsJsonAsync("/api/v1/campaigns",
            new CreateCampaignRequest("Adopt", "Arden", CharacterEngine.Fighter, Prompts: TestContent.Prompts, Build: FullCreationTests.Named("Arden")))).Content.ReadFromJsonAsync<CreatedCampaign>())!;
        Auth(h, blank.AccessToken);
        fake.Next = _ => ValidProposal();
        var prepared = (await (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{blank.Snapshot.Id}/content/preparation", Request(Id())))
            .Content.ReadFromJsonAsync<PreparationResult>())!;
        Check.Equal("ready", prepared.Status);
        var import = (await (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{blank.Snapshot.Id}/content/adventure",
            new ImportAdventureRequest(Id(), blank.Snapshot.Version, prepared.Document!))).Content.ReadFromJsonAsync<ActionResponse>())!;
        var activate = (await (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{blank.Snapshot.Id}/content/activate",
            new ActivateContentRequest(Id(), import.Snapshot.Version))).Content.ReadFromJsonAsync<ActionResponse>())!;
        Check.Equal("harbor", activate.Snapshot.Scene.Id);
        Check.True(activate.Snapshot.WorldMemory!.Length == 1, "adopted knowledge is seeded on activation");
        var nodes = activate.Snapshot.Map.Nodes;
        Check.True(nodes.Length >= 1);
        Check.True(nodes.All(n => n.Unlocated), "prepared nodes stay unlocated on the map projection");
        Check.True(nodes.Any(n => n.Id == "cliff" && n.Unlocated), "the reachable neighbour is listed without coordinates");
    }

    public static async Task LegacyFingerprintAndValidation()
    {
        string json = JsonSerializer.Serialize(TestContent.Document, JsonFiles.Options);
        Check.True(!json.Contains("\"initialKnowledge\"", StringComparison.Ordinal), "legacy documents must not gain new keys");
        Check.True(!json.Contains("\"unlocated\"", StringComparison.Ordinal), "legacy scenes must not gain new keys");
        // LF-pinned values (JsonFiles.Options.NewLine). The earlier pins 66655d24…/9c633554… are the same
        // bytes with Windows CRLF; the same data must now hash identically on every OS.
        Check.True(!json.Contains('\r'), "fingerprint JSON never uses platform CRLF");
        Check.Equal("2075f0444b49ddd904f3c3744b188a7cee5c61d439ccfd31392df056fa02c8c7", JsonFiles.Hash(json));
        Check.Equal("0d8ac2e51323768c511b80988b3e66112fcee9940c24522605e05116a47c0813", JsonFiles.Hash(JsonSerializer.Serialize(TestContent.Prompts, JsonFiles.Options)));

        var knowledge = new[] { new InitialKnowledgeEntry("k1", "clue", "线索", "摘要", "harbor", "public") };
        var withKnowledge = TestContent.Document with { InitialKnowledge = knowledge };
        var changed = JsonSerializer.Serialize(withKnowledge, JsonFiles.Options);
        Check.True(changed.Contains("\"initialKnowledge\"", StringComparison.Ordinal));
        Check.True(JsonFiles.Hash(changed) != JsonFiles.Hash(json), "new optional content must change the binding fingerprint");

        // ContentValidator owns the boundary for imported optional fields.
        ContentValidator.Validate(withKnowledge);
        Check.Throws<GameException>(() => ContentValidator.Validate(withKnowledge with
        {
            InitialKnowledge = [new("k1", "clue", "线索", "摘要", "harbor", "arrival")]
        }));
        Check.Throws<GameException>(() => ContentValidator.Validate(withKnowledge with
        {
            InitialKnowledge = [new("k1", "clue", "线索", "摘要", "missing", "public")]
        }));
        Check.Throws<GameException>(() => ContentValidator.Validate(withKnowledge with
        {
            InitialKnowledge = [new("k1", "relic", "线索", "摘要", "", "public")]
        }));

        var located = new ContentScene { Id = "a", Title = "A" };
        var unlocated = new ContentScene { Id = "a", Title = "A", Unlocated = true };
        Check.True(!JsonSerializer.Serialize(located, JsonFiles.Options).Contains("unlocated", StringComparison.Ordinal));
        Check.True(JsonSerializer.Serialize(unlocated, JsonFiles.Options).Contains("\"unlocated\": true", StringComparison.Ordinal));

        var map = JsonSerializer.Serialize(new MapNode("a", "A", "visited", false, "hint", 0.5f, 0.5f, true), JsonFiles.Options);
        Check.True(map.Contains("\"unlocated\": true", StringComparison.Ordinal));
        Check.True(!JsonSerializer.Serialize(new MapNode("a", "A", "visited", false, "hint", 0.5f, 0.5f), JsonFiles.Options)
            .Contains("unlocated", StringComparison.Ordinal));
    }
}
