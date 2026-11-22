using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Reflection;
using DiceRealm.Server.Application;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class HarnessPiIsolationTests
{
    // A real managed child is terminated only after this fixture's model callback entered.
    // The provider deliberately ignores cancellation; the coordinator must still stop awaiting it.
    public static async Task ProcessExitReleasesQueueWithoutReplayingUnknown()
    {
        const string privateInput = "OWNER_PRIVATE_UNFINISHED_INPUT";
        const string lateNarrative = "LATE_PROVIDER_RESULT_MUST_NOT_COMMIT";
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var cancelled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var lateReturned = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var model = new Model(async (number, _, token) =>
        {
            if (number == 1)
            {
                using var registration = token.Register(() => cancelled.TrySetResult());
                entered.TrySetResult();
                await release.Task; // Explicitly simulate a supplier that does not honor cancellation.
                lateReturned.TrySetResult();
                return Text(lateNarrative);
            }
            if (number == 3) throw new HttpRequestException("PRIVATE_PROVIDER_FAILURE_BODY");
            return Text(number == 2 ? "本席位的独立行动已完成。" : "前次供应商失败没有污染本次行动。");
        });
        var dice = new SequenceDice(18);
        var configure = Configure(model, extra: builder =>
        {
            builder.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry();
            builder.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>();
        });
        string root, campaign, ownerToken;
        HarnessInputRequest original;
        await using (var host = await Host.Start(dice: dice, configure: configure))
        {
            var owner = await Create(host);
            var guest = await HarnessBoundaryTests.Guest(host, owner);
            root = host.Root; campaign = owner.Snapshot.Id; ownerToken = owner.AccessToken;
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", ownerToken);
            var current = (await host.Get(campaign))!;
            original = new(Id(), current.Version, privateInput);
            var first = await Post<HarnessRunView>(host, campaign, "harness/runs", original);
            try
            {
                await entered.Task.WaitAsync(TimeSpan.FromSeconds(90)); // Real SDK cold import budget, not a product timeout change.
                var runtime = (PiHarnessRuntime)host.App.Services.GetRequiredService<IHarnessRuntime>();
                var ownedChild = ManagedChild(runtime);
                int childId = ownedChild.Id;

                // The campaign mutex rejects another seat before any provider request.
                host.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
                using (var response = await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{campaign}/harness/runs",
                    new HarnessInputRequest(Id(), current.Version, "不应调用模型的并发输入")))
                    Check.Equal(HttpStatusCode.Conflict, response.StatusCode);
                Check.Equal(1, model.Calls);
                Check.True(!ownedChild.HasExited, "Rejected concurrent input killed the active child.");
                Check.Equal(childId, ManagedChild(runtime).Id);
                Check.Equal(current.Version, (await host.Get(campaign))!.Version);

                // Kill exactly the runtime-owned Process, not a name-matched process or our host.
                ownedChild.Kill(entireProcessTree: true);
                await cancelled.Task.WaitAsync(TimeSpan.FromSeconds(5));
                host.Http.DefaultRequestHeaders.Authorization = new("Bearer", ownerToken);
                first = await Settled(host, campaign, first.Id, maximumPolls: 200);
                Check.Equal("unknown", first.Status);
                Check.Equal("harness_model_unknown", first.Error);
                Check.Equal(1, first.ModelAttempts);
                Check.Equal(0, dice.Count);
                Check.Equal(current.Version, (await host.Get(campaign))!.Version);
                using (var health = await host.Http.GetAsync("/health")) Check.Equal(HttpStatusCode.OK, health.StatusCode);

                // The next explicit command gets a fresh child and only the new seat's context.
                host.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
                var next = await Start(host, (await host.Get(campaign))!, "另一席位的独立行动");
                next = await Settled(host, campaign, next.Id, maximumPolls: 3000);
                Check.Equal("completed", next.Status);
                Check.Equal(2, model.Calls);
                Check.True(ManagedChild(runtime).Id != childId);
                Check.True(!HarnessJson.Serialize(model.Requests[1]).Contains(privateInput, StringComparison.Ordinal));
                Check.True(!HarnessJson.Serialize(model.Requests[1]).Contains(lateNarrative, StringComparison.Ordinal));
                int settledVersion = (await host.Get(campaign))!.Version;
                release.TrySetResult();
                await lateReturned.Task.WaitAsync(TimeSpan.FromSeconds(5));
                Check.Equal(settledVersion, (await host.Get(campaign))!.Version);
                Check.True(!HarnessJson.Serialize(await host.Get(campaign)).Contains(lateNarrative, StringComparison.Ordinal));

                // Provider failure also tears down the child, preserves unknown, and never retries.
                var failed = await Start(host, (await host.Get(campaign))!, "触发隔离供应商失败");
                failed = await Settled(host, campaign, failed.Id, maximumPolls: 3000);
                Check.Equal("unknown", failed.Status);
                Check.Equal(3, model.Calls);
                Check.True(!HarnessJson.Serialize(failed).Contains("PRIVATE_PROVIDER_FAILURE_BODY", StringComparison.Ordinal));
                var healthy = await Start(host, (await host.Get(campaign))!, "故障后的新行动");
                healthy = await Settled(host, campaign, healthy.Id, maximumPolls: 3000);
                Check.Equal("completed", healthy.Status);
                Check.Equal(4, model.Calls);
                Check.Equal(0, dice.Count);
            }
            finally { release.TrySetResult(); }
        }

        // Reopening the host and reading/replaying unknown never schedules a supplier or rolls back.
        await using var reopened = await Host.Start(root, dice, configure: configure);
        reopened.Http.DefaultRequestHeaders.Authorization = new("Bearer", ownerToken);
        var replay = await Post<HarnessRunView>(reopened, campaign, "harness/runs", original);
        Check.True(replay.Replayed);
        Check.Equal("unknown", replay.Status);
        using (var response = await reopened.Http.PostAsJsonAsync($"/api/v1/campaigns/{campaign}/harness/runs/{replay.Id}/resume",
                   new HarnessResumeRequest(Id(), (await reopened.Get(campaign))!.Version)))
            Check.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Check.Equal(4, model.Calls);
        Check.Equal(0, dice.Count);
        Check.True(!HarnessJson.Serialize(await reopened.Get(campaign)).Contains(lateNarrative, StringComparison.Ordinal));
    }

    public static async Task ActiveCancellationAndHostStopRemainIsolated()
    {
        var entered = Enumerable.Range(0, 2).Select(_ => new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously)).ToArray();
        var release = Enumerable.Range(0, 2).Select(_ => new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously)).ToArray();
        var returned = Enumerable.Range(0, 2).Select(_ => new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously)).ToArray();
        var model = new Model(async (number, _, _) =>
        {
            if (number is 1 or 3)
            {
                int index = number == 1 ? 0 : 1;
                entered[index].TrySetResult();
                await release[index].Task; // The owner bounds this wait even when a supplier ignores cancellation.
                returned[index].TrySetResult();
                return Text("已取消的供应商文字不应落地。");
            }
            return Text("另一席位明确提交的排队行动已完成。");
        });
        var dice = new SequenceDice(18);
        var configure = Configure(model, extra: builder =>
        {
            builder.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry();
            builder.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>();
        });
        var host = await Host.Start(dice: dice, configure: configure);
        bool disposed = false;
        try
        {
            var owner = await Create(host);
            var guest = await HarnessBoundaryTests.Guest(host, owner);
            string campaign = owner.Snapshot.Id;
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var current = (await host.Get(campaign))!;
            var first = await Start(host, current, "取消正在等待供应商的行动");
            await entered[0].Task.WaitAsync(TimeSpan.FromSeconds(90));
            var runtime = (PiHarnessRuntime)host.App.Services.GetRequiredService<IHarnessRuntime>();
            using var firstChild = Process.GetProcessById(ManagedChild(runtime).Id); // Independent handle survives runtime disposal.
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
            using (var response = await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{campaign}/harness/runs",
                new HarnessInputRequest(Id(), current.Version, "并发行动必须被拒绝")))
                Check.Equal(HttpStatusCode.Conflict, response.StatusCode);
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            using (var response = await host.Http.PostAsync($"/api/v1/campaigns/{campaign}/harness/runs/{first.Id}/cancel", null))
                Check.Equal(HttpStatusCode.OK, response.StatusCode);
            first = await Settled(host, campaign, first.Id, maximumPolls: 200);
            Check.Equal("unknown", first.Status); // A started supplier attempt cannot be called unspent.
            await firstChild.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
            var queued = await Start(host, (await host.Get(campaign))!, "前次取消后本人明确提交的另一行动");
            queued = await Settled(host, campaign, queued.Id, maximumPolls: 3000);
            Check.Equal("completed", queued.Status);
            Check.Equal(2, model.Calls);
            release[0].TrySetResult();
            await returned[0].Task.WaitAsync(TimeSpan.FromSeconds(5));
            Check.Equal(0, dice.Count);

            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            current = (await host.Get(campaign))!;
            var stopRequest = new HarnessInputRequest(Id(), current.Version, "停服时仍在等待模型的本人行动");
            var stopping = await Post<HarnessRunView>(host, campaign, "harness/runs", stopRequest);
            await entered[1].Task.WaitAsync(TimeSpan.FromSeconds(90));
            using var stoppingChild = Process.GetProcessById(ManagedChild(runtime).Id);
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
            using (var response = await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{campaign}/harness/runs",
                new HarnessInputRequest(Id(), current.Version, "停服前并发但不应外发的行动")))
                Check.Equal(HttpStatusCode.Conflict, response.StatusCode);
            string root = host.Root;
            await host.DisposeAsync(); disposed = true;
            await stoppingChild.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));
            Check.Equal(3, model.Calls);
            release[1].TrySetResult();
            await returned[1].Task.WaitAsync(TimeSpan.FromSeconds(5));

            await using var reopened = await Host.Start(root, dice, configure: configure);
            reopened.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            stopping = (await reopened.Http.GetFromJsonAsync<HarnessRunView>($"/api/v1/campaigns/{campaign}/harness/runs/{stopping.Id}"))!;
            Check.Equal("unknown", stopping.Status);
            Check.Equal(1, stopping.ModelAttempts);
            Check.True((await Post<HarnessRunView>(reopened, campaign, "harness/runs", stopRequest)).Replayed);
            Check.Equal(current.Version, (await reopened.Get(campaign))!.Version);
            reopened.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
            var active = await reopened.Http.GetFromJsonAsync<HarnessActiveRuns>($"/api/v1/campaigns/{campaign}/harness/runs/active");
            Check.Equal(0, active!.Runs.Length);
            Check.Equal(3, model.Calls);
            Check.Equal(0, dice.Count);
        }
        finally
        {
            foreach (var source in release) source.TrySetResult();
            if (!disposed) await host.DisposeAsync();
        }
    }

    internal static object[] Workers(PiHarnessRuntime runtime) =>
        ((Array)typeof(PiHarnessRuntime).GetField("workers", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(runtime)!).Cast<object>().ToArray();

    internal static Process ManagedChild(PiHarnessRuntime runtime) => Workers(runtime)
        .Select(worker => worker.GetType().GetField("process", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(worker) as Process)
        .Single(child => child is { HasExited: false })!;
}
