using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace DiceRealm.Tests;

internal static class WorldMemoryTests
{
    private static string Id() => Guid.NewGuid().ToString();
    private static ActionRequest Input(CampaignSnapshot s, string text) => new(Id(), s.Version, "natural", Text: text);
    private static void Auth(Host h, string token) => h.Http.DefaultRequestHeaders.Authorization = new("Bearer", token);
    private static async Task<ActionResponse> Post(Host h, string id, string route, object body)
    {
        var response = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/{route}", body);
        if (!response.IsSuccessStatusCode) throw new Exception(response.StatusCode + " " + await response.Content.ReadAsStringAsync());
        return (await response.Content.ReadFromJsonAsync<ActionResponse>())!;
    }
    private sealed class Director(Func<AdventureContext, AdventureDecision> reply) : IIntentInterpreter
    {
        public int Calls; public AdventureContext? Last;
        public Task<Intent?> Interpret(string text, ActionChoice[] allowed, CancellationToken cancellationToken, string campaignId = "", PromptBundle? prompts = null) => throw new Exception("No legacy call expected");
        public Task<AdventureDecision> Direct(AdventureContext context, CancellationToken cancellationToken, string campaignId = "", PromptBundle? prompts = null)
        { Calls++; Last = context; return Task.FromResult(reply(context)); }
    }
    private static WorldMemoryProposal Memory(string kind = "npc", string name = "旅人艾尔", string scene = "harbor") => new("", kind, name, "旅人说自己正在寻找故乡的消息。", "known", scene);
    private static AdventureDecision Narrate(params WorldMemoryProposal[] memory) => new("narrate", [], Narrative: "旅人停下脚步，讲述了海边的往事。", Memory: memory);

    public static async Task AutomaticMemoryReplayAndRestart()
    {
        var dice = new SequenceDice();
        var provider = new Director(c => c.KnownMemory.Length == 0 ? Narrate(Memory(), Memory("quest", "寻找家书"), Memory("place", "故乡", ""), Memory("clue", "旧船名")) :
            Narrate(new WorldMemoryProposal(c.KnownMemory.Single(m => m.Kind == "npc").Id, "npc", "旅人艾尔", "已经记下旅人提到的船名。", "active", "harbor")));
        var h = await Host.Start(dice: dice, interpreter: provider); var owner = await h.Create(); var s = owner.Snapshot;
        string original = JsonSerializer.Serialize(s.Character); string facts = JsonSerializer.Serialize(s.Facts); long seconds = s.ElapsedSeconds;
        var request = Input(s, "询问旅人的家乡，并记下相关消息");
        var responses = await Task.WhenAll(Post(h, s.Id, "actions/input", request), Post(h, s.Id, "actions/input", request));
        Check.True(responses.Any(r => r.Replayed)); s = responses[0].Snapshot;
        Check.Equal("narrated", responses[0].Resolution.Status); Check.Equal(1, provider.Calls); Check.Equal(0, dice.Count);
        Check.True(s.PendingIntent is null && s.PendingRoll is null && s.PendingRulings.Length == 0);
        Check.Equal(original, JsonSerializer.Serialize(s.Character)); Check.Equal(facts, JsonSerializer.Serialize(s.Facts)); Check.Equal(seconds, s.ElapsedSeconds);
        Check.Equal(4, s.WorldMemory!.Length); Check.True(s.WorldMemory.All(m => Guid.TryParse(m.Id, out _) && m.Revision == 1 && m.OriginSequence == 2 && m.Source == "ai"));
        var activity = (await h.Http.GetFromJsonAsync<ActivityPage>($"/api/v1/campaigns/{s.Id}/activity"))!.Entries.Single();
        Check.Equal(request.Text, activity.Origin!.Input); Check.Equal("completed", activity.Status); Check.Equal(Narrate().Narrative, activity.Narrative);
        var firstNpc = s.WorldMemory.Single(m => m.Kind == "npc");
        s = (await Post(h, s.Id, "actions/input", Input(s, "再问问那条船"))).Snapshot;
        Check.Equal(2, provider.Calls); Check.Equal(4, s.WorldMemory!.Length);
        var updated = s.WorldMemory.Single(m => m.Kind == "npc"); Check.Equal(firstNpc.Id, updated.Id); Check.Equal(2, updated.Revision); Check.Equal(2, updated.OriginSequence); Check.Equal(3, updated.UpdatedSequence);
        Check.Equal(4, provider.Last!.KnownMemory.Length);
        string path = h.Root; await h.DisposeAsync(); h = await Host.Start(path, interpreter: provider, dice: dice); Auth(h, owner.AccessToken);
        Check.True((await Post(h, s.Id, "actions/input", request)).Replayed); Check.Equal(2, provider.Calls);
        s = (await Post(h, s.Id, "archive", new ArchiveCampaignRequest(Id(), s.Version, true))).Snapshot;
        Check.True((await Post(h, s.Id, "actions/input", request)).Replayed); Check.Equal(4, s.WorldMemory!.Length); Check.Equal(0, dice.Count);
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/actions/input", request with { Text = "改写输入" })).StatusCode);
        await h.DisposeAsync();
    }

    public static async Task InvalidPlansAndBoundedContext()
    {
        var provider = new Director(_ => Narrate(Memory(), Memory("clue", "未公开地点", "beacon")));
        await using var h = await Host.Start(interpreter: provider); var owner = await h.Create(); var s = owner.Snapshot;
        s = (await Post(h, s.Id, "actions/input", Input(s, "询问秘密"))).Snapshot;
        Check.Equal("unavailable", s.PendingIntent!.Source); Check.Equal(0, s.WorldMemory!.Length); Check.Equal(0, s.PendingRulings.Length);
        var c = TestContent.Campaign("harbor", "Bounds");
        c.Adventure = c.Adventure! with { SourceText = "PRIVATE_SCRIPT_SENTINEL" }; c.Facts.Add("PRIVATE_FACT_SENTINEL");
        c.WorldMemory.Add(new("private", "clue", "PRIVATE_MEMORY_SENTINEL", "SECRET_SUMMARY", "known", "", 1, 1, 1, "player", "dm", true));
        for (int i = 0; i < 40; i++) c.WorldMemory.Add(new("public-" + i, "clue", "已知线索" + i, "公开摘要", "known", "", 1, 1, i, "player", "ai"));
        var context = AdventureDirecting.Build(c, IntentContexts.Build(c, "问路", [], IntentContexts.SelectCandidates(ActionUnderstanding.Candidates(c), "问路")));
        Check.Equal(32, context.KnownMemory.Length); Check.True(context.KnownScenes.All(x => x.Id != "beacon"));
        string wire = JsonSerializer.Serialize(context, JsonFiles.Options);
        foreach (var secret in new[] { "PRIVATE_SCRIPT_SENTINEL", "PRIVATE_FACT_SENTINEL", "PRIVATE_MEMORY_SENTINEL", "SECRET_SUMMARY", "tokenHash" }) Check.True(!wire.Contains(secret), secret);
        var ids = context.KnownMemory.Select(m => m.Id).ToHashSet(); var scenes = context.KnownScenes.Select(m => m.Id).ToHashSet();
        var invalid = new[] {
            new[] { Memory(), Memory() }, new[] { Memory() with { Id = "private" } }, new[] { Memory() with { Id = "invented" } },
            new[] { Memory() with { Kind = "hp" } }, new[] { Memory() with { Status = "rewarded" } }, new[] { Memory() with { Name = "\0" } },
            new[] { Memory() with { Summary = new string('x', 801) } }, new[] { Memory() with { SceneId = "beacon" } },
            Enumerable.Range(0, 7).Select(i => Memory(name: "too many " + i)).ToArray(), new WorldMemoryProposal[] { null! }
        };
        foreach (var entries in invalid) Check.Throws<GameException>(() => WorldMemories.Plan(c, entries, ids, scenes, 2, "ai"));
        Check.Equal(41, c.WorldMemory.Count);
        var action = context.Intent.Candidates[0].Id;
        Check.Throws<InvalidDataException>(() => AdventureDirecting.Validate(new("action", [action], Memory: [Memory()]), context));
        Check.Throws<InvalidDataException>(() => AdventureDirecting.Validate(Narrate(), context with { CanNarrate = false }));
        Check.Throws<InvalidDataException>(() => AdventureDirecting.Validate(Narrate() with { CandidateIds = [action] }, context));
        Check.Throws<InvalidDataException>(() => AdventureDirecting.Validate(new("clarify", [], "请说明", "伪造已完成"), context));
    }

    public static async Task CorrectionsPermissionsPrivacyAndHistory()
    {
        var provider = new Director(_ => Narrate(Memory()));
        var h = await Host.Start(interpreter: provider); var owner = await h.Create(); var s = owner.Snapshot;
        var invite = new InviteRequest(Id(), s.Version, new string('a', 64)); await Post(h, s.Id, "invitations", invite);
        var join = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/join", new JoinCampaignRequest(Id(), invite.InviteToken, new string('b', 64), "客人", Build: FullCreationTests.Named("客人")));
        var guest = (await join.Content.ReadFromJsonAsync<CreatedCampaign>())!; guest = await h.ApproveGuest(owner, guest);
        Auth(h, guest.AccessToken); s = guest.Snapshot;
        s = (await Post(h, s.Id, "actions/input", Input(s, "问候旅人"))).Snapshot; int root = s.Version; var memory = s.WorldMemory!.Single();
        var correct = new CorrectWorldMemoryRequest(Id(), s.Version, memory.Id, memory.Revision, "PRIVATE_CORRECTED_NAME", "PRIVATE_CORRECTED_SUMMARY", "known", true, "PRIVATE_CORRECTION_REASON");
        var prose = new CorrectAdventureRequest(Id(), s.Version, root, "旅人称自己叫埃尔。", "纠正口误，不重新结算");
        Check.Equal(HttpStatusCode.Forbidden, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/world/correct", correct)).StatusCode);
        Check.Equal(HttpStatusCode.Forbidden, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/adventure/correct", prose)).StatusCode);
        Auth(h, owner.AccessToken);
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/world/correct", correct with { Revision = 0 })).StatusCode);
        s = (await Post(h, s.Id, "world/correct", correct)).Snapshot;
        Check.Equal(2, s.WorldMemory!.Single().Revision); Check.True(s.WorldMemory!.Single().Hidden); Check.Equal(root, s.WorldMemory!.Single().OriginSequence);
        Check.True((await Post(h, s.Id, "world/correct", correct)).Replayed);
        prose = prose with { ExpectedVersion = s.Version };
        var corrected = await Task.WhenAll(Post(h, s.Id, "adventure/correct", prose), Post(h, s.Id, "adventure/correct", prose));
        Check.True(corrected.Any(x => x.Replayed)); s = corrected[0].Snapshot;
        Check.Equal(1, s.AdventureCorrections!.Length); Check.Equal(1, provider.Calls);
        Auth(h, guest.AccessToken); var guestState = (await h.Get(s.Id))!; Check.Equal(0, guestState.WorldMemory!.Length);
        foreach (string path in new[] { "", "/events?after=0&limit=100", "/journal?after=0&limit=100", "/activity?after=0&limit=100", "/journal/export", "/recap" })
        {
            var read = await h.Http.GetAsync($"/api/v1/campaigns/{s.Id}" + path);
            Check.Equal(path == "/journal/export" ? HttpStatusCode.Forbidden : HttpStatusCode.OK, read.StatusCode);
            string projection = await read.Content.ReadAsStringAsync();
            foreach (string hiddenText in new[] { "PRIVATE_CORRECTED_NAME", "PRIVATE_CORRECTED_SUMMARY", "PRIVATE_CORRECTION_REASON" }) Check.True(!projection.Contains(hiddenText), "Hidden correction leaked via " + path);
        }
        var activity = (await h.Http.GetFromJsonAsync<ActivityEntry>($"/api/v1/campaigns/{s.Id}/activity/{root}"))!;
        Check.Equal(Narrate().Narrative, activity.Narrative); Check.Equal(prose.Text, activity.Correction!.Text); Check.Equal("问候旅人", activity.Origin!.Input);
        // A host cannot publish another player's unconfirmed input by attaching a public correction.
        guestState = (await Post(h, s.Id, "actions/interpret", Input(guestState, "GUEST_PRIVATE_DRAFT"))).Snapshot;
        int guestPrivate = guestState.Version; Auth(h, owner.AccessToken);
        Check.Equal(HttpStatusCode.NotFound, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/adventure/correct", new CorrectAdventureRequest(Id(), guestState.Version, guestPrivate, "不应公开", "无权限"))).StatusCode);
        // Even the host's own unpublished intent must not become public through the correction API.
        s = (await Post(h, s.Id, "actions/interpret", Input(guestState, "HOST_PRIVATE_DRAFT"))).Snapshot;
        Check.Equal(HttpStatusCode.NotFound, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/adventure/correct", new CorrectAdventureRequest(Id(), s.Version, s.Version, "不应公开", "尚未发布"))).StatusCode);
        string data = h.Root; await h.DisposeAsync(); h = await Host.Start(data, interpreter: provider); Auth(h, owner.AccessToken);
        Check.True((await Post(h, s.Id, "world/correct", correct)).Replayed); Check.True((await Post(h, s.Id, "adventure/correct", prose)).Replayed); Check.Equal(1, provider.Calls);
        var events = await h.Http.GetStringAsync($"/api/v1/campaigns/{s.Id}/events?after=0&limit=100");
        Check.True(events.Contains("问候旅人") && events.Contains("PRIVATE_CORRECTION_REASON") && events.Contains("纠正口误"));
        await h.DisposeAsync();
    }

    public static async Task OfflineBypassesDirector()
    {
        var provider = new Director(_ => throw new Exception("Must not call online director"));
        await using var h = await Host.Start(interpreter: provider);
        string token = new('a', 64);
        var c = new Campaign { Id = Id(), Name = "Offline", TokenHash = JsonFiles.Hash(token), Character = CharacterEngine.Create("Trial", CharacterEngine.Fighter),
            Adventure = TestContent.Document, Prompts = TestContent.Prompts, ContentActivated = true, OfflineTrial = true, SceneId = "harbor" };
        c.Events.Add(new(Id(), 1, "arrival", "Offline fixture", "", "authored", DateTimeOffset.UtcNow, null));
        h.App.Services.GetRequiredService<CampaignStore>().Create(c); Auth(h, token); var s = (await h.Get(c.Id))!;
        s = (await Post(h, s.Id, "actions/input", Input(s, "观察"))).Snapshot;
        Check.Equal(0, provider.Calls); Check.True(s.PendingIntent is null); Check.Equal(0, s.WorldMemory!.Length);
    }

    private sealed class Wire : HttpMessageHandler
    {
        public string Reply = ""; public string[] Messages = []; public int Calls;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Calls++; using var json = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(ct));
            Messages = json.RootElement.GetProperty("messages").EnumerateArray().Select(m => m.GetProperty("content").GetString()!).ToArray();
            return new(HttpStatusCode.OK) { Content = new StringContent(Reply) };
        }
    }
    public static async Task StrictProviderContract()
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["DataPath"] = Path.Combine(Path.GetTempPath(), "world-wire-" + Id()), ["TextAi:ApiKey"] = "fake", ["TextAi:Model"] = "fixture" }).Build();
        using var directory = new DataDirectory(config); var wire = new Wire();
        var ai = new OpenAiText(new HttpClient(wire), config, new ProviderBudget(directory, config));
        var c = TestContent.Campaign("harbor", "Wire"); var context = AdventureDirecting.Build(c, IntentContexts.Build(c, "问候", [], IntentContexts.SelectCandidates(ActionUnderstanding.Candidates(c), "问候")));
        wire.Reply = FakeHandler.Chat(new { decision = "narrate", candidateIds = Array.Empty<string>(), question = "", narrative = "旅人向你问好。", memory = new[] { new { id = "", kind = "npc", name = "旅人", summary = "初次见面", status = "known", sceneId = "harbor" } } });
        var result = await ai.Direct(context, default, prompts: TestContent.Prompts); Check.Equal("narrate", result.Decision); Check.Equal(1, result.Memory!.Length);
        Check.Equal(3, wire.Messages.Length); Check.Equal(TestContent.Prompts.Intent, wire.Messages[0]); Check.Equal(TestContent.Prompts.Narration, wire.Messages[1]);
        using var user = JsonDocument.Parse(wire.Messages[2]); Check.True(user.RootElement.TryGetProperty("known_memory", out _)); Check.True(user.RootElement.TryGetProperty("player_context", out _));
        foreach (var malformed in new object[] {
            new { decision = "narrate", candidateIds = Array.Empty<string>(), question = "", narrative = "恢复生命", memory = Array.Empty<object>(), hp = 99 },
            new { decision = "narrate", candidateIds = Array.Empty<string>(), question = "", narrative = "新增坐标", memory = new[] { new { id = "", kind = "place", name = "位置", summary = "猜测位置", status = "known", sceneId = "", x = .5 } } }
        })
        {
            wire.Reply = FakeHandler.Chat(malformed);
            try { await ai.Direct(context, default, prompts: TestContent.Prompts); throw new Exception("Accepted unknown authority fields"); } catch (JsonException) { }
        }
        wire.Reply = FakeHandler.Chat(new { kind = "observe", target = "" });
        Check.Equal("legacy", (await ai.Direct(context, default, prompts: TestContent.Prompts)).Source);
        int calls = wire.Calls;
        try { await ai.Direct(context, default); throw new Exception("Accepted absent prompts"); } catch (InvalidOperationException) { }
        Check.Equal(calls, wire.Calls);
    }
}
