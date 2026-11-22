namespace DiceRealm.Server.Domain;

// Character-owned, so a still-live concentration effect survives an ended encounter.
public static class ConcentrationEffects
{
    public static ConcentrationEffect? Current(Campaign c, Character ch) => ch.Concentration is { } effect &&
        effect.ExpiresAtSeconds > c.ElapsedSeconds && ch.HitPoints > 0 &&
        !ch.Conditions.Any(x => x is "Dead" or "Unconscious" or "Incapacitated" or "Paralyzed" or "Petrified" or "Stunned") ? effect : null;
    public static bool Has(Campaign c, Character ch, string spell) => Current(c, ch)?.SpellId == spell;
    public static void Validate(Campaign c)
    {
        foreach (var (_, ch) in PartyEngine.Characters(c, true))
            if (ch.Concentration is { } effect && (effect.SpellId is not ("blade-ward" or "expeditious-retreat") ||
                effect.Source is not { Length: > 0 and <= 160 } || effect.ExpiresAtSeconds < 0))
                throw new GameException("invalid_standard_combat", "专注记录不完整或不受支持；保留存档，请检查记录。", 409);
    }
}
