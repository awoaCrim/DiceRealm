using System.Text.Json;

namespace DiceRealm.Server.Domain;

// Pure preview and application share one evaluator. Campaign authorization/opportunities
// belong to the application boundary; maxLevel is supplied by that boundary, not the draft.
public static partial class AdvancementEngine
{
    public static CharacterAdvancement State(Character c)
    {
        if (c.Build is null || c.BuildMechanics is null)
            throw new GameException("advancement_build_required", "此成长流程需要完整建卡角色；旧预设继续使用原升级流程。");
        if (c.Advancement is { } state)
        {
            if (!ValidState(c, state))
                throw new GameException("invalid_advancement_state", "成长记录不兼容或不完整；请恢复一致备份。", 409);
            return state;
        }
        if (c.Level != 1)
            throw new GameException("advancement_history_required", "已有等级缺少逐级取得依据，不能推测或重置角色。", 409);
        var b = c.Build;
        var optional = b.Selections.Where(s => s.Key == "class:warlock/invocation").SelectMany(s => s.Values).ToArray();
        return new(1, BuildCatalog.Revision,
            [new(b.ClassId, 1, "", b.Cantrips.ToArray(), (c.PlayState?.PreparedSpells ?? b.PreparedSpells).ToArray(), b.Spellbook.ToArray(), optional, c.BuildMechanics.Masteries.ToArray(), [])], []);
    }

    public static AdvancementPreview Evaluate(Character character, AdvancementDraft draft, int maxLevel)
    {
        if (!ValidDraft(draft))
            throw new GameException("invalid_advancement", "成长选择的版本、字段或数量无效。");
        ValidateResources(character);
        var state = TransferInitialSources(character, State(character));
        var context = new Evaluation(character, state, draft);
        if (character.Level >= 20) context.Issue("level", "level_limit", "总等级已达到 20。");
        if (maxLevel <= character.Level) context.Issue("level", "advancement_not_earned", "尚未获得下一等级的成长资格。");
        var cls = AdvancementCatalog.Get().Classes.SingleOrDefault(c => c.Id == draft.ClassId);
        if (cls is null)
        {
            context.Issue("class", "class_required", "请选择本次提升的职业。");
            return context.Result(null);
        }
        var prior = state.Classes.SingleOrDefault(c => c.ClassId == cls.Id);
        var next = prior is null ? new(cls.Id, 1, "", [], [], [], []) : prior with { Level = prior.Level + 1 };
        if (next.Level > 20 || character.Level >= 20) return context.Result(null);
        if (prior is null && (!MeetsPrimary(character, cls) || state.Classes.Any(s => !MeetsPrimary(character,
                AdvancementCatalog.Get().Classes.Single(c => c.Id == s.ClassId)))))
            context.Issue("class", "multiclass_prerequisite", "当前所有职业及新职业的主要属性均须满足兼职的 13 点要求。");
        if (next.Level == 3)
        {
            var options = AdvancementCatalog.Get().Subclasses.Where(s => s.ClassId == cls.Id).Select(s => new BuildOption(s.Id, s.Name)).ToArray();
            bool valid = options.Any(s => s.Id == draft.SubclassId);
            context.Groups.Add(new("subclass", "class", "选择子职业", 1, options, draft.SubclassId == "" ? [] : [draft.SubclassId], [cls.Id], valid));
            if (!valid) context.Issue("subclass", "subclass_required", "三级需要选择本职业的子职业。");
            else next = next with { SubclassId = draft.SubclassId };
        }
        else if (draft.SubclassId != "" && draft.SubclassId != next.SubclassId)
            context.Issue("subclass", "subclass_unavailable", "不能在此次升级取得或更换子职业。");
        var sub = AdvancementCatalog.Get().Subclasses.SingleOrDefault(s => s.Id == next.SubclassId);
        context.Class = next;
        foreach (var id in cls.Features.Concat(sub?.Features ?? []).Where(id => context.FeaturesById[id].Level == next.Level))
            context.Acquire(id);
        if (prior is null) context.MulticlassTraining(cls);
        context.ClassChoices(cls, next);
        context.FeatChoices(next);
        context.OptionalChoices(cls, sub, prior);
        next = context.Spells(cls, sub, prior, next) with { OptionalFeatures = context.OptionalFeatures, Masteries = context.ClassMasteries };
        context.Class = next;
        var classes = context.SpellChanges(state.Classes.Where(s => s.ClassId != next.ClassId).Append(next).OrderBy(s => s.ClassId).ToArray());
        context.LineageSpells();
        foreach (var selection in draft.Selections.Where(s => !context.UsedKeys.Contains(s.Key)))
            context.Issue(selection.Key, "unavailable_selection", "选择不属于本次取得的能力或其依赖已改变。");
        if (context.Issues.Count > 0) return context.Result(null);
        var scores = character.Abilities.Select(a =>
        {
            int value = a.Score + context.Increases.GetValueOrDefault(a.Name);
            return a with { Score = value, Modifier = RulesEngine.AbilityModifier(value) };
        }).ToArray();
        int conDelta = scores.Single(a => a.Name == "constitution").Modifier - CharacterEngine.Ability(character, "constitution");
        int hpIncrease = Math.Max(1, cls.HitDie / 2 + 1 + CharacterEngine.Ability(character, "constitution"))
            + conDelta * (character.Level + 1);
        if (character.Build!.SpeciesId == "dwarf") hpIncrease += 1;
        if (next.SubclassId == "sorcerer:draconic") hpIncrease += next.Level == 3 ? 3 : 1;
        bool hadTough = character.BuildMechanics!.Feats.Contains("tough");
        hpIncrease += (context.CurrentFeats.Contains("tough") ? 2 * (character.Level + 1) : 0) - (hadTough ? 2 * character.Level : 0);
        if (context.Feats.Contains("boon-of-fortitude")) hpIncrease += 40;
        var step = new AdvancementStep(character.Level + 1, cls.Id, next.Level, next.SubclassId, hpIncrease,
            context.Acquired.Select(f => f.Id).ToArray(), draft with { Selections = draft.Selections.Select(s => new BuildSelection(s.Key, s.Values.ToArray())).ToArray() });
        var resourcePrior = context.PreserveReplacedResources(classes);
        var result = character with
        {
            Level = character.Level + 1,
            Abilities = scores,
            ProficiencyBonus = AdvancementCatalog.Get().Proficiency[character.Level],
            MaxHitPoints = character.MaxHitPoints + hpIncrease,
            // Preserve unconsciousness, injuries, temporary HP, conditions, identity and equipment.
            HitPoints = character.HitPoints == 0 ? 0 : Math.Clamp(character.HitPoints + hpIncrease, 0, character.MaxHitPoints + hpIncrease),
            Skills = context.Skills.Order().ToArray(), Expertise = context.CurrentExpertise,
            Features = context.CurrentFeatures(classes),
            Advancement = new(1, BuildCatalog.Revision, classes, state.Steps.Append(step).ToArray(), context.FeatSources, context.RetiredResources),
            BuildMechanics = character.BuildMechanics with
            {
                ArmorTraining = context.Armor.Order().ToArray(), WeaponTraining = context.Weapons.Order().ToArray(),
                Tools = context.Tools.Order().ToArray(), Languages = context.Languages.Order().ToArray(), Saves = context.Saves.Order().ToArray(),
                Feats = context.CurrentFeats, Masteries = context.Masteries.ToArray(),
                Resistances = context.Resistances.Order().ToArray(), SpellGrants = context.SpellGrants.ToArray()
            }
        };
        result = AdvancementProjection.Refresh(result, resourcePrior);
        return context.Result(result);
    }

    public static bool MeetsPrimary(Character character, AdvancementClassData cls) => cls.PrimaryAbility.EnumerateArray().Any(option =>
        option.EnumerateObject().All(p => character.Abilities.Single(a => a.Name == BuildCatalog.AbilityName(p.Name)).Score >= 13));

    private sealed partial class Evaluation
    {
        public readonly Character Character;
        public readonly CharacterAdvancement State;
        public readonly AdvancementDraft Draft;
        public readonly List<BuildIssue> Issues = [];
        public readonly List<BuildGroup> Groups = [];
        public readonly List<string> Notices = [];
        public readonly HashSet<string> UsedKeys = [];
        public readonly List<AdvancementFeatureData> Acquired = [];
        public readonly Dictionary<string, AdvancementFeatureData> FeaturesById = AdvancementCatalog.Get().Features.ToDictionary(f => f.Id);
        public readonly HashSet<string> Skills, Expertise, Armor, Weapons, Tools, Languages, Saves, Resistances;
        public readonly List<string> Feats = [];
        public readonly List<BuildSpellGrant> SpellGrants;
        public readonly Dictionary<string, int> Increases = [];
        public string[] Masteries;
        public string[] OptionalFeatures = [];
        public string[] ClassMasteries = [];
        public AdvancementClass Class = null!;
        public Evaluation(Character c, CharacterAdvancement state, AdvancementDraft draft)
        {
            Character = c; State = state; Draft = draft;
            Skills = c.Skills.ToHashSet(); Expertise = (c.Expertise ?? []).ToHashSet();
            Armor = c.BuildMechanics!.ArmorTraining.ToHashSet(); Weapons = c.BuildMechanics.WeaponTraining.ToHashSet();
            Tools = c.BuildMechanics.Tools.ToHashSet(); Languages = c.BuildMechanics.Languages.ToHashSet();
            Saves = c.BuildMechanics.Saves.ToHashSet();
            Resistances = c.BuildMechanics.Resistances.ToHashSet();
            SpellGrants = c.BuildMechanics.SpellGrants.ToList();
            TransferInitialGrants();
            Masteries = c.BuildMechanics.Masteries.ToArray();
            InitializeFeatSources();
        }
        public void Issue(string key, string code, string message) => Issues.Add(new("growth", code, message, key));
        public AdvancementPreview Result(Character? c) => new(Issues.Count == 0 && c is not null, Character.Level, Math.Min(20, Character.Level + 1),
            Issues.ToArray(), Groups.ToArray(), c, ["固定生命值成长；已有伤势与已消耗资源保留。能力取得记录不代表其主动效果已自动执行。", ..Notices]);
        public string[] Choose(string key, string label, int count, IEnumerable<BuildOption> options, string[]? prior = null)
        {
            UsedKeys.Add(key);
            var allowed = options.DistinctBy(o => o.Id).ToArray();
            var selected = Draft.Selections.SingleOrDefault(s => s.Key == key)?.Values ?? prior ?? [];
            bool complete = selected.Length == count && selected.Distinct().Count() == count && selected.All(s => allowed.Any(o => o.Id == s));
            Groups.Add(new(key, "choices", label, count, allowed, selected.ToArray(), [Draft.ClassId], complete));
            if (!complete) Issue(key, "choice_required", label + "：请选择 " + count + " 个不同且有效的选项。");
            if (complete && TrainingOrigin != "permanent") GrantChoices.Add(new(key, selected.ToArray()));
            return complete ? selected.ToArray() : [];
        }
        public void Acquire(string id)
        {
            if (Acquired.Any(f => f.Id == id)) return;
            var feature = FeaturesById[id];
            Acquired.Add(feature);
            foreach (var link in feature.Links) AcquireLink(link, feature.Name);
        }
        private void AcquireLink(AdvancementLink link, string label)
        {
            if (link.Ref != "") { Acquire(link.Ref); return; }
            // Invocation and maneuver catalogues are offered by their explicit progression,
            // not once again by the source's encyclopaedic "Options" feature.
            if (link.Options is null || link.Options.All(o => o.Optional != "")) return;
            var selected = Choose(link.Key, label, link.Count, link.Options.Select(o =>
                new BuildOption(o.Ref != "" ? o.Ref : o.Key, o.Ref != "" ? FeaturesById[o.Ref].Name : label)));
            foreach (var option in link.Options.Where(o => selected.Contains(o.Ref != "" ? o.Ref : o.Key))) AcquireLink(option, label);
        }
        public void MulticlassTraining(AdvancementClassData cls)
        {
            var data = cls.MulticlassProficiencies;
            foreach (string key in new[] { "armor", "weapons" })
                if (data.TryGetProperty(key, out var values))
                    foreach (var v in values.EnumerateArray()) GainTraining(key == "armor" ? Armor : Weapons, v.GetString()!);
            if (data.TryGetProperty("skills", out var skills))
                foreach (var group in skills.EnumerateArray())
                    if (group.TryGetProperty("choose", out var choice))
                    {
                        var options = choice.GetProperty("from").EnumerateArray().Select(v => Skill(v.GetString()!)).Where(s => !Skills.Contains(s.Name));
                        foreach (var s in Choose("multiclass:skill", "兼职技能熟练", choice.GetProperty("count").GetInt32(), options.Select(s => new BuildOption(s.Id, s.Name)))) GainTraining(Skills, Skill(s).Name);
                    }
            if (cls.Id == "rogue") GainTraining(Tools, "thieves-tools");
            if (cls.Id == "bard")
                foreach (var id in Choose("multiclass:instrument", "兼职乐器熟练", 1,
                             BuildCatalog.Get().Equipment.Where(e => e.Kind == "INS").Select(e => new BuildOption(e.Id, e.Name)))) GainTraining(Tools, id);
        }
        private static BuildSkill Skill(string id) => BuildCatalog.Get().Skills.Single(s => s.Id == id || s.Name.Equals(id, StringComparison.OrdinalIgnoreCase));
        private void ExpertiseChoice(string key, int count, string[]? allowed = null)
        {
            var options = BuildCatalog.Get().Skills.Where(s => Skills.Contains(s.Name) && !Expertise.Contains(s.Name) && (allowed is null || allowed.Contains(s.Name))).ToArray();
            if (options.Length < count)
                Notices.Add("技能专精的合格熟练技能不足；只可选择现有合格目标，不额外获得技能熟练。");
            if (options.Length == 0) return;
            foreach (string id in Choose(key, "技能专精", Math.Min(count, options.Length), options.Select(s => new BuildOption(s.Id, s.Name)))) GainTraining(Expertise, Skill(id).Name);
        }
        public void ClassChoices(AdvancementClassData cls, AdvancementClass next)
        {
            FeatureProficiencies(cls, next);
            if (cls.Id == "wizard" && next.Level == 2)
                ExpertiseChoice("scholar", 1, ["Arcana", "History", "Investigation", "Medicine", "Nature", "Religion"]);
            if (cls.Id == "rogue" && next.Level is 1 or 6 || cls.Id == "bard" && next.Level is 2 or 9 || cls.Id == "ranger" && next.Level == 9)
                ExpertiseChoice("expertise", 2);
            if (cls.Id == "ranger" && next.Level == 2)
            {
                ExpertiseChoice("deft-explorer:expertise", 1);
                foreach (var id in Choose("deft-explorer:languages", "探索者语言", 2,
                    BuildCatalog.Get().Languages.Where(l => l.Id != "druidic" && l.Id != "thieves-cant" && !Languages.Contains(l.Id)).Select(l => new BuildOption(l.Id, l.Name)))) Languages.Add(id);
            }
            if (cls.Id == "barbarian" && next.Level == 3)
                foreach (var id in Choose("primal-knowledge", "原初知识技能", 1,
                    BuildCatalog.Get().Classes.Single(c => c.Id == cls.Id).Skills.Select(Skill).Where(s => !Skills.Contains(s.Name)).Select(s => new BuildOption(s.Id, s.Name)))) GainTraining(Skills, Skill(id).Name);
            int masteryCount = AdvancementCatalog.Table(cls.Tables, "Weapon Mastery", next.Level);
            if (cls.Id is "paladin" or "ranger" or "rogue") masteryCount = 2;
            if (masteryCount > 0)
            {
                var options = BuildCatalog.Get().Equipment.Where(e => e.Mastery.Length > 0 && (e.WeaponCategory == "simple" || Weapons.Contains(e.WeaponCategory)));
                var ownPrevious = State.Classes.SingleOrDefault(c => c.ClassId == cls.Id)?.Masteries ?? [];
                var chosen = Choose("masteries", "本职业武器精通", masteryCount, options.Select(e => new BuildOption(e.Id, e.Name)), ownPrevious.Length == masteryCount ? ownPrevious : []);
                ClassMasteries = chosen;
                Masteries = chosen.Concat(State.Classes.Where(c => c.ClassId != cls.Id).SelectMany(c => c.Masteries ?? []))
                    .Concat(State.Steps.SelectMany(s => s.Choices.Selections.Where(v => v.Key == "feat:mastery").SelectMany(v => v.Values))).Distinct().ToArray();
            }
            if (cls.Id == "barbarian" && next.Level == 20) { Increase("str", 4, 25); Increase("con", 4, 25); }
            if (cls.Id == "monk" && next.Level == 20) { Increase("dex", 4, 25); Increase("wis", 4, 25); }
        }
        private void Increase(string id, int amount, int maximum)
        {
            string name = BuildCatalog.AbilityName(id);
            int current = Character.Abilities.Single(a => a.Name == name).Score + Increases.GetValueOrDefault(name);
            Increases[name] = Increases.GetValueOrDefault(name) + Math.Max(0, Math.Min(amount, maximum - current));
        }
    }
}
