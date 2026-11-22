namespace DiceRealm.Server.Domain;

public sealed record CampaignLifecycle(string Status, string Message, bool CanAct);

// Character conditions survive encounters. A closed battle is historical, not a second
// source of current life/death; zero HP (including stable) alone never means death.
public static class GameLifecycle
{
    public static bool Dead(Character character) => character.Conditions.Contains("Dead", StringComparer.Ordinal);
    public static bool Dead(Campaign c, string actor) => Dead(PartyEngine.CharacterFor(c, actor)) ||
        CombatEngine.InCombat(c) && c.Combat!.Units.Any(u => u.Id == actor && u.Standard?.Dead == true);
    public static bool GameOver(Campaign c)
    {
        if (c.GameEnded) return true;
        var party = PartyEngine.Characters(c).ToArray();
        return party.Length > 0 && party.All(p => Dead(c, p.Id));
    }
    public static bool CanAct(Campaign c) => !GameOver(c) && PartyEngine.HasCharacter(c) && !Dead(c, c.ActingActorId);
    public static void RequireAction(Campaign c)
    {
        if (GameOver(c)) throw new GameException("game_over", "全体玩家已经死亡，游戏结束。请由 DM 读档或重开。", 409);
        PartyEngine.RequireCharacter(c);
        if (Dead(c, c.ActingActorId)) throw new GameException("character_dead", "角色已经死亡，不能继续行动。仍可阅读、取消等待或由 DM 读档、重开。", 409);
    }
    public static CampaignLifecycle View(Campaign c)
    {
        if (GameOver(c)) return new("game_over", "全体玩家已经死亡，游戏结束。请由 DM 读档或重开。", false);
        bool alive = PartyEngine.HasCharacter(c) && !Dead(c, c.ActingActorId);
        return new("active", !PartyEngine.HasCharacter(c) ? "" : alive ? "" : "角色已经死亡，不能继续行动。", alive);
    }
    internal static void SynchronizeDeaths(Campaign c)
    {
        if (CombatEngine.InCombat(c))
        foreach (var (actor, character) in PartyEngine.Characters(c, includeRevoked: true).ToArray())
            if (!Dead(character) && c.Combat!.Units.Any(u => u.Id == actor && u.Standard?.Dead == true))
                PartyEngine.SetCharacter(c, actor, character with { Conditions = [.. character.Conditions, "Dead"] });
        c.GameEnded = GameOver(c);
    }
}
