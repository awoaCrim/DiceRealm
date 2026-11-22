using System.Text.Json;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Tests;

internal static class CombatPresentationTests
{
    public static Task CapturesSettledMomentsWithoutChangingDiceOrWaits()
    {
        var c = StandardCombatTests.Campaign(hp: 6);
        var dice = new SequenceDice(20, 1, 15, 4);
        var engine = new CombatEngine(dice);
        engine.Resolve(c, "combat.start", "");
        var initial = c.Combat!.Log.Single(e => e.Kind == "initiative" && e.ActorId == "player").Presentation!;
        Check.Equal(c.Combat.Id, initial.CombatId);
        Check.Equal(6, initial.Units.Single().HitPoints);
        engine.Resolve(c, "combat.end_turn", "");
        Check.Equal(4, dice.Count);
        var attack = c.Combat.Log.Single(e => e.Kind == "attack").Presentation!;
        var damage = c.Combat.Log.Single(e => e.Kind == "damage").Presentation!;
        Check.Equal(6, attack.Units.Single(u => u.Id == "player").HitPoints);
        Check.Equal(1, damage.Units.Single(u => u.Id == "player").HitPoints);
        Check.True(attack.Text.Contains("命中") && damage.Text.Contains("5点伤害"));
        Check.True(c.Combat.Log.All(e => e.Presentation!.Units.Length <= 2));
        Check.True(c.Combat.Log.All(e => !e.Presentation!.Text.Contains("AC") && !e.Presentation.Text.Contains("HP")));
        var reopened = JsonSerializer.Deserialize<Campaign>(JsonSerializer.Serialize(c, JsonFiles.Options), JsonFiles.Options)!;
        Check.Equal(6, reopened.Combat!.Log.Single(e => e.Kind == "attack").Presentation!.Units.Single(u => u.Id == "player").HitPoints);
        var projection = CombatVisibility.Project(c, true)!;
        projection.Log.Single(e => e.Kind == "attack").Presentation!.Units[0] = new("tampered", 0, 0, 0, 0, [], false, false, false);
        Check.True(c.Combat.Log.Single(e => e.Kind == "attack").Presentation!.Units.All(u => u.Id != "tampered"));
        var dying = StandardCombatTests.Campaign(hp: 1);
        var deathDice = new SequenceDice(20, 1, 15, 4);
        var lethal = new CombatEngine(deathDice);
        lethal.Resolve(dying, "combat.start", ""); lethal.Resolve(dying, "combat.end_turn", "");
        Check.Equal("death", dying.Combat!.Standard!.Wait!.Kind); Check.Equal(4, deathDice.Count);
        Check.True(dying.Combat.Log.Last(e => e.Kind == "damage").Presentation!.Units.Single().Conditions.Contains("Unconscious"));
        Check.Equal(0, StandardCombatTests.P(dying).Standard!.DeathFailures);
        return Task.CompletedTask;
    }
    public static Task FrozenAudienceDeepCopyAndOldNull()
    {
        var c = StandardCombatTests.Campaign();
        var old = new CombatEntry(1, 1, "turn", "player", "旧记录");
        Check.True(!JsonSerializer.Serialize(old, JsonFiles.Options).Contains("presentation"));
        Check.True(JsonSerializer.Deserialize<CombatEntry>(JsonSerializer.Serialize(old, JsonFiles.Options), JsonFiles.Options)!.Presentation is null);
        var moment = new CombatUnitMoment("secret", 2, 3, 4, 0, ["Prone"], false, false, false);
        var privateEntry = new CombatEntry(2, 1, "turn", "secret", "私有记录", Audience: ["observer"],
            Presentation: new("battle", "私有动作", "secret", [moment]));
        Check.Equal(0, CombatVisibility.ProjectLog(c, [privateEntry], true).Length);
        c.ActingActorId = "observer";
        var visible = CombatVisibility.ProjectLog(c, [privateEntry], true).Single();
        Check.True(visible.Audience is null);
        visible.Presentation!.Units[0].Conditions[0] = "changed";
        Check.Equal("Prone", privateEntry.Presentation!.Units[0].Conditions[0]);
        c.ActingActorId = "another";
        Check.Equal(0, CombatVisibility.ProjectLog(c, [privateEntry], true).Length);
        return Task.CompletedTask;
    }
}
