using System.Text;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Server.Application;

public sealed record HarnessItemMatch(string Kind, string Field, string Text, int Score);
public sealed record HarnessItemSearchEntry(string ItemId, string Name, string CanonicalName, string[] Aliases,
    string? RulesId, HarnessItemMatch Match);

// Ranked retrieval only. Neither fuzzy similarity nor rule text establishes scene presence,
// ownership, permission or an executable identity. No inferred aliases are persisted.
public static class HarnessItemSearch
{
    public static object Read(int version, HarnessContextReadArgs args, LocalRulesPackage? package)
    {
        HarnessContextReads.Validate(args);
        string query = Normalize(args.Query);
        string[] terms = Terms(args.Query);
        bool browse = string.IsNullOrWhiteSpace(args.Query);
        var entries = HarnessContextReads.Catalog(package).Select(source =>
        {
            var item = source.Item;
            var match = browse ? new HarnessItemMatch("browse", "", "", 0) : Match(item, source.Rule, query, terms);
            return match is null ? null : new HarnessItemSearchEntry(item.ItemId, item.Name, item.CanonicalName,
                item.Aliases, source.Rule?.Id, match);
        }).Where(e => e is not null).Select(e => e!)
            .OrderByDescending(e => e.Match.Score).ThenBy(e => e.ItemId, StringComparer.Ordinal).ToArray();
        if (args.Offset > entries.Length) throw new GameException("harness_invalid_payload", "物品目录游标超出结果范围。");
        return new
        {
            version, scope = "supported_acquisition_catalog", total = entries.Length, chineseNamesAvailable = package is not null,
            entries = entries.Skip(args.Offset).Take(args.Limit).ToArray(),
            nextOffset = args.Offset + args.Limit < entries.Length ? (int?)(args.Offset + args.Limit) : null,
            coverage = "Ranked catalog candidates only: exact > partial/terms > fuzzy > text. Score is retrieval relevance, not identity confidence. Match text is catalog evidence; rules_read(rulesId) gives full rules. This does NOT establish local presence, possession, quantity or permission. Never introduce a scene item just because it matches. Use current scene evidence/inventory/established stock; unsupported presence stays unknown. Empty results do not prove absence or justify inventing a prop. Page with the same query."
        };
    }

    private static HarnessItemMatch? Match(HarnessCatalogItem item, LocalRuleEntry? rule, string query, string[] terms)
    {
        if (query.Length == 0) return null; // Punctuation is not a request to browse everything.
        var names = new[] { ("itemId", item.ItemId), ("name", item.Name), ("canonicalName", item.CanonicalName) }
            .Concat(item.Aliases.Select(a => ("alias", a)))
            .Concat(rule is null ? [] : new[] { ("rulesId", rule.Id) }).ToArray();
        HarnessItemMatch? best = null;
        void Offer(string kind, string field, string text, int score)
        {
            if (best is null || score > best.Score) best = new(kind, field, text, score);
        }
        var normalized = names.Select(n => (Field: n.Item1, Text: n.Item2, Key: Normalize(n.Item2))).ToArray();
        foreach (var name in normalized)
        {
            if (name.Key == query) Offer("exact", name.Field, name.Text, name.Field == "itemId" ? 1000 : 990);
            else if (name.Key.Contains(query, StringComparison.Ordinal))
                Offer("partial", name.Field, name.Text, 800 + 90 * query.Length / name.Key.Length);
            // IDs are opaque authority. Only names/aliases participate in typo matching.
            else if (name.Field is "name" or "canonicalName" or "alias" && query.Length >= 2 && name.Key.Length >= 2)
            {
                double similarity = Similarity(query, name.Key);
                if (similarity > 0) Offer("fuzzy", name.Field, name.Text, 400 + (int)(similarity * 199));
            }
        }
        if (terms.Length > 1 && terms.All(t => normalized.Any(n => n.Key.Contains(t, StringComparison.Ordinal))))
            Offer("terms", "names", string.Join(" / ", new[] { item.Name, item.CanonicalName }.Distinct()), 790);
        // Rules prose is lower priority than names and is never treated as an alias. Only
        // actual query terms match here (no edit distance over long rule paragraphs).
        if (best is null && rule is not null && query.Length >= 2 && terms.Length > 0 &&
            terms.All(t => rule.Text.Contains(t, StringComparison.OrdinalIgnoreCase)))
        {
            int at = terms.Select(t => rule.Text.IndexOf(t, StringComparison.OrdinalIgnoreCase)).Min();
            int start = Math.Max(0, at - 40), end = Math.Min(rule.Text.Length, start + 240);
            if (start > 0 && char.IsLowSurrogate(rule.Text[start])) start--;
            if (end < rule.Text.Length && char.IsLowSurrogate(rule.Text[end])) end--;
            Offer("text", "text", rule.Text[start..end], 200);
        }
        return best;
    }

    private static double Similarity(string query, string name)
    {
        bool chinese = query.Any(IsHan), nameChinese = name.Any(IsHan);
        if (chinese != nameChinese) return 0;
        if (chinese)
        {
            // Do not discard model numbers, bonuses or Latin qualifiers in mixed queries.
            if (string.Concat(query.Where(c => !IsHan(c))) != string.Concat(name.Where(c => !IsHan(c)))) return 0;
            var a = query.Where(IsHan).ToHashSet(); var b = name.Where(IsHan).ToHashSet();
            if (a.Count < 2 || b.Count < 2) return 0;
            double overlap = 2.0 * a.Intersect(b).Count() / (a.Count + b.Count);
            // A two-character query can have one changed character (麻绳/绳索).
            // Longer names need more shared evidence. These are explicitly fuzzy candidates.
            return overlap >= (Math.Max(a.Count, b.Count) <= 3 ? .5 : .6) ? overlap : 0;
        }
        if (Math.Min(query.Length, name.Length) < 3) return 0;
        int maximum = Math.Max(query.Length, name.Length) >= 7 ? 2 : 1;
        if (Math.Abs(query.Length - name.Length) > maximum) return 0;
        int distance = Distance(query, name);
        return distance <= maximum ? 1.0 - (double)distance / Math.Max(query.Length, name.Length) : 0;
    }

    // Optimal-string-alignment distance: insert/delete/substitute and adjacent transposition.
    private static int Distance(string a, string b)
    {
        var rows = new int[3][] { new int[b.Length + 1], new int[b.Length + 1], new int[b.Length + 1] };
        for (int j = 0; j <= b.Length; j++) rows[0][j] = j;
        for (int i = 1; i <= a.Length; i++)
        {
            var current = rows[i % 3]; var previous = rows[(i - 1) % 3]; current[0] = i;
            for (int j = 1; j <= b.Length; j++)
            {
                current[j] = Math.Min(Math.Min(previous[j] + 1, current[j - 1] + 1), previous[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1));
                if (i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1])
                    current[j] = Math.Min(current[j], rows[(i - 2) % 3][j - 2] + 1);
            }
        }
        return rows[a.Length % 3][b.Length];
    }
    private static bool IsHan(char c) => c is >= '\u3400' and <= '\u9fff';
    private static string Normalize(string value) => string.Concat(Compatible(value).Where(char.IsLetterOrDigit));
    private static string[] Terms(string value) => string.Concat(Compatible(value).Select(c => char.IsLetterOrDigit(c) ? c : ' '))
        .Split(' ', StringSplitOptions.RemoveEmptyEntries).Distinct(StringComparer.Ordinal).ToArray();
    private static string Compatible(string value)
    {
        try { return value.Normalize(NormalizationForm.FormKC).ToUpperInvariant(); }
        catch (ArgumentException) { throw new GameException("harness_invalid_payload", "物品查询包含无效Unicode字符。"); }
    }
}
