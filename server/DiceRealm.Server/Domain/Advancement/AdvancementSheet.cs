using System.Text.Json;

namespace DiceRealm.Server.Domain;

public static class AdvancementSheet
{
    public static SheetPreparation[] Preparations(Campaign c, Character character)
    {
        var catalog = AdvancementCatalog.Get();
        return AdvancementEngine.State(character).Classes.Select(state =>
        {
            var cls = catalog.Classes.Single(x => x.Id == state.ClassId);
            bool supported = cls.Id is "cleric" or "druid" or "wizard" or "paladin" or "ranger";
            var options = supported ? catalog.Spells.Where(s => s.Level > 0 && s.Level <= AdvancementCatalog.MaximumSpellLevel(state)
                && s.Classes.Contains(cls.Id) && (cls.Id != "wizard" || state.Spellbook.Contains(s.Id))
                && !(state.BonusSpells ?? []).Any(b => b.Id == s.Id && b.Mode is "prepared" or "known"))
                .Select(s => new BuildOption(s.Id, s.Name, Details(s))).ToArray() : [];
            string reason = CharacterPlayEngine.Block(c);
            if (reason == "") reason = !supported ? "此职业的准备法术替换与升级绑定。"
                : Unable(character) ? "当前角色无法准备法术。"
                : character.PlayState?.PreparationOpen != true || (character.PlayState.PreparedClasses ?? []).Contains(cls.Id)
                    ? "完成长休后，每个可重新准备的职业各有一次调整窗口；其他行动会结束该窗口。" : "";
            return new SheetPreparation(reason == "", reason, state.PreparedSpells.Length,
                cls.Id is "paladin" or "ranger" ? 1 : state.PreparedSpells.Length, options, state.PreparedSpells.ToArray(), cls.Id);
        }).ToArray();
    }
    private static bool Unable(Character c) => c.HitPoints <= 0 || c.Exhaustion >= 6
        || c.Conditions.Any(s => s is "Unconscious" or "Incapacitated" or "Paralyzed" or "Petrified" or "Stunned");
    public static Character Prepare(Campaign campaign, Character c, string classId, string[] selected)
    {
        if (classId == "") classId = c.Build!.ClassId;
        var preparation = Preparations(campaign, c).SingleOrDefault(p => p.ClassId == classId)
            ?? throw new GameException("invalid_preparation", "请选择已有职业的准备清单。");
        if (!preparation.Available) throw new GameException("character_unavailable", preparation.Reason, 409);
        if (selected.Length != preparation.Count || selected.Distinct().Count() != selected.Length
            || selected.Any(id => !preparation.Options.Any(o => o.Id == id)) || selected.Except(preparation.Selected).Count() > preparation.MaxChanges)
            throw new GameException("invalid_preparation", "准备数量、法术来源或本次可替换数量不合法。");
        var state = AdvancementEngine.State(c);
        var result = c with
        {
            Advancement = state with { Classes = state.Classes.Select(s => s.ClassId == classId ? s with { PreparedSpells = selected.ToArray() } : s).ToArray() },
            PlayState = c.PlayState! with { PreparedClasses = (c.PlayState!.PreparedClasses ?? []).Append(classId).Distinct().ToArray() }
        };
        return AdvancementProjection.Refresh(result, c);
    }
    public static SheetSpellOption[] Spells(Character c, string block)
    {
        var output = new List<SheetSpellOption>();
        var catalog = AdvancementCatalog.Get();
        void Add(string key, string id, string source, string ability, string resource, string note = "")
        {
            var spell = catalog.Spells.Single(s => s.Id == id);
            int count = resource == "" ? -1 : c.Resources.SingleOrDefault(r => r.Name == resource)?.Current ?? 0;
            string reason = block != "" ? block : Unable(c) ? "当前角色不能记录施法。" : count == 0 ? "所选来源的资源已用尽。" : "";
            bool hasAbility = BuildCatalog.Get().Abilities.Contains(ability);
            int mod = hasAbility ? CharacterEngine.Ability(c, BuildCatalog.AbilityName(ability)) : 0;
            output.Add(new(key, id, spell.Name, source, hasAbility ? BuildCatalog.AbilityName(ability) : "", hasAbility ? c.ProficiencyBonus + mod : 0,
                hasAbility ? 8 + c.ProficiencyBonus + mod : 0, resource, count, Details(spell) + note, reason == "", reason));
        }
        void Paid(string key, string id, string source, string ability)
        {
            var spell = catalog.Spells.Single(s => s.Id == id);
            if (spell.Level == 0) { Add(key + "/cantrip", id, source, ability, ""); return; }
            for (int level = spell.Level; level <= 9; level++)
                foreach (bool pact in new[] { false, true })
                {
                    string name = AdvancementProjection.SlotName(level, pact);
                    if (c.Resources.Any(r => r.Name == name)) Add(key + "/" + (pact ? "pact/" : "slot/") + level, id, source, ability, name);
                }
        }
        foreach (var state in AdvancementEngine.State(c).Classes)
        {
            var cls = catalog.Classes.Single(s => s.Id == state.ClassId);
            var sub = catalog.Subclasses.SingleOrDefault(s => s.Id == state.SubclassId);
            string ability = sub?.SpellcastingAbility is { Length: > 0 } a ? a : cls.SpellcastingAbility;
            foreach (var id in state.Cantrips.Concat(state.PreparedSpells).Distinct())
                Paid("class/" + state.ClassId + "/" + id, id, "class:" + state.ClassId, ability);
            foreach (var id in (state.ClassId == "wizard" ? state.Spellbook : state.PreparedSpells).Where(id => catalog.Spells.Single(s => s.Id == id).Ritual))
                Add("ritual/" + state.ClassId + "/" + id, id, "class:" + state.ClassId, ability, "", "\n仪式额外耗时和材料仍须在实际执行时确认。");
            int index = 0;
            foreach (var bonus in state.BonusSpells ?? [])
            {
                string key = "bonus/" + state.ClassId + "/" + index++ + "/" + bonus.Id;
                string stat = bonus.Ability == "" ? ability : bonus.Ability;
                if (bonus.Mode is "known" or "prepared" or "signature" or "mastery") Paid(key, bonus.Id, bonus.Origin, stat);
                if (bonus.Mode == "mastery") Add(key + "/mastery", bonus.Id, bonus.Origin, stat, "", "\n法术精通只可在最低环级无消耗施放。");
                else if (bonus.Mode is "arcanum" or "signature" || bonus.Uses > 0 && bonus.Resource == "")
                    Add(key + "/free", bonus.Id, bonus.Origin, stat, FreeSpell(bonus));
                else if (bonus.Mode == "at-will")
                    Add(key + "/at-will", bonus.Id, bonus.Origin, stat, "", bonus.Condition == "self"
                        ? "\n此祈唤只允许对自己无槽施放；材料与实际效果仍须确认。"
                        : "\n此祈唤允许以魔法动作无槽施放；不免材料，也不自动召唤魔宠。");
                else if (bonus.Mode == "ritual") Add(key + "/ritual", bonus.Id, bonus.Origin, stat, "", "\n仅记录来源允许的仪式，尚未推进施法时间。");
                else if (bonus.Mode == "innate")
                {
                    // Metadata's innate tag also describes feature-bound casting (for example
                    // The Third Eye). It does not authorize a free at-will spell by itself.
                    Add(key + "/feature", bonus.Id, bonus.Origin, stat, "", "\n来源能力的触发、次数与额外条件须裁定；这不是无条件任意施法许可。");
                }
            }
        }
        int grantIndex = 0;
        foreach (var grant in c.BuildMechanics!.SpellGrants)
        {
            string key = "initial/" + grantIndex++ + "/" + grant.Id;
            Paid(key, grant.Id, grant.Source, grant.Ability);
            if (grant.FreeUses > 0) Add(key + "/free", grant.Id, grant.Source, grant.Ability, PlayResources.FreeSpell(grant));
            if (grant.Mode == "at-will") Add(key + "/at-will", grant.Id, grant.Source, grant.Ability, "");
        }
        return output.ToArray();
    }
    public static string FreeSpell(AdvancementBonusSpell s) => "Free: " + s.Id + " [" + s.Origin + "]";
    public static string Details(AdvancementSpellData s) => s.Name + " · " + (s.Level == 0 ? "戏法" : s.Level + " 环")
        + "\n施法：" + s.Casting + "\n范围：" + JsonSerializer.Serialize(s.Range) + "\n持续：" + JsonSerializer.Serialize(s.Duration)
        + "\n成分：" + JsonSerializer.Serialize(s.Components) + (s.Ritual ? "\n可仪式施放" : "")
        + "\n这是取得与资源记录；材料、触发、目标和效果不因保存记录而自动执行。";
}
