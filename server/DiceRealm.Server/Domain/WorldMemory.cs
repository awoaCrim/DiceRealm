namespace DiceRealm.Server.Domain;

// Public narrative knowledge is separate from authored facts, inventories, routes and rules.
// SceneId is an optional known-place association, never an invented image coordinate.
// Visibility is host | public | arrival; arrival entries also carry the scene whose visit makes
// them visible to players. Legacy records default to public and keep their previous projection.
public sealed record WorldMemoryEntry(string Id, string Kind, string Name, string Summary, string Status, string SceneId,
    int Revision, int OriginSequence, int UpdatedSequence, string ActorId, string Source, bool Hidden = false,
    string Visibility = "public", string RevealSceneId = "");
public sealed record WorldMemoryProposal(string Id, string Kind, string Name, string Summary, string Status, string SceneId);
public sealed record CorrectWorldMemoryRequest(string RequestId, int ExpectedVersion, string MemoryId, int Revision,
    string Name, string Summary, string Status, bool Hidden, string Reason);
public sealed record AdventureCorrection(int OriginSequence, string Text, string Reason, string CorrectedBy, DateTimeOffset CorrectedAt, int Sequence);
public sealed record CorrectAdventureRequest(string RequestId, int ExpectedVersion, int OriginSequence, string Text, string Reason);

public static class WorldMemories
{
    public const int MaximumEntries = 8192;
    public const int SnapshotLimit = 256;
    public const int MaximumProposals = 6;
    // Host sees every entry; players see public entries, plus arrival entries only after the
    // reveal scene has been visited. Hidden stays host-only.
    public static bool IsPublic(Campaign c, WorldMemoryEntry entry) => !entry.Hidden &&
        (entry.Visibility == "public" || entry.Visibility == "arrival" &&
            !string.IsNullOrEmpty(entry.RevealSceneId) && c.VisitedScenes.Contains(entry.RevealSceneId));
    public static WorldMemoryEntry? Find(Campaign c, string id) => WorldMemoryIndex.For(c).Find(id);
    public static WorldMemorySlice Read(Campaign c, string[]? words = null, string kind = "", int offset = 0, int limit = 32,
        bool host = false, bool localFirst = true, string[]? scenes = null) => WorldMemoryIndex.For(c).Read(new(words ?? [], kind,
            host && PartyEngine.IsHost(c), c.VisitedScenes.ToArray(), localFirst ? c.SceneId : "#no-preference", scenes, offset, limit));
    public static WorldMemoryEntry[] Public(Campaign c) => Read(c, limit: SnapshotLimit).Entries;
    public static WorldMemoryEntry[] View(Campaign c) => Read(c, limit: SnapshotLimit, host: true, localFirst: false).Entries;
    public static WorldMemoryPaging? Paging(Campaign c)
    {
        var page = Read(c, limit: 0, host: true, localFirst: false);
        return page.Total > SnapshotLimit ? new(page.Total, SnapshotLimit) : null;
    }

    // Imported preparation knowledge becomes non-mechanical public world memory on activation.
    // It is seeded once; later AI or DM corrections keep their own ids and revisions.
    public static void Seed(Campaign c, int sequence)
    {
        var entries = c.Adventure?.InitialKnowledge;
        if (entries is null || entries.Length == 0) return;
        var index = WorldMemoryIndex.For(c);
        foreach (var entry in entries)
        {
            if (index.Find(entry.Id) is not null) continue;
            if (index.Count >= MaximumEntries || index.NameExists(entry.Kind, entry.Name, entry.Id))
                throw new GameException("world_memory_capacity", "初始世界信息容量或名称冲突，未启用。", 409);
            index.Upsert(new(entry.Id, entry.Kind, entry.Name, entry.Summary, "known", entry.SceneId, 1, 0,
                sequence, PartyEngine.HostId, "preparation", Hidden: false, Visibility: entry.Visibility,
                RevealSceneId: entry.RevealSceneId));
        }
    }

    public static WorldMemoryEntry[] Plan(Campaign c, WorldMemoryProposal[] proposals, IReadOnlySet<string> offeredIds,
        IReadOnlySet<string> knownScenes, int originSequence, string source, int namingVersion = NpcNames.Version)
    {
        if (proposals is null || proposals.Length > MaximumProposals || proposals.Any(p => p is null))
            throw new GameException("invalid_world_memory", "世界信息提议的数量或结构不合法。");
        var planned = new List<WorldMemoryEntry>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var p in proposals)
        {
            if (p.Id is null || p.SceneId is null || p.Kind is not ("npc" or "quest" or "place" or "clue"))
                throw new GameException("invalid_world_memory", "世界信息只能记录人物、任务、地点或线索。");
            string name = Text(p.Name, 80), summary = Text(p.Summary, 800, multiline: true);
            Status(p.Status);
            if (p.SceneId.Length > 0 && !knownScenes.Contains(p.SceneId))
                throw new GameException("invalid_world_memory", "只能关联已知的公开地点，未知位置必须留空。");
            WorldMemoryEntry? existing = null;
            if (p.Id.Length > 0)
            {
                if (!offeredIds.Contains(p.Id) || (existing = Find(c, p.Id)) is null || !IsPublic(c, existing) || existing.Kind != p.Kind)
                    throw new GameException("invalid_world_memory", "只能更新此次上下文中提供的同类公开信息。");
                if (!seen.Add(p.Id)) throw new GameException("invalid_world_memory", "同一信息不能重复更新。");
            }
            if (namingVersion >= NpcNames.Version && existing is null && p.Kind == "npc" && NpcNames.IsGeneric(name))
                throw new GameException("invalid_world_memory", "新人物须使用个体名字或绰号；已有棋盘人物请复用工具返回的实际名字，不能只用类型或编号。");
            if (p.SceneId.Length > 0 && c.WorldAtlas?.Places.Any(place => place.MemoryId == p.Id) == true)
                throw new GameException("invalid_world_memory", "此地点已拥有独立路线，不能用文字关联把它移动到另一个地点。");
            if (planned.Any(m => m.Kind == p.Kind && WorldMemoryIndex.Key(m.Name) == WorldMemoryIndex.Key(name)) || WorldMemoryIndex.For(c).NameExists(p.Kind, name, p.Id))
                throw new GameException("invalid_world_memory", "同名信息已存在，请使用已提供的引用更新，不能重复建立。");
            // An automatically repeated observation is not new evidence. Validate it first,
            // then preserve its original revision, actor, source and ordering when unchanged.
            if (existing is not null && existing.Name == name && existing.Summary == summary &&
                existing.Status == p.Status && existing.SceneId == p.SceneId) continue;
            planned.Add(new(existing?.Id ?? Guid.NewGuid().ToString(), p.Kind, name, summary, p.Status, p.SceneId,
                (existing?.Revision ?? 0) + 1, existing?.OriginSequence ?? originSequence, c.Version + 1, c.ActingActorId, source,
                Visibility: existing?.Visibility ?? "public", RevealSceneId: existing?.RevealSceneId ?? ""));
        }
        if (WorldMemoryIndex.For(c).Count + planned.Count(m => Find(c, m.Id) is null) > MaximumEntries)
            throw new GameException("world_memory_capacity", "公开冒险信息已达当前容量，未应用新的提议。", 409);
        return planned.ToArray();
    }
    public static void Apply(Campaign c, WorldMemoryEntry[] plan)
    {
        foreach (var entry in plan) WorldMemoryIndex.For(c).Upsert(entry);
    }
    public static Resolution Correct(Campaign c, CorrectWorldMemoryRequest request)
    {
        PartyEngine.RequireHost(c);
        var current = Find(c, request.MemoryId);
        if (current is null || current.Revision != request.Revision)
            throw new GameException("world_memory_changed", "世界信息已变化，请读取当前记录再纠正。", 409);
        string name = Text(request.Name, 80), summary = Text(request.Summary, 800, multiline: true), reason = Text(request.Reason, 1000, multiline: true);
        Status(request.Status);
        if (WorldMemoryIndex.For(c).NameExists(current.Kind, name, current.Id))
            throw new GameException("invalid_world_memory", "同类信息名称不能重复。");
        WorldMemoryIndex.For(c).Upsert(current with { Name = name, Summary = summary, Status = request.Status, Hidden = request.Hidden,
            Revision = current.Revision + 1, UpdatedSequence = c.Version + 1, ActorId = c.ActingActorId, Source = "dm" });
        return new("resolved", "world.correct", "DM 更正冒险信息：" + name + "。" + summary + "。状态：" + request.Status +
            (request.Hidden ? "；已从当前世界信息中隐藏。" : "。") + "理由：" + reason, null, ["memory:" + current.Id, "origin:" + current.OriginSequence]);
    }
    public static string Text(string? value, int maximum, bool multiline = false)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > maximum || value.Any(c => char.IsControl(c) && !(multiline && c is '\n' or '\r' or '\t')))
            throw new GameException("invalid_world_memory", "冒险信息正文缺失、过长或含不允许的字符。");
        return value.Trim();
    }
    private static void Status(string? status)
    {
        if (status is not ("known" or "active" or "resolved")) throw new GameException("invalid_world_memory", "信息状态只支持 known、active 或 resolved；它不会结算规则或奖励。");
    }
}
