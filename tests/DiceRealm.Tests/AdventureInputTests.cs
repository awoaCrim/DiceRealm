using System.Net;
using System.Net.Http.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;

namespace DiceRealm.Tests;

internal static class AdventureInputTests
{
    private static string Id() => Guid.NewGuid().ToString();
    private static ActionRequest Input(CampaignSnapshot s, string text) => new(Id(), s.Version, "natural", Text: text);
    private static async Task<ActionResponse> Post(Host h, string id, string route, object body)
    {
        var response = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/{route}", body);
        if (!response.IsSuccessStatusCode) throw new Exception(response.StatusCode + " " + await response.Content.ReadAsStringAsync());
        return (await response.Content.ReadFromJsonAsync<ActionResponse>())!;
    }
    private sealed class Understanding(Func<IntentContext, IntentInterpretation> reply) : IIntentInterpreter
    {
        public int Calls;
        public Task<Intent?> Interpret(string text, ActionChoice[] allowed, CancellationToken cancellationToken, string campaignId = "", PromptBundle? prompts = null) => throw new Exception("No legacy call expected");
        public Task<IntentInterpretation> Understand(IntentContext context, CancellationToken cancellationToken, string campaignId = "", PromptBundle? prompts = null)
        { Calls++; return Task.FromResult(reply(context)); }
    }
    private static IntentInterpretation Select(IntentContext context, string kind) => new("action", [context.Commands.Single(c => c.Action?.Kind == kind).Id], Source: "fixture");

    public static async Task DirectRollReplayAndRestart()
    {
        var dice = new SequenceDice(18);
        var provider = new Understanding(c => Select(c, c.Text.Contains("调查") ? "investigate" : "observe"));
        var h = await Host.Start(dice: dice, interpreter: provider); var owner = await h.Create(); var s = owner.Snapshot;
        var direct = Input(s, "观察这里"); var response = await Post(h, s.Id, "actions/input", direct); s = response.Snapshot;
        Check.Equal("resolved", response.Resolution.Status); Check.True(s.PendingIntent is null); Check.Equal(1, provider.Calls); Check.Equal(0, dice.Count);
        Check.True(response.Resolution.IntentId.Length > 0);
        var activity = (await h.Http.GetFromJsonAsync<ActivityPage>($"/api/v1/campaigns/{s.Id}/activity"))!;
        Check.Equal(1, activity.Entries.Length); Check.Equal("观察这里", activity.Entries[0].Origin!.Input);
        Check.True((await Post(h, s.Id, "actions/input", direct)).Replayed); Check.Equal(1, provider.Calls);
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/actions/interpret", direct)).StatusCode);
        var staged = await Post(h, s.Id, "actions/input", Input(s, "调查现场")); s = staged.Snapshot;
        Check.True(s.PendingIntent is null); Check.True(s.PendingRoll is not null); Check.Equal(0, dice.Count);
        Check.True(s.PendingRoll!.Description.Contains("消耗"));
        foreach (string word in new[] { "好", "我转身离开", "20" })
            Check.Equal(HttpStatusCode.BadRequest, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/actions/input", Input(s, word))).StatusCode);
        Check.Equal(s.Version, (await h.Get(s.Id))!.Version); Check.Equal(0, dice.Count);
        var roll = Input(s, "投掷");
        var done = await Task.WhenAll(Post(h, s.Id, "actions/input", roll), Post(h, s.Id, "actions/input", roll));
        Check.True(done.Any(r => r.Replayed)); Check.Equal(1, dice.Count); Check.Equal(2, provider.Calls);
        s = done[0].Snapshot; Check.True(s.PendingRoll is null);
        var root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, dice: dice, interpreter: provider);
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        var replay = await Post(h, s.Id, "actions/input", roll); Check.True(replay.Replayed); Check.Equal(1, dice.Count); Check.Equal(2, provider.Calls);
        s = (await Post(h, s.Id, "archive", new ArchiveCampaignRequest(Id(), s.Version, true))).Snapshot;
        Check.True((await Post(h, s.Id, "actions/input", direct)).Replayed);
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/actions/input", roll with { Text = "取消" })).StatusCode);
        await h.DisposeAsync();
    }

    public static async Task ClarifyChooseCancelAndLegacy()
    {
        var dice = new SequenceDice(15);
        var provider = new Understanding(c => c.Clarifications.Length > 0 ? Select(c, "observe") : new("clarify",
            c.Commands.Where(x => x.Action?.Kind is "observe" or "investigate").Select(x => x.Id).ToArray(), "观察还是调查？", "fixture"));
        await using var h = await Host.Start(dice: dice, interpreter: provider); var owner = await h.Create(); var s = owner.Snapshot;
        s = (await Post(h, s.Id, "actions/input", Input(s, "看一看"))).Snapshot;
        Check.Equal(2, s.PendingIntent!.Options.Length);
        var ambiguous = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/actions/input", Input(s, "好"));
        Check.Equal(HttpStatusCode.BadRequest, ambiguous.StatusCode); Check.Equal(s.Version, (await h.Get(s.Id))!.Version); Check.Equal(1, provider.Calls);
        s = (await Post(h, s.Id, "actions/input", Input(s, "只看环境，不翻动物件"))).Snapshot;
        Check.True(s.PendingIntent is null); Check.Equal(2, provider.Calls); Check.Equal(0, dice.Count);
        s = (await Post(h, s.Id, "actions/input", Input(s, "再看一看"))).Snapshot;
        int option = Array.FindIndex(s.PendingIntent!.Options, o => o.Label.Contains("查")) + 1;
        Check.True(option > 0); s = (await Post(h, s.Id, "actions/input", Input(s, "选择" + option))).Snapshot;
        Check.True(s.PendingRoll is not null); Check.Equal(0, dice.Count);
        s = (await Post(h, s.Id, "actions/input", Input(s, "取消"))).Snapshot;
        Check.True(s.PendingRoll is null); Check.Equal(0, dice.Count);
        // Old clients still get their explicit confirmation lifecycle and identical fingerprints.
        var legacyProvider = new Understanding(c => Select(c, "observe"));
        await using var old = await Host.Start(interpreter: legacyProvider); var oldOwner = await old.Create();
        var oldReply = await Post(old, oldOwner.Snapshot.Id, "actions/interpret", Input(oldOwner.Snapshot, "观察"));
        Check.Equal("awaiting_confirmation", oldReply.Resolution.Status); Check.True(oldReply.Snapshot.PendingIntent is not null);
    }

    public static async Task ResourceConsentAndFrozenContext()
    {
        var provider = new Understanding(c => Select(c, "character.cast")); var dice = new SequenceDice();
        await using var h = await Host.Start(dice: dice, interpreter: provider);
        var created = await h.Http.PostAsJsonAsync("/api/v1/campaigns", new CreateCampaignRequest("Wizard", "法师", CharacterEngine.Fighter, TestContent.Document, TestContent.Prompts, true, Build: FullCreationTests.Named("法师", CharacterEngine.Wizard)));
        var owner = (await created.Content.ReadFromJsonAsync<CreatedCampaign>())!; h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        var s = (await Post(h, owner.Snapshot.Id, "actions/input", Input(owner.Snapshot, "给自己施放法师护甲"))).Snapshot;
        Check.True(s.PendingIntent is not null); Check.Equal(2, CharacterEngine.Value(s.Character.Required(), "Spell Slots (1st)"));
        Check.True(s.PendingIntent!.Options[0].Details.Cost.Contains("法术位"));
        var confirm = Input(s, "确认"); s = (await Post(h, s.Id, "actions/input", confirm)).Snapshot;
        Check.Equal(1, CharacterEngine.Value(s.Character.Required(), "Spell Slots (1st)")); Check.Equal(0, dice.Count);
        Check.True((await Post(h, s.Id, "actions/input", confirm)).Replayed);
        // Separate campaign: another committed event invalidates an offered operation, never rebases it.
        await using var other = await Host.Start(); var ordinary = await other.Create(); var state = ordinary.Snapshot;
        state = (await Post(other, state.Id, "actions/interpret", Input(state, "观察"))).Snapshot;
        state = (await other.Act(state, "observe")).Snapshot;
        Check.Equal(HttpStatusCode.Conflict, (await other.Http.PostAsJsonAsync($"/api/v1/campaigns/{state.Id}/actions/input", Input(state, "确认"))).StatusCode);
        state = (await Post(other, state.Id, "actions/input", Input(state, "取消"))).Snapshot;
        Check.True(state.PendingIntent is null);
        Check.Equal(HttpStatusCode.BadRequest, (await other.Http.PostAsJsonAsync($"/api/v1/campaigns/{state.Id}/actions/input", Input(state, "投掷"))).StatusCode);
    }
}
