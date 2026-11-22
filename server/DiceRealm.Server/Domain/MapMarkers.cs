namespace DiceRealm.Server.Domain;

// Private projection input. Never expose this list directly to a player or derive visibility from pins.
public sealed record MapMarkerTarget(string Kind, string TargetId, string Label, string Summary, string State, bool PlayerVisible,
    string AnchorSceneId = "", int UpdatedSequence = 0);

public static class MapMarkers
{
    public static MapMarkerTarget[] Targets(Campaign c)
    {
        if (!ContentRuntime.Ready(c)) return [];
        var nodes = Adventure.Map(c, Adventure.Choices(c)).Nodes.ToDictionary(n => n.Id);
        var world = ContentRuntime.World(c);
        var npcs = world.Npcs.ToDictionary(n => n.Id);
        var quests = world.Quests.ToDictionary(q => q.Id);
        var result = new List<MapMarkerTarget>();
        foreach (var scene in c.Adventure!.Scenes)
        {
            nodes.TryGetValue(scene.Id, out var node);
            result.Add(new("scene", scene.Id, node?.Title ?? scene.Title,
                node is null ? "" : scene.Id == c.SceneId ? Adventure.Current(c).Summary : node.Hint,
                node?.State ?? "hidden", node is not null));
        }
        foreach (var npc in c.Adventure.Npcs)
        {
            npcs.TryGetValue(npc.Id, out var visible);
            // A placed annotation is not NPC tracking; in particular never reveal their hidden location.
            result.Add(new("npc", npc.Id, visible?.Name ?? npc.Name, visible?.Summary ?? "",
                visible is null ? "hidden" : visible.Met ? "met" : "known", visible is not null));
        }
        foreach (var quest in c.Adventure.Quests)
        {
            quests.TryGetValue(quest.Id, out var visible);
            result.Add(new("quest", quest.Id, visible?.Title ?? quest.Title, visible?.Summary ?? "",
                visible?.Status ?? "hidden", visible is not null));
        }
        foreach (var place in c.WorldAtlas?.Places ?? [])
        {
            nodes.TryGetValue(place.Id, out var node);
            result.Add(new("scene", place.Id, node?.Title ?? "未公开地点", node?.Hint ?? "", node?.State ?? "hidden", node is not null));
        }
        // Only an explicitly PUBLIC record's own known association is an anchor. Authored NPC
        // locations may be secret, and an image pin is not permission to track those positions.
        foreach (var memory in WorldMemories.Read(c, limit: 128, localFirst: false, scenes: nodes.Keys.ToArray()).Entries)
            result.Add(new("memory", memory.Id, memory.Name, memory.Summary, memory.Status, true, memory.SceneId, memory.UpdatedSequence));
        return result.ToArray();
    }

    public static MapMarkerView[] Automatic(MapMarker[] markers, MapMarkerTarget[]? targets, bool host)
    {
        var lookup = (targets ?? []).ToDictionary(t => (t.Kind, t.TargetId));
        var anchors = markers.Where(m => m.Kind == "scene" && (host || m.Visibility == "player") &&
                lookup.TryGetValue((m.Kind, m.TargetId), out var target) && target.PlayerVisible)
            .OrderBy(m => m.Visibility != "player").ThenBy(m => m.Id, StringComparer.Ordinal)
            .GroupBy(m => m.TargetId).ToDictionary(g => g.Key, g => g.First());
        return (targets ?? []).Where(t => t.Kind == "memory" && t.PlayerVisible && anchors.ContainsKey(t.AnchorSceneId))
            .OrderByDescending(t => t.UpdatedSequence).ThenBy(t => t.TargetId, StringComparer.Ordinal).Take(128).Select(t =>
            {
                var anchor = anchors[t.AnchorSceneId];
                var hash = System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes("automatic-memory:" + anchor.Id + ":" + t.TargetId));
                string id = new Guid(hash.AsSpan(0, 16)).ToString();
                return new MapMarkerView(id, "memory", t.TargetId, anchor.X, anchor.Y, anchor.Visibility,
                    t.Label, t.Summary + "\n公开记录关联：" + lookup[("scene", t.AnchorSceneId)].Label + "。位置沿用地点标注，不表示人物实时坐标。", t.State);
            }).ToArray();
    }

    public static MapMarkerView[] Project(MapMarker[] markers, MapMarkerTarget[]? targets, bool host)
    {
        var lookup = (targets ?? []).ToDictionary(t => (t.Kind, t.TargetId));
        return markers.Select(marker =>
        {
            lookup.TryGetValue((marker.Kind, marker.TargetId), out var target);
            if (!host && (marker.Visibility != "player" || target?.PlayerVisible != true)) return null;
            return new MapMarkerView(marker.Id, marker.Kind, marker.TargetId, marker.X, marker.Y, marker.Visibility,
                target?.Label ?? "关联对象已不可用", target?.Summary ?? "", target?.State ?? "unavailable");
        }).OfType<MapMarkerView>().ToArray();
    }

    public static void Validate(MapMarker[]? markers, MapMarkerTarget[] targets)
    {
        var ids = new HashSet<Guid>();
        var allowed = targets.Select(t => (t.Kind, t.TargetId)).ToHashSet();
        if (markers is null || markers.Length > 128 || markers.Any(m => m is null ||
            !Guid.TryParseExact(m.Id, "D", out var id) || id == Guid.Empty || !ids.Add(id) ||
            m.Kind is not ("scene" or "npc" or "quest") || m.Visibility is not ("gm" or "player") ||
            !allowed.Contains((m.Kind, m.TargetId)) || !double.IsFinite(m.X) || !double.IsFinite(m.Y) ||
            m.X is < 0 or > 1 || m.Y is < 0 or > 1))
            throw new GameException("invalid_map_markers", "标记须关联本战役已启用的地点、人物或任务；编号须为不重复的非空 UUID，坐标须在 0 至 1，权限为 gm/player，最多 128 项。空列表移除全部标记。");
    }
}
