using System.Text.Json;

namespace DiceRealm.Server.Domain;

// XPHB: High Elf, Spell Mastery, Circle of the Land Spells, Boon of Energy Resistance.
// A rest window permits one explicit choice per source. Never rebuild Build or acquisition
// history, silently choose a replacement, or treat source replacement as another rest.
public static class AdvancementRestChoices
{
    public const string HighElf = "high-elf-cantrip";
    public const string Mastery = "spell-mastery";
    public const string Land = "druid-land";
    public const string Energy = "energy-resistance";
    private const string ElfSource = "species:elf/lineage:high-elf";
    private const string LandSource = "subclass:druid:land";
    private const string EnergyChoice = "feat:boon-of-energy-resistance:resistance";
    private static readonly string[] Keys = [HighElf, Mastery, Land, Energy];

    public static SheetRestChoice[] Choices(Campaign campaign, Character character)
    {
        if (character.Build is null || character.BuildMechanics is null) return [];
        var catalog = AdvancementCatalog.Get();
        var result = new List<SheetRestChoice>();
        void Add(string key, string label, int count, IEnumerable<BuildOption> options, string[] selected)
        {
            string reason = CharacterPlayEngine.Block(campaign);
            if (reason == "") reason = character.HitPoints <= 0 || character.Exhaustion >= 6
                || character.Conditions.Any(s => s is "Unconscious" or "Incapacitated" or "Paralyzed" or "Petrified" or "Stunned")
                    ? "当前角色无法自行调整休息选择。"
                    : character.PlayState?.PreparationOpen != true || (character.PlayState.RestChoicesUsed ?? []).Contains(key)
                        ? "完成长休后，此来源有一次调整机会；其他行动会结束休息窗口。" : "";
            if (reason == "" && key == Mastery && !character.Inventory.Any(i => i.Id == "spellbook" && i.Quantity > 0))
                reason = "需要持有法术书才能研习并更换法术精通。";
            result.Add(new(key, label, count, options.ToArray(), selected, reason == "", reason));
        }
        if (character.Build.SpeciesId == "elf" && character.Build.Selections.Any(s => s.Key == "species:elf/lineage" && s.Values.SequenceEqual(new[] { "high-elf" })))
        {
            var grant = character.BuildMechanics.SpellGrants.SingleOrDefault(g => g.Source == ElfSource && catalog.Spells.Any(s => s.Id == g.Id && s.Level == 0));
            if (grant is null) throw Invalid();
            Add(HighElf, "高等精灵 · 来源戏法", 1,
                catalog.Spells.Where(s => s.Level == 0 && s.Classes.Contains("wizard")).Select(s => new BuildOption(s.Id, s.Name)), [grant.Id]);
        }
        if (character.Advancement is not { } state) return result.ToArray();
        var wizard = state.Classes.SingleOrDefault(s => s.ClassId == "wizard" && s.Level >= 18);
        if (wizard is not null)
        {
            var mastered = (wizard.BonusSpells ?? []).Where(b => b.Mode == "mastery").ToArray();
            if (mastered.Length != 2 || !new[] { 1, 2 }.All(level => mastered.Count(b => b.Origin == "class:wizard/mastery:" + level
                    && catalog.Spells.Any(s => s.Id == b.Id && s.Level == level && s.ActionCasting && wizard.Spellbook.Contains(s.Id))) == 1)) throw Invalid();
            // One group, not two independent groups: the source allows replacing only ONE.
            Add(Mastery, "法术精通 · 最多替换一个法术", 1,
                new[] { new BuildOption("keep", "保留两个现有法术") }.Concat(mastered.SelectMany(old =>
                    catalog.Spells.Where(s => wizard.Spellbook.Contains(s.Id) && s.Level == catalog.Spells.Single(v => v.Id == old.Id).Level
                        && s.ActionCasting && s.Id != old.Id).Select(s => new BuildOption(s.Level + "/" + s.Id,
                            catalog.Spells.Single(v => v.Id == old.Id).Name + " → " + s.Name)))), ["keep"]);
        }
        var druid = state.Classes.SingleOrDefault(s => s.SubclassId == "druid:land");
        if (druid is not null)
        {
            var blocks = catalog.Subclasses.Single(s => s.Id == "druid:land").AdditionalSpells.EnumerateArray().ToArray();
            var selected = druid.Choices?.SingleOrDefault(s => s.Key == LandSource + ":list")?.Values;
            if (selected is not { Length: 1 } || !int.TryParse(selected[0], out int index) || index < 0 || index >= blocks.Length) throw Invalid();
            Add(Land, "大地结社 · 当前地貌法术", 1, blocks.Select((b, i) => new BuildOption(i.ToString(), b.GetProperty("name").GetString()!)), selected.ToArray());
        }
        var owner = state.Classes.SingleOrDefault(s => (s.Choices ?? []).Any(v => v.Key == EnergyChoice));
        if (owner is not null)
        {
            if (!character.BuildMechanics.Feats.Contains("boon-of-energy-resistance")) throw Invalid();
            var options = catalog.Feats.Single(f => f.Id == "boon-of-energy-resistance").Mechanics.GetProperty("resist")[0].GetProperty("choose").GetProperty("from");
            Add(Energy, "能量抗性恩惠 · 两种抗性", 2, options.EnumerateArray().Select(v => new BuildOption(v.GetString()!, v.GetString()!)),
                owner.Choices!.Single(s => s.Key == EnergyChoice).Values.ToArray());
        }
        return result.ToArray();
    }

    public static Character Apply(Campaign campaign, Character character, string key, string[] selected)
    {
        var choice = Choices(campaign, character).SingleOrDefault(s => s.Key == key)
            ?? throw new GameException("invalid_rest_choice", "请选择已取得来源的休息调整。");
        if (!choice.Available) throw new GameException("character_unavailable", choice.Reason, 409);
        if (selected.Length != choice.Count || selected.Distinct().Count() != choice.Count || selected.Any(id => !choice.Options.Any(o => o.Id == id)))
            throw new GameException("invalid_rest_choice", "休息选择的数量、来源或法术资格无效。");
        var result = character;
        if (key == HighElf)
        {
            var old = character.BuildMechanics!.SpellGrants.Single(g => g.Source == ElfSource && AdvancementCatalog.Get().Spells.Any(s => s.Id == g.Id && s.Level == 0));
            result = result with { BuildMechanics = character.BuildMechanics with
            { SpellGrants = character.BuildMechanics.SpellGrants.Select(g => g == old ? g with { Id = selected[0] } : g).ToArray() } };
        }
        else
        {
            var state = AdvancementEngine.State(character);
            var classes = state.Classes.ToArray();
            if (key == Mastery && selected[0] != "keep")
            {
                var parts = selected[0].Split('/', 2);
                int index = Array.FindIndex(classes, s => s.ClassId == "wizard");
                classes[index] = classes[index] with { BonusSpells = classes[index].BonusSpells!.Select(b =>
                    b.Origin == "class:wizard/mastery:" + parts[0] && b.Mode == "mastery" ? b with { Id = parts[1] } : b).ToArray() };
            }
            else if (key == Land)
            {
                int index = Array.FindIndex(classes, s => s.SubclassId == "druid:land");
                var druid = classes[index];
                var block = AdvancementCatalog.Get().Subclasses.Single(s => s.Id == "druid:land").AdditionalSpells[int.Parse(selected[0])];
                var spells = block.GetProperty("prepared").EnumerateObject().Where(p => int.Parse(p.Name) <= druid.Level)
                    .SelectMany(p => p.Value.EnumerateArray()).Select(v => AdvancementCatalog.Slug(v.GetString()!.Split('|')[0])).ToArray();
                classes[index] = druid with
                {
                    BonusSpells = (druid.BonusSpells ?? []).Where(b => b.Origin != LandSource)
                        .Concat(spells.Select(id => new AdvancementBonusSpell(id, "prepared", LandSource, "wis"))).ToArray(),
                    Choices = druid.Choices!.Select(s => s.Key == LandSource + ":list" ? s with { Values = selected.ToArray() } : s).ToArray()
                };
            }
            else if (key == Energy)
            {
                int index = Array.FindIndex(classes, s => (s.Choices ?? []).Any(v => v.Key == EnergyChoice));
                var old = classes[index].Choices!.Single(s => s.Key == EnergyChoice).Values;
                var other = OtherResistances(character);
                result = result with { BuildMechanics = result.BuildMechanics! with
                { Resistances = result.BuildMechanics!.Resistances.Except(old).Concat(other).Concat(selected).Distinct().Order().ToArray() } };
                classes[index] = classes[index] with { Choices = classes[index].Choices!.Select(s => s.Key == EnergyChoice ? s with { Values = selected.ToArray() } : s).ToArray() };
            }
            result = result with { Advancement = state with { Classes = classes } };
        }
        result = result with { PlayState = result.PlayState! with { RestChoicesUsed = (result.PlayState.RestChoicesUsed ?? []).Append(key).ToArray() } };
        if (result.Advancement is not null) return AdvancementProjection.Refresh(result, character);
        // Level-one lineage cantrips have no resources. Refresh only the spell display;
        // the source routes are read from SpellGrants, and the immutable Build stays intact.
        var data = AdvancementCatalog.Get();
        var ids = result.Build!.Cantrips.Concat(result.PlayState.PreparedSpells).Concat(result.Build.Spellbook)
            .Concat(result.BuildMechanics!.SpellGrants.Select(g => g.Id)).Distinct().ToArray();
        string[] abilities = result.BuildMechanics.SpellGrants.Select(g => g.Ability)
            .Concat(result.Build.Cantrips.Length + result.PlayState.PreparedSpells.Length + result.Build.Spellbook.Length > 0
                ? new[] { BuildCatalog.Get().Classes.Single(c => c.Id == result.Build.ClassId).SpellAbility } : []).Where(s => s != "").Distinct().ToArray();
        string ability = abilities.Length == 1 ? BuildCatalog.AbilityName(abilities[0]) : "multiple";
        int mod = ability == "multiple" ? 0 : CharacterEngine.Ability(result, ability);
        return result with { Spellcasting = new(ability, ability == "multiple" ? 0 : result.ProficiencyBonus + mod,
            ability == "multiple" ? 0 : 8 + result.ProficiencyBonus + mod, ids.Select(id =>
            {
                var s = data.Spells.Single(v => v.Id == id);
                var old = result.Spellcasting?.Spells.SingleOrDefault(v => v.Id == id);
                return new SpellView(id, s.Name, s.Level, s.Level == 0 || result.PlayState.PreparedSpells.Contains(id) || result.BuildMechanics.SpellGrants.Any(g => g.Id == id),
                    old?.Automated ?? false, s.Casting, AdvancementSheet.Details(s));
            }).ToArray()) };
    }

    private static string[] OtherResistances(Character character)
    {
        // The aggregate can contain the same damage type from several independent sources.
        // Recover the immutable initial source plus other acquired feat sources before
        // removing this boon, so e.g. a dragonborn's Fire resistance never disappears.
        var initial = BuildEvaluator.Evaluate(character.Build!).Character?.BuildMechanics?.Resistances ?? throw Invalid();
        var other = initial.ToHashSet();
        var catalog = AdvancementCatalog.Get();
        foreach (var id in character.BuildMechanics!.Feats.Where(id => id != "boon-of-energy-resistance"))
        {
            var feat = catalog.Feats.SingleOrDefault(f => f.Id == id);
            if (feat is not null && feat.Mechanics.TryGetProperty("resist", out var resist))
                foreach (var value in resist.EnumerateArray())
                    if (value.ValueKind == JsonValueKind.String) other.Add(value.GetString()!);
        }
        foreach (var s in character.Advancement!.Classes.SelectMany(c => c.Choices ?? []).Where(s => s.Key != EnergyChoice && s.Key.EndsWith(":resistance", StringComparison.Ordinal)))
            other.UnionWith(s.Values);
        return other.ToArray();
    }

    public static void ValidateState(Campaign campaign)
    {
        foreach (var (_, character) in PartyEngine.Characters(campaign, includeRevoked: true))
        {
            var used = character.PlayState?.RestChoicesUsed;
            if (used is null) continue; // Missing legacy marker never opens a rest window.
            if (used.Length > Keys.Length || used.Distinct().Count() != used.Length || used.Any(k => !Keys.Contains(k))) throw Invalid();
            var choices = Choices(campaign, character);
            if (used.Any(k => !choices.Any(c => c.Key == k))) throw Invalid();
        }
    }
    private static GameException Invalid() => new("invalid_rest_choice_state", "休息来源记录不完整或不兼容；请恢复一致备份。", 409);
}
