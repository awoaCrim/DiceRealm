namespace DiceRealm.Server.Domain;

// Opt-in, immutable configuration for new campaigns only. Skills are data, not executable files.
public sealed record HarnessPreset(string Id, int Version, string SystemPrompt,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    string? CombatSystemPrompt = null);
public sealed record HarnessSkill(string Id, string Description, string Content);
public sealed record HarnessProfile(HarnessPreset Preset, string Hash, HarnessSkill[] Skills);

public static class HarnessProfiles
{
    public static void Validate(HarnessPreset? preset, HarnessSkill[]? skills)
    {
        if (preset is null || !ValidId(preset.Id) || preset.Version < 1 || !Text(preset.SystemPrompt, 32768) ||
            preset.CombatSystemPrompt is not null && !Text(preset.CombatSystemPrompt, 32768) ||
            skills is null || skills.Length > 16 || skills.Any(s => s is null || !ValidId(s.Id) ||
                !Text(s.Description, 240) || !Text(s.Content, 16384)) || skills.Select(s => s.Id).Distinct().Count() != skills.Length ||
            skills.Sum(s => s.Content.Length) > 65536)
            throw new GameException("invalid_harness_profile", "需要有版本的原始预设和有界只读 Skill 内容。不会加载本机文件或默认提示词。");
    }
    private static bool ValidId(string? value) => value is { Length: > 0 and <= 80 } && value.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_' or '.');
    private static bool Text(string? value, int maximum) => !string.IsNullOrWhiteSpace(value) && value.Length <= maximum &&
        !value.Any(c => char.IsControl(c) && c is not ('\n' or '\r' or '\t'));
}
