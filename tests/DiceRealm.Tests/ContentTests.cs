using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.Configuration;

namespace DiceRealm.Tests;

internal static class ContentTests
{
    // Deliberately neutral fixture IDs. This is test input, not a shipped/default adventure.
    private static ContentCondition Has(string fact) => new() { All = [fact] };
    private static AdventureDocument Document() => new()
    {
        Id = "import-test", Version = "1", Name = "Imported document", StartSceneId = "node-x",
        SourceText = "PRIVATE source document supplied by test author",
        Scenes = [new() { Id = "node-x", Title = "User title X", Summary = "User summary X", Arrival = "User arrival X", SafeRest = true,
            Actions = [new() { Id = "unlock", Target = "unlock", Label = "User action", Check = new("intelligence", "Investigation", 1),
                Success = new("User success", [new("fact", "open"), new("item", "gold-piece", 5)]), Failure = new("User failure", []) }],
            Exits = [new("node-z", Has("open"), 123)] },
            new() { Id = "node-z", Title = "User title Z", Summary = "User summary Z", Arrival = "User arrival Z",
                Actions = [new() { Id = "finish", Target = "finish", Label = "User ending", Success = new("User conclusion", [new("fact", "done"), new("chapter", Amount: 2)]) }],
                Exits = [new("node-x", new(), 25)] }],
        Quests = [new("goal", "User goal", "User instructions", "User reward text", new(), new(), Has("done"), [new("User objective", Has("done"))])],
        Branches = [new("choice", "result", "User branch label", Has("done"))],
        Level2Milestone = Has("open")
    };
    private static PromptBundle Prompts(string version = "1") => new(1, "import-prompts", version, "Author prompts", "User intent\r\nverbatim", "User narration\nverbatim");
    private sealed class RecordingText : IIntentInterpreter, INarrator
    {
        public int Calls;
        public PromptBundle? Last;
        public Task<Intent?> Interpret(string text, ActionChoice[] allowed, CancellationToken cancellationToken, string campaignId = "", PromptBundle? prompts = null)
        { Calls++; Last = prompts; return Task.FromResult<Intent?>(null); }
        public Task<Narrative> Narrate(NarrativeContext context, CancellationToken cancellationToken, string campaignId = "", PromptBundle? prompts = null)
        { Calls++; Last = prompts; Check.True(context.SourceText.StartsWith("PRIVATE")); return Task.FromResult(new Narrative("display only 999", "test")); }
    }
    private static async Task<CreatedCampaign> Draft(Host host)
    {
        var response = await host.Http.PostAsJsonAsync("/api/v1/campaigns", new CreateCampaignRequest("Empty", "Tester", Build: FullCreationTests.Named("Tester")));
        Check.Equal(HttpStatusCode.Created, response.StatusCode);
        var created = (await response.Content.ReadFromJsonAsync<CreatedCampaign>())!;
        host.Http.DefaultRequestHeaders.Authorization = new("Bearer", created.AccessToken);
        return created;
    }
    private static async Task<ActionResponse> Change(Host host, CampaignSnapshot s, string operation, object request)
    {
        var response = await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/content/{operation}", request);
        if (response.StatusCode != HttpStatusCode.OK) throw new Exception(await response.Content.ReadAsStringAsync());
        return (await response.Content.ReadFromJsonAsync<ActionResponse>())!;
    }
    public static async Task DraftValidationAndActivation()
    {
        var text = new RecordingText(); await using var host = await Host.Start(interpreter: text, narrator: text);
        var created = await Draft(host); var s = created.Snapshot;
        Check.Equal("draft", s.Content!.Status); Check.Equal("", s.Scene.Id); Check.Equal(0, s.AvailableActions.Length);
        Check.Equal(0, s.Map.Nodes.Length); Check.Equal("removed", s.SceneAsset.Status);
        Check.Equal(0, Directory.GetFiles(Path.Combine(host.Root, "asset-jobs")).Length);
        Check.Equal(HttpStatusCode.Conflict, (await host.Send(s.Id, new(Guid.NewGuid().ToString(), s.Version, "natural", Text: "invent a world"))).StatusCode);
        Check.Equal(HttpStatusCode.Conflict, (await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/content/activate", new ActivateContentRequest(Guid.NewGuid().ToString(), s.Version))).StatusCode);
        var original = s.Version;
        foreach (var invalid in new[] { Document() with { StartSceneId = "missing" }, Document() with { Scenes = [null!] }, Document() with { Scenes = [Document().Scenes[0] with { Actions = [new() { Id = "bad", Kind = "combat.attack", Success = new("x", []) }] }] } })
        {
            Check.Equal(HttpStatusCode.BadRequest, (await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/content/adventure", new ImportAdventureRequest(Guid.NewGuid().ToString(), s.Version, invalid))).StatusCode);
            Check.Equal(original, (await host.Get(s.Id))!.Version);
        }
        var request = new ImportAdventureRequest(Guid.NewGuid().ToString(), s.Version, Document());
        var one = await Change(host, s, "adventure", request); var again = await Change(host, s, "adventure", request);
        Check.True(again.Replayed); Check.Equal(one.Snapshot.Version, again.Snapshot.Version); s = again.Snapshot;
        Check.Equal("draft", s.Content!.Status); Check.Equal(0, s.AvailableActions.Length);
        Check.Equal(HttpStatusCode.Conflict, (await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/content/adventure", request with { Document = Document() with { Name = "changed" } })).StatusCode);
        s = (await Change(host, s, "prompts", new ImportPromptsRequest(Guid.NewGuid().ToString(), s.Version, Prompts()))).Snapshot;
        Check.Equal("ready_to_activate", s.Content!.Status); Check.Equal(0, text.Calls);
        var activation = new ActivateContentRequest(Guid.NewGuid().ToString(), s.Version);
        s = (await Change(host, s, "activate", activation)).Snapshot;
        Check.Equal("active", s.Content!.Status); Check.Equal("node-x", s.Scene.Id); Check.Equal("User arrival X", s.Events.Last().Text);
        Check.Equal(0, text.Calls); Check.Equal(0, Directory.GetFiles(Path.Combine(host.Root, "asset-jobs")).Length);
        Check.True(!JsonSerializer.Serialize(s).Contains("PRIVATE"));
        var exported = (await host.Http.GetFromJsonAsync<CampaignContentExport>($"/api/v1/campaigns/{s.Id}/content"))!;
        Check.Equal(Document().SourceText, exported.Adventure!.SourceText); Check.Equal(Prompts().Intent, exported.Prompts!.Intent);
        Check.Equal(HttpStatusCode.Conflict, (await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/content/adventure", new ImportAdventureRequest(Guid.NewGuid().ToString(), s.Version, Document()))).StatusCode);
        Check.True((await Change(host, s, "activate", activation)).Replayed);
        // Legacy scene-authoring ports cannot resurrect the removed generation feature.
        var revision = await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/scene-asset", new ReviseSceneAssetRequest(s.SceneAsset.Id, "User image prompt", "User style", [], []));
        Check.Equal(HttpStatusCode.Gone, revision.StatusCode);
        Check.Equal(0, Directory.GetFiles(Path.Combine(host.Root, "asset-jobs")).Length);
    }
    public static async Task RuntimeReplayAndRestart()
    {
        var text = new RecordingText(); var dice = new SequenceDice(12); var host = await Host.Start(dice: dice, interpreter: text, narrator: text);
        var create = await host.Http.PostAsJsonAsync("/api/v1/campaigns", new CreateCampaignRequest("Imported", "Tester", Adventure: Document(), Prompts: Prompts(), StartImmediately: true, Build: FullCreationTests.Named("Tester")));
        var created = (await create.Content.ReadFromJsonAsync<CreatedCampaign>())!;
        host.Http.DefaultRequestHeaders.Authorization = new("Bearer", created.AccessToken); var s = created.Snapshot;
        Check.True(!s.AvailableActions.Any(a => a.Kind == "travel"));
        var action = new ActionRequest(Guid.NewGuid().ToString(), s.Version, "script.action", "unlock");
        var responses = await Task.WhenAll(host.Send(s.Id, action), host.Send(s.Id, action));
        var results = await Task.WhenAll(responses.Select(async r => (await r.Content.ReadFromJsonAsync<ActionResponse>())!));
        Check.True(results[0].Replayed != results[1].Replayed); Check.Equal(1, dice.Count); Check.Equal(1, text.Calls);
        s = results[0].Snapshot; Check.Equal(59, s.Character.Required().Inventory.Single(i => i.Id == "gold-piece").Quantity);
        Check.Equal(Prompts().Narration, text.Last!.Narration); Check.Equal(12, s.Character.HitPoints);
        s = (await host.Act(s, "travel", "node-z")).Snapshot; Check.Equal(123L, s.ElapsedSeconds);
        s = (await host.Act(s, "script.action", "finish")).Snapshot; Check.Equal(2, s.Chapter); Check.Equal("completed", s.World!.Quests.Single().Status); Check.Equal("result", s.World.Branches.Single().Choice);
        var oldHash = s.Content!.Prompts!.Hash;
        s = (await Change(host, s, "prompts", new ImportPromptsRequest(Guid.NewGuid().ToString(), s.Version, Prompts("2")))).Snapshot;
        Check.True(s.Content!.Prompts!.Hash != oldHash); Check.Equal("node-z", s.Scene.Id); Check.True(s.Facts.Contains("done"));
        var root = host.Root; var version = s.Version; await host.DisposeAsync();
        await using var restart = await Host.Start(root, dice, interpreter: text, narrator: text); restart.Http.DefaultRequestHeaders.Authorization = new("Bearer", created.AccessToken);
        s = (await restart.Get(s.Id))!; Check.Equal(version, s.Version); Check.Equal("2", s.Content!.Prompts!.Version);
        Check.True((await (await restart.Send(s.Id, action)).Content.ReadFromJsonAsync<ActionResponse>())!.Replayed);
        s = (await restart.Act(s, "observe")).Snapshot; Check.Equal("2", text.Last!.Version);
        Check.Equal(1, dice.Count); Check.Equal(59, s.Character.Required().Inventory.Single(i => i.Id == "gold-piece").Quantity);
    }
    public static async Task ImportBoundariesAndPermissions()
    {
        await using var host = await Host.Start(); var created = await Draft(host); var s = created.Snapshot;
        string path = $"/api/v1/campaigns/{s.Id}/content/adventure";
        foreach (var body in new[] { "{\"document\":null}", "{\"unknown\":1}", "{\"requestId\":\"a\",\"requestId\":\"b\"}", new string('x', 1024 * 1024 + 1) })
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, path) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
            request.Headers.ExpectContinue = true;
            var response = await host.Http.SendAsync(request);
            Check.True(response.StatusCode is HttpStatusCode.BadRequest or HttpStatusCode.RequestEntityTooLarge, await response.Content.ReadAsStringAsync());
        }
        Check.Equal(1, (await host.Get(s.Id))!.Version);
        Check.Throws<GameException>(() => ContentValidator.Validate(Document() with { Scenes = [Document().Scenes[0] with { Actions = [new() { Id = "illegal", Success = new("x", [new("hp", "player", 999)]) }] }] }));
        var responseCreate = await host.Http.PostAsJsonAsync("/api/v1/campaigns", new CreateCampaignRequest("Permissions", "Host", Adventure: Document(), Prompts: Prompts(), StartImmediately: true, Build: FullCreationTests.Named("Host")));
        created = (await responseCreate.Content.ReadFromJsonAsync<CreatedCampaign>())!; s = created.Snapshot;
        host.Http.DefaultRequestHeaders.Authorization = new("Bearer", created.AccessToken);
        string inviteToken = new('a', 64), guestToken = new('b', 64);
        var invited = await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/invitations", new InviteRequest(Guid.NewGuid().ToString(), s.Version, inviteToken)); Check.Equal(HttpStatusCode.OK, invited.StatusCode);
        var joined = await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/join", new JoinCampaignRequest(Guid.NewGuid().ToString(), inviteToken, guestToken, "Guest", Build: FullCreationTests.Named("Guest"))); Check.Equal(HttpStatusCode.OK, joined.StatusCode);
        host.Http.DefaultRequestHeaders.Authorization = new("Bearer", guestToken); s = (await host.Get(s.Id))!;
        Check.Equal(HttpStatusCode.Forbidden, (await host.Http.GetAsync($"/api/v1/campaigns/{s.Id}/content")).StatusCode);
        Check.Equal(HttpStatusCode.Forbidden, (await host.Http.GetAsync($"/api/v1/campaigns/{s.Id}/content/prompt-history")).StatusCode);
        Check.Equal(HttpStatusCode.Forbidden, (await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/content/preflight", new PreflightRequest(Document()))).StatusCode);
        Check.Equal(HttpStatusCode.Forbidden, (await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/content/trial", new TrialRequest(Guid.NewGuid().ToString(), s.Version, new string('c', 64), Document(), Prompts()))).StatusCode);
        Check.Equal(HttpStatusCode.Forbidden, (await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/content/prompts-bind", new BindPromptsRequest(Guid.NewGuid().ToString(), s.Version, "absent"))).StatusCode);
        Check.Equal(HttpStatusCode.Forbidden, (await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/content/prompts", new ImportPromptsRequest(Guid.NewGuid().ToString(), s.Version, Prompts("3")))).StatusCode);
        Check.Equal(HttpStatusCode.Forbidden, (await host.Send(s.Id, new(Guid.NewGuid().ToString(), s.Version, "script.action", "unlock"))).StatusCode);
    }
    private sealed class WireHandler : HttpMessageHandler
    {
        public string Reply = "", System = "", User = "";
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(ct));
            var messages = body.RootElement.GetProperty("messages");
            Check.Equal(2, messages.GetArrayLength()); System = messages[0].GetProperty("content").GetString()!; User = messages[1].GetProperty("content").GetString()!;
            return new(HttpStatusCode.OK) { Content = new StringContent(Reply) };
        }
    }
    public static async Task PromptTransport()
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["DataPath"] = Path.Combine(Path.GetTempPath(), "prompt-wire-" + Guid.NewGuid()), ["TextAi:Model"] = "test", ["TextAi:ApiKey"] = "test-only" }).Build();
        using var directory = new DataDirectory(config);
        var handler = new WireHandler { Reply = FakeHandler.Chat(new { kind = "observe", target = "" }) };
        var ai = new OpenAiText(new HttpClient(handler), config, new ProviderBudget(directory, config));
        var bundle = Prompts();
        await ai.Interpret("input", [new("observe", "", "label")], default, prompts: bundle);
        Check.Equal(bundle.Intent, handler.System);
        handler.Reply = FakeHandler.Chat(new { text = "Any language 123" });
        await ai.Narrate(new("scene", "character", "server outcome", [], "author source", ["fact"]), default, prompts: bundle);
        Check.Equal(bundle.Narration, handler.System);
        using var data = JsonDocument.Parse(handler.User);
        Check.True(!data.RootElement.TryGetProperty("script_context", out _));
        Check.True(!data.RootElement.TryGetProperty("facts", out _));
        Check.True(!handler.User.Contains("author source"), "Narration must not send the complete authored script.");
        Check.Equal("server outcome", data.RootElement.GetProperty("outcome").GetString());
    }
    private sealed class Minimum : IDice { public int Roll(int sides) => 1; }
    public static Task ImportedEncounters()
    {
        var encounter = new ContentEncounter { Id = "two-units", Title = "Author encounter", StartLabel = "Author start", Enemies = [new("target-a", "A", 5, 1, 4, 10, 5), new("target-b", "B", 5, 3, 4, 10, 5)], Victory = new("Author victory", [new("fact", "won")]) };
        var document = Document() with { Scenes = [Document().Scenes[0] with { Exits = [], Encounter = encounter }], Quests = [], Branches = [] };
        ContentValidator.Validate(document);
        var c = new Campaign { Id = Guid.NewGuid().ToString(), Name = "test", TokenHash = "test", Character = CharacterEngine.Create("Tester", CharacterEngine.Wizard), Adventure = document, Prompts = Prompts(), ContentActivated = true, SceneId = "node-x" };
        var engine = new CombatEngine(new Minimum());
        engine.Resolve(c, "combat.start", "");
        Check.Equal(2, c.Combat!.Units.Count(u => u.Team == "enemy"));
        Check.True(CombatEngine.Choices(c).Any(a => a.Target == "magic-missile:target-b"));
        engine.Resolve(c, "combat.cast", "magic-missile:target-a"); Check.Equal("active", c.Combat.Status); Check.True(!c.Facts.Contains("won"));
        var saved = JsonSerializer.Serialize(c, JsonFiles.Options); c = JsonSerializer.Deserialize<Campaign>(saved, JsonFiles.Options)!;
        engine.Resolve(c, "combat.end_turn", ""); engine.Resolve(c, "combat.cast", "magic-missile:target-b");
        Check.Equal("victory", c.Combat!.Status); Check.True(c.Facts.Contains("won")); Check.Equal("Author victory", c.Combat.Log.Last().Text);
        Check.Throws<GameException>(() => engine.Resolve(c, "combat.start", ""));
        return Task.CompletedTask;
    }
}
