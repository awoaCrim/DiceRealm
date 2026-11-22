namespace DiceRealm.Server.Domain;

public sealed partial class StandardCombatEngine
{
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
            var unit = new CombatUnit
            {
                Id = entry.Id, Team = "party", Name = ch.Name, X = 1, Y = new[] { 2, 1, 3, 4 }[index], HitPoints = ch.HitPoints,
                MaxHitPoints = ch.MaxHitPoints, ArmorClass = ch.ArmorClass, Speed = BuildRuntime.Speed(ch), InitiativeRoll = Roll(20),
                InitiativeModifier = (ch.BuildMechanics?.InitiativeBonus ?? CharacterEngine.Ability(ch, "dexterity") + ch.ProficiencyBonus) - 2 * ch.Exhaustion,
                Standard = new() { Conditions = ch.Conditions.ToArray(), TemporaryHitPoints = ch.TemporaryHitPoints }
            };
            unit.Initiative = unit.InitiativeRoll + unit.InitiativeModifier;
            return unit;
        });
        var enemies = preparation is not null ? Array.Empty<CombatUnit>() : enemyDefinitions.Select(e =>
        {
            var unit = new CombatUnit
            {
                Id = e.Id, Team = "enemy", Name = e.Name, X = e.X, Y = e.Y, HitPoints = e.HitPoints, MaxHitPoints = e.HitPoints,
                ArmorClass = e.ArmorClass, Speed = e.Speed, InitiativeRoll = Roll(20), InitiativeModifier = e.InitiativeModifier, Standard = new()
            };
            unit.Initiative = unit.InitiativeRoll + unit.InitiativeModifier;
            return unit;
        });
        var units = preparation?.Units ?? players.Concat(enemies).ToArray();
        var runtime = c.RuntimeEncounters?.SingleOrDefault(e => e.Definition.Id == definition.Id);
        var initiativeChecks = new Dictionary<string, DiceCheck>();
        var groups = new Dictionary<string, int>();
        if (preparation is not null)
            foreach (var unit in units)
            {
                bool surprised = runtime?.SurprisedActors?.Contains(unit.Id) == true;
                int[] rolls;
                if (runtime is not null && Enemy(unit))
                {
                    string group = c.Board!.Entities.Single(e => e.Id == unit.BoardEntityId).Source.RulesId + ":" + unit.InitiativeModifier;
                    if (!groups.TryGetValue(group, out int shared)) groups[group] = shared = Roll(20);
                    rolls = [shared];
                }
                else rolls = surprised ? [Roll(20), Roll(20)] : [Roll(20)];
                unit.InitiativeRoll = rolls.Min();
                unit.Initiative = unit.InitiativeRoll + unit.InitiativeModifier;
                if (runtime is not null) initiativeChecks[unit.Id] = new("dexterity", "Initiative", rolls, unit.InitiativeRoll, unit.InitiativeModifier,
                    unit.Initiative, 0, false, surprised ? "disadvantage" : "normal", HasDc: false);
            }
        var b = c.Combat = new()
        {
            Id = Guid.NewGuid().ToString(), DefinitionId = definition.Id, Title = definition.Title, Cells = preparation is null || runtime is not null ? definition.Cells : [],
            Units = units, ActiveActorId = "", TurnOrder = units.OrderByDescending(u => u.Initiative).Select(u => u.Id).ToArray(), Standard = new(),
            BoardLayout = preparation?.Layout, Width = preparation?.Layout.Width ?? 7, Height = preparation?.Layout.Height ?? 5
        };
        var session = CombatAgentSessions.Current(c);
        bool narrated = session is not null && (session.ToolContractVersion >= 49 || session.Inputs.Any(i => i.ToolContractVersion >= 49));
        c.StandardCombatFlow = new() { NarratedThrough = narrated ? 0 : null };
        foreach (var u in units)
        {
            initiativeChecks.TryGetValue(u.Id, out var check);
            string detail = check is null ? u.InitiativeRoll.ToString() : string.Join(",", check.Rolls);
            Add(c, "initiative", u.Id, $"{u.Name} 先攻 d20 [{detail}] {u.InitiativeModifier:+0;-0;0} = {u.Initiative}；" +
                (check?.Mode == "disadvantage" ? "惊讶：先攻劣势（2024，无惊讶轮）。" : "") + "同分队伍加入顺序优先（本场政策）。", check: check);
        }
        Add(c, "scenario", "system", "显式标准2024致命遭遇。地形按格心射线计算掩护，反应和死亡豁免由对应玩家确认；未实现能力不从叙事猜测执行。");
        b.ActiveActorId = b.TurnOrder[0]; BeginTurn(c, Unit(c, b.ActiveActorId)); Continue(c);
    }
    private void BeginTurn(Campaign c, CombatUnit u)
    {
        var b = Board(c);
        b.Standard!.TurnSerial++;
        foreach (var unit in b.Units) unit.SavageAttackerUsed = false; // Once per turn, not once per own turn.
        u.MovementRemaining = Speed(c, u); u.ActionAvailable = u.BonusActionAvailable = u.ReactionAvailable = true;
        u.Dodging = u.Disengaging = u.SavageAttackerUsed = u.SurgeAction = false;
        Body(u).ActionSurgeUsed = false; Body(u).AttacksRemaining = 0; Body(u).DashesThisTurn = 0; Body(u).ShieldActive = false; Body(u).ReactionsSuppressed = false;
        Add(c, "turn", u.Id, $"第{b.Round}轮 · {u.Name}的回合。", displayText: $"第{b.Round}轮，轮到{u.Name}行动。");
        if (!Enemy(u) && Dying(u))
        {
            b.Standard.Wait = new("death", u.Id, u.Id, "此角色0HP且尚未稳定；等待本人确认死亡豁免。");
            Add(c, "death_wait", u.Id, "0HP开始回合：等待本人死亡豁免，尚未掷骰。", displayText: u.Name + "倒地昏迷，等待死亡豁免。");
        }
        else if (Enemy(u)) PlanNpc(c, u);
    }
    private static bool Finish(Campaign c)
    {
        var b = Board(c);
        if (b.Status != "active") return true;
        if (b.Standard!.Wait is not null || c.StandardCombatFlow!.Steps.Count > 0) return false;
        var party = b.Units.Where(u => !Enemy(u)).ToArray();
        bool livingEnemies = b.Units.Any(u => Enemy(u) && !u.Withdrawn && !Body(u).Dead);
        // A fallen player's required saves do not disappear when the last opponent falls.
        if (party.Any(Dying)) return false;
        bool livingParty = party.Any(u => !u.Withdrawn && !Body(u).Dead && u.HitPoints > 0);
        string status;
        if (!livingEnemies) status = "victory";
        else if (livingParty) return false;
        else status = party.All(u => u.Withdrawn) ? "retreated" : "defeated";
        b.Status = status; b.ActiveActorId = ""; b.Standard!.Wait = null; c.StandardCombatFlow!.Steps.Clear();
        if (status == "victory")
        {
            var outcome = Definition(c).Victory;
            ContentRuntime.Apply(c, outcome.Effects);
            Add(c, status, "system", outcome.Text, displayText: "战斗结束，队伍获胜。");
        }
        else Add(c, status, "system", status == "retreated" ? "全队已撤退。" : "队伍已全部死亡或稳定倒地；此模式不自动复活/回血。稳定者可明确等待恢复。",
            displayText: status == "retreated" ? "全队撤离，战斗结束。" : "队伍失去战斗力，战斗结束。");
        return true;
    }
    private void Continue(Campaign c, bool coalesceIdleTurns = false)
    {
        var b = Board(c); var steps = c.StandardCombatFlow!.Steps;
        int iterations = 0;
        while (b.Status == "active" && b.Standard!.Wait is null && steps.Count > 0)
        {
            if (++iterations > 256) throw new GameException("combat_flow_limit", "本次战斗推进超过安全上限，未提交；请检查遭遇。", 409);
            var step = steps[0]; var actor = Unit(c, step.ActorId);
            if (step.Kind == "advance")
            {
                // A unit's movement, attack and immediate consequences form one story beat.
                // Do not begin the next unit until this beat has been narrated.
                if (NarrationPending(c) && !(coalesceIdleTurns && Enemy(actor) &&
                    b.Log.Where(e => e.Sequence > c.StandardCombatFlow!.NarratedThrough).All(e => e.Kind == "turn"))) return;
                steps.RemoveAt(0);
                if (Finish(c)) return;
                actor.Disengaging = false; MasteryTurnEnd(b, actor.Id);
                int next = (Array.IndexOf(b.TurnOrder, b.ActiveActorId) + 1) % b.TurnOrder.Length;
                if (next == 0) { b.Round++; CharacterEngine.Advance(c, 6); }
                b.ActiveActorId = b.TurnOrder[next];
                var unit = Unit(c, b.ActiveActorId);
                MasteryTurnStart(b, unit.Id);
                // Stable unconscious and dead/withdrawn units do not get fake actions or saves.
                if (unit.Withdrawn || Body(unit).Dead || unit.HitPoints == 0 && Body(unit).Stable)
                    steps.Insert(0, new() { Kind = "advance", ActorId = unit.Id });
                else BeginTurn(c, unit);
                continue;
            }
            if (step.Kind == "concentration")
            {
                if (ConcentrationEffects.Current(c, PartyEngine.CharacterFor(c, actor.Id)) is null) { steps.RemoveAt(0); continue; }
                b.Standard!.Wait = new("concentration", actor.Id, actor.Id, $"受伤后等待本人确认DC{step.SaveDc} Constitution专注豁免，或主动结束专注。");
                Add(c, "concentration_wait", actor.Id, b.Standard.Wait.Description, displayText: actor.Name + "受伤后等待专注豁免。"); return;
            }
            if (step.Kind == "missile-shield")
            {
                var target = Unit(c, step.TargetId);
                if (Body(target).ShieldActive || step.Reacted.Contains(target.Id) || CastOptions(c, target, true).Length == 0) { steps.RemoveAt(0); continue; }
                b.Standard!.Wait = new("shield", target.Id, actor.Id, "被Magic Missile选为目标；飞弹尚未掷伤害/命中。可用Shield阻挡，或明确放弃。所有目标响应后才一起结算。");
                Add(c, "reaction_wait", target.Id, b.Standard.Wait.Description, target: actor.Id,
                    displayText: target.Name + "被魔法飞弹锁定，等待护盾反应。"); return;
            }
            if (step.Kind == "missile-impact")
            {
                steps.RemoveAt(0); ImpactMissiles(c, step); if (Finish(c)) return; continue;
            }
            if (step.Kind == "area-save")
            {
                var target = Unit(c, step.TargetId);
                if (Body(target).Dead || target.Withdrawn) { steps.RemoveAt(0); continue; }
                if (!Enemy(target))
                {
                    // Named as the concentration wait is ("Constitution专注豁免"), never as raw ids.
                    var area = step.Area!; string spell = PlayCatalog.Spells.Single(s => s.Id == area.SpellId).Name;
                    b.Standard!.Wait = new("area-save", target.Id, actor.Id, $"{spell}影响此角色；等待本人确认DC{area.Dc} {char.ToUpperInvariant(area.Ability[0]) + area.Ability[1..]}豁免，其他目标尚未继续。");
                    Add(c, "area_wait", target.Id, b.Standard.Wait.Description, target: actor.Id,
                        displayText: target.Name + "受到法术波及，等待豁免。"); return;
                }
                steps.RemoveAt(0); ResolveAreaSave(c, step); if (Finish(c)) return; continue;
            }
            if (step.Kind == "hit")
            {
                steps.RemoveAt(0); ResolveStrike(c, step);
                if (Finish(c)) return;
                continue;
            }
            if (!Able(actor)) { steps.RemoveAt(0); continue; }
            if (step.Kind is "move" or "retreat")
            {
                foreach (var foe in b.Units.Where(z => z.Team != actor.Team && Able(z) && z.ReactionAvailable && !Body(z).ReactionsSuppressed && !step.Reacted.Contains(z.Id)))
                {
                    if (actor.Disengaging || !Sees(c, foe, actor) || !CanMelee(c, foe, actor) ||
                        Math.Max(Math.Abs(step.X - foe.X), Math.Abs(step.Y - foe.Y)) <= 1) continue;
                    if (!Enemy(foe))
                    {
                        b.Standard.Wait = new("opportunity", foe.Id, actor.Id, actor.Name + "即将离开触及；移动尚未发生，接受后消耗反应进行一次近战攻击。");
                        Add(c, "reaction_wait", foe.Id, b.Standard.Wait.Description, target: actor.Id,
                            displayText: actor.Name + "即将离开" + foe.Name + "身旁，等待借机攻击反应。");
                        return;
                    }
                    step.Reacted = [.. step.Reacted, foe.Id]; foe.ReactionAvailable = false;
                    Attack(c, foe, actor, true);
                    break; // Hit/Shield/concentration must resolve before this exact movement step.
                }
                if (steps[0] != step) continue;
                if (b.Status != "active" || b.Standard!.Wait is not null) return;
                steps.RemoveAt(0);
                if (!Able(actor)) continue;
                int cost = step.Kind == "retreat" ? 5 : CombatGeometry.StepCost(b, actor, step.X, step.Y);
                if (actor.MovementRemaining < cost) continue;
                actor.MovementRemaining -= cost;
                if (step.Kind == "retreat")
                {
                    actor.Withdrawn = true;
                    Add(c, "combat.retreat", actor.Id, actor.Name + "花费5尺撤退，敌人不追击区域外目标（本场政策）。", displayText: actor.Name + "撤离战场。");
                    if (!Enemy(actor) && b.ActiveActorId == actor.Id) steps.Insert(0, new() { Kind = "advance", ActorId = actor.Id });
                }
                else
                {
                    actor.X = step.X; actor.Y = step.Y;
                    EncounterConcealment.RefreshSight(c, b);
                    Add(c, "combat.move", actor.Id, $"{actor.Name}移动至({actor.X},{actor.Y})，消耗{cost}尺。", displayText: actor.Name + "移动。");
                }
            }
            else if (step.Kind == "attack")
            {
                steps.RemoveAt(0);
                var target = Unit(c, step.TargetId);
                bool ranged = step.WeaponId == "shortbow";
                if (actor.ActionAvailable && !Body(target).Dead && !target.Withdrawn &&
                    (ranged ? CanShortbow(c, actor, target) : CanMelee(c, actor, target)))
                { actor.ActionAvailable = false; Attack(c, actor, target, false, ranged: ranged); }
            }
            else throw new InvalidOperationException("Unknown standard combat continuation.");
            if (Finish(c)) return;
        }
    }
    private static (int X, int Y) Exit(CombatState b, CombatUnit u)
    {
        // Orthogonal outward step avoids a fabricated diagonal corner crossing.
        if (u.X == 0) return (-1, u.Y);
        if (u.X == b.Width - 1) return (b.Width, u.Y);
        if (u.Y == 0) return (u.X, -1);
        return (u.X, b.Height);
    }
    private static void NimbleEscape(Campaign c, CombatUnit u)
    {
        if (!u.BonusActionAvailable || u.Disengaging || !StandardMonsters.IsGoblinWarrior(BoardCombat.EnemyProfile(c, u))) return;
        var b = Board(c);
        var cursor = new CombatUnit { Id = u.Id, Team = u.Team, BoardEntityId = u.BoardEntityId, X = u.X, Y = u.Y, Standard = u.Standard };
        foreach (var step in c.StandardCombatFlow!.Steps.Where(s => s.ActorId == u.Id && s.Kind is "move" or "retreat"))
        {
            if (b.Units.Any(z => z.Team != u.Team && Able(z) && z.ReactionAvailable && !Body(z).ReactionsSuppressed &&
                Sees(c, z, cursor) && CanMelee(c, z, cursor) && Math.Max(Math.Abs(step.X - z.X), Math.Abs(step.Y - z.Y)) > 1))
            {
                u.BonusActionAvailable = false; u.Disengaging = true;
                Add(c, "combat.nimble_escape", u.Id, u.Name + "使用Nimble Escape，消耗1附赠动作Disengage；本回合移动不触发借机攻击，不消耗动作。", displayText: u.Name + "灵巧脱身，避开借机攻击。");
                return;
            }
            cursor.X = step.X; cursor.Y = step.Y;
        }
    }
    private static void PlanGoblinRanged(Campaign c, CombatUnit u)
    {
        var b = Board(c);
        var targets = b.Units.Where(z => !Enemy(z) && Able(z)).ToArray();
        // A legal current shot is preferred to a Dash. Close combat may use an affordable
        // escape route, but does not invent hidden positions, cover or an extra action.
        var target = targets.Where(z => ShortbowPosition(b, u, z))
            .OrderBy(z => CombatGeometry.Distance(u, z) > 80).ThenBy(z => CombatGeometry.Cover(b, u, z))
            .ThenBy(z => CombatGeometry.Distance(u, z)).FirstOrDefault();
        List<(int X, int Y)> path = [];
        if (target is null || RangedThreatened(c, u))
        {
            bool escape = target is not null;
            var candidate = targets.Select(z => new
            {
                Unit = z,
                Path = CombatGeometry.Path(b, u, (x, y) =>
                {
                    var cursor = new CombatUnit { Id = u.Id, Team = u.Team, X = x, Y = y };
                    return ShortbowPosition(b, cursor, z) && (!escape || !RangedThreatened(c, cursor));
                })
            }).Where(x => x.Path.Count > 0).OrderBy(x => x.Path.Sum(s => CombatGeometry.StepCost(b, u, s.X, s.Y))).FirstOrDefault();
            if (candidate is not null && (target is null || candidate.Path.Sum(s => CombatGeometry.StepCost(b, u, s.X, s.Y)) <= u.MovementRemaining))
            { target = candidate.Unit; path = candidate.Path; }
        }
        if (path.Sum(s => CombatGeometry.StepCost(b, u, s.X, s.Y)) > u.MovementRemaining)
        { u.ActionAvailable = false; Dash(c, u); Add(c, "combat.dash", u.Id, u.Name + "使用Dash前往可射击位置，放弃本回合动作攻击。", displayText: u.Name + "疾走，寻找射击位置。"); }
        int budget = u.MovementRemaining;
        foreach (var cell in path)
        {
            int cost = CombatGeometry.StepCost(b, u, cell.X, cell.Y);
            if (cost > budget) break;
            Queue(c, new() { Kind = "move", ActorId = u.Id, X = cell.X, Y = cell.Y }); budget -= cost;
        }
        if (target is not null) Queue(c, new() { Kind = "attack", ActorId = u.Id, TargetId = target.Id, WeaponId = "shortbow" });
        Queue(c, new() { Kind = "advance", ActorId = u.Id });
        NimbleEscape(c, u);
    }
    private void PlanNpc(Campaign c, CombatUnit u)
    {
        var b = Board(c); var definition = BoardCombat.EnemyProfile(c, u);
        if (!Able(u)) { Queue(c, new() { Kind = "advance", ActorId = u.Id }); return; }
        if (Body(u).Conditions.Contains("Prone") && Speed(c, u) > 0 && u.MovementRemaining >= Speed(c, u) / 2)
        {
            u.MovementRemaining -= Speed(c, u) / 2; RemoveCondition(c, u, "Prone");
            Add(c, "combat.stand", u.Id, u.Name + "花费一半速度的移动额度起身。", displayText: u.Name + "站起身。");
        }
        if (definition.Tactic == "ranged" && StandardMonsters.IsGoblinWarrior(definition))
        { PlanGoblinRanged(c, u); return; }
        List<(int X, int Y)> path;
        CombatUnit? target = null;
        bool withdraw = definition.Tactic == "withdraw";
        if (withdraw)
        {
            path = CombatGeometry.Path(b, u, (x, y) => x == 0 || y == 0 || x == b.Width - 1 || y == b.Height - 1);
        }
        else
        {
            // Authored basic AI prefers conscious targets and does not execute fallen players.
            // This is encounter policy, not a general monster intelligence rule.
            var candidate = b.Units.Where(z => !Enemy(z) && Able(z)).Select(z => new
            {
                Unit = z,
                Path = CombatGeometry.Path(b, u, (x, y) => CombatGeometry.Reach(b, new() { X = x, Y = y, Id = u.Id }, z))
            }).Where(x => CanMelee(c, u, x.Unit) || x.Path.Count > 0)
                .OrderBy(x => x.Path.Sum(s => CombatGeometry.StepCost(b, u, s.X, s.Y))).FirstOrDefault();
            path = candidate?.Path ?? []; target = candidate?.Unit;
        }
        int total = path.Sum(s => CombatGeometry.StepCost(b, u, s.X, s.Y)) + (withdraw ? 5 : 0);
        if (total > u.MovementRemaining) { u.ActionAvailable = false; Dash(c, u); Add(c, "combat.dash", u.Id, u.Name + "使用Dash移动，放弃动作攻击。", displayText: u.Name + "疾走。"); }
        int budget = u.MovementRemaining;
        foreach (var cell in path)
        {
            int cost = CombatGeometry.StepCost(b, u, cell.X, cell.Y);
            if (cost > budget) break;
            Queue(c, new() { Kind = "move", ActorId = u.Id, X = cell.X, Y = cell.Y }); budget -= cost;
        }
        if (withdraw && budget >= 5 && (path.Count == 0 ? Boundary(b, u) : total - 5 <= u.MovementRemaining))
        {
            var last = path.Count == 0 ? (u.X, u.Y) : path[^1];
            var exit = Exit(b, new() { X = last.Item1, Y = last.Item2 });
            Queue(c, new() { Kind = "retreat", ActorId = u.Id, X = exit.X, Y = exit.Y });
        }
        else if (target is not null) Queue(c, new() { Kind = "attack", ActorId = u.Id, TargetId = target.Id });
        Queue(c, new() { Kind = "advance", ActorId = u.Id });
        NimbleEscape(c, u);
    }
}
