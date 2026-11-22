namespace DiceRealm.Server.Domain;

public static partial class SharedBoard
{
    public static bool CanView(Campaign c, BoardEntity entity, bool publicOnly = false)
    {
        if (entity.ActorId.Length > 0 && !PartyEngine.Characters(c).Any(p => p.Id == entity.ActorId && p.Character.Id == entity.CharacterId)) return false;
        if (!publicOnly && PartyEngine.IsHost(c)) return true;
        if (entity.Appearance.Visibility != "player" && !EncounterConcealment.PresentedTo(c, entity.Id, c.ActingActorId)) return false;
        return entity.Source.Kind != "npc" || ContentRuntime.World(c).Npcs.Any(n => n.Id == entity.Source.Id);
    }
    public static bool CanControl(Campaign c, BoardEntity entity, bool narrator = false, bool controlPlayers = false) =>
        entity.ActorId.Length > 0 ? (!GameLifecycle.GameOver(c) && !GameLifecycle.Dead(c, entity.ActorId) &&
            (entity.ActorId == c.ActingActorId && CharacterReviews.CanAct(c) ||
            narrator && controlPlayers && PartyEngine.Characters(c).Any(p => p.Id == entity.ActorId && p.Character.Id == entity.CharacterId)))
            : PartyEngine.IsHost(c) || narrator && entity.Appearance.Visibility == "player" && CanView(c, entity, true);

    public static BoardView Project(Campaign c, MapAssetView map, bool publicOnly = false)
    {
        map = RuntimeEncounters.TacticalMap(c, map);
        var entities = (c.Board?.Entities ?? []).Where(e => PlacementOn(e, map.Id) is not null && CanView(c, e, publicOnly)).ToArray();
        var ids = entities.Select(e => e.Id).ToHashSet(StringComparer.Ordinal);

        return new(c.Version, c.SceneId, new(map.Id, map.Title, map.Version, map.ContentHash, map.ImageUrl, map.Width, map.Height, map.Grid) { Purpose = map.Purpose },
            entities.Select(e =>
            {
                var stats = Statistics(c, e); var p = PlacementOn(e, map.Id)!;
                return new BoardTokenView(e.Id, e.Id[..8], e.Appearance.Name, e.Kind, e.Appearance.Summary, BoardArt.Icon(e),
                    p.X, p.Y, p.OnMap, CanControl(c, e), e.Appearance.Visibility, stats?.HitPoints, stats?.MaxHitPoints,
                    stats?.Conditions ?? [], p.Path, e.ActorId) { Size = stats?.Size ?? (e.Source.Kind == "enemy" ? StandardMonsters.Size(e.Source.RulesId) : null) };
            }).ToArray(),
            [], // Legacy response field; operation history is no longer recorded or exposed.
            (c.Board?.Moves ?? []).Where(m => m.Status == "pending" && m.Origin.MapId == map.Id && m.Destination.MapId == map.Id &&
                ids.Contains(m.EntityId) && (m.ActorId == c.ActingActorId || PartyEngine.IsHost(c)))
                .Select(m => new BoardMoveView(m.Id, m.EntityId, m.Destination.X, m.Destination.Y, m.Destination.Path, m.RulingId)).ToArray());
    }
    public static BoardTokenDetail Detail(Campaign c, string entityId, bool publicOnly = false)
    {
        var entity = Find(c, entityId);
        if (!CanView(c, entity, publicOnly)) throw Missing();
        Character? character = entity.ActorId.Length > 0
            ? PartyEngine.Snapshot(c).Members.Single(p => p.Id == entity.ActorId).Character : entity.Character;
        if ((publicOnly || !PartyEngine.IsHost(c)) && character is not null) character = character with { Build = null, Creation = null };
        return new(c.Version, entity.Id, entity.Appearance.Name, entity.Kind, entity.Appearance.Summary, BoardArt.Icon(entity),
            entity.ActorId, entity.FactionId, CanControl(c, entity), Statistics(c, entity),
            !publicOnly && PartyEngine.IsHost(c) ? entity.Source : null, character);
    }
    public static BoardEntity Find(Campaign c, string id) => c.Board?.Entities.FirstOrDefault(e => e.Id == id) ?? throw Missing();
    private static GameException Missing() => new("board_token_not_found", "此单位不存在或当前不可见。", 404);
    private static GameException Invalid(string message = "棋盘参数不符合约定。") => new("invalid_board_command", message);
    private static BoardStatistics? Statistics(Campaign c, BoardEntity e)
    {
        var ch = e.ActorId.Length > 0 ? PartyEngine.CharacterFor(c, e.ActorId) : e.Character;
        return ch is null ? e.Statistics : new(ch.HitPoints, ch.MaxHitPoints, ch.ArmorClass, BuildRuntime.Speed(ch),
            TemporaryHitPoints: ch.TemporaryHitPoints, Abilities: ch.Abilities, Conditions: ch.Conditions, Features: ch.Features,
            Inventory: ch.Inventory, Resources: ch.Resources, Spellcasting: ch.Spellcasting, Effects: ch.Effects, Concentration: ch.Concentration, Size: ch.BuildMechanics?.Size);
    }

    // The caller owns authentication, expectedVersion and the one transaction/receipt. Narrator is a
    // trusted in-process scope, never accepted in HTTP/tool arguments and never changes ActingActorId.
    public static BoardCommandResult Execute(Campaign c, MapAssetView map, BoardCommandRequest request, bool narrator = false, bool controlPlayers = false,
        int namingVersion = NpcNames.Version)
    {
        ValidateCommand(request);
        map = RuntimeEncounters.TacticalMap(c, map);
        if (map.Status != "ready" || map.Width < 1 || map.Height < 1 || map.Id != request.MapId)
            throw new GameException("board_map_unavailable", "需要可读取的已完成底图。", 409);
        if (CombatEngine.InCombat(c) && request.Operation is "spawn" or "remove")
            throw new GameException("board_combat_active", "战斗中的入场/离场须由原战斗流程结算，不能通过摆放绕过。", 409);
        if (CombatEngine.InCombat(c) && request.Operation == "move")
            throw new GameException("board_combat_move_required", "战斗拖动须在原事务调用BoardCombat.ResolveMove，保留行动预算、借机与本人反应；不能转成普通摆放或笼统人类裁定。", 409);
        var board = c.Board ?? new SharedBoardState();
        var changedIds = new List<string>();
        var entities = new List<BoardEntity>(board.Entities);
        string rulingId = "", status = "applied";
        BoardMoveIntent? move = null;
        if (request.Operation == "spawn")
        {
            var spawns = request.Spawns!;
            var reservedNames = namingVersion < NpcNames.Version ? null : NpcNames.Reserved(c,
                spawns.Where(s => s?.Appearance is not null).Select(s => s.Appearance.Name)
                    .Concat(spawns.Where(s => s?.Build?.Identity is not null).Select(s => s.Build!.Identity!.Name))
                    .Concat(spawns.Where(s => s?.Source?.Kind == "npc")
                        .Select(s => c.Adventure?.Npcs.FirstOrDefault(n => n.Id == s.Source.Id)?.Name).OfType<string>())
                    .Concat(spawns.Where(s => s?.Source?.Kind == "enemy")
                        .Select(s => ContentRuntime.FindEncounter(c, s.Source.EncounterId)?.Enemies.FirstOrDefault(e => e.Id == s.Source.Id)?.Name).OfType<string>()));
            foreach (var spawn in spawns)
            {
                var entity = Create(c, entities, spawn, narrator, controlPlayers: controlPlayers,
                    namingVersion: namingVersion, reservedNames: reservedNames);
                if (entities.Any(e => e.Id == entity.Id) && MovementRestricted(c, entity))
                    throw new GameException("board_move_restricted", "此实例有已知移动限制；再次摆放不能绕过原移动裁定。", 409);
                if (changedIds.Contains(entity.Id)) throw Invalid("同一批不能重复摆放同一实例。");
                if (!CanControl(c, entity, narrator, controlPlayers)) throw new GameException("forbidden", "不能摆放其他玩家的角色。", 403);
                var position = Position(map, new(spawn.X, spawn.Y), request.Snap);
                var placed = WithPlacement(entity, new(map.Id, position.X, position.Y, true, []));
                changedIds.Add(entity.Id);
                int index = entities.FindIndex(e => e.Id == entity.Id);
                if (index < 0) entities.Add(placed); else entities[index] = placed;
            }
        }
        else
        {
            var entity = Find(c, request.EntityId);
            RequireControl(c, entity, narrator, controlPlayers);
            var placement = PlacementOn(entity, map.Id);
            if (placement is null || placement.MapId != map.Id || !placement.OnMap)
                throw new GameException("board_token_off_map", "此单位不在这张地图上。", 409);
            BoardEntity updated = entity;
            switch (request.Operation)
            {
                case "move":
                    var point = Position(map, request.Destination!, request.Snap);
                    var path = (request.Path ?? []).Select(p => Position(map, p, request.Snap)).ToArray();
                    var destination = placement with { X = point.X, Y = point.Y, Path = path };
                    if (MovementRestricted(c, entity))
                    {
                        if (!CanView(c, entity, true))
                            throw new GameException("board_move_restricted", "此私有单位有已知移动限制；不能创建会公开单位信息的待裁定记录。", 409);
                        if (board.Moves.Any(m => m.EntityId == entity.Id && m.Status == "pending"))
                            throw new GameException("board_move_pending", "此单位已有未结算的移动意图。", 409);
                        rulingId = Guid.NewGuid().ToString(); status = "pending";
                        move = new(Guid.NewGuid().ToString(), entity.Id, c.ActingActorId, c.SceneId, placement, destination, rulingId, "pending");
                    }
                    else updated = WithPlacement(entity, destination);
                    break;
                case "update":
                    ValidateAppearance(request.Appearance!);
                    if (entity.ActorId.Length > 0 && request.Appearance!.Visibility != "player") throw Invalid("玩家角色不能通过外观编辑隐藏。");
                    if (narrator && request.Appearance!.Visibility != "player") throw new GameException("forbidden", "当前AI范围仅含公开单位。", 403);
                    if (CombatEngine.InCombat(c) && c.Combat!.Units.Any(u => u.BoardEntityId == entity.Id) && request.Appearance!.Visibility != "player")
                        throw new GameException("board_combat_active", "活动战斗参与者由公开战斗记录投影，不能通过外观编辑隐藏其实际状态。", 409);
                    var appearance = request.Appearance!;
                    if (namingVersion >= NpcNames.Version && entity.ActorId.Length > 0)
                        appearance = appearance with { Name = PartyEngine.CharacterFor(c, entity.ActorId).Name };
                    updated = entity with { Appearance = appearance }; break;
                case "remove": updated = WithPlacement(entity, placement with { OnMap = false, Path = [] }); break;
            }
            if (move is null)
            {
                changedIds.Add(entity.Id);
                entities[entities.FindIndex(e => e.Id == entity.Id)] = updated;
            }
        }
        // All batch entries validated before touching the aggregate.
        if (entities.Count > 2048) throw Invalid("棋盘单位超过存档可容纳的范围。");
        c.Board = board;
        board.Entities.Clear(); board.Entities.AddRange(entities);
        if (namingVersion >= NpcNames.Version && request.Operation == "update" && CombatEngine.InCombat(c))
            foreach (var unit in c.Combat!.Units.Where(u => u.BoardEntityId == request.EntityId))
            {
                var entity = entities.Single(e => e.Id == request.EntityId);
                if (entity.ActorId.Length == 0) unit.Name = entity.Appearance.Name;
            }
        string operationId = Guid.NewGuid().ToString();
        if (move is not null)
        {
            board.Moves.Add(move);
            c.PendingRulings.Add(new(rulingId, "棋盘移动：" + Find(c, move.EntityId).Appearance.Name, "pending",
                "此移动需要战斗执行或裁定；实际位置尚未改变。", c.ActingActorId, c.SceneId, c.Combat?.Status == "active" ? c.Combat.Id : "", BoardMoveId: move.Id));
        }
        else
        {
            EncounterConcealment.RefreshSight(c, map);
        }
        return new(status, move is null ? changedIds.ToArray() : [move.EntityId], operationId, rulingId,
            status == "pending" ? "只保存移动意图，实际位置未改变。" : "已保存棋盘操作；不代表召唤、取得物品或支付资源。");
    }

    private static BoardEntity Create(Campaign c, List<BoardEntity> entities, BoardSpawn spawn, bool narrator, bool encounterSetup = false, bool controlPlayers = false,
        int namingVersion = NpcNames.Version, ISet<string>? reservedNames = null)
    {
        if (spawn is null || spawn.Source is null || spawn.Appearance is null || spawn.ExistingId is null || spawn.ActorId is null) throw Invalid();
        if (spawn.ExistingId.Length > 0)
        {
            if (spawn.Statistics is not null || spawn.Character is not null || spawn.Build is not null || spawn.ActorId.Length > 0 || spawn.Source.Kind != "existing" ||
                spawn.Source.Id.Length > 0 || spawn.Source.EncounterId.Length > 0 || spawn.Source.RulesId.Length > 0 || spawn.Source.ContentVersion.Length > 0)
                throw Invalid("再次摆放只引用已有实例，不能更换来源或补充数值。");
            return entities.FirstOrDefault(e => e.Id == spawn.ExistingId && CanView(c, e, narrator)) ?? throw Missing();
        }
        ValidateSource(spawn.Source); ValidateAppearance(spawn.Appearance); ValidateStatistics(spawn.Statistics);
        if (spawn.Kind is not ("creature" or "object") || spawn.Character is not null) throw Invalid("完整NPC角色须由已校验的角色创建入口建立。");
        if (narrator && spawn.Appearance.Visibility != "player" && !encounterSetup) throw new GameException("forbidden", "普通棋盘工具只能创建公开单位。", 403);
        string actor = "", characterId = "", faction = "";
        BoardStatistics? statistics = spawn.Statistics; var appearance = spawn.Appearance; var source = spawn.Source;
        Character? builtCharacter = null;
        string? sourceName = null;
        if (spawn.Build is not null)
        {
            if (narrator || !PartyEngine.IsHost(c)) throw new GameException("forbidden", "完整NPC建卡由主持提交已验证的构筑选择。", 403);
            if (source.Kind != "custom" || spawn.Kind != "creature" || statistics is not null || spawn.ActorId.Length != 0)
                throw Invalid("完整NPC只接收独立构筑，不混用模板、玩家席位或自报机械数值。");
            builtCharacter = CharacterEngine.CreateComplete(spawn.Build.Identity?.Name ?? "", "", null, spawn.Build);
            characterId = builtCharacter.Id;
        }
        if (source.Kind == "player")
        {
            if (source.Id != spawn.ActorId || statistics is not null || spawn.Kind != "creature" || appearance.Visibility != "player" ||
                spawn.ActorId != c.ActingActorId && !(narrator && controlPlayers)) throw Invalid("玩家棋子须绑定获准席位的实际角色。");
            var member = PartyEngine.Characters(c).SingleOrDefault(p => p.Id == spawn.ActorId);
            if (member.Character is null) throw new GameException("forbidden", "只能摆放本战役已获准的实际角色。", 403);
            actor = spawn.ActorId; var ch = member.Character; characterId = ch.Id;
            appearance = appearance with { Name = ch.Name };
            var existing = entities.SingleOrDefault(e => e.ActorId == actor);
            if (existing is not null) return existing;
        }
        else
        {
            if (!PartyEngine.IsHost(c) && !narrator) throw new GameException("forbidden", "非玩家单位由主持创建。", 403);
            if (spawn.ActorId.Length != 0) throw Invalid();
            switch (source.Kind)
            {
                case "npc":
                    if (statistics is not null || spawn.Kind != "creature") throw Invalid("人物来源没有这些机械数值；不能借摆放修改资料。");
                    var npc = c.Adventure?.Npcs.FirstOrDefault(n => n.Id == source.Id) ?? throw Invalid("找不到人物来源。");
                    if (narrator && !ContentRuntime.World(c).Npcs.Any(n => n.Id == npc.Id)) throw Missing();
                    var existing = entities.SingleOrDefault(e => e.Source.Kind == "npc" && e.Source.Id == npc.Id);
                    if (existing is not null) return existing;
                    faction = npc.FactionId;
                    sourceName = npc.Name;
                    if (namingVersion >= NpcNames.Version && !NpcNames.IsGeneric(npc.Name)) appearance = appearance with { Name = npc.Name };
                    break;
                case "enemy":
                    if (statistics is not null || spawn.Kind != "creature") throw Invalid("遭遇单位的初始数值来自原内容。");
                    var encounter = ContentRuntime.FindEncounter(c, source.EncounterId);
                    var enemy = encounter?.Enemies.FirstOrDefault(e => e.Id == source.Id) ?? throw Invalid("找不到遭遇单位来源。");
                    if (!encounterSetup && c.RuntimeEncounters?.Any(e => e.Definition.Id == source.EncounterId) == true)
                        return entities.SingleOrDefault(e => e.Source.EncounterId == source.EncounterId && e.Source.Id == source.Id)
                            ?? throw Invalid("运行时遭遇不允许补造或复制敌方实例。");
                    if (narrator && ContentRuntime.SceneEncounter(c)?.Id != source.EncounterId) throw Missing();
                    statistics = new(enemy.HitPoints, enemy.HitPoints, enemy.ArmorClass, enemy.Speed, enemy.InitiativeModifier,
                        SavingThrows: enemy.SavingThrows);
                    source = source with { RulesId = enemy.RulesId ?? "" };
                    sourceName = enemy.Name;
                    break;
                case "custom":
                    if (source.Id.Length != 0 || source.EncounterId.Length != 0 || source.RulesId.Length != 0) throw Invalid("自定义单位不能冒充规则来源。");
                    if (narrator && statistics is not null) throw Invalid("AI创建外观不授予机械数值；需已验证来源或原裁定。");
                    break;
                default: throw Invalid("来源须为player、npc、enemy或custom。");
            }
        }
        if (appearance.IconKey.Length == 0) appearance = appearance with { IconKey = BoardArt.Default(appearance.Name, source.Kind, source.RulesId) };
        if (namingVersion >= NpcNames.Version && spawn.Kind == "creature" && actor.Length == 0 && !encounterSetup)
        {
            // Full builds retain their validated identity. A named author source wins over a
            // generic appearance, while a supplied individual name on a template stays intact.
            string name = builtCharacter?.Name ?? (NpcNames.IsGeneric(appearance.Name) && sourceName is not null && !NpcNames.IsGeneric(sourceName)
                ? sourceName : appearance.Name);
            appearance = appearance with { Name = builtCharacter is null
                ? NpcNames.ForCreation(name, reservedNames ?? NpcNames.Reserved(c, entities.Select(e => e.Appearance.Name))) : name };
        }
        if (source.Kind is "npc" or "enemy") source = source with { ContentVersion = c.Adventure!.Version };
        string id;
        do id = Guid.NewGuid().ToString();
        while (entities.Any(e => e.Id[..8] == id[..8]));
        return new(id, spawn.Kind, source, appearance, actor, characterId, faction, statistics, builtCharacter);
    }

    private static bool MovementRestricted(Campaign c, BoardEntity entity) => MovementRestricted(Statistics(c, entity)?.Conditions);
    public static bool MovementRestricted(string[]? conditions) =>
        conditions?.Any(s => s is "Unconscious" or "Restrained" or "Grappled" or "Paralyzed" or "Petrified" or "Stunned" or "Dead") == true;

    private static void RequireControl(Campaign c, BoardEntity e, bool narrator, bool controlPlayers)
    {
        if (!CanView(c, e, narrator)) throw Missing();
        if (!CanControl(c, e, narrator, controlPlayers)) throw new GameException("forbidden", "只能操作本人角色或授权主持的单位。", 403);
    }
    private static BoardPoint Position(MapAssetView map, BoardPoint point, bool snap)
    {
        ValidatePoint(point);
        if (!snap) return point;
        var g = map.Purpose == "tactical" ? MapScale.TacticalGrid(map) : map.Grid;
        if (g.Type != "square" || g.Uncalibrated || !double.IsFinite(g.CellPixels) || g.CellPixels <= 0)
            throw Invalid("吸附需要已标定的方格；未标定图仍可自由摆放。");
        double x = (Math.Floor((point.X * map.Width - g.OffsetX) / g.CellPixels) + .5) * g.CellPixels + g.OffsetX;
        double y = (Math.Floor((point.Y * map.Height - g.OffsetY) / g.CellPixels) + .5) * g.CellPixels + g.OffsetY;
        var result = new BoardPoint(x / map.Width, y / map.Height); ValidatePoint(result); return result;
    }
    private static void ValidatePoint(BoardPoint? p)
    {
        if (p is null || !double.IsFinite(p.X) || !double.IsFinite(p.Y) || p.X is < 0 or > 1 || p.Y is < 0 or > 1) throw Invalid("坐标须为0至1的有限数值。");
    }
    private static void ValidateAppearance(BoardAppearance a)
    {
        if (a is null || string.IsNullOrWhiteSpace(a.Name) || a.Name.Length > 120 || a.Name.Any(char.IsControl) ||
            a.Summary is null || a.Summary.Length > 2400 || a.IconKey is null || a.IconKey.Length > 100 ||
            a.IconKey.Any(ch => !char.IsAsciiLetterOrDigit(ch) && ch is not ('-' or '_')) || a.Visibility is not ("player" or "gm")) throw Invalid("名称、说明、图标资源键或显示范围无效。");
    }
    public static void ValidateCommand(BoardCommandRequest r)
    {
        if (r.Operation is not ("spawn" or "move" or "update" or "remove") || r.EntityId is null || r.OperationId is null ||
            (r.Operation == "spawn") != (r.Spawns is not null) || r.Spawns is { Length: < 1 or > 32 } ||
            (r.Operation == "move") != (r.Destination is not null) || (r.Operation == "update") != (r.Appearance is not null) ||
            r.OperationId.Length > 0 ||
            (r.Operation is "move" or "update" or "remove") != (r.EntityId.Length > 0) ||
            r.Operation != "move" && r.Path is not null || r.Path is { Length: > 64 } ||
            r.Snap && r.Operation is not ("spawn" or "move")) throw Invalid();
    }
    private static void ValidateStatistics(BoardStatistics? s)
    {
        if (s is null) return;
        if (s.MaxHitPoints is <= 0 or > 100000 || s.HitPoints is < 0 || s.HitPoints is not null && (s.MaxHitPoints is null || s.HitPoints > s.MaxHitPoints) ||
            s.ArmorClass is < 0 or > 100 || s.Speed is < 0 or > 10000 || s.InitiativeModifier is < -100 or > 100 || s.TemporaryHitPoints is < 0 or > 100000 ||
            s.Abilities is { Length: > 6 } || s.Abilities?.Any(a => a is null || a.Score is < 1 or > 30 || a.Modifier != (int)Math.Floor((a.Score - 10) / 2d)) == true ||
            s.Resources is { Length: > 128 } || s.Inventory is { Length: > 400 } ||
            s.Resources?.Any(r => r is null || r.Current < 0 || r.Maximum < r.Current) == true || s.Inventory?.Any(i => i is null || i.Quantity < 0) == true)
            throw Invalid("初始单位数值无效；未知值应省略，不填零或猜测。");
        foreach (var values in new[] { s.Conditions, s.Features, s.Actions, s.Senses, s.Languages, s.Resistances, s.Immunities, s.Vulnerabilities })
            if (values is { Length: > 128 } || values?.Any(v => v is null || v.Length > 2400) == true) throw Invalid();
    }
}
