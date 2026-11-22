using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Application;

// v9 is frozen; v10 adds source-linked public mastery effects to the bounded PUBLIC board. Never send Campaign.StandardCombatFlow or authored
// encounter definitions/conditions/victory effects to the model.
internal static class HarnessCombatContext
{
    public static object Read(Campaign c, int version = 9)
    {
        var b = CombatVisibility.Project(c, publicOnly: true)!;
        var result = new
        {
            mode = StandardCombatEngine.Mode, b.Status, b.Round, b.ActiveActorId, b.Width, b.Height, b.CellFeet,
            geometry = "Flat grid, centre rays, explicit obstacle cells; no inferred height, darkness or hidden units.",
            wait = b.Standard!.Wait,
            units = b.Units.Select(u => new
            {
                u.Id, u.Name, u.Team, u.X, u.Y, u.HitPoints, u.MaxHitPoints, u.ArmorClass,
                u.MovementRemaining, u.ActionAvailable, u.BonusActionAvailable, u.ReactionAvailable, u.Withdrawn,
                u.Standard!.Conditions, u.Standard.TemporaryHitPoints, u.Standard.Dead, u.Standard.Stable,
                u.Standard.DeathSuccesses, u.Standard.DeathFailures, u.Standard.ShieldActive, u.Standard.ReactionsSuppressed,
                concentration = u.Team == "party" ? ConcentrationEffects.Current(c, PartyEngine.CharacterFor(c, u.Id)) : null
            }).ToArray(),
            cells = b.Cells,
            recent = b.Log.TakeLast(8).Select(e => new { e.Sequence, e.Kind, e.ActorId, text = IntentContexts.Bounded(e.Text, 500) }).ToArray()
        };
        if (version < 10) return result;
        return new
        {
            result.mode, result.Status, result.Round, result.ActiveActorId, result.Width, result.Height, result.CellFeet,
            result.geometry, result.wait, result.units, result.cells, result.recent,
            masteries = b.Units.SelectMany(u => u.Standard!.MasteryEffects.Select(e => new
            { targetId = u.Id, e.Kind, e.SourceId, e.TurnEndsRemaining,
                expiry = e.Kind == "vex" ? "source next attack against this target or end of source next turn" : "start of source next turn; Sap consumed on target next attack" })).ToArray()
        };
    }
}
