using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Application;

public static class HarnessCombatPrompts
{
    public const int MinimumToolVersion = 54;
    public static readonly string Default = ReadDefault();

    // Resolve only when capturing/delegating a new battle. Saved sessions keep their profile.
    public static HarnessPreset? Resolve(HarnessPreset preset, int contract) =>
        preset.CombatSystemPrompt is { } custom
            ? preset with { SystemPrompt = custom, CombatSystemPrompt = null }
            : contract >= MinimumToolVersion ? new("dicerealm-combat", 1, Default) : null;

    private static string ReadDefault()
    {
        using var stream = typeof(HarnessCombatPrompts).Assembly.GetManifestResourceStream("DiceRealm.Prompts.combat.md")
            ?? throw new InvalidOperationException("缺少内置战斗主持提示词。");
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }
}
