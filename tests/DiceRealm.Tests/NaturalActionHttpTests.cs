using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class NaturalActionHttpTests
{
    private static string Select(HarnessModelRequest request, string category, string text)
    {
        using var body = JsonDocument.Parse(request.Messages.Last(m => m.Name == "context_read").Content);
        return body.RootElement.GetProperty("context").GetProperty("intent").GetProperty("candidates").EnumerateArray()
            .First(c => c.GetProperty("category").GetString() == category && c.GetProperty("label").GetString()!.Contains(text))
            .GetProperty("id").GetString()!;
    }
    private static void Auth(Host h, string token) => h.Http.DefaultRequestHeaders.Authorization = new("Bearer", token);
    public static async Task RealPiConsentConcurrencyAndRestart()
    {
        var dice = new SequenceDice(4); var model = new Model((n, r) => n switch
        {
            1 => Tool("context_read"),
            2 => Tool("actions_propose", new { candidateId = Select(r, "effect", "Second Wind") }),
            3 => Text("已经完成回气，体力有所恢复。"),
            _ => throw new Exception("Unexpected model call " + n)
        });
        var configure = Configure(model, extra: b =>
        {
            b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry(); b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>();
        });
        var h = await Host.Start(dice: dice, configure: configure);
        try
        {
            var owner = await Create(h); var guest = await HarnessBoundaryTests.Guest(h, owner);
            Auth(h, owner.AccessToken); string id = owner.Snapshot.Id;
            var s = (await h.Get(id))!;
            s = (await Post<ActionResponse>(h, id, "characters/adjust", new AdjustCharacterRequest(Id(), s.Version, "player", "隔离治疗验证", "夹具",
                [new("hp", "", 1)]))).Snapshot;
            // Legacy run 7 reads exactly the old candidate family even on the new executable.
            var game = h.App.Services.GetRequiredService<GameService>();
            var old = await game.HarnessTool(id, owner.AccessToken, "player", Id(), "回气治疗自身", s.Version, Id(), "read-only",
                new("context_read", HarnessJson.Element(new { }), Id()), [], CancellationToken.None, new(Preset, HarnessJson.ProfileHash(Preset, []), []), toolContractVersion: 7);
            Check.True(!old.Reply.Content.Contains("\"category\":\"effect\""));
            var initial = s; var input = new HarnessInputRequest(Id(), s.Version, "回气 Second Wind，治疗我自己");
            var run = await Post<HarnessRunView>(h, id, "harness/runs", input); run = await Settled(h, id, run.Id, 3000);
            Check.Equal("waiting", run.Status); Check.Equal(2, model.Calls); Check.Equal(0, dice.Count);
            s = (await h.Get(id))!; Check.Equal(HarnessJson.Serialize(initial.Character), HarnessJson.Serialize(s.Character));
            var choice = s.PendingIntent!.Options.Single(); Check.True(choice.Details.Note.Contains("恢复骰"));
            var confirm = new IntentResponseRequest(Id(), s.Version, s.PendingIntent.Id, "choose", choice.Id);
            Auth(h, guest.AccessToken);
            Check.True((await h.Get(id))!.PendingIntent is null);
            Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/intents/respond", confirm)).StatusCode);
            Check.Equal(0, dice.Count);
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, dice: dice, configure: configure); Auth(h, owner.AccessToken);
            var requests = new[] { confirm, confirm with { RequestId = Id() } };
            var raced = await Task.WhenAll(requests.Select(r => h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/intents/respond", r)));
            Check.Equal(1, raced.Count(r => r.IsSuccessStatusCode)); Check.Equal(1, raced.Count(r => r.StatusCode == HttpStatusCode.Conflict));
            int winner = Array.FindIndex(raced, r => r.IsSuccessStatusCode);
            var done = (await raced[winner].Content.ReadFromJsonAsync<ActionResponse>())!;
            Check.Equal(1, dice.Count); Check.Equal(6, done.Snapshot.Character.Required().HitPoints); Check.Equal(1, CharacterEngine.Value(done.Snapshot.Character.Required(), "Second Wind"));
            Check.Equal(6L, done.Snapshot.ElapsedSeconds); Check.Equal(0, done.Snapshot.PendingRulings.Length);
            Check.Equal(HarnessJson.Serialize(initial.Party!.Members.Single(m => m.Id != "player").Character),
                HarnessJson.Serialize(done.Snapshot.Party!.Members.Single(m => m.Id != "player").Character));
            Check.True((await Post<ActionResponse>(h, id, "intents/respond", requests[winner])).Replayed); Check.Equal(1, dice.Count);
            run = await Post<HarnessRunView>(h, id, $"harness/runs/{run.Id}/resume", new HarnessResumeRequest(Id(), done.Snapshot.Version));
            run = await Settled(h, id, run.Id, 3000); Check.Equal("completed", run.Status); Check.Equal(3, model.Calls);
            var page = (await h.Http.GetFromJsonAsync<ActivityPage>($"/api/v1/campaigns/{id}/activity"))!;
            var entry = page.Entries.Single(e => e.Origin?.Input == input.Text);
            Check.True(entry.Steps!.Any(step => step.Result.Kind == "character.execute" && step.Origin!.Changes.Any(x => x.Operation == "hp" && x.Before == "1" && x.After == "6")));
            await h.DisposeAsync(); h = await Host.Start(root, dice: dice, configure: configure); Auth(h, owner.AccessToken);
            var replay = await Post<ActionResponse>(h, id, "intents/respond", requests[winner]);
            Check.True(replay.Replayed); Check.Equal(HarnessJson.Serialize(done.Resolution), HarnessJson.Serialize(replay.Resolution));
            Check.True((await Post<HarnessRunView>(h, id, "harness/runs", input)).Replayed);
            Check.Equal(1, dice.Count); Check.Equal(3, model.Calls);
            Console.WriteLine("NATURAL real Pi/MCP v8: source effect -> waiting -> foreign refusal -> restart -> racing own confirmation -> heal once -> resume -> replay; 3 fake calls, 0 real calls.");
        }
        finally { await h.DisposeAsync(); }
    }
    public static async Task RealPiRecordedCheckToWorldOutcome()
    {
        var model = new Model((n, r) => n switch
        {
            1 or 3 => Tool("context_read"),
            2 => Tool("ruling_request", new { question = "另一种调查手法需要确认对应的检定。" }),
            4 => Tool("actions_propose", new { candidateId = Select(r, "story", "核对线索") }),
            5 => Text("已沿用原检定落实线索与奖励，没有再次投掷。"),
            _ => throw new Exception("Unexpected story model call " + n)
        });
        var configure = Configure(model, extra: b =>
        {
            b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry(); b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>();
        });
        var dice = new SequenceDice(18); await using var h = await Host.Start(dice: dice, configure: configure);
        var owner = await Create(h, NaturalActionTests.StoryFixture().Adventure); string id = owner.Snapshot.Id;
        var run = await Start(h, owner.Snapshot, "核对线索并落实已确认的结果"); run = await Settled(h, id, run.Id, 3000);
        Check.Equal("ruling", run.Wait!.Kind); Check.Equal(0, dice.Count);
        var state = (await h.Get(id))!; var ruling = state.PendingRulings.Single();
        var requested = await Post<ActionResponse>(h, id, "rulings/respond", new ResolveRulingRequest(Id(), state.Version, ruling.Id, "check",
            "确认此次调查对应既有线索检定", "导入剧本", "intelligence", "Investigation", 12));
        Check.Equal("awaiting_roll", requested.Resolution.Status); Check.Equal(0, dice.Count);
        var rolled = await Post<ActionResponse>(h, id, "rolls/respond", new RollResponseRequest(Id(), requested.Snapshot.Version, requested.Snapshot.PendingRoll!.Id, "roll"));
        Check.Equal(1, dice.Count); Check.True(!rolled.Snapshot.Character.Required().Inventory.Any(i => i.Id == "medal"));
        run = await Post<HarnessRunView>(h, id, $"harness/runs/{run.Id}/resume", new HarnessResumeRequest(Id(), rolled.Snapshot.Version));
        run = await Settled(h, id, run.Id, 3000); Check.Equal("waiting", run.Status); Check.Equal("intent", run.Wait!.Kind);
        state = (await h.Get(id))!; Check.Equal(1, state.PendingIntent!.Options.Length); Check.Equal("story", state.PendingIntent.Options[0].Category);
        Check.Equal(1, dice.Count); Check.True(!state.Character.Required().Inventory.Any(i => i.Id == "medal"));
        var confirmation = new IntentResponseRequest(Id(), state.Version, state.PendingIntent.Id, "choose", state.PendingIntent.Options[0].Id);
        var applied = await Post<ActionResponse>(h, id, "intents/respond", confirmation);
        Check.Equal(1, dice.Count); Check.Equal(1, applied.Snapshot.Character.Required().Inventory.Single(i => i.Id == "medal").Quantity);
        Check.Equal(18, applied.Snapshot.PendingRulings.Single().Check!.Selected);
        run = await Post<HarnessRunView>(h, id, $"harness/runs/{run.Id}/resume", new HarnessResumeRequest(Id(), applied.Snapshot.Version));
        run = await Settled(h, id, run.Id, 3000); Check.Equal("completed", run.Status); Check.Equal(5, model.Calls);
        Check.True((await Post<ActionResponse>(h, id, "intents/respond", confirmation)).Replayed); Check.Equal(1, dice.Count);
        Console.WriteLine("NATURAL story real Pi/MCP: own root -> ruling -> own roll consent -> recorded check -> fresh context -> own consequence consent -> world/reward once; 5 fake calls, 1 die, 0 real calls.");
    }
    public static async Task CancellationStaleAndStoryConfirmation()
    {
        var model = new Model((_, _) => throw new Exception("No model expected")); var dice = new SequenceDice();
        var h = await Host.Start(dice: dice, configure: Configure(model));
        try
        {
            var owner = await Create(h); string id = owner.Snapshot.Id; var store = h.App.Services.GetRequiredService<CampaignStore>();
            var game = h.App.Services.GetRequiredService<GameService>();
            var profile = new HarnessProfile(Preset, HarnessJson.ProfileHash(Preset, []), []);
            async Task<HarnessToolOutcome> Call(string run, int version, string name, object arguments, string[]? offered = null) =>
                await game.HarnessTool(id, owner.AccessToken, "player", run, "回气并治疗自身", version, Id(), Id(), new(name, HarnessJson.Element(arguments), Id()), offered ?? [],
                    CancellationToken.None, profile, toolContractVersion: 8);
            var state = (await h.Get(id))!;
            state = (await Post<ActionResponse>(h, id, "characters/adjust", new AdjustCharacterRequest(Id(), state.Version, "player", "隔离验证", "夹具", [new("hp", "", 1)]))).Snapshot;
            async Task<CampaignSnapshot> Propose()
            {
                string run = Id(); var read = await Call(run, state.Version, "context_read", new { });
                using var body = JsonDocument.Parse(read.Reply.Content);
                string option = body.RootElement.GetProperty("context").GetProperty("intent").GetProperty("candidates").EnumerateArray()
                    .Single(c => c.GetProperty("category").GetString() == "effect").GetProperty("id").GetString()!;
                await Call(run, state.Version, "actions_propose", new { candidateId = option }, read.OfferedIds);
                return (await h.Get(id))!;
            }
            state = await Propose(); var waiting = state.PendingIntent!;
            state = (await Post<ActionResponse>(h, id, "intents/respond", new IntentResponseRequest(Id(), state.Version, waiting.Id, "cancel"))).Snapshot;
            Check.Equal(0, dice.Count); Check.Equal(1, state.Character.Required().HitPoints); Check.Equal(2, CharacterEngine.Value(state.Character.Required(), "Second Wind"));
            state = await Propose(); waiting = state.PendingIntent!;
            state = (await Post<ActionResponse>(h, id, "characters/adjust", new AdjustCharacterRequest(Id(), state.Version, "player", "隔离状态推进", "夹具", [new("temporary-hp", "", 1)]))).Snapshot;
            Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/intents/respond", new IntentResponseRequest(Id(), state.Version, waiting.Id, "choose", waiting.Options[0].Id))).StatusCode);
            Check.Equal(0, dice.Count); Check.Equal(1, state.Character.Required().HitPoints);
            // A fixture creates the already-settled exact root; only the public confirmation commits effects.
            state = (await Post<ActionResponse>(h, id, "intents/respond", new IntentResponseRequest(Id(), state.Version, waiting.Id, "cancel"))).Snapshot;
            string rootId = Id();
            await store.Access(id, owner.AccessToken, true, c =>
            {
                var fixture = NaturalActionTests.StoryFixture(); c.Adventure = fixture.Adventure;
                c.Version++; c.Events.Add(new(Id(), c.Version, "fixture", "隔离检定结果", "", "fixture", DateTimeOffset.UtcNow, null));
                c.PendingIntents.Add(new() { Id = rootId, ActorId = "player", RootSequence = c.Version, Text = "核对线索", Published = true, Status = "completed" });
                c.PendingRulings.Add(fixture.PendingRulings[0] with { Id = Id(), OriginSequence = c.Version });
                return Task.FromResult(true);
            });
            state = (await h.Get(id))!;
            var readStory = await Call(rootId, state.Version, "context_read", new { });
            using var storyBody = JsonDocument.Parse(readStory.Reply.Content);
            string storyOption = storyBody.RootElement.GetProperty("context").GetProperty("intent").GetProperty("candidates").EnumerateArray()
                .Single(c => c.GetProperty("category").GetString() == "story").GetProperty("id").GetString()!;
            await Call(rootId, state.Version, "actions_propose", new { candidateId = storyOption }, readStory.OfferedIds);
            state = (await h.Get(id))!; Check.True(!state.Character.Required().Inventory.Any(i => i.Id == "medal")); Check.Equal(0, dice.Count);
            var confirmation = new IntentResponseRequest(Id(), state.Version, rootId, "choose", state.PendingIntent!.Options.Single().Id);
            var applied = await Post<ActionResponse>(h, id, "intents/respond", confirmation);
            Check.Equal("story.verified", applied.Resolution.Kind); Check.Equal(1, applied.Snapshot.Character.Required().Inventory.Single(i => i.Id == "medal").Quantity);
            Check.Equal(0, dice.Count); Check.True(applied.Snapshot.PendingRulings.Single().Story is not null);
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, dice: dice, configure: Configure(model)); Auth(h, owner.AccessToken);
            Check.True((await Post<ActionResponse>(h, id, "intents/respond", confirmation)).Replayed);
            Check.Equal(1, (await h.Get(id))!.Character.Required().Inventory.Single(i => i.Id == "medal").Quantity); Check.Equal(0, dice.Count); Check.Equal(0, model.Calls);
        }
        finally { await h.DisposeAsync(); }
    }
}
