using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class HarnessBoundaryTests
{
    private static string Secret() => Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
    internal static async Task<CreatedCampaign> Guest(Host h, CreatedCampaign owner)
    {
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        var s = (await h.Get(owner.Snapshot.Id))!;
        var invite = new InviteRequest(Id(), s.Version, Secret());
        await Post<ActionResponse>(h, s.Id, "invitations", invite);
        var guest = await Post<CreatedCampaign>(h, s.Id, "join", new JoinCampaignRequest(Id(), invite.InviteToken, Secret(), "Lyra", Build: FullCreationTests.Named("Lyra")));
        return await h.ApproveGuest(owner, guest);
    }
    public static async Task PrivateProjectionAndSeatIsolation()
    {
        var model = new Model((i, _) => i switch
        {
            1 => Tool("context_read"), 2 => Tool("skills_list"), 3 => Tool("skills_read", new { id = "test-skill" }),
            _ => Tool("ask_player", new { question = "请补充公开目标。" })
        });
        await using var h = await Host.Start(configure: Configure(model));
        var owner = await Create(h, TestContent.Document with { SourceText = "SOURCE_SENTINEL", InitialKnowledge =
        [new("private", "clue", "Private", "PRIVATE_SENTINEL", "", "host"),
            new("future", "clue", "Future", "FUTURE_SENTINEL", "causeway", "arrival", "causeway")] });
        var guest = await Guest(h, owner); var id = owner.Snapshot.Id;
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        var s = (await h.Get(id))!;
        var run = await Start(h, s, "PRIVATE_INPUT_TO_OWNER"); run = await Settled(h, id, run.Id);
        Check.Equal("waiting", run.Status); Check.Equal("player", run.Wait!.Kind);
        Check.True(!HarnessJson.Serialize(model.Requests).Contains("SENTINEL"));
        Check.True(HarnessJson.Serialize(model.Requests).Contains("test-skill"));
        string path = $"/api/v1/campaigns/{id}/harness/runs/{run.Id}";
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
        Check.Equal(HttpStatusCode.NotFound, (await h.Http.GetAsync(path)).StatusCode);
        Check.Equal(HttpStatusCode.NotFound, (await h.Http.PostAsync(path + "/cancel", null)).StatusCode);
        Check.Equal(HttpStatusCode.NotFound, (await h.Http.PostAsJsonAsync(path + "/resume", new HarnessResumeRequest(Id(), run.Version, "答复"))).StatusCode);
        Check.True(!HarnessJson.Serialize(await h.Get(id)).Contains("PRIVATE_INPUT_TO_OWNER"));
        var foreign = await Create(h); Check.Equal(HttpStatusCode.Unauthorized, (await h.Http.GetAsync(path)).StatusCode);
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        var resumed = new HarnessResumeRequest(Id(), run.Version, "在港口交谈");
        await Post<HarnessRunView>(h, id, $"harness/runs/{run.Id}/resume", resumed);
        run = await Settled(h, id, run.Id); Check.Equal("waiting", run.Status); Check.Equal(5, model.Calls);
        Check.True((await Post<HarnessRunView>(h, id, $"harness/runs/{run.Id}/resume", resumed)).Replayed);
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync(path + "/resume", resumed with { Text = "替换答复" })).StatusCode);
        foreach (string file in Directory.GetFiles(Path.Combine(h.Root, "harness"), "*.json", SearchOption.AllDirectories))
        {
            string raw = File.ReadAllText(file);
            Check.True(!raw.Contains(owner.AccessToken) && !raw.Contains(guest.AccessToken) && !raw.Contains(foreign.AccessToken));
        }
    }
    public static async Task SameRequestIdAcrossSeatsAndRevocation()
    {
        var model = new Model((_, r) => r.Messages.Any(m => m.Role == "tool") ? Tool("ask_player", new { question = "继续吗？" }) :
            Tool("world_record", new NarrativeHarnessArgs("公开且无机械变化的回应。", [], Complete: false)));
        await using var h = await Host.Start(configure: Configure(model)); var owner = await Create(h); var guest = await Guest(h, owner);
        string same = Id(), id = owner.Snapshot.Id;
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        var s = (await h.Get(id))!;
        var first = await Post<HarnessRunView>(h, id, "harness/runs", new HarnessInputRequest(same, s.Version, "主持席位的行动"));
        await Settled(h, id, first.Id);
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
        s = (await h.Get(id))!;
        var second = await Post<HarnessRunView>(h, id, "harness/runs", new HarnessInputRequest(same, s.Version, "队员席位的行动"));
        var result = await Settled(h, id, second.Id); Check.Equal("waiting", result.Status);
        var store = h.App.Services.GetRequiredService<HarnessRunStore>();
        var hostRun = store.Read(id, PartyEngine.HostId, same)!;
        var guestRun = store.Read(id, guest.Snapshot.Party!.SelfActorId, same)!;
        Check.True(hostRun.IntentId != guestRun.IntentId);
        Check.Equal(2, (await h.Http.GetFromJsonAsync<ActivityPage>($"/api/v1/campaigns/{id}/activity"))!.Entries.Length);
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken); s = (await h.Get(id))!;
        await Post<ActionResponse>(h, id, "seats/revoke", new RevokeSeatRequest(Id(), s.Version, guest.Snapshot.Party.SelfActorId));
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
        Check.Equal(HttpStatusCode.Unauthorized, (await h.Http.GetAsync($"/api/v1/campaigns/{id}/harness/runs/{same}")).StatusCode);
        Check.Equal(HttpStatusCode.Unauthorized, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/harness/runs/{same}/resume", new HarnessResumeRequest(Id(), result.Version, "继续"))).StatusCode);
    }
    public static async Task StaleVersionAndMultiToolStop()
    {
        var dice = new SequenceDice();
        var model = new Model((i, r) => i == 1 ? Tool("context_read") : new HarnessModelReply("",
        [new("proposal", "actions_propose", HarnessJson.Element(new { candidateId = Candidate(r, TestContent.Document.Scenes.Single(s => s.Id == "harbor").Actions.Single(a => a.Kind == "investigate").Label) })),
            new("blocked", "world_record", HarnessJson.Element(new NarrativeHarnessArgs("不能抢跑。", [new("", "clue", "不能出现", "不能出现", "known", "")])))] , 10, 10));
        await using var h = await Host.Start(dice: dice, configure: Configure(model)); var owner = await Create(h); var id = owner.Snapshot.Id;
        var run = await Start(h, owner.Snapshot); run = await Settled(h, id, run.Id);
        Check.Equal("waiting", run.Status); Check.Equal(2, run.ToolSteps); Check.Equal(0, dice.Count);
        var s = (await h.Get(id))!; Check.True(!s.WorldMemory!.Any(m => m.Name == "不能出现"));
        s = (await Post<ActionResponse>(h, id, "rolls/respond", new RollResponseRequest(Id(), s.Version, run.Wait!.Id, "roll"))).Snapshot;
        Check.Equal(1, dice.Count);
        // A later unrelated action must not be hidden by refreshing the expected version.
        s = (await h.Act(s, "observe")).Snapshot;
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/harness/runs/{run.Id}/resume", new HarnessResumeRequest(Id(), s.Version))).StatusCode);
        Check.Equal(2, model.Calls); Check.Equal(1, dice.Count);
    }
    private sealed class FailAfterTool : IHarnessRuntime
    {
        public async Task<HarnessCompletion> Execute(HarnessExecution e, Func<HarnessCallback, CancellationToken, Task<JsonElement>> callback, CancellationToken ct)
        {
            var reply = HarnessJson.Read<HarnessModelReply>(await callback(new("0:model:0", "model", 0, 0,
                HarnessJson.Element(new HarnessModelRequest(e.SystemPrompt, [new("user", e.Turns[0])], e.Tools, 4096))), ct));
            var tool = reply.ToolCalls.Single();
            await callback(new("0:tool:0", "tool", 0, 0, HarnessJson.Element(new HarnessToolRequest(tool.Name, tool.Arguments, tool.Id))), ct);
            throw new IOException("simulated child disconnect");
        }
    }
    public static async Task CommittedReceiptCrashRecovery()
    {
        var model = new Model((i, _) => i == 1 ? Tool("world_record", new NarrativeHarnessArgs("首次叙事。", [new("", "clue", "只保存一次", "原回执", "known", "harbor")])) : Text());
        var h = await Host.Start(configure: Configure(model, new FailAfterTool())); var owner = await Create(h); string id = owner.Snapshot.Id;
        var run = await Start(h, owner.Snapshot); run = await Settled(h, id, run.Id);
        Check.Equal("interrupted", run.Status); Check.Equal(1, model.Calls);
        var saved = h.App.Services.GetRequiredService<HarnessRunStore>().Read(id, PartyEngine.HostId, run.Id)!;
        var step = saved.Steps.Single(s => s.Kind == "tool");
        Check.True(step.Outcome is not null); int committedVersion = step.Outcome!.Version;
        string committedOutput = step.Result!.Value.GetRawText();
        // Exact crash window: campaign transaction committed, run journal still has started tool.
        step.Status = "started"; step.Result = null; step.Outcome = null;
        saved.Status = "running"; saved.Error = ""; saved.Version = owner.Snapshot.Version;
        h.App.Services.GetRequiredService<HarnessRunStore>().Save(saved);
        var root = h.Root; await h.DisposeAsync();
        h = await Host.Start(root, configure: Configure(model)); h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        run = await Settled(h, id, run.Id); Check.Equal("interrupted", run.Status); Check.Equal(1, model.Calls);
        await Post<HarnessRunView>(h, id, $"harness/runs/{run.Id}/resume", new HarnessResumeRequest(Id(), committedVersion));
        run = await Settled(h, id, run.Id); Check.Equal("completed", run.Status); Check.Equal(1, model.Calls);
        saved = h.App.Services.GetRequiredService<HarnessRunStore>().Read(id, PartyEngine.HostId, run.Id)!;
        Check.Equal(HarnessJson.Fingerprint(JsonDocument.Parse(committedOutput).RootElement), HarnessJson.Fingerprint(saved.Steps.Single(s => s.Kind == "tool").Result!.Value));
        var s = (await h.Get(id))!; Check.Equal(1, s.WorldMemory!.Count(m => m.Name == "只保存一次")); Check.Equal(1, s.WorldMemory!.Single().Revision);
        Check.Equal(committedVersion, s.Version); Check.Equal("首次叙事。", run.Text); await h.DisposeAsync();
    }
    public static async Task ClosedRunsKeepReplayWithoutLifetimeCap()
    {
        var model = new Model((_, _) => Tool("ask_player", new { question = "目标？" }));
        await using var h = await Host.Start(configure: Configure(model)); var owner = await Create(h); string id = owner.Snapshot.Id;
        var first = new HarnessInputRequest(Id(), owner.Snapshot.Version, "第一次输入");
        for (int i = 0; i < 66; i++)
        {
            var input = i == 0 ? first : new HarnessInputRequest(Id(), owner.Snapshot.Version, "第 " + i + " 次输入");
            var run = await Post<HarnessRunView>(h, id, "harness/runs", input); await Settled(h, id, run.Id);
            var response = await h.Http.PostAsync($"/api/v1/campaigns/{id}/harness/runs/{run.Id}/cancel", null);
            Check.Equal(HttpStatusCode.OK, response.StatusCode);
        }
        Check.Equal(66, model.Calls);
        var replay = await Post<HarnessRunView>(h, id, "harness/runs", first);
        Check.True(replay.Replayed); Check.Equal("cancelled", replay.Status); Check.Equal(66, model.Calls);
        var recased = await Post<HarnessRunView>(h, id.ToUpperInvariant(), "harness/runs", first with { RequestId = first.RequestId.ToUpperInvariant() });
        Check.True(recased.Replayed); Check.Equal(first.RequestId, recased.Id);
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/harness/runs",
            first with { RequestId = first.RequestId.ToUpperInvariant(), Text = "不是同一正文" })).StatusCode);
        var fetched = (await h.Http.GetFromJsonAsync<HarnessRunView>($"/api/v1/campaigns/{id.ToUpperInvariant()}/harness/runs/{first.RequestId.ToUpperInvariant()}"))!;
        Check.Equal("cancelled", fetched.Status); Check.Equal(66, model.Calls);
        Check.Equal(0, h.App.Services.GetRequiredService<HarnessRunStore>().ListActive(id, PartyEngine.HostId).Length);
        Check.Equal(66, Directory.GetFiles(Path.Combine(h.Root, "harness"), "*.json", SearchOption.AllDirectories).Length);
    }
    public static async Task CancellingGenerationDisclosesOutstandingConsent()
    {
        var dice = new SequenceDice(); var model = AdventureModel();
        await using var h = await Host.Start(dice: dice, configure: Configure(model)); var owner = await Create(h); string id = owner.Snapshot.Id;
        var run = await Start(h, owner.Snapshot); run = await Settled(h, id, run.Id);
        var response = await h.Http.PostAsync($"/api/v1/campaigns/{id}/harness/runs/{run.Id}/cancel", null);
        var cancelled = (await response.Content.ReadFromJsonAsync<HarnessRunView>())!;
        Check.Equal("cancelled", cancelled.Status); Check.True(cancelled.Notice.Contains("rolls/respond") && cancelled.Notice.Contains("decision=cancel"));
        Check.Equal(run.Wait!.Id, cancelled.Wait!.Id);
        var s = (await h.Get(id))!; Check.Equal(run.Wait.Id, s.PendingRoll!.Id); Check.Equal(0, dice.Count);
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/harness/runs", new HarnessInputRequest(Id(), s.Version, "新行动"))).StatusCode);
        s = (await Post<ActionResponse>(h, id, "rolls/respond", new RollResponseRequest(Id(), s.Version, run.Wait.Id, "cancel"))).Snapshot;
        Check.True(s.PendingRoll is null); Check.Equal(0, dice.Count); Check.Equal(2, model.Calls);
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/harness/runs/{run.Id}/resume", new HarnessResumeRequest(Id(), s.Version))).StatusCode);
    }
    public static async Task StrictArgumentsAndCorruptJournal()
    {
        foreach (object bad in new object[] { new { narrative = "不应保存", memory = new object[] { new { id = "", kind = "clue", name = "x", summary = "s", status = "known", sceneId = "", hp = 999 } } },
            new { narrative = "不应保存", memory = new[] { new WorldMemoryProposal("", "clue", "bad location", "s", "known", "not-public") } } })
        {
            var model = new Model((_, _) => Tool("world_record", bad));
            await using var h = await Host.Start(configure: Configure(model)); var owner = await Create(h);
            var run = await Start(h, owner.Snapshot); run = await Settled(h, owner.Snapshot.Id, run.Id);
            Check.Equal("failed", run.Status); Check.Equal(owner.Snapshot.Version, (await h.Get(owner.Snapshot.Id))!.Version);
            Check.Equal(0, (await h.Get(owner.Snapshot.Id))!.WorldMemory!.Length);
        }
        var waiting = new Model((_, _) => Tool("ask_player", new { question = "目标？" }));
        await using var host = await Host.Start(configure: Configure(waiting)); var created = await Create(host);
        var pending = await Start(host, created.Snapshot); await Settled(host, created.Snapshot.Id, pending.Id);
        string path = Directory.GetFiles(Path.Combine(host.Root, "harness"), pending.Id + ".json", SearchOption.AllDirectories).Single();
        string invalid = File.ReadAllText(path).Replace("\"schemaVersion\": 1", "\"schemaVersion\": 99"); File.WriteAllText(path, invalid);
        Check.Equal(HttpStatusCode.Conflict, (await host.Http.GetAsync($"/api/v1/campaigns/{created.Snapshot.Id}/harness/runs/{pending.Id}")).StatusCode);
        Check.Equal(invalid, File.ReadAllText(path)); Check.Equal(1, waiting.Calls);
    }
}
