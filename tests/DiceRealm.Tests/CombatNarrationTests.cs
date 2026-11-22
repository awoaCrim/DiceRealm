using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Tests;

internal static class CombatNarrationTests
{
    private static Campaign Narrated(string tactic = "engage", int hp = 100, int damageBonus = 1)
    {
        var c = StandardCombatTests.Campaign(tactic, hp, damageBonus: damageBonus);
        c.Character = c.Character.Required() with { MaxHitPoints = hp };
        c.CombatAgentSessions = [new()
        {
            Id = Guid.NewGuid().ToString(), SceneId = c.SceneId,
            EncounterId = c.Adventure!.Scenes.Single(s => s.Id == "causeway").Encounter!.Id,
            ParentActorId = c.ActingActorId, ParentRunId = Guid.NewGuid().ToString(), ParentIntentId = Guid.NewGuid().ToString(),
            ParentCredentialHash = new string('a', 64), Profile = new(HarnessTests.Preset, new string('b', 64), []),
            ToolContractVersion = 49, Handoff = new("守住位置", "对方进攻", []), StartedVersion = c.Version, Members = [c.ActingActorId]
        }];
        return c;
    }

    private static Campaign Reopen(Campaign c)
    {
        StandardCombatEngine.ValidateState(c);
        var reopened = JsonSerializer.Deserialize<Campaign>(JsonSerializer.Serialize(c, JsonFiles.Options), JsonFiles.Options)!;
        StandardCombatEngine.ValidateState(reopened);
        return reopened;
    }

    public static Task EachUnitWaitsForNarrationAndRestart()
    {
        var c = Narrated();
        c.Adventure = c.Adventure! with { Scenes = c.Adventure.Scenes.Select(s => s.Id != "causeway" ? s : s with
        {
            Encounter = s.Encounter! with { Enemies = Enumerable.Range(0, 3).Select(i =>
                new ContentEnemy("foe" + i, "敌人" + i, 2 + i / 3, 1 + i % 3, 50, 12, 20, AttackBonus: 3, DamageBonus: 1, Tactic: "engage")).ToArray() }
        }).ToArray() };
        ContentValidator.Validate(c.Adventure);
        var dice = new SequenceDice(20, 1, 1, 1, 15, 2, 15, 2, 15, 2);
        var engine = new CombatEngine(dice);
        engine.Resolve(c, "combat.start", "");
        Check.Equal(4, dice.Count); Check.True(StandardCombatEngine.NarrationPending(c));
        Check.Equal(0, StandardCombatEngine.Choices(c).Length);
        Check.Throws<GameException>(() => engine.ContinueNarrated(c));
        StandardCombatEngine.AcknowledgeNarration(c);
        engine.Resolve(c, "combat.end_turn", "");
        Check.Equal(4, dice.Count); Check.Equal("player", c.Combat!.ActiveActorId);
        for (int i = 0; i < 3; i++)
        {
            Check.True(StandardCombatEngine.NarrationPending(c));
            string before = JsonSerializer.Serialize(c, JsonFiles.Options); int count = dice.Count;
            Check.Throws<GameException>(() => engine.ContinueNarrated(c));
            Check.Throws<GameException>(() => engine.Resolve(c, "combat.end_turn", ""));
            Check.Equal(before, JsonSerializer.Serialize(c, JsonFiles.Options)); Check.Equal(count, dice.Count);
            c = Reopen(c);
            StandardCombatEngine.AcknowledgeNarration(c);
            Check.True(StandardCombatEngine.CanContinueNarrated(c));
            engine.ContinueNarrated(c);
            Check.Equal("foe" + i, c.Combat!.ActiveActorId);
            Check.Equal(6 + i * 2, dice.Count);
            Check.Equal(100 - (i + 1) * 3, c.Character.Required().HitPoints);
        }
        StandardCombatEngine.AcknowledgeNarration(c); engine.ContinueNarrated(c);
        Check.Equal("player", c.Combat!.ActiveActorId); Check.Equal(10, dice.Count);
        Check.True(StandardCombatEngine.NarrationPending(c));
        StandardCombatEngine.AcknowledgeNarration(c);
        Check.True(!StandardCombatEngine.CanContinueNarrated(c));
        Check.True(StandardCombatEngine.Choices(c).Any(a => a.Kind == "combat.end_turn"));
        Reopen(c);
        return Task.CompletedTask;
    }

    public static Task IdleTurnsKeepAuditAndDeathWait()
    {
        var c = Narrated(hp: 1, damageBonus: 8); c.Character = c.Character.Required() with { MaxHitPoints = 12 };
        c.Adventure = c.Adventure! with { Scenes = c.Adventure.Scenes.Select(s => s.Id != "causeway" ? s : s with
        { Encounter = s.Encounter! with { Enemies = Enumerable.Range(0, 3).Select(i =>
            new ContentEnemy("foe" + i, "敌人" + i, 2, 1 + i, 50, 12, 20, AttackBonus: 3, DamageBonus: 8, Tactic: "engage")).ToArray() } }).ToArray() };
        var dice = new SequenceDice(20, 1, 1, 1, 15, 4, 10); var engine = new CombatEngine(dice);
        engine.Resolve(c, "combat.start", ""); StandardCombatEngine.AcknowledgeNarration(c);
        engine.Resolve(c, "combat.end_turn", ""); StandardCombatEngine.AcknowledgeNarration(c);
        engine.ContinueNarrated(c, coalesceIdleTurns: true);
        Check.Equal(0, c.Character.Required().HitPoints); Check.Equal(6, dice.Count);
        Check.Equal("foe0", c.Combat!.ActiveActorId); Check.True(StandardCombatEngine.NarrationPending(c));
        Check.True(c.Combat.Standard!.Wait is null, "A real damaging attack still stops before the next unit");
        c = Reopen(c); StandardCombatEngine.AcknowledgeNarration(c);
        engine.ContinueNarrated(c, coalesceIdleTurns: true);
        Check.Equal("death", c.Combat!.Standard!.Wait!.Kind); Check.Equal(2, c.Combat.Round); Check.Equal(6, dice.Count);
        Check.Throws<GameException>(() => engine.ContinueNarrated(c, coalesceIdleTurns: true));
        StandardCombatEngine.AcknowledgeNarration(c);
        engine.Resolve(c, "combat.death_save", ""); Check.Equal(7, dice.Count);
        Check.Equal(1, StandardCombatTests.P(c).Standard!.DeathSuccesses);
        c = Reopen(c); StandardCombatEngine.AcknowledgeNarration(c);
        var legacy = Reopen(c);
        engine.ContinueNarrated(legacy);
        Check.Equal("foe0", legacy.Combat!.ActiveActorId); Check.True(legacy.Combat.Standard!.Wait is null);
        Check.True(StandardCombatEngine.NarrationPending(legacy));
        int through = c.Combat!.LogSequence; long elapsed = c.ElapsedSeconds;
        engine.ContinueNarrated(c, coalesceIdleTurns: true);
        Check.Equal(7, dice.Count); Check.Equal(3, c.Combat!.Round); Check.Equal(elapsed + 6, c.ElapsedSeconds);
        Check.Equal("death", c.Combat.Standard!.Wait!.Kind); Check.Equal("player", c.Combat.ActiveActorId);
        Check.True(c.Combat.Log.Where(e => e.Sequence > through).Select(e => e.Kind).SequenceEqual(new[] { "turn", "turn", "turn", "turn", "death_wait" }));
        Check.Equal(1, c.Combat.Log.Count(e => e.Kind == "combat.end_turn"));
        Check.True(StandardCombatEngine.NarrationPending(c));
        Reopen(c);
        return Task.CompletedTask;
    }

    public static Task ShieldConcentrationAndPrivateAudience()
    {
        var c = StandardSpellTests.Fixture(); var dice = new SequenceDice(20, 1, 11); var engine = new CombatEngine(dice);
        engine.Resolve(c, "combat.start", ""); StandardCombatEngine.EnableNarration(c);
        engine.Resolve(c, "combat.move", "0,2");
        Check.Equal("shield", c.Combat!.Standard!.Wait!.Kind); Check.Equal(3, dice.Count);
        Check.True(StandardCombatEngine.NarrationPending(c));
        c = Reopen(c); StandardCombatEngine.AcknowledgeNarration(c);
        var shield = StandardSpellTests.Spell(c, "Shield", "combat.react"); engine.Resolve(c, shield.Kind, shield.Target);
        Check.Equal(3, dice.Count); Check.Equal(0, StandardCombatTests.P(c).X); Reopen(c);

        c = StandardSpellTests.Fixture(); dice = new(20, 1, 11, 2, 10); engine = new(dice);
        engine.Resolve(c, "combat.start", ""); StandardCombatEngine.EnableNarration(c);
        var spell = StandardSpellTests.Spell(c, "Expeditious Retreat"); engine.Resolve(c, spell.Kind, spell.Target);
        StandardCombatEngine.AcknowledgeNarration(c); engine.Resolve(c, "combat.move", "0,2");
        Check.Equal("concentration", c.Combat!.Standard!.Wait!.Kind); Check.Equal(4, dice.Count);
        c = Reopen(c); StandardCombatEngine.AcknowledgeNarration(c);
        engine.Resolve(c, "combat.concentration_save", "");
        Check.Equal(5, dice.Count); Check.Equal(0, StandardCombatTests.P(c).X); Reopen(c);

        c.Combat!.Log = [new(1, 1, "move", "player", "PUBLIC"),
            new(2, 1, "move", "player", "OWN_ONLY", Audience: ["player"]),
            new(3, 1, "move", "other", "OTHER_SECRET", Audience: ["other"])];
        c.Combat.LogSequence = 3; c.StandardCombatFlow!.NarratedThrough = 0;
        var projection = (HarnessCombatNarration)typeof(GameService).GetMethod("CombatNarration",
            System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic)!.Invoke(null, [c])!;
        Check.Equal(2, projection.Records.Length);
        Check.Equal("public", projection.Records[0].Audience); Check.Equal("actor", projection.Records[1].Audience);
        Check.True(!HarnessJson.Serialize(projection).Contains("OTHER_SECRET"));
        return Task.CompletedTask;
    }

    public static Task ReactionsDeathAndLegacy()
    {
        var c = Narrated("withdraw"); var dice = new SequenceDice(20, 1, 1); var engine = new CombatEngine(dice);
        engine.Resolve(c, "combat.start", ""); StandardCombatEngine.AcknowledgeNarration(c);
        engine.Resolve(c, "combat.end_turn", ""); StandardCombatEngine.AcknowledgeNarration(c); engine.ContinueNarrated(c, coalesceIdleTurns: true);
        Check.Equal("opportunity", c.Combat!.Standard!.Wait!.Kind); Check.Equal(2, dice.Count);
        Check.True(!StandardCombatEngine.CanContinueNarrated(c));
        c = Reopen(c); StandardCombatEngine.AcknowledgeNarration(c);
        Check.True(StandardCombatEngine.Choices(c).Any(a => a.Kind == "combat.react"));
        engine.Resolve(c, "combat.react", "attack");
        Check.Equal(3, dice.Count); Check.True(StandardCombatEngine.NarrationPending(c));
        StandardCombatEngine.AcknowledgeNarration(c); engine.ContinueNarrated(c);
        Check.Equal("victory", c.Combat!.Status); Check.True(StandardCombatEngine.NarrationPending(c));
        Reopen(c); StandardCombatEngine.AcknowledgeNarration(c);
        Check.True(!StandardCombatEngine.CanContinueNarrated(c));

        var fallen = Narrated(hp: 1); fallen.Character = fallen.Character.Required() with { MaxHitPoints = 12 };
        var deathDice = new SequenceDice(20, 1, 15, 4, 20); var death = new CombatEngine(deathDice);
        death.Resolve(fallen, "combat.start", ""); StandardCombatEngine.AcknowledgeNarration(fallen);
        death.Resolve(fallen, "combat.end_turn", ""); StandardCombatEngine.AcknowledgeNarration(fallen); death.ContinueNarrated(fallen);
        Check.Equal(0, fallen.Character.Required().HitPoints); Check.Equal(4, deathDice.Count);
        Check.True(fallen.Combat!.Standard!.Wait is null); // next unit has not begun
        fallen = Reopen(fallen); StandardCombatEngine.AcknowledgeNarration(fallen); death.ContinueNarrated(fallen);
        Check.Equal("death", fallen.Combat!.Standard!.Wait!.Kind); Check.Equal(4, deathDice.Count);
        StandardCombatEngine.AcknowledgeNarration(fallen); death.Resolve(fallen, "combat.death_save", "");
        Check.Equal(1, fallen.Character.Required().HitPoints); Check.Equal(5, deathDice.Count); Reopen(fallen);

        var old = StandardCombatTests.Campaign(); var legacy = new CombatEngine(new SequenceDice(20, 1, 15, 4));
        legacy.Resolve(old, "combat.start", ""); legacy.Resolve(old, "combat.end_turn", "");
        Check.True(old.StandardCombatFlow!.NarratedThrough is null);
        Check.Equal("player", old.Combat!.ActiveActorId);
        Check.True(!JsonSerializer.Serialize(old, JsonFiles.Options).Contains("narratedThrough"));
        StandardCombatEngine.EnableNarration(old); Check.True(!StandardCombatEngine.NarrationPending(old));
        legacy.Resolve(old, "combat.end_turn", ""); Check.True(StandardCombatEngine.NarrationPending(old));
        return Task.CompletedTask;
    }
}
