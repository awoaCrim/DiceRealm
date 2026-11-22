using System.Text;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Server.Application;

public sealed record HarnessRulesSearchArgs(string Query, string Category = "", int Offset = 0, int Limit = 6);
public sealed record HarnessRulesReadArgs(string Id, int Offset = 0, int Limit = 4000);
public sealed record HarnessRulesMatch(string Id, string Name, string Category, string Preview);
public sealed record HarnessRulesSearchResult(int Version, string CatalogVersion, string Language, HarnessRulesMatch[] Entries, int? NextOffset);
public sealed record HarnessRulesReadResult(int Version, string CatalogVersion, string Language, string Id, string Name,
    string Category, string Text, int Offset, int TotalCharacters, int? NextOffset);

// Public reading projection, not execution authority. Source/page/revision remain in the local
// maintenance package and never enter these results. Paging traverses the complete translation.
public static class HarnessRules
{
    public static object Scope(LocalRulesCatalog catalog, string? rulesCatalogVersion, string ruleset, int toolContractVersion)
    {
        // Bound availability describes the accepted edition, never the current active pointer.
        var package = rulesCatalogVersion is null ? null : catalog.Read(rulesCatalogVersion);
        return new { ruleset, mode = "implemented_operations_only",
            localRules = new { available = package is not null, catalogVersion = rulesCatalogVersion, language = "zh-CN",
                sourceComplete = package?.Coverage.SourceComplete ?? false, translationComplete = package?.Coverage.TranslationComplete ?? false },
            note = toolContractVersion >= 34
                ? "This is execution/catalog metadata, not a rules search. Available tools and current encounter limitations are already in the execution frame. rules_search/rules_read query the pinned local catalog; missing entries remain unknown."
                : toolContractVersion >= 31
                ? "Rules are reference, not execution. Ordinary actor ability/skill checks use check_request; the server computes current modifiers, records passive Perception comparisons without dice, or waits for the actor before an active roll. Only use a supported grounded threshold, never invent enemy Stealth rolls. Ordinary explicit movement uses token_spawn/token_move without second consent; dice, combat, resources and other players remain separate. Complete the full compound action before final narration. Unsupported actual combat still needs a concrete host ruling; a missing encounter or a threat alone is not an attack. No 2014/2024 substitution."
                : toolContractVersion >= 29
                ? "Rules are reference, not execution. Ordinary conversation, visible details and established facts need no extra check or human approval. Use an offered action only when its full scope matches actual intent; missing intent/target uses ask_player. A missing encounter or a threat alone does not establish an attack. For an attack actually initiated, use offered combat.start or a concrete ruling_request, without inventing hit/miss, block, dodge or escape. Authored discoveries need matching action receipts; unperformed searches are not automatic correction requests. Human judgement is a last resort for actual unsupported mechanics or concrete corrections. No 2014/2024 substitution."
                : toolContractVersion >= 28
                ? "Rules reference never executes an attack or discovery. Use the current encounter guidance: offered combat.start or ruling_request when execution is unavailable. Never invent hit/miss/armor-block/dodge/escape results. An authored discovery must be resolved within the actual player input before claiming its fact; otherwise request a grounded ruling, not a repeat of an already announced action. No 2014/2024 substitution."
                : toolContractVersion >= 12
                ? "Use rules_search/rules_read for local Chinese details. Reading does not grant execution authority. Prefer offered executable actions or ordinary non-mechanical narrative. Ask the player for missing intent/target; human ruling is a last resort for a genuine unresolved mechanical ambiguity. Rest initiation belongs to the DM, not player actions. No remote or English fallback."
                : "Use rules_search/rules_read for local Chinese details. Coverage may be incomplete. Reading does not grant eligibility or execution authority; only offered actions can execute. Unsupported mechanics require a ruling. No remote or English fallback." };
    }

    public const int SearchBytes = 24 * 1024;
    public const int ReadBytes = 48 * 1024;
    public static HarnessRulesSearchResult Search(LocalRulesCatalog catalog, string? catalogVersion, int version, HarnessRulesSearchArgs args)
    {
        if (args.Query is null || args.Query.Length > 120 || args.Query.Any(char.IsControl) ||
            args.Category is null || args.Category != "" && !LocalRulesCatalog.Category(args.Category) ||
            args.Offset is < 0 or > LocalRulesCatalog.MaximumEntries || args.Limit is < 1 or > 8) throw Invalid();
        string query = args.Query.Trim();
        string[] words = query.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        if (words.Length > 8) throw Invalid();
        var package = catalog.Read(catalogVersion);
        bool NameMatches(LocalRuleEntry e, string word) => e.Name.Contains(word, StringComparison.OrdinalIgnoreCase) ||
            e.CanonicalName.Contains(word, StringComparison.OrdinalIgnoreCase) || e.Aliases.Any(a => a.Contains(word, StringComparison.OrdinalIgnoreCase));
        bool Exact(LocalRuleEntry e) => e.Name.Equals(query, StringComparison.OrdinalIgnoreCase) ||
            e.CanonicalName.Equals(query, StringComparison.OrdinalIgnoreCase) || e.Aliases.Contains(query, StringComparer.OrdinalIgnoreCase);
        var matches = package.Entries.Where(e => (args.Category == "" || e.Category == args.Category) &&
            words.All(word => NameMatches(e, word) || e.Text.Contains(word, StringComparison.OrdinalIgnoreCase)))
            .OrderByDescending(Exact).ThenBy(e => e.Id, StringComparer.Ordinal).Skip(args.Offset).Take(args.Limit + 1).ToArray();
        var entries = matches.Take(args.Limit).Select(e => new HarnessRulesMatch(e.Id, e.Name, e.Category, HarnessMemories.Clip(e.Text, 480))).ToList();
        HarnessRulesSearchResult Result() => new(version, catalogVersion!, package.Language, entries.ToArray(),
            entries.Count < matches.Length ? args.Offset + entries.Count : null);
        while (entries.Count > 0 && Encoding.UTF8.GetByteCount(HarnessJson.Serialize(Result())) > SearchBytes) entries.RemoveAt(entries.Count - 1);
        // Even a maximal single record fits the fixed budget. Never emit a non-advancing page.
        if (entries.Count == 0 && matches.Length > 0) throw HarnessJson.Conflict("harness_context_limit");
        var result = Result();
        HarnessJson.Bound(result, SearchBytes);
        return result;
    }
    public static HarnessRulesReadResult Read(LocalRulesCatalog catalog, string? catalogVersion, int version, HarnessRulesReadArgs args)
    {
        if (!LocalRulesCatalog.Id(args.Id) || args.Offset is < 0 or > LocalRulesCatalog.MaximumText || args.Limit is < 1 or > 6000) throw Invalid();
        var package = catalog.Read(catalogVersion);
        var entry = package.Entries.FirstOrDefault(e => e.Id == args.Id) ??
            throw new GameException("rules_entry_unavailable", "此版本本地中文库尚无该条完整译文。", 404);
        if (args.Offset > entry.Text.Length || args.Offset < entry.Text.Length && char.IsLowSurrogate(entry.Text[args.Offset])) throw Invalid();
        int end = Math.Min(entry.Text.Length, args.Offset + args.Limit);
        if (end < entry.Text.Length && char.IsLowSurrogate(entry.Text[end])) end--;
        // A limit of one still returns one complete Unicode scalar rather than stalling forever.
        if (end == args.Offset && end < entry.Text.Length) end += 2;
        var result = new HarnessRulesReadResult(version, catalogVersion!, package.Language, entry.Id, entry.Name, entry.Category,
            entry.Text[args.Offset..end], args.Offset, entry.Text.Length, end < entry.Text.Length ? end : null);
        HarnessJson.Bound(result, ReadBytes);
        return result;
    }
    private static GameException Invalid() => new("harness_invalid_payload", "规则查询参数不符合合同。");
}
