using System.Net.Http.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class CombatAgentRedelegationTests
{
    private sealed class DelegationFault : IHarnessRuntime
    {
        private readonly Loop loop = new();
        public bool Fault = true;
        public Task<HarnessCompletion> Execute(HarnessExecution execution, Func<HarnessCallback, CancellationToken, Task<System.Text.Json.JsonElement>> callback, CancellationToken ct) =>
            loop.Execute(execution, async (call, token) =>
            {
                var result = await callback(call, token);
                if (Fault && execution.Turns.Any(t => t.Contains("\"combatReturn\"")) && call.Turn == execution.Turns.Length - 1 && call.Kind == "tool" &&
                    HarnessJson.Read<HarnessToolRequest>(call.Payload).Name == "combat_delegate")
                    throw new IOException("isolated post-delegation / pre-child fault");
                return result;
            }, ct);
    }

    public static async Task MissingFirstInputRecoveryCancellationAndRevocation()
    {
        foreach (string stage in new[] { "recover", "cancel", "revoked", "hard" })
        {
            var document = StandardCombatTests.Document();
            document = document with { Scenes = document.Scenes.Select(s => s.Encounter is null ? s :
                s with { Encounter = s.Encounter with { Repeatable = true } }).ToArray() };
            string startLabel = document.Scenes.Single(s => s.Id == "causeway").Encounter!.StartLabel;
            var model = new Model((call, request) =>
            {
                var frame = HarnessExecutionProtocolTests.Frame(request);
                var agent = frame.GetProperty("agent");
                if (call is 1 or 3) return Tool("combat_delegate", new CombatDelegateArgs(agent.GetProperty("encounterId").GetString()!, "真实交锋。", []));
                if (call is 2 or 4)
                    return Tool("actions_propose", new { candidateId = frame.GetProperty("context").GetProperty("intent").GetProperty("candidates").EnumerateArray()
                        .Single(c => c.GetProperty("label").GetString() == startLabel).GetProperty("id").GetString()! });
                Check.Equal(5, call);
                return Tool("world_record", new NarrativeHarnessArgs("保留两次战斗结果。", []));
            });
            var runtime = new DelegationFault(); var dice = new SequenceDice(20, 1, 20, 1);
            var h = await Host.Start(dice: dice, configure: Configure(model, runtime));
            try
            {
                var created = await h.Http.PostAsJsonAsync("/api/v1/harness/campaigns", new CreateHarnessCampaignRequest("委派恢复 " + stage, "Arden", document,
                    Preset with { CombatSystemPrompt = "独立战斗" }, Build: FullCreationTests.Named("Arden", CharacterEngine.Fighter)));
                Check.True(created.IsSuccessStatusCode, await created.Content.ReadAsStringAsync());
                var owner = (await created.Content.ReadFromJsonAsync<CreatedCampaign>())!;
                string id = owner.Snapshot.Id, token = owner.AccessToken;
                h.Http.DefaultRequestHeaders.Authorization = new("Bearer", token);
                var parent = await StartHistorical(h, id, new(Id(), owner.Snapshot.Version, "应对交锋。"), 47);
                parent = await Settled(h, id, parent.Id);
                var session = await Current();
                await Settled(h, id, session.Inputs[0].RunId);
                await EndBattle();
                parent = await Settled(h, id, parent.Id);
                Check.Equal("interrupted", parent.Status); Check.Equal("delegation", parent.Recovery);
                session = await Current();
                Check.True(h.App.Services.GetRequiredService<HarnessRunStore>().Read(id, session.ParentActorId, session.Inputs[0].RunId) is null);
                Check.Equal(3, model.Calls); Check.Equal(2, dice.Count);
                if (stage == "hard")
                {
                    var stale = h.App.Services.GetRequiredService<HarnessRunStore>().Read(id, session.ParentActorId, parent.Id)!;
                    stale.ExecutionStartedAt = DateTimeOffset.UtcNow.AddMinutes(-30);
                    h.App.Services.GetRequiredService<HarnessRunStore>().Save(stale);
                }
                if (stage == "cancel")
                {
                    Check.True((await h.Http.PostAsync($"/api/v1/campaigns/{id}/harness/runs/{parent.Id}/cancel", null)).IsSuccessStatusCode);
                    Check.Equal(3, model.Calls);
                }
                if (stage == "revoked")
                {
                    string replacement = Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N");
                    await h.App.Services.GetRequiredService<CampaignStore>().Access(id, token, true, c =>
                    { typeof(Campaign).GetProperty(nameof(Campaign.TokenHash))!.SetValue(c, JsonFiles.Hash(replacement)); return Task.FromResult(true); });
                    token = replacement;
                }
                string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, dice: dice, configure: Configure(model, runtime));
                h.Http.DefaultRequestHeaders.Authorization = new("Bearer", token); runtime.Fault = false;
                var board = (await h.Http.GetFromJsonAsync<AdventureBoard>($"/api/v1/campaigns/{id}/adventure"))!;
                Check.Equal(stage == "revoked" ? "blocked" : stage == "cancel" ? "stopped" : "ready", board.Sessions.Single().Phase);
                var progress = (await h.Http.GetFromJsonAsync<AdventureProgress>($"/api/v1/campaigns/{id}/adventure/progress"))!.Runs.Single(r => r.Id == parent.Id);
                Check.Equal(stage == "revoked" ? "blocked" : stage == "cancel" ? null : "delegation", progress.Recovery);
                if (stage != "cancel") Check.True(!string.IsNullOrWhiteSpace(progress.Notice));
                var exact = (await h.Http.GetFromJsonAsync<AdventureProgress>($"/api/v1/campaigns/{id}/adventure/progress?actorId={session.ParentActorId}&actionId={session.ParentIntentId}"))!.Runs.Single();
                Check.Equal(progress.Recovery, exact.Recovery); Check.Equal(progress.Notice, exact.Notice);
                Check.True(h.App.Services.GetRequiredService<HarnessRunStore>().Read(id, session.ParentActorId, session.Inputs[0].RunId) is null);
                Check.Equal(3, model.Calls); Check.Equal(2, dice.Count);
                var state = (await h.Get(id))!;
                if (stage == "revoked")
                {
                    var denied = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/harness/runs/{parent.Id}/resume", new HarnessResumeRequest(Id(), state.Version));
                    Check.Equal(System.Net.HttpStatusCode.Unauthorized, denied.StatusCode);
                    Check.Equal(3, model.Calls); Check.Equal(2, dice.Count); continue;
                }
                string childId;
                if (stage == "cancel")
                {
                    var next = await Start(h, state, "重新应对眼前的交锋。"); childId = next.Id;
                    var abandoned = h.App.Services.GetRequiredService<HarnessRunStore>().Read(id, session.ParentActorId, session.Inputs[0].RunId)!;
                    Check.Equal("cancelled", abandoned.Status); Check.Equal(0, abandoned.ModelAttempts); Check.Equal(0, abandoned.Steps.Count);
                }
                else
                {
                    await Post<HarnessRunView>(h, id, $"harness/runs/{parent.Id}/resume", new HarnessResumeRequest(Id(), state.Version));
                    childId = session.Inputs[0].RunId;
                }
                var child = await Settled(h, id, childId);
                Check.Equal("waiting", child.Status); Check.Equal("combat", child.Role); Check.Equal(parent.Id, child.ParentRunId);
                Check.Equal(4, model.Calls); Check.Equal(2, dice.Count);
                if (stage == "hard")
                {
                    var resumed = h.App.Services.GetRequiredService<HarnessRunStore>().Read(id, session.ParentActorId, parent.Id)!;
                    Check.True(resumed.ExecutionStartedAt is null && resumed.RuntimeMilliseconds >= 1800000);
                }
                await EndBattle(); parent = await Settled(h, id, parent.Id);
                Check.Equal(stage == "cancel" ? "cancelled" : "completed", parent.Status);
                Check.Equal(stage == "cancel" ? 4 : 5, model.Calls); Check.Equal(4, dice.Count);
                var saved = h.App.Services.GetRequiredService<HarnessRunStore>().Read(id, session.ParentActorId, parent.Id)!;
                Check.Equal(2, saved.CombatReturns!.Count);
                Check.True(await h.App.Services.GetRequiredService<CampaignStore>().Access(id, token, false,
                    c => Task.FromResult(CombatAgentSessions.Current(c) is null)));

                Task<CombatAgentSession> Current() => h.App.Services.GetRequiredService<CampaignStore>().Access(id, token, false,
                    c => Task.FromResult(CombatAgentSessions.Current(c)!));
                async Task EndBattle()
                {
                    var snapshot = (await h.Get(id))!;
                    snapshot = (await Post<ActionResponse>(h, id, "rolls/respond", new RollResponseRequest(Id(), snapshot.Version, snapshot.PendingRoll!.Id, "roll"))).Snapshot;
                    snapshot = (await h.Act(snapshot, "combat.disengage")).Snapshot;
                    snapshot = (await h.Act(snapshot, "combat.move", "0," + snapshot.Combat!.Units.Single(u => u.Id == "player").Y)).Snapshot;
                    snapshot = (await h.Act(snapshot, "combat.retreat")).Snapshot;
                    Check.Equal("retreated", snapshot.Combat!.Status);
                }
            }
            finally { await h.DisposeAsync(); }
        }
    }

    public static async Task TwoHandoffsKeepReceiptsAndRenewOnlyReturnGeneration()
    {
        var document = StandardCombatTests.Document();
        // Authored repeatable encounter fixture: the second delegation starts a distinct
        // legal battle, not a rebuild/replay of the first one.
        document = document with { Scenes = document.Scenes.Select(s => s.Encounter is null ? s :
            s with { Encounter = s.Encounter with { Repeatable = true } }).ToArray() };
        string startLabel = document.Scenes.Single(s => s.Id == "causeway").Encounter!.StartLabel;
        int parentCalls = 0, childCalls = 0;
        var model = new Model((_, request) =>
        {
            try
            {
            var frame = HarnessExecutionProtocolTests.Frame(request);
            var agent = frame.GetProperty("agent");
            if (agent.GetProperty("role").GetString() == "combat")
            {
                childCalls++;
                Check.True(request.System == "独立战斗提示词");
                Check.Equal(0, request.ProviderHistory.Length);
                string candidate = frame.GetProperty("context").GetProperty("intent").GetProperty("candidates").EnumerateArray()
                    .Single(c => c.GetProperty("label").GetString() == startLabel).GetProperty("id").GetString()!;
                return Tool("actions_propose", new { candidateId = candidate });
            }
            parentCalls++;
            Check.Equal(Preset.SystemPrompt, request.System);
            Check.True(request.ProviderHistory.Length <= parentCalls - 1);
            Check.True(request.ProviderHistory.All(e => !e.Reply.ToolCalls.Any(c => c.Name == "actions_propose")));
            if (parentCalls == 33)
            {
                Check.Equal(2, request.Messages.Count(m => m.Role == "user" && m.Content.Contains("\"combatReturn\"")));
                return Tool("world_record", new NarrativeHarnessArgs("两场交锋均已结束，按最新处境重新考虑。", []));
            }
            int position = (parentCalls - 1) % 16;
            if (position == 15) return Tool("combat_delegate", new CombatDelegateArgs(agent.GetProperty("encounterId").GetString()!, "当前对方实际发起交锋。", []));
            var reply = position < 11 ? Tool("ask_player", new { question = "请明确本次选择：" + parentCalls })
                : Tool("context_read", new { scope = "context" });
            return reply with { Text = new string('x', 500) }; // each interval <8192, cumulative >8192
            }
            catch (Exception error) { Console.WriteLine($"Repeated delegation model parent={parentCalls}, child={childCalls}: {error}"); throw; }
        });
        var dice = new SequenceDice(20, 1, 20, 1);
        var configure = Configure(model, extra: b =>
        {
            b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry();
            b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>();
        });
        var h = await Host.Start(dice: dice, configure: configure);
        try
        {
            var created = await h.Http.PostAsJsonAsync("/api/v1/harness/campaigns", new CreateHarnessCampaignRequest("两次委派隔离", "Arden", document,
                Preset with { CombatSystemPrompt = "独立战斗提示词" }, Build: FullCreationTests.Named("Arden", CharacterEngine.Fighter)));
            Check.True(created.IsSuccessStatusCode, await created.Content.ReadAsStringAsync());
            var owner = (await created.Content.ReadFromJsonAsync<CreatedCampaign>())!;
            string id = owner.Snapshot.Id, token = owner.AccessToken;
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", token);
            var input = new HarnessInputRequest(Id(), owner.Snapshot.Version, "我应对接连发生的交锋，随时重新判断处境。");
            var parent = await StartHistorical(h, id, input, 47);
            string[] sessions = new string[2], battleIds = new string[2];
            string firstReceipt = "";
            for (int battleIndex = 0; battleIndex < 2; battleIndex++)
            {
                for (int answer = 0; answer < 11; answer++)
                {
                    parent = await Settled(h, id, parent.Id, 3000);
                    Check.True(parent.Status == "waiting" && parent.Wait?.Kind == "player", parent.Status + ":" + parent.Error);
                    var snapshot = (await h.Get(id))!;
                    await Post<HarnessRunView>(h, id, $"harness/runs/{parent.Id}/resume", new HarnessResumeRequest(Id(), snapshot.Version, "按当前情况应对。"));
                }
                parent = await Settled(h, id, parent.Id, 3000);
                if (parent.Status != "delegated")
                {
                    var failed = h.App.Services.GetRequiredService<HarnessRunStore>().Read(id, PartyEngine.HostId, parent.Id)!;
                    Console.WriteLine($"Stopped after {parentCalls} parent calls, last step {failed.Steps.Last().Id} / {failed.Steps.Last().ToolName}.");
                }
                Check.True(parent.Status == "delegated", parent.Status + ":" + parent.Error);
                var store = h.App.Services.GetRequiredService<CampaignStore>();
                var runs = h.App.Services.GetRequiredService<HarnessRunStore>();
                var session = await store.Access(id, token, false, c => Task.FromResult(CombatAgentSessions.Current(c)!));
                sessions[battleIndex] = session.Id;
                Check.Equal(JsonFiles.Hash(token), session.ParentCredentialHash);
                Check.Equal(parent.Id, session.ParentRunId);
                var child = await Settled(h, id, session.Inputs[0].RunId, 3000);
                Check.True(child.Status == "waiting" && child.Wait?.Kind == "roll", child.Status + ":" + child.Error);
                Check.Equal(battleIndex * 2, dice.Count);
                var saved = runs.Read(id, session.ParentActorId, parent.Id)!;
                Check.Equal((battleIndex + 1) * 16, saved.ModelAttempts);
                if (battleIndex == 0)
                {
                    firstReceipt = HarnessJson.Serialize(saved.Steps.Last().Outcome);
                    // Explicit elapsed-lease fixture: a completed pre-battle generation has
                    // already consumed its deadline. No model/effect/turn is fabricated.
                    saved.RuntimeMilliseconds = 750001; runs.Save(saved);
                }
                else Check.Equal(firstReceipt, HarnessJson.Serialize(saved.Steps.First(s => s.Outcome?.DelegatedSessionId is not null).Outcome));
                // Reopen with the second first-input grant and first return both durable.
                if (battleIndex == 1)
                {
                    string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, dice: dice, configure: configure);
                    h.Http.DefaultRequestHeaders.Authorization = new("Bearer", token);
                    await h.Get(id); Check.Equal(34, model.Calls);
                }
                var state = (await h.Get(id))!;
                state = (await Post<ActionResponse>(h, id, "rolls/respond", new RollResponseRequest(Id(), state.Version, state.PendingRoll!.Id, "roll"))).Snapshot;
                battleIds[battleIndex] = state.Combat!.Id;
                state = (await h.Act(state, "combat.disengage")).Snapshot;
                var player = state.Combat!.Units.Single(u => u.Id == "player");
                state = (await h.Act(state, "combat.move", "0," + player.Y)).Snapshot;
                state = (await h.Act(state, "combat.retreat")).Snapshot;
                Check.Equal("retreated", state.Combat!.Status);
            }
            parent = await Settled(h, id, parent.Id, 3000);
            if (parent.Status != "completed")
            {
                var diagnostic = h.App.Services.GetRequiredService<HarnessRunStore>().Read(id, PartyEngine.HostId, parent.Id)!;
                Console.WriteLine($"Return failure root={h.Root}, calls={model.Calls}, steps={diagnostic.Steps.Count}, turns={diagnostic.Turns.Count}, error={parent.Error}, lastStep={diagnostic.Steps.Last().Id}, lastStatus={diagnostic.Steps.Last().Status}, lastTool={diagnostic.Steps.Last().ToolName}");
            }
            Check.True(parent.Status == "completed", parent.Status + ":" + parent.Error);
            Check.Equal(35, model.Calls); Check.Equal(33, parentCalls); Check.Equal(2, childCalls); Check.Equal(4, dice.Count);
            Check.True(sessions[0] != sessions[1] && battleIds[0] != battleIds[1]);
            var final = h.App.Services.GetRequiredService<HarnessRunStore>().Read(id, PartyEngine.HostId, parent.Id)!;
            Check.Equal(2, final.CombatReturns!.Count); Check.Equal(2, final.Turns.Count(t => t.Contains("\"combatReturn\"")));
            Check.Equal(66, final.Steps.Count); Check.Equal(25, final.Turns.Count); Check.Equal(23, final.Resumes.Count); // 22 answers plus the historical fixture startup resume
            Check.Equal(final.CombatReturns[1].ReturnId, final.CombatReturnId);
            var progress = (await h.Http.GetFromJsonAsync<AdventureProgress>($"/api/v1/campaigns/{id}/adventure/progress?actorId=player&actionId={final.IntentId}"))!;
            Check.Equal(66, progress.Runs.Single().Steps.Length);
            var lastStep = (await h.Http.GetFromJsonAsync<AdventureStepDetail>($"/api/v1/campaigns/{id}/adventure/progress/steps/66?actorId=player&actionId={final.IntentId}"))!;
            Check.Equal("world_record", lastStep.Tool);
            Check.Equal(sessions[1], final.DelegatedSessionId);
            Check.True((await Post<HarnessRunView>(h, id, "harness/runs", input)).Replayed);
            Check.Equal(35, model.Calls); Check.Equal(4, dice.Count);
            Check.True(await h.App.Services.GetRequiredService<CampaignStore>().Access(id, token, false,
                c => Task.FromResult(c.CombatAgentSessions!.Count == 2 && c.CombatAgentSessions.All(s => s.ReturnConsumed))));
            Console.WriteLine("Repeated delegation: real Pi, 35 fake calls, 2 real authoritative battles/4 dice, same parent and immutable receipts, 66 steps/25 turns/22 answers; new interval only at saved return, restart and zero-call replay.");
        }
        finally { await h.DisposeAsync(); }
    }
}
