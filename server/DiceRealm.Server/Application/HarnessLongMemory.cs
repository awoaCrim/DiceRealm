using System.Text;
using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Application;

public sealed record HarnessSemanticArgs(string Query, int Offset = 0, int Limit = 6);
public sealed record HarnessDigestArgs(int Before = 0, int Limit = 8);
public sealed record HarnessMemoryExcerpt(string IntentId, int OriginSequence, int ResultVersion, string Input,
    string Narrative, bool Corrected, HarnessMemoryStep[] Steps);
public sealed record HarnessSemanticHit(double Score, string[] Concepts, HarnessMemoryExcerpt Entry);
public sealed record HarnessSemanticResult(int Version, string Scope, string Algorithm, int TotalMatches,
    HarnessSemanticHit[] Entries, int? NextOffset);
public sealed record HarnessDigestResult(int Version, string Scope, string Method, int TotalEligible,
    HarnessMemoryExcerpt[] Entries, int? NextBefore);
public sealed record HarnessArchiveMemory(string Method, int TotalOlderActions, HarnessMemoryExcerpt[] Selected);

// A bounded local semantic model, not a general neural embedding service. Concept features let
// known paraphrases match without shared characters; lexical features keep names/IDs specific.
// It is deliberately stateless: authorization, public corrections and revocation precede every
// derivation, and no seat's vectors or summaries are placed in a process-wide cache.
public static class HarnessLongMemory
{
    public const string Algorithm = "local-concept-lexical-v1";
    public const int MaximumBytes = 24576;
    private static readonly string[][] Concepts =
    [
        ["passphrase", "口令", "暗号", "通关密语", "密码", "password", "passphrase", "codeword"],
        ["rescue", "营救", "救援", "解救", "获救", "救出", "搭救", "rescue", "liberate"],
        ["missing", "失踪", "下落", "失联", "寻人", "不见了", "missing", "disappear"],
        ["healing", "治疗", "医治", "疗伤", "医师", "疗愈", "恢复生命", "heal", "medicine", "physician"],
        ["crossing", "渡口", "过河", "桥梁", "跨河", "渡船", "桥上", "bridge", "ferry", "crossing"],
        ["key", "钥匙", "开锁", "解锁", "锁孔", "key", "unlock", "lockpick"],
        ["promise", "承诺", "约定", "答应", "誓言", "保证", "promise", "oath", "pledge"],
        ["debt", "欠款", "债务", "欠债", "借款", "偿还", "debt", "repay", "loan"],
        ["reward", "报酬", "奖励", "酬劳", "赏金", "reward", "bounty", "payment"],
        ["betrayal", "背叛", "出卖", "叛徒", "叛变", "betray", "traitor"],
        ["danger", "危险", "威胁", "险情", "警告", "danger", "threat", "warning"],
        ["ambush", "埋伏", "伏击", "突袭", "偷袭", "ambush", "surprise attack"],
        ["poison", "中毒", "毒药", "毒素", "毒液", "poison", "venom", "toxin"],
        ["cure", "解毒", "解药", "治疗药", "治愈", "antidote", "cure", "remedy"],
        ["prison", "囚牢", "牢房", "监狱", "地牢", "囚禁", "prison", "cell", "captive"],
        ["secret", "秘密", "隐情", "内幕", "机密", "secret", "confidential"],
        ["route", "道路", "路线", "路径", "小径", "捷径", "通路", "route", "path", "trail", "road"],
        ["shelter", "避难", "庇护", "藏身", "安全屋", "shelter", "refuge", "safehouse"],
        ["rest", "休息", "休整", "歇息", "宿营", "扎营", "rest", "camp", "sleep"],
        ["trade", "购买", "交易", "买卖", "出售", "商人", "trade", "buy", "sell", "merchant"],
        ["witness", "证人", "目击", "亲眼", "见证", "witness", "testimony"],
        ["evidence", "证据", "线索", "痕迹", "蛛丝马迹", "evidence", "clue", "trace"],
        ["map", "地图", "图纸", "地形图", "舆图", "map", "chart"],
        ["alliance", "盟友", "同盟", "结盟", "联盟", "ally", "alliance"],
        ["hostile", "敌对", "敌意", "仇恨", "仇敌", "hostile", "enemy", "enmity"],
        ["quest", "任务", "委托", "使命", "差事", "quest", "mission", "errand"],
        ["ritual", "仪式", "祭典", "祭祀", "祈祷", "ritual", "ceremony", "prayer"],
        ["underground", "地下", "地底", "隧道", "洞穴", "暗道", "underground", "tunnel", "cave"],
        ["document", "信件", "书信", "信函", "文书", "手稿", "letter", "document", "manuscript"],
        ["identity", "身份", "姓名", "名字", "真名", "identity", "name"],
        ["departure", "离开", "出发", "启程", "动身", "depart", "leave", "departure"],
        ["arrival", "抵达", "到达", "来到", "进入", "arrive", "arrival", "enter"]
    ];

    private static Dictionary<string, double> Features(string text)
    {
        string normalized = text.Normalize(NormalizationForm.FormKC).ToLowerInvariant();
        var features = new Dictionary<string, double>(StringComparer.Ordinal);
        foreach (var group in Concepts)
            if (group.Skip(1).Any(word => normalized.Contains(word, StringComparison.Ordinal))) features["concept:" + group[0]] = 3;
        var latin = new StringBuilder(); char previous = '\0';
        void Word()
        {
            if (latin.Length > 1) features.TryAdd("word:" + latin, 1);
            latin.Clear();
        }
        foreach (char c in normalized)
        {
            if (char.IsAsciiLetterOrDigit(c)) { latin.Append(c); previous = '\0'; continue; }
            Word();
            if (c is >= '\u3400' and <= '\u9fff')
            {
                if (previous != '\0') features.TryAdd("pair:" + previous + c, 1);
                previous = c;
            }
            else previous = '\0';
        }
        Word(); return features;
    }
    private static string Source(Campaign c, PendingIntent intent) => string.Join("\n", new[]
    {
        intent.Text,
        c.AdventureCorrections.FirstOrDefault(x => x.OriginSequence == intent.RootSequence)?.Text ?? HarnessMemories.Narrative(c, intent),
        string.Join("\n", (intent.HarnessSteps ?? []).Where(s => HarnessMemories.Settled(s.Result)).Select(s => HarnessMemories.PublicResult(c, s.Result).Summary))
    });
    private sealed record Match(PendingIntent Intent, double Score, string[] Concepts);
    private static IEnumerable<Match> Rank(Campaign c, string query, IEnumerable<PendingIntent> eligible)
    {
        var vector = Features(query);
        double norm = Math.Sqrt(vector.Values.Sum(v => v * v));
        foreach (var intent in eligible)
        {
            string text = Source(c, intent);
            var match = Similarity(query, text, vector, norm);
            if (!match.Matches) continue;
            yield return new(intent, match.Score, match.Concepts);
        }
    }
    private static (bool Matches, double Score, string[] Concepts) Similarity(string query, string text, Dictionary<string, double> vector, double norm, bool allowExact = true)
    {
        var source = Features(text);
        double dot = vector.Sum(feature => source.GetValueOrDefault(feature.Key) * feature.Value);
        bool exact = allowExact && query.Length > 0 && text.Contains(query, StringComparison.OrdinalIgnoreCase);
        double score = norm > 0 && source.Count > 0 ? dot / (norm * Math.Sqrt(source.Values.Sum(v => v * v))) : 0;
        if (exact) score += 1;
        return (!(query.Length > 0 && dot == 0 && !exact), score,
            vector.Keys.Where(key => key.StartsWith("concept:", StringComparison.Ordinal) && source.ContainsKey(key))
                .Select(key => key[8..]).Order(StringComparer.Ordinal).ToArray());
    }
    // History supplements need distinguishing terms, not any shared Chinese pair.
    // Corpus-common words otherwise reinsert virtually all summarized originals.
    // The legacy search/ranking path above remains unchanged.
    internal static Func<string, double> Relevance(string query, IEnumerable<string>? groups = null)
    {
        var vector = Features(query);
        if (groups is not null)
        {
            var documents = groups.Select(Features).ToArray();
            foreach (string key in vector.Keys.ToArray())
                // A few related exchanges do not establish a generic corpus term.
                if (documents.Count(document => document.ContainsKey(key)) > Math.Max(4, documents.Length / 2))
                    vector.Remove(key);
        }
        double norm = Math.Sqrt(vector.Values.Sum(v => v * v));
        return text => Similarity(query, text, vector, norm, allowExact: groups is null || norm > 0).Score;
    }
    private static HarnessMemoryExcerpt Excerpt(Campaign c, PendingIntent intent)
    {
        var projection = HarnessMemories.Project(c, intent);
        // Extracts retain negation and attribution verbatim. No generated assertion replaces
        // the original result, and consumers can read the full action using IntentId.
        return new(intent.Id, intent.RootSequence, projection.ResultVersion, HarnessMemories.Clip(projection.Input, 160),
            HarnessMemories.Clip(projection.Narrative, 480), projection.Corrected,
            projection.Steps.TakeLast(2).Select(s => s with { Summary = HarnessMemories.Clip(s.Summary, 160) }).ToArray());
    }
    private static void Query(string? query, int offset, int limit)
    {
        if (query is null || query.Length > 240 || query.Any(char.IsControl) || offset < 0 || limit is < 1 or > 8)
            throw new GameException("harness_invalid_payload", "记忆查询长度、游标或数量无效。");
    }
    public static HarnessSemanticResult Search(Campaign c, HarnessSemanticArgs args)
    {
        Query(args.Query, args.Offset, args.Limit);
        var matches = Rank(c, args.Query.Trim(), HarnessMemories.Eligible(c)).OrderByDescending(m => m.Score)
            .ThenByDescending(m => m.Intent.RootSequence).ThenBy(m => m.Intent.Id, StringComparer.Ordinal).ToArray();
        if (args.Offset > matches.Length) throw new GameException("harness_invalid_payload", "记忆查询游标超出当前结果范围。");
        var entries = matches.Skip(args.Offset).Take(args.Limit).Select(m => new HarnessSemanticHit(Math.Round(m.Score, 6), m.Concepts, Excerpt(c, m.Intent))).ToList();
        HarnessSemanticResult Result() => new(c.Version, HarnessRecall.Scope, Algorithm, matches.Length, entries.ToArray(),
            args.Offset + entries.Count < matches.Length ? args.Offset + entries.Count : null);
        while (entries.Count > 1 && Encoding.UTF8.GetByteCount(HarnessJson.Serialize(Result())) > MaximumBytes) entries.RemoveAt(entries.Count - 1);
        var result = Result(); HarnessJson.Bound(result, MaximumBytes); return result;
    }
    public static HarnessDigestResult Digest(Campaign c, HarnessDigestArgs args)
    {
        Query("", args.Before, args.Limit);
        if (args.Before > c.Version) throw new GameException("harness_invalid_payload", "摘要游标超出当前版本。");
        var eligible = HarnessMemories.Eligible(c).ToArray();
        var page = eligible.Where(i => args.Before == 0 || i.RootSequence < args.Before).OrderByDescending(i => i.RootSequence).Take(args.Limit + 1).ToArray();
        var entries = page.Take(args.Limit).Select(i => Excerpt(c, i)).ToList();
        HarnessDigestResult Result() => new(c.Version, HarnessRecall.Scope, "source-extracts-v1", eligible.Length, entries.ToArray(),
            page.Length > entries.Count ? entries[^1].OriginSequence : null);
        while (entries.Count > 1 && Encoding.UTF8.GetByteCount(HarnessJson.Serialize(Result())) > MaximumBytes) entries.RemoveAt(entries.Count - 1);
        var result = Result(); HarnessJson.Bound(result, MaximumBytes); return result;
    }
    public static HarnessMemory ForRun(Campaign c, string input)
    {
        var memory = HarnessMemories.Build(c);
        var recent = memory.Entries.Select(e => e.IntentId).ToHashSet(StringComparer.Ordinal);
        var older = HarnessMemories.Eligible(c).Where(i => !recent.Contains(i.Id)).OrderBy(i => i.RootSequence).ToArray();
        if (older.Length == 0) return memory;
        var selected = Rank(c, input, older).OrderByDescending(m => m.Score).ThenByDescending(m => m.Intent.RootSequence)
            .Take(4).Select(m => m.Intent).ToList();
        // Include source anchors across the campaign, not just another most-recent window.
        foreach (int index in new[] { 0, older.Length / 3, 2 * older.Length / 3, older.Length - 1 })
            if (selected.Count < 6 && selected.All(i => i.Id != older[index].Id)) selected.Add(older[index]);
        memory = memory with { Archive = new("source-extracts-v1/" + Algorithm, older.Length,
            selected.OrderBy(i => i.RootSequence).Select(i => Excerpt(c, i)).ToArray()) };
        while (memory.Entries.Length > 0 && Encoding.UTF8.GetByteCount(HarnessJson.Serialize(memory)) > HarnessMemories.MaximumBytes)
            memory = memory with { Entries = memory.Entries.Skip(1).ToArray() };
        while (memory.Archive!.Selected.Length > 1 && Encoding.UTF8.GetByteCount(HarnessJson.Serialize(memory)) > HarnessMemories.MaximumBytes)
            memory = memory with { Archive = memory.Archive with { Selected = memory.Archive.Selected.SkipLast(1).ToArray() } };
        memory = memory with { Archive = memory.Archive with { TotalOlderActions = older.Length + recent.Count - memory.Entries.Length } };
        HarnessMemories.Validate(memory); return memory;
    }
    public static void ValidateArchive(HarnessArchiveMemory archive, int version)
    {
        if (archive.Method != "source-extracts-v1/" + Algorithm || archive.TotalOlderActions < 1 || archive.Selected is null ||
            archive.Selected.Length is < 1 or > 6 || archive.Selected.Length > archive.TotalOlderActions ||
            archive.Selected.Any(e => e is null || !Guid.TryParseExact(e.IntentId, "D", out _) || e.OriginSequence < 1 ||
                e.ResultVersion < e.OriginSequence || e.ResultVersion > version || e.Input is not { Length: > 0 and <= 160 } ||
                e.Narrative is null || e.Narrative.Length > 480 || e.Steps is null || e.Steps.Length > 2 ||
                e.Steps.Any(s => s is null || s.Version < e.OriginSequence || s.Version > e.ResultVersion || s.Status is not { Length: > 0 and <= 80 } ||
                    s.Kind is not { Length: > 0 and <= 80 } || s.Summary is null || s.Summary.Length > 160 || s.RollId is null ||
                    s.RollId.Length > 0 && !Guid.TryParseExact(s.RollId, "D", out _))) ||
            archive.Selected.Select(e => e.IntentId).Distinct().Count() != archive.Selected.Length) throw new InvalidDataException();
    }
}
