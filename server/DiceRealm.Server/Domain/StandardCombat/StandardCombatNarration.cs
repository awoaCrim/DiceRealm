namespace DiceRealm.Server.Domain;

public sealed partial class StandardCombatEngine
{
    public static bool NarrationPending(Campaign c) => c.StandardCombatFlow?.NarratedThrough is { } through &&
        c.Combat is { } battle && battle.LogSequence > through;

    public static bool CanContinueNarrated(Campaign c) => c.StandardCombatFlow is { NarratedThrough: not null, Steps.Count: > 0 } &&
        c.Combat is { Status: "active", Standard.Wait: null } && !NarrationPending(c);

    // Adopt pacing only for a newly accepted input; never replay or renarrate old logs.
    public static void EnableNarration(Campaign c)
    {
        if (c.StandardCombatFlow is { } flow && c.Combat is { Status: "active" } battle)
            flow.NarratedThrough ??= battle.LogSequence;
    }

    public static void AcknowledgeNarration(Campaign c)
    {
        if (c.StandardCombatFlow?.NarratedThrough is not null)
            c.StandardCombatFlow.NarratedThrough = Board(c).LogSequence;
    }

    // Called by the battle host only after the preceding story is durably recorded.
    // There are no player decisions here: only the original remaining NPC/trigger queue.
    public Resolution ContinueNarrated(Campaign c, bool coalesceIdleTurns = false)
    {
        if (!CanContinueNarrated(c)) throw Unavailable();
        int before = Board(c).LogSequence;
        Continue(c, coalesceIdleTurns);
        BoardCombat.Commit(c);
        return Result(c, "combat.continue", before);
    }
}
