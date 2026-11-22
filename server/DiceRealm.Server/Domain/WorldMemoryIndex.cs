namespace DiceRealm.Server.Domain;

// A request-scoped port, not a serialized collection. The persistent implementation is
// attached only inside the authorized campaign gate; pure domain fixtures use the list.
public interface IWorldMemoryIndex
{
    int Count { get; }
    WorldMemoryEntry? Find(string id);
    bool NameExists(string kind, string name, string exceptId);
    WorldMemorySlice Read(WorldMemoryQuery query);
    void Upsert(WorldMemoryEntry entry);
}

public sealed record WorldMemoryQuery(string[] Words, string Kind, bool IncludePrivate, string[] VisitedScenes,
    string PreferredScene, string[]? Scenes, int Offset, int Limit);
public sealed record WorldMemorySlice(WorldMemoryEntry[] Entries, int Total, int? NextOffset);
public sealed record WorldMemoryPage(int Version, string Scope, WorldMemoryEntry[] Entries, int Total, int? NextOffset);
public sealed record WorldMemoryPaging(int Total, int? NextOffset);

public static class WorldMemoryIndex
{
    public static IWorldMemoryIndex For(Campaign c) => c.WorldMemoryIndex ?? new ListIndex(c.WorldMemory);
    public static string Key(string text) => text.ToUpperInvariant();
    public static bool Matches(WorldMemoryEntry e, WorldMemoryQuery q) =>
        (q.IncludePrivate || !e.Hidden && (e.Visibility == "public" || e.Visibility == "arrival" && q.VisitedScenes.Contains(e.RevealSceneId))) &&
        (q.Kind == "" || e.Kind == q.Kind) && (q.Scenes is null || q.Scenes.Contains(e.SceneId)) &&
        q.Words.All(w => Key(e.Name).Contains(Key(w), StringComparison.Ordinal) || Key(e.Summary).Contains(Key(w), StringComparison.Ordinal));

    // UTF-16 units are encoded before indexing, including surrogate units. SQL receives
    // safe ASCII tokens, and the final normalized substring predicate verifies candidates.
    public static string[] Tokens(string text)
    {
        text = Key(text);
        var result = new HashSet<string>(StringComparer.Ordinal);
        for (int i = 0; i < text.Length; i++)
        {
            result.Add("u" + ((int)text[i]).ToString("X4"));
            if (i + 1 < text.Length) result.Add("b" + ((int)text[i]).ToString("X4") + ((int)text[i + 1]).ToString("X4"));
        }
        return result.ToArray();
    }
    public static void ValidateLegacy(List<WorldMemoryEntry>? entries, int version)
    {
        if (entries is null || entries.Count > WorldMemories.MaximumEntries) throw Invalid();
        // Validate nullable deserialized fields before using them as dictionary/index keys.
        foreach (var entry in entries) Validate(entry, version);
        if (entries.Select(e => e.Id).Distinct(StringComparer.Ordinal).Count() != entries.Count ||
            entries.Select(e => (e.Kind, Key(e.Name))).Distinct().Count() != entries.Count) throw Invalid();
    }
    public static void Validate(WorldMemoryEntry e, int version)
    {
        bool Text(string? s, int max, bool empty = false) => s is not null && s.Length <= max && (empty || !string.IsNullOrWhiteSpace(s)) &&
            !s.Any(ch => char.IsControl(ch) && ch is not ('\n' or '\r' or '\t'));
        if (e is null || !Text(e.Id, 64) || !char.IsAsciiLetterOrDigit(e.Id[0]) || !e.Id.All(ch => char.IsAsciiLetterOrDigit(ch) || ch is '-' or '_' or '.') ||
            e.Kind is not ("npc" or "quest" or "place" or "clue") || !Text(e.Name, 80) || !Text(e.Summary, 800) ||
            e.Status is not ("known" or "active" or "resolved") || !Text(e.SceneId, 80, true) ||
            e.Revision < 1 || e.OriginSequence < 0 || e.UpdatedSequence < e.OriginSequence || e.UpdatedSequence > version ||
            !Text(e.ActorId, 80) || !Text(e.Source, 80) || e.Visibility is not ("public" or "host" or "arrival") ||
            !Text(e.RevealSceneId, 80, true) || e.Visibility == "arrival" && e.RevealSceneId.Length == 0)
            throw Invalid();
    }
    public static GameException Invalid() => new("invalid_world_memory_store", "世界信息存档格式或索引损坏，未覆盖原记录。请检查匹配版本和备份。", 409);

    private sealed class ListIndex(List<WorldMemoryEntry> entries) : IWorldMemoryIndex
    {
        public int Count => entries.Count;
        public WorldMemoryEntry? Find(string id) => entries.FirstOrDefault(e => e.Id == id);
        public bool NameExists(string kind, string name, string exceptId) => entries.Any(e => e.Id != exceptId && e.Kind == kind && Key(e.Name) == Key(name));
        public WorldMemorySlice Read(WorldMemoryQuery q)
        {
            var matches = entries.Where(e => Matches(e, q)).OrderByDescending(e => e.SceneId == q.PreferredScene)
                .ThenByDescending(e => e.UpdatedSequence).ThenBy(e => e.Id, StringComparer.Ordinal).ToArray();
            var page = matches.Skip(q.Offset).Take(q.Limit).ToArray();
            return new(page, matches.Length, q.Offset + page.Length < matches.Length ? q.Offset + page.Length : null);
        }
        public void Upsert(WorldMemoryEntry e)
        {
            int index = entries.FindIndex(m => m.Id == e.Id);
            if (index < 0) entries.Add(e); else entries[index] = e;
        }
    }
}
