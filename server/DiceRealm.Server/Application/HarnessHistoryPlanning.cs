using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Server.Application;

public sealed partial class HarnessRunService
{
    private static bool HistoryTransportError(Exception error) => error is GameException
        { Code: "harness_context_limit" or "harness_transport_limit" } ||
        error is HarnessModelNotSentException { Code: "harness_transport_limit" };

    private static (HarnessExecutionFrame Frame, HarnessPreparedContext Prepared) PrepareHistoryTransport(
        HarnessRun run, HarnessModelRequest request, HarnessExecutionFrame frame)
    {
        HarnessPreparedContext Project(HarnessExecutionFrame candidate) => HarnessContextCompactor.PreserveCurrent(
            HarnessExecutionProtocol.Project(request, candidate, run.ToolContractVersion));
        try { return (frame, Project(frame)); }
        catch (Exception error) when (HistoryTransportError(error))
        {
            if (frame.ReadPreload is not null)
            {
                frame = HarnessReadPreloads.OmitForTransport(frame);
                try { return (frame, Project(frame)); }
                catch (Exception preloadError) when (HistoryTransportError(preloadError)) { }
            }
            if (frame.History is null || frame.HistoryCapture is null) throw;
            // Try a complete published brief. RequiredOnly is an internal placeholder;
            // it must never reach the provider without the remaining history restored.
            var brief = frame with { History = HarnessHistoryContexts.Build(frame.Version, run.ActorId,
                frame.HistoryCapture, run.Input, frame.WorkingContext?.People ?? [], brief: true, toolContractVersion: run.ToolContractVersion) };
            try { return (brief, Project(brief)); }
            catch (Exception briefError) when (HistoryTransportError(briefError))
            {
                var required = frame with { History = HarnessHistoryContexts.RequiredOnly(frame.History), HistoryPreparationRequired = true };
                try { return (required, Project(required)); }
                catch (Exception requiredError) when (HistoryTransportError(requiredError))
                { throw HarnessJson.Conflict("harness_transport_limit"); }
            }
        }
    }

    private async Task<HarnessModelRequest> PrepareHistoryInput(HarnessRun run, string token, HarnessStep step,
        HarnessExecutionFrame? frame, HarnessModelRequest request, CombatRunAuthority? authority, CancellationToken ct)
    {
        if (request.ContextPolicy != HarnessContextCompactor.HistoryPolicy || frame?.History is not { } selected ||
            frame.HistoryCapture is not { } capture) return request;
        var history = frame.HistoryPreparationRequired ? HarnessHistoryContexts.Build(frame.Version, run.ActorId, capture,
            run.Input, frame.WorkingContext?.People ?? [], toolContractVersion: run.ToolContractVersion) : selected;
        if (!frame.HistoryPreparationRequired)
        {
            // Usage observes already completed requests, not model capacity. Never estimate
            // the first request or block generation when usage is absent. Include earlier
            // inputs: ordinary one-call conversations must not wait for a three-call Run.
            var previous = run.Steps.Where(s => s.Id != step.Id && s.Kind == "model" && s.Status == "done")
                .TakeLast(2).ToArray();
            if (previous.Length < 2)
            {
                // Compare first slots across inputs, avoiding each old Run's accumulated
                // native tool chain. Only this actor, scope, timeline and fixed profile qualify.
                var prior = capture.Sources.Where(s => s.Source.Kind == "intent" && s.Source.Part == "input" && s.ActorId == run.ActorId)
                    .OrderByDescending(s => s.Version).DistinctBy(s => s.Source.Id).Take(2)
                    .Select(s => runs.ReadAction(run.CampaignId, run.ActorId, s.Source.Id))
                    .Where(r => r is not null && r.Id != run.Id && r.Status == "completed" && r.TimelineId == run.TimelineId &&
                        r.CombatSessionId == run.CombatSessionId && r.Profile.Hash == run.Profile.Hash && r.RulesCatalogVersion == run.RulesCatalogVersion)
                    .Select(r => r!.Steps.FirstOrDefault(s => s.Kind == "model" && s.Status == "done"))
                    .OfType<HarnessStep>().Reverse();
                previous = prior.Concat(previous).TakeLast(2).ToArray();
            }
            bool growing = previous.Length == 2 && previous[0].ProviderIdentity is not null &&
                previous[0].ProviderIdentity == previous[1].ProviderIdentity &&
                previous[0].ContextPlan?.ReportedInputTokens is { } before &&
                previous[1].ContextPlan?.ReportedInputTokens is { } after && after > before;
            bool boundary = capture.Sources.Any(s => s.ClosedForSummary && !history.ProtectedOriginals.Contains(s.Source) &&
                (s.Round is not null || s.SceneId.Length > 0 && s.SceneId != frame.WorkingContext?.SceneId));
            if (boundary || growing)
                foreach (var audience in history.Audiences)
                    _ = historyManager.Prepare(run, token, capture, history, audience.Audience, authority);
            // Background publication affects later slots only. This slot's selection stays frozen.
            return request;
        }

        var published = new List<HarnessHistorySummary>();
        foreach (var audience in history.Audiences)
        {
            var summary = await historyManager.Prepare(run, token, capture, history, audience.Audience, authority).WaitAsync(ct);
            if (summary is not null && !capture.Published.Any(s => s.Id == summary.Id)) published.Add(summary);
        }
        if (published.Count > 0)
        {
            var available = capture with { Published = [.. capture.Published, .. published] };
            var finalFrame = frame with { History = HarnessHistoryContexts.Build(frame.Version, run.ActorId, available,
                run.Input, frame.WorkingContext?.People ?? [], brief: true, toolContractVersion: run.ToolContractVersion), HistoryPreparationRequired = false };
            try
            {
                var candidate = HarnessExecutionProtocol.Project(request with { Messages = request.Messages[..^1] }, finalFrame, run.ToolContractVersion);
                var planned = HarnessContextCompactor.PreserveCurrent(candidate);
                step.ExecutionFrame = finalFrame;
                step.ContextPlan = planned.Plan;
                runs.Save(run);
                return planned.Request;
            }
            catch (Exception error) when (HistoryTransportError(error)) { }
        }
        throw new HarnessModelNotSentException(HarnessModelRejection.ContextPreparation);
    }
}
