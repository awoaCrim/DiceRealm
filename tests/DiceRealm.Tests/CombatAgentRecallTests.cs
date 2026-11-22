using System.Net.Http.Json;
using System.Reflection;
using System.Text;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class CombatAgentRecallTests
{
    public static async Task BoundedCaptureAndExactLongSourcePaging()
    {
        var document = StandardCombatTests.Document();
        string startLabel = document.Scenes.Single(s => s.Id == "causeway").Encounter!.StartLabel;
        var model = new Model((n, request) =>
        {
            var frame = HarnessExecutionProtocolTests.Frame(request);
            if (n == 1) return Tool("combat_delegate", new CombatDelegateArgs(frame.GetProperty("agent").GetProperty("encounterId").GetString()!, "实际交锋。", []));
            if (n == 2)
            {
                string candidate = frame.GetProperty("context").GetProperty("intent").GetProperty("candidates").EnumerateArray()
                    .Single(c => c.GetProperty("label").GetString() == startLabel).GetProperty("id").GetString()!;
                return Tool("actions_propose", new { candidateId = candidate });
            }
            return Tool("world_record", new NarrativeHarnessArgs("本轮对白" + n + new string('述', 1800), [], Private: "own-note-" + n)) with
            {
                ProviderContinuation = new(new string('b', 64), HarnessJson.Element(new { signature = "signature-" + n, body = new string('x', 40000) }))
            };
        });
        var dice = new SequenceDice(20, 1);
        await using var h = await Host.Start(dice: dice, configure: Configure(model));
        var response = await h.Http.PostAsJsonAsync("/api/v1/harness/campaigns", new CreateHarnessCampaignRequest("长战斗来源隔离", "Arden", document,
            Preset with { CombatSystemPrompt = "战斗提示原文" }, Build: FullCreationTests.Named("Arden", CharacterEngine.Fighter)));
        Check.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        var owner = (await response.Content.ReadFromJsonAsync<CreatedCampaign>())!;
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        string id = owner.Snapshot.Id;
        // This verifies the pre-45 cumulative native-history contract. New45 has independent sourced-history coverage.
        var parent = await StartHistorical(h, id, new(Id(), owner.Snapshot.Version, "我守住位置。"), 44);
        Check.Equal("delegated", (await Settled(h, id, parent.Id)).Status);
        var store = h.App.Services.GetRequiredService<CampaignStore>();
        var runs = h.App.Services.GetRequiredService<HarnessRunStore>();
        var session = await store.Access(id, owner.AccessToken, false, c => Task.FromResult(CombatAgentSessions.Current(c)!));
        var child = await Settled(h, id, session.Inputs[0].RunId);
        var snapshot = (await h.Get(id))!;
        snapshot = (await Post<ActionResponse>(h, id, "rolls/respond", new RollResponseRequest(Id(), snapshot.Version, snapshot.PendingRoll!.Id, "roll"))).Snapshot;
        await Post<HarnessRunView>(h, id, $"harness/runs/{child.Id}/resume", new HarnessResumeRequest(Id(), snapshot.Version));
        Check.Equal("completed", (await Settled(h, id, child.Id)).Status);
        for (int index = 0; index < 8; index++)
        {
            child = await Start(h, (await h.Get(id))!, "我继续交谈，第" + index + "次。");
            child = await Settled(h, id, child.Id);
            Check.True(child.Status == "completed", child.Status + ":" + child.Error);
        }
        var current = runs.Read(id, session.ParentActorId, child.Id)!;
        var history = current.CombatHistory!;
        Check.True(history.OmittedInputs > 0 && history.SourceRunIds.Length > 1, "Cumulative native metadata must shorten history without losing all exact recent blocks.");
        Check.True(history.Messages.Length < 48, "This case must hit cumulative bytes, not only the message cap.");
        Check.True(Encoding.UTF8.GetByteCount(HarnessJson.Serialize(history)) <= 256 * 1024);
        foreach (var source in history.SourceRunIds)
        {
            var saved = runs.Read(id, session.ParentActorId, source)!;
            var native = saved.Steps.Where(s => s.ProviderContinuation is not null).Select(s => s.ProviderContinuation!).ToArray();
            foreach (var continuation in native)
                Check.True(history.Exchanges.Any(e => e.Continuation is not null && HarnessJson.Serialize(e.Continuation) == HarnessJson.Serialize(continuation)));
        }
        // Explicit long-history fixture: retain actual battle/input identity and append
        // events through the real atomic store. This is not a natural-input game tour.
        string longText = "早期发现" + new string('密', 995) + "😀" + new string('密', 23);
        await store.Access(id, owner.AccessToken, true, c =>
        {
            for (int index = 0; index < 110; index++)
            {
                c.Version++;
                c.Events.Add(new(Id(), c.Version, "narrative", "公开结果" + index, "公开对白" + index, "harness", DateTimeOffset.UtcNow,
                    new Resolution("resolved", "narrative", "公开结果" + index, null, [], IntentId: current.IntentId),
                    ActorId: current.ActorId, PrivateText: index == 0 ? longText : ""));
            }
            return Task.FromResult(true);
        });
        int version = (await h.Get(id))!.Version;
        int calls = model.Calls;
        var read = typeof(GameService).GetMethod("ReadCombatHistory", BindingFlags.NonPublic | BindingFlags.Instance)!;
        var game = h.App.Services.GetRequiredService<GameService>();
        var collected = new List<CombatHistoryItem>();
        int after = 0;
        while (true)
        {
            var args = new CombatHistoryReadArgs(session.Id, "events", after, version, 8);
            var outcome = await (Task<HarnessToolOutcome>)read.Invoke(game, [id, owner.AccessToken, current.ActorId, version,
                current.Id, session.Id, null, args, runs, CancellationToken.None, 36])!;
            Check.True(Encoding.UTF8.GetByteCount(outcome.Reply.Content) <= 24 * 1024);
            var page = System.Text.Json.JsonSerializer.Deserialize<CombatHistoryPage>(outcome.Reply.Content, HarnessJson.Options)!;
            collected.AddRange(page.Entries);
            if (!page.HasMore) break;
            Check.True(page.NextAfter > after); after = page.NextAfter;
        }
        string privateSource = collected.Single(e => e.Kind == "private_discovery" && e.Text.Contains("早期发现")).SourceId;
        var parts = collected.Where(e => e.Kind == "private_discovery" && e.SourceId == privateSource).ToArray();
        Check.True(parts.Length > 1 && parts.All(e => e.Audience == "actor"));
        Check.Equal(longText, string.Concat(parts.Select(p => p.Text)));
        Check.True(collected.Any(e => e.Text == "公开结果109"));
        Check.Equal(calls, model.Calls); Check.Equal(2, dice.Count); Check.Equal(version, (await h.Get(id))!.Version);
        Console.WriteLine("Long battle: actual cumulative native capture below 256KiB, exact sources retained; paged 110 persisted events beyond snapshot tail, private Unicode parts reconstructed exactly; zero recall side effects.");
    }
}
