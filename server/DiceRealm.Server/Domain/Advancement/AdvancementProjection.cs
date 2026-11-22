namespace DiceRealm.Server.Domain;

// Derived progression is rebuilt from class levels, never from client-supplied maxima.
// A maximum increase grants only the newly gained capacity, not a free rest.
public static class AdvancementProjection
{
    public static string SlotName(int level, bool pact = false) => (pact ? "Pact Slots (" : "Spell Slots (")
        + level + (level == 1 ? "st" : level == 2 ? "nd" : level == 3 ? "rd" : "th") + ")";

    public static Character Refresh(Character c, Character previous)
    {
        var state = AdvancementEngine.State(c);
        var data = AdvancementCatalog.Get();
        var resources = PlayResources.Ensure(previous).Resources.ToList();
        int rangerUses = state.Classes.SingleOrDefault(s => s.ClassId == "ranger") is { } ranger
            ? AdvancementCatalog.Table(data.Classes.Single(d => d.Id == "ranger").Tables, "Favored Enemy", ranger.Level) : 0;
        void Set(string name, int maximum, string recovery = "long", Resource? renamed = null)
        {
            var old = renamed ?? resources.SingleOrDefault(r => r.Name == name);
            int spent = old is null ? 0 : old.Maximum - old.Current;
            var value = new Resource(name, Math.Clamp(maximum - spent, 0, maximum), maximum, recovery, old?.Description ?? "2024 职业等级派生；升级保留已消耗量。", "XPHB");
            resources.RemoveAll(r => r.Name == name);
            if (renamed is not null) resources.RemoveAll(r => r.Name == renamed.Name);
            if (maximum > 0) resources.Add(value);
        }
        foreach (var group in state.Classes.GroupBy(s => data.Classes.Single(d => d.Id == s.ClassId).HitDie))
            Set("Hit Dice (d" + group.Key + ")", group.Sum(s => s.Level));
        var slots = AdvancementCatalog.SharedSlots(state.Classes);
        for (int i = 0; i < slots.Length; i++) Set(SlotName(i + 1), slots[i]);
        foreach (var cls in state.Classes)
        {
            var definition = data.Classes.Single(d => d.Id == cls.ClassId);
            int T(string column) => AdvancementCatalog.Table(definition.Tables, column, cls.Level);
            switch (cls.ClassId)
            {
                case "barbarian": Set("Rage", T("Rages"), "short-one"); break;
                case "bard": Set("Bardic Inspiration", Math.Max(1, CharacterEngine.Ability(c, "charisma")), cls.Level >= 5 ? "short" : "long"); break;
                case "cleric": Set("Channel Divinity [cleric]", T("Channel Divinity"), "short-one"); break;
                case "druid": Set("Wild Shape", T("Wild Shape"), "short-one"); break;
                case "fighter":
                    Set("Second Wind", T("Second Wind"), "short-one");
                    if (cls.Level >= 2) Set("Action Surge", cls.Level >= 17 ? 2 : 1, "short");
                    if (cls.Level >= 9) Set("Indomitable", cls.Level >= 17 ? 3 : cls.Level >= 13 ? 2 : 1);
                    break;
                case "monk": Set("Focus Points", T("Focus Points"), "short"); break;
                case "paladin":
                    Set("Lay on Hands", cls.Level * 5);
                    Set("Channel Divinity [paladin]", T("Channel Divinity"), "short-one");
                    break;
                case "sorcerer":
                    Set("Innate Sorcery", 2);
                    Set("Sorcery Points", T("Sorcery Points"));
                    break;
                case "warlock":
                    int spellLevel = T("Slot Level");
                    Set(SlotName(spellLevel, true), T("Spell Slots"), "short", resources.SingleOrDefault(r => r.Name.StartsWith("Pact Slots (", StringComparison.Ordinal)));
                    if (cls.Level >= 2) Set("Magical Cunning", 1);
                    break;
                case "wizard": Set("Arcane Recovery", 1); break;
            }
            foreach (var spell in cls.BonusSpells ?? [])
                if (spell.Mode is "arcanum" or "signature" || spell.Uses > 0 && spell.Resource == "")
                    Set(AdvancementSheet.FreeSpell(spell), spell.Mode is "arcanum" or "signature" ? 1
                        : spell.Origin == "class:ranger" && spell.Id == "hunter-s-mark" ? rangerUses
                        : BuildCatalog.Get().Abilities.Contains(spell.Condition) ? Math.Max(1, CharacterEngine.Ability(c, BuildCatalog.AbilityName(spell.Condition))) : spell.Uses,
                        spell.Mode == "signature" ? "short" : spell.Recovery);
        }
        var m = c.BuildMechanics!;
        foreach (var resource in new[] { "Luck Points", "Breath Weapon", "Giant Ancestry", "Adrenaline Rush" })
        {
            var old = resources.SingleOrDefault(r => r.Name == resource);
            if (old is not null) Set(resource, c.ProficiencyBonus, old.Recovery);
        }
        if (m.Feats.Contains("lucky") && !resources.Any(r => r.Name == "Luck Points")) Set("Luck Points", c.ProficiencyBonus);
        string[] saves = m.Saves;
        var latest = state.Steps.LastOrDefault();
        if (latest?.Choices.Selections.SingleOrDefault(s => s.Key == "feat")?.Values.Contains("resilient") == true)
            saves = saves.Concat(latest.Choices.Selections.Single(s => s.Key == "feat:ability").Values.Select(BuildCatalog.AbilityName)).Distinct().ToArray();
        var skills = BuildCatalog.Get().Skills.Select(s => new BuildSkillValue(s.Id, s.Name, BuildCatalog.AbilityName(s.Ability),
            CharacterEngine.Ability(c, BuildCatalog.AbilityName(s.Ability)) + ((c.Expertise ?? []).Contains(s.Name) ? 2 * c.ProficiencyBonus
                : c.Skills.Contains(s.Name) ? c.ProficiencyBonus : 0) + BuildRuntime.ExtraSkillBonus(c, s.Name, BuildCatalog.AbilityName(s.Ability)),
            c.Skills.Contains(s.Name), (c.Expertise ?? []).Contains(s.Name))).ToArray();
        var grants = m.SpellGrants.Select(g => g with
        {
            FreeUses = g.Source == "species:gnome/lineage:forest" && g.Id == "speak-with-animals" ? c.ProficiencyBonus
                : g.Source == "class:ranger" && g.Id == "hunter-s-mark" ? rangerUses : g.FreeUses,
            AttackBonus = c.ProficiencyBonus + CharacterEngine.Ability(c, BuildCatalog.AbilityName(g.Ability)),
            SaveDc = 8 + c.ProficiencyBonus + CharacterEngine.Ability(c, BuildCatalog.AbilityName(g.Ability))
        }).ToArray();
        foreach (var grant in grants.Where(g => g.FreeUses > 0)) Set(PlayResources.FreeSpell(grant), grant.FreeUses);
        var allSpells = state.Classes.SelectMany(s => s.Cantrips.Concat(s.PreparedSpells).Concat(s.Spellbook).Concat((s.BonusSpells ?? []).Select(b => b.Id)))
            .Concat(grants.Select(g => g.Id)).Distinct().Select(id => data.Spells.Single(s => s.Id == id)).ToArray();
        bool Prepared(string id) => state.Classes.Any(s => s.Cantrips.Contains(id) || s.PreparedSpells.Contains(id) || (s.BonusSpells ?? []).Any(b => b.Id == id)) || grants.Any(g => g.Id == id);
        var first = data.Classes.Single(x => x.Id == c.Build!.ClassId);
        var firstState = state.Classes.Single(x => x.ClassId == first.Id);
        var castingAbilities = grants.Select(g => g.Ability).ToList();
        foreach (var cls in state.Classes)
        {
            string stat = data.Subclasses.SingleOrDefault(s => s.Id == cls.SubclassId)?.SpellcastingAbility is { Length: > 0 } a
                ? a : data.Classes.Single(s => s.Id == cls.ClassId).SpellcastingAbility;
            if (cls.Cantrips.Length + cls.PreparedSpells.Length + cls.Spellbook.Length > 0) castingAbilities.Add(stat);
            castingAbilities.AddRange((cls.BonusSpells ?? []).Select(s => s.Ability == "" ? stat : s.Ability));
        }
        string[] abilities = castingAbilities.Where(BuildCatalog.Get().Abilities.Contains).Distinct().ToArray();
        string ability = abilities.Length == 1 ? abilities[0] : "";
        int mod = ability == "" ? 0 : CharacterEngine.Ability(c, BuildCatalog.AbilityName(ability));
        return c with
        {
            Resources = resources.ToArray(), ArmorClass = ArmorClass(c, (c.Effects ?? []).Any(e => e.Id == "mage-armor")), 
            BuildMechanics = m with
            {
                Saves = saves, Skills = skills, SpellGrants = grants, Speed = Speed(c),
                SavingThrows = c.Abilities.Select(a => new BuildSaveValue(a.Name, a.Modifier + (saves.Contains(a.Name) ? c.ProficiencyBonus : 0), saves.Contains(a.Name))).ToArray(),
                InitiativeBonus = CharacterEngine.Ability(c, "dexterity") + (m.Feats.Contains("alert") ? c.ProficiencyBonus : 0),
                PassivePerception = 10 + skills.Single(s => s.Id == "perception").Modifier,
                // Existing combat is still a level-one bounded engine; growth cannot silently
                // enable its incomplete high-level attacks/effects. Line 3 owns that registry.
                AutomatedCombat = false
            },
            PlayState = (c.PlayState ?? new CharacterPlayState(1, [])) with { PreparedSpells = firstState.PreparedSpells.ToArray() },
            Spellcasting = allSpells.Length == 0 ? null : new(ability == "" ? "multiple" : BuildCatalog.AbilityName(ability), ability == "" ? 0 : c.ProficiencyBonus + mod,
                ability == "" ? 0 : 8 + c.ProficiencyBonus + mod, allSpells.Select(s => new SpellView(s.Id, s.Name, s.Level, Prepared(s.Id), false, "见来源规则", "按职业来源取得；主动效果需使用支持的执行能力或主持裁定。")).ToArray())
        };
    }

    public static int ArmorClass(Character c, bool mageArmor) => ArmorClassCalculation(c, mageArmor).Value;
    public static ArmorClassCalculation ArmorClassCalculation(Character c, bool mageArmor)
    {
        var states = AdvancementEngine.State(c).Classes;
        var equipped = BuildRuntime.Equipped(c);
        string unarmored = c.Build!.ClassId;
        if (unarmored is not ("barbarian" or "monk"))
            unarmored = c.Advancement!.Steps.Select(s => s.ClassId).FirstOrDefault(id => id is "barbarian" or "monk") ?? c.Build.ClassId;
        // Multiple unarmored formulas do not stack and multiclassing cannot acquire it twice.
        var basis = BuildEvaluator.ArmorClassCalculation(unarmored, CharacterEngine.Ability(c, "dexterity"), CharacterEngine.Ability(c, "constitution"),
            CharacterEngine.Ability(c, "wisdom"), c.BuildMechanics!.Feats.Contains("defense"), equipped, mageArmor);
        if (!equipped.Any(e => e.Kind is "LA" or "MA" or "HA") && states.Any(s => s.SubclassId == "sorcerer:draconic"))
        {
            int dex = CharacterEngine.Ability(c, "dexterity"), charisma = CharacterEngine.Ability(c, "charisma");
            bool shield = equipped.Any(e => e.Kind == "S");
            int draconic = 10 + dex + charisma + (shield ? 2 : 0);
            if (draconic > basis.Value) basis = new(draconic, shield
                ? ["Draconic无甲防御：10 + DEX " + dex + " + CHA " + charisma, "实际持盾 +2"]
                : ["Draconic无甲防御：10 + DEX " + dex + " + CHA " + charisma]);
        }
        return WearableEquipment.ArmorClass(c, basis);
    }
    public static int CheckBonus(Character c, string skill, string ability)
    {
        var state = AdvancementEngine.State(c);
        int total = 0;
        if (skill != "" && !c.Skills.Contains(skill) && state.Classes.Any(s => s.ClassId == "bard" && s.Level >= 2)) total += c.ProficiencyBonus / 2;
        if (ability == "charisma" && state.Classes.Any(s => s.SubclassId == "ranger:fey-wanderer")) total += Math.Max(1, CharacterEngine.Ability(c, "wisdom"));
        bool Order(string classId, string feature) => c.Build!.ClassId == classId && c.Build.Selections.Any(s => s.Key == "class:" + classId + "/order" && s.Values.Contains(feature))
            || state.Steps.Any(s => s.Features.Contains(feature + "|" + classId + "|xphb|1"));
        if (skill is "Arcana" or "Religion" && Order("cleric", "thaumaturge")) total += Math.Max(1, CharacterEngine.Ability(c, "wisdom"));
        if (skill is "Arcana" or "Nature" && Order("druid", "magician")) total += Math.Max(1, CharacterEngine.Ability(c, "wisdom"));
        return total;
    }
    public static int Speed(Character c)
    {
        var states = AdvancementEngine.State(c).Classes;
        int speed = BuildRuntime.BaseSpeed(c);
        bool shield = EquipmentLoadout.Shield(c);
        var monk = states.SingleOrDefault(s => s.ClassId == "monk");
        if (monk is not null && !BuildRuntime.Armored(c) && !shield)
            speed += AdvancementCatalog.Table(AdvancementCatalog.Get().Classes.Single(x => x.Id == "monk").Tables, "Unarmored Movement", monk.Level);
        bool heavy = c.Inventory.Any(i => i.Equipped && i.Quantity > 0 && BuildCatalog.Get().Equipment.Any(e => e.Id == i.Id && e.Kind == "HA"));
        if (states.Any(s => s.ClassId == "barbarian" && s.Level >= 5) && !heavy) speed += 10;
        if (c.BuildMechanics!.Feats.Contains("speedy")) speed += 10;
        if (c.BuildMechanics.Feats.Contains("boon-of-speed")) speed += 30;
        return speed;
    }
}
