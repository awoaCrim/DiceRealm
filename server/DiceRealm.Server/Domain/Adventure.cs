namespace DiceRealm.Server.Domain;

public sealed record SceneDefinition(string Id, string Title, string Summary, string Arrival, string Prompt, string[] Exits,
    string StyleProfile = "", string[]? VisualConstraints = null);

// No built-in scenario. A campaign runs the validated, version-pinned imported document.
public static class Adventure
{
    public static SceneDefinition Current(Campaign c) => ContentRuntime.Ready(c) ? ForScene(c, c.SceneId)
        : new("", "战役尚未启用", "请由主持人在工作台导入剧本与提示词包，检查后启用战役。已有的历史记录和角色数据不会被覆盖。", "", "", []);
    public static SceneDefinition ForScene(Campaign c, string sceneId)
    {
        var document = c.Adventure ?? throw new GameException("content_required", "尚未导入剧本。", 409);
        var scene = document.Scenes.FirstOrDefault(s => s.Id == sceneId) ?? WorldRoutes.Scene(c, sceneId)
            ?? throw new GameException("unknown_scene", "世界中不存在此场景。", 409);
        var variant = scene.Variants.FirstOrDefault(v => ContentRuntime.Matches(c, v.When));
        return new(scene.Id, variant?.Title ?? scene.Title, variant?.Summary ?? scene.Summary, scene.Arrival,
            variant?.ImagePrompt ?? scene.ImagePrompt, scene.Exits.Select(e => e.Target).ToArray(), document.StyleProfile, document.VisualConstraints);
    }
    public static ContentExit[] Exits(Campaign c) => WorldRoutes.Exits(c, c.SceneId);
    public static ExplorationMap Map(Campaign c, ActionChoice[] choices)
    {
        if (!ContentRuntime.Ready(c)) return new("尚未导入地图", [], []);
        var targets = choices.Where(a => a.Kind == "travel").Select(a => a.Target).ToHashSet();
        var visible = WorldRoutes.KnownScenes(c);
        var scenes = c.Adventure!.Scenes.Concat((c.WorldAtlas?.Places ?? []).Select(p => WorldRoutes.Scene(c, p.Id)!))
            .Where(s => visible.Contains(s.Id)).ToArray();
        var nodes = scenes.Select(s =>
        {
            bool current = s.Id == c.SceneId, visited = c.VisitedScenes.Contains(s.Id);
            return new MapNode(s.Id, ForScene(c, s.Id).Title, current ? "current" : visited ? "visited" : "discovered", targets.Contains(s.Id),
                current ? "你在这里" : targets.Contains(s.Id) ? "可沿当前路线前往" : visited ? "已探索 · 请先返回相邻地点" : "已知地点 · 当前没有直达路线",
                s.X, s.Y, s.Unlocated);
        }).ToArray();
        var edges = scenes.Where(s => s.Id == c.SceneId || c.VisitedScenes.Contains(s.Id))
            .SelectMany(s => WorldRoutes.Exits(c, s.Id).Where(e => visible.Contains(e.Target)).Select(e => new MapEdge(s.Id, e.Target)))
            .Distinct().ToArray();
        return new(c.Adventure.Name, nodes, edges);
    }
    public static ActionChoice[] Choices(Campaign c)
    {
        if (!ContentRuntime.Ready(c) || !PartyEngine.HasCharacter(c) || !GameLifecycle.CanAct(c)) return [];
        if (CombatEngine.Restricted(c)) return CombatEngine.Choices(c).Where(a => PartyEngine.Allowed(c, a)).ToArray();
        var result = new List<ActionChoice> { new("observe", "", "观察场景") };
        foreach (var exit in Exits(c))
            result.Add(new("travel", exit.Target, "前往" + ForScene(c, exit.Target).Title));
        result.AddRange(ContentRuntime.Choices(c));
        result.AddRange(CombatEngine.Choices(c));
        result.AddRange(GrowthEngine.Choices(c));
        return result.Where(a => PartyEngine.Allowed(c, a)).ToArray();
    }
}
