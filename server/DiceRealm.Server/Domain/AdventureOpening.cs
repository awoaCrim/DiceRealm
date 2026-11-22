using System.Text.Json.Serialization;

namespace DiceRealm.Server.Domain;

// Author-declared eligible entry places and a main-story anchor. Coordinates are not
// distances; only initially traversable authored exits supply the distance evidence.
public sealed record ContentOpening(string MainSceneId, string[] EntrySceneIds);
public sealed class AdventureOpeningState
{
    public required string SceneId { get; init; }
    public string PublicText { get; set; } = "";
    public int PublicSequence { get; set; }
    public List<AdventureOpeningEntry> Entries { get; init; } = [];
}
public sealed record AdventureOpeningEntry(string ActorId, string EventId, int Sequence, string PrivateText);
public sealed record AdventureOpeningView(string SceneId, string PublicText, int PublicSequence, bool Needed, PrivateStoryPart[] PrivateParts)
{
    // Later entrants' public arrival lines (contract 58), in order; absent when there are none.
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public OpeningArrival[]? Arrivals { get; init; }
}
public sealed record OpeningArrival(string ActorId, int Sequence, string Text);

public static class AdventureOpenings
{
    public static string SelectScene(AdventureDocument document)
    {
        if (document.Opening is not { } opening) return document.StartSceneId;
        var scenes = document.Scenes.ToDictionary(s => s.Id, StringComparer.Ordinal);
        if (!scenes.ContainsKey(opening.MainSceneId ?? "") || opening.EntrySceneIds is not { Length: > 0 and <= 32 } ||
            opening.EntrySceneIds.Distinct(StringComparer.Ordinal).Count() != opening.EntrySceneIds.Length ||
            opening.EntrySceneIds.Any(id => id is null || !scenes.ContainsKey(id)))
            throw new GameException("invalid_content", "opening 必须指定真实主线场景和不重复的可入场地点。");
        long Distance(string start)
        {
            var distance = new Dictionary<string, long>(StringComparer.Ordinal) { [start] = 0 };
            var queue = new PriorityQueue<string, long>(); queue.Enqueue(start, 0);
            while (queue.TryDequeue(out var current, out long cost))
            {
                if (cost != distance[current]) continue;
                if (current == opening.MainSceneId) return cost;
                foreach (var exit in scenes[current].Exits.Where(e => e.When.All.All(f => f == "visited:" + start) &&
                    (e.When.Any.Length == 0 || e.When.Any.Contains("visited:" + start)) && !e.When.None.Contains("visited:" + start)))
                {
                    long next = cost + exit.Seconds;
                    if (!distance.TryGetValue(exit.Target, out long prior) || next < prior)
                    { distance[exit.Target] = next; queue.Enqueue(exit.Target, next); }
                }
            }
            return long.MaxValue;
        }
        var chosen = opening.EntrySceneIds.Select((id, order) => new { Id = id, Order = order, Distance = Distance(id) })
            .OrderBy(s => s.Distance).ThenBy(s => s.Order).First();
        if (chosen.Distance == long.MaxValue || string.IsNullOrWhiteSpace(scenes[chosen.Id].Arrival))
            throw new GameException("invalid_content", "opening 的入场地点须可沿初始路线到达主线，并有公开现场资料。");
        return chosen.Id;
    }
    public static void ValidateState(Campaign c)
    {
        if (c.Opening is not { } opening) return;
        if (c.Adventure?.Opening is null || opening.SceneId != SelectScene(c.Adventure) || opening.PublicText is null ||
            opening.PublicText.Length > 4096 || opening.Entries is null || opening.PublicSequence < 0 || opening.PublicSequence > c.Version ||
            opening.PublicSequence == 0 && opening.PublicText.Length != 0 ||
            (opening.PublicSequence == 0 ? opening.Entries.Count != 0 : opening.Entries.FirstOrDefault()?.Sequence != opening.PublicSequence) ||
            opening.Entries.Any(e => e is null) ||
            opening.Entries.Select(e => e.ActorId).Distinct(StringComparer.Ordinal).Count() != opening.Entries.Count ||
            opening.Entries.Select(e => e.EventId).Distinct(StringComparer.Ordinal).Count() != opening.Entries.Count ||
            opening.Entries.Any(e => e.Sequence < opening.PublicSequence || e.Sequence > c.Version ||
                !Guid.TryParseExact(e.EventId, "D", out _) || string.IsNullOrEmpty(e.ActorId) || e.PrivateText is null || e.PrivateText.Length > 1024))
            throw new GameException("invalid_opening", "开场记录损坏；原存档保留。", 409);
    }
    public static bool Needed(Campaign c) => c.Opening is { } opening && PartyEngine.HasCharacter(c) &&
        !opening.Entries.Any(e => e.ActorId == c.ActingActorId);
    public static AdventureOpeningView? View(Campaign c, IEnumerable<GameEvent>? events = null)
    {
        if (c.Opening is not { } opening) return null;
        var parts = opening.Entries.Where(e => e.PrivateText.Length > 0 && ActionUnderstanding.MaySeePrivate(c, e.ActorId))
            .Select(e => PrivateStories.Part(c, "event", e.EventId, e.Sequence, e.ActorId, e.PrivateText)!)
            .Concat((events ?? c.Events).Where(e => opening.Entries.Any(entry => entry.EventId == e.Id && entry.Sequence == e.Sequence))
                .SelectMany(e => PrivateStories.Parts(c, e)))
            .DistinctBy(p => p.Source).ToArray();
        var arrivals = (events ?? c.Events).Where(e => e.Sequence != opening.PublicSequence && e.Narrative.Length > 0 &&
                opening.Entries.Any(entry => entry.EventId == e.Id && entry.Sequence == e.Sequence))
            .OrderBy(e => e.Sequence).Select(e => new OpeningArrival(e.ActorId, e.Sequence, e.Narrative)).ToArray();
        return new(opening.SceneId, opening.PublicText, opening.PublicSequence, Needed(c), parts) { Arrivals = arrivals.Length > 0 ? arrivals : null };
    }
}
