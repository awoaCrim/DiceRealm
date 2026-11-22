using System.Diagnostics;
using System.Reflection;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.Configuration;

namespace DiceRealm.Tests;

internal static class HarnessParallelTests
{
    public static async Task IndependentRealPiWorkersAndCancellation()
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        { ["Harness:AgentHostPath"] = HarnessPiTests.Entry() }).Build();
        using var runtime = new PiHarnessRuntime(configuration);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(90));
        using var firstCancellation = CancellationTokenSource.CreateLinkedTokenSource(deadline.Token);
        var entered = Enumerable.Range(0, 4).Select(_ => new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously)).ToArray();
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        int calls = 0;
        var tasks = Enumerable.Range(0, 4).Select(i => runtime.Execute(
            new(Guid.NewGuid().ToString(), "ISOLATED_SYSTEM_" + i, ["ISOLATED_INPUT_" + i], [], new()),
            async (call, token) =>
            {
                Check.Equal("model", call.Kind);
                var request = HarnessJson.Read<HarnessModelRequest>(call.Payload);
                Check.Equal("ISOLATED_SYSTEM_" + i, request.System);
                Check.True(request.Messages.Any(m => m.Content.Contains("ISOLATED_INPUT_" + i, StringComparison.Ordinal)));
                Check.True(!request.Messages.Any(m => Enumerable.Range(0, 4).Where(n => n != i)
                    .Any(n => m.Content.Contains("ISOLATED_INPUT_" + n, StringComparison.Ordinal))));
                Interlocked.Increment(ref calls);
                entered[i].TrySetResult();
                await release.Task.WaitAsync(token);
                return HarnessJson.Element(HarnessTests.Text("RESULT_" + i));
            }, i == 0 ? firstCancellation.Token : deadline.Token)).ToArray();
        try
        {
            // A single serialized runtime cannot pass: all four callbacks must enter
            // before any is released, independent of cold import/CPU timing.
            await Task.WhenAll(entered.Select(e => e.Task)).WaitAsync(deadline.Token);
            var children = HarnessPiIsolationTests.Workers(runtime).Select(worker =>
                (Process)worker.GetType().GetField("process", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(worker)!).ToArray();
            Check.Equal(4, children.Select(p => p.Id).Distinct().Count());
            using var queuedCancellation = new CancellationTokenSource();
            var queued = runtime.Execute(new(Guid.NewGuid().ToString(), "", ["QUEUED"], [], new()),
                (_, _) => throw new Exception("Queued cancelled execution reached a provider."), queuedCancellation.Token);
            queuedCancellation.Cancel();
            try { await queued; throw new Exception("Expected queued cancellation"); }
            catch (OperationCanceledException) { }
            Check.True(children.All(p => !p.HasExited));
            firstCancellation.Cancel();
            try { await tasks[0]; throw new Exception("Expected active cancellation"); }
            catch (OperationCanceledException) { }
            Check.True(tasks.Skip(1).All(t => !t.IsCompleted), "Another worker was cancelled with the first.");
            release.TrySetResult();
            for (int i = 1; i < 4; i++) Check.Equal("RESULT_" + i, (await tasks[i]).Text);
            Check.Equal(4, calls);
            var warm = await runtime.Execute(new(Guid.NewGuid().ToString(), "NEXT", ["NEXT"], [], new()),
                (_, _) => Task.FromResult(HarnessJson.Element(HarnessTests.Text("WARM"))), deadline.Token);
            Check.Equal("WARM", warm.Text);
        }
        finally
        {
            release.TrySetResult(); deadline.Cancel();
            try { await Task.WhenAll(tasks); } catch (OperationCanceledException) { }
        }
    }
}
