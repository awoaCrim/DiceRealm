using System.Net.Http.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class CombatAgentSessionTests
{
    public static async Task DelegationIndependentInputsRestartAndReturn()
    {
        const string battlePrompt = "  独立战斗系统原文\r\n保留人物和交涉。\t ";
        var document = StandardCombatTests.Document();
        var person = document.Npcs[0];
        document = document with { Npcs = [.. document.Npcs,
            person with { Id = "combat-witness", Name = "现场证人", SceneId = "causeway", Locations = [], Visible = new(), Summary = "PUBLIC_NPC_RELATIONSHIP" },
            person with { Id = "combat-secret", Name = "隐藏人物", SceneId = "causeway", Locations = [], Visible = new() { None = ["visited:causeway"] }, Summary = "HIDDEN_NPC_PROFILE" }] };
        string startLabel = document.Scenes.Single(s => s.Id == "causeway").Encounter!.StartLabel;
        var recalled = new List<CombatHistoryItem>();
        int parentReadVersion = 0;
        string followupSession = "";
        int followupStage = 0;
        var followupDiscoveries = new List<CombatHistoryItem>();
        var model = new Model((call, request) =>
        {
            try
            {
            int n = call - 1;
            if (n == 4)
                return Tool("world_record", new NarrativeHarnessArgs("双方继续交谈。", [], Complete: false,
                    Continuity: Enumerable.Range(0, 8).Select(i => new NarrativeContinuityEntry("statement", "MIDDLE_NOTE_" + i)).ToArray()), "middle-notes");
            if (n == 5)
                return Tool("world_record", new NarrativeHarnessArgs("先攻已经确定，继续按现场行动。", [], Private: "FIRST_PRIVATE_DISCOVERY",
                    Continuity: [new("promise", "你只要求对方让开；未承诺战后继续前进。")]), "accepted-note");
            if (n >= 6) n -= 2;
            if (n == 0) return Tool("world_record", new NarrativeHarnessArgs("PARENT_EXECUTED_PROGRESS", [], Complete: false));
            var frame = HarnessExecutionProtocolTests.Frame(request);
            var agent = frame.GetProperty("agent");
            if (followupSession.Length > 0)
            {
                Check.True(!agent.TryGetProperty("afterCombat", out _));
                Check.True(agent.GetProperty("recentCombatSessions").EnumerateArray().Any(s => s.GetString() == followupSession));
                if (followupStage++ == 0)
                {
                    Check.True(request.Messages.Any(m => m.Content.Contains("FIRST_PRIVATE_DISCOVERY")), "Past battle findings are supplied proactively in exploration history.");
                    return Tool("combat_history_read", new { scope = "sessions" });
                }
                var page = HarnessJson.Read<CombatHistoryPage>(System.Text.Json.JsonDocument.Parse(request.Messages.Last(m => m.Role == "tool").Content).RootElement);
                if (page.Scope == "sessions")
                {
                    Check.True(page.Entries.Any(e => e.SourceId == followupSession));
                    return Tool("combat_history_read", new CombatHistoryReadArgs(followupSession, "discoveries", Limit: 1));
                }
                followupDiscoveries.AddRange(page.Entries);
                if (page.HasMore) return Tool("combat_history_read", new CombatHistoryReadArgs(followupSession, "discoveries", page.NextAfter, page.Through, 1));
                Check.True(followupDiscoveries.Any(e => e.Text == "FIRST_PRIVATE_DISCOVERY"));
                Check.True(followupDiscoveries.Any(e => e.Text == "LATEST_PRIVATE_DISCOVERY"));
                return Tool("world_record", new NarrativeHarnessArgs("按此前本人所知继续交谈。", []));
            }
            if (n == 1 || n >= 6)
            {
                Check.Equal(Preset.SystemPrompt, request.System);
                Check.Equal("exploration", agent.GetProperty("role").GetString());
                Check.True(!request.Tools.Any(t => t.Name == "encounter_engage"));
                if (n >= 6)
                {
                    using var packet = System.Text.Json.JsonDocument.Parse(request.Messages.Last(m => m.Role == "user" && m.Content.Contains("\"combatReturn\"")).Content);
                    var returned = packet.RootElement.GetProperty("combatReturn");
                    string sessionId = returned.GetProperty("sessionId").GetString()!;
                    var aftermath = agent.GetProperty("afterCombat");
                    Check.Equal(sessionId, aftermath.GetProperty("sessionId").GetString());
                    Check.Equal(returned.GetProperty("id").GetString(), aftermath.GetProperty("returnId").GetString());
                    Check.True(aftermath.GetProperty("instruction").GetString()!.Contains("不是重写战报"));
                    Check.True(returned.GetProperty("units").EnumerateArray().All(u => u.GetProperty("audience").GetString() is "public" or "actor"));
                    if (n == 6)
                    {
                        Check.True(returned.GetProperty("units").EnumerateArray().Any(u => u.GetProperty("withdrawn").GetBoolean()));
                        var story = returned.GetProperty("story").EnumerateArray().ToArray();
                        Check.True(story.Any(s => s.GetProperty("text").GetString() == "FIRST_PRIVATE_DISCOVERY" && s.GetProperty("audience").GetString() == PartyEngine.HostId));
                        Check.True(story.Any(s => s.GetProperty("text").GetString() == "LATEST_PRIVATE_DISCOVERY"));
                        Check.True(story.Any(s => s.GetProperty("kind").GetString() == "player_question"));
                        Check.True(story.Any(s => s.GetProperty("text").GetString() == "只要后一个。"));
                        var promises = story.Where(s => s.GetProperty("text").GetString() == "你只要求对方让开；未承诺战后继续前进。").ToArray();
                        Check.Equal(2, promises.Length); // Same words in two distinct inputs remain two sources.
                        Check.True(promises.All(s => s.GetProperty("kind").GetString() == "model_reported_promise" && s.GetProperty("audience").GetString() == PartyEngine.HostId));
                        var earlyNote = story.Single(s => s.GetProperty("text").GetString() == "EARLY_NOTE_0");
                        Check.True(earlyNote.GetProperty("sourceId").GetString()!.StartsWith("run:") && earlyNote.GetProperty("kind").GetString() == "model_reported_statement" && earlyNote.GetProperty("audience").GetString() == PartyEngine.HostId);
                        Check.True(!story.Any(s => s.GetProperty("text").GetString()!.Contains("REJECTED_PROMISE")));
                        Check.True(story.All(s => s.GetProperty("sourceId").GetString()!.Length > 0 && s.GetProperty("revision").GetString()!.Length == 64));
                        Check.True(returned.TryGetProperty("course", out _) && returned.TryGetProperty("ending", out _));
                        Check.True(!returned.TryGetProperty("log", out _), "No per-attack stream is returned to exploration.");
                        parentReadVersion = returned.GetProperty("version").GetInt32();
                        return Tool("combat_history_read", new CombatHistoryReadArgs(sessionId, "events", Through: parentReadVersion, Limit: 8));
                    }
                    var page = HarnessJson.Read<CombatHistoryPage>(System.Text.Json.JsonDocument.Parse(request.Messages.Last(m => m.Role == "tool").Content).RootElement);
                    Check.Equal(parentReadVersion, page.Through);
                    Check.True(page.Entries.All(e => e.SourceId.Length > 0));
                    recalled.AddRange(page.Entries);
                    if (page.HasMore) return Tool("combat_history_read", new CombatHistoryReadArgs(sessionId, page.Scope, page.NextAfter, page.Through, 8));
                    if (page.Scope == "events") return Tool("combat_history_read", new CombatHistoryReadArgs(sessionId, "inputs", Through: page.Through, Limit: 8));
                    Check.True(recalled.Any(e => e.Kind == "private_discovery" && e.Text == "FIRST_PRIVATE_DISCOVERY" && e.Audience == "actor"));
                    Check.True(recalled.Any(e => e.Kind == "private_discovery" && e.Text == "LATEST_PRIVATE_DISCOVERY" && e.Audience == "actor"));
                    Check.True(recalled.Any(e => e.Kind == "player_answer" && e.Text == "只要后一个。" && e.Audience == "actor"));
                    var answer = recalled.Single(e => e.Kind == "player_answer");
                    Check.True(recalled.Any(e => e.Kind == "player_question" && e.SourceId == answer.ReplyTo && e.Text.Contains("还是只让开道路")));
                    Check.True(!recalled.Any(e => e.Text.Contains("REJECTED_PROMISE")));
                    Check.True(recalled.Any(e => e.Kind == "model_reported_promise" && e.Audience == "actor"));
                    Check.True(!recalled.Any(e => e.Kind.StartsWith("model_reported_") && e.Audience == "public"));
                    return Tool("world_record", new NarrativeHarnessArgs("战斗已经结束，停在当前处境等待你的下一选择。", []));
                }
                return Tool("combat_delegate", new CombatDelegateArgs(agent.GetProperty("encounterId").GetString()!, "对方开始实际进攻。",
                    [new("statement", "对方先前说过：不会让你通过。"), new("open_question", "原来想要继续交涉，尚未决定战后去向。")]), "delegate");
            }
            Check.Equal(battlePrompt, request.System);
            Check.Equal("combat", agent.GetProperty("role").GetString());
            Check.True(!frame.TryGetProperty("workingContext", out _) && !frame.TryGetProperty("scenePresentation", out _) && !frame.TryGetProperty("supplies", out _));
            Check.True(!request.Tools.Any(t => t.Name is "combat_delegate" or "world_routes" or "memory_search" or "token_move"));
            Check.True(frame.GetProperty("dmChecklist").GetProperty("instructions").GetString()!.StartsWith("# 本次调用：完整战斗主持检查"));
            if (n == 2)
            {
                Check.True(!request.Messages.Any(m => m.Role == "assistant"), "Child must not inherit parent exploration dialogue.");
                Check.True(agent.GetProperty("handoff").GetProperty("progress").EnumerateArray().Any(p => p.GetProperty("kind").GetString() == "adventure.narrate" && p.GetProperty("sequence").GetInt32() > 1));
                Check.True(agent.GetProperty("people").EnumerateArray().Any(p => p.GetProperty("summary").GetString() == "PUBLIC_NPC_RELATIONSHIP"));
                Check.True(!HarnessJson.Serialize(request).Contains("HIDDEN_NPC_PROFILE"));
                string candidate = frame.GetProperty("context").GetProperty("intent").GetProperty("candidates").EnumerateArray()
                    .Single(c => c.GetProperty("label").GetString() == startLabel).GetProperty("id").GetString()!;
                return Tool("actions_propose", new { candidateId = candidate });
            }
            if (n == 3)
            {
                var rejected = Tool("world_record", new NarrativeHarnessArgs("不可保存", [new("", "clue", "禁止战斗写探索记忆", "拒绝", "known", "causeway")],
                    Continuity: [new("promise", "REJECTED_PROMISE")]), "rejected-note");
                var early = Tool("world_record", new NarrativeHarnessArgs("交锋中的早期交谈已经记下。", [], Complete: false,
                    Continuity: Enumerable.Range(0, 8).Select(i => new NarrativeContinuityEntry("statement", "EARLY_NOTE_" + i)).ToArray()), "early-notes");
                return early with { ToolCalls = [.. rejected.ToolCalls, .. early.ToolCalls] };
            }
            if (n == 4)
            {
                Check.Equal(0, request.ProviderHistory.Length);
                Check.True(request.Messages.Any(m => m.Content.Contains("先攻已经确定")), "A later input gets sourced history, not previous input's native chain.");
                return Tool("ask_player", new { question = "你希望对方放下武器，还是只让开道路？" });
            }
            if (n == 5)
            {
                Check.True(request.Messages.Any(m => m.Content.Contains("playerAnswer")));
                return Tool("world_record", new NarrativeHarnessArgs("你的话已传达，对方尚未放下武器，交锋仍在继续。", [],
                    Private: "LATEST_PRIVATE_DISCOVERY", Continuity: [new("promise", "你只要求对方让开；未承诺战后继续前进。") ]));
            }
            throw new Exception("Unexpected model call " + n);
            }
            catch (Exception error) { Console.WriteLine("Scripted combat assertion at call " + call + ": " + error); throw; }
        });
        var dice = new SequenceDice(20, 1);
        var configure = Configure(model, extra: b =>
        { b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry(); b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>(); });
        var h = await Host.Start(dice: dice, configure: configure);
        try
        {
            var created = await h.Http.PostAsJsonAsync("/api/v1/harness/campaigns", new CreateHarnessCampaignRequest("独立战斗子会话隔离", "Arden", document,
                Preset with { CombatSystemPrompt = battlePrompt }, Build: FullCreationTests.Named("Arden", CharacterEngine.Fighter)));
            Check.True(created.IsSuccessStatusCode, await created.Content.ReadAsStringAsync());
            var owner = (await created.Content.ReadFromJsonAsync<CreatedCampaign>())!;
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            string id = owner.Snapshot.Id;
            var input = new HarnessInputRequest(Id(), owner.Snapshot.Version, "我守住位置，回应对方的进攻。");
            // This regression owns v47 handoff/history semantics and uses direct
            // engineering moves; v49 paced gameplay is covered by CombatNarrationHttpTests.
            var parent = await StartHistorical(h, id, input, 47);
            parent = await Settled(h, id, parent.Id, 3000);
            Check.Equal("delegated", parent.Status);
            Check.Equal(0, dice.Count);
            var session = await Session(h, id, owner.AccessToken);
            Check.Equal(parent.Id, session.ParentRunId); Check.True(session.BattleId is null);
            var child = await Settled(h, id, session.Inputs[0].RunId, 3000);
            Check.True(child.Status == "waiting" && child.Wait?.Kind == "roll", child.Status + ":" + child.Error);
            Check.Equal(session.Id, child.BattleSessionId); Check.Equal(0, dice.Count); Check.Equal(3, model.Calls);
            Check.Equal("delegated", (await h.Http.GetFromJsonAsync<AdventureSessionView>($"/api/v1/campaigns/{id}/adventure/sessions/{parent.Id}"))!.Phase);
            async Task AssertInheritedInputIsNotBroadcast()
            {
                var first = (await h.Http.GetFromJsonAsync<AdventureSessionView>($"/api/v1/campaigns/{id}/adventure/sessions/{child.Id}"))!;
                Check.Equal("", first.ActionText); Check.Equal(child.IntentId, first.ActionId);
                var progress = (await h.Http.GetFromJsonAsync<AdventureProgress>($"/api/v1/campaigns/{id}/adventure/progress?actorId={session.ParentActorId}&actionId={child.IntentId}"))!;
                Check.Equal("", progress.Runs.Single().Input);
                var audit = (await h.Http.GetFromJsonAsync<HarnessRunView>($"/api/v1/campaigns/{id}/harness/runs/{child.Id}"))!;
                Check.Equal(input.Text, audit.Input); Check.True(audit.FirstCombatInput);
            }
            await AssertInheritedInputIsNotBroadcast();
            var snapshot = (await h.Get(id))!;
            var confirm = new RollResponseRequest(Id(), snapshot.Version, snapshot.PendingRoll!.Id, "roll");
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, dice: dice, configure: configure);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            Check.Equal(3, model.Calls); Check.Equal(0, dice.Count);
            await AssertInheritedInputIsNotBroadcast();
            var confirmed = await Post<ActionResponse>(h, id, "rolls/respond", confirm);
            Check.Equal(2, dice.Count);
            await Post<HarnessRunView>(h, id, $"harness/runs/{child.Id}/resume", new HarnessResumeRequest(Id(), confirmed.Snapshot.Version));
            child = await Settled(h, id, child.Id, 3000); Check.Equal("completed", child.Status);
            await WaitSession(h, id, owner.AccessToken, s => s.BattleId is not null);
            snapshot = (await h.Get(id))!;
            // Identical text with a new request is still a real, separate player message.
            var dialogue = await Start(h, snapshot, input.Text);
            dialogue = await Settled(h, id, dialogue.Id, 3000);
            Check.True(dialogue.Status == "waiting" && dialogue.Wait?.Kind == "player", dialogue.Status + ":" + dialogue.Error);
            Check.Equal(session.Id, dialogue.BattleSessionId);
            Check.Equal(input.Text, (await h.Http.GetFromJsonAsync<AdventureSessionView>($"/api/v1/campaigns/{id}/adventure/sessions/{dialogue.Id}"))!.ActionText);
            Check.True(!dialogue.FirstCombatInput);
            snapshot = (await h.Get(id))!;
            await Post<HarnessRunView>(h, id, $"harness/runs/{dialogue.Id}/resume", new HarnessResumeRequest(Id(), snapshot.Version, "只要后一个。"));
            dialogue = await Settled(h, id, dialogue.Id, 3000); Check.Equal("completed", dialogue.Status);
            Check.Equal(8, model.Calls); Check.Equal(2, dice.Count);
            // Real existing domain commands, not state editing: disengage, move to the edge,
            // and leave. These engineering actions are not claimed as a natural-input tour.
            snapshot = (await h.Get(id))!;
            snapshot = (await h.Act(snapshot, "combat.disengage")).Snapshot;
            var player = snapshot.Combat!.Units.Single(u => u.Id == "player");
            snapshot = (await h.Act(snapshot, "combat.move", "0," + player.Y)).Snapshot;
            snapshot = (await h.Act(snapshot, "combat.retreat")).Snapshot;
            Check.Equal("retreated", snapshot.Combat!.Status);
            // The authoritative closing command hands control back without another player input.
            await WaitSession(h, id, owner.AccessToken, s => s.ReturnConsumed);
            parent = await Settled(h, id, parent.Id, 3000);
            Check.True(parent.Status == "completed", parent.Status + ":" + parent.Error);
            Check.True(model.Calls >= 9); Check.Equal(2, dice.Count);
            int totalCalls = model.Calls;
            var ended = await Session(h, id, owner.AccessToken, session.Id);
            Check.Equal(2, ended.Inputs.Count); Check.Equal("retreated", ended.Return!.Status);
            int version = (await h.Get(id))!.Version;
            var activity = (await h.Http.GetFromJsonAsync<ActivityPage>($"/api/v1/campaigns/{id}/activity?after=0&limit=100"))!;
            var parentEntries = activity.Entries.Where(e => e.ActionId == parent.IntentId).ToArray();
            Check.Equal(2, parentEntries.Length);
            Check.Equal("PARENT_EXECUTED_PROGRESS", parentEntries[0].Narrative);
            Check.Equal(0, parentEntries[0].ContinuationOf);
            Check.Equal(parentEntries[0].Sequence, parentEntries[1].ContinuationOf);
            Check.True(parentEntries[1].Sequence > ended.Return.Version);
            Check.Equal("战斗已经结束，停在当前处境等待你的下一选择。", parentEntries[1].Narrative);
            Check.Equal(parentEntries[0].Sequence, activity.Entries.Single(e => e.ActionId == child.IntentId).ContinuationOf);
            // A late frozen page must contain the reply even when the input root is outside it.
            var tail = (await h.Http.GetFromJsonAsync<ActivityPage>($"/api/v1/campaigns/{id}/activity?after={ended.Return.Version}&through={version}&limit=1"))!;
            Check.Equal(parentEntries[1].Sequence, tail.Entries.Single().Sequence);
            var detail = (await h.Http.GetFromJsonAsync<ActivityEntry>($"/api/v1/campaigns/{id}/activity/{parentEntries[1].Sequence}"))!;
            Check.Equal(parentEntries[1].Narrative, detail.Narrative);
            Check.Equal(totalCalls, model.Calls); Check.Equal(2, dice.Count);
            root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, dice: dice, configure: configure);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            Check.True((await Post<HarnessRunView>(h, id, "harness/runs", input)).Replayed);
            Check.True((await Post<ActionResponse>(h, id, "rolls/respond", confirm)).Replayed);
            Check.Equal(version, (await h.Get(id))!.Version); Check.Equal(totalCalls, model.Calls); Check.Equal(2, dice.Count);
            followupSession = session.Id;
            var later = await Start(h, (await h.Get(id))!, "我回想刚才独自发现的细节，再继续交谈。");
            later = await Settled(h, id, later.Id, 3000);
            Check.True(later.Status == "completed", later.Status + ":" + later.Error);
            Check.Equal(2, dice.Count); Check.Equal(version + 1, (await h.Get(id))!.Version);
            Console.WriteLine($"Persistent combat child: real Pi/MCP, before-initiative delegation, automatic NPC/progress handoff, independent history, restart, automatic return, exact private discoveries/questions/elliptical answers/accepted promises and later exploration recall; {model.Calls} fake calls, 0 real provider calls.");
        }
        finally { await h.DisposeAsync(); }
    }

    private static Task<CombatAgentSession> Session(Host h, string id, string token, string? session = null) => h.App.Services.GetRequiredService<CampaignStore>()
        .Access(id, token, false, c => Task.FromResult(session is null ? CombatAgentSessions.Current(c)! : CombatAgentSessions.Require(c, session)));
    private static async Task WaitSession(Host h, string id, string token, Func<CombatAgentSession, bool> predicate)
    {
        for (int i = 0; i < 400; i++)
        {
            var session = await h.App.Services.GetRequiredService<CampaignStore>().Access(id, token, false, c => Task.FromResult(c.CombatAgentSessions!.Last()));
            if (predicate(session)) return;
            await Task.Delay(25);
        }
        throw new Exception("Combat session transition did not settle.");
    }
}
