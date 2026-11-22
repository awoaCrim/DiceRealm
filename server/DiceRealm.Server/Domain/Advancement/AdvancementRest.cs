namespace DiceRealm.Server.Domain;

public sealed record HitDiePool(int Sides, string Resource, int Current);
public sealed record ArcaneRecoveryChoice(string Target, int[] Slots, string Label);

// XPHB p44: equal die types pool, different types remain separately selectable.
// XPHB Wizard / Arcane Recovery: ceil(Wizard level / 2), expended slots below level 6.
// This extends the existing rest owner and its consent/receipt path; no new roll API.
public static class AdvancementRest
{
    public static HitDiePool[] Dice(Character c) => AdvancementEngine.State(c).Classes
        .Select(s => AdvancementCatalog.Get().Classes.Single(d => d.Id == s.ClassId).HitDie).Distinct().Order()
        .Select(sides => new HitDiePool(sides, "Hit Dice (d" + sides + ")", CharacterEngine.Value(c, "Hit Dice (d" + sides + ")")))
        .Where(pool => pool.Current > 0).ToArray();

    public static string DieTarget(Character c, int sides, bool start) => sides == BuildRuntime.HitDie(c)
        ? start ? "hit_die" : "" : start ? "hit_die:d" + sides : "d" + sides;

    public static ActionChoice[] DieChoices(Character c, bool start) => Dice(c).Select(pool => new ActionChoice(
        start ? "rest.short" : "rest.hit_die", DieTarget(c, pool.Sides, start),
        (start ? "短休 1 小时并花 " : "在刚才短休中再花 ") + "1 颗 d" + pool.Sides + " 生命骰（剩余 " + pool.Current + "）")).ToArray();

    public static int DieSides(Character c, string target, bool start)
    {
        // The legacy combined request still names the original class's die and one first-level slot.
        if (start && target == "hit_die_arcane") return BuildRuntime.HitDie(c);
        return Dice(c).Single(p => DieTarget(c, p.Sides, start) == target).Sides;
    }

    public static ArcaneRecoveryChoice[] ArcaneChoices(Character c)
    {
        int wizard = AdvancementEngine.State(c).Classes.SingleOrDefault(s => s.ClassId == "wizard")?.Level ?? 0;
        if (wizard == 0 || CharacterEngine.Value(c, "Arcane Recovery") < 1 || !c.Inventory.Any(i => i.Id == "spellbook" && i.Quantity > 0)) return [];
        int budget = (wizard + 1) / 2;
        int[] missing = Enumerable.Range(1, 5).Select(level => c.Resources.SingleOrDefault(r => r.Name == AdvancementProjection.SlotName(level)))
            .Select(r => r is null ? 0 : Math.Max(0, r.Maximum - r.Current)).ToArray();
        var result = new List<ArcaneRecoveryChoice>();
        var counts = new int[5];
        void Choose(int level, int remaining)
        {
            if (level == 6)
            {
                if (counts.All(n => n == 0)) return;
                var selected = counts.ToArray();
                string target = selected[0] == 1 && selected.Skip(1).All(n => n == 0) ? "arcane" : "arcane:" + string.Join(",", selected);
                result.Add(new(target, selected, string.Join("、", selected.Select((n, i) => (n, level: i + 1)).Where(x => x.n > 0).Select(x => x.n + " 个 " + x.level + " 环位"))));
                return;
            }
            for (int count = 0; count <= Math.Min(missing[level - 1], remaining / level); count++)
            { counts[level - 1] = count; Choose(level + 1, remaining - count * level); }
            counts[level - 1] = 0;
        }
        Choose(1, budget);
        return result.OrderByDescending(r => r.Slots.Select((n, i) => n * (i + 1)).Sum()).ThenBy(r => r.Target, StringComparer.Ordinal).ToArray();
    }

    public static ActionChoice[] ShortRestChoices(Campaign campaign, bool recovery)
    {
        var c = PlayResources.Ensure(campaign.ActingCharacter);
        var result = new List<ActionChoice>();
        if (recovery || c.Resources.Any(r => (r.Recovery is "short" or "short-one") && r.Current < r.Maximum))
            result.Add(new("rest.short", "", "短休 1 小时 / 不花生命骰"));
        bool heal = c.HitPoints < c.MaxHitPoints || recovery;
        if (heal) result.AddRange(DieChoices(c, true));
        var arcane = ArcaneChoices(c);
        result.AddRange(arcane.Select(choice => new ActionChoice("rest.short", choice.Target, "短休 / 奥术回想恢复 " + choice.Label)));
        if (heal && Dice(c).Any(d => d.Sides == BuildRuntime.HitDie(c)) && arcane.Any(a => a.Target == "arcane"))
            result.Add(new("rest.short", "hit_die_arcane", "短休 / 1 颗 d" + BuildRuntime.HitDie(c) + " 生命骰与奥术回想恢复 1 个 1 环位"));
        return result.ToArray();
    }

    public static string Recover(Campaign c, string target)
    {
        var choice = ArcaneChoices(c.ActingCharacter).Single(a => a.Target == (target == "hit_die_arcane" ? "arcane" : target));
        CharacterEngine.Change(c, "Arcane Recovery", -1);
        for (int i = 0; i < choice.Slots.Length; i++) CharacterEngine.Change(c, AdvancementProjection.SlotName(i + 1), choice.Slots[i]);
        return "奥术回想恢复 " + choice.Label + "；此能力完成长休后才能再次使用。";
    }
}
