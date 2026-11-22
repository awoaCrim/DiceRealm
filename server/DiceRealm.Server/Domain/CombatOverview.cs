namespace DiceRealm.Server.Domain;

// Host-only read projection for the workbench. It reports what is still blocking a
// battle without offering any way to roll, confirm or change another seat's state.
public sealed record CombatOverviewView(string CampaignId, string TimelineId, int Version, CombatState? Combat, CombatOverviewWait[] Waits);
public sealed record CombatOverviewWait(string Id, string ActorId, string ActorName, string Kind, string Label, string Description, string State, string Reason);

public static class CombatOverviewProjection
{
    public static CombatOverviewView Project(Campaign c)
    {
        var seats = PartyEngine.Characters(c).ToDictionary(seat => seat.Id, seat => seat.Character.Name, StringComparer.Ordinal);
        var participants = CombatEngine.InCombat(c) ? c.Combat!.Units.Select(u => u.Id).ToHashSet(StringComparer.Ordinal) : null;
        var waits = new List<CombatOverviewWait>();
        foreach (var roll in c.PendingRolls.Where(r => r.Status == "pending"))
        {
            if (!seats.TryGetValue(roll.ActorId, out string? name) || !Waiting(c, roll, participants)) continue;
            var (state, reason) = RollState(c, roll);
            waits.Add(new(roll.Id, roll.ActorId, name, "roll", roll.Label, roll.Description, state, reason));
        }
        foreach (var intent in c.PendingIntents.Where(i => i.Status == "pending"))
        {
            if (!seats.TryGetValue(intent.ActorId, out string? name) || !Waiting(intent, participants)) continue;
            var (state, reason) = IntentState(c, intent);
            // Private-root text was never published; only the generated question is safe to repeat.
            waits.Add(new(intent.Id, intent.ActorId, name, "intent", intent.PrivateRoot ? "" : intent.Text,
                intent.Question, state, reason));
        }
        return new(c.Id, c.TimelineId ?? "", c.Version, CombatVisibility.Project(c), waits.ToArray());
    }

    // With a battle running every pending wait of a participating seat can hold it up.
    // Without one only an explicit combat operation (including all-party initiative) is a battle wait.
    private static bool Waiting(Campaign c, PendingRoll roll, HashSet<string>? participants) =>
        participants?.Contains(roll.ActorId) ?? RollKind(c, roll).StartsWith("combat.", StringComparison.Ordinal);

    private static bool Waiting(PendingIntent intent, HashSet<string>? participants) =>
        participants?.Contains(intent.ActorId) ??
        intent.Options.Any(option => option.Action is { } action && action.Kind.StartsWith("combat.", StringComparison.Ordinal));

    // Group confirmations carry no intent on member rolls; the leader holds the original operation.
    private static string RollKind(Campaign c, PendingRoll roll)
    {
        var source = roll.GroupId == "" ? roll : c.PendingRolls.FirstOrDefault(r => r.Id == roll.GroupId) ?? roll;
        return source.Intent?.Kind ?? source.Action?.Kind ?? "";
    }

    private static (string State, string Reason) RollState(Campaign c, PendingRoll roll)
    {
        if (c.Archived) return ("blocked", "战役已归档，不能继续投掷；请由主持人读档或重开。");
        if (GameLifecycle.Dead(c, roll.ActorId)) return ("blocked", "该角色已经死亡，不能继续投掷；仍可阅读或由主持人读档、重开。");
        if (c.Version != roll.Version) return ("stale", "行动依据的状态已变化；不会自动重掷或结算，需要该席位放弃后重新选择。");
        if (roll.Confirmed) return ("confirmed", "本人已确认，等待其他席位确认；全员确认前不会掷骰或开始结算。");
        return ("pending", "");
    }

    private static (string State, string Reason) IntentState(Campaign c, PendingIntent intent)
    {
        if (c.Archived) return ("blocked", "战役已归档，不能继续确认行动；请由主持人读档或重开。");
        if (GameLifecycle.Dead(c, intent.ActorId)) return ("blocked", "该角色已经死亡，不能继续确认行动；仍可阅读或由主持人读档、重开。");
        if (c.Version != intent.Version) return ("stale", "冒险状态已变化；不会自动执行，需要该席位放弃旧意图后重新描述。");
        return ("pending", "");
    }

}
