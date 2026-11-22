using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Server.Application;

// One active publication per campaign/scope/audience. Work is opportunistic; no GET starts
// it, and a saved started marker prevents crash/restart from resending an unknown helper call.
public sealed class HarnessHistoryManager(GameService game, IHarnessHistorian historian,
    ILogger<HarnessHistoryManager> logger) : IHostedService, IDisposable
{
    private readonly object gate = new();
    private readonly Dictionary<string, Task<HarnessHistorySummary?>> active = [];
    private readonly CancellationTokenSource stopping = new();

    internal Task<HarnessHistorySummary?> Prepare(HarnessRun run, string token, HarnessHistoryCapture capture,
        HarnessHistoryContext context, string audience, CombatRunAuthority? authority)
    {
        var helper = historian.Capture();
        if (!helper.Enabled || stopping.IsCancellationRequested) return Task.FromResult<HarnessHistorySummary?>(null);
        var selected = context.Audiences.Single(a => a.Audience == audience);
        var covered = selected.Summaries.SelectMany(s => s.Sources).ToHashSet();
        // Even an unselectable mixed old summary is a published ancestor. A partial
        // replacement cannot publish with Replaces=[]; keep those groups raw instead.
        if (run.ToolContractVersion >= 51)
            covered.UnionWith(capture.Published.Where(s => s.Scope == capture.Scope && s.Audience == audience).SelectMany(s => s.Sources));
        // Keep published baselines frozen. Each new summary adds only complete, closed,
        // uncovered groups for this audience; an old boundary cannot re-summarize them.
        var eligible = capture.Sources.Where(s => s.Audience == audience).GroupBy(s => s.Group)
            .Where(group => group.All(s => s.ClosedForSummary && !context.ProtectedOriginals.Contains(s.Source) &&
                !covered.Contains(s.Source)))
            .SelectMany(group => group.Select(s => s.Source)).ToHashSet();
        if (eligible.Count == 0)
            return Task.FromResult<HarnessHistorySummary?>(null);
        var range = HarnessHistorySummaries.Freeze(capture.Scope, audience, capture.Sources, eligible.ToArray());
        string key = run.CampaignId + "/" + capture.Scope + "/" + audience;
        lock (gate)
        {
            if (active.TryGetValue(key, out var pending)) return pending;
            var task = Task.Run(async () =>
            {
                try { return await Summarize(); }
                finally { lock (gate) active.Remove(key); }
            });
            active.Add(key, task);
            return task;
        }

        async Task<HarnessHistorySummary?> Summarize()
        {
            HarnessHistoryWork? work = null;
            var previousScope = ModelRequestScope.Current;
            ModelRequestScope.Current = new(run.CampaignId, run.Id, run.Input);
            try
            {
                work = await game.BeginHarnessHistory(run, token, capture, range, helper.Identity, stopping.Token, authority);
                if (work is null) return null;
                var sources = capture.Sources.Where(s => range.Sources.Contains(s.Source)).ToArray();
                var text = await helper.Summarize(sources, async ct =>
                {
                    if (run.CancelRequested) throw new OperationCanceledException(ct);
                    await game.AuthorizeHarnessHistory(run, token, capture, range, ct, authority);
                }, run.CampaignId, stopping.Token, run.ToolContractVersion);
                var candidate = new HarnessHistorySummary(Guid.NewGuid().ToString(), 1, 1, range.Scope,
                    range.Audience, range.Sources, text.Detailed, text.Brief, []);
                var published = await game.PublishHarnessHistory(run, token, capture, range, candidate, stopping.Token, authority);
                await game.FinishHarnessHistory(run, token, capture, work, true, "", stopping.Token, authority);
                return published;
            }
            catch (Exception error)
            {
                // Failure leaves raw/previous published combinations available. Never claim
                // a cancelled HTTP call was unsent; its durable work marker already exists.
                string code = error is HarnessModelNotSentException rejected ? rejected.Code :
                    error is OperationCanceledException ? "cancelled" : "summary_failed";
                logger.LogWarning("History preparation stopped ({Code}); error {ErrorType}", code, error.GetType().Name);
                if (work is not null && !stopping.IsCancellationRequested)
                {
                    try { await game.FinishHarnessHistory(run, token, capture, work, false, code, stopping.Token, authority); }
                    catch (Exception finishError)
                    { logger.LogWarning("History attempt remains started ({ErrorType})", finishError.GetType().Name); }
                }
                return null;
            }
            finally { ModelRequestScope.Current = previousScope; }
        }
    }

    public Task StartAsync(CancellationToken ct) => Task.CompletedTask;
    public async Task StopAsync(CancellationToken ct)
    {
        stopping.Cancel();
        Task[] pending;
        lock (gate) pending = active.Values.ToArray();
        await Task.WhenAll(pending).WaitAsync(ct);
    }
    public void Dispose() => stopping.Dispose();
}
