namespace DiceRealm.Server.Domain;

public sealed record PartyRestRequest(string RequestId, int ExpectedVersion, string Kind);
public sealed record PartyRestOption(string Kind, string Label, long Seconds, bool Available, string Reason);
public sealed record PartyRestView(int Version, PartyRestOption[] Options, string[] Participants);

// DM-owned team time; personal dice/source choices stay on the original player's command path.
public static class PartyRest
{
    public static bool IsInitiation(string kind) => kind is "rest.short" or "rest.long" or "rest.wait";
    public static void RequirePlayerAction(string kind)
    {
        if (IsInitiation(kind)) throw new GameException("rest_host_required", "休整由 DM 在主持工作台发起；玩家可在休整后选择自己的生命骰和恢复方式。", 409);
    }
    private static bool Recovering(Campaign c, string actor) => c.Combat?.Units.Any(u => u.Id == actor && u.RecoveryRestRequired) == true
        || actor == PartyEngine.HostId && c.Combat?.RecoveryRestRequired == true;
    private static long WaitSeconds(Campaign c) => Math.Max(0, PartyEngine.Characters(c).Select(p => p.Character.NextLongRestAtSeconds).DefaultIfEmpty(0).Max() - c.ElapsedSeconds);
    public static PartyRestView View(Campaign c)
    {
        PartyEngine.RequireHost(c);
        return new(c.Version, new[] { "short", "long", "wait" }.Select(kind => new PartyRestOption(kind,
            kind == "short" ? "全队短休" : kind == "long" ? "全队长休" : "度过长休间隔",
            kind == "short" ? 3600 : kind == "long" ? 28800 : WaitSeconds(c), Block(c, kind) == "", Block(c, kind))).ToArray(),
            PartyEngine.Characters(c).Select(p => p.Character.Name).ToArray());
    }
    private static string Block(Campaign c, string kind)
    {
        if (GameLifecycle.GameOver(c)) return "游戏已结束，请由 DM 读档或重开。";
        if (c.Archived) return "战役已归档。";
        if (!ContentRuntime.Ready(c)) return "请先启用冒险内容。";
        if (CombatEngine.InCombat(c)) return "请先结束战斗。";
        var people = PartyEngine.Characters(c).Where(p => !GameLifecycle.Dead(c, p.Id)).ToArray();
        if (people.Length == 0) return "尚无审核通过的玩家角色，请先邀请玩家在客户端建卡加入。";
        var actors = people.Select(p => p.Id).ToHashSet(StringComparer.Ordinal);
        if (c.PendingRolls.Any(r => actors.Contains(r.ActorId) && r.Status == "pending")
            || c.PendingIntents.Any(i => actors.Contains(i.ActorId) && i.Status == "pending"))
            return "队伍中仍有人等待确认行动或投掷，请由本人先完成或放弃。";
        if (!ContentRuntime.SafeRest(c) && !(kind == "short" && people.Any(p => Recovering(c, p.Id))))
            return "此地点尚不允许安全休整。";
        if (people.Any(p => p.Character.HitPoints <= 0 || p.Character.Exhaustion >= 6))
            return "有角色无法通过普通休整恢复，请先处理濒死或其他特殊状态。";
        if (people.Any(p => p.Character.Conditions.Contains("Unconscious") && !(kind == "short" && Recovering(c, p.Id))))
            return "有角色尚未脱离昏迷；请先处理其恢复条件。";
        if (kind == "long" && WaitSeconds(c) > 0) return "队伍的长休间隔尚未结束，还需 " + WaitSeconds(c) + " 秒。";
        if (kind == "wait" && WaitSeconds(c) == 0) return "已经可以开始长休，无需额外度过间隔。";
        return "";
    }
    public static Resolution Apply(Campaign c, string kind)
    {
        PartyEngine.RequireHost(c);
        if (kind is not ("short" or "long" or "wait")) throw new GameException("invalid_rest", "请选择短休、长休或度过长休间隔。", 400);
        var reason = Block(c, kind);
        if (reason != "") throw new GameException("rest_unavailable", reason, 409);
        long seconds = kind == "short" ? 3600 : kind == "long" ? 28800 : WaitSeconds(c);
        var actors = PartyEngine.Characters(c).Where(p => !GameLifecycle.Dead(c, p.Id)).Select(p => p.Id).ToArray();
        CharacterEngine.Advance(c, seconds); // A single shared clock advance, never once per seat.
        string owner = c.ActingActorId;
        try
        {
            foreach (var actor in actors)
            {
                c.ActingActorId = actor;
                var ch = PlayResources.Ensure(c.ActingCharacter);
                if (kind == "short")
                {
                    ch = PlayResources.ShortRest(ch) with { ShortRestDiceAvailable = true,
                        PlayState = ch.PlayState! with { PreparationOpen = false } };
                    if (Recovering(c, actor))
                    {
                        PartyEngine.FinishRecovery(c);
                        ch = ch with { Conditions = ch.Conditions.Where(s => s != "Unconscious").ToArray() };
                    }
                }
                else if (kind == "long")
                    ch = PlayResources.LongRest(ch) with { HitPoints = ch.MaxHitPoints, NextLongRestAtSeconds = c.ElapsedSeconds + 16 * 3600,
                        ShortRestDiceAvailable = false };
                else ch = ch with { ShortRestDiceAvailable = false, PlayState = ch.PlayState! with { PreparationOpen = false } };
                c.ActingCharacter = ch;
                c.ActingPendingAbilityCheck = null;
            }
        }
        finally { c.ActingActorId = owner; }
        CharacterEngine.Sync(c);
        string summary = kind == "short" ? "DM 发起的全队短休已完成，共经过 1 小时。已按来源恢复短休资源；没有自动治疗或消耗生命骰。每位玩家可自行选择生命骰和奥术回想。"
            : kind == "long" ? "DM 发起的全队长休已完成，共经过 8 小时。已恢复各成员生命与长休资源；准备法术和来源调整由各成员自行选择。"
            : "DM 让全队在安全地点度过 " + seconds / 60 + " 分钟长休间隔；未恢复生命或资源。";
        return new("resolved", "party.rest." + kind, summary, null, actors.Select(a => "character:" + PartyEngine.CharacterFor(c, a).Id).ToArray());
    }
}
