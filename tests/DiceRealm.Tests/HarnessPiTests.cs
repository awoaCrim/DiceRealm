using System.Net.Http.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class HarnessPiTests
{
    internal static string Entry()
    {
        if (Environment.GetEnvironmentVariable("DICEREALM_TEST_AGENT_HOST_PATH") is { Length: > 0 } isolated)
        {
            if (!Path.IsPathFullyQualified(isolated) || !File.Exists(isolated))
                throw new InvalidOperationException("The explicit isolated agent-host test entry is missing.");
            return isolated;
        }
        for (var root = new DirectoryInfo(Directory.GetCurrentDirectory()); root is not null; root = root.Parent)
        {
            var entry = Path.Combine(root.FullName, "agent-host", "dist", "main.js");
            if (File.Exists(entry)) return entry;
        }
        throw new InvalidOperationException("Build the real runtime first: npm --prefix agent-host ci --ignore-scripts && npm --prefix agent-host run build");
    }
    public static async Task RealSdkMcpConsentRecovery()
    {
        var dice = new SequenceDice(18); var model = AdventureModel();
        var configure = Configure(model, extra: b =>
        {
            b.Configuration["Harness:AgentHostPath"] = Entry();
            b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>();
        });
        var h = await Host.Start(dice: dice, configure: configure); bool disposed = false;
        try
        {
            // Startup prepares one reusable real Node/Pi worker without an input or model call.
            var runtime = (PiHarnessRuntime)h.App.Services.GetRequiredService<IHarnessRuntime>();
            System.Diagnostics.Process[] Processes() => ((Array)typeof(PiHarnessRuntime).GetField("workers", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!.GetValue(runtime)!)
                .Cast<object>().Select(w => w.GetType().GetField("process", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!.GetValue(w))
                .OfType<System.Diagnostics.Process>().Where(p => !p.HasExited).ToArray();
            int preparedPid = Processes().Single().Id;
            await runtime.Prepare(default); Check.Equal(preparedPid, Processes().Single().Id);
            Check.Equal(0, model.Calls); Check.Equal(0, dice.Count);
            var stoppedWorker = Processes().Single(); stoppedWorker.Kill(entireProcessTree: true); await stoppedWorker.WaitForExitAsync();
            await runtime.Prepare(default); Check.True(Processes().Single().Id != preparedPid);
            preparedPid = Processes().Single().Id;
            Check.Equal(0, model.Calls);
            var owner = await Create(h); string id = owner.Snapshot.Id;
            // Real SDK cold imports may exceed the fake-loop 12s poll window on Windows.
            // Keep the product 120s runtime deadline; only this process fixture gets a 90s wait.
            var run = await Start(h, owner.Snapshot); run = await Settled(h, id, run.Id, maximumPolls: 3000);
            Check.True(run.Status == "waiting", "Real Pi failed: " + run.Status + "/" + run.Error); Check.Equal("roll", run.Wait!.Kind); Check.Equal(0, dice.Count); Check.Equal(2, model.Calls);
            Check.Equal(preparedPid, Processes().Single().Id); // first gameplay reuses the prepared worker
            var s = (await h.Get(id))!;
            Check.True(s.PendingRoll!.Preview is { HasDc: true });
            var roll = await Post<ActionResponse>(h, id, "rolls/respond", new RollResponseRequest(Id(), s.Version, run.Wait.Id, "roll"));
            Check.Equal(1, dice.Count); Check.Equal(s.PendingRoll!.Preview!.Dc, roll.Resolution.Check!.Dc);
            var root = h.Root; await h.DisposeAsync(); disposed = true; // kills only our managed child; no process or paid model survives
            h = await Host.Start(root, dice, configure: configure); disposed = false; h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            Check.Equal(2, model.Calls);
            var restored = (await h.Http.GetFromJsonAsync<HarnessActiveRuns>($"/api/v1/campaigns/{id}/harness/runs/active"))!.Runs.Single();
            Check.Equal(run.Id, restored.Id);
            Check.True(run.Progress!.SequenceEqual(restored.Progress!));
            Check.Equal(run.Binding!.ProfileHash, restored.Binding!.ProfileHash);
            Check.True(restored.Progress!.Any(step => step.Tool == "actions_propose" && step.WaitKind == "roll"));
            Check.Equal(2, model.Calls); // discovery after reopening the host/Node is read-only
            await Post<HarnessRunView>(h, id, $"harness/runs/{run.Id}/resume", new HarnessResumeRequest(Id(), roll.Snapshot.Version));
            run = await Settled(h, id, run.Id, maximumPolls: 3000);
            Check.Equal("completed", run.Status); Check.Equal(4, model.Calls); Check.Equal(1, dice.Count);
            Check.True(model.Requests.All(r => r.System == Preset.SystemPrompt));
            Check.True(model.Requests.All(r => r.Tools.All(t => t.Name is not ("bash" or "read" or "write" or "edit"))));
            Check.True(model.Requests.Last().Messages.Any(m => m.Role == "tool" && m.Name == "checks_result" && m.Content.Contains("selected")));
            Check.Equal(1, (await h.Get(id))!.WorldMemory!.Count(m => m.Name == "Harness 回归线索"));
            var activity = (await h.Http.GetFromJsonAsync<ActivityPage>($"/api/v1/campaigns/{id}/activity"))!.Entries.Single();
            Check.Equal(roll.Resolution.Check!.Total, activity.InitialResult!.Check!.Total); Check.Equal(run.Text, activity.Narrative);
        }
        finally { if (!disposed) await h.DisposeAsync(); }
    }
}
