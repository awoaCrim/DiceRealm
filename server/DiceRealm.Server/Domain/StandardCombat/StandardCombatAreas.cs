namespace DiceRealm.Server.Domain;

public sealed partial class StandardCombatEngine
{
    private static CombatUnit[] AreaTargets(Campaign c, CombatUnit caster, string spell, int x = -1, int y = -1)
    {
        bool sphere = spell == "acid-splash"; int radius = AreaRadius(spell);
        var origin = sphere ? new CombatUnit { X = x, Y = y } : caster;
        return Board(c).Units.Where(u => (sphere || u.Id != caster.Id) && !u.Withdrawn && !Body(u).Dead &&
            Math.Max(Math.Abs(origin.X - u.X), Math.Abs(origin.Y - u.Y)) <= radius && CombatGeometry.Cover(Board(c), origin, u) != 99).ToArray();
    }
    private static int AreaRadius(string spell) => spell == "arms-of-hadar" ? 2 : 1;
    private static ActionArea AreaShape(Campaign c, CastChoice option)
    {
        var spell = option.Source.SpellId; var caster = Unit(c, c.ActingActorId);
        var targets = AreaTargets(c, caster, spell, option.CenterX, option.CenterY).Where(u => PresentedTarget(c, caster, u)).Select(u => u.Id).ToArray();
        return option.CenterX >= 0 ? new(option.CenterX, option.CenterY, AreaRadius(spell), targets) : new(caster.X, caster.Y, AreaRadius(spell), targets);
    }
    private static string AreaDescription(Campaign c, CastChoice option)
    {
        var spell = option.Source.SpellId; var caster = Unit(c, c.ActingActorId);
        return (spell switch {
            "acid-splash" => $"60尺内中心({option.CenterX},{option.CenterY})，5尺Sphere；DEX失败受Acid伤害，成功无伤害。含中心与施法者，DEX半/四分之三掩护+2/+5，有效Dodge优势。",
            "thunderclap" => "5尺Emanation排除施法者，CON失败受Thunder伤害，成功无伤害；声响100尺内可闻。",
            _ => "10尺Emanation排除施法者，STR失败受Necrotic伤害且至自己下回合开始不能反应，成功半伤害。" }) +
            "本实现格心范围含友伤，完整掩护阻挡；目标：" + string.Join("、", AreaTargets(c, caster, spell, option.CenterX, option.CenterY).Where(u => PresentedTarget(c, caster, u)).Select(u => u.Name + (Enemy(u) ? "" : "（同伴）"))) +
            "。伤害骰同次一次，各目标分别豁免；玩家本人豁免确认前暂停后续目标。";
    }
    private void CastArea(Campaign c, CombatUnit p, CastChoice choice)
    {
        string spell = choice.Source.SpellId;
        int level = PartyEngine.CharacterFor(c, p.Id).Level;
        int count = spell == "arms-of-hadar" ? 1 + Math.Max(1, choice.SlotLevel) : level >= 17 ? 4 : level >= 11 ? 3 : level >= 5 ? 2 : 1;
        int[] rolls = Enumerable.Range(0, count).Select(_ => Roll(6)).ToArray();
        string ability = spell switch { "thunderclap" => "constitution", "acid-splash" => "dexterity", _ => "strength" };
        string type = spell switch { "thunderclap" => "Thunder", "acid-splash" => "Acid", _ => "Necrotic" };
        var targets = AreaTargets(c, p, spell, choice.CenterX, choice.CenterY);
        Add(c, "combat.cast", p.Id, $"{choice.Source.Name}：共享伤害{count}d6 [{string.Join(",", rolls)}] = {rolls.Sum()} {type}；来源{choice.Source.Source}，消耗{choice.Source.Resource}。目标：" + string.Join("、", targets.Where(u => u.Team != "enemy" || u.BoardEntityId is null || c.Board!.Entities.Single(e => e.Id == u.BoardEntityId).Appearance.Visibility == "player").Select(u => u.Name)) + (spell == "thunderclap" ? "。声响100尺内可闻，不凭空生成区域外听众。" : "。"),
            displayText: p.Name + "施放「" + choice.Source.Name + "」。");
        foreach (var target in targets)
            Queue(c, new() { Kind = "area-save", ActorId = p.Id, TargetId = target.Id,
                Area = new(spell, ability, choice.Source.SaveDc, rolls.Sum(), type, spell == "arms-of-hadar",
                    spell == "acid-splash" ? CombatGeometry.Cover(Board(c), new() { X = choice.CenterX, Y = choice.CenterY }, target) : 0) });
    }
    private void ResolveAreaSave(Campaign c, StandardCombatStep step)
    {
        var z = Unit(c, step.TargetId); var area = step.Area!; DiceCheck check;
        bool dodge = area.Ability == "dexterity" && z.Dodging && Able(z) && Speed(c, z) > 0;
        if (!Enemy(z))
        {
            var ch = PartyEngine.CharacterFor(c, z.Id);
            check = new RulesEngine(dice).SheetTest(ch, new("area-save", area.SpellId, area.Ability, "", 0, true), dodge ? "advantage" : "normal");
            check = check with { Dc = area.Dc, HasDc = true, Success = check.Mode != "automatic-failure" && check.Total >= area.Dc };
        }
        else
        {
            int modifier = StandardMonsters.Save(BoardCombat.EnemyProfile(c, z), area.Ability)!.Value;
            bool automatic = area.Ability is "strength" or "dexterity" && Body(z).Conditions.Any(s => s is "Unconscious" or "Stunned" or "Paralyzed" or "Petrified");
            int[] rolls = automatic ? [] : dodge ? [Roll(20), Roll(20)] : [Roll(20)]; int die = rolls.Length == 0 ? 0 : rolls.Max();
            check = new(area.Ability, area.SpellId, rolls, die, modifier, die + modifier, area.Dc, !automatic && die + modifier >= area.Dc,
                automatic ? "automatic-failure" : dodge ? "advantage" : "normal", Source: BoardCombat.EnemyProfile(c, z).RulesId is null ? "authored" : "XMM", TestKind: "save");
        }
        if (area.CoverBonus > 0)
            check = check with { Modifier = check.Modifier + area.CoverBonus, Total = check.Total + area.CoverBonus,
                Success = check.Mode != "automatic-failure" && check.Total + area.CoverBonus >= area.Dc };
        int damage = check.Success ? area.HalfOnSave ? area.Damage / 2 : 0 : area.Damage;
        if (!check.Success && area.SpellId == "arms-of-hadar") Body(z).ReactionsSuppressed = true;
        Add(c, "area_save", z.Id, $"{z.Name} / {area.SpellId}：{area.Ability} d20 [{string.Join(",", check.Rolls)}] {check.Modifier:+0;-0;0} = {check.Total} vs DC{area.Dc}；" +
            (check.Success ? "成功" : "失败") + (area.CoverBonus > 0 ? $"（已计掩护+{area.CoverBonus}）" : "") + $"，{damage} {area.DamageType}伤害" + (!check.Success && area.SpellId == "arms-of-hadar" ? "，不能反应至自己下回合开始。" : "。"), check: check, target: step.ActorId,
            displayText: z.Name + (check.Success ? "通过了法术豁免。" : "未能通过法术豁免。") + (!check.Success && area.SpellId == "arms-of-hadar" ? "暂时无法作出反应。" : ""));
        Damage(c, z, damage, area.DamageType);
    }
    private void AreaSave(Campaign c)
    {
        var step = c.StandardCombatFlow!.Steps[0]; c.StandardCombatFlow.Steps.RemoveAt(0); Board(c).Standard!.Wait = null;
        ResolveAreaSave(c, step);
    }
}
