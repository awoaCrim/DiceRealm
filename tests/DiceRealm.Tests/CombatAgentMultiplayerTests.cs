using System.Net;
using System.Net.Http.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class CombatAgentMultiplayerTests
{
    public static async Task GroupConsentScopedContinuationAndSerialization()
    {
        var document = StandardCombatTests.Document();
        document = document with { Scenes = document.Scenes.Select(s => s.Id == "causeway" ? s with { SafeRest = true } : s).ToArray() };
        string startLabel = document.Scenes.Single(s => s.Id == "causeway").Encounter!.StartLabel;
        string providerIdentity = new('c', 64);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var model = new Model(async (n, request, ct) =>
        {
            var frame = HarnessExecutionProtocolTests.Frame(request);
            if (n == 1) return Tool("combat_delegate", new CombatDelegateArgs(frame.GetProperty("agent").GetProperty("encounterId").GetString()!, "拦截真实攻击。", []));
            if (n == 2)
            {
                string candidate = frame.GetProperty("context").GetProperty("intent").GetProperty("candidates").EnumerateArray()
                    .Single(c => c.GetProperty("label").GetString() == startLabel).GetProperty("id").GetString()!;
                return Tool("actions_propose", new { candidateId = candidate }) with
                    { ProviderContinuation = new(providerIdentity, HarnessJson.Element(new { signature = "A_NATIVE_PRIVATE" })) };
            }
            string body = HarnessJson.Serialize(request);
            if (n == 3)
            {
                Check.True(request.PriorProviderIdentities.Contains(providerIdentity), "same battle provider binding must survive an actor change");
                Check.Equal(0, request.ProviderHistory.Length); Check.True(!body.Contains("A_NATIVE_PRIVATE"));
                Check.True(frame.GetProperty("agent").GetProperty("handoff").ValueKind == System.Text.Json.JsonValueKind.Null);
                return Tool("world_record", new NarrativeHarnessArgs("我方仍守住位置。", [], Private: "B_PRIVATE_DISCOVERY"));
            }
            if (n == 4) return Tool("ask_player", new { question = "你要守住哪位同伴？" });
            if (n == 5)
            {
                entered.TrySetResult(); await release.Task.WaitAsync(ct);
                return Tool("world_record", new NarrativeHarnessArgs("队友已回应。", [], Private: "B_SECOND_PRIVATE"));
            }
            Check.True(!body.Contains("B_PRIVATE_DISCOVERY") && !body.Contains("B_SECOND_PRIVATE"));
            string sessionId = frame.GetProperty("agent").GetProperty("sessionId").GetString()!;
            if (n == 6) return Tool("combat_history_read", new CombatHistoryReadArgs(sessionId, "events"));
            var recalled = HarnessJson.Read<CombatHistoryPage>(System.Text.Json.JsonDocument.Parse(request.Messages.Last(m => m.Role == "tool").Content).RootElement);
            Check.True(recalled.Entries.All(e => e.Kind != "private_discovery"), "Host's playing model cannot recall a peer's private text.");
            if (recalled.HasMore) return Tool("combat_history_read", new CombatHistoryReadArgs(sessionId, recalled.Scope, recalled.NextAfter, recalled.Through));
            if (recalled.Scope == "events") return Tool("combat_history_read", new CombatHistoryReadArgs(sessionId, "inputs"));
            return Tool("world_record", new NarrativeHarnessArgs("你仍在当前战斗中守护同伴。", []));
        });
        var dice = new SequenceDice(20, 19, 1);
        await using var h = await Host.Start(dice: dice, configure: Configure(model));
        var response = await h.Http.PostAsJsonAsync("/api/v1/harness/campaigns", new CreateHarnessCampaignRequest("多人战斗隔离", "Arden", document,
            Preset with { CombatSystemPrompt = "独立战斗提示" }, Build: FullCreationTests.Named("Arden", CharacterEngine.Fighter)));
        Check.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        var owner = (await response.Content.ReadFromJsonAsync<CreatedCampaign>())!;
        var guest = await HarnessBoundaryTests.Guest(h, owner);
        string id = owner.Snapshot.Id;
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        // This fixed dialogue script covers legacy consent/history ownership, not v49's
        // additional per-unit narration slots (covered by CombatNarrationHttpTests).
        var parent = await StartHistorical(h, id, new(Id(), (await h.Get(id))!.Version, "我拦住这次攻击。"), 47); parent = await Settled(h, id, parent.Id);
        Check.Equal("delegated", parent.Status);
        var session = await h.App.Services.GetRequiredService<CampaignStore>().Access(id, owner.AccessToken, false, c => Task.FromResult(CombatAgentSessions.Current(c)!));
        var child = await Settled(h, id, session.Inputs[0].RunId); Check.Equal("waiting", child.Status);
        var a = (await h.Get(id))!;
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
        var b = (await h.Get(id))!;
        Check.Equal(session.Id, b.PendingRoll!.BattleSessionId); Check.True(b.PendingRoll.Id != a.PendingRoll!.Id);
        var wrong = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/rolls/respond", new RollResponseRequest(Id(), b.Version, a.PendingRoll.Id, "roll"));
        Check.Equal(HttpStatusCode.Conflict, wrong.StatusCode); Check.Equal(0, dice.Count);
        b = (await Post<ActionResponse>(h, id, "rolls/respond", new RollResponseRequest(Id(), b.Version, b.PendingRoll.Id, "roll"))).Snapshot;
        Check.Equal(0, dice.Count);
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        a = (await h.Get(id))!;
        await Post<ActionResponse>(h, id, "rolls/respond", new RollResponseRequest(Id(), a.Version, a.PendingRoll!.Id, "roll"));
        Check.Equal(3, dice.Count);
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
        var spoken = await Start(h, (await h.Get(id))!, "我提醒同伴注意对方的动作。"); spoken = await Settled(h, id, spoken.Id);
        Check.True(spoken.Status == "completed", spoken.Status + ":" + spoken.Error);
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        a = (await h.Get(id))!;
        await Post<HarnessRunView>(h, id, $"harness/runs/{child.Id}/resume", new HarnessResumeRequest(Id(), a.Version));
        child = await Settled(h, id, child.Id); Check.Equal("player", child.Wait!.Kind);
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
        var next = await Start(h, (await h.Get(id))!, "我继续回应队友。");
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        a = (await h.Get(id))!;
        var busy = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/harness/runs/{child.Id}/resume", new HarnessResumeRequest(Id(), a.Version, "守住身边同伴。"));
        Check.Equal(HttpStatusCode.Conflict, busy.StatusCode); Check.True((await busy.Content.ReadAsStringAsync()).Contains("harness_busy"));
        release.TrySetResult();
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
        Check.Equal("completed", (await Settled(h, id, next.Id)).Status);
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        a = (await h.Get(id))!;
        await Post<HarnessRunView>(h, id, $"harness/runs/{child.Id}/resume", new HarnessResumeRequest(Id(), a.Version, "守住身边同伴。"));
        child = await Settled(h, id, child.Id); Check.True(child.Status == "completed", child.Status + ":" + child.Error);
        Check.Equal(session.Id, child.BattleSessionId); Check.True(model.Calls >= 8); Check.Equal(3, dice.Count);
        var runs = h.App.Services.GetRequiredService<HarnessRunStore>();
        var saved = runs.Read(id, session.ParentActorId, child.Id)!;
        int answerVersion = saved.TurnVersions!.Last();
        Check.True(answerVersion > session.StartedVersion);
        session = await h.App.Services.GetRequiredService<CampaignStore>().Access(id, owner.AccessToken, false, c => Task.FromResult(CombatAgentSessions.Current(c)!));
        var recall = typeof(HarnessRunService).Assembly.GetType("DiceRealm.Server.Application.HarnessCombatRecall")!;
        var inputs = recall.GetMethod("Inputs", System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic)!;
        List<CombatHistoryItem> Read(int through) => (List<CombatHistoryItem>)inputs.Invoke(null,
            [session, session.ParentActorId, through, null, new Func<CombatAgentInput, HarnessRun?>(i => runs.Read(id, i.ActorId, i.RunId)), new Func<string, bool>(_ => true), false])!;
        Check.True(!Read(answerVersion - 1).Any(i => i.Kind == "player_answer"));
        Check.True(Read(answerVersion).Any(i => i.Kind == "player_answer" && i.Version == answerVersion && i.ReplyTo is not null));
        // A previously invisible source occupies its original cursor slot; later
        // publication cannot shift or repeat the next own item.
        var pageMethod = recall.GetMethod("Page", System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic)!;
        var items = new[] { new CombatHistoryItem("peer", "peer", "unavailable", "player_input", "hidden", answerVersion),
            new CombatHistoryItem("own-a", session.ParentActorId, "actor", "player_input", "first", answerVersion),
            new CombatHistoryItem("own-b", session.ParentActorId, "actor", "player_input", "second", answerVersion) };
        var firstPage = (CombatHistoryPage)pageMethod.Invoke(null, [session.Id, "inputs", answerVersion, 0, 1, items])!;
        Check.Equal("own-a", firstPage.Entries.Single().SourceId);
        items[0] = items[0] with { Audience = "public" };
        var nextPage = (CombatHistoryPage)pageMethod.Invoke(null, [session.Id, "inputs", answerVersion, firstPage.NextAfter, 1, items])!;
        Check.Equal("own-b", nextPage.Entries.Single().SourceId);
    }
}
