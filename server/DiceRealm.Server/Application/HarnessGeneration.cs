using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Server.Application;

// A battle return starts a new exploration generation interval. Keep cumulative audit
// counters and all SDK callbacks intact; replay never grants another interval.
internal static class HarnessGeneration
{
    internal static HarnessCombatReturnReceipt? Boundary(HarnessRun run) => run.CombatReturns?.LastOrDefault();
    internal static int StepLimit(HarnessRun run) => (Boundary(run)?.StepCount ?? 0) + 64;
    internal static int TurnLimit(HarnessRun run) => (Boundary(run)?.Turn ?? 0) + 12;
    internal static int ResumeLimit(HarnessRun run) => (Boundary(run)?.ResumeCount ?? 0) + 16;
    internal static int ModelLimit(HarnessRun run) => (Boundary(run)?.ModelAttempts ?? 0) + run.Limits.MaxModelCalls;
    internal static int ToolLimit(HarnessRun run) => PriorSteps(run).Count(s => s.Kind == "tool") + run.Limits.MaxToolCalls;
    internal static long RuntimeUsed(HarnessRun run) => run.RuntimeMilliseconds - (Boundary(run)?.RuntimeMilliseconds ?? 0);
    private static IEnumerable<HarnessStep> PriorSteps(HarnessRun run) => run.Steps.Take(Boundary(run)?.StepCount ?? 0);

    internal static HarnessLimits ReplayLimits(HarnessRun run) => Boundary(run) is null ? run.Limits : run.Limits with
    {
        MaxModelCalls = PriorSteps(run).Count(s => s.Kind == "model") + run.Limits.MaxModelCalls,
        MaxToolCalls = ToolLimit(run),
        MaxOutputCharacters = PriorSteps(run).Where(s => s.Kind == "model" && s.Status == "done")
            .Sum(s => HarnessJson.Read<HarnessModelReply>(s.Result!.Value).Text.Length) + run.Limits.MaxOutputCharacters
    };
}
