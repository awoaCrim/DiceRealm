namespace DiceRealm.Server.Domain;

public sealed partial class StandardCombatEngine
{
    public static bool IsUnpaidMissilePlan(Campaign c, Intent action) => IsStandard(c) && Board(c).Status == "active" &&
        (action.Kind == "combat.missile_allocate" || action.Kind == "combat.cast" && CastOptions(c, Unit(c, c.ActingActorId)).Any(o => o.Key == action.Target && o.Source.SpellId == "magic-missile"));
    private static CombatUnit[] MissileTargets(Campaign c, CombatUnit p) => Board(c).Units.Where(u => !u.Withdrawn && !Body(u).Dead &&
        PresentedTarget(c, p, u) && Sees(c, p, u) && CombatGeometry.Distance(p, u) <= 120).ToArray();
    private static ActionChoice[] MissileChoices(Campaign c, CombatUnit p)
    {
        var plan = c.StandardCombatFlow!.Steps[0].Missiles!;
        int left = plan.Count - plan.Targets.Length;
        string summary = (plan.Targets.Length == 0 ? "尚未分配" : "已分配：" + string.Join("、", plan.Targets.GroupBy(id => id).Select(g => Unit(c, g.Key).Name + "×" + g.Count()))) + "；剩余" + left + "枚。尚未消耗动作/来源、未掷骰。";
        var choices = new List<ActionChoice>();
        if (left > 0)
            foreach (var z in MissileTargets(c, p))
            {
                choices.Add(Choice("combat.missile_allocate", "one/" + z.Id, "Magic Missile / 分配一枚至 " + z.Name, z.Name, "只编辑分配", summary));
                if (left > 1) choices.Add(Choice("combat.missile_allocate", "all/" + z.Id, "Magic Missile / 剩余全部 " + left + "枚至 " + z.Name, z.Name, "只编辑分配", summary));
            }
        else if (CastOptions(c, p).Any(o => o.Key == plan.SourceKey && o.Source.SpellId == "magic-missile" && o.SlotLevel == plan.SlotLevel && plan.Count == 2 + Math.Max(1, o.SlotLevel)) && plan.Targets.All(id => MissileTargets(c, p).Any(u => u.Id == id)))
            choices.Add(Choice("combat.missile_cast", "", "Magic Missile / 确认已分配飞弹", p.Name, "1 Magic动作 + 原来源资源；还须本人施法确认", summary + "每枚1d4+1 Force，同时命中；各玩家可回应Shield，全部反应前不掷伤害。"));
        if (plan.Targets.Length > 0) choices.Add(Choice("combat.missile_allocate", "undo", "撤销最后一枚飞弹分配", p.Name, "无消耗", summary));
        choices.Add(Choice("combat.missile_allocate", "cancel", "取消本次飞弹分配", p.Name, "无消耗", "清除尚未施放的分配，不消耗动作/来源/骰点。"));
        return choices.ToArray();
    }
    private static void BeginMissiles(Campaign c, CombatUnit p, CastChoice option)
    {
        int count = 2 + Math.Max(1, option.SlotLevel);
        Queue(c, new() { Kind = "missile-allocation", ActorId = p.Id, TargetId = p.Id, Missiles = new(option.Key, count, [], option.SlotLevel) });
        Board(c).Standard!.Wait = new("missile-allocation", p.Id, p.Id, $"Magic Missile：分配{count}枚飞弹后另行本人确认施放；现在没有消耗动作/来源，也没有骰点。");
        Add(c, "missile_allocation", p.Id, Board(c).Standard!.Wait!.Description);
    }
    private static void AllocateMissile(Campaign c, CombatUnit p, string target)
    {
        var step = c.StandardCombatFlow!.Steps[0]; var plan = step.Missiles!;
        if (target == "cancel")
        {
            c.StandardCombatFlow.Steps.RemoveAt(0); Board(c).Standard!.Wait = null;
            Add(c, "missile_cancel", p.Id, "取消尚未施放的Magic Missile分配，未消耗动作、来源或骰点。"); return;
        }
        var targets = target == "undo" ? plan.Targets[..^1] : plan.Targets.Concat(Enumerable.Repeat(target[4..], target.StartsWith("all/", StringComparison.Ordinal) ? plan.Count - plan.Targets.Length : 1)).ToArray();
        step.Missiles = plan with { Targets = targets };
        Board(c).Standard!.Wait = new("missile-allocation", p.Id, p.Id, $"Magic Missile已分配{targets.Length}/{plan.Count}枚；全部分配后还须本人确认施放。尚未付费或掷骰。");
        Add(c, "missile_allocation", p.Id, target == "undo" ? "撤销最后一枚飞弹分配。" : "分配飞弹至" + Unit(c, target[4..]).Name + "；尚未施放。", target: target == "undo" ? null : target[4..]);
    }
    private static void ReleaseMissiles(Campaign c, CombatUnit p)
    {
        var steps = c.StandardCombatFlow!.Steps; var plan = steps[0].Missiles!;
        var option = CastOptions(c, p).Single(o => o.Key == plan.SourceKey);
        PaySpell(c, p, option); p.ActionAvailable = false; steps.RemoveAt(0); Board(c).Standard!.Wait = null;
        foreach (string id in plan.Targets.Distinct())
            if (!Enemy(Unit(c, id))) Queue(c, new() { Kind = "missile-shield", ActorId = p.Id, TargetId = id });
        Queue(c, new() { Kind = "missile-impact", ActorId = p.Id, TargetId = p.Id, Missiles = plan });
        Add(c, "combat.cast", p.Id, $"Magic Missile：来源{option.Source.Source}，消耗{option.Source.Resource}；" +
            string.Join("、", plan.Targets.GroupBy(id => id).Select(g => Unit(c, g.Key).Name + "×" + g.Count())) + "。所有Shield响应之前不掷伤害。每枚独立1d4+1，同次伤害先全部结算，再处理每枚造成的专注触发（本实现明确政策）。", targets: plan.Targets,
            displayText: p.Name + "施放「" + option.Source.Name + "」，飞弹飞向" + string.Join("、", plan.Targets.Distinct().Select(id => Unit(c, id).Name)) + "。");
    }
    private void ImpactMissiles(Campaign c, StandardCombatStep step)
    {
        // Roll all unblocked darts first. Damage to every target commits in the same transaction,
        // before any concentration pause; no partial volley is saved behind a player's save.
        var impacts = step.Missiles!.Targets.Select(id => new { Target = Unit(c, id), Die = Body(Unit(c, id)).ShieldActive ? 0 : Roll(4) }).ToArray();
        var checks = new List<StandardCombatStep>();
        foreach (var hit in impacts)
        {
            if (hit.Die == 0) { Add(c, "missile_blocked", hit.Target.Id, hit.Target.Name + "的Shield阻挡一枚Magic Missile，0伤害、无伤害骰。", target: step.ActorId,
                displayText: hit.Target.Name + "的护盾挡住了一枚魔法飞弹。"); continue; }
            Add(c, "missile_damage", step.ActorId, $"Magic Missile / {hit.Target.Name}：d4 [{hit.Die}] +1 = {hit.Die + 1} Force。", target: hit.Target.Id,
                displayText: "一枚魔法飞弹命中" + hit.Target.Name + "。");
            int dealt = Damage(c, hit.Target, hit.Die + 1, "Force", concentrationCheck: false);
            if (dealt > 0 && !Enemy(hit.Target)) checks.Add(new() { Kind = "concentration", ActorId = hit.Target.Id, TargetId = hit.Target.Id, SaveDc = Math.Min(30, Math.Max(10, dealt / 2)) });
        }
        foreach (var check in checks.Where(s => ConcentrationEffects.Current(c, PartyEngine.CharacterFor(c, s.ActorId)) is not null)) Queue(c, check);
    }
}
