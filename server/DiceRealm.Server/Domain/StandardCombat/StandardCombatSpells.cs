using System.Security.Cryptography;
using System.Text;

namespace DiceRealm.Server.Domain;

public sealed partial class StandardCombatEngine
{
    private sealed record CastChoice(string Key, SheetSpellOption Source, string TargetId, int SlotLevel, bool Bonus, int CenterX = -1, int CenterY = -1);
    private static int SlotLevel(string resource)
    {
        for (int n = 1; n <= 9; n++)
            if (resource == AdvancementProjection.SlotName(n) || resource == AdvancementProjection.SlotName(n, true)) return n;
        return 0;
    }
    private static bool SpellComponents(Character ch, string spell) =>
        BuildRuntime.Equipped(ch)
            .Where(e => e?.Kind is "LA" or "MA" or "HA" or "S").All(e => PlayCatalog.EquipmentBlock(ch, e!, true) == "") &&
        (spell == "healing-word" || ch.BuildMechanics?.Feats.Contains("war-caster") == true || EquipmentLoadout.GestureHand(ch));
    private static CastChoice[] CastOptions(Campaign c, CombatUnit p, bool shield = false)
    {
        if (Enemy(p) || !Able(p)) return [];
        var ch = PartyEngine.CharacterFor(c, p.Id); var b = Board(c); var result = new List<CastChoice>();
        foreach (var s in CharacterPlayEngine.SpellSources(ch).Where(s => s.Available && s.Ability != "" &&
            (s.Resource == "" || s.Remaining > 0) && !s.Id.EndsWith("/feature", StringComparison.Ordinal) && !s.Id.Contains("ritual", StringComparison.Ordinal)))
        {
            if (shield ? s.SpellId != "shield" || (!p.ReactionAvailable || Body(p).ReactionsSuppressed) :
                s.SpellId is not ("blade-ward" or "expeditious-retreat" or "cure-wounds" or "healing-word" or "thunderclap" or "arms-of-hadar" or "acid-splash" or "magic-missile")) continue;
            int slot = SlotLevel(s.Resource); bool bonus = s.SpellId is "expeditious-retreat" or "healing-word";
            if (!SpellComponents(ch, s.SpellId) || slot > 0 && Body(p).SlotSpentTurn == b.Standard!.TurnSerial) continue;
            if (!shield && (b.ActiveActorId != p.Id || (bonus ? !p.BonusActionAvailable : !p.ActionAvailable || p.SurgeAction))) continue;
            if (s.SpellId == "acid-splash")
            {
                for (int y = 0; y < b.Height; y++)
                for (int x = 0; x < b.Width; x++)
                {
                    var center = new CombatUnit { X = x, Y = y };
                    if (CombatGeometry.Obstacle(b, x, y) || CombatGeometry.Distance(p, center) > 60 || CombatGeometry.Cover(b, p, center) == 99) continue;
                    var area = AreaTargets(c, p, s.SpellId, x, y);
                    if (area.Length == 0 && RuntimeEncounters.Current(c) is null || area.Any(u => Enemy(u) && StandardMonsters.Save(BoardCombat.EnemyProfile(c, u), "dexterity") is null)) continue;
                    result.Add(new(SpellKey(s.Id, $"point/{x},{y}"), s, p.Id, slot, bonus, x, y));
                }
                continue;
            }
            if (s.SpellId is "thunderclap" or "arms-of-hadar")
            {
                var area = AreaTargets(c, p, s.SpellId);
                if (area.Length == 0 && RuntimeEncounters.Current(c) is null || area.Any(u => Enemy(u) && StandardMonsters.Save(BoardCombat.EnemyProfile(c, u), s.SpellId == "thunderclap" ? "constitution" : "strength") is null)) continue;
            }
            bool healing = s.SpellId is "cure-wounds" or "healing-word";
            var targets = healing ? b.Units.Where(u => !Enemy(u) && !u.Withdrawn && !Body(u).Dead && u.HitPoints < u.MaxHitPoints &&
                (s.SpellId == "cure-wounds" ? u.Id == p.Id || CombatGeometry.Reach(b, p, u) :
                    Sees(c, p, u) && Math.Max(Math.Abs(p.X - u.X), Math.Abs(p.Y - u.Y)) <= 12)) : [p];
            foreach (var target in targets)
            {
                string key = SpellKey(s.Id, target.Id);
                result.Add(new(key, s, target.Id, slot, bonus));
            }
        }
        return result.ToArray();
    }
    private static string SpellKey(string source, string target) => "spell/" + Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(source + "|" + target)));
    private static ActionChoice SpellChoice(Campaign c, CastChoice option, bool shield = false)
    {
        var s = option.Source; string target = option.CenterX >= 0 ? $"中心({option.CenterX},{option.CenterY})" : Unit(c, option.TargetId).Name;
        bool area = s.SpellId is "thunderclap" or "arms-of-hadar" or "acid-splash";
        string effect = s.SpellId switch
        {
            "thunderclap" or "arms-of-hadar" or "acid-splash" => AreaDescription(c, option),
            "magic-missile" => (2 + Math.Max(1, option.SlotLevel)) + "枚飞弹，120尺可见目标。先编辑确切分配（可取消、此时无消耗/骰点），分配完成后本人另行确认Magic动作和原来源，再开放各目标Shield。",
            "shield" => "触发攻击也获得+5AC，并阻挡Magic Missile；持续至自己下回合开始，自然20攻击仍命中。",
            "blade-ward" => "专注最多1分钟；每次针对自己的攻击掷骰减1d4。替换原专注。",
            "expeditious-retreat" => "立即Dash，专注最多10分钟；后续可用附赠动作Dash。替换原专注。",
            _ => "恢复 " + (2 * Math.Max(1, option.SlotLevel)) + "d" + (s.SpellId == "cure-wounds" ? 8 : 4) + " + 施法属性修正的HP，不复活、不自动起身。"
        };
        return Choice(shield ? "combat.react" : "combat.cast", option.Key, s.Name + " / " + target + "（" + s.Source + "）", target,
            (s.SpellId == "magic-missile" ? "先编辑分配；确认施放时才消耗1 Magic动作" : shield ? "1反应" : option.Bonus ? "1附赠动作" : "1 Magic动作") + "; " + (s.Resource == "" ? "此来源无资源消耗" : s.Resource + " ×1"),
            effect + " " + (s.SpellId == "healing-word" ? "须能发声并看到目标。" : (s.SpellId == "thunderclap" ? "无需发声成分，" : "须能发声，") + "且需要可提供手势的手（双手武器可松开一手）（War Caster可豁免空手要求）。") + "每个回合最多消耗一个法术位。未记录的施法阻碍须先核实。") with { Area = area ? AreaShape(c, option) : null };
    }
    private static void PaySpell(Campaign c, CombatUnit p, CastChoice option)
    {
        var ch = PartyEngine.CharacterFor(c, p.Id); string resource = option.Source.Resource;
        PartyEngine.SetCharacter(c, p.Id, ch with { Resources = ch.Resources.Select(r => r.Name == resource ? r with { Current = r.Current - 1 } : r).ToArray() });
        if (option.SlotLevel > 0) Body(p).SlotSpentTurn = Board(c).Standard!.TurnSerial;
    }
    private void Cast(Campaign c, CombatUnit p, string key)
    {
        var option = CastOptions(c, p).Single(o => o.Key == key); var s = option.Source;
        if (s.SpellId == "magic-missile") { BeginMissiles(c, p, option); return; }
        PaySpell(c, p, option);
        if (option.Bonus) p.BonusActionAvailable = false; else p.ActionAvailable = false;
        var ch = PartyEngine.CharacterFor(c, p.Id);
        if (s.SpellId is "blade-ward" or "expeditious-retreat")
        {
            if (ch.Concentration is not null) EndConcentration(c, p);
            ch = PartyEngine.CharacterFor(c, p.Id);
            PartyEngine.SetCharacter(c, p.Id, ch with { Concentration = new(s.SpellId, s.Source, c.ElapsedSeconds + (s.SpellId == "blade-ward" ? 60 : 600)) });
            if (s.SpellId == "expeditious-retreat") Dash(c, p);
            Add(c, "combat.cast", p.Id, s.Name + "已生效并开始专注；来源 " + s.Source + "，消耗 " + (s.Resource == "" ? "无资源" : s.Resource + " ×1") + "。",
                displayText: p.Name + "施放「" + s.Name + "」，开始专注。" + (s.SpellId == "expeditious-retreat" ? "脚步随之加快。" : ""));
        }
        else if (s.SpellId is "thunderclap" or "arms-of-hadar" or "acid-splash") CastArea(c, p, option);
        else
        {
            int level = Math.Max(1, option.SlotLevel), count = 2 * level, die = s.SpellId == "cure-wounds" ? 8 : 4;
            bool life = ch.Advancement?.Classes.Any(x => x.ClassId == "cleric" && x.SubclassId == "cleric:life" && x.Level >= 3) == true;
            bool maximize = ch.Advancement?.Classes.Any(x => x.ClassId == "cleric" && x.SubclassId == "cleric:life" && x.Level >= 17) == true;
            int bonus = CharacterEngine.Ability(ch, s.Ability) + (life && option.SlotLevel > 0 ? 2 + option.SlotLevel : 0);
            int[] rolls = maximize ? [] : Enumerable.Range(0, count).Select(_ => Roll(die)).ToArray();
            int amount = (maximize ? count * die : rolls.Sum()) + bonus;
            var z = Unit(c, option.TargetId); int actual = Heal(c, z, amount);
            Add(c, "combat.cast", p.Id, $"{s.Name} / {z.Name}：{count}d{die} " + (maximize ? "Supreme Healing最大值" : "[" + string.Join(",", rolls) + "]") + $" {bonus:+0;-0;0}，实际恢复{actual}HP；来源{s.Source}，消耗{s.Resource}。", target: z.Id,
                displayText: $"{p.Name}对{z.Name}施放「{s.Name}」，恢复{actual}点生命。" + (Body(z).Conditions.Contains("Prone") ? "仍然倒地。" : ""));
            if (actual > 0 && life && option.SlotLevel > 0 && z.Id != p.Id && ch.Advancement!.Classes.Any(x => x.ClassId == "cleric" && x.Level >= 6))
            {
                int selfHealed = Heal(c, p, 2 + option.SlotLevel);
                Add(c, "healing", p.Id, $"Blessed Healer：实际恢复{selfHealed}HP。", displayText: $"{p.Name}同时恢复{selfHealed}点生命。");
            }
        }
    }
    private static void EndConcentration(Campaign c, CombatUnit p)
    {
        var ch = PartyEngine.CharacterFor(c, p.Id);
        if (ch.Concentration is null) return;
        PartyEngine.SetCharacter(c, p.Id, ch with { Concentration = null });
        Add(c, "concentration_end", p.Id, p.Name + "结束 " + ch.Concentration.SpellId + " 的专注。", displayText: p.Name + "结束专注。");
    }
    private void ConcentrationSave(Campaign c, CombatUnit p)
    {
        var step = c.StandardCombatFlow!.Steps[0]; int dc = step.SaveDc;
        var ch = PartyEngine.CharacterFor(c, p.Id);
        var check = new RulesEngine(dice).SheetTest(ch, new("concentration", "Concentration", "constitution", "", 0, true),
            ch.BuildMechanics?.Feats.Contains("war-caster") == true ? "advantage" : "normal");
        check = check with { Dc = dc, HasDc = true, Success = check.Total >= dc };
        if (!check.Success) EndConcentration(c, p);
        Add(c, "concentration_save", p.Id, $"{p.Name}专注CON豁免：d20 [{string.Join(",", check.Rolls)}] {check.Modifier:+0;-0;0} = {check.Total} vs DC{dc}，" + (check.Success ? "保持专注。" : "专注结束。"), check: check,
            displayText: p.Name + "进行专注豁免，" + (check.Success ? "保持了专注。" : "失去专注。"));
        c.StandardCombatFlow.Steps.RemoveAt(0); Board(c).Standard!.Wait = null;
    }
}
