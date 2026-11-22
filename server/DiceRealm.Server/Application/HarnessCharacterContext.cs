using System.Text.Json.Serialization;
using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Application;

// Explicit, read-only acting-seat facts. Never serialize Character, Build, acquisition
// choices/history or Campaign here. Source-linked spell routes remain separate even when
// the same spell is obtained more than once. They describe ownership/cost, not execution.
public sealed record HarnessCharacterContext(string ActorId, string Id, string Name, string Species, string ClassName,
    string Background, int Level, HarnessCharacterClass[] Classes, HarnessCharacterIdentity? Identity,
    Ability[] Abilities, int ArmorClass, int ProficiencyBonus, int HitPoints, int MaxHitPoints, int TemporaryHitPoints,
    int Speed, string Size, int InitiativeBonus, int PassivePerception, BuildSaveValue[] SavingThrows, BuildSkillValue[] Skills,
    string[] Conditions, int Exhaustion, string[] Features, HarnessCharacterResource[] Resources, Item[] Inventory,
    HarnessCharacterProficiencies Proficiencies, string[] Feats, string[] Masteries, string[] Resistances,
    HarnessCharacterSpell[] Spells, HarnessCharacterSpellSelection[] SpellSelections, HarnessCharacterSpellRoute[] SpellRoutes,
    HarnessCharacterSpellGrant[] SpellGrants,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? ActiveWeaponId = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] SheetLoadoutView? Loadout = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] SheetWearablesView? Wearables = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] CharacterEquipmentStatus? EquipmentStatus = null)
{
    public const int MinimumToolVersion = 19;

    public static HarnessCharacterContext Capture(Campaign campaign, int toolContractVersion = 19)
    {
        // Ensure is a pure copy/derived-default projection; it does not assign the campaign
        // character or restore a live counter. The authorized gate owns the acting identity.
        var ch = PlayResources.Ensure(campaign.ActingCharacter);
        if (toolContractVersion >= 21) ch = WearableEquipment.Project(campaign, ch);
        var catalog = BuildCatalog.Get();
        var mechanics = ch.BuildMechanics;
        var primary = catalog.Classes.Single(c => c.Name == ch.ClassName);
        var classes = ch.Advancement?.Classes.Select(c => new HarnessCharacterClass(c.ClassId,
            AdvancementCatalog.Get().Classes.Single(d => d.Id == c.ClassId).Name, c.Level, c.SubclassId)).ToArray()
            ?? [new(primary.Id, primary.Name, ch.Level, "")];
        var identity = ch.Build?.Identity;
        var abilities = ch.Abilities.Select(a => new Ability(a.Name, a.Score, RulesEngine.AbilityModifier(a.Score))).ToArray();
        var saves = abilities.Select(a => new BuildSaveValue(a.Name, RulesEngine.TestModifier(ch, a.Name, "", true),
            RulesEngine.SavingProficiencies(ch).Contains(a.Name))).ToArray();
        var skills = catalog.Skills.Select(s => new BuildSkillValue(s.Id, s.Name, BuildCatalog.AbilityName(s.Ability),
            RulesEngine.TestModifier(ch, BuildCatalog.AbilityName(s.Ability), s.Name, false),
            ch.Skills.Contains(s.Name), (ch.Expertise ?? []).Contains(s.Name))).ToArray();
        var selections = ch.Advancement?.Classes.Select(c => new HarnessCharacterSpellSelection("class:" + c.ClassId,
            c.Cantrips.ToArray(), c.PreparedSpells.ToArray(), c.Spellbook.ToArray())).ToArray()
            ?? [new("class:" + primary.Id, (ch.Build?.Cantrips ?? ch.Spellcasting?.Spells.Where(s => s.Level == 0).Select(s => s.Id).ToArray() ?? []).ToArray(),
                ch.PlayState!.PreparedSpells.ToArray(), (ch.Build?.Spellbook ?? []).ToArray())];
        var spellSources = CharacterPlayEngine.SpellSources(ch);
        var spells = (ch.Spellcasting?.Spells ?? []).Select(s => new HarnessCharacterSpell(s.Id, s.Name, s.Level,
            s.Prepared, s.CastingTime)).ToArray();
        var routes = spellSources.Select(s =>
        {
            // Preserve authoritative route-only qualifications (e.g. self-only invocation,
            // lowest-level mastery, feature trigger and ritual time) without duplicating the
            // entire rule reference for every source/slot. Rule lookup remains optional.
            string reference = ch.Advancement is null ? PlayCatalog.SpellDetails(s.SpellId)
                : AdvancementSheet.Details(AdvancementCatalog.Get().Spells.Single(p => p.Id == s.SpellId));
            string note = s.Details.StartsWith(reference, StringComparison.Ordinal) ? s.Details[reference.Length..].Trim() : s.Details;
            int level = ch.Advancement is null ? PlayCatalog.Spells.Single(p => p.Id == s.SpellId).Level
                : AdvancementCatalog.Get().Spells.Single(p => p.Id == s.SpellId).Level;
            int castLevel = Enumerable.Range(1, 9).FirstOrDefault(n =>
                s.Resource == AdvancementProjection.SlotName(n, false) || s.Resource == AdvancementProjection.SlotName(n, true), level);
            return new HarnessCharacterSpellRoute(s.Id, s.SpellId, s.Source, s.Ability, s.AttackBonus, s.SaveDc,
                s.Resource, s.Remaining, castLevel, s.Available, s.Reason, note);
        }).ToArray();
        var grants = (mechanics?.SpellGrants ?? []).Select(g =>
        {
            var pool = ch.Resources.FirstOrDefault(r => r.Name == PlayResources.FreeSpell(g));
            return new HarnessCharacterSpellGrant(g.Id, g.Source, BuildCatalog.AbilityName(g.Ability), g.Mode,
                pool?.Name ?? "", pool?.Maximum ?? g.FreeUses, pool?.Recovery ?? "", "");
        }).Concat((ch.Advancement?.Classes ?? []).SelectMany(c => (c.BonusSpells ?? []).Select(g =>
        {
            var pool = ch.Resources.FirstOrDefault(r => r.Name == AdvancementSheet.FreeSpell(g));
            return new HarnessCharacterSpellGrant(g.Id, g.Origin, g.Ability, g.Mode, pool?.Name ?? g.Resource,
                pool?.Maximum ?? g.Uses, pool?.Recovery ?? g.Recovery, g.Condition);
        }))).ToArray();
        return new(campaign.ActingActorId, ch.Id, ch.Name, ch.Species, ch.ClassName, ch.Background, ch.Level, classes,
            identity is null ? null : new(identity.Pronouns, identity.Appearance, identity.Personality, identity.Backstory, identity.Alignment),
            abilities, ch.ArmorClass, ch.ProficiencyBonus, ch.HitPoints, ch.MaxHitPoints, ch.TemporaryHitPoints,
            BuildRuntime.Speed(ch), mechanics?.Size ?? "", (mechanics?.InitiativeBonus ?? CharacterEngine.Ability(ch, "dexterity") + ch.ProficiencyBonus) - 2 * ch.Exhaustion,
            toolContractVersion >= 31 ? RulesEngine.PassivePerception(ch) : mechanics?.PassivePerception ?? 10 + skills.Single(s => s.Id == "perception").Modifier,
            saves, skills, ch.Conditions.ToArray(), ch.Exhaustion, ch.Features.ToArray(),
            ch.Resources.Select(r => new HarnessCharacterResource(r.Name, r.Current, r.Maximum, r.Recovery, r.Description)).ToArray(),
            ch.Inventory.Select(i => new Item(i.Id, i.Name, i.Quantity, i.Equipped, toolContractVersion >= 21 ? i.RulesId : null)).ToArray(),
            new(RulesEngine.SavingProficiencies(ch).ToArray(), PlayCatalog.ArmorTraining(ch).ToArray(),
                (mechanics?.WeaponTraining ?? primary.Weapons).ToArray(), (mechanics?.Tools ?? []).ToArray(),
                (mechanics?.Languages ?? []).ToArray(), ch.Skills.ToArray(), (ch.Expertise ?? []).ToArray()),
            (mechanics?.Feats ?? []).ToArray(), (mechanics?.Masteries ?? []).ToArray(), (mechanics?.Resistances ?? []).ToArray(),
            spells, selections, routes, grants, PlayCatalog.ActiveWeapon(ch)?.Id, toolContractVersion >= 20 ? EquipmentLoadout.View(ch, dropped: EquipmentLoadout.ActiveDrops(campaign)) with { Options = [] } : null,
            toolContractVersion >= 21 ? WearableEquipment.View(campaign) with { Options = [], AttunementOptions = [] } : null,
            toolContractVersion >= 21 ? ch.EquipmentStatus : null);
    }

    public static void Validate(HarnessCharacterContext self, ActingCharacterContext summary, int toolContractVersion = 19)
    {
        if ((toolContractVersion >= 21) != (self.Wearables is not null) || (toolContractVersion >= 21) != (self.EquipmentStatus is not null) ||
            toolContractVersion < 21 && (self.Inventory ?? []).Any(i => i.RulesId is not null)) throw new InvalidDataException("Invalid wearable version.");
        if (self.Wearables is { } wearables)
        {
            bool ValidItem(SheetWearableItem item)
            {
                if (item is null || item.ItemId is not { Length: > 0 } || WearableCatalog.For(new Item(item.ItemId, "", 1, item.Equipped, item.RulesId)) is not { } definition ||
                    item.RequiresAttunement != definition.RequiresAttunement || item.Label is null || item.Status is null || item.Notice is null ||
                    item.Effective && (!definition.Supported || !item.Equipped || item.RequiresAttunement && !item.Attuned)) return false;
                var carried = (self.Inventory ?? []).FirstOrDefault(i => i.Id == item.ItemId && i.Quantity > 0);
                if (carried is not null) return WearableCatalog.For(carried)?.RulesId == item.RulesId && carried.Equipped == item.Equipped;
                return definition.RequiresAttunement && item.Attuned && !item.Equipped && !item.Effective && item.Slot == definition.Slot &&
                    item.Status == "不在库存 · 仍同调";
            }
            if (wearables.AttunementLimit != 3 || wearables.AttunementUsed is < 0 or > 3 || wearables.Slots is null ||
                !wearables.Slots.Take(5).Select(s => s.Id).SequenceEqual(WearableEquipment.FixedSlots) ||
                wearables.Slots.Any(s => s is null || s.Id is null || s.Label is null || s.ItemId is null || s.OccupiedBy != "") ||
                wearables.Slots.Select(s => s.Id).Distinct(StringComparer.Ordinal).Count() != wearables.Slots.Length ||
                wearables.Items is null || wearables.Items.Any(i => !ValidItem(i)) ||
                wearables.Options is null || wearables.Options.Length != 0 || wearables.AttunementOptions is null || wearables.AttunementOptions.Length != 0 ||
                wearables.Notice is null) throw new InvalidDataException("Invalid wearable facts.");
        }
        if (self.EquipmentStatus is { } equipment && (string.IsNullOrEmpty(equipment.Armor) || equipment.Current is null || equipment.Reserve is null ||
            equipment.Issues is null || equipment.Issues.Any(i => i is null) || equipment.ArmorClassSources is null || equipment.ArmorClassSources.Any(s => s is null)))
            throw new InvalidDataException("Invalid equipment status.");
        if ((toolContractVersion >= 20) != (self.Loadout is not null)) throw new InvalidDataException("Invalid loadout version.");
        if (self.Loadout is { } loadout)
        {
            if (loadout.ActiveSet is not ("melee" or "ranged") || loadout.MeleeGrip is not ("one" or "two") || loadout.Slots is null || loadout.Slots.Length != 5 ||
                !loadout.Slots.Select(s => s.Id).SequenceEqual(new[] { "armor", "melee-main", "melee-off", "ranged-main", "ranged-off" }) ||
                loadout.Options is null || loadout.Options.Any(o => o is null || o.Key is null || o.Label is null || o.Reason is null || o.Seconds < 0) ||
                loadout.Slots.Any(s => s.ItemId is null || s.OccupiedBy is null || s.Label is null ||
                    s.Active && s.Id != "armor" && !s.Id.StartsWith(loadout.ActiveSet + "-", StringComparison.Ordinal) ||
                    s.Active && s.ItemId != "" && !(self.Inventory ?? []).Any(i => i.Id == s.ItemId && i.Quantity > 0 && i.Equipped) ||
                    s.OccupiedBy != "" && (s.ItemId != "" || !s.Id.EndsWith("-off", StringComparison.Ordinal) ||
                        !loadout.Slots.Any(main => main.Id == s.Id.Replace("-off", "-main", StringComparison.Ordinal) && main.ItemId == s.OccupiedBy))))
                throw new InvalidDataException("Invalid loadout facts.");
        }
        static bool Text(string? text) => text is not null;
        static bool Texts(string[]? values) => values is not null && values.All(Text);
        var abilityNames = BuildCatalog.Get().Abilities.Select(BuildCatalog.AbilityName).ToArray();
        if (self.ActorId is not { Length: > 0 } || !Guid.TryParseExact(self.Id, "D", out _) ||
            !Text(self.Name) || !Text(self.Species) || !Text(self.ClassName) || !Text(self.Background) || !Text(self.Size) ||
            summary.Name != IntentContexts.Bounded(self.Name, 80) || summary.Species != IntentContexts.Bounded(self.Species, 80) ||
            summary.ClassName != IntentContexts.Bounded(self.ClassName, 80) || summary.Background != IntentContexts.Bounded(self.Background, 100) ||
            summary.Level != self.Level || summary.HitPoints != self.HitPoints || summary.MaxHitPoints != self.MaxHitPoints ||
            self.Level is < 1 or > 20 || self.ProficiencyBonus < 1 || self.MaxHitPoints < 1 || self.HitPoints < 0 || self.HitPoints > self.MaxHitPoints ||
            self.TemporaryHitPoints < 0 || self.Speed < 0 || self.Exhaustion is < 0 or > 6 ||
            self.Classes is null || self.Classes.Length == 0 || self.Classes.Any(c => c is null || c.Id is not { Length: > 0 } || !Text(c.Name) || !Text(c.SubclassId) || c.Level < 1) ||
            self.Classes.Sum(c => c.Level) != self.Level || self.Classes.Select(c => c.Id).Distinct(StringComparer.Ordinal).Count() != self.Classes.Length ||
            self.Abilities is null || self.Abilities.Length != 6 || self.Abilities.Any(a => a is null || !abilityNames.Contains(a.Name) || a.Score is < 1 or > 30 || a.Modifier != RulesEngine.AbilityModifier(a.Score)) ||
            self.Abilities.Select(a => a.Name).Distinct(StringComparer.Ordinal).Count() != 6 ||
            self.SavingThrows is null || self.SavingThrows.Length != 6 || self.SavingThrows.Any(s => s is null || !abilityNames.Contains(s.Ability)) ||
            self.SavingThrows.Select(s => s.Ability).Distinct(StringComparer.Ordinal).Count() != 6 ||
            self.Skills is null || self.Skills.Length != BuildCatalog.Get().Skills.Length || self.Skills.Any(s => s is null || !Text(s.Id) || !Text(s.Name) || !abilityNames.Contains(s.Ability)) ||
            self.Skills.Select(s => s.Id).Distinct(StringComparer.Ordinal).Count() != self.Skills.Length ||
            !Texts(self.Conditions) || !Texts(self.Features) || !Texts(self.Feats) || !Texts(self.Masteries) || !Texts(self.Resistances) ||
            self.Identity is { } identity && (!Text(identity.Pronouns) || !Text(identity.Appearance) || !Text(identity.Personality) || !Text(identity.Backstory) || !Text(identity.Alignment)) ||
            self.Resources is null || self.Resources.Any(r => r is null || r.Name is not { Length: > 0 } || r.Current < 0 || r.Maximum < r.Current || !Text(r.Recovery) || !Text(r.Description)) ||
            self.Resources.Select(r => r.Name).Distinct(StringComparer.Ordinal).Count() != self.Resources.Length ||
            self.Inventory is null || self.Inventory.Any(i => i is null || i.Id is not { Length: > 0 } || !Text(i.Name) || i.Quantity < 0) ||
            self.Inventory.Select(i => i.Id).Distinct(StringComparer.Ordinal).Count() != self.Inventory.Length ||
            self.ActiveWeaponId is not null && !self.Inventory.Any(i => i.Id == self.ActiveWeaponId && i.Quantity > 0 && i.Equipped && PlayCatalog.Equipment(i.Id)?.WeaponCategory is { Length: > 0 }) ||
            self.Proficiencies is not { } p || !Texts(p.Saves) || !Texts(p.Armor) || !Texts(p.Weapons) || !Texts(p.Tools) || !Texts(p.Languages) || !Texts(p.Skills) || !Texts(p.Expertise) ||
            self.Spells is null || self.Spells.Any(s => s is null || s.Id is not { Length: > 0 } || !Text(s.Name) || s.Level is < 0 or > 9 || !Text(s.CastingTime)) ||
            self.Spells.Select(s => s.Id).Distinct(StringComparer.Ordinal).Count() != self.Spells.Length ||
            self.SpellSelections is null || self.SpellSelections.Any(s => s is null || s.Source is not { Length: > 0 } || !Texts(s.Cantrips) || !Texts(s.Prepared) || !Texts(s.Spellbook)) ||
            self.SpellRoutes is null || self.SpellRoutes.Any(s => s is null || s.Id is not { Length: > 0 } || s.SpellId is not { Length: > 0 } || s.Source is not { Length: > 0 } || !Text(s.Ability) || !Text(s.Resource) || !Text(s.Reason) || !Text(s.Note) || s.Remaining < -1 || s.CastLevel is < 0 or > 9) ||
            self.SpellRoutes.Select(s => s.Id).Distinct(StringComparer.Ordinal).Count() != self.SpellRoutes.Length ||
            self.SpellGrants is null || self.SpellGrants.Any(s => s is null || s.SpellId is not { Length: > 0 } || s.Source is not { Length: > 0 } || !Text(s.Ability) || !Text(s.Mode) || !Text(s.Resource) || s.FreeUses < 0 || !Text(s.Recovery) || !Text(s.Condition)))
            throw new InvalidDataException("Invalid acting-character facts.");
    }
}

public sealed record HarnessCharacterClass(string Id, string Name, int Level, string SubclassId);
public sealed record HarnessCharacterIdentity(string Pronouns, string Appearance, string Personality, string Backstory, string Alignment);
public sealed record HarnessCharacterResource(string Name, int Current, int Maximum, string Recovery, string Description);
public sealed record HarnessCharacterProficiencies(string[] Saves, string[] Armor, string[] Weapons, string[] Tools,
    string[] Languages, string[] Skills, string[] Expertise);
public sealed record HarnessCharacterSpell(string Id, string Name, int Level, bool Prepared, string CastingTime);
public sealed record HarnessCharacterSpellSelection(string Source, string[] Cantrips, string[] Prepared, string[] Spellbook);
public sealed record HarnessCharacterSpellRoute(string Id, string SpellId, string Source, string Ability, int AttackBonus, int SaveDc,
    string Resource, int Remaining, int CastLevel, bool Available, string Reason, string Note);
public sealed record HarnessCharacterSpellGrant(string SpellId, string Source, string Ability, string Mode, string Resource,
    int FreeUses, string Recovery, string Condition);
