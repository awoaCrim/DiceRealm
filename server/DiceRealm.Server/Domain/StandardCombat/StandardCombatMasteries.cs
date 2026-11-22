namespace DiceRealm.Server.Domain;

public sealed partial class StandardCombatEngine
{
    private static string WeaponMastery(WeaponProfile? w) => w?.Id switch
    {
        "greatsword" => "graze", "club" => "slow", "quarterstaff" or "maul" => "topple", "mace" => "sap",
        "longsword" or "flail" => "sap", "rapier" or "shortsword" => "vex", _ => ""
    };
    private static bool OptionalMastery(Campaign c, CombatUnit a, CombatUnit z)
    {
        var weapon = Weapon(c, a);
        if (weapon is null || !Mastery(PartyEngine.CharacterFor(c, a.Id), weapon.Id)) return false;
        return WeaponMastery(weapon) switch
        {
            "topple" => Enemy(z) && StandardMonsters.Save(BoardCombat.EnemyProfile(c, z), "constitution") is not null,
            "slow" => true, _ => false
        };
    }
    private static string MasteryNote(Campaign c, CombatUnit a) => WeaponMastery(Weapon(c, a)) switch
    {
        "topple" => "Topple：命中后目标进行CON豁免（DC8+本次攻击属性修正+熟练加值），失败倒地。",
        "slow" => "Slow：命中并实际造成伤害后，目标速度减10尺至自己下回合开始，不叠加超过10尺。",
        _ => ""
    };
    private static bool HasMasteryEffect(CombatUnit target, string kind, string? source = null) =>
        Body(target).MasteryEffects.Any(e => e.Kind == kind && (source is null || e.SourceId == source));
    private static void ConsumeAttackMasteries(CombatUnit attacker, CombatUnit defender)
    {
        Body(attacker).MasteryEffects = Body(attacker).MasteryEffects.Where(e => e.Kind != "sap").ToArray();
        Body(defender).MasteryEffects = Body(defender).MasteryEffects.Where(e => e.Kind != "vex" || e.SourceId != attacker.Id).ToArray();
    }
    private static void MasteryTurnStart(CombatState b, string source)
    {
        foreach (var u in b.Units)
            Body(u).MasteryEffects = Body(u).MasteryEffects.Where(e => e.SourceId != source || e.Kind == "vex").ToArray();
    }
    private static void MasteryTurnEnd(CombatState b, string source)
    {
        foreach (var u in b.Units)
            Body(u).MasteryEffects = Body(u).MasteryEffects.Where(e => e.SourceId != source || e.Kind != "vex" || e.TurnEndsRemaining > 1)
                .Select(e => e.SourceId == source && e.Kind == "vex" ? e with { TurnEndsRemaining = e.TurnEndsRemaining - 1 } : e).ToArray();
    }
    private void ApplyMastery(Campaign c, CombatUnit a, CombatUnit z, StandardStrike strike, bool hit, int dealt)
    {
        if (!hit || Body(z).Dead || Enemy(a)) return;
        var ch = PartyEngine.CharacterFor(c, a.Id); var weapon = Weapon(c, a);
        if (weapon is null || !Mastery(ch, weapon.Id)) return;
        string mastery = WeaponMastery(weapon);
        if (mastery is "slow" or "topple" && !strike.UseMastery || mastery is "vex" or "slow" && dealt <= 0) return;
        if (mastery == "topple")
        {
            int dc = 8 + strike.AbilityModifier + ch.ProficiencyBonus;
            int modifier = StandardMonsters.Save(BoardCombat.EnemyProfile(c, z), "constitution")!.Value;
            int die = Roll(20); bool success = die + modifier >= dc;
            if (!success)
            {
                Body(z).Conditions = Body(z).Conditions.Concat(["Prone"]).Distinct().ToArray(); SyncCharacter(c, z);
            }
            Add(c, "mastery_topple", a.Id, $"Topple / {z.Name}：CON d20 [{die}] {modifier:+0;-0;0} = {die + modifier} vs DC{dc}；" + (success ? "成功，未倒地。" : "失败，倒地。"),
                check: new("constitution", "Topple", [die], die, modifier, die + modifier, dc, success, "normal", Source: "XPHB", TestKind: "save"), target: z.Id,
                displayText: success ? z.Name + "稳住身形，没有倒地。" : a.Name + "将" + z.Name + "击倒在地。");
        }
        else if (mastery is "sap" or "slow" or "vex")
        {
            int speed = Speed(c, z);
            Body(z).MasteryEffects = Body(z).MasteryEffects.Where(e => e.Kind != mastery || e.SourceId != a.Id)
                .Append(new(mastery, a.Id, mastery == "vex" ? Board(c).ActiveActorId == a.Id ? 2 : 1 : 0)).ToArray();
            z.MovementRemaining = Math.Max(0, z.MovementRemaining - Math.Max(0, speed - Speed(c, z)) * (1 + Body(z).DashesThisTurn));
            Add(c, "mastery_" + mastery, a.Id, a.Name + "对" + z.Name + "施加" + mastery + "：" + (mastery switch
            {
                "sap" => "目标下一次攻击具有劣势，至来源自己下回合开始。",
                "slow" => "速度减10尺（不叠加），至来源自己下回合开始。",
                _ => "来源对该目标下一次攻击具有优势，至来源自己下回合结束。"
            }), target: z.Id, displayText: mastery switch
            {
                "sap" => z.Name + "的攻势受挫，下一次攻击更难命中。",
                "slow" => z.Name + "脚步变慢。",
                _ => a.Name + "看准了" + z.Name + "的破绽。"
            });
        }
    }
}
