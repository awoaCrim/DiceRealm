using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Application;

// Model-only working context. It belongs to a private v23 frame, not to the PUBLIC
// AdventureContext, client snapshots or world_search. Build must run in the authorized
// campaign gate so every index read observes the same campaign version as the frame.
public sealed record HarnessSceneContext(string SceneId, int Version, HarnessScenePerson[] People,
    HarnessSceneEvidence[] PublicEvidence, HarnessSceneEvidence[] DmOnly, HarnessSceneCoverage Coverage,
    string Guidance);

// Id is a namespaced working identity (npc:<authored id> or memory:<record id>).
// Sources[0] supplies Summary; the other identity sources and RelatedEvidenceIds do not
// get silently rewritten into a synthesized personality, promise or relationship.
public sealed record HarnessScenePerson(string Id, string Name, string Summary, int SummaryLength,
    bool SummaryTruncated, int SourceTotal, HarnessSceneSource[] Sources, string[] RelatedEvidenceIds);

public sealed record HarnessSceneSource(string Origin, string Id, string Source, string Nature,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? Revision = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? OriginSequence = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? UpdatedSequence = null);

// These are complete current record summaries, not extracted facts or mechanical proof.
// ActorId, correction reasons and action/private texts are intentionally not projected.
public sealed record HarnessSceneEvidence(string Id, string Kind, string Name, string Summary, string Status,
    string SceneId, string Visibility, int Revision, int OriginSequence, int UpdatedSequence, string Source,
    string Nature);

public sealed record HarnessSceneCoverage(int PublicRecordsTotal, int AuthoredPeopleTotal,
    int AuthoredPeopleIncluded, int PeopleConsidered, int PeopleIncluded, int InputTermsTotal,
    int InputTermsQueried, HarnessSceneReadCoverage[] PublicReads, HarnessSceneDmCoverage DmOnly, string Note);

// Totals are exact for each query but queries overlap: their totals must not be added.
// Read is the first indexed page actually loaded; IncludedIds identifies its records
// actually supplied in PublicEvidence. NextOffset does not imply that Read was supplied
// in full when the output selection omits records from that page.
public sealed record HarnessSceneReadCoverage(string Scope, string Kind, string SceneId, string[] Words,
    int Total, int Read, string[] IncludedIds,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? NextOffset = null);

public sealed record HarnessSceneDmCoverage(int ImportedCandidates, int Checked, int Eligible, int Included);

public static class HarnessSceneContexts
{
    public const int MinimumToolVersion = 23;
    public const int MaximumPeople = 8;
    // Server-written guidance: the fixed v44+ text plus encounter notes already reached ~1000
    // characters, and v58's authored-encounter note put a real room's frame past the old cap.
    public const int MaximumGuidance = 2000;
    public const int MaximumPersonSources = 8;
    public const int MaximumPersonSummary = 400;
    public const int MaximumSceneNpcRead = 16;
    public const int MaximumSceneEvidence = 16;
    public const int MaximumUnlocatedEvidence = 8;
    public const int MaximumPublicEvidence = MaximumSceneEvidence + MaximumUnlocatedEvidence;
    public const int MaximumInputTerms = 4;
    public const int MaximumRelatedRead = 4;
    public const int MaximumDmEvidence = 8;

    private const string GuidanceText = "局部记录，空查询或未加载不证明不存在。人物摘要来自Sources[0]，相关原文见RelatedEvidenceIds。authored为作者资料，model_record/host_record为非机械记录，不认证获物、期限或招募能力；未知保持未知。DM-only仅供推理，不是玩家已知。处境和出口见context；未列候选不等于无法尝试。People.id仅为工作身份，写入须用公开原ID。";
    private const string CoverageNote = "PublicRecordsTotal只统计公开索引；各查询Total可重叠。Read为加载量，IncludedIds为实际提供记录，未提供的不算已知。人物仅本场景；无地点记录按姓名/字面词匹配。DM-only仅当前场景导入host名单的有效同ID版本。";

    public static HarnessSceneContext Build(Campaign c, AdventureContext context, int toolContractVersion = MinimumToolVersion)
    {
        ArgumentNullException.ThrowIfNull(c);
        ArgumentNullException.ThrowIfNull(context);
        string sceneId = c.SceneId;
        string input = context.Intent.Text + " " + string.Join(" ", context.Intent.Clarifications.Select(x => x.Answer));
        var reads = new List<MemoryRead>();
        MemoryRead Read(string scope, string kind, string[] words, string scene, int limit)
        {
            // Never request host access, even when the acting seat is a human host.
            var page = WorldMemories.Read(c, words, kind, limit: limit, host: false, scenes: [scene]);
            var read = new MemoryRead(scope, kind, scene, words, page);
            reads.Add(read);
            return read;
        }

        var npcs = StoryEngine.Snapshot(c).Npcs.Where(n => n.SceneId == sceneId).ToArray();
        var localNpcs = Read("current_scene_npcs", "npc", [], sceneId, MaximumSceneNpcRead);
        var localRecords = Read("current_scene_records", "", [], sceneId, MaximumSceneEvidence);
        var identities = npcs.Select(n => new PersonRecord(n.Name, n.Summary,
                new HarnessSceneSource("static_npc", n.Id, "adventure", "authored")))
            .Concat(localNpcs.Page.Entries.Select(e => new PersonRecord(e.Name, e.Summary, Source(e))));
        var considered = identities.GroupBy(x => NameKey(x.Name), StringComparer.Ordinal).Select(group =>
        {
            var ordered = group.OrderByDescending(x => x.Source.Origin == "static_npc")
                .ThenBy(x => x.Source.Id, StringComparer.Ordinal).ToArray();
            var primary = ordered[0];
            // Keep the authored identity first, but do not bury a same-name world record
            // behind many authored aliases if the source-reference list reaches its limit.
            var sources = new[] { primary.Source }.Concat(ordered.Select(x => x.Source)
                    .OrderByDescending(s => s.Origin == "world_memory").ThenBy(s => s.Id, StringComparer.Ordinal))
                .DistinctBy(s => (s.Origin, s.Id)).ToArray();
            string summary = Excerpt(primary.Summary, MaximumPersonSummary);
            return new HarnessScenePerson(PersonId(primary.Source), primary.Name.Trim(), summary,
                primary.Summary.Length, summary.Length < primary.Summary.Length, sources.Length,
                sources.Take(MaximumPersonSources).ToArray(), []);
        }).ToArray();
        var people = considered.OrderByDescending(p => input.Contains(p.Name, StringComparison.OrdinalIgnoreCase))
            .ThenByDescending(p => p.Sources[0].Origin == "static_npc")
            .ThenBy(p => NameKey(p.Name), StringComparer.Ordinal).ThenBy(p => p.Id, StringComparer.Ordinal)
            .Take(MaximumPeople).ToArray();

        foreach (var person in people)
            Read("unlocated_npc", "", [person.Name], "", MaximumRelatedRead);
        var terms = toolContractVersion >= 28 ? PrioritizedInputTerms(input, context, npcs.Select(n => n.Name)) : InputTerms(input);
        foreach (string term in terms.Take(MaximumInputTerms))
            Read("unlocated_input", "", [term], "", MaximumRelatedRead);

        bool IsPersonRecord(WorldMemoryEntry e) => e.Kind == "npc" && people.Any(p => NameKey(e.Name) == NameKey(p.Name));
        bool Related(WorldMemoryEntry e) => people.Any(p => Relates(e.Name, e.Summary, p.Name));
        var local = localNpcs.Page.Entries.Concat(localRecords.Page.Entries).DistinctBy(e => e.Id)
            .OrderByDescending(IsPersonRecord).ThenByDescending(Related)
            .ThenByDescending(e => e.UpdatedSequence).ThenBy(e => e.Id, StringComparer.Ordinal)
            .Take(MaximumSceneEvidence);
        // Reserve a small part of the output for earlier unlocated promises/relationships
        // so a busy current scene cannot crowd them out. No other scene is searched.
        var unlocated = reads.Where(r => r.SceneId.Length == 0).SelectMany(r => r.Page.Entries).DistinctBy(e => e.Id)
            .OrderByDescending(Related).ThenByDescending(e => e.UpdatedSequence).ThenBy(e => e.Id, StringComparer.Ordinal)
            .Take(MaximumUnlocatedEvidence);
        var publicEvidence = local.Concat(unlocated).Select(Evidence).ToArray();
        var suppliedIds = publicEvidence.Select(e => e.Id).ToHashSet(StringComparer.Ordinal);
        people = people.Select(p => p with
        {
            RelatedEvidenceIds = publicEvidence.Where(e => Relates(e.Name, e.Summary, p.Name)).Select(e => e.Id).ToArray()
        }).ToArray();

        // The imported current-scene host ID list is the author-data boundary. Reading
        // current versions by ID is independent of the acting seat's host privilege.
        // Never fall back to the original imported summary if its current row is absent,
        // hidden, moved or no longer host-only.
        var imported = (c.Adventure?.InitialKnowledge ?? []).Where(e => e.Visibility == "host" && e.SceneId == sceneId)
            .Select(e => e.Id).Distinct(StringComparer.Ordinal).ToArray();
        var eligible = imported.Select(id => WorldMemories.Find(c, id))
            .Where(e => e is not null && !e.Hidden && e.Visibility == "host" && e.SceneId == sceneId)
            .Select(e => e!).OrderByDescending(e => e.UpdatedSequence).ThenBy(e => e.Id, StringComparer.Ordinal).ToArray();
        var dmOnly = eligible.Take(MaximumDmEvidence).Select(Evidence).ToArray();
        var coverage = new HarnessSceneCoverage(WorldMemories.Read(c, limit: 0, host: false).Total,
            npcs.Select(n => NameKey(n.Name)).Distinct(StringComparer.Ordinal).Count(),
            people.Count(p => p.Sources[0].Origin == "static_npc"), considered.Length, people.Length,
            terms.Length, Math.Min(terms.Length, MaximumInputTerms),
            reads.Select(r => new HarnessSceneReadCoverage(r.Scope, r.Kind, r.SceneId, r.Words, r.Page.Total,
                r.Page.Entries.Length, r.Page.Entries.Where(e => suppliedIds.Contains(e.Id)).Select(e => e.Id).ToArray(),
                r.Page.NextOffset)).ToArray(), new(imported.Length, imported.Length, eligible.Length, dmOnly.Length), CoverageNote);
        var result = new HarnessSceneContext(sceneId, c.Version, people, publicEvidence, dmOnly, coverage, GuidanceText);
        Validate(result);
        return result;
    }

    // Structural validation for private saved frames. It checks internal counts, bounds,
    // partitions and source references, not the truth of prose or the imported allow-list;
    // only Build in the authorized gate can establish that live-data boundary.
    public static void Validate(HarnessSceneContext value)
    {
        if (value is null || !Text(value.SceneId, 80) || value.Version < 1 ||
            value.People is null || value.People.Length > MaximumPeople ||
            value.PublicEvidence is null || value.PublicEvidence.Length > MaximumPublicEvidence ||
            value.DmOnly is null || value.DmOnly.Length > MaximumDmEvidence || value.Coverage is null ||
            !Text(value.Guidance, MaximumGuidance, multiline: true)) throw Invalid();
        if (value.PublicEvidence.Any(e => !ValidEvidence(e, value, dmOnly: false)) ||
            value.DmOnly.Any(e => !ValidEvidence(e, value, dmOnly: true)) ||
            value.PublicEvidence.Select(e => e.Id).Distinct(StringComparer.Ordinal).Count() != value.PublicEvidence.Length ||
            value.DmOnly.Select(e => e.Id).Distinct(StringComparer.Ordinal).Count() != value.DmOnly.Length ||
            value.DmOnly.Any(e => value.PublicEvidence.Any(p => p.Id == e.Id))) throw Invalid();
        var evidence = value.PublicEvidence.ToDictionary(e => e.Id, StringComparer.Ordinal);
        foreach (var p in value.People)
        {
            if (p is null || !Text(p.Name, 120) || p.Summary is null || p.Summary.Length > MaximumPersonSummary ||
                p.SummaryLength < p.Summary.Length || p.SummaryLength > 8000 || p.SummaryTruncated != (p.SummaryLength > p.Summary.Length) ||
                p.Sources is null || p.Sources.Length is < 1 or > MaximumPersonSources || p.SourceTotal < p.Sources.Length ||
                p.Sources.Any(s => !ValidSource(s, value.Version)) ||
                p.Sources.Select(s => (s.Origin, s.Id)).Distinct().Count() != p.Sources.Length ||
                p.Id != PersonId(p.Sources[0]) || p.RelatedEvidenceIds is null || p.RelatedEvidenceIds.Length > MaximumPublicEvidence ||
                p.RelatedEvidenceIds.Distinct(StringComparer.Ordinal).Count() != p.RelatedEvidenceIds.Length ||
                p.RelatedEvidenceIds.Any(id => id is null || !evidence.TryGetValue(id, out var e) || !Relates(e.Name, e.Summary, p.Name)))
                throw Invalid();
            foreach (var s in p.Sources.Where(s => s.Origin == "world_memory"))
            {
                if (!evidence.TryGetValue(s.Id, out var e) || e.Kind != "npc" || e.SceneId != value.SceneId ||
                    NameKey(e.Name) != NameKey(p.Name) || s != Source(e)) throw Invalid();
            }
            if (p.Sources[0].Origin == "world_memory")
            {
                var primary = evidence[p.Sources[0].Id];
                if (p.SummaryLength != primary.Summary.Length || p.Summary != Excerpt(primary.Summary, MaximumPersonSummary)) throw Invalid();
            }
        }
        if (value.People.Select(p => p.Id).Distinct(StringComparer.Ordinal).Count() != value.People.Length ||
            value.People.Select(p => NameKey(p.Name)).Distinct(StringComparer.Ordinal).Count() != value.People.Length) throw Invalid();

        var c = value.Coverage;
        if (c.PublicRecordsTotal is < 0 or > WorldMemories.MaximumEntries || c.PublicRecordsTotal < value.PublicEvidence.Length ||
            c.AuthoredPeopleTotal < 0 || c.AuthoredPeopleIncluded != value.People.Count(p => p.Sources[0].Origin == "static_npc") ||
            c.AuthoredPeopleIncluded > c.AuthoredPeopleTotal || c.PeopleConsidered < c.AuthoredPeopleTotal ||
            c.PeopleConsidered < value.People.Length || c.PeopleIncluded != value.People.Length ||
            c.InputTermsTotal < 0 || c.InputTermsQueried != Math.Min(c.InputTermsTotal, MaximumInputTerms) ||
            c.PublicReads is null || c.PublicReads.Length != 2 + value.People.Length + c.InputTermsQueried ||
            !Text(c.Note, 1000, multiline: true) || c.DmOnly is null || c.DmOnly.ImportedCandidates is < 0 or > 64 ||
            c.DmOnly.Checked != c.DmOnly.ImportedCandidates || c.DmOnly.Eligible < c.DmOnly.Included ||
            c.DmOnly.Eligible > c.DmOnly.Checked || c.DmOnly.Included != value.DmOnly.Length ||
            c.DmOnly.Included != Math.Min(c.DmOnly.Eligible, MaximumDmEvidence)) throw Invalid();
        foreach (var r in c.PublicReads)
        {
            if (r is null || r.Words is null || r.IncludedIds is null || r.Total < 0 || r.Total > c.PublicRecordsTotal ||
                r.Read < 0 || r.Read > r.Total || r.IncludedIds.Length > r.Read ||
                r.IncludedIds.Distinct(StringComparer.Ordinal).Count() != r.IncludedIds.Length ||
                r.NextOffset != (r.Read < r.Total ? (int?)r.Read : null)) throw Invalid();
            int limit;
            switch (r.Scope)
            {
                case "current_scene_npcs":
                    if (r.Kind != "npc" || r.SceneId != value.SceneId || r.Words.Length != 0) throw Invalid();
                    limit = MaximumSceneNpcRead;
                    break;
                case "current_scene_records":
                    if (r.Kind != "" || r.SceneId != value.SceneId || r.Words.Length != 0) throw Invalid();
                    limit = MaximumSceneEvidence;
                    break;
                case "unlocated_npc":
                    if (r.Kind != "" || r.SceneId != "" || r.Words.Length != 1 || !value.People.Any(p => p.Name == r.Words[0])) throw Invalid();
                    limit = MaximumRelatedRead;
                    break;
                case "unlocated_input":
                    if (r.Kind != "" || r.SceneId != "" || r.Words.Length != 1 || !Text(r.Words[0], 80)) throw Invalid();
                    limit = MaximumRelatedRead;
                    break;
                default: throw Invalid();
            }
            if (r.Read != Math.Min(r.Total, limit) || r.IncludedIds.Any(id => id is null || !evidence.TryGetValue(id, out var e) ||
                e.SceneId != r.SceneId || r.Kind != "" && e.Kind != r.Kind ||
                !r.Words.All(w => Contains(e.Name, w) || Contains(e.Summary, w)))) throw Invalid();
        }
        if (c.PublicReads.Count(r => r.Scope == "current_scene_npcs") != 1 ||
            c.PublicReads.Count(r => r.Scope == "current_scene_records") != 1 ||
            c.PublicReads.Count(r => r.Scope == "unlocated_input") != c.InputTermsQueried ||
            c.PublicReads.Where(r => r.Scope == "unlocated_npc").Select(r => r.Words[0]).Distinct(StringComparer.Ordinal).Count() != value.People.Length ||
            !c.PublicReads.SelectMany(r => r.IncludedIds).ToHashSet(StringComparer.Ordinal).SetEquals(evidence.Keys) ||
            value.PublicEvidence.Count(e => e.SceneId == value.SceneId) > MaximumSceneEvidence ||
            value.PublicEvidence.Count(e => e.SceneId == "") > MaximumUnlocatedEvidence) throw Invalid();
    }

    private static HarnessSceneEvidence Evidence(WorldMemoryEntry e) => new(e.Id, e.Kind, e.Name, e.Summary,
        e.Status, e.SceneId, e.Visibility, e.Revision, e.OriginSequence, e.UpdatedSequence, e.Source, Nature(e.Source));
    private static HarnessSceneSource Source(WorldMemoryEntry e) => new("world_memory", e.Id, e.Source,
        Nature(e.Source), e.Revision, e.OriginSequence, e.UpdatedSequence);
    private static HarnessSceneSource Source(HarnessSceneEvidence e) => new("world_memory", e.Id, e.Source,
        e.Nature, e.Revision, e.OriginSequence, e.UpdatedSequence);
    private static string Nature(string source) => source switch
    {
        "preparation" => "authored",
        "dm" or "host" => "host_record",
        _ => "model_record"
    };
    private static string PersonId(HarnessSceneSource source) => (source.Origin == "static_npc" ? "npc:" : "memory:") + source.Id;
    private static string NameKey(string name) => WorldMemoryIndex.Key(name.Trim());
    private static bool Contains(string text, string word) => WorldMemoryIndex.Key(text).Contains(WorldMemoryIndex.Key(word), StringComparison.Ordinal);
    private static bool Relates(string name, string summary, string person) => Contains(name, person) || Contains(summary, person);
    private static string Excerpt(string text, int limit)
    {
        if (text.Length <= limit) return text;
        if (char.IsHighSurrogate(text[limit - 1]) && char.IsLowSurrogate(text[limit])) limit--;
        return text[..limit];
    }
    private static string[] PrioritizedInputTerms(string input, AdventureContext context, IEnumerable<string> people)
    {
        // Retrieval hints only. Public names are already supplied to this run; neither
        // these terms nor user-supplied destinations establish discovery or authority.
        var names = context.KnownScenes.Select(s => s.Title).Concat(context.KnownMemory.Select(m => m.Name)).Concat(people)
            .Where(name => name.Length is >= 2 and <= 80 && input.Contains(name, StringComparison.OrdinalIgnoreCase))
            .Distinct(StringComparer.OrdinalIgnoreCase).OrderByDescending(name => name.Length)
            .ThenBy(name => input.IndexOf(name, StringComparison.OrdinalIgnoreCase));
        var targets = Regex.Matches(input, @"(?:前往|走向|寻找|拜访|询问|查看)[\s：:]*(?<target>[\p{L}\p{N}]{2,40})", RegexOptions.CultureInvariant)
            .Select(match => match.Groups["target"].Value);
        return names.Concat(targets).Concat(InputTerms(input)).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
    }
    private static string[] InputTerms(string input)
    {
        var terms = new List<string>();
        foreach (Match match in Regex.Matches(input, @"[\p{L}\p{N}]+", RegexOptions.CultureInvariant))
        {
            string word = match.Value;
            if (word.Length is >= 2 and <= 80) terms.Add(word);
            // Literal Chinese bigrams only improve retrieval; they never classify a
            // statement as a promise, a relationship, a deadline or a world fact.
            for (int i = 0; i + 1 < word.Length; i++)
                if (word[i] is >= '\u3400' and <= '\u9fff' && word[i + 1] is >= '\u3400' and <= '\u9fff')
                    terms.Add(word.Substring(i, 2));
        }
        return terms.Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
    }
    private static bool ValidEvidence(HarnessSceneEvidence? e, HarnessSceneContext context, bool dmOnly) =>
        e is not null && Id(e.Id) && (e.Kind is "npc" or "quest" or "place" or "clue") && Text(e.Name, 80) &&
        Text(e.Summary, 800, multiline: true) && (e.Status is "known" or "active" or "resolved") &&
        (dmOnly ? e.Visibility == "host" && e.SceneId == context.SceneId
            : (e.Visibility is "public" or "arrival") && (e.SceneId == "" || e.SceneId == context.SceneId)) &&
        e.Revision >= 1 && e.OriginSequence >= 0 && e.UpdatedSequence >= e.OriginSequence && e.UpdatedSequence <= context.Version &&
        Text(e.Source, 80) && e.Nature == Nature(e.Source);
    private static bool ValidSource(HarnessSceneSource? source, int version)
    {
        if (source is null || !Id(source.Id) || !Text(source.Source, 80)) return false;
        if (source.Origin == "static_npc") return source.Source == "adventure" && source.Nature == "authored" &&
            source.Revision is null && source.OriginSequence is null && source.UpdatedSequence is null;
        return source.Origin == "world_memory" && source.Nature == Nature(source.Source) && source.Revision is >= 1 &&
            source.OriginSequence is { } origin && origin >= 0 && source.UpdatedSequence is { } updated && updated >= origin && updated <= version;
    }
    private static bool Id(string? id) => id is not null && Text(id, 64) && char.IsAsciiLetterOrDigit(id[0]) &&
        id.All(ch => char.IsAsciiLetterOrDigit(ch) || ch is '.' or '_' or '-');
    private static bool Text(string? text, int maximum, bool multiline = false) => !string.IsNullOrWhiteSpace(text) &&
        text.Length <= maximum && !text.Any(ch => char.IsControl(ch) && !(multiline && ch is '\n' or '\r' or '\t'));
    private static InvalidDataException Invalid() => new("Invalid harness scene working context.");
    private sealed record PersonRecord(string Name, string Summary, HarnessSceneSource Source);
    private sealed record MemoryRead(string Scope, string Kind, string SceneId, string[] Words, WorldMemorySlice Page);
}
