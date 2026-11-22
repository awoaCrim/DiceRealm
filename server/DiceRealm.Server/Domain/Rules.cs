using System.Security.Cryptography;

namespace DiceRealm.Server.Domain;

public interface IDice { int Roll(int sides); }
public sealed class ServerDice : IDice
{
    public int Roll(int sides) => RandomNumberGenerator.GetInt32(1, checked(sides + 1));
}

public sealed class RulesEngine(IDice dice)
{
    public static int AbilityModifier(int score) => (int)Math.Floor((score - 10) / 2d);
    public int[] RollDice(int count, int sides)
    {
        if (count is < 1 or > 100 || sides is not (4 or 6 or 8 or 10 or 12 or 20)) throw new ArgumentOutOfRangeException(nameof(count));
        var result = Enumerable.Range(0, count).Select(_ => dice.Roll(sides)).ToArray();
        if (result.Any(n => n < 1 || n > sides)) throw new InvalidOperationException("Invalid dice source.");
        return result;
    }

    public static string[] SavingProficiencies(Character c) => c.BuildMechanics?.Saves ??
        BuildCatalog.Get().Classes.FirstOrDefault(x => x.Name == c.ClassName)?.Saves.Select(BuildCatalog.AbilityName).ToArray() ?? [];
    public static int TestModifier(Character c, string ability, string skill, bool savingThrow) => CharacterEngine.Ability(c,ability)
        + (savingThrow ? (SavingProficiencies(c).Contains(ability) ? c.ProficiencyBonus : 0)
            : (c.Skills.Contains(skill) ? c.ProficiencyBonus : 0) + ((c.Expertise ?? []).Contains(skill) ? c.ProficiencyBonus : 0) + BuildRuntime.ExtraSkillBonus(c,skill,ability))
        + (savingThrow ? WearableEquipment.SaveBonus(c) : WearableEquipment.SkillBonus(c, ability, skill)) - 2*c.Exhaustion;
    public static bool AutomaticSaveFailure(Character c, string ability) =>
        ability is "strength" or "dexterity" && c.Conditions.Any(x => x is "Unconscious" or "Stunned" or "Paralyzed" or "Petrified");

    // XPHB p.372: current check bonus plus 10, +/-5 for effective advantage/disadvantage.
    // This is a score, never a rolled d20 or an automatic discovery.
    public static int PassivePerception(Character c, string mode = "normal")
    {
        bool advantage = mode == "advantage" || WearableEquipment.Advantage(c, "wisdom", "Perception");
        bool disadvantage = mode == "disadvantage" || c.Conditions.Contains("Poisoned");
        return 10 + TestModifier(c, "wisdom", "Perception", false) + (advantage == disadvantage ? 0 : advantage ? 5 : -5);
    }

    // Shared read-only mode projection for consent preview and the actual sheet test.
    public static string SheetTestMode(Character c, string ability, string skill, bool savingThrow, string mode)
    {
        if (savingThrow && AutomaticSaveFailure(c, ability)) return "automatic-failure";
        bool advantage = mode == "advantage", disadvantage = mode == "disadvantage";
        if (!savingThrow)
        {
            advantage |= WearableEquipment.Advantage(c, ability, skill);
            disadvantage |= c.Conditions.Contains("Poisoned") || skill == "Stealth" && BuildRuntime.StealthDisadvantage(c);
        }
        return advantage == disadvantage ? "normal" : advantage ? "advantage" : "disadvantage";
    }

    public DiceCheck SheetTest(Character c, SheetCheckOption option, string mode)
    {
        int modifier=TestModifier(c,option.Ability,option.Skill,option.SavingThrow);
        string effective = SheetTestMode(c, option.Ability, option.Skill, option.SavingThrow, mode);
        if(effective == "automatic-failure")
            return new(option.Ability,"",[],0,modifier,0,0,false,"automatic-failure",HasDc:false,TestKind:"save");
        int[] rolls=effective=="normal"?[dice.Roll(20)]:[dice.Roll(20),dice.Roll(20)];
        if(rolls.Any(x=>x is <1 or >20))throw new InvalidOperationException("Invalid dice source.");
        int selected=effective=="advantage"?rolls.Max():effective=="disadvantage"?rolls.Min():rolls[0];
        return new(option.Ability,option.Skill,rolls,selected,modifier,selected+modifier,0,false,effective,HasDc:false,TestKind:option.SavingThrow?"save":"ability");
    }

    public DiceCheck AbilityCheck(Character character, string ability, string skill, int dc,
        bool advantage = false, bool disadvantage = false)
    {
        var modifier = TestModifier(character, ability, skill, false);
        advantage |= WearableEquipment.Advantage(character, ability, skill);
        // Any amount of both advantage and disadvantage cancels. No stacking.
        disadvantage |= ability == "dexterity" && skill == "Stealth" && BuildRuntime.StealthDisadvantage(character);
        var mode = advantage == disadvantage ? "normal" : advantage ? "advantage" : "disadvantage";
        var rolls = mode == "normal" ? new[] { dice.Roll(20) } : new[] { dice.Roll(20), dice.Roll(20) };
        if (rolls.Any(r => r is < 1 or > 20)) throw new InvalidOperationException("Invalid dice source.");
        var selected = mode switch
        {
            "advantage" => rolls.Max(), "disadvantage" => rolls.Min(), _ => rolls[0]
        };
        // Ability checks do not use attack-roll critical success/failure rules.
        return new(ability, skill, rolls, selected, modifier, selected + modifier, dc,
            selected + modifier >= dc, mode);
    }
}

public static class StarterCharacter
{
    // Additive upgrade is limited to the only historical preset, which previously had no rest commands.
    public static Character Upgrade(Character c)
    {
        if (c.TemplateId != "human-fighter-soldier-2024" || c.Creation is not null) return c;
        var current = Create(c.Name);
        var resources = c.Resources.ToList();
        if (!resources.Any(r => r.Name == "Hit Dice (d10)")) resources.Add(new("Hit Dice (d10)", c.Level, c.Level));
        if (!resources.Any(r => r.Name == "Heroic Inspiration")) resources.Add(new("Heroic Inspiration", 0, 1));
        return c with { Features = c.Level == 1 ? current.Features : c.Features, Resources = resources.ToArray(), Effects = c.Effects ?? [] };
    }
    public static Character Create(string name)
    {
        int[] scores = [17, 13, 15, 10, 12, 8];
        string[] names = ["strength", "dexterity", "constitution", "intelligence", "wisdom", "charisma"];
        return new(Guid.NewGuid().ToString(), name, "human-fighter-soldier-2024", "Human", "Fighter",
            "Soldier", 1, 12, 12, 16, 2,
            names.Select((n, i) => new Ability(n, scores[i], RulesEngine.AbilityModifier(scores[i]))).ToArray(),
            ["Athletics", "Intimidation", "Perception", "Survival", "Investigation"],
            [new("greatsword", "Greatsword", 1, true), new("chain-mail", "Chain Mail", 1, true),
             new("flail", "Flail", 1, false), new("javelin", "Javelin", 8, false),
             new("dungeoneers-pack", "Dungeoneer's Pack", 1, false),
             new("gold-piece", "Gold Piece", 54, false)],
            [], ["Resourceful: Heroic Inspiration after Long Rest (reroll needs adjudication)", "Skillful: Investigation", "Versatile: Alert (+2 initiative; solo, no swap)",
                "Savage Attacker (Greatsword: better weapon dice set once per turn)", "Great Weapon Fighting (Greatsword: damage dice 1/2 treated as 3)",
                "Weapon Mastery: Greatsword (Graze); Flail/Javelin not automated",
                "Gaming Set proficiency: Dice Set", "Languages: Common, Dwarvish, Elvish",
                "Size: Medium; speed: 30 ft", "Saving throw proficiencies: Strength, Constitution"],
            [new("Second Wind", 2, 2), new("Hit Dice (d10)", 1, 1), new("Heroic Inspiration", 0, 1)], "XPHB", Effects: []);
    }
}
