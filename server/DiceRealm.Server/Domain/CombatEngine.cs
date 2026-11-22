namespace DiceRealm.Server.Domain;

// Verified level 1–2 rule operations. Arena data, opponents and outcomes come from the imported script.
// This implementation supports visible melee opponents and explicitly nonlethal encounters only.
public sealed class CombatEngine(IDice dice)
{
    public static readonly string[] Kinds = ["combat.start", "combat.move", "combat.attack", "combat.dodge",
        "combat.dash", "combat.disengage", "combat.cast", "combat.action_surge", "combat.second_wind", "combat.end_turn", "combat.retreat", "rest.short", "rest.recover",
        "combat.react", "combat.death_save", "combat.stabilize", "combat.search", "combat.stand", "combat.pick_up", "combat.recover_stable", "combat.concentration_save", "combat.concentration_end", "combat.quick_dash", "combat.area_save", "combat.missile_allocate", "combat.missile_cast"];
    public Resolution ContinueNarrated(Campaign c, bool coalesceIdleTurns = false) => new StandardCombatEngine(dice).ContinueNarrated(c, coalesceIdleTurns);
    public static bool InCombat(Campaign c) => c.Combat?.Status == "active";
    public static bool Restricted(Campaign c) => InCombat(c) || c.ActingCharacter.Conditions.Contains("Unconscious") || c.ActingCharacter.Conditions.Contains("Prone");
    private static CombatUnit Player(Campaign c) => c.Combat!.Units.Single(u => u.Id == c.ActingActorId);
    private static bool Capable(CombatUnit u) => u.HitPoints > 0 && !u.Withdrawn && !u.RecoveryRestRequired;
    private static bool Enemy(CombatUnit u) => u.Team == "enemy";
    private static IEnumerable<CombatUnit> Enemies(CombatState b) => b.Units.Where(u => Enemy(u) && Capable(u));
    private static ContentEncounter Definition(Campaign c) => c.Adventure!.Scenes.Select(s => s.Encounter).Single(e => e?.Id == c.Combat!.DefinitionId)!;
    private static int ResourceValue(Campaign c, string name) => CharacterEngine.Value(c.ActingCharacter, name);
    private static void ResourceChange(Campaign c, string name, int delta) => c.ActingCharacter = c.ActingCharacter with
    { Resources = c.ActingCharacter.Resources.Select(r => r.Name == name ? r with { Current = Math.Clamp(r.Current + delta, 0, r.Maximum) } : r).ToArray() };
    private static bool Boundary(CombatState b, CombatUnit u) => u.X == 0 || u.Y == 0 || u.X == b.Width - 1 || u.Y == b.Height - 1;
    private static bool Blocked(CombatState b, int x, int y) => x < 0 || y < 0 || x >= b.Width || y >= b.Height || b.Cells.Any(t => t.X == x && t.Y == y && t.Terrain == "blocked");
    public static bool Adjacent(CombatState b, int x, int y, int nx, int ny)
    {
        if (Math.Max(Math.Abs(nx - x), Math.Abs(ny - y)) != 1 || Blocked(b, nx, ny)) return false;
        // A diagonal cannot cross a blocked corner. This arena has no cover or unseen combatants.
        return nx == x || ny == y || (!Blocked(b, nx, y) && !Blocked(b, x, ny));
    }
    private static bool InReach(CombatState b, CombatUnit a, CombatUnit z) => Adjacent(b, a.X, a.Y, z.X, z.Y);
    private static (int X, int Y) RetreatExit(CombatState b, CombatUnit p, CombatUnit enemy)
    {
        // Crossing the authored arena boundary is not automatically leaving weapon reach.
        // Pick a legal outward step, preferring one farther from the opponent. Outside the
        // arena is open ground; map bounds must not be treated as walls for this one step.
        bool Rock(int x, int y) => b.Cells.Any(t => t.X == x && t.Y == y && t.Terrain == "blocked");
        var exits = new List<(int X, int Y)>();
        for (int y = p.Y - 1; y <= p.Y + 1; y++)
        for (int x = p.X - 1; x <= p.X + 1; x++)
            if ((x < 0 || y < 0 || x >= b.Width || y >= b.Height) &&
                (x == p.X || y == p.Y || (!Rock(x, p.Y) && !Rock(p.X, y)))) exits.Add((x, y));
        return exits.OrderByDescending(s => Math.Max(Math.Abs(s.X - enemy.X), Math.Abs(s.Y - enemy.Y))).First();
    }
    public static int StepCost(CombatState b, int x, int y) => b.Cells.Any(t => t.X == x && t.Y == y && t.Terrain == "difficult") ? 10 : 5;
    private static IEnumerable<(int X, int Y)> Steps(CombatState b, CombatUnit u)
    {
        for (int y = u.Y - 1; y <= u.Y + 1; y++)
        for (int x = u.X - 1; x <= u.X + 1; x++)
            if (Adjacent(b, u.X, u.Y, x, y) && !b.Units.Any(other => other.Id != u.Id && other.X == x && other.Y == y && other.HitPoints > 0 && !other.Withdrawn))
                yield return (x, y);
    }
    public static ActionChoice[] Choices(Campaign c)
    {
        if (StandardCombatEngine.IsStandard(c) && InCombat(c)) return StandardCombatEngine.Choices(c);
        var choices = new List<ActionChoice>();
        if (InCombat(c))
        {
            var b = c.Combat!; var p = Player(c);
            if (b.ActiveActorId != p.Id || !Capable(p)) return [];
            foreach (var (x, y) in Steps(b, p).Where(s => StepCost(b, s.X, s.Y) <= p.MovementRemaining))
                choices.Add(new("combat.move", $"{x},{y}", $"移动至 {x},{y}"));
            if (p.ActionAvailable)
            {
                foreach (var enemy in Enemies(b).Where(e => InReach(b, p, e)))
                    if (CharacterEngine.Weapon(c.ActingCharacter) is { } weapon)
                        choices.Add(new("combat.attack", enemy.Id, weapon.Name + " / " + enemy.Name));
                if (!p.SurgeAction && CharacterEngine.CanCast(c, "mage-armor")) choices.Add(new("combat.cast", "mage-armor:self", "Mage Armor / 自身（1 环）"));
                foreach (var enemy in Enemies(b).Where(e => !p.SurgeAction && Math.Max(Math.Abs(p.X - e.X), Math.Abs(p.Y - e.Y)) * b.CellFeet <= 120))
                {
                    if (CharacterEngine.CanCast(c, "fire-bolt")) choices.Add(new("combat.cast", "fire-bolt:" + enemy.Id, "Fire Bolt / " + enemy.Name + "（戏法）"));
                    if (CharacterEngine.CanCast(c, "magic-missile")) choices.Add(new("combat.cast", "magic-missile:" + enemy.Id, "Magic Missile / " + enemy.Name + "（1 环）"));
                }
                choices.Add(new("combat.dodge", "", "Dodge / 闪避"));
                choices.Add(new("combat.dash", "", "Dash / 疾走"));
                choices.Add(new("combat.disengage", "", "Disengage / 撤离"));
            }
            if (!p.ActionAvailable && ResourceValue(c, "Action Surge") > 0) choices.Add(new("combat.action_surge", "", "Action Surge / 再获得一个非 Magic 动作"));
            if (p.BonusActionAvailable && ResourceValue(c, "Second Wind") > 0 && p.HitPoints < p.MaxHitPoints)
                choices.Add(new("combat.second_wind", "", "Second Wind / 自疗"));
            if (Boundary(b, p) && p.MovementRemaining >= 5) choices.Add(new("combat.retreat", "", "离开边界 / 撤退"));
            choices.Add(new("combat.end_turn", "", "结束回合"));
            return choices.ToArray();
        }
        choices.AddRange(CharacterEngine.Choices(c));
        if (StandardCombatEngine.IsStandard(c)) choices.AddRange(StandardCombatEngine.Choices(c));
        if (!c.ActingCharacter.Conditions.Contains("Prone") && !c.ActingCharacter.Conditions.Contains("Unconscious") &&
            ContentRuntime.AvailableEncounter(c) is { } encounter && CharacterReviews.CanAct(c) && PartyEngine.Ready(c) &&
            (encounter.Mode == StandardCombatEngine.Mode ? StandardCombatEngine.CanStart(c) : BuildRuntime.PartyCanAutomateCombat(c)))
            choices.Add(new("combat.start", "", encounter.StartLabel));
        return choices.ToArray();
    }
    public Resolution Resolve(Campaign c, string kind, string target, int namingVersion = NpcNames.Version)
    {
        if (!Choices(c).Any(a => a.Kind == kind && a.Target == target))
            throw new GameException("action_unavailable", "当前回合、距离或资源不允许此行动。", 409);
        if (StandardCombatEngine.Uses(c, kind)) return new StandardCombatEngine(dice).Resolve(c, kind, target, namingVersion);
        if (CharacterEngine.Kinds.Contains(kind)) return new CharacterEngine(dice).Resolve(c, kind, target);
        int before = kind == "combat.start" ? 0 : c.Combat?.LogSequence ?? 0;
        string summary;
        if (kind == "combat.start") { Start(c, namingVersion); summary = "先攻已确定。选择格子移动，靠近后攻击；可从棋盘边界撤退。"; }
        else
        {
            var b = c.Combat!; var p = Player(c);
            switch (kind)
            {
                case "combat.move":
                    var xy = target.Split(',').Select(int.Parse).ToArray();
                    foreach (var enemy in Enemies(b).ToArray())
                        if (InCombat(c) && Capable(p) && InReach(b, enemy, p) && !Adjacent(b, enemy.X, enemy.Y, xy[0], xy[1])) Opportunity(c, enemy);
                    if (InCombat(c) && Capable(p))
                    {
                        var cost = StepCost(b, xy[0], xy[1]); p.MovementRemaining -= cost;
                        p.X = xy[0]; p.Y = xy[1]; Add(c, kind, p.Id, $"移动至 ({p.X},{p.Y})，消耗 {cost} 尺，剩余 {p.MovementRemaining} 尺。", displayText: p.Name + "移动。");
                    }
                    break;
                case "combat.attack": p.ActionAvailable = false; Attack(c, true, false, b.Units.Single(u => u.Id == target)); break;
                case "combat.cast": p.ActionAvailable = false; Cast(c, target); break;
                case "combat.dodge": p.ActionAvailable = false; p.Dodging = true; Add(c, kind, p.Id, "Dodge：直到自己下回合开始，可见敌人的攻击具有劣势。", displayText: p.Name + "采取闪避。"); break;
                case "combat.dash": p.ActionAvailable = false; p.MovementRemaining += p.Speed; Add(c, kind, p.Id, $"Dash：增加 {p.Speed} 尺本回合移动额度。", displayText: p.Name + "疾走。"); break;
                case "combat.disengage": p.ActionAvailable = false; p.Disengaging = true; Add(c, kind, p.Id, "Disengage：本回合移动不触发借机攻击。", displayText: p.Name + "谨慎撤离，避开借机攻击。"); break;
                case "combat.action_surge":
                    ResourceChange(c, "Action Surge", -1); p.ActionAvailable = true; p.SurgeAction = true;
                    Add(c, kind, p.Id, "Action Surge：消耗 1 次资源，获得额外动作；此动作不能用于 Magic。每回合 Savage Attacker 限额不会重置。", displayText: p.Name + "奋力再行动一次。"); break;
                case "combat.second_wind":
                    p.BonusActionAvailable = false; ResourceChange(c, "Second Wind", -1);
                    var roll = Roll(10); var healed = Heal(c, roll + c.ActingCharacter.Level);
                    Add(c, kind, p.Id, $"Second Wind：d10 [{roll}] + {c.ActingCharacter.Level}，实际恢复 {healed} HP；消耗附赠动作和 1 次资源。", displayText: $"{p.Name}回气，恢复{healed}点生命。"); break;
                case "combat.end_turn":
                    Add(c, kind, p.Id, "结束玩家回合。", displayText: p.Name + "结束回合。"); p.Disengaging = false;
                    AdvanceTurn(c);
                    break;
                case "combat.retreat":
                    var nearest = Enemies(b).OrderBy(e => Math.Max(Math.Abs(e.X - p.X), Math.Abs(e.Y - p.Y))).First();
                    var exit = RetreatExit(b, p, nearest);
                    foreach (var enemy in Enemies(b).ToArray())
                        if (InCombat(c) && Capable(p) && Math.Max(Math.Abs(exit.X - enemy.X), Math.Abs(exit.Y - enemy.Y)) > 1) Opportunity(c, enemy);
                    if (InCombat(c) && Capable(p))
                    {
                        p.MovementRemaining -= 5; p.Withdrawn = true;
                        Add(c, kind, p.Id, $"花费 5 尺移动至边界外 ({exit.X},{exit.Y})。此角色已撤退；敌人不攻击区域外目标。其他队员继续自己的回合。", displayText: p.Name + "撤离战场。");
                        if (!FinishParty(c)) AdvanceTurn(c);
                    }
                    break;
            }
            summary = string.Join("\n", b.Log.Where(e => e.Sequence > before).Select(e => e.Text));
        }
        BoardCombat.Commit(c);
        var entries = c.Combat?.Log.Where(e => e.Sequence > before).ToArray() ?? [];
        return new("resolved", kind, summary, null, ["combat:" + (c.Combat?.Status ?? "none")], CombatLog: entries);
    }
    private void Start(Campaign c, int namingVersion)
    {
        var definition = ContentRuntime.AvailableEncounter(c)!;
        var preparation = BoardCombat.Prepare(c, definition, c.BoardMapContext);
        ContentRuntime.Apply(c, definition.OnStart);
        if (preparation is not null) preparation = BoardCombat.Prepare(c, definition, c.BoardMapContext);
        c.AttemptedEncounters.Add(definition.Id);
        var enemyDefinitions = preparation is null ? NpcNames.EncounterInstances(c, definition.Enemies, namingVersion) : definition.Enemies;
        var players = preparation is not null ? Array.Empty<CombatUnit>() : PartyEngine.Characters(c).Where(p => !GameLifecycle.Dead(c, p.Id)).Select((entry, index) =>
        {
            var ch = entry.Character;
            var unit = new CombatUnit { Id = entry.Id, Team = "party", Name = ch.Name, X = 1, Y = new[] { 2, 1, 3, 4 }[index], HitPoints = ch.HitPoints,
                MaxHitPoints = ch.MaxHitPoints, ArmorClass = ch.ArmorClass, Speed = BuildRuntime.Speed(ch),
                InitiativeRoll = Roll(20), InitiativeModifier = ch.BuildMechanics?.InitiativeBonus ?? CharacterEngine.Ability(ch, "dexterity") + ch.ProficiencyBonus };
            unit.Initiative = unit.InitiativeRoll + unit.InitiativeModifier; return unit;
        }).ToArray();
        var enemies = preparation is not null ? Array.Empty<CombatUnit>() : enemyDefinitions.Select(e =>
        {
            var unit = new CombatUnit { Id = e.Id, Team = "enemy", Name = e.Name, X = e.X, Y = e.Y, HitPoints = e.HitPoints,
                MaxHitPoints = e.HitPoints, ArmorClass = e.ArmorClass, Speed = e.Speed, InitiativeRoll = Roll(20), InitiativeModifier = e.InitiativeModifier };
            unit.Initiative = unit.InitiativeRoll + unit.InitiativeModifier; return unit;
        }).ToArray();
        var units = preparation?.Units ?? players.Concat(enemies).ToArray();
        if (preparation is not null)
            foreach (var unit in units)
            {
                unit.InitiativeRoll = Roll(20);
                unit.Initiative = unit.InitiativeRoll + unit.InitiativeModifier;
            }
        var b = c.Combat = new CombatState { Id = Guid.NewGuid().ToString(), DefinitionId = definition.Id, Title = definition.Title, Units = units, ActiveActorId = "",
            TurnOrder = units.OrderByDescending(u => u.Initiative).Select(u => u.Id).ToArray(), Cells = preparation is null ? definition.Cells : [],
            BoardLayout = preparation?.Layout, Width = preparation?.Layout.Width ?? 7, Height = preparation?.Layout.Height ?? 5 };
        foreach (var u in units) Add(c, "initiative", u.Id, $"先攻：{u.Name} d20 [{u.InitiativeRoll}] + {u.InitiativeModifier} = {u.Initiative}。同分按加入顺序，队员先于敌人（本场裁定）。");
        if (preparation is null)
            foreach (var e in enemyDefinitions) Add(c, "scenario", e.Id, $"{e.Name}：AC {e.ArmorClass} / HP {e.HitPoints} / 速度 {e.Speed} 尺 / 近战 {e.AttackBonus:+0;-0;0}，{e.DamageDice}d{e.DamageDie}+{e.DamageBonus}。本剧本设置为非致命遭遇。每格 5 尺，没有掩护或隐匿；所有队员倒下或撤退才结束。");
        else
            foreach (var u in units.Where(Enemy))
            {
                var e = BoardCombat.EnemyProfile(c, u);
                Add(c, "scenario", u.Id, $"{u.Name}：AC {u.ArmorClass} / HP {u.HitPoints}/{u.MaxHitPoints} / 速度 {u.Speed} 尺 / 近战 {e.AttackBonus:+0;-0;0}，{e.DamageDice}d{e.DamageDie}+{e.DamageBonus}。使用实际棋子与校准底图，每格5尺；不从图片推断地形。此遭遇仍按原非致命规则结算。");
            }
        b.ActiveActorId = b.TurnOrder[0];
        if (Enemy(b.Units.Single(u => u.Id == b.ActiveActorId))) { NpcTurn(c); if (InCombat(c)) AdvanceTurn(c); }
        else BeginTurn(c, b.Units.Single(u => u.Id == b.ActiveActorId));
    }
    private static bool FinishParty(Campaign c)
    {
        var b = c.Combat!;
        if (b.Units.Any(u => !Enemy(u) && Capable(u))) return false;
        b.Status = b.Units.Any(u => u.RecoveryRestRequired) ? "defeated" : "retreated"; b.ActiveActorId = "";
        Add(c, "aftermath", "system", "所有队员已经撤退或被非致命击倒。非致命遭遇结束；倒下的队员可以完成安全短休。",
            displayText: b.Status == "retreated" ? "全队撤离，战斗结束。" : "队伍失去战斗力，战斗结束。");
        return true;
    }
    private void AdvanceTurn(Campaign c)
    {
        var b = c.Combat!;
        while (InCombat(c))
        {
            if (FinishParty(c)) return;
            int next = (Array.IndexOf(b.TurnOrder, b.ActiveActorId) + 1) % b.TurnOrder.Length;
            if (next == 0) { b.Round++; CharacterEngine.Advance(c, 6); }
            b.ActiveActorId = b.TurnOrder[next];
            var u = b.Units.Single(u => u.Id == b.ActiveActorId);
            if (!Capable(u)) continue;
            if (Enemy(u)) { NpcTurn(c); continue; }
            BeginTurn(c, u); return;
        }
    }
    private static void BeginTurn(Campaign c, CombatUnit u)
    {
        var b = c.Combat!;
        b.ActiveActorId = u.Id; u.MovementRemaining = u.Speed; u.ActionAvailable = u.BonusActionAvailable = u.ReactionAvailable = true;
        u.Dodging = u.Disengaging = u.SavageAttackerUsed = u.SurgeAction = false;
        Add(c, "turn", u.Id, $"第 {b.Round} 轮 · {u.Name} 的回合。", displayText: $"第{b.Round}轮，轮到{u.Name}行动。");
    }
    private void NpcTurn(Campaign c)
    {
        var b = c.Combat!; var enemy = b.Units.Single(u => u.Id == b.ActiveActorId);
        var candidate = b.Units.Where(u => !Enemy(u) && Capable(u)).Select(u => new { Unit = u, Path = PathToReach(b, enemy, u) })
            .Where(x => InReach(b, enemy, x.Unit) || x.Path.Count > 0)
            .OrderBy(x => x.Path.Sum(step => StepCost(b, step.X, step.Y))).FirstOrDefault();
        BeginTurn(c, enemy);
        if (candidate is null) { Add(c, "hold", enemy.Id, "敌人没有能抵达的合法近战目标，留在原地。", displayText: enemy.Name + "留在原地。"); return; }
        // Stop at the first reachable party member rather than walking out of another
        // player's reach. This bounded encounter never auto-resolves a player's reaction.
        var p = candidate.Unit; var path = candidate.Path;
        int cost = path.Sum(s => StepCost(b, s.X, s.Y));
        if (cost > enemy.MovementRemaining) { enemy.ActionAvailable = false; enemy.MovementRemaining += enemy.Speed; Add(c, "combat.dash", enemy.Id, "敌人使用 Dash 接近，放弃本回合攻击。", displayText: enemy.Name + "疾走接近。"); }
        foreach (var cell in path)
        {
            var stepCost = StepCost(b, cell.X, cell.Y); if (stepCost > enemy.MovementRemaining) break;
            enemy.X = cell.X; enemy.Y = cell.Y; enemy.MovementRemaining -= stepCost;
            Add(c, "combat.move", enemy.Id, $"敌人移动至 ({enemy.X},{enemy.Y})，花费 {stepCost} 尺。", displayText: enemy.Name + "移动。");
        }
        if (enemy.ActionAvailable && InReach(b, enemy, p)) { enemy.ActionAvailable = false; Attack(c, false, false, enemy, p); }
    }
    // Dijkstra on the tiny arena: difficult ground costs two squares and diagonal corner cuts are excluded.
    private static List<(int X, int Y)> PathToReach(CombatState b, CombatUnit enemy, CombatUnit target)
    {
        var start = (enemy.X, enemy.Y); var distances = new Dictionary<(int, int), int> { [start] = 0 };
        var prior = new Dictionary<(int, int), (int, int)>(); var queue = new PriorityQueue<(int X, int Y), int>(); queue.Enqueue(start, 0);
        while (queue.TryDequeue(out var cell, out int distance))
        {
            if (distance != distances[cell]) continue;
            if (Adjacent(b, cell.X, cell.Y, target.X, target.Y))
            {
                var result = new List<(int, int)>();
                while (cell != start) { result.Add(cell); cell = prior[cell]; } result.Reverse(); return result;
            }
            var cursor = new CombatUnit { Id = enemy.Id, X = cell.X, Y = cell.Y };
            foreach (var next in Steps(b, cursor))
            {
                var d = distance + StepCost(b, next.X, next.Y);
                if (distances.TryGetValue(next, out int old) && old <= d) continue;
                distances[next] = d; prior[next] = cell; queue.Enqueue(next, d);
            }
        }
        return [];
    }
    private void Opportunity(Campaign c, CombatUnit enemy)
    {
        var b = c.Combat!; var p = Player(c);
        if (enemy.ReactionAvailable && !p.Disengaging && InReach(b, enemy, p))
        { enemy.ReactionAvailable = false; Attack(c, false, true, enemy); }
    }
    private void Attack(Campaign c, bool playerAttacks, bool opportunity, CombatUnit enemy, CombatUnit? targetPlayer = null)
    {
        var b = c.Combat!; var p = targetPlayer ?? Player(c);
        var profile = BoardCombat.EnemyProfile(c, enemy);
        var ch = PartyEngine.CharacterFor(c, p.Id);
        var attacker = playerAttacks ? p : enemy; var defender = playerAttacks ? enemy : p;
        bool disadvantage = defender.Dodging;
        var weapon = CharacterEngine.Weapon(ch);
        var result = playerAttacks ? WeaponAttack(ch, defender.ArmorClass, disadvantage, !p.SavageAttackerUsed)
            : RollAttack(defender.ArmorClass, profile.AttackBonus, profile.DamageBonus, profile.DamageDice, profile.DamageDie, disadvantage, false, false, false);
        if (playerAttacks && result.Hit) p.SavageAttackerUsed = true;
        var rawDamage = result.Damage;
        string description = $"{attacker.Name}{(opportunity ? "借机攻击" : "攻击")}：d20 [{string.Join(",", result.Rolls)}] {result.Mode} +{result.Modifier} = {result.Total} vs AC {result.ArmorClass}；";
        if (result.Hit)
        {
            description += result.Critical ? "重击；" : "命中；";
            description += $"伤害骰 [{string.Join(",", result.DamageRolls)}]";
            if (result.AlternateRolls.Length > 0) description += $" / Savage Attacker [{string.Join(",", result.AlternateRolls)}]";
            description += $"，采用有效骰 [{string.Join(",", result.EffectiveDice)}] + {result.DamageModifier} = {rawDamage} 点{(playerAttacks ? weapon?.Id == "dagger" ? "穿刺" : weapon?.Id == "greatsword" ? "挥砍" : "钝击" : "钝击")}伤害。";
        }
        else description += result.Graze ? $"未命中，Graze 造成 {rawDamage} 点挥砍伤害（无伤害掷骰）。" : "未命中，无伤害。";
        Add(c, opportunity ? "opportunity_attack" : "attack", attacker.Id, description, result, target: defender.Id,
            displayText: attacker.Name + (opportunity ? "借机攻击" : "攻击") + defender.Name + (result.Hit ? result.Critical ? "，重击命中。" : "，命中。" : result.Graze && rawDamage > 0 ? "，未命中，但擦中了目标。" : "，落空。"));
        if (playerAttacks) DamageEnemy(c, enemy, rawDamage);
        else if (rawDamage >= p.HitPoints)
        {
            // XPHB 2024 p28: melee nonlethal reduces to ONE HP, unconscious, starts short rest.
            p.HitPoints = 1; p.RecoveryRestRequired = true;
            p.DroppedWeaponId = CharacterEngine.Weapon(ch)?.Id ?? "";
            if (p.Id == PartyEngine.HostId) { b.RecoveryRestRequired = true; b.DroppedWeaponId = p.DroppedWeaponId; }
            PartyEngine.SetCharacter(c, p.Id, PlayCatalog.SetEquipment(ch, p.DroppedWeaponId, false) with { HitPoints = 1, Conditions = ["Unconscious", "Prone"] });
            Add(c, "defeat", enemy.Id, $"{enemy.Name} 选择非致命击倒：{p.Name} 保留 1 HP，陷入 Unconscious / Prone，武器掉落。遭遇结束后可完成安全短休。", target: p.Id,
                displayText: $"{p.Name}受到{rawDamage}点伤害，被非致命击倒，昏迷倒地。");
            if (!FinishParty(c) && b.ActiveActorId == p.Id) AdvanceTurn(c);
        }
        else
        {
            p.HitPoints -= rawDamage; PartyEngine.SetCharacter(c, p.Id, ch with { HitPoints = p.HitPoints });
            if (rawDamage > 0) Add(c, "damage", p.Id, $"{p.Name}承受{rawDamage}点伤害；HP {p.HitPoints}/{p.MaxHitPoints}。", displayText: $"{p.Name}受到{rawDamage}点伤害。");
        }
    }
    private static void DamageEnemy(Campaign c, CombatUnit enemy, int damage)
    {
        var b = c.Combat!;
        int amount = damage, absorbed = 0;
        if (enemy.BoardBody is { } body)
        {
            absorbed = Math.Min(Math.Max(0, damage), body.TemporaryHitPoints);
            body.TemporaryHitPoints -= absorbed;
            damage -= absorbed;
        }
        enemy.HitPoints = Math.Max(0, enemy.HitPoints - damage);
        if (amount > 0) Add(c, "damage", enemy.Id, $"{enemy.Name}承受{amount}点伤害（临时HP吸收{absorbed}）；HP {enemy.HitPoints}/{enemy.MaxHitPoints}。",
            displayText: $"{enemy.Name}受到{amount}点伤害" + (absorbed > 0 ? $"，临时防护吸收{absorbed}点" : "") + (enemy.HitPoints == 0 ? "，失去战斗力。" : "。"));
        if (enemy.HitPoints != 0 || Enemies(b).Any()) return;
        b.Status = "victory"; b.ActiveActorId = "";
        var outcome = Definition(c).Victory;
        ContentRuntime.Apply(c, outcome.Effects);
        Add(c, "victory", c.ActingActorId, outcome.Text, displayText: "战斗结束，队伍获胜。");
    }
    private void Cast(Campaign c, string target)
    {
        var b = c.Combat!; var p = Player(c);
        var id = target.Split(':')[0];
        var enemy = id == "mage-armor" ? null : b.Units.Single(u => u.Id == target.Split(':')[1]);
        if (id != "fire-bolt") CharacterEngine.Change(c, "Spell Slots (1st)", -1);
        if (id == "mage-armor")
        {
            CharacterEngine.MageArmor(c);
            Add(c, "spell", p.Id, "Mage Armor：消耗动作与 1 个 1 环位，自身 AC 改为 13 + DEX，持续 8 小时。",
                spell: new(id, p.Id, 1, [], 0, ""), displayText: p.Name + "施放法师护甲保护自己。");
        }
        else if (id == "magic-missile")
        {
            int[] rolls = [Roll(4), Roll(4), Roll(4)]; int damage = rolls.Sum() + 3;
            Add(c, "spell", p.Id, $"Magic Missile：消耗动作与 1 个 1 环位，三枚飞弹同时命中 {enemy!.Name}；d4 [{string.Join(",", rolls)}]，每枚 +1，共 {damage} Force 伤害，无攻击或豁免。",
                spell: new(id, enemy!.Id, 1, rolls, damage, "Force"), target: enemy.Id, displayText: p.Name + "施放魔法飞弹，三枚飞弹命中" + enemy.Name + "。");
            DamageEnemy(c, enemy!, damage);
        }
        else
        {
            bool disadvantage = Enemies(b).Any(e => InReach(b, e, p)) || enemy!.Dodging;
            var hit = RollAttack(enemy!.ArmorClass, c.ActingCharacter.Spellcasting!.AttackBonus, 0, 1, 10, disadvantage, false, false, false);
            Add(c, "spell", p.Id, $"Fire Bolt：远程法术攻击，{(disadvantage ? "近身或闪避造成劣势" : "正常")}，d20 [{string.Join(",", hit.Rolls)}] +{hit.Modifier} = {hit.Total} vs AC {hit.ArmorClass}；{(hit.Critical ? "重击" : hit.Hit ? "命中" : "未命中")}，{hit.Damage} Fire 伤害。", hit,
                new(id, enemy.Id, 0, hit.DamageRolls, hit.Damage, "Fire"), target: enemy.Id,
                displayText: p.Name + "向" + enemy.Name + "施放火焰箭" + (hit.Hit ? hit.Critical ? "，重击命中。" : "，命中。" : "，落空。"));
            DamageEnemy(c, enemy!, hit.Damage);
        }
    }
    public AttackRoll WeaponAttack(Character character, int armorClass, bool disadvantage = false, bool savageAttacker = true)
    {
        var weapon = CharacterEngine.Weapon(character) ?? throw new GameException("missing_weapon", "没有准备可自动结算的武器。", 409);
        int modifier = weapon.Id == "dagger" ? Math.Max(CharacterEngine.Ability(character, "strength"), CharacterEngine.Ability(character, "dexterity")) : CharacterEngine.Ability(character, "strength");
        if (!BuildRuntime.CanAutomateCombat(character)) throw new GameException("manual_character_combat", "此构筑尚需主持进行战斗裁定。", 409);
        bool greatsword = weapon.Id == "greatsword" && character.ClassName == "Fighter";
        bool twoHands = EquipmentLoadout.TwoHands(EquipmentLoadout.Read(character), EquipmentLoadout.Read(character).ActiveSet);
        bool style = (character.BuildMechanics is null ? greatsword : character.BuildMechanics.Feats.Contains("great-weapon-fighting")) && twoHands;
        bool graze = character.BuildMechanics is null ? greatsword : weapon.Id == "greatsword" && character.BuildMechanics.Masteries.Contains("greatsword");
        bool savage = savageAttacker && (character.BuildMechanics is null || character.BuildMechanics.Feats.Contains("savage-attacker"));
        return RollAttack(armorClass, modifier + character.ProficiencyBonus, modifier,
            weapon.Id == "greatsword" ? 2 : 1, weapon.Id == "greatsword" ? 6 : weapon.Id == "quarterstaff" ? (twoHands ? 8 : 6) : 4,
            disadvantage, savage, style, graze);
    }
    // Deterministic rule-test surface and the authored opponent profile.
    public AttackRoll WeaponAttack(int armorClass, bool greatsword, bool disadvantage = false, bool savageAttacker = true) =>
        RollAttack(armorClass, greatsword ? 5 : 3, greatsword ? 3 : 1, greatsword ? 2 : 1, greatsword ? 6 : 4,
            disadvantage, greatsword && savageAttacker, greatsword, greatsword);
    private AttackRoll RollAttack(int armorClass, int modifier, int damageModifier, int count, int sides, bool disadvantage, bool savageAttacker, bool greatWeaponFighting, bool graze)
    {
        var rolls = disadvantage ? new[] { Roll(20), Roll(20) } : new[] { Roll(20) };
        var selected = rolls.Min();
        bool critical = selected == 20, hit = critical || (selected != 1 && selected + modifier >= armorClass);
        if (!hit) return new(rolls, selected, modifier, selected + modifier, armorClass, disadvantage ? "disadvantage" : "normal",
            false, false, [], [], [], damageModifier, graze ? Math.Max(0, damageModifier) : 0, graze);
        if (critical) count *= 2;
        int[] Set() => Enumerable.Range(0, count).Select(_ => Roll(sides)).ToArray();
        int[] Effective(int[] set) => greatWeaponFighting ? set.Select(d => Math.Max(3, d)).ToArray() : set;
        var raw = Set(); var alternate = savageAttacker ? Set() : [];
        var chosen = alternate.Length > 0 && Effective(alternate).Sum() > Effective(raw).Sum() ? alternate : raw;
        var effective = Effective(chosen);
        return new(rolls, selected, modifier, selected + modifier, armorClass, disadvantage ? "disadvantage" : "normal",
            true, critical, raw, alternate, effective, damageModifier, Math.Max(0, effective.Sum() + damageModifier), false);
    }
    private int Roll(int sides)
    {
        int value = dice.Roll(sides);
        if (value < 1 || value > sides) throw new InvalidOperationException("Invalid dice source.");
        return value;
    }
    private static int Heal(Campaign c, int amount) => CharacterEngine.Heal(c, amount);
    private static void Add(Campaign c, string kind, string actor, string text, AttackRoll? attack = null, SpellRoll? spell = null,
        string? target = null, string displayText = "")
    {
        var b = c.Combat!;
        var involved = CombatPresentation.Involved(actor, target, null);
        var audience = CombatPresentation.Audience(c, involved);
        b.Log.Add(new(++b.LogSequence, b.Round, kind, actor, text, attack, spell, Audience: audience,
            Presentation: CombatPresentation.Capture(c, displayText, involved, audience)));
        if (b.Log.Count > 200) b.Log.RemoveRange(0, b.Log.Count - 200);
    }
}
