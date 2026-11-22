namespace DiceRealm.Server.Domain;

// Frozen actual-image calibration, not another authoritative map. Grid coordinates are
// local to the complete cells of this image; the image's pixel origin is preserved.
public sealed record BoardCombatLayout(string MapId, int MapVersion, string ContentHash,
    int ImageWidth, int ImageHeight, MapGrid Grid, int FirstColumn, int FirstRow, int Width, int Height);
public sealed record BoardCombatPosition(BoardPoint Origin, int X, int Y);
public sealed class BoardCombatBody
{
    public int TemporaryHitPoints { get; set; }
    public string[] Conditions { get; set; } = [];
}
public sealed record BoardCombatPreparation(BoardCombatLayout Layout, CombatUnit[] Units);
public sealed record BoardCombatMoveChoice(string Target, BoardPoint Destination, string Label, ActionDetails? Details);

public static class BoardCombat
{
    // Keep the existing small-encounter engines and bounded continuations. Larger battles
    // require a separate rules change, not an unbounded image-derived arena.
    public const int MaximumDimension = 32;
    public const int MaximumCells = 1024;
    public const int MaximumUnits = 7;
    private static readonly string[] StandardConditions = ["Dead", "Unconscious", "Incapacitated", "Paralyzed", "Prone", "Poisoned", "Blinded", "Deafened", "Stunned"];
    private static GameException Refuse(string suffix, string message) => new("board_combat_" + suffix, message, 409);

    // Pure preparation, before OnStart, initiative or any mutation. Null exclusively means
    // a pre-board save, whose historical arena and rule behavior must remain unchanged.
    public static BoardCombatPreparation? Prepare(Campaign c, ContentEncounter encounter, MapAssetView? map)
    {
        if (c.Board is null) return null;
        if (map is null) throw Refuse("map_required", "开战需要在授权事务内读取当前底图；不能重建旧棋盘或猜测位置。");
        if (map.Status != "ready" || map.Edition != "player" || !map.Published || !map.CurrentScene ||
            ContentRuntime.SceneEncounter(c)?.Id != encounter.Id)
            throw Refuse("map_unavailable", "需要当前场景已发布的玩家底图；查看另一张图不会把单位传送过去。");
        if (RuntimeEncounters.Current(c) is { } setup && setup.Definition.Id == encounter.Id)
        {
            if (setup.Layout is null)
                throw Refuse("layout_required", "侦察结果已保存；开战前须为原遭遇绑定已校准的战术布局，不重建或重掷敌人。");
            if (!RuntimeEncounters.MatchesMap(setup.Layout, map))
                throw Refuse("map_changed", "遭遇布置对应的底图已变化，请处理原布置，不能自动重算距离。");
        }
        var layout = Layout(RuntimeEncounters.TacticalMap(c, map));
        if (encounter.Cells.Length != 0 && RuntimeEncounters.Current(c)?.Definition.Id != encounter.Id)
            throw Refuse("terrain_unsupported", "遭遇的旧棋盘地形没有与实际底图建立格位对应，不能直接套到图片上；请按原裁定处理。");
        var units = new List<CombatUnit>();
        bool standard = encounter.Mode == StandardCombatEngine.Mode;
        foreach (var player in PartyEngine.Characters(c).Where(p => !GameLifecycle.Dead(c, p.Id)))
        {
            var ch = player.Character;
            var entity = c.Board.Entities.SingleOrDefault(e => e.ActorId == player.Id && e.CharacterId == ch.Id);
            if (entity is null) throw Refuse("placement_required", "每位参与队员都需要本人实际棋子和当前图上的位置；不会补造出生点。");
            var unit = new CombatUnit
            {
                Id = player.Id, Team = "party", Name = ch.Name, HitPoints = ch.HitPoints,
                MaxHitPoints = ch.MaxHitPoints, ArmorClass = ch.ArmorClass, Speed = BuildRuntime.Speed(ch),
                InitiativeModifier = (ch.BuildMechanics?.InitiativeBonus ?? CharacterEngine.Ability(ch, "dexterity") + ch.ProficiencyBonus) - (standard ? 2 * ch.Exhaustion : 0),
                Standard = standard ? new() { Conditions = ch.Conditions.ToArray(), TemporaryHitPoints = ch.TemporaryHitPoints } : null
            };
            Place(c, layout, entity, unit, encounter.Id);
            units.Add(unit);
        }
        var instances = c.Board.Entities.Where(e => e.Kind == "creature" && e.Source.Kind == "enemy" &&
            e.Source.EncounterId == encounter.Id && SharedBoard.PlacementOn(e, map.Id) is { OnMap: true }).ToArray();
        if (instances.Length == 0)
        {
            bool unsupported = c.Board.Entities.Any(e => e.Kind == "creature" && e.ActorId == "" && e.Source.Kind != "enemy" &&
                SharedBoard.PlacementOn(e, map.Id) is { OnMap: true });
            if (unsupported) throw Refuse("mechanics_unsupported", "当前图只有人物、自定义或完整NPC角色，没有本遭遇的ContentEnemy执行来源；不能冒充玩家席位或敌方模板。");
            throw Refuse("instances_required", "当前图没有此遭遇的实际敌方实例；不会从模板补满敌人。");
        }
        foreach (var entity in instances)
        {
            _ = Profile(c, encounter, entity);
            if (entity.Character is not null)
                throw Refuse("mechanics_unsupported", "完整NPC角色尚未绑定此遭遇的自动执行策略，不能冒充玩家席位或强套模板攻击；请按原裁定处理。");
            var stats = entity.Statistics;
            if (stats?.HitPoints is null || stats.MaxHitPoints is null || stats.ArmorClass is null || stats.Speed is null || stats.InitiativeModifier is null)
                throw Refuse("mechanics_required", "实际敌方单位缺少已记录的HP上限、当前HP、AC、速度或先攻；不能从模板重置当前状态。");
            if (stats.HitPoints <= 0 || stats.Conditions?.Contains("Dead") == true) continue;
            var conditions = stats.Conditions ?? [];
            if (conditions.Any(s => !StandardConditions.Contains(s)) || conditions.Distinct().Count() != conditions.Length || !standard && conditions.Length != 0 ||
                stats.Effects is { Length: > 0 } || stats.Concentration is not null)
                throw Refuse("mechanics_unsupported", "此单位的当前条件或持续效果尚不能由该战斗模式完整结算；请保留位置并按原裁定处理。");
            var unit = new CombatUnit
            {
                Id = entity.Id, Team = "enemy", Name = entity.Appearance.Name,
                HitPoints = stats.HitPoints.Value, MaxHitPoints = stats.MaxHitPoints.Value,
                ArmorClass = stats.ArmorClass.Value, Speed = stats.Speed.Value, InitiativeModifier = stats.InitiativeModifier.Value,
                Standard = standard ? new() { Conditions = conditions.ToArray(), TemporaryHitPoints = stats.TemporaryHitPoints ?? 0 } : null,
                BoardBody = standard ? null : new() { Conditions = conditions.ToArray(), TemporaryHitPoints = stats.TemporaryHitPoints ?? 0 }
            };
            Place(c, layout, entity, unit, encounter.Id);
            units.Add(unit);
        }
        if (!units.Any(u => u.Team == "enemy")) throw Refuse("no_living_enemies", "此图上的遭遇单位已经倒下或死亡，不能因再次开战复活。");
        if (units.Count is < 2 or > MaximumUnits) throw Refuse("participants_unsupported", "原引擎一次支持2至7个实际参与者；不会省略或合并多实例。");
        var geometry = new CombatState { Width = layout.Width, Height = layout.Height, Cells = encounter.Cells };
        if (units.Any(u => CombatGeometry.Obstacle(geometry, u.X, u.Y)))
            throw Refuse("positions_unsupported", "实际参与者在明确障碍格内；请处理真实位置，不会自动挪动。");
        if (units.Select(u => (u.X, u.Y)).Distinct().Count() != units.Count)
            throw Refuse("positions_unsupported", "实际参与者占据同一格，原引擎不能结算这种叠放；不会自动挪开单位。");
        return new(layout, units.ToArray());
    }

    private static void Place(Campaign c, BoardCombatLayout layout, BoardEntity entity, CombatUnit unit, string encounterId)
    {
        if (SharedBoard.PlacementOn(entity, layout.MapId) is not { OnMap: true } p)
            throw Refuse("placement_required", "参与者不在当前底图上；换场景或看图不自动传送。");
        if (entity.Appearance.Visibility != "player" && !EncounterConcealment.CanParticipate(c, entity, encounterId))
            throw Refuse("visibility_unsupported", "原战斗投影只支持公开参与者，不能把隐藏棋子经战斗记录泄露。");
        var origin = new BoardPoint(p.X, p.Y);
        var cell = NormalizedToGrid(layout, origin);
        unit.X = cell.X; unit.Y = cell.Y;
        unit.BoardEntityId = entity.Id;
        unit.BoardPosition = new(origin, cell.X, cell.Y);
    }
    public static BoardCombatLayout Layout(MapAssetView map)
    {
        var g = map.Purpose is null ? map.Grid : MapScale.TacticalGrid(map);
        if (map.Width <= 0 || map.Height <= 0 || g is null || g.Type != "square" || g.Uncalibrated ||
            g.Distance != 5 || g.Units != "feet" || !double.IsFinite(g.CellPixels) || g.CellPixels <= 0 ||
            !double.IsFinite(g.OffsetX) || !double.IsFinite(g.OffsetY))
            throw Refuse("scale_unsupported", "自动战斗需要实际图片尺寸、已校准的square方格及每格5feet；未校准图不能推物理距离。");
        // Partial edge cells cannot represent every token's unchanged within-cell offset.
        // Only complete cells participate; positions in the margins are explicitly refused.
        double firstX = Math.Ceiling(-g.OffsetX / g.CellPixels), firstY = Math.Ceiling(-g.OffsetY / g.CellPixels);
        double width = Math.Floor((map.Width - g.OffsetX) / g.CellPixels) - firstX;
        double height = Math.Floor((map.Height - g.OffsetY) / g.CellPixels) - firstY;
        if (firstX < int.MinValue || firstX > int.MaxValue || firstY < int.MinValue || firstY > int.MaxValue ||
            !double.IsFinite(width) || !double.IsFinite(height) || width < 1 || height < 1 ||
            width > MaximumDimension || height > MaximumDimension || width * height > MaximumCells)
            throw Refuse("bounds_unsupported", "底图完整方格范围超过原小型战斗引擎可处理范围（每边最多32格）；不会缩放或搬到7×5。");
        return new(map.Id, map.Version, map.ContentHash, map.Width, map.Height, g, (int)firstX, (int)firstY, (int)width, (int)height);
    }
    public static (int X, int Y) NormalizedToGrid(BoardCombatLayout layout, BoardPoint point)
    {
        if (point is null || !double.IsFinite(point.X) || !double.IsFinite(point.Y) || point.X is < 0 or > 1 || point.Y is < 0 or > 1)
            throw Refuse("position_invalid", "位置须为实际底图0至1的有限规范化中心坐标。");
        // A normalized double exactly on a grid line may acquire a rounding residue when
        // scaled back to pixels. Do not turn a settled step into the preceding cell on reload.
        static double Cell(double value) => Math.Floor(Math.Abs(value - Math.Round(value)) <= 1e-10 ? Math.Round(value) : value);
        double x = Cell((point.X * layout.ImageWidth - layout.Grid.OffsetX) / layout.Grid.CellPixels) - layout.FirstColumn;
        double y = Cell((point.Y * layout.ImageHeight - layout.Grid.OffsetY) / layout.Grid.CellPixels) - layout.FirstRow;
        if (x < 0 || y < 0 || x >= layout.Width || y >= layout.Height)
            throw Refuse("positions_unsupported", "位置不在底图的完整已校准方格内；不能自动搬入场内。");
        return ((int)x, (int)y);
    }
    public static BoardPoint GridToNormalized(CombatState combat, CombatUnit unit, int x, int y)
    {
        var layout = combat.BoardLayout ?? throw Refuse("mapping_required", "当前战斗没有共享棋盘映射。");
        var anchor = unit.BoardPosition ?? throw Refuse("mapping_required", "此参与者没有实际棋子位置映射。");
        if (!CombatGeometry.Inside(combat, x, y)) throw Refuse("position_invalid", "目标格位不在当前战斗范围内。");
        // Preserve the exact original normalized centre at start, including sub-cell offset.
        double nx = anchor.Origin.X + (x - anchor.X) * layout.Grid.CellPixels / layout.ImageWidth;
        double ny = anchor.Origin.Y + (y - anchor.Y) * layout.Grid.CellPixels / layout.ImageHeight;
        if (nx < -1e-12 || nx > 1 + 1e-12 || ny < -1e-12 || ny > 1 + 1e-12)
            throw Refuse("position_invalid", "已结算格位无法还原为底图内的位置；不能丢弃原格内偏移。");
        // Only floating-point residue at the image edge is clamped; complete cells ensure
        // every real within-cell offset is representable without snapping the token centre.
        return new(Math.Clamp(nx, 0, 1), Math.Clamp(ny, 0, 1));
    }
    public static ContentEnemy EnemyProfile(Campaign c, CombatUnit unit)
    {
        var encounter = ContentRuntime.FindEncounter(c, c.Combat!.DefinitionId)
            ?? throw Refuse("source_unsupported", "找不到此战斗的持久遭遇来源。");
        if (c.Combat!.BoardLayout is null) return encounter.Enemies.Single(e => e.Id == unit.Id);
        var entity = c.Board?.Entities.FirstOrDefault(e => e.Id == unit.BoardEntityId)
            ?? throw Refuse("mapping_required", "战斗实例的持久实体不存在。");
        return Profile(c, encounter, entity);
    }
    private static ContentEnemy Profile(Campaign c, ContentEncounter encounter, BoardEntity entity)
    {
        if (entity.Source.Kind != "enemy" || entity.Source.EncounterId != encounter.Id || entity.Source.ContentVersion != c.Adventure!.Version)
            throw Refuse("source_unsupported", "实际实例缺少当前遭遇的明确ContentEnemy来源；不能按实例ID或名字套模板。");
        var profile = encounter.Enemies.FirstOrDefault(e => e.Id == entity.Source.Id)
            ?? throw Refuse("source_unsupported", "实际实例引用的ContentEnemy不存在。");
        if (entity.Source.RulesId != (profile.RulesId ?? "")) throw Refuse("source_unsupported", "实际实例与已验证模板的规则来源不一致。");
        return profile;
    }

    public static BoardCombatMoveChoice[] MoveChoices(Campaign c, MapAssetView map, string entityId)
    {
        var unit = MovingUnit(c, map, entityId);
        return CombatEngine.Choices(c).Where(a => a.Kind == "combat.move").Select(a =>
        {
            var xy = a.Target.Split(',').Select(int.Parse).ToArray();
            return new BoardCombatMoveChoice(a.Target, GridToNormalized(c.Combat!, unit, xy[0], xy[1]), a.Label, a.Details);
        }).ToArray();
    }
    public static string MoveTarget(Campaign c, MapAssetView map, string entityId, BoardPoint destination, BoardPoint[]? path = null)
    {
        string[] targets = MoveTargets(c, map, entityId, destination, path);
        if (targets.Length != 1)
            throw Refuse("path_unsupported", "此单步入口不能执行连续路径；请用ResolveMove逐个结算提供的waypoint。");
        return targets[0];
    }
    // The path is a list of explicit intermediate waypoints; Destination is also explicit.
    // An optional first point in the current cell is the origin, not a paid movement step.
    public static string[] MoveTargets(Campaign c, MapAssetView map, string entityId, BoardPoint destination, BoardPoint[]? path = null)
    {
        var unit = MovingUnit(c, map, entityId);
        var layout = c.Combat!.BoardLayout!;
        if (path is { Length: > 64 }) throw Refuse("path_unsupported", "显式路径最多64个waypoint；不能由服务器补点或寻路。");
        var cells = (path ?? []).Select(point => NormalizedToGrid(layout, point)).ToList();
        var end = NormalizedToGrid(layout, destination);
        if (cells.Count == 0 || cells[^1] != end) cells.Add(end);
        var current = (unit.X, unit.Y);
        if (cells.Count > 0 && cells[0] == current) cells.RemoveAt(0);
        if (cells.Count == 0) throw Refuse("move_unavailable", "本次意图没有新的格位；战斗移动保留原格内偏移，不能免费调整中心位置。");
        foreach (var next in cells)
        {
            if (Math.Max(Math.Abs(next.X - current.Item1), Math.Abs(next.Y - current.Item2)) != 1)
                throw Refuse("path_unsupported", "显式路径必须逐格相邻，不能跨格或重复同格；请提供中间waypoint，服务器不会另寻路径。");
            current = next;
        }
        string[] targets = cells.Select(cell => $"{cell.X},{cell.Y}").ToArray();
        if (!CombatEngine.Choices(c).Any(a => a.Kind == "combat.move" && a.Target == targets[0]))
            throw Refuse("move_unavailable", "路径第一步不是本人当前可执行的移动；请先处理原等待、回合或移动限制。");
        return targets;
    }
    public static Resolution ResolveMove(Campaign c, MapAssetView map, BoardCommandRequest command, CombatEngine combat)
    {
        SharedBoard.ValidateCommand(command);
        if (command.Operation != "move" || command.MapId != map.Id)
            throw new GameException("invalid_board_command", "战斗移动需要同一授权底图的move命令。");
        string[] targets = MoveTargets(c, map, command.EntityId, command.Destination!, command.Path);
        var unit = c.Combat!.Units.Single(u => u.BoardEntityId == command.EntityId);
        var entries = new List<CombatEntry>();
        var summaries = new List<string>();
        Resolution? last = null;
        int completed = 0;
        foreach (string target in targets)
        {
            // Revalidate after every settled step. Opportunity attacks can change HP,
            // conditions, the active actor or continuation; no remaining points are queued.
            if (!CombatEngine.InCombat(c) || c.Combat.Standard?.Wait is not null || c.Combat.ActiveActorId != unit.Id ||
                !CombatEngine.Choices(c).Any(a => a.Kind == "combat.move" && a.Target == target)) break;
            last = combat.Resolve(c, "combat.move", target);
            summaries.Add(last.Summary);
            entries.AddRange(last.CombatLog ?? []);
            var xy = target.Split(',').Select(int.Parse).ToArray();
            if (unit.X != xy[0] || unit.Y != xy[1] || unit.Withdrawn) break;
            completed++;
            if (c.Combat.Standard?.Wait is not null) break;
        }
        if (last is null) throw Refuse("move_unavailable", "路径尚未执行；当前战斗不允许本人移动。");
        int remaining = targets.Length - completed;
        if (remaining > 0)
        {
            string reason = c.Combat.Standard?.Wait is not null
                ? "当前一步仍由原战斗反应/豁免续接处理；其余waypoint没有排队，处理等待后须基于实际落点重新选择。"
                : "剩余路径未执行；当前回合、移动预算或规则已不允许继续，请按原流程处理后重新选择。";
            summaries.Add($"显式路径已结算{completed}/{targets.Length}步；尚未落点：{string.Join(" → ", targets.Skip(completed))}。{reason}");
        }
        return last with
        {
            Status = c.Combat.Standard?.Wait is not null ? "pending" : "resolved",
            Summary = string.Join("\n", summaries), CombatLog = entries.ToArray(),
            Changes = remaining == 0 ? last.Changes : [..last.Changes, "board:remaining_steps:" + remaining]
        };
    }
    private static CombatUnit MovingUnit(Campaign c, MapAssetView map, string entityId)
    {
        if (!CombatEngine.InCombat(c) || c.Combat!.BoardLayout is not { } layout)
            throw Refuse("mapping_required", "当前战斗没有共享棋盘映射；不能把拖动变成普通摆放。");
        var current = Layout(RuntimeEncounters.TacticalMap(c, map));
        if (map.Status != "ready" || current != layout)
            throw Refuse("map_changed", "实际底图、版本或校准已变化；原战斗仍使用冻结布局，不能重新映射单位位置。");
        var unit = c.Combat.Units.FirstOrDefault(u => u.BoardEntityId == entityId)
            ?? throw Refuse("participant_required", "此棋子不是当前战斗参与者，不能经拖动入场。");
        if (unit.Team != "party" || unit.Id != c.ActingActorId)
            throw new GameException("forbidden", "战斗拖动只执行本人角色；NPC由原引擎控制，不能冒充其他席位。", 403);
        if (!CharacterReviews.CanAct(c))
            throw new GameException("character_review_required", "角色尚未获准参与冒险，不能通过棋盘拖动绕过审核。", 403);
        return unit;
    }

    // Called only by a Resolve that started active (or just started combat), including its
    // final transition. Closed CombatState is history and must never drive later exploration.
    internal static void Commit(Campaign c)
    {
        if (c.Combat?.BoardLayout is not { } layout) return;
        var board = c.Board ?? throw Refuse("mapping_required", "活动战斗的持久棋盘不存在。");
        foreach (var unit in c.Combat.Units)
        {
            int index = board.Entities.FindIndex(e => e.Id == unit.BoardEntityId);
            if (index < 0) throw Refuse("mapping_required", "活动战斗的实际单位不存在。");
            var entity = board.Entities[index];
            var old = SharedBoard.PlacementOn(entity, layout.MapId) ?? throw Refuse("placement_required", "活动战斗参与者的摆放不存在。");
            var point = GridToNormalized(c.Combat, unit, unit.X, unit.Y);
            var placement = old with { MapId = layout.MapId, X = point.X, Y = point.Y, OnMap = !unit.Withdrawn };
            if (old.X != placement.X || old.Y != placement.Y || old.OnMap != placement.OnMap)
            {
                placement = placement with { Path = [] };
            }
            var statistics = entity.Statistics;
            if (unit.Team == "enemy")
            {
                if (statistics is null) throw Refuse("mechanics_required", "活动敌方实例的机械资料不存在。");
                int temporary = unit.Standard?.TemporaryHitPoints ?? unit.BoardBody!.TemporaryHitPoints;
                var conditions = unit.Standard?.Conditions ?? unit.BoardBody!.Conditions;
                statistics = statistics with { HitPoints = unit.HitPoints, TemporaryHitPoints = temporary, Conditions = conditions.ToArray() };
            }
            board.Entities[index] = SharedBoard.WithPlacement(entity, placement) with { Statistics = statistics };
        }
    }

    public static void ValidateState(Campaign c)
    {
        static void Require(bool valid)
        {
            if (!valid) throw new GameException("invalid_board_combat", "共享棋盘与战斗记录不一致；原存档已保留。", 409);
        }
        var b = c.Combat;
        if (b?.BoardLayout is not { } layout)
        {
            Require(b?.Units?.All(u => u is not null && u.BoardEntityId is null && u.BoardPosition is null && u.BoardBody is null) ?? true);
            return;
        }
        Require(c.Board?.Entities is not null && c.Board.Entities.All(e => e is not null && e.Source is not null) &&
            Guid.TryParseExact(layout.MapId, "D", out var id) && id != Guid.Empty &&
            layout.MapVersion > 0 && layout.ContentHash is { Length: > 0 } && layout.Grid is not null &&
            b.CellFeet == 5 && b.Width == layout.Width && b.Height == layout.Height && b.Cells is not null && (b.Cells.Length == 0 || c.RuntimeEncounters?.Any(e => e.Definition.Id == b.DefinitionId && e.Definition.Cells.SequenceEqual(b.Cells)) == true) &&
            b.Units is { Length: >= 2 and <= MaximumUnits } && b.Units.All(u => u is not null) &&
            b.Status is "active" or "victory" or "defeated" or "retreated" &&
            b.TurnOrder is not null && b.TurnOrder.Length == b.Units.Length && b.TurnOrder.Distinct().Count() == b.Units.Length &&
            b.Units.Select(u => u.Id).Distinct().Count() == b.Units.Length && b.TurnOrder.All(actor => b.Units.Any(u => u.Id == actor)) &&
            (b.Status == "active" ? b.Units.Any(u => u.Id == b.ActiveActorId) : b.ActiveActorId == ""));
        try
        {
            var recalculated = Layout(new(layout.MapId, "", "", "player", layout.MapVersion, "ready", true,
                layout.ImageWidth, layout.ImageHeight, layout.ImageWidth, layout.ImageHeight, layout.Grid!, "", layout.ContentHash, "", 0, default));
            Require(recalculated == layout);
            Require(b.Units.Select(u => u.BoardEntityId).Distinct().Count() == b.Units.Length);
            foreach (var unit in b.Units)
            {
                Require(unit.BoardEntityId is not null && unit.BoardPosition is not null && unit.Team is "party" or "enemy" &&
                    CombatGeometry.Inside(b, unit.X, unit.Y) && unit.HitPoints >= 0 && unit.HitPoints <= unit.MaxHitPoints && unit.MaxHitPoints > 0);
                var entity = c.Board!.Entities.FirstOrDefault(e => e.Id == unit.BoardEntityId);
                Require(entity is not null && entity.Kind == "creature");
                Require(NormalizedToGrid(layout, unit.BoardPosition!.Origin) == (unit.BoardPosition.X, unit.BoardPosition.Y));
                var point = GridToNormalized(b, unit, unit.X, unit.Y);
                if (unit.Team == "enemy")
                {
                    Require(entity!.ActorId == "" && unit.Id == entity.Id && entity.Character is null);
                    _ = EnemyProfile(c, unit);
                    Require(unit.Standard is not null ? unit.BoardBody is null : unit.BoardBody is not null &&
                        unit.BoardBody.TemporaryHitPoints >= 0 && unit.BoardBody.Conditions is { Length: 0 });
                }
                else Require(entity!.ActorId == unit.Id && entity.CharacterId == PartyEngine.CharacterFor(c, unit.Id).Id && unit.BoardBody is null);
                if (b.Status != "active") continue;
                Require((entity!.Appearance.Visibility == "player" || EncounterConcealment.CanParticipate(c, entity, b.DefinitionId)) && SharedBoard.PlacementOn(entity, layout.MapId) is { } placement &&
                    placement.MapId == layout.MapId && placement.OnMap == !unit.Withdrawn &&
                    Math.Abs(placement.X - point.X) <= 1e-12 && Math.Abs(placement.Y - point.Y) <= 1e-12);
                if (unit.Team == "enemy")
                {
                    var stats = entity.Statistics;
                    Require(stats is not null && stats.HitPoints == unit.HitPoints && stats.MaxHitPoints == unit.MaxHitPoints &&
                        stats.ArmorClass == unit.ArmorClass && stats.Speed == unit.Speed && stats.InitiativeModifier == unit.InitiativeModifier &&
                        stats.TemporaryHitPoints == (unit.Standard?.TemporaryHitPoints ?? unit.BoardBody!.TemporaryHitPoints) &&
                        stats.Conditions is not null && stats.Conditions.SequenceEqual(unit.Standard?.Conditions ?? unit.BoardBody!.Conditions));
                }
                else
                {
                    var ch = PartyEngine.CharacterFor(c, unit.Id);
                    Require(ch.HitPoints == unit.HitPoints && ch.MaxHitPoints == unit.MaxHitPoints && ch.ArmorClass == unit.ArmorClass &&
                        BuildRuntime.Speed(ch) == unit.Speed);
                }
            }
        }
        catch (GameException)
        {
            throw new GameException("invalid_board_combat", "共享棋盘映射、来源或活动状态无效；原存档已保留。", 409);
        }
    }
}
