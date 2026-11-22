namespace DiceRealm.Server.Domain;

// Prevent expanded acquisition options from silently inheriting preset-only automation.
// The build remains the acquisition record; inventory/effects are the current runtime state.
public sealed record ArmorClassCalculation(int Value, string[] Sources);
public static class BuildRuntime
{
    internal static BuildEquipment[] Equipped(Character c) => BuildCatalog.Get().Equipment.Where(e =>
        c.Inventory.Any(i => i.Id == BuildCatalog.ItemId(e.Id) && i.Equipped && i.Quantity > 0) && (e.Kind != "S" || EquipmentLoadout.Shield(c))).ToArray();
    public static bool Armored(Character c) => Equipped(c).Any(e => e.Kind is "LA" or "MA" or "HA");
    public static bool StealthDisadvantage(Character c) => Equipped(c).Any(e => e.StealthDisadvantage);
    public static int HitDie(Character c) => c.BuildMechanics?.HitDie ?? (c.ClassName == "Wizard" ? 6 : 10);
    public static int ArmorClass(Character c, bool mageArmor) => ArmorClassCalculation(c, mageArmor).Value;
    public static ArmorClassCalculation ArmorClassCalculation(Character c, bool mageArmor)
    {
        if (c.Advancement is not null) return AdvancementProjection.ArmorClassCalculation(c, mageArmor);
        int dex = CharacterEngine.Ability(c,"dexterity");
        var basis = BuildEvaluator.ArmorClassCalculation(c.Build?.ClassId??c.ClassName.ToLowerInvariant(),dex,CharacterEngine.Ability(c,"constitution"),CharacterEngine.Ability(c,"wisdom"),
            c.BuildMechanics?.Feats.Contains("defense") == true,Equipped(c),mageArmor);
        return WearableEquipment.ArmorClass(c, basis);
    }
    public static int Speed(Character c) => c.Advancement is null ? BaseSpeed(c) : AdvancementProjection.Speed(c);
    internal static int BaseSpeed(Character c)
    {
        var data = BuildCatalog.Get(); var species = data.Species.Single(s => c.Build is null?s.Name==c.Species:s.Id == c.Build.SpeciesId);
        int speed = species.Speed;
        if (species.Id == "elf" && c.Build?.Selections.Any(s => s.Key == "species:elf/lineage" && s.Values.Contains("wood-elf"))==true) speed = 35;
        if (Equipped(c).Any(e => e.Kind == "HA" && e.Strength > c.Abilities.Single(a => a.Name == "strength").Score)) speed -= 10;
        return speed;
    }
    public static bool CanAutomateCombat(Character c)
    {
        if (EquipmentLoadout.Held(c).Count(h => PlayCatalog.Equipment(h.Item.Id)?.WeaponCategory is { Length: > 0 }) > 1) return false;
        if (c.TemporaryHitPoints>0 || c.Exhaustion>0 || c.Conditions.Any(x=>x is not ("Prone" or "Unconscious"))) return false;
        var used = Equipped(c).Where(e => e.WeaponCategory == "" || BuildCatalog.ItemId(e.Id) == PlayCatalog.ActiveWeapon(c)?.Id).ToArray();
        if (c.Build is null) return used.Where(e=>e.WeaponCategory!=""||e.Kind is "LA" or "MA" or "HA" or "S")
            .All(e=>e.Id=="chain-mail"||CharacterEngine.WeaponIds.Contains(e.Id));
        if (c.BuildMechanics?.AutomatedCombat != true || Speed(c) != 30) return false;
        return used.All(e => e.WeaponCategory == "" ? e.Id == "chain-mail" : CharacterEngine.WeaponIds.Contains(e.Id)
            && (e.WeaponCategory == "simple" || c.BuildMechanics.WeaponTraining.Contains(e.WeaponCategory))
            && (e.Id != "greatsword" || c.Abilities.Single(a => a.Name == "strength").Score >= 13));
    }
    public static bool PartyCanAutomateCombat(Campaign c) => PartyEngine.Characters(c).Where(p => !GameLifecycle.Dead(c, p.Id)).All(p => CanAutomateCombat(p.Character));
    public static bool CanPrepareWeapon(Character c, string id)
    {
        if (c.Build is null) return true;
        var item = BuildCatalog.Get().Equipment.SingleOrDefault(e => BuildCatalog.ItemId(e.Id) == id);
        return item is not null && (item.WeaponCategory == "simple" || c.BuildMechanics?.WeaponTraining.Contains(item.WeaponCategory) == true)
            && PlayCatalog.EquipmentBlock(c, item, true) == "";
    }
    public static bool CanToggleChain(Character c) => c.Build is null || c.BuildMechanics?.ArmorTraining.Contains("heavy") == true
        && !Equipped(c).Any(e => e.Kind is "LA" or "MA" or "HA" && e.Id != "chain-mail");
    public static int ExtraSkillBonus(Character c, string skill, string ability = "")
    {
        if (c.Build is null) return 0;
        if (c.Advancement is not null) return AdvancementProjection.CheckBonus(c, skill, ability);
        bool cleric = c.Build.ClassId == "cleric" && skill is "Arcana" or "Religion";
        bool druid = c.Build.ClassId == "druid" && skill is "Arcana" or "Nature";
        return (cleric || druid) && c.Build.Selections.Any(s => s.Key == "class:" + c.Build.ClassId + "/order" && s.Values.Any(v => v is "thaumaturge" or "magician"))
            ? Math.Max(1,CharacterEngine.Ability(c,"wisdom")) : 0;
    }
}
