using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class HarnessContinuationRegressionTests
{
    private static string Observe(HarnessModelRequest request)
    {
        using var doc = JsonDocument.Parse(request.Messages.Last(m => m.Role == "tool").Content);
        return doc.RootElement.GetProperty("context").GetProperty("intent").GetProperty("candidates").EnumerateArray()
            .First(c => c.GetProperty("label").GetString()!.Contains("观察")).GetProperty("id").GetString()!;
    }

    public static Task LegacyStepVersionProjectionIsReadOnlyAndBounded()
    {
        var c = TestContent.Campaign("harbor", "旧多步结果");
        c.Version = 17;
        var intent = new PendingIntent
        {
            Id = Id(), ActorId = c.ActingActorId, Text = "走到堤道后观察", RootSequence = 14, Version = 16,
            Status = "completed", Published = true, Source = "harness", NarrativeSource = "harness",
            Result = new("resolved", "observe", "已经观察", null, []),
            HarnessSteps = [new(15, new("resolved", "travel", "已经移动", null, []), null),
                new(17, new("resolved", "observe", "已经观察", null, []), null)]
        };
        c.PendingIntents.Add(intent);
        string before = HarnessJson.Serialize(c);
        var memory = HarnessLongMemory.ForRun(c, "继续前往灯塔");
        HarnessMemories.Validate(memory);
        Check.Equal(17, memory.Entries.Single().ResultVersion);
        Check.Equal(17, HarnessRecall.Search(c, new("观察")).Entries.Single().ResultVersion);
        Check.Equal(17, HarnessRecall.Read(c, new(intent.Id)).Entry.ResultVersion);
        Check.Equal(17, HarnessLongMemory.Digest(c, new()).Entries.Single().ResultVersion);
        Check.Equal(17, HarnessLongMemory.Search(c, new("观察")).Entries.Single().Entry.ResultVersion);
        Check.Equal(before, HarnessJson.Serialize(c));
        Check.Equal(16, intent.Version); // No migration or rewriting old evidence on read.
        intent.HarnessSteps[1] = new(18, intent.HarnessSteps[1].Result, null);
        Check.Throws<InvalidDataException>(() => HarnessMemories.Validate(HarnessMemories.Build(c)));
        return Task.CompletedTask;
    }

    public static async Task MultiStepFailureAndLegacyRestartAcceptNextAction()
    {
        var model = new Model((call, request) => call switch
        {
            1 or 3 => Tool("context_read"),
            2 or 4 => Tool("actions_propose", new { candidateId = Observe(request) }),
            5 => Tool("skills_read", new { id = "not-imported" }), // Fail AFTER two committed actions, without a final narrative.
            6 => Text("保留先前结果，下一条行动正常完成。"),
            _ => throw new Exception("Unexpected repeated model request")
        });
        var dice = new SequenceDice();
        var h = await Host.Start(dice: dice, configure: Configure(model));
        try
        {
            var owner = await Create(h);
            string id = owner.Snapshot.Id;
            var request = new HarnessInputRequest(Id(), owner.Snapshot.Version, "观察，再观察周围");
            var run = await Post<HarnessRunView>(h, id, "harness/runs", request);
            run = await Settled(h, id, run.Id);
            Check.Equal("failed", run.Status); Check.Equal("harness_skill_unavailable", run.Error);
            var snapshot = (await h.Get(id))!;
            Check.Equal(owner.Snapshot.Version + 4, snapshot.Version);
            Check.Equal(2, snapshot.Events.Count(e => e.Kind == "observe"));
            var store = h.App.Services.GetRequiredService<CampaignStore>();
            await store.Access(id, owner.AccessToken, false, c =>
            {
                var intent = c.PendingIntents.Single(i => i.Id == run.IntentId);
                Check.Equal(c.Version, intent.Version);
                Check.Equal(2, intent.HarnessSteps!.Count);
                Check.Equal(c.Version, intent.HarnessSteps.Last().Sequence);
                HarnessMemories.Validate(HarnessMemories.Build(c));
                return Task.FromResult(0);
            }, default);
            // Isolated old-version fixture: preserve the actual steps/events/receipts and lower only
            // the legacy intent marker, exactly as the observed pre-fix completion path did.
            await store.Access(id, owner.AccessToken, true, c =>
            {
                c.PendingIntents.Single(i => i.Id == run.IntentId).Version = c.Version - 1;
                return Task.FromResult(0);
            }, default);
            string root = h.Root;
            await h.DisposeAsync();
            h = await Host.Start(root, dice: dice, configure: Configure(model));
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            string db = Path.Combine(root, "campaigns", id + ".sqlite");
            byte[] before = File.ReadAllBytes(db);
            var memory = (await h.Http.GetFromJsonAsync<HarnessMemory>($"/api/v1/campaigns/{id}/harness/memory"))!;
            HarnessMemories.Validate(memory);
            Check.Equal(snapshot.Version, memory.Entries.Single().ResultVersion);
            Check.True(before.SequenceEqual(File.ReadAllBytes(db)), "Read-only compatibility must not rewrite saved evidence");
            Check.True((await Post<HarnessRunView>(h, id, "harness/runs", request)).Replayed);
            Check.Equal(5, model.Calls); Check.Equal(0, dice.Count);
            var nextRequest = new HarnessInputRequest(Id(), snapshot.Version, "下一条独立行动");
            var next = await Post<HarnessRunView>(h, id, "harness/runs", nextRequest);
            next = await Settled(h, id, next.Id);
            Check.Equal("completed", next.Status); Check.Equal(6, model.Calls);
            var after = (await h.Get(id))!;
            Check.Equal(2, after.Events.Count(e => e.Kind == "observe"));
            Check.Equal(0, dice.Count);
            Check.True((await Post<HarnessRunView>(h, id, "harness/runs", nextRequest)).Replayed);
            Check.Equal(6, model.Calls);
            await h.App.Services.GetRequiredService<CampaignStore>().Access(id, owner.AccessToken, false, c =>
            {
                Check.Equal(snapshot.Version - 1, c.PendingIntents.Single(i => i.Id == run.IntentId).Version);
                return Task.FromResult(0);
            }, default);
        }
        finally { await h.DisposeAsync(); }
    }
}
