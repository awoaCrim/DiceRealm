using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class CombatAgentRecoveryTests
{
    // Fault before the first returned-parent callback: no external call has started.
    private sealed class PauseReturn : IHarnessRuntime
    {
        public bool Paused = true;
        private readonly Loop loop = new();
        public Task<HarnessCompletion> Execute(HarnessExecution request, Func<HarnessCallback, CancellationToken, Task<JsonElement>> callback, CancellationToken ct)
        {
            if (Paused && request.Turns.Any(t => t.Contains("\"combatReturn\"", StringComparison.Ordinal))) throw new IOException("isolated pre-callback fault");
            return loop.Execute(request, callback, ct);
        }
    }

    public static async Task ReturnCrashRecoveryCancellationAndOriginalGrant()
    {
        foreach (string stage in new[] { "frozen", "received", "consumed", "cancelled", "revoked", "hardReturn" }) await Scenario(stage);
    }

    private static async Task RejectDamagedSessionsWithoutWriting(Host h, string id, string token, CombatAgentSession session)
    {
        string path = Path.Combine(h.Root, "campaigns", id + ".sqlite");
        string State(string? replacement = null)
        {
            using var db = new Microsoft.Data.Sqlite.SqliteConnection("Data Source=" + path); db.Open();
            using var command = db.CreateCommand();
            if (replacement is not null)
            {
                command.CommandText = "UPDATE state SET json=$json WHERE id=1";
                command.Parameters.AddWithValue("$json", replacement); command.ExecuteNonQuery();
            }
            command.CommandText = "SELECT json FROM state WHERE id=1";
            return (string)command.ExecuteScalar()!;
        }
        byte[] Hash()
        {
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            return System.Security.Cryptography.SHA256.HashData(stream);
        }
        string original = State();
        var mutations = new Action<System.Text.Json.Nodes.JsonObject>[]
        {
            s => s["return"]!["actor"] = null,
            s => s["return"]!["inputs"] = null,
            s => s["return"]!["log"] = null,
            s => s["return"]!["inputs"]![0]!["runId"] = Id(),
            s => s["profile"]!["hash"] = new string('0', 64),
            s => s["parentCredentialHash"] = null,
            s => s["toolContractVersion"] = 999
        };
        var store = h.App.Services.GetRequiredService<CampaignStore>();
        var game = h.App.Services.GetRequiredService<GameService>();
        var freeze = typeof(GameService).GetMethod("FreezeCombatReturn", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!;
        try
        {
            foreach (var mutate in mutations)
            {
                var saved = System.Text.Json.Nodes.JsonNode.Parse(original)!.AsObject();
                mutate(saved["combatAgentSessions"]![0]!.AsObject());
                var damaged = saved["combatAgentSessions"]![0]!.Deserialize<CombatAgentSession>(JsonFiles.Options)!;
                byte[] beforeWrite = Hash();
                try
                {
                    await store.Access(id, token, true, c => { c.CombatAgentSessions![0] = damaged; return Task.FromResult(true); });
                    throw new Exception("Damaged session was saved.");
                }
                catch (GameException error) { Check.Equal("invalid_combat_session", error.Code); }
                Check.True(beforeWrite.SequenceEqual(Hash()));
                State(saved.ToJsonString());
                byte[] corrupted = Hash();
                var response = await h.Http.GetAsync($"/api/v1/campaigns/{id}");
                Check.Equal(HttpStatusCode.Conflict, response.StatusCode);
                Check.True((await response.Content.ReadAsStringAsync()).Contains("invalid_combat_session"));
                try
                {
                    await (Task<CombatAgentReturn>)freeze.Invoke(game, [id, session.Id, session.ParentRunId, CancellationToken.None])!;
                    throw new Exception("Internal authorization accepted damaged session.");
                }
                catch (GameException error) { Check.Equal("invalid_combat_session", error.Code); }
                Check.True(corrupted.SequenceEqual(Hash()), "Bad reads/authorization must preserve bytes.");
                State(original);
            }
        }
        finally { State(original); }
    }

    private static async Task Scenario(string stage)
    {
        var document = StandardCombatTests.Document();
        string startLabel = document.Scenes.Single(s => s.Id == "causeway").Encounter!.StartLabel;
        var model = new Model((n, request) =>
        {
            var frame = HarnessExecutionProtocolTests.Frame(request);
            if (n == 1) return Tool("combat_delegate", new CombatDelegateArgs(frame.GetProperty("agent").GetProperty("encounterId").GetString()!, "真实交锋。", []));
            if (n == 2)
            {
                string candidate = frame.GetProperty("context").GetProperty("intent").GetProperty("candidates").EnumerateArray()
                    .Single(c => c.GetProperty("label").GetString() == startLabel).GetProperty("id").GetString()!;
                return Tool("actions_propose", new { candidateId = candidate });
            }
            Check.Equal(3, n); Check.True(request.Messages.Any(m => m.Content.Contains("combatReturn")));
            return Tool("world_record", new NarrativeHarnessArgs("停在当前处境，等候新的行动。", []));
        });
        var runtime = new PauseReturn(); var dice = new SequenceDice(20, 1);
        var h = await Host.Start(dice: dice, configure: Configure(model, runtime));
        try
        {
            var created = await h.Http.PostAsJsonAsync("/api/v1/harness/campaigns", new CreateHarnessCampaignRequest("隔离恢复 " + stage, "Arden", document,
                Preset with { CombatSystemPrompt = "独立战斗主持原文" }, Build: FullCreationTests.Named("Arden", CharacterEngine.Fighter)));
            Check.True(created.IsSuccessStatusCode, await created.Content.ReadAsStringAsync());
            var owner = (await created.Content.ReadFromJsonAsync<CreatedCampaign>())!;
            string id = owner.Snapshot.Id, token = owner.AccessToken;
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", token);
            var parentView = await StartHistorical(h, id, new(Id(), owner.Snapshot.Version, "我回应进攻。"), 47);
            parentView = await Settled(h, id, parentView.Id); Check.Equal("delegated", parentView.Status);
            var store = h.App.Services.GetRequiredService<CampaignStore>();
            var runs = h.App.Services.GetRequiredService<HarnessRunStore>();
            var battle = await store.Access(id, token, false, c => Task.FromResult(CombatAgentSessions.Current(c)!));
            var child = await Settled(h, id, battle.Inputs[0].RunId);
            Check.Equal("waiting", child.Status);
            var before = runs.Read(id, battle.ParentActorId, parentView.Id)!;
            if (stage == "cancelled")
            {
                var cancelled = await h.Http.PostAsync($"/api/v1/campaigns/{id}/harness/runs/{before.Id}/cancel", null);
                Check.True(cancelled.IsSuccessStatusCode, await cancelled.Content.ReadAsStringAsync());
            }
            if (stage == "hardReturn")
            {
                // Hard-crash journal after the committed delegate, before the final marker.
                // The real battle remains authoritative; no effect or callback is replayed.
                before.Status = "running"; before.ExecutionStartedAt = DateTimeOffset.UtcNow.AddMinutes(-30); runs.Save(before);
            }
            var snapshot = (await h.Get(id))!;
            snapshot = (await Post<ActionResponse>(h, id, "rolls/respond", new RollResponseRequest(Id(), snapshot.Version, snapshot.PendingRoll!.Id, "roll"))).Snapshot;
            snapshot = (await h.Act(snapshot, "combat.disengage")).Snapshot;
            var player = snapshot.Combat!.Units.Single(u => u.Id == "player");
            snapshot = (await h.Act(snapshot, "combat.move", "0," + player.Y)).Snapshot;
            snapshot = (await h.Act(snapshot, "combat.retreat")).Snapshot;
            Check.Equal("retreated", snapshot.Combat!.Status); Check.Equal(2, dice.Count);
            parentView = await Settled(h, id, before.Id);
            Check.Equal(stage == "cancelled" ? "cancelled" : "interrupted", parentView.Status);
            Check.Equal(2, model.Calls);
            var received = runs.Read(id, battle.ParentActorId, before.Id)!;
            string returnId = received.CombatReturnId!; Check.True(returnId is not null);
            if (stage == "consumed") await RejectDamagedSessionsWithoutWriting(h, id, token, battle);
            Check.Equal(1, received.Turns.Count(t => t.Contains("\"combatReturn\"")));
            Check.Equal("cancelled", runs.Read(id, battle.Inputs[0].ActorId, child.Id)!.Status);
            if (stage == "cancelled")
            {
                Check.True(await store.Access(id, token, false, c => Task.FromResult(CombatAgentSessions.Current(c) is null)));
                Check.Equal(2, model.Calls); return;
            }
            // Restore the durable artifacts at each crash boundary in this disposable fixture.
            // No battle/HP/dice/events are rolled back or replayed.
            if (stage == "frozen") runs.Save(before);
            if (stage is "frozen" or "received") await store.Access(id, token, true, c =>
            {
                var s = CombatAgentSessions.Require(c, battle.Id); s.ReturnConsumed = false; s.Phase = "return_pending";
                return Task.FromResult(true);
            });
            if (stage == "revoked")
            {
                string replacement = Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N");
                await store.Access(id, token, true, c => { typeof(Campaign).GetProperty(nameof(Campaign.TokenHash))!.SetValue(c, JsonFiles.Hash(replacement)); return Task.FromResult(true); });
                token = replacement;
            }
            int version = snapshot.Version;
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, dice: dice, configure: Configure(model, runtime));
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", token);
            runtime.Paused = false;
            await h.Get(id); await h.Http.GetAsync($"/api/v1/campaigns/{id}/adventure");
            Check.Equal(2, model.Calls); Check.Equal(2, dice.Count);
            var resume = new HarnessResumeRequest(Id(), version);
            if (stage == "revoked")
            {
                var denied = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/harness/runs/{before.Id}/resume", resume);
                Check.Equal(HttpStatusCode.Unauthorized, denied.StatusCode);
                Check.Equal(2, model.Calls);
                var unchanged = h.App.Services.GetRequiredService<HarnessRunStore>().Read(id, battle.ParentActorId, before.Id)!;
                Check.Equal(received.Resumes.Count, unchanged.Resumes.Count); Check.Equal(received.Turns.Count, unchanged.Turns.Count);
                return;
            }
            await Post<HarnessRunView>(h, id, $"harness/runs/{before.Id}/resume", resume);
            parentView = await Settled(h, id, before.Id);
            Check.True(parentView.Status == "completed", stage + ":" + parentView.Error);
            var final = h.App.Services.GetRequiredService<HarnessRunStore>().Read(id, battle.ParentActorId, before.Id)!;
            Check.Equal(returnId, final.CombatReturnId); Check.Equal(1, final.Turns.Count(t => t.Contains("\"combatReturn\"")));
            Check.Equal(3, model.Calls); Check.Equal(2, dice.Count);
            Check.True((await Post<HarnessRunView>(h, id, $"harness/runs/{before.Id}/resume", resume)).Replayed);
            Check.Equal(3, model.Calls); Check.Equal(version + 1, (await h.Get(id))!.Version);
        }
        finally { await h.DisposeAsync(); }
    }
}
