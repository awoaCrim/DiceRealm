namespace DiceRealm.Server.Domain;

// Explicitly confirmed topology, separate from the immutable authored adventure and prose.
public sealed record WorldPlace(string Id, string MemoryId);
public sealed record WorldRoute(string Id, string From, string To, int Seconds, bool Bidirectional, bool Open,
    int Revision, int OriginSequence, int UpdatedSequence, string ActorId, string Reason);
public sealed class WorldAtlas
{
    public int SchemaVersion { get; init; } = 1;
    public List<WorldPlace> Places { get; init; } = [];
    public List<WorldRoute> Routes { get; init; } = [];
}
public sealed record WorldRouteProposal(string RouteId, string SceneId, string MemoryId, int Seconds, bool Bidirectional,
    bool Open, string Reason);
public sealed record WorldRoutePlan(WorldRoute Route, WorldPlace? Place, int PreviousRevision, int MemoryRevision);
public sealed record WorldRouteView(string Id, string From, string FromTitle, string To, string ToTitle, int Seconds,
    bool Bidirectional, bool Open, int Revision, string Reason, int UpdatedSequence);

// Model v28 read projection. Only dynamic routes have a writable route ID.
public sealed record KnownWorldRoute(string Source, string Id, string From, string FromTitle, string To,
    string ToTitle, int Seconds, bool Open, bool Bidirectional, bool CanTravel, bool Editable);

public static class WorldRoutes
{
    public const int MaximumPlaces = 512, MaximumRoutes = 2048;

    public static void ValidateState(Campaign c)
    {
        if (c.WorldAtlas is not { } atlas) return;
        bool BadText(string? text, int max) => string.IsNullOrWhiteSpace(text) || text.Length > max ||
            text.Any(ch => char.IsControl(ch) && ch is not ('\n' or '\r' or '\t'));
        if (atlas.SchemaVersion != 1 || atlas.Places is null || atlas.Routes is null || atlas.Places.Count > MaximumPlaces || atlas.Routes.Count > MaximumRoutes ||
            atlas.Places.Any(p => p is null || p.Id is null || !p.Id.StartsWith("world-", StringComparison.Ordinal) ||
                !Guid.TryParseExact(p.Id[6..], "N", out _) || c.Adventure?.Scenes.Any(s => s.Id == p.Id) == true ||
                WorldMemories.Find(c, p.MemoryId)?.Kind != "place") ||
            atlas.Places.Select(p => p.Id).Distinct(StringComparer.Ordinal).Count() != atlas.Places.Count ||
            atlas.Places.Select(p => p.MemoryId).Distinct(StringComparer.Ordinal).Count() != atlas.Places.Count)
            throw InvalidState();
        var nodes = (c.Adventure?.Scenes.Select(s => s.Id) ?? []).Concat(atlas.Places.Select(p => p.Id)).ToHashSet(StringComparer.Ordinal);
        var pairs = new HashSet<(string, string)>();
        foreach (var r in atlas.Routes)
        {
            if (r is null || !Guid.TryParseExact(r.Id, "D", out var id) || id == Guid.Empty || !nodes.Contains(r.From) || !nodes.Contains(r.To) || r.From == r.To ||
                r.Seconds is < 1 or > 604800 || r.Revision < 1 || r.OriginSequence < 1 || r.UpdatedSequence < r.OriginSequence || r.UpdatedSequence > c.Version ||
                r.ActorId != PartyEngine.HostId && !c.PartyMembers.Any(m => m.Id == r.ActorId) || BadText(r.Reason, 500) ||
                !pairs.Add(string.CompareOrdinal(r.From, r.To) < 0 ? (r.From, r.To) : (r.To, r.From)) ||
                c.Adventure?.Scenes.Any(s => s.Exits.Any(e => s.Id == r.From && e.Target == r.To || s.Id == r.To && e.Target == r.From)) == true)
                throw InvalidState();
        }
        if (atlas.Routes.Select(r => r.Id).Distinct(StringComparer.OrdinalIgnoreCase).Count() != atlas.Routes.Count) throw InvalidState();
    }
    private static GameException InvalidState() => new("invalid_world_atlas", "世界路线存档版本或引用损坏，未修改原记录。请核对匹配版本与备份。", 409);

    private static WorldMemoryEntry? PublicMemory(Campaign c, string id) => WorldMemories.Find(c, id) is { } m && WorldMemories.IsPublic(c, m) ? m : null;

    public static ContentScene? Scene(Campaign c, string id)
    {
        var place = c.WorldAtlas?.Places.FirstOrDefault(p => p.Id == id);
        if (place is null) return null;
        var memory = PublicMemory(c, place.MemoryId);
        return new() { Id = place.Id, Title = memory?.Name ?? "未公开地点", Summary = memory?.Summary ?? "此地点的公开记录已被隐藏，请以当前可用路线为准。",
            Arrival = memory?.Summary ?? "", Unlocated = true };
    }
    public static bool PublicPlace(Campaign c, string id) => c.WorldAtlas?.Places.Any(p => p.Id == id &&
        PublicMemory(c, p.MemoryId)?.Kind == "place") == true;

    // Pure current knowledge. Authored remote exits are revealed only from visited sources;
    // unvisited authored descriptions and hidden memory names never enter this projection.
    public static HashSet<string> KnownScenes(Campaign c)
    {
        var known = new HashSet<string>(StringComparer.Ordinal);
        if (!ContentRuntime.Ready(c)) return known;
        var visited = c.VisitedScenes.Append(c.SceneId).ToHashSet(StringComparer.Ordinal);
        foreach (var scene in c.Adventure!.Scenes.Where(s => visited.Contains(s.Id)))
        {
            known.Add(scene.Id);
            foreach (var exit in scene.Exits.Where(e => ContentRuntime.Matches(c, e.When))) known.Add(exit.Target);
        }
        foreach (var place in c.WorldAtlas?.Places ?? [])
            if (PublicPlace(c, place.Id)) known.Add(place.Id);
        known.Add(c.SceneId);
        return known;
    }
    public static ContentExit[] Exits(Campaign c, string from)
    {
        if (!ContentRuntime.Ready(c)) return [];
        var authored = c.Adventure!.Scenes.FirstOrDefault(s => s.Id == from)?.Exits
            .Where(e => ContentRuntime.Matches(c, e.When)).ToArray() ?? [];
        var known = KnownScenes(c);
        return [..authored, ..(c.WorldAtlas?.Routes ?? []).Where(r => r.Open && (r.From == from || r.Bidirectional && r.To == from))
            .Select(r => new ContentExit(r.From == from ? r.To : r.From, new(), r.Seconds))
            .Where(e => known.Contains(e.Target) && !authored.Any(a => a.Target == e.Target))];
    }
    public static WorldRouteView[] View(Campaign c)
    {
        var known = KnownScenes(c);
        return (c.WorldAtlas?.Routes ?? []).Where(r => (r.From == c.SceneId || r.To == c.SceneId) && known.Contains(r.From) && known.Contains(r.To))
            .OrderBy(r => r.Id, StringComparer.Ordinal).Select(r => new WorldRouteView(r.Id, r.From, Adventure.ForScene(c, r.From).Title,
                r.To, Adventure.ForScene(c, r.To).Title, r.Seconds, r.Bidirectional, r.Open, r.Revision, r.Reason, r.UpdatedSequence)).ToArray();
    }
    public static KnownWorldRoute[] KnownRoutes(Campaign c)
    {
        var dynamic = View(c);
        var exits = Exits(c, c.SceneId);
        var authored = c.Adventure?.Scenes.FirstOrDefault(s => s.Id == c.SceneId)?.Exits ?? [];
        var routes = exits.Where(e => authored.Contains(e)).Select(e => new KnownWorldRoute(
            "authored", "", c.SceneId, Adventure.Current(c).Title, e.Target, Adventure.ForScene(c, e.Target).Title,
            e.Seconds, true, false, true, false));
        return routes.Concat(dynamic.Select(r => new KnownWorldRoute("dynamic", r.Id, r.From, r.FromTitle, r.To, r.ToTitle,
            r.Seconds, r.Open, r.Bidirectional, r.Open && (r.From == c.SceneId || r.Bidirectional) &&
                exits.Any(e => e.Target == (r.From == c.SceneId ? r.To : r.From)), true)))
            .OrderBy(r => r.Source, StringComparer.Ordinal).ThenBy(r => r.From, StringComparer.Ordinal)
            .ThenBy(r => r.To, StringComparer.Ordinal).ThenBy(r => r.Id, StringComparer.Ordinal).ToArray();
    }
    public static WorldRoutePlan Plan(Campaign c, WorldRouteProposal p, IReadOnlySet<string> readMemoryIds, IReadOnlySet<string> readSceneIds, int origin)
    {
        Available(c);
        if (p is null || p.RouteId is null || p.SceneId is null || p.MemoryId is null || p.RouteId.Length > 80 ||
            p.SceneId.Length > 80 || p.MemoryId.Length > 80 || p.Seconds is < 1 or > 604800)
            throw Invalid();
        string reason = WorldMemories.Text(p.Reason, 500, multiline: true);
        WorldRoute? old = null;
        WorldPlace? place = null;
        int memoryRevision = 0;
        string from = c.SceneId, to;
        if (p.RouteId.Length > 0)
        {
            old = c.WorldAtlas?.Routes.FirstOrDefault(r => r.Id == p.RouteId);
            if (p.SceneId != "" || p.MemoryId != "" || old is null || (old.From != c.SceneId && old.To != c.SceneId) ||
                !readSceneIds.Contains(old.From) || !readSceneIds.Contains(old.To)) throw Invalid();
            from = old.From; to = old.To;
        }
        else if (p.MemoryId.Length > 0)
        {
            if (p.SceneId != "" || !readMemoryIds.Contains(p.MemoryId)) throw Invalid();
            var memory = PublicMemory(c, p.MemoryId) is { Kind: "place" } found ? found : null;
            if (memory is null || memory.SceneId != "") throw Invalid();
            memoryRevision = memory.Revision;
            place = c.WorldAtlas?.Places.FirstOrDefault(x => x.MemoryId == memory.Id);
            if (place is null)
            {
                // A generic conflict reveals no private matching title or id.
                if (c.Adventure!.Scenes.Any(s => s.Title.Equals(memory.Name, StringComparison.OrdinalIgnoreCase)) ||
                    (c.WorldAtlas?.Places.Count ?? 0) >= MaximumPlaces) throw Invalid();
                place = new("world-" + Guid.NewGuid().ToString("N"), memory.Id);
            }
            to = place.Id;
        }
        else
        {
            to = p.SceneId;
            if (to == "" || !readSceneIds.Contains(to)) throw Invalid();
        }
        var route = new WorldRoute(old?.Id ?? Guid.NewGuid().ToString(), from, to, p.Seconds, p.Bidirectional, p.Open,
            (old?.Revision ?? 0) + 1, old?.OriginSequence ?? origin, c.Version + 1, c.ActingActorId, reason);
        var plan = new WorldRoutePlan(route, place, old?.Revision ?? 0, memoryRevision);
        ValidatePlan(c, plan);
        if (old is not null && old.Seconds == route.Seconds && old.Bidirectional == route.Bidirectional && old.Open == route.Open)
            throw new GameException("world_route_unchanged", "路线没有变化，不需要再次确认。", 409);
        return plan;
    }
    public static Resolution Apply(Campaign c, WorldRoutePlan plan, string intentId)
    {
        Available(c);
        ValidatePlan(c, plan);
        c.WorldAtlas ??= new();
        if (plan.Place is { } place && !c.WorldAtlas.Places.Any(p => p.Id == place.Id)) c.WorldAtlas.Places.Add(place);
        var route = plan.Route with { UpdatedSequence = c.Version + 1, ActorId = c.ActingActorId };
        int index = c.WorldAtlas.Routes.FindIndex(r => r.Id == route.Id);
        if (index < 0) c.WorldAtlas.Routes.Add(route); else c.WorldAtlas.Routes[index] = route;
        return new("resolved", "world.route", Description(c, plan) + " 已更新世界路线；没有移动队伍、经过时间、生成图片或结算奖励。", null,
            ["route:" + route.Id, "route-revision:" + route.Revision], IntentId: intentId);
    }
    public static string Description(Campaign c, WorldRoutePlan plan)
    {
        string Title(string id) => plan.Place?.Id == id
            ? PublicMemory(c, plan.Place.MemoryId)?.Name ?? "未公开地点"
            : Adventure.ForScene(c, id).Title;
        var route = plan.Route;
        return (route.Open ? "开通 " : "关闭 ") + Title(route.From) + (route.Bidirectional ? " ↔ " : " → ") + Title(route.To) +
            "；每次旅行 " + route.Seconds + " 秒。依据：" + route.Reason;
    }
    private static void Available(Campaign c)
    {
        if (c.Archived || !ContentRuntime.Ready(c) || CombatEngine.Restricted(c) || !CharacterReviews.CanAct(c) || !PartyEngine.Ready(c))
            throw new GameException("world_route_unavailable", "当前不能确认世界路线；请先处理战斗、角色状态或待处理事项。", 409);
        ContextualRolls.RequireNoPending(c);
        if (c.WorldAtlas?.SchemaVersion is not (null or 1)) throw Invalid();
    }
    private static void ValidatePlan(Campaign c, WorldRoutePlan plan)
    {
        var r = plan.Route;
        var known = KnownScenes(c);
        if (r.From == r.To || (r.From != c.SceneId && r.To != c.SceneId) || r.Seconds is < 1 or > 604800 ||
            !Guid.TryParseExact(r.Id, "D", out _) || r.ActorId != c.ActingActorId) throw Invalid();
        var existing = c.WorldAtlas?.Routes.FirstOrDefault(x => x.Id == r.Id);
        if ((existing?.Revision ?? 0) != plan.PreviousRevision || r.Revision != plan.PreviousRevision + 1 ||
            existing is not null && (existing.From != r.From || existing.To != r.To)) throw Invalid();
        if (existing is null && (c.WorldAtlas?.Routes.Count ?? 0) >= MaximumRoutes) throw Invalid();
        if (plan.Place is { } place)
        {
            var memory = PublicMemory(c, place.MemoryId) is { Kind: "place" } found ? found : null;
            if (memory is null || memory.Revision != plan.MemoryRevision || memory.SceneId != "" ||
                !place.Id.StartsWith("world-", StringComparison.Ordinal) || place.Id != r.To) throw Invalid();
            if (c.WorldAtlas?.Places.Any(p => (p.Id == place.Id || p.MemoryId == place.MemoryId) && p != place) == true) throw Invalid();
            if (c.WorldAtlas?.Places.Any(p => p.Id == place.Id) != true && ((c.WorldAtlas?.Places.Count ?? 0) >= MaximumPlaces ||
                c.Adventure!.Scenes.Any(s => s.Title.Equals(memory.Name, StringComparison.OrdinalIgnoreCase)))) throw Invalid();
            known.Add(place.Id);
        }
        if (!known.Contains(r.From) || !known.Contains(r.To)) throw Invalid();
        // Even an authored currently closed or one-way edge must never be bypassed by a new pair.
        bool Pair(string a, string b) => a == r.From && b == r.To || a == r.To && b == r.From;
        if (c.Adventure!.Scenes.Any(s => s.Exits.Any(e => Pair(s.Id, e.Target))) ||
            c.WorldAtlas?.Routes.Any(x => x.Id != r.Id && Pair(x.From, x.To)) == true) throw Invalid();
    }
    private static GameException Invalid() => new("invalid_world_route", "路线需关联本次读过的公开地点或独立地点记录，不能覆盖剧本路线、重复关系或失效依据。", 409);
}
