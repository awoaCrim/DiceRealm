using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Application;

public sealed partial class GameService
{
    private static HarnessCombatNarration? CombatNarration(Campaign c) => c.StandardCombatFlow?.NarratedThrough is { } through
        ? new(StandardCombatEngine.NarrationPending(c), StandardCombatEngine.CanContinueNarrated(c),
            CombatVisibility.ProjectLog(c, c.Combat!.Log.Where(e => e.Sequence > through), publicOnly: true)
                .Select(e => new HarnessCombatBeat(e.Sequence, e.ActorId, e.Kind, e.Text,
                    c.Combat.Log.Single(original => original.Sequence == e.Sequence).Audience is null ? "public" : "actor")).ToArray())
        : null;

    private static bool HasCombatNarrationWork(Campaign c) =>
        CombatAgentSessions.Current(c) is { Phase: "active" } session && session.Members.Contains(c.ActingActorId) &&
        (StandardCombatEngine.NarrationPending(c) || StandardCombatEngine.CanContinueNarrated(c));

    private Resolution ContinueCombatNarration(Campaign c, string runId, string input, int toolContractVersion)
    {
        ContextualRolls.RequireNoPending(c);
        if (ActionUnderstanding.Current(c) is not null || !StandardCombatEngine.CanContinueNarrated(c))
            throw HarnessJson.Conflict("combat_narration_required");
        var (intent, root) = HarnessRoot(c, runId, input);
        var before = ActivityRecords.Capture(c);
        long elapsed = c.ElapsedSeconds;
        var result = combat.ContinueNarrated(c, coalesceIdleTurns: toolContractVersion >= 53) with { IntentId = intent.Id };
        var origin = IntentOrigin(c, intent) with { Changes = ActivityRecords.Changes(before, c), ElapsedSecondsBefore = elapsed };
        RecordIntent(c, intent, result, root ? "intent.request" : "combat.continue", origin: origin);
        ActionUnderstanding.Complete(c, result, origin);
        return result;
    }
}
