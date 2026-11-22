using DiceRealm.Server.Application;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

// Fixed model decisions exercise the real UI/HTTP/confirmation path without a paid provider.
// They establish plumbing and presentation, not free-language judgment quality.
internal static class NarrativeCheckBrowserFixture
{
    public static async Task Run(string statePath)
    {
        statePath = Path.GetFullPath(statePath);
        if (File.Exists(statePath) || File.Exists(statePath + ".stop")) throw new InvalidOperationException("Use a fresh fixture path.");
        var dice = new SequenceDice(18, 13);
        var model = new Model((_, request) =>
        {
            bool saving = HarnessExecutionProtocolTests.Frame(request).GetProperty("context").GetProperty("intent").GetProperty("text").GetString()!.Contains("门");
            if (!request.Messages.Any(m => m.Role == "tool" && m.Name == "check_request"))
                return Tool("check_request", saving
                    ? NarrativeCheckTests.Proposed("save", "strength", "", 12, "门框碎石松脱，本场以DC12力量豁免处理。")
                    : NarrativeCheckTests.Proposed());
            return Tool("world_record", new NarrativeHarnessArgs(saving
                ? "Arden稳住身形，松落的石块擦着脚边落地。"
                : "Arden踏稳湿滑的石阶，继续向前。", []));
        });
        await using var h = await Host.Start(dice: dice, configure: Configure(model, extra: b =>
        {
            b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry();
            b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>();
        }));
        AccountTests.SeedAdminFixture(h);
        var owner = await Create(h, NarrativeCheckTests.Document);
        var run = await Start(h, owner.Snapshot, "我沿着台阶继续向前。");
        run = await Settled(h, owner.Snapshot.Id, run.Id, 3000);
        Check.Equal("waiting", run.Status);
        // Private connection file lets an isolated QA Player use the real HTTP flow.
        JsonFiles.Write(statePath + ".player-session", new { baseUrl = h.Http.BaseAddress!.GetLeftPart(UriPartial.Authority),
            campaignId = owner.Snapshot.Id, accessToken = owner.AccessToken });
        JsonFiles.Write(statePath, new { baseUrl = h.Http.BaseAddress!.GetLeftPart(UriPartial.Authority), dataPath = h.Root,
            processId = Environment.ProcessId, campaignId = owner.Snapshot.Id, fixture = "narrative-checks-fixed-decisions-no-provider" });
        while (!File.Exists(statePath + ".stop"))
        {
            foreach (string operation in new[] { "confirm-ability", "start-save", "confirm-save" })
            {
                string control = statePath + "." + operation;
                if (!File.Exists(control) || File.Exists(control + ".done")) continue;
                var current = (await h.Get(owner.Snapshot.Id))!;
                if (operation == "start-save")
                    run = await Start(h, current, "我推开面前的门。");
                else
                {
                    var rolled = await Post<DiceRealm.Server.Domain.ActionResponse>(h, current.Id, "rolls/respond",
                        new DiceRealm.Server.Domain.RollResponseRequest(Id(), current.Version, current.PendingRoll!.Id, "roll"));
                    await Post<HarnessRunView>(h, current.Id, $"harness/runs/{run.Id}/resume", new HarnessResumeRequest(Id(), rolled.Snapshot.Version));
                }
                run = await Settled(h, current.Id, run.Id, 3000);
                Check.Equal(operation == "start-save" ? "waiting" : "completed", run.Status);
                File.WriteAllText(control + ".done", "applied");
            }
            JsonFiles.Write(statePath + ".stats", new { dice = dice.Count, modelCalls = model.Calls, paidProviderCalls = 0 });
            await Task.Delay(250);
        }
        var snapshot = (await h.Get(owner.Snapshot.Id))!;
        JsonFiles.Write(statePath + ".result", new { dice = dice.Count, modelCalls = model.Calls, paidProviderCalls = 0,
            snapshot.Version, pendingRoll = snapshot.PendingRoll is not null, rulings = snapshot.PendingRulings.Length });
    }
}
