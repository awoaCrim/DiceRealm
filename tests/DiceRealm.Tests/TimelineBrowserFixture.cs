using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

// Opt-in real HTTP/Pi fixture with deterministic decisions and dice; no paid provider.
internal static class TimelineBrowserFixture
{
    public static async Task Run(string statePath)
    {
        statePath = Path.GetFullPath(statePath);
        if (File.Exists(statePath) || File.Exists(statePath + ".stop")) throw new InvalidOperationException("Use a fresh fixture path.");
        var dice = new SequenceDice(18);
        var model = new Model(async (_, request, ct) =>
        {
            var tools = request.Messages.Where(m => m.Role == "tool").ToArray();
            bool running = HarnessExecutionProtocolTests.Frame(request).GetProperty("context").GetProperty("intent").GetProperty("text").GetString()!.Contains("海面");
            if (!tools.Any(m => m.Name == "dm_reference")) return Tool("dm_reference", new { topic = "objects" });
            if (running)
            {
                while (!File.Exists(statePath + ".release")) await Task.Delay(100, ct);
                return Tool("world_record", new NarrativeHarnessArgs("海雾渐渐散去，旧灯塔的轮廓重新出现在航道尽头。", []));
            }
            if (!tools.Any(m => m.Name == "check_request")) return Tool("check_request", NarrativeCheckTests.Proposed());
            if (!tools.Any(m => m.Name == "checks_result")) return Tool("checks_result", new { scope = "current" });
            if (!tools.Any(m => m.Name == "world_record")) return Tool("world_record", new NarrativeHarnessArgs("尚未保存的错误尝试。",
                [new("npc:invented-id", "npc", "守港人", "提案没有可更新的公开 ID。", "known", "harbor")]));
            return Tool("world_record", new NarrativeHarnessArgs("你踏稳湿滑的石阶，跨过缺口，来到门前。守港人从屋檐下向你点了点头。\n\n“雨快停了。”他说。",
                [new("", "npc", "守港人", "站在码头门前，提醒你雨快停了。", "known", "harbor")]));
        });
        await using var h = await Host.Start(dice: dice, configure: Configure(model, extra: b =>
        {
            b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry();
            b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>();
        }));
        AccountTests.SeedAdminFixture(h);
        var owner = await Create(h, NarrativeCheckTests.Document);
        var completed = await Start(h, owner.Snapshot, "我沿着湿滑石阶跨过缺口，去门前找守港人。");
        completed = await Settled(h, owner.Snapshot.Id, completed.Id, 3000); Check.Equal("waiting", completed.Status);
        var snapshot = (await h.Get(owner.Snapshot.Id))!;
        var rolled = await Post<ActionResponse>(h, snapshot.Id, "rolls/respond", new RollResponseRequest(Id(), snapshot.Version, snapshot.PendingRoll!.Id, "roll"));
        await Post<HarnessRunView>(h, snapshot.Id, $"harness/runs/{completed.Id}/resume", new HarnessResumeRequest(Id(), rolled.Snapshot.Version));
        completed = await Settled(h, snapshot.Id, completed.Id, 3000); Check.True(completed.Status == "completed", completed.Status + "/" + completed.Error);
        var saved = h.App.Services.GetRequiredService<HarnessRunStore>().Read(snapshot.Id, PartyEngine.HostId, completed.Id)!;
        Check.Equal(1, dice.Count);
        Check.Equal(2, saved.Steps.Count(s => s.ToolName == "world_record"));
        JsonFiles.Write(statePath, new { baseUrl = h.Http.BaseAddress!.GetLeftPart(UriPartial.Authority), dataPath = h.Root,
            campaignId = snapshot.Id, completedRun = completed.Id, processId = Environment.ProcessId, fixture = "real-pi-fixed-model-timeline" });
        HarnessRunView? running = null;
        while (!File.Exists(statePath + ".stop"))
        {
            if (File.Exists(statePath + ".start") && running is null)
            {
                snapshot = (await h.Get(snapshot.Id))!;
                running = await Start(h, snapshot, "我继续望向海面。");
                JsonFiles.Write(statePath + ".running", new { runId = running.Id });
            }
            JsonFiles.Write(statePath + ".stats", new { dice = dice.Count, modelCalls = model.Calls, paidProviderCalls = 0 });
            await Task.Delay(100);
        }
        JsonFiles.Write(statePath + ".result", new { dice = dice.Count, modelCalls = model.Calls, paidProviderCalls = 0 });
    }
}
