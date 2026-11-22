using System.Security.Cryptography;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Infrastructure;

public sealed record LocalRuleEntry(string Id, string Category, string Name, string CanonicalName, string[] Aliases,
    string Text, string Source, int Page, string SourceRevision, string SourceHash, string TranslationStatus);
public sealed record LocalRulesCount(int SourceCount, int TranslatedCount);
public sealed record LocalRulesCoverage(bool SourceComplete, bool TranslationComplete, string[] Missing,
    Dictionary<string, LocalRulesCount> Counts);
public sealed record LocalRulesPackage(int SchemaVersion, string Ruleset, string Language, string SourceRevision,
    string[] Sources, LocalRulesCoverage Coverage, LocalRuleEntry[] Entries);
public sealed record LocalRulesPointer(string Version);

// A deployment-owned local directory, never a model-supplied path or remote fallback. Pack bytes
// are checked on every new read; a deleted/corrupted historical pack cannot become a new edition.
public sealed class LocalRulesCatalog(IConfiguration configuration)
{
    public const int MaximumBytes = 128 * 1024 * 1024;
    public const string SourceRevision = "e5f3e77b303a92df10487207857200245e71957c";
    public const int MaximumEntries = 20000;
    public const int MaximumText = 262144;
    private readonly string? directory = configuration["LocalRules:Directory"];
    public static bool Category(string? value) => value is "spell" or "class" or "subclass" or "feature" or "species" or
        "background" or "feat" or "equipment" or "magic_item" or "monster" or "condition" or "rule" or "language";
    public static bool Version(string? value) => Hex(value, 64);
    public static bool Id(string? value) => value is { Length: > 0 and <= 240 } &&
        value.All(c => char.IsAsciiLetterOrDigit(c) || c is ':' or '.' or '_' or '-');
    private static bool Hex(string? value, int length) => value?.Length == length && value.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f');
    private static bool Text(string? value, int maximum, bool multiline = false)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > maximum) return false;
        for (int i = 0; i < value.Length; i++)
        {
            char c = value[i];
            if (char.IsControl(c) && !(multiline && c is '\n' or '\r' or '\t')) return false;
            if (char.IsHighSurrogate(c))
            {
                if (++i >= value.Length || !char.IsLowSurrogate(value[i])) return false;
            }
            else if (char.IsLowSurrogate(c)) return false;
        }
        return true;
    }
    public string? CaptureVersion()
    {
        if (string.IsNullOrWhiteSpace(directory)) return null;
        var pointer = Parse<LocalRulesPointer>(ReadFile("active.json", 256));
        if (!Version(pointer.Version)) throw Corrupt();
        _ = Read(pointer.Version); // Reject invalid configuration before a new run/model attempt.
        return pointer.Version;
    }
    public LocalRulesPackage Read(string? version)
    {
        if (string.IsNullOrWhiteSpace(directory) || version is null) throw Unavailable();
        if (!Version(version)) throw Corrupt();
        byte[] bytes = ReadFile(version + ".json", MaximumBytes);
        if (Convert.ToHexStringLower(SHA256.HashData(bytes)) != version) throw Corrupt();
        var package = Parse<LocalRulesPackage>(bytes);
        Validate(package);
        return package;
    }
    private byte[] ReadFile(string file, int maximum)
    {
        try
        {
            using var stream = new FileStream(Path.Combine(directory!, file), FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete);
            if (stream.Length is < 2 || stream.Length > maximum) throw Corrupt();
            byte[] bytes = new byte[(int)stream.Length];
            stream.ReadExactly(bytes);
            if (stream.ReadByte() != -1) throw Corrupt();
            return bytes;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        { throw Unavailable(); }
    }
    private static T Parse<T>(byte[] bytes)
    {
        try
        {
            using var document = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 32 });
            return HarnessJson.Read<T>(document.RootElement);
        }
        catch (Exception ex) when (ex is JsonException or GameException or InvalidOperationException or ArgumentException)
        { throw Corrupt(); }
    }
    public static void Validate(LocalRulesPackage p)
    {
        if (p.SchemaVersion != 1 || p.Ruleset != "dnd2024" || p.Language != "zh-CN" || p.SourceRevision != SourceRevision ||
            p.Sources is not { Length: > 0 and <= 3 } || p.Sources.Any(s => s is not ("XPHB" or "XDMG" or "XMM")) ||
            p.Sources.Distinct(StringComparer.Ordinal).Count() != p.Sources.Length ||
            p.Entries is null || p.Entries.Length > MaximumEntries || p.Coverage is null) throw Corrupt();
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var e in p.Entries)
        {
            if (e is null || !Id(e.Id) || !ids.Add(e.Id) || !Category(e.Category) || !Text(e.Name, 160) || !Text(e.CanonicalName, 160) ||
                e.Aliases is null || e.Aliases.Length > 16 || e.Aliases.Any(a => !Text(a, 160)) ||
                e.Aliases.Distinct(StringComparer.Ordinal).Count() != e.Aliases.Length || !Text(e.Text, MaximumText, multiline: true) ||
                !p.Sources.Contains(e.Source) || e.Page < 0 || e.SourceRevision != p.SourceRevision || !Hex(e.SourceHash, 64) ||
                e.TranslationStatus != "translated" || e.Text.Contains("{@", StringComparison.Ordinal)) throw Corrupt();
        }
        var coverage = p.Coverage;
        // No complete three-core source manifest has been independently verified yet.
        // Self-reported book names/counts (even an internally consistent empty pack)
        // cannot certify completeness. Enable this only alongside an audited source pin.
        if (coverage.SourceComplete || coverage.TranslationComplete) throw Corrupt();
        if (coverage.Missing is null || coverage.Missing.Length > MaximumEntries || coverage.Missing.Any(s => !Text(s, 512)) ||
            coverage.Counts is null || coverage.Counts.Count != 13 || coverage.Counts.Any(pair => !Category(pair.Key) || pair.Value is null ||
                pair.Value.SourceCount is < 0 or > MaximumEntries || pair.Value.TranslatedCount < 0 ||
                pair.Value.TranslatedCount > pair.Value.SourceCount) ||
            p.Entries.Any(e => !coverage.Counts.ContainsKey(e.Category)) ||
            coverage.Counts.Any(pair => p.Entries.Count(e => e.Category == pair.Key) != pair.Value.TranslatedCount) ||
            coverage.SourceComplete && p.Sources.Length != 3 ||
            !coverage.SourceComplete && coverage.Missing.Length == 0 ||
            coverage.TranslationComplete && (!coverage.SourceComplete || coverage.Missing.Length != 0 ||
                coverage.Counts.Values.Any(c => c.SourceCount != c.TranslatedCount))) throw Corrupt();
    }
    private static GameException Corrupt() => new("rules_catalog_corrupt", "本地中文规则包无效或版本不匹配；已保留原文件，不会改用其他资料。", 409);
    private static GameException Unavailable() => new("rules_catalog_unavailable", "此运行绑定的本地中文规则包不可用；不会联网或使用英文资料回退。", 409);
}
