using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace DiceRealm.Tests;

internal static class ActionUnderstandingTests
{
    private static string Id() => Guid.NewGuid().ToString();
    private static void Auth(Host h, string token) => h.Http.DefaultRequestHeaders.Authorization = new("Bearer", token);
    private static async Task<ActionResponse> Post<T>(Host h, string id, string endpoint, T request)
    {
        var response = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/{endpoint}", request);
        Check.True(response.StatusCode == HttpStatusCode.OK, endpoint + ": " + await response.Content.ReadAsStringAsync());
        return (await response.Content.ReadFromJsonAsync<ActionResponse>())!;
    }
    private static ActionRequest Input(CampaignSnapshot s, string text) => new(Id(), s.Version, "natural", Text: text);
    private static IntentResponseRequest Reply(CampaignSnapshot s, string decision, string text = "", string? option = null)
        => new(Id(), s.Version, s.PendingIntent!.Id, decision, option ?? (decision == "choose" ? s.PendingIntent.Options.First().Id : ""), text);
    private sealed class Scripted(Func<IntentContext, IntentInterpretation> choose) : IIntentInterpreter, INarrator
    {
        public int Calls, Narrations;
        public IntentContext? Last;
        public NarrativeContext? Narrative;
        public Task<Intent?> Interpret(string text, ActionChoice[] allowed, CancellationToken ct, string campaignId = "", PromptBundle? prompts = null)
            => throw new Exception("New requests must use contextual understanding.");
        public Task<IntentInterpretation> Understand(IntentContext context, CancellationToken ct, string campaignId = "", PromptBundle? prompts = null)
        { Calls++; Last = context; return Task.FromResult(choose(context)); }
        public Task<Narrative> Narrate(NarrativeContext context, CancellationToken ct, string campaignId = "", PromptBundle? prompts = null)
        { Narrations++; Narrative = context; return Task.FromResult(new Narrative("", "fixture")); }
    }
    private static IntentInterpretation Select(IntentContext c, Func<ActionCandidate, bool> match)
        => new("action", [c.Commands.First(match).Id]);

    public static async Task ClarifyRollReplayAndRestart()
    {
        var dice = new SequenceDice(18);
        var text = new Scripted(c => c.Clarifications.Length == 0
            ? new("clarify", [], "你想仔细检查什么？") : Select(c, x => x.Action?.Kind == "investigate"));
        var h = await Host.Start(dice: dice, interpreter: text, narrator: text);
        var owner = await h.Create(); var initial = owner.Snapshot;
        var request = Input(initial, "我想仔细弄明白这里发生了什么");
        var first = await Post(h, initial.Id, "actions/interpret", request); var s = first.Snapshot;
        Check.Equal("awaiting_clarification", first.Resolution.Status); Check.Equal(0, dice.Count); Check.Equal(1, text.Calls);
        Check.Equal(0L, s.ElapsedSeconds); Check.Equal(JsonSerializer.Serialize(initial.Character), JsonSerializer.Serialize(s.Character));
        Check.True(s.PendingIntent is not null); Check.Equal(0, s.PendingRulings.Length); Check.Equal(0, text.Narrations);
        Check.True((await Post(h, s.Id, "actions/interpret", request)).Replayed); Check.Equal(1, text.Calls);
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/actions/interpret", request with { Text = "different" })).StatusCode);
        var clarify = Reply(s, "clarify", "查看栈桥现场留下的痕迹");
        s = (await Post(h, s.Id, "intents/respond", clarify)).Snapshot;
        Check.Equal(2, text.Calls); Check.Equal(1, s.PendingIntent!.Clarifications.Length); Check.Equal(0, dice.Count);
        Check.Equal(1, s.PendingIntent.Options.Length); Check.True((await Post(h, s.Id, "intents/respond", clarify)).Replayed);
        string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, dice, interpreter: text, narrator: text); Auth(h, owner.AccessToken);
        s = (await h.Get(s.Id))!; var choose = Reply(s, "choose");
        var both = await Task.WhenAll(Enumerable.Range(0, 2).Select(_ => Post(h, s.Id, "intents/respond", choose)));
        Check.True(both.Any(x => x.Replayed)); s = both[0].Snapshot;
        Check.Equal(2, text.Calls); Check.Equal(0, dice.Count); Check.True(s.PendingIntent is null && s.PendingRoll is not null);
        var confirm = new RollResponseRequest(Id(), s.Version, s.PendingRoll!.Id, "roll");
        var done = await Post(h, s.Id, "rolls/respond", confirm);
        Check.Equal(1, dice.Count); Check.Equal(1, text.Narrations); Check.Equal("", text.Narrative!.SourceText); Check.True(text.Narrative.Facts is null);
        Check.True(text.Narrative.PlayerContext is not null);
        Check.True((await Post(h, s.Id, "rolls/respond", confirm)).Replayed); Check.Equal(1, dice.Count);
        var page = (await h.Http.GetFromJsonAsync<ActivityPage>($"/api/v1/campaigns/{s.Id}/activity"))!;
        var entry = page.Entries.Single(); Check.Equal(2, entry.Sequence); Check.Equal("completed", entry.Status);
        Check.Equal(request.Text, entry.Origin!.Input); Check.Equal(clarify.Text, entry.Origin.Clarifications!.Single().Answer);
        Check.Equal(18, entry.InitialResult!.Check!.Selected); Check.Equal(first.Resolution.IntentId, entry.InitialResult.IntentId);
        Check.True(!JsonSerializer.Serialize(done.Snapshot).Contains("expectedVersion"), "Private command continuations are not snapshot fields.");
        await h.DisposeAsync(); await using var restarted = await Host.Start(root, dice, interpreter: text, narrator: text); Auth(restarted, owner.AccessToken);
        Check.True((await Post(restarted, s.Id, "actions/interpret", request)).Replayed); Check.True((await Post(restarted, s.Id, "intents/respond", choose)).Replayed);
        Check.Equal(2, text.Calls); Check.Equal(1, dice.Count);
    }

    public static async Task SourceSpellAndRuling()
    {
        var dice = new SequenceDice(17);
        var text = new Scripted(c =>
        {
            Check.True(!c.Commands.Any(x => x.Character?.Operation is "spell" or "use" or "feature"));
            return new("clarify", [], "你要对什么目标做什么？");
        });
        await using var h = await Host.Start(dice: dice, interpreter: text, narrator: text);
        var response = await h.Http.PostAsJsonAsync("/api/v1/campaigns", new CreateCampaignRequest("Spell context", "Wizard", CharacterEngine.Fighter,
            TestContent.Document, TestContent.Prompts, true, Build: FullCreationTests.Named("Wizard", CharacterEngine.Wizard)));
        var owner = (await response.Content.ReadFromJsonAsync<CreatedCampaign>())!; Auth(h, owner.AccessToken); var initial = owner.Snapshot;
        var proposed = await Post(h, initial.Id, "actions/interpret", Input(initial, "使用 Magic Missile 解决眼前的问题"));
        Check.Equal(0, dice.Count); Check.Equal(JsonSerializer.Serialize(initial.Character), JsonSerializer.Serialize(proposed.Snapshot.Character));
        Check.Equal("awaiting_clarification", proposed.Resolution.Status); Check.Equal(0, proposed.Snapshot.PendingRulings.Length);
        // Simulate an upgrade with a previously frozen recording option. It retains its old
        // meaning, never upgrades to a new effect and never introduces undisclosed dice.
        await h.App.Services.GetRequiredService<CampaignStore>().Access(initial.Id, owner.AccessToken, true, c =>
        {
            ActionUnderstanding.Current(c)!.Options = [ActionUnderstanding.Candidates(c).Single(x => x.Character?.Operation == "spell" && x.Character.Key.Contains("magic-missile") && x.Character.Key.EndsWith("/slot"))];
            return Task.FromResult(true);
        });
        proposed = proposed with { Snapshot = (await h.Get(initial.Id))! };
        var option = proposed.Snapshot.PendingIntent!.Options.Single(); Check.True(option.Label.Contains("Spell Slots (1st)"));
        Check.True(option.Details.Note.Contains("目标效果"));
        var choose = Reply(proposed.Snapshot, "choose"); var used = await Post(h, initial.Id, "intents/respond", choose);
        Check.Equal(0, dice.Count); Check.Equal(0L, used.Snapshot.ElapsedSeconds);
        Check.Equal(CharacterEngine.Value(initial.Character.Required(), "Spell Slots (1st)") - 1, CharacterEngine.Value(used.Snapshot.Character.Required(), "Spell Slots (1st)"));
        var ruling = used.Snapshot.PendingRulings.Single(); Check.Equal("pending", ruling.Status); Check.Equal(2, ruling.OriginSequence);
        Check.True((await Post(h, initial.Id, "intents/respond", choose)).Replayed); Check.Equal(1, text.Calls);
        var activity = (await h.Http.GetFromJsonAsync<ActivityPage>($"/api/v1/campaigns/{initial.Id}/activity"))!.Entries.Single();
        Check.Equal("awaiting_ruling", activity.Status); Check.True(activity.Origin!.Changes.Any(c => c.Operation == "resource"));
        // The same single-player host can explicitly respond; a pending ruling is not an unfinishable state.
        var resolve = new ResolveRulingRequest(Id(), used.Snapshot.Version, ruling.Id, "narrative", "本次用途已确认，具体变化另行预览", "本场主持裁定");
        var settled = await Post(h, initial.Id, "rulings/respond", resolve);
        Check.Equal("resolved", settled.Snapshot.PendingRulings.Single().Status);
        Check.Equal(CharacterEngine.Value(used.Snapshot.Character.Required(), "Spell Slots (1st)"), CharacterEngine.Value(settled.Snapshot.Character.Required(), "Spell Slots (1st)"));
    }

    public static async Task AuthorityStaleAndCancel()
    {
        var text = new Scripted(c => Select(c, x => x.Action?.Kind == "observe")); var dice = new SequenceDice(19);
        await using var h = await Host.Start(dice: dice, interpreter: text); var owner = await h.Create();
        string Secret() => Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        var invitation = new InviteRequest(Id(), owner.Snapshot.Version, Secret()); await Post(h, owner.Snapshot.Id, "invitations", invitation);
        var join = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{owner.Snapshot.Id}/join", new JoinCampaignRequest(Id(), invitation.InviteToken, Secret(), "Guest", CharacterEngine.Fighter, Build: FullCreationTests.Named("Guest", CharacterEngine.Wizard)));
        var guest = (await join.Content.ReadFromJsonAsync<CreatedCampaign>())!;
        guest = await h.ApproveGuest(owner, guest);
        var s = (await h.Get(owner.Snapshot.Id))!; s = (await Post(h, s.Id, "actions/interpret", Input(s, "看看这里"))).Snapshot;
        var choose = Reply(s, "choose");
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/intents/respond", choose with { OptionId = "not-offered" })).StatusCode);
        var forged = new { requestId = Id(), expectedVersion = s.Version, intentId = s.PendingIntent!.Id, decision = "choose", optionId = choose.OptionId, text = "", selected = 20 };
        Check.Equal(HttpStatusCode.BadRequest, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/intents/respond", forged)).StatusCode);
        Auth(h, guest.AccessToken); var g = (await h.Get(s.Id))!; Check.True(g.PendingIntent is null);
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/intents/respond", choose)).StatusCode);
        await h.Act(g, "observe"); Auth(h, owner.AccessToken); s = (await h.Get(s.Id))!;
        Check.True(!s.PendingIntent!.Available); choose = choose with { RequestId = Id(), ExpectedVersion = s.Version };
        var stale = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/intents/respond", choose);
        Check.Equal(HttpStatusCode.Conflict, stale.StatusCode); Check.True((await stale.Content.ReadAsStringAsync()).Contains("intent_context_changed"));
        Check.Equal(0, dice.Count); var cancel = Reply(s, "cancel"); var cancelled = await Post(h, s.Id, "intents/respond", cancel);
        Check.True(cancelled.Snapshot.PendingIntent is null); Check.Equal("cancelled", cancelled.Resolution.Status);
        Check.True((await Post(h, s.Id, "intents/respond", cancel)).Replayed);
        var entry = (await h.Http.GetFromJsonAsync<ActivityPage>($"/api/v1/campaigns/{s.Id}/activity"))!.Entries.First(e => e.Kind == "intent.request");
        Check.Equal("cancelled", entry.Status); Check.Equal(1, text.Calls);
    }

    public static async Task PrivateUntilPublished()
    {
        var text = new Scripted(c => Select(c, x => x.Action?.Kind == "observe"));
        var h = await Host.Start(interpreter: text); var owner = await h.Create();
        string Secret() => Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        var invite = new InviteRequest(Id(), owner.Snapshot.Version, Secret()); await Post(h, owner.Snapshot.Id, "invitations", invite);
        var joined = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{owner.Snapshot.Id}/join", new JoinCampaignRequest(Id(), invite.InviteToken, Secret(), "Guest", CharacterEngine.Fighter, Build: FullCreationTests.Named("Guest", CharacterEngine.Wizard)));
        var guest = (await joined.Content.ReadFromJsonAsync<CreatedCampaign>())!;
        guest = await h.ApproveGuest(owner, guest);
        Auth(h, guest.AccessToken); var s = (await h.Get(owner.Snapshot.Id))!;
        s = (await Post(h, s.Id, "actions/interpret", Input(s, "PRIVATE_INTENT_SENTINEL"))).Snapshot;
        int sequence = s.Version;
        async Task Hidden(int root)
        {
            Auth(h, owner.AccessToken);
            foreach (string path in new[] { "", "/events?after=0&limit=100", "/journal?after=0&limit=100", "/activity?after=0&limit=100", "/journal/export" })
            {
                var response = await h.Http.GetAsync($"/api/v1/campaigns/{s.Id}" + path);
                Check.Equal(HttpStatusCode.OK, response.StatusCode); string body = await response.Content.ReadAsStringAsync();
                Check.True(!body.Contains("PRIVATE_INTENT_SENTINEL") && !body.Contains("PRIVATE_ANSWER_SENTINEL"), "Private intent escaped through " + path);
            }
            Check.Equal(HttpStatusCode.NotFound, (await h.Http.GetAsync($"/api/v1/campaigns/{s.Id}/activity/{root}")).StatusCode);
            var page = (await h.Http.GetFromJsonAsync<JournalPage>($"/api/v1/campaigns/{s.Id}/journal?after={root - 1}&limit=1"))!;
            Check.Equal(root, page.NextAfter); Check.Equal(0, page.Events.Length);
            var activity = (await h.Http.GetFromJsonAsync<ActivityPage>($"/api/v1/campaigns/{s.Id}/activity?after={root - 1}&limit=1"))!;
            Check.Equal(root, activity.NextAfter); Check.Equal(0, activity.Entries.Length);
            Auth(h, guest.AccessToken);
        }
        await Hidden(sequence);
        var clarify = Reply(s, "clarify", "PRIVATE_ANSWER_SENTINEL");
        s = (await Post(h, s.Id, "intents/respond", clarify)).Snapshot;
        Check.True((await Post(h, s.Id, "intents/respond", clarify)).Replayed);
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/intents/respond", clarify with { Text = "different" })).StatusCode);
        await Hidden(sequence);
        s = (await Post(h, s.Id, "intents/respond", Reply(s, "choose"))).Snapshot;
        Auth(h, owner.AccessToken);
        var published = (await h.Http.GetFromJsonAsync<ActivityEntry>($"/api/v1/campaigns/{s.Id}/activity/{sequence}"))!;
        Check.Equal("PRIVATE_INTENT_SENTINEL", published.Origin!.Input); Check.Equal("PRIVATE_ANSWER_SENTINEL", published.Origin.Clarifications!.Single().Answer);
        // A distinct cancelled intent stays private, even for the host's transcript and after restart.
        Auth(h, guest.AccessToken); s = (await Post(h, s.Id, "actions/interpret", Input(s, "CANCELLED_PRIVATE_SENTINEL"))).Snapshot;
        int cancelledRoot = s.Version; s = (await Post(h, s.Id, "intents/respond", Reply(s, "cancel"))).Snapshot;
        string data = h.Root; await h.DisposeAsync(); h = await Host.Start(data, interpreter: text); Auth(h, owner.AccessToken);
        foreach (string path in new[] { "", "/events?after=0&limit=100", "/journal?after=0&limit=100", "/activity?after=0&limit=100", "/journal/export" })
            Check.True(!(await h.Http.GetStringAsync($"/api/v1/campaigns/{s.Id}" + path)).Contains("CANCELLED_PRIVATE_SENTINEL"));
        Check.Equal(HttpStatusCode.NotFound, (await h.Http.GetAsync($"/api/v1/campaigns/{s.Id}/activity/{cancelledRoot}")).StatusCode);
        s = (await h.Act((await h.Get(s.Id))!, "observe")).Snapshot;
        var tail = (await h.Http.GetFromJsonAsync<GameEvent[]>($"/api/v1/campaigns/{s.Id}/events?after={cancelledRoot - 1}&limit=1"))!;
        Check.Equal(s.Version, tail.Single().Sequence);
        await h.DisposeAsync();
    }

    public static async Task InvalidInterpretationAndOffline()
    {
        var bad = new Scripted(c => new("action", ["model-invented-command"])); var dice = new SequenceDice(20);
        await using var h = await Host.Start(dice: dice, interpreter: bad, narrator: bad); var owner = await h.Create(); var s = owner.Snapshot;
        s = (await Post(h, s.Id, "actions/interpret", Input(s, "不明确的事情"))).Snapshot;
        Check.Equal("unavailable", s.PendingIntent!.Source); Check.Equal(0, s.PendingIntent.Options.Length); Check.Equal(0, dice.Count);
        for (int i = 0; i < 3; i++) s = (await Post(h, s.Id, "intents/respond", Reply(s, "clarify", "补充 " + i))).Snapshot;
        Check.True(s.PendingIntent is null); Check.Equal(1, s.PendingRulings.Length); Check.Equal(0, dice.Count); Check.Equal(0, bad.Narrations); Check.Equal(3, bad.Calls);
        Check.Equal(3, (await h.Http.GetFromJsonAsync<ActivityPage>($"/api/v1/campaigns/{s.Id}/activity"))!.Entries.Single().Origin!.Clarifications!.Length);
        // Offline trials bypass the registered provider regardless of its configuration.
        string token = new('a', 64);
        var trial = new Campaign { Id = Id(), Name = "Offline", TokenHash = JsonFiles.Hash(token), Character = CharacterEngine.Create("Trial", CharacterEngine.Fighter),
            Adventure = TestContent.Document, Prompts = TestContent.Prompts, ContentActivated = true, OfflineTrial = true, SceneId = "harbor" };
        trial.Events.Add(new(Id(), 1, "arrival", "Offline fixture", "", "authored", DateTimeOffset.UtcNow, null));
        h.App.Services.GetRequiredService<CampaignStore>().Create(trial); Auth(h, token); s = (await h.Get(trial.Id))!;
        s = (await Post(h, s.Id, "actions/interpret", Input(s, "look"))).Snapshot; Check.Equal("offline", s.PendingIntent!.Source);
        s = (await Post(h, s.Id, "intents/respond", Reply(s, "choose"))).Snapshot; Check.True(s.PendingIntent is null);
        Check.Equal(3, bad.Calls); Check.Equal(0, bad.Narrations); Check.Equal(0, dice.Count);
    }

    public static Task BoundedPrivateContext()
    {
        var c = TestContent.Campaign("harbor", "Context");
        c.Adventure = c.Adventure! with { SourceText = "PRIVATE_SCRIPT_SENTINEL", Scenes = c.Adventure.Scenes.Select(s => s.Id == "beacon" ? s with { Title = "PRIVATE_LOCATION_SENTINEL" } : s).ToArray() };
        c.Facts.Add("PRIVATE_FACT_SENTINEL");
        c.Character = c.Character.Required() with { Build = new CharacterBuild { Identity = new BuildIdentity { Backstory = "lighthouse keeper remembers the coast. PRIVATE_UNRELATED_IDENTITY" } } };
        c.Events.Add(new(Id(), 1, "host.secret", "PRIVATE_ADMIN_SENTINEL", "", "system", DateTimeOffset.UtcNow, null));
        var candidates = IntentContexts.SelectCandidates(ActionUnderstanding.Candidates(c), "lighthouse");
        var context = IntentContexts.Build(c, "lighthouse", [], candidates);
        string json = JsonSerializer.Serialize(context, JsonFiles.Options);
        foreach (string secret in new[] { "PRIVATE_SCRIPT_SENTINEL", "PRIVATE_LOCATION_SENTINEL", "PRIVATE_FACT_SENTINEL", "PRIVATE_ADMIN_SENTINEL", "PRIVATE_UNRELATED_IDENTITY", "tokenHash", "operation" })
            Check.True(!json.Contains(secret), "Unexpected private context: " + secret);
        Check.True(context.Context.Character.RelevantIdentity.Single().Contains("lighthouse"));
        Check.True(context.Candidates.Length <= IntentContexts.MaximumCandidates); Check.True(Encoding.UTF8.GetByteCount(json) < 128 * 1024);
        Check.True(ActionUnderstanding.Candidates(c).Where(x => x.Character is not null).All(x => x.Character!.Operation is not ("check" or "spend" or "consume" or "prepare")));
        return Task.CompletedTask;
    }

    private sealed class Wire : HttpMessageHandler
    {
        public string Reply = "", System = "", User = ""; public int Calls;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Calls++; using var json = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(ct));
            var messages = json.RootElement.GetProperty("messages"); System = messages[0].GetProperty("content").GetString()!; User = messages[1].GetProperty("content").GetString()!;
            return new(HttpStatusCode.OK) { Content = new StringContent(Reply) };
        }
    }
    public static async Task ProviderContract()
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["DataPath"] = Path.Combine(Path.GetTempPath(), "understanding-wire-" + Id()), ["TextAi:ApiKey"] = "fake", ["TextAi:Model"] = "fixture" }).Build();
        using var directory = new DataDirectory(config); var wire = new Wire();
        var ai = new OpenAiText(new HttpClient(wire), config, new ProviderBudget(directory, config));
        var c = TestContent.Campaign("harbor", "Wire"); var context = IntentContexts.Build(c, "看一看", [], IntentContexts.SelectCandidates(ActionUnderstanding.Candidates(c), "看一看"));
        var option = context.Commands.First(x => x.Action?.Kind == "observe");
        wire.Reply = FakeHandler.Chat(new { decision = "action", candidateIds = new[] { option.Id }, question = "" });
        Check.Equal(option.Id, (await ai.Understand(context, default, prompts: TestContent.Prompts)).CandidateIds.Single());
        Check.Equal(TestContent.Prompts.Intent, wire.System); Check.True(wire.User.Contains("player_context") && !wire.User.Contains("tokenHash"));
        wire.Reply = FakeHandler.Chat(new { decision = "action", candidateIds = new[] { option.Id }, question = "", hp = 99 });
        try { await ai.Understand(context, default, prompts: TestContent.Prompts); throw new Exception("Accepted authority field"); } catch (JsonException) { }
        wire.Reply = FakeHandler.Chat(new { kind = "observe", target = "" });
        Check.Equal("legacy", (await ai.Understand(context, default, prompts: TestContent.Prompts)).Source);
        int calls = wire.Calls;
        try { await ai.Understand(context, default); throw new Exception("Accepted missing prompts"); } catch (InvalidOperationException) { }
        Check.Equal(calls, wire.Calls);
        wire.Reply = FakeHandler.Chat(new { text = "Recorded result" });
        await ai.Narrate(new("scene", "actor", "authoritative result", [], "PRIVATE_SCRIPT", ["PRIVATE_FACT"], context.Context), default, prompts: TestContent.Prompts);
        Check.Equal(TestContent.Prompts.Narration, wire.System); Check.True(!wire.User.Contains("PRIVATE_SCRIPT") && !wire.User.Contains("PRIVATE_FACT"));
        Check.True(wire.User.Contains("player_context"));
    }
}
