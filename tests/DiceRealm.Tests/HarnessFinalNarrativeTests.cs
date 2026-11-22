using System.Net.Http.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class HarnessFinalNarrativeTests
{
    private const string FinalText = "“急，但你只有一个人也是实情。你打算去哪儿找帮手？”";

    public static async Task RealPiFinalStopsBatchAndSavesOnce()
    {
        var model = new Model((call, _) =>
        {
            Check.Equal(1, call);
            return new("", [
                new("read-first", "context_read", HarnessJson.Element(new { scope = "items", query = "rpoe" })),
                new("finish", "world_record", HarnessJson.Element(new NarrativeHarnessArgs(FinalText, [], Private: "本人看到的小记号。"))),
                new("must-not-run", "ask_player", HarnessJson.Element(new QuestionHarnessArgs("这条不应执行。")))
            ], 10, 10);
        });
        var dice = new SequenceDice();
        var h = await Host.Start(dice: dice, configure: Configure(model, extra: b =>
        {
            b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry();
            b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>();
        }));
        try
        {
            var owner = await Create(h);
            var request = new HarnessInputRequest(Id(), owner.Snapshot.Version, "我想明早再出发");
            var run = await Settled(h, owner.Snapshot.Id,
                (await Post<HarnessRunView>(h, owner.Snapshot.Id, "harness/runs", request)).Id, 3000);
            Check.True(run.Status == "completed", run.Status + "/" + run.Error);
            Check.Equal(FinalText, run.Text);
            Check.True(run.Wait is null);
            Check.Equal(1, model.Calls);
            Check.Equal(0, dice.Count);
            Check.Equal(request.ExpectedVersion + 1, run.Version);
            var store = h.App.Services.GetRequiredService<HarnessRunStore>();
            var saved = store.Read(owner.Snapshot.Id, PartyEngine.HostId, run.Id)!;
            Check.Equal(3, saved.Steps.Count);
            Check.Equal("context_read", saved.Steps[1].ToolName);
            Check.True(!saved.Steps[1].Outcome!.Reply.Stop);
            Check.True(saved.Steps.All(step => step.Kind != "final" && step.ToolName != "ask_player"));
            Check.Equal(FinalText, saved.Steps.Last().Outcome!.CompletedNarrative);
            var page = (await h.Http.GetFromJsonAsync<ActivityPage>($"/api/v1/campaigns/{owner.Snapshot.Id}/activity"))!;
            Check.Equal(1, page.Entries.Length);
            Check.Equal(FinalText, page.Entries[0].Narrative);
            Check.Equal("本人看到的小记号。", page.Entries[0].PrivateText);
            string original = HarnessJson.Serialize(saved);
            string root = h.Root;
            await h.DisposeAsync();
            h = await Host.Start(root, dice: dice, configure: Configure(model, extra: b => b.Configuration["Harness:Enabled"] = "false"));
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var replay = await Post<HarnessRunView>(h, owner.Snapshot.Id, "harness/runs", request);
            Check.True(replay.Replayed);
            Check.Equal(FinalText, replay.Text);
            Check.Equal(1, model.Calls);
            Check.Equal(original, HarnessJson.Serialize(h.App.Services.GetRequiredService<HarnessRunStore>().Read(owner.Snapshot.Id, PartyEngine.HostId, run.Id)!));
        }
        finally { await h.DisposeAsync(); }
    }

    public static async Task IntermediateRecordContinuesWithoutFinalDuplicate()
    {
        var model = new Model((call, request) => call switch
        {
            1 => Tool("world_record", new NarrativeHarnessArgs("莫娜听完了你的计划。", [], Complete: false)),
            2 => Tool("actions_propose", new { candidateId = HarnessExecutionProtocolTests.Choice(request, "观察") }),
            3 => Tool("world_record", new NarrativeHarnessArgs(FinalText, [], Complete: true)),
            _ => throw new Exception("A saved final narrative must not require another model call")
        });
        await using var h = await Host.Start(configure: Configure(model));
        var owner = await Create(h);
        var run = await Settled(h, owner.Snapshot.Id, (await Start(h, owner.Snapshot, "听她说完再观察四周")).Id);
        Check.True(run.Status == "completed", run.Status + "/" + run.Error);
        Check.Equal(3, model.Calls);
        Check.Equal(FinalText, run.Text);
        var saved = h.App.Services.GetRequiredService<HarnessRunStore>().Read(owner.Snapshot.Id, PartyEngine.HostId, run.Id)!;
        var records = saved.Steps.Where(s => s.ToolName == "world_record").ToArray();
        Check.Equal(2, records.Length);
        Check.True(!records[0].Outcome!.Reply.Stop && records[0].Outcome!.CompletedNarrative is null);
        Check.True(records[1].Outcome!.Reply.Stop && records[1].Outcome!.CompletedNarrative == FinalText);
        Check.True(saved.Steps.All(s => s.Kind != "final"));
        Check.Equal(1, (await h.Get(owner.Snapshot.Id))!.Events.Count(e => e.Kind == "observe"));
    }

    public static async Task DoneToolRecoversAfterLaterGameChangesWithProviderDisabled()
    {
        var model = new Model((_, _) => Tool("world_record", new NarrativeHarnessArgs(FinalText, [])));
        var h = await Host.Start(configure: Configure(model));
        try
        {
            var owner = await Create(h);
            var run = await Settled(h, owner.Snapshot.Id, (await Start(h, owner.Snapshot)).Id);
            Check.Equal("completed", run.Status);
            var store = h.App.Services.GetRequiredService<HarnessRunStore>();
            var saved = store.Read(owner.Snapshot.Id, PartyEngine.HostId, run.Id)!;
            saved.Status = "running"; saved.Text = ""; saved.ExecutionStartedAt = null;
            store.Save(saved); // done tool persisted; terminal journal marker was lost
            var advanced = (await h.Act((await h.Get(owner.Snapshot.Id))!, "observe")).Snapshot;
            Check.True(advanced.Version > run.Version);
            string root = h.Root; await h.DisposeAsync();
            h = await Host.Start(root, configure: Configure(model, extra: b => b.Configuration["Harness:Enabled"] = "false"));
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var resume = new HarnessResumeRequest(Id(), advanced.Version);
            var recovered = await Post<HarnessRunView>(h, owner.Snapshot.Id, $"harness/runs/{run.Id}/resume", resume);
            Check.Equal("completed", recovered.Status); Check.Equal(FinalText, recovered.Text);
            Check.Equal(run.Version, recovered.Version); Check.Equal(1, model.Calls);
            Check.Equal(advanced.Version, (await h.Get(owner.Snapshot.Id))!.Version);
            Check.True((await Post<HarnessRunView>(h, owner.Snapshot.Id, $"harness/runs/{run.Id}/resume", resume)).Replayed);
            Check.Equal(HarnessJson.Serialize(saved.Steps), HarnessJson.Serialize(h.App.Services.GetRequiredService<HarnessRunStore>().Read(owner.Snapshot.Id, PartyEngine.HostId, run.Id)!.Steps));
        }
        finally { await h.DisposeAsync(); }
    }

    public static async Task AcceptedCompletionSurvivesLostToolJournal()
    {
        var model = new Model((call, _) =>
        {
            Check.Equal(1, call);
            return Tool("world_record", new NarrativeHarnessArgs(FinalText, []));
        });
        var configure = Configure(model);
        var h = await Host.Start(configure: configure);
        try
        {
            var owner = await Create(h);
            var request = new HarnessInputRequest(Id(), owner.Snapshot.Version, "询问莫娜");
            var run = await Settled(h, owner.Snapshot.Id,
                (await Post<HarnessRunView>(h, owner.Snapshot.Id, "harness/runs", request)).Id);
            Check.Equal("completed", run.Status);
            var store = h.App.Services.GetRequiredService<HarnessRunStore>();
            var saved = store.Read(owner.Snapshot.Id, PartyEngine.HostId, run.Id)!;
            int acceptedVersion = run.Version;
            // Simulate the actual window: game transaction/receipt committed, but the
            // corresponding run tool slot is still started and the process exited.
            var tool = saved.Steps.Last();
            tool.Status = "started";
            tool.Result = null;
            tool.Outcome = null;
            saved.Status = "running";
            saved.Version = request.ExpectedVersion;
            saved.Text = "";
            saved.ExecutionStartedAt = null;
            store.Save(saved);
            string root = h.Root;
            await h.DisposeAsync();
            h = await Host.Start(root, configure: configure);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            Check.Equal("interrupted", (await Settled(h, owner.Snapshot.Id, run.Id)).Status);
            await Post<HarnessRunView>(h, owner.Snapshot.Id, $"harness/runs/{run.Id}/resume", new HarnessResumeRequest(Id(), acceptedVersion));
            var recovered = await Settled(h, owner.Snapshot.Id, run.Id);
            Check.True(recovered.Status == "completed", recovered.Status + "/" + recovered.Error);
            Check.Equal(FinalText, recovered.Text);
            Check.Equal(acceptedVersion, recovered.Version);
            Check.Equal(1, model.Calls);
            Check.Equal(acceptedVersion, (await h.Get(owner.Snapshot.Id))!.Version);
            var journal = h.App.Services.GetRequiredService<HarnessRunStore>().Read(owner.Snapshot.Id, PartyEngine.HostId, run.Id)!;
            Check.True(journal.Steps.All(s => s.Kind != "final"));
            Check.Equal(FinalText, journal.Steps.Last().Outcome!.CompletedNarrative);
        }
        finally { await h.DisposeAsync(); }
    }
}
