using System.Text.RegularExpressions;
using System.Text.Json.Serialization;
using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Application;

public sealed record ActingCharacterContext(string Name, string Species, string ClassName, string Background,
    int Level, int HitPoints, int MaxHitPoints, string[] Conditions, string[] Skills, string[] Features,
    string[] RelevantIdentity);
public sealed record KnownPersonContext(string Name, string Summary);
public sealed record RecentActionContext(string Input, string Result, string Status);
public sealed record PlayerActionContext(string Place, string Situation, ActingCharacterContext Character,
    string[] Goals, KnownPersonContext[] People, string[] KnownPlaces, RecentActionContext[] RecentActions);
public sealed record IntentContext(string Text, IntentClarification[] Clarifications, PlayerActionContext Context,
    IntentOptionView[] Candidates)
{
    [JsonIgnore] public ActionCandidate[] Commands { get; init; } = [];
}
public sealed record IntentInterpretation(string Decision, string[] CandidateIds, string Question = "", string Source = "ai");

// An explicit player-visible projection, not a generic serializer of the private campaign.
public static partial class IntentContexts
{
    public const int MaximumCandidates = 32;
    public static string Bounded(string? value, int length)
    {
        string text = value ?? "";
        return text.Length <= length ? text : text[..length];
    }
    [GeneratedRegex(@"[\p{L}\p{N}]+", RegexOptions.CultureInvariant)]
    private static partial Regex Words();
    private static HashSet<string> Terms(string text)
    {
        var terms = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (Match word in Words().Matches(text))
        {
            string value = word.Value.ToLowerInvariant();
            if (value.Length < 2) continue;
            terms.Add(value);
            // Chinese has no required word separators. Bigrams keep selection deterministic and bounded.
            if (value.Any(c => c >= 0x3400 && c <= 0x9fff))
                for (int i = 0; i < value.Length - 1; i++) terms.Add(value.Substring(i, 2));
        }
        return terms;
    }
    private static int Score(HashSet<string> terms, string value) => Terms(value).Count(terms.Contains);
    public static ActionCandidate[] SelectCandidates(ActionCandidate[] candidates, string text)
    {
        var terms = Terms(text);
        return candidates.Select((value, order) => (value, order, score: Score(terms, value.Label + " " + value.Details.TargetLabel)))
            .OrderByDescending(x => x.score).ThenBy(x => x.order).Take(MaximumCandidates).Select(x => x.value).ToArray();
    }
    public static IntentContext Build(Campaign c, string text, IntentClarification[] clarifications, ActionCandidate[] candidates, bool combatOnly = false)
        => new(text, clarifications, Player(c, text + " " + string.Join(" ", clarifications.Select(x => x.Answer)), combatOnly),
            candidates.Select(x => new IntentOptionView(x.Id, Bounded(x.Label, 120), x.Category,
                new(Bounded(x.Details.TargetLabel, 100), Bounded(x.Details.Cost, 160), Bounded(x.Details.Range, 120), Bounded(x.Details.Note, 220)))).ToArray()) { Commands = candidates };

    public static PlayerActionContext Player(Campaign c, string relatedText, bool combatOnly = false)
    {
        var terms = Terms(relatedText);
        var ch = c.ActingCharacter;
        var scene = Adventure.Current(c);
        var world = combatOnly ? null : StoryEngine.Snapshot(c);
        string[] Relevant(IEnumerable<string> values, int count, int length, bool requireMatch = false) => values
            .Select((value, order) => (value, order, score: Score(terms, value)))
            .Where(x => !requireMatch || x.score > 0).OrderByDescending(x => x.score).ThenBy(x => x.order)
            .Take(count).Select(x => Bounded(x.value, length)).ToArray();
        var identity = ch.Build?.Identity;
        var identityParts = new[] { identity?.Personality ?? "", identity?.Backstory ?? "" }
            .SelectMany(x => x.Split(['\n', '\r', '。', '！', '？', '.', '!', '?'], StringSplitOptions.RemoveEmptyEntries));
        var actor = new ActingCharacterContext(Bounded(ch.Name, 80), Bounded(ch.Species, 80), Bounded(ch.ClassName, 80),
            Bounded(ch.Background, 100), ch.Level, ch.HitPoints, ch.MaxHitPoints, ch.Conditions.Take(8).ToArray(),
            Relevant(ch.Skills, 8, 60), Relevant(ch.Features, 10, 180), Relevant(identityParts, 2, 240, requireMatch: true));
        if (combatOnly) return new(Bounded(scene.Title, 100), "当前战斗子会话；必要交接与本人可见战场见agent/combat/board。", actor, [], [], [], []);
        var goals = world!.Quests.Where(q => q.Status == "active").Take(4)
            .Select(q => Bounded(q.Title + "：" + q.Summary + " " + string.Join("；", q.Objectives.Take(4).Select(o => (o.Complete ? "已完成：" : "待完成：") + o.Text)), 320)).ToArray();
        var people = world.Npcs.Where(n => n.SceneId == scene.Id).Take(6)
            .Select(n => new KnownPersonContext(Bounded(n.Name, 80), Bounded(n.Summary, 240))).ToArray();
        var places = Adventure.Map(c, Adventure.Choices(c)).Nodes.Take(12).Select(n => Bounded(n.Title, 100)).ToArray();
        // Only actual player roots in this place/seat. Host administration and raw facts/source are not context.
        var recent = c.Events.Where(e => e.ActorId == c.ActingActorId && e.Origin?.SceneId == scene.Id && ActivityRecords.IsRoot(e))
            .TakeLast(4).Select(e => ActivityRecords.Project(c, e))
            .Select(e => new RecentActionContext(Bounded(e.Origin?.Input == "" ? e.Origin.Label : e.Origin?.Input, 240),
                Bounded(e.Ruling?.Story?.ResultText ?? e.InitialResult?.Summary, 360), e.Status)).ToArray();
        return new(Bounded(scene.Title, 100), Bounded(scene.Summary, 1000), actor, goals, people, places, recent);
    }

    public static IntentInterpretation Validate(IntentInterpretation value, IntentContext context)
    {
        if (value is null || value.Decision is not ("action" or "clarify" or "adjudicate") || value.CandidateIds is null ||
            value.CandidateIds.Length > 6 || value.CandidateIds.Distinct().Count() != value.CandidateIds.Length ||
            value.CandidateIds.Any(id => !context.Candidates.Any(c => c.Id == id)) || value.Question is null ||
            value.Question.Length > 240 || value.Question.Any(char.IsControl) ||
            value.Decision == "action" && value.CandidateIds.Length != 1 ||
            value.Decision == "clarify" && string.IsNullOrWhiteSpace(value.Question) ||
            value.Decision == "adjudicate" && value.CandidateIds.Length != 0)
            throw new InvalidDataException("Invalid structured action interpretation.");
        return value with { Question = value.Question.Trim(), Source = value.Source is "offline" or "legacy" or "unavailable" ? value.Source : "ai" };
    }
}
