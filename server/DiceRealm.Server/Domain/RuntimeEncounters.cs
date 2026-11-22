using System.Text.Json.Serialization;

namespace DiceRealm.Server.Domain;

// Private encounter preparation, separate from the immutable imported adventure and PNG.
// Perception preparation has no tactical scale. Combat binds one later without resetting instances.
public sealed record RuntimeEncounter(string SceneId, string ContentVersion, string SourceId, string Quote,
    string LayoutReason, BoardCombatLayout? Layout, ContentEncounter Definition,
    EncounterHiddenEnemy[]? Concealment = null, EncounterObservation[]? Observations = null,
    string[]? SurprisedActors = null, string? EngagementReason = null)
{
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public bool PreservesMapScale { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ObservationMapId { get; init; }
}
public sealed record EncounterPlacement(string RulesId, string Name, string Tactic, BoardPoint Position,
    string? HidingCover = null, string? HidingReason = null);

public static class RuntimeEncounters
{
    public static RuntimeEncounter? Current(Campaign c) => c.RuntimeEncounters?.SingleOrDefault(e => e.SceneId == c.SceneId);
    public static MapAssetView TacticalMap(Campaign c, MapAssetView map)
    {
        var setup = c.RuntimeEncounters?.SingleOrDefault(e => e.SceneId == c.SceneId && e.Layout?.MapId == map.Id);
        if (setup?.Layout is null || !MatchesMap(setup.Layout, map))
            return map.Purpose == "tactical" && map.Grid.Type is ("none" or "square") && double.IsFinite(MapScale.FeetPerPixel(map.Grid))
                ? map with { Grid = MapScale.TacticalGrid(map) } : map;
        return setup.PreservesMapScale
            ? map with { Grid = setup.Layout.Grid }
            : map with { Grid = setup.Layout.Grid, Purpose = null, Title = map.Title + " · 本场DM战术标尺（非原图比例）" };
    }
    public static bool MatchesMap(BoardCombatLayout? layout, MapAssetView map) =>
        layout is not null && layout.MapId == map.Id && layout.MapVersion == map.Version && layout.ContentHash == map.ContentHash &&
        layout.ImageWidth == map.Width && layout.ImageHeight == map.Height;

    public static RuntimeEncounter Prepare(Campaign c, MapAssetView map, MapGrid? grid, string title,
        string sourceId, string quote, string layoutReason, EncounterPlacement[] placements, BattleCell[]? terrain = null,
        int namingVersion = NpcNames.Version, RuntimeEncounter? binding = null)
    {
        if (!ContentRuntime.Ready(c) || ContentRuntime.Scene(c)?.Encounter is not null ||
            Current(c) != binding || binding is not null && (binding.Layout is not null || binding.EngagementReason is not null) ||
            CombatEngine.Restricted(c) || c.PendingRolls.Any(r => r.Status == "pending"))
            throw Unavailable("当前场景已有遭遇或待处理战斗/投掷，不能重建敌人或重置状态。");
        if (map.Status != "ready" || !map.Published || map.Edition != "player" || !map.CurrentScene)
            throw Unavailable("运行时遭遇必须绑定当前已发布玩家底图。");
        if (placements is null || placements.Length == 0 || placements.Length + PartyEngine.Characters(c).Count() > BoardCombat.MaximumUnits)
            throw Unavailable("遭遇需要实际敌人；本引擎共支持2至7名参与者，不会省略队员。");
        bool observationOnly = namingVersion >= 46 && grid is null && binding is null;
        bool preservesScale = namingVersion >= 42;
        if (!observationOnly && preservesScale && MapScale.TacticalGrid(map) != grid)
            throw Unavailable("遭遇只能沿用该图实际尺度或等比例细分，不能另设五尺标尺。");
        var layout = observationOnly ? null : BoardCombat.Layout(map with { Grid = grid!, Purpose = preservesScale ? map.Purpose : null });
        var cells = terrain ?? [];
        if (layout is null && cells.Length != 0)
            throw Unavailable("侦察准备不需要战术格位，terrain须为空；真实开战前再绑定实际战术布局。");
        if (cells.Length > 35 || cells.Any(cell => cell is null || cell.X < 0 || cell.X >= layout!.Width || cell.Y < 0 || cell.Y >= layout.Height ||
            cell.Terrain is not ("blocked" or "difficult" or "half-cover" or "three-quarters-cover")) || cells.Select(cell => (cell.X, cell.Y)).Distinct().Count() != cells.Length)
            throw Unavailable("战术地形须为当前标尺上的明确格位；不从图片自动推断，最多35个地形格。");
        if (!preservesScale && !map.Grid.Uncalibrated && map.Grid.Type == "square" && map.Grid != grid)
            throw Unavailable("已有明确标定时使用原标尺，不能通过遭遇重设距离。");
        title = WorldMemories.Text(title, 80);
        sourceId = WorldMemories.Text(sourceId, 120);
        quote = WorldMemories.Text(quote, 800, multiline: true);
        layoutReason = WorldMemories.Text(layoutReason, 500, multiline: true);
        var enemies = placements.Select((placement, index) =>
        {
            if (placement is null) throw Unavailable("缺少敌方布置。");
            if (placement.HidingCover is not null && (placement.HidingCover is not ("three-quarters-cover" or "total-cover") || string.IsNullOrWhiteSpace(placement.HidingReason)) ||
                placement.HidingCover is null && placement.HidingReason is not null)
                throw Unavailable("躲藏需要明确的四分之三/全掩护及当前脱离敌方视线的场景判断；黑暗/重度遮蔽未自动实现。");
            if (placement.HidingReason is not null) _ = WorldMemories.Text(placement.HidingReason, 500, multiline: true);
            var profile = StandardMonsters.Find(placement.RulesId) ?? throw Unavailable("只能选择已验证的2024敌方规则来源，不能提交自定数值。");
            if (placement.Tactic is not ("engage" or "withdraw") && !(placement.Tactic == "ranged" && profile.Id == "xmm:goblin-warrior"))
                throw Unavailable("此来源没有对应执行策略。");
            if (placement.Position is not { } point || !double.IsFinite(point.X) || !double.IsFinite(point.Y) ||
                point.X is < 0 or > 1 || point.Y is < 0 or > 1)
                throw Unavailable("敌人位置须为当前底图上的有限归一坐标。");
            var cell = layout is null ? (X: -1, Y: -1) : BoardCombat.NormalizedToGrid(layout, point);
            return new ContentEnemy("enemy-" + index, WorldMemories.Text(placement.Name, 80), cell.X, cell.Y,
                profile.Hp, profile.Ac, profile.Speed, profile.Initiative, profile.Attack, 1, profile.Die, profile.Bonus,
                placement.Tactic, profile.Id);
        }).ToArray();
        enemies = binding is null ? NpcNames.EncounterInstances(c, enemies, namingVersion) : enemies;
        if (layout is not null)
        {
            var occupied = enemies.Select(e => (e.X, e.Y)).ToList();
            var occupants = enemies.Select(e => binding is null ? $"{e.Id}（{e.Name}）" :
                $"{c.Board!.Entities.Single(entity => entity.Source.EncounterId == binding.Definition.Id && entity.Source.Id == e.Id).Id}（{e.Name}）").ToList();
            foreach (var player in PartyEngine.Characters(c))
            {
                var entity = c.Board?.Entities.SingleOrDefault(e => e.ActorId == player.Id && e.CharacterId == player.Character.Id);
                if (SharedBoard.PlacementOn(entity, map.Id) is not { OnMap: true } p)
                    throw Unavailable("每位参战队员需要当前图上的实际棋子，不会为他人补造位置。");
                occupied.Add(BoardCombat.NormalizedToGrid(layout, new(p.X, p.Y)));
                occupants.Add($"{entity!.Id}（队员 {player.Character.Name}）");
            }
            if (occupied.Distinct().Count() != occupied.Count || cells.Any(cell => cell.Terrain != "difficult" && occupied.Contains((cell.X, cell.Y))))
            {
                if (namingVersion < 51)
                    throw Unavailable("战术格位重叠或落在障碍上；须明确修正布置，不会自动挪动已有棋子。");
                var conflicts = occupied.Select((point, index) => (point, occupant: occupants[index]))
                    .GroupBy(p => p.point).Where(group => group.Count() > 1)
                    .Select(group => $"格({group.Key.X},{group.Key.Y})单位重叠：{string.Join("、", group.Select(p => p.occupant))}").ToList();
                conflicts.AddRange(cells.Where(cell => cell.Terrain != "difficult").SelectMany(cell =>
                    occupied.Select((point, index) => (point, occupant: occupants[index]))
                        .Where(p => p.point == (cell.X, cell.Y))
                        .Select(p => $"格({cell.X},{cell.Y}) {p.occupant} 占据不可站立地形 {cell.Terrain}")));
                throw Unavailable(string.Join("；", conflicts) + ". " + FormattableString.Invariant(
                    $"采用mapId={layout.MapId}, version={layout.MapVersion}, hash={layout.ContentHash}; image={layout.ImageWidth}x{layout.ImageHeight}; grid=square, cellPixels={layout.Grid.CellPixels}, offset=({layout.Grid.OffsetX},{layout.Grid.OffsetY}), first=({layout.FirstColumn},{layout.FirstRow}), size={layout.Width}x{layout.Height}, cellFeet={layout.Grid.Distance}。") +
                    "terrain使用此布局零起算局部格；掩护是遮挡格，不是站位格。保留原遭遇、名单、隐藏骰和玩家实际位置，仅明确修正有依据的布局提案，不自动挪位或重建。");
            }
            var geometry = new CombatState { Width = layout.Width, Height = layout.Height, Cells = cells };
            for (int i = 0; i < placements.Length; i++)
            {
                if (placements[i].HidingCover is null) continue;
                var enemy = new CombatUnit { X = enemies[i].X, Y = enemies[i].Y };
                for (int observer = enemies.Length; observer < occupied.Count; observer++)
                {
                    var point = occupied[observer];
                    int cover = CombatGeometry.Cover(geometry, new() { X = point.X, Y = point.Y }, enemy);
                    int required = placements[i].HidingCover == "total-cover" ? 99 : 5;
                    if (cover >= required) continue;
                    throw Unavailable(namingVersion < 51
                        ? "隐匿布置须有对应的战术掩护，不能只用文字绕过已知位置与地形。"
                        : FormattableString.Invariant($"{occupants[i]} 格({enemy.X},{enemy.Y}) 对 {occupants[observer]} 格({point.X},{point.Y}) 掩护不足：实际cover={cover}，原隐匿要求={placements[i].HidingCover}。采用mapId={layout.MapId}, version={layout.MapVersion}, hash={layout.ContentHash}, image={layout.ImageWidth}x{layout.ImageHeight}, cellPixels={layout.Grid.CellPixels}, offset=({layout.Grid.OffsetX},{layout.Grid.OffsetY}), first=({layout.FirstColumn},{layout.FirstRow}), size={layout.Width}x{layout.Height}；按有效格心视线修正有依据的遮挡，不重掷隐匿或移动玩家。"));
                }
            }
        }
        if (binding is not null)
            return binding with { Layout = layout, LayoutReason = layoutReason,
                Definition = binding.Definition with { Enemies = enemies, Cells = cells } };
        return new(c.SceneId, c.Adventure!.Version, sourceId, quote, layoutReason, layout,
            new() { Id = "runtime-" + Guid.NewGuid(), Title = title, StartLabel = "进入战斗", Mode = StandardCombatEngine.Mode,
                Nonlethal = false, Enemies = enemies, Cells = cells, Victory = new("本场敌对交锋结束；后续剧情、搜寻和奖励尚未处理。", []) })
            { PreservesMapScale = preservesScale, ObservationMapId = observationOnly ? map.Id : null };
    }

    // One-way binding: source identity and all live state survive; only grounded positions and terrain change.
    public static RuntimeEncounter BindLayout(Campaign c, MapAssetView map, string encounterId,
        string layoutReason, EncounterPlacement[] placements, BattleCell[] terrain, int toolContractVersion = 46)
    {
        var original = Current(c);
        if (original?.Definition.Id != encounterId || original.ObservationMapId is null || original.Layout is not null ||
            original.EngagementReason is not null || placements.Length != original.Definition.Enemies.Length)
            throw Unavailable("只能为本场尚未绑定战术布局的原遭遇补充布局，不能重建或重掷。");
        var entities = original.Definition.Enemies.Select(enemy => c.Board!.Entities.Single(e =>
            e.Source.EncounterId == encounterId && e.Source.Id == enemy.Id)).ToArray();
        var grounded = placements.Select((p, i) =>
        {
            var enemy = original.Definition.Enemies[i];
            var entity = entities[i];
            if (entity.Placement is not { OnMap: true })
                throw Unavailable("已离图单位不能通过绑定布局重新入场。");
            if (SharedBoard.MovementRestricted(entity.Statistics?.Conditions) &&
                (entity.Placement.MapId != map.Id || entity.Placement.X != p.Position.X || entity.Placement.Y != p.Position.Y))
                throw Unavailable("绑定布局不能移动仍受限制的实例；保留原状态。");
            if (p.RulesId != enemy.RulesId || p.Name != enemy.Name || p.Tactic != enemy.Tactic || p.HidingCover is not null || p.HidingReason is not null)
                throw Unavailable("绑定布局须按原名单顺序保留姓名、来源和策略，不重新提交隐匿条件。");
            var hidden = original.Concealment?.SingleOrDefault(h => h.EntityId == entities[i].Id && h.Hidden);
            return p with { HidingCover = hidden?.Cover, HidingReason = hidden?.Reason };
        }).ToArray();
        var result = Prepare(c, map, MapScale.TacticalGrid(map), original.Definition.Title, original.SourceId,
            original.Quote, layoutReason, grounded, terrain, namingVersion: toolContractVersion, binding: original);
        c.RuntimeEncounters![c.RuntimeEncounters.IndexOf(original)] = result;
        for (int i = 0; i < entities.Length; i++)
        {
            int index = c.Board!.Entities.IndexOf(entities[i]);
            c.Board.Entities[index] = SharedBoard.WithPlacement(entities[i], new(map.Id, placements[i].Position.X, placements[i].Position.Y, true, []));
        }
        EncounterConcealment.RefreshSight(c, map);
        return result;
    }

    public static RuntimeEncounter Establish(Campaign c, MapAssetView map, RuntimeEncounter setup, EncounterPlacement[] placements, RulesEngine rules)
    {
        (c.RuntimeEncounters ??= []).Add(setup);
        var ids = SharedBoard.SpawnEncounter(c, map, setup, placements);
        var hidden = new List<EncounterHiddenEnemy>();
        for (int i = 0; i < placements.Length; i++)
        {
            var p = placements[i];
            if (p.HidingCover is null) continue;
            var profile = StandardMonsters.Find(p.RulesId)!;
            int modifier = profile.Id == "xmm:goblin-warrior" ? 6 : profile.Dexterity;
            int die = rules.RollDice(1, 20)[0];
            var check = new DiceCheck("dexterity", "Stealth", [die], die, modifier, die + modifier, 15, die + modifier >= 15, "normal");
            hidden.Add(new() { EntityId = ids[i], Cover = p.HidingCover, Reason = p.HidingReason!, Stealth = check, Hidden = check.Success });
        }
        var result = setup with { Concealment = hidden.ToArray() };
        c.RuntimeEncounters[c.RuntimeEncounters.IndexOf(setup)] = result;
        return result;
    }

    public static void ValidateState(Campaign c)
    {
        if (c.RuntimeEncounters is null) return;
        void Require(bool value)
        {
            if (!value) throw new GameException("invalid_runtime_encounter", "运行时遭遇记录无效；原存档已保留。", 409);
        }
        Require(c.RuntimeEncounters.All(e => e is not null) && c.RuntimeEncounters.Select(e => e.SceneId).Distinct().Count() == c.RuntimeEncounters.Count &&
            c.RuntimeEncounters.Select(e => e.Definition?.Id).Distinct().Count() == c.RuntimeEncounters.Count);
        foreach (var setup in c.RuntimeEncounters)
        {
            var d = setup.Definition;
            Require(c.Adventure is not null && setup.ContentVersion == c.Adventure.Version &&
                (c.Adventure.Scenes.Any(s => s.Id == setup.SceneId && s.Encounter is null) || WorldRoutes.Scene(c, setup.SceneId) is not null) &&
                setup.SourceId is { Length: > 0 and <= 120 } && setup.Quote is { Length: > 0 and <= 800 } && setup.LayoutReason is { Length: > 0 and <= 500 } &&
                d is not null && d.Id.StartsWith("runtime-", StringComparison.Ordinal) && Guid.TryParseExact(d.Id[8..], "D", out _) &&
                d.Title is { Length: > 0 and <= 80 } && d.Mode == StandardCombatEngine.Mode && !d.Nonlethal && !d.Repeatable &&
                d.OnStart is { Length: 0 } && d.Cells is { Length: <= 35 } && d.When is { All.Length: 0, Any.Length: 0, None.Length: 0 } &&
                d.Victory is { Effects.Length: 0 } && d.Enemies is { Length: > 0 and < BoardCombat.MaximumUnits } &&
                d.Enemies.All(e => e is not null && StandardMonsters.Matches(e) && e.Name is { Length: > 0 and <= 80 } &&
                    (e.Tactic is "engage" or "withdraw" || e.Tactic == "ranged" && e.RulesId == "xmm:goblin-warrior")) &&
                d.Enemies.Select(e => e.Id).Distinct().Count() == d.Enemies.Length);
            var instances = c.Board?.Entities.Where(e => e?.Source?.EncounterId == d!.Id).ToArray() ?? [];
            Require(instances.Length == d!.Enemies.Length && d.Enemies.All(enemy =>
                instances.Count(e => e.Source.Kind == "enemy" && e.Source.Id == enemy.Id &&
                    e.Source.RulesId == enemy.RulesId && e.Source.ContentVersion == setup.ContentVersion && e.Kind == "creature") == 1));
            Require(setup.ObservationMapId is null || Guid.TryParseExact(setup.ObservationMapId, "D", out _));
            var l = setup.Layout;
            if (l is null)
            {
                Require(setup.ObservationMapId is not null && setup.PreservesMapScale && setup.EngagementReason is null &&
                    setup.SurprisedActors is null && !c.AttemptedEncounters.Contains(d.Id) && c.Combat?.DefinitionId != d.Id &&
                    c.CombatAgentSessions?.Any(s => s.EncounterId == d.Id) != true &&
                    d.Cells.Length == 0 && d.Enemies.All(e => e.X == -1 && e.Y == -1) &&
                    instances.All(e => SharedBoard.PlacementOn(e, setup.ObservationMapId!) is not null));
                EncounterConcealment.Validate(c, setup);
                continue;
            }
            Require(l.MapVersion > 0 && Guid.TryParseExact(l.MapId, "D", out _) && l.ContentHash is { Length: > 0 });
            try
            {
                var restored = BoardCombat.Layout(new(l!.MapId, "", "", "player", l.MapVersion, "ready", true, l.ImageWidth, l.ImageHeight,
                    l.ImageWidth, l.ImageHeight, l.Grid, "", l.ContentHash, "", 0, default));
                Require(restored == l && d!.Enemies.All(e => e.X >= 0 && e.X < l.Width && e.Y >= 0 && e.Y < l.Height) &&
                    d.Enemies.Select(e => (e.X, e.Y)).Distinct().Count() == d.Enemies.Length &&
                    d.Cells.All(cell => cell is not null && cell.X >= 0 && cell.X < l.Width && cell.Y >= 0 && cell.Y < l.Height &&
                        cell.Terrain is "blocked" or "difficult" or "half-cover" or "three-quarters-cover") &&
                    d.Cells.Select(cell => (cell.X, cell.Y)).Distinct().Count() == d.Cells.Length);
                EncounterConcealment.Validate(c, setup);
            }
            catch (GameException) { throw new GameException("invalid_runtime_encounter", "运行时战术标尺无效；原存档已保留。", 409); }
        }
    }
    private static GameException Unavailable(string message) => new("encounter_setup_unavailable", message, 409);
}
