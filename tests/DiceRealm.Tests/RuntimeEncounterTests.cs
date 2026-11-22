using System.Text.Json;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Tests;

internal static class RuntimeEncounterTests
{
    private static MapAssetView Map() => new(Guid.NewGuid().ToString(), "公开示意图", "scene", "player", 3, "ready", true,
        768, 512, 768, 512, new() { Type = "none", Uncalibrated = true }, "", "fixture-image-hash", "", 0, default, CurrentScene: true);
    private static Campaign Campaign(MapAssetView map, Character? character = null)
    {
        var c = TestContent.Campaign("causeway");
        if (character is not null) { c.Character = character; CharacterEngine.Sync(c); }
        c.Adventure = c.Adventure! with { Scenes = c.Adventure.Scenes.Select(s => s with { Encounter = null }).ToArray() };
        SharedBoard.Execute(c, map, new("prepare-self", c.Version, map.Id, "spawn", Spawns:
            [new("", "creature", new("player", c.ActingActorId), new("self"), .125, .3125, c.ActingActorId)], ExpectedMapVersion: map.Version));
        c.Version++;
        return c;
    }
    private static RuntimeEncounter Setup(Campaign c, MapAssetView map, EncounterPlacement[]? enemies = null) =>
        RuntimeEncounters.Prepare(c, map, new() { Type = "square", CellPixels = 64, Distance = 5, Units = "feet" },
            "隔离战术测试", c.SceneId, "测试引用（并非正式作者资料）", "测试DM明确采用每格5尺的战术尺度，不改变原图比例声明。",
            enemies ?? [new("xmm:skeleton", "测试敌人", "engage", new(.375, .3125))]);

    public static Task ImmutableSourceAndTacticalMap()
    {
        var map = Map(); var c = Campaign(map);
        string original = JsonSerializer.Serialize(c.Adventure, JsonFiles.Options);
        string board = JsonSerializer.Serialize(c.Board, JsonFiles.Options);
        string legacy = JsonSerializer.Serialize(c, JsonFiles.Options);
        Check.True(!legacy.Contains("\"runtimeEncounters\""));
        var setup = Setup(c, map);
        Check.Equal(original, JsonSerializer.Serialize(c.Adventure, JsonFiles.Options));
        Check.Equal(board, JsonSerializer.Serialize(c.Board, JsonFiles.Options));
        Check.True(c.RuntimeEncounters is null && c.Combat is null); // pure preparation, not a hidden write
        var enemy = setup.Definition.Enemies.Single();
        Check.Equal(13, enemy.HitPoints); Check.Equal(14, enemy.ArmorClass);
        var point = new BoardPoint(.375, .3125);
        setup = RuntimeEncounters.Establish(c, map, setup, [new("xmm:skeleton", "测试敌人", "engage", point)], new RulesEngine(new SequenceDice()));
        c.Version++;
        RuntimeEncounters.ValidateState(c);
        Check.True(ContentRuntime.AvailableEncounter(c) is null); // preparation is not hostile engagement
        Check.Equal(setup.Definition.Id, CombatAgentSessions.DelegatableEncounter(c)!.Id); // delegation precedes engagement
        c.RuntimeEncounters![0] = setup with { EngagementReason = "测试明确交锋" };
        Check.Equal(setup.Definition.Id, ContentRuntime.AvailableEncounter(c)!.Id);
        Check.Equal(2, c.Board!.Entities.Count);
        var projected = SharedBoard.Project(c, map, publicOnly: true);
        Check.True(projected.Map.Title.Contains("非原图比例")); Check.Equal("square", projected.Map.Grid.Type);
        Check.True(map.Grid.Uncalibrated && map.Grid.Type == "none");
        Check.Equal(.125, projected.Tokens.Single(t => t.ActorId == c.ActingActorId).X);
        var preparation = BoardCombat.Prepare(c, setup.Definition, map)!;
        Check.Equal(12, preparation.Layout.Width); Check.Equal(8, preparation.Layout.Height);
        Check.Equal(c.Board.Entities.Single(e => e.Source.Kind == "enemy").Id, preparation.Units.Single(u => u.Team == "enemy").Id);
        var restored = JsonSerializer.Deserialize<Campaign>(JsonSerializer.Serialize(c, JsonFiles.Options), JsonFiles.Options)!;
        RuntimeEncounters.ValidateState(restored); SharedBoard.ValidateState(restored);
        Check.Equal(setup.Definition.Id, ContentRuntime.FindEncounter(restored, setup.Definition.Id)!.Id);
        Check.Equal(original, JsonSerializer.Serialize(restored.Adventure, JsonFiles.Options));
        Check.Equal(point.X, SharedBoard.Project(restored, map, true).Tokens.Single(t => t.ActorId == "").X);
        Check.Throws<GameException>(() => Setup(restored, map));
        Check.Throws<GameException>(() => BoardCombat.Prepare(restored, setup.Definition, map with { Version = 4 }));
        Check.True(SharedBoard.Project(restored, map with { Version = 4 }, true).Map.Grid.Uncalibrated);
        var actual = restored.Board!.Entities.Single(e => e.Source.Kind == "enemy");
        restored.Board.Entities.Remove(actual);
        Check.Throws<GameException>(() => RuntimeEncounters.ValidateState(restored));
        restored.Board.Entities.Add(actual);
        restored.Board.Entities.Add(actual with { Id = Guid.NewGuid().ToString() });
        Check.Throws<GameException>(() => RuntimeEncounters.ValidateState(restored));
        restored.Board.Entities.RemoveAt(restored.Board.Entities.Count - 1);
        RuntimeEncounters.ValidateState(restored);
        var bad = setup with { Definition = setup.Definition with { Enemies = [enemy with { ArmorClass = 99 }] } };
        restored.RuntimeEncounters = [bad]; Check.Throws<GameException>(() => RuntimeEncounters.ValidateState(restored));
        return Task.CompletedTask;
    }
    private static RuntimeEncounter HiddenSetup(Campaign c, MapAssetView map, RulesEngine rules, int count = 2)
    {
        var placements = new[] {
            new EncounterPlacement("xmm:goblin-warrior", "秘密甲", "ranged", new(5.5 / 12, 2.5 / 8), "three-quarters-cover", "测试DM裁定：隔着密集掩护并处于敌人视线外。"),
            new EncounterPlacement("xmm:goblin-warrior", "秘密乙", "ranged", new(5.5 / 12, 4.5 / 8), "three-quarters-cover", "测试DM裁定：隔着密集掩护并处于敌人视线外。") }.Take(count).ToArray();
        var setup = RuntimeEncounters.Prepare(c, map, new() { Type = "square", CellPixels = 64 }, "场景交锋", c.SceneId, "测试伏兵依据", "测试战术标尺，不是作者比例", placements,
            [new(3, 2, "three-quarters-cover"), new(3, 3, "three-quarters-cover")]);
        setup = RuntimeEncounters.Establish(c, map, setup, placements, rules); c.Version++;
        RuntimeEncounters.ValidateState(c); SharedBoard.ValidateState(c);
        return setup;
    }
    public static Task HiddenInitiativeAndActualRangedDamage()
    {
        var map = Map(); var c = Campaign(map);
        var dice = new SequenceDice(15, 12, 20, 3, 1, 20, 2, 2, 2, 1, 1, 1, 1);
        var setup = HiddenSetup(c, map, new RulesEngine(dice));
        Check.Equal(2, dice.Count); Check.Equal(1, SharedBoard.Project(c, map, true).Tokens.Length);
        EncounterConcealment.Search(c, setup.Definition.Id, "search-failed", 8);
        setup = c.RuntimeEncounters![0];
        Check.Equal(0, setup.Observations!.Single().FoundIds.Length);
        c.RuntimeEncounters[0] = setup with { EngagementReason = "测试真实伏击触发", SurprisedActors = [c.ActingActorId] };
        c.BoardMapContext = map;
        var engine = new CombatEngine(dice); engine.Resolve(c, "combat.start", ""); c.Version++;
        Check.Equal(5, dice.Count); // two saved Hide checks, two surprised PC dice, one identical-monster initiative
        Check.Equal(c.ActingActorId, c.Combat!.ActiveActorId);
        Check.True(CombatAgentSessions.DelegatableEncounter(c) is null);
        Check.Equal(setup.Definition.Id, CombatAgentSessions.DelegatableEncounter(c, includeActive: true)!.Id);
        Check.Equal(5, dice.Count); // read-only adoption capability never rerolls setup or initiative
        Check.Equal(1, c.Combat.Units.Where(u => u.Team == "enemy").Select(u => u.InitiativeRoll).Distinct().Count());
        var visible = CombatVisibility.Project(c, true)!;
        Check.Equal(1, visible.Units.Length); Check.Equal(1, visible.TurnOrder.Length);
        Check.True(!JsonSerializer.Serialize(visible).Contains("秘密"));
        Check.Equal("disadvantage", visible.Log.Single(e => e.Kind == "initiative").Check!.Mode);
        Check.Equal(0, Adventure.Choices(c).Count(a => a.Kind == "combat.attack"));
        StandardCombatEngine.ValidateState(c); RuntimeEncounters.ValidateState(c); SharedBoard.ValidateState(c);
        var before = JsonSerializer.Serialize(c, JsonFiles.Options);
        c = JsonSerializer.Deserialize<Campaign>(before, JsonFiles.Options)!;
        engine.Resolve(c, "combat.end_turn", ""); c.Version++;
        Check.Equal(13, dice.Count);
        var attacks = c.Combat!.Log.Where(e => e.Kind == "attack").ToArray();
        Check.Equal(2, attacks.Length); Check.True(attacks[0].Attack!.Critical);
        Check.Equal("advantage", attacks[0].Attack!.Mode); Check.Equal(4, attacks[0].Attack!.DamageRolls.Length);
        Check.Equal(8, attacks[0].Attack!.Damage); Check.Equal(4, c.Character.Required().HitPoints);
        Check.True(!attacks[1].Attack!.Hit); Check.Equal(3, SharedBoard.Project(c, map, true).Tokens.Length);
        Check.Equal(1, CombatVisibility.Project(c, true)!.Log.Count(e => e.Kind == "initiative")); // revealing now never republishes old private dice
        StandardCombatEngine.ValidateState(c); RuntimeEncounters.ValidateState(c); SharedBoard.ValidateState(c);
        return Task.CompletedTask;
    }
    public static Task HiddenSearchAndShieldRestart()
    {
        var map = Map(); var c = Campaign(map, StandardSpellTests.Wizard());
        var dice = new SequenceDice(15, 20, 1, 14, 12, 3, 2);
        var setup = HiddenSetup(c, map, new RulesEngine(dice), 1);
        // Successful private discovery reveals no new information to another actor.
        EncounterConcealment.Search(c, setup.Definition.Id, "search-success", 25);
        Check.Equal(2, SharedBoard.Project(c, map, true).Tokens.Length);
        Check.True(!c.RuntimeEncounters![0].Concealment![0].Hidden);
        string actor = c.ActingActorId; c.ActingActorId = "other-seat";
        Check.Equal(1, SharedBoard.Project(c, map, true).Tokens.Length); c.ActingActorId = actor;
        Check.Throws<GameException>(() => EncounterConcealment.Search(c, setup.Definition.Id, "search-success", 30));
        // Separate fixture preserves a genuinely hidden first shot and saved bonus dice.
        c = Campaign(map, StandardSpellTests.Wizard());
        dice = new SequenceDice(15, 20, 1, 20, 12, 2, 2, 1, 1);
        setup = HiddenSetup(c, map, new RulesEngine(dice), 1);
        c.RuntimeEncounters![0] = setup with { EngagementReason = "测试敌对交锋", SurprisedActors = [] };
        c.BoardMapContext = map; var engine = new CombatEngine(dice);
        engine.Resolve(c, "combat.start", ""); c.Version++;
        engine.Resolve(c, "combat.end_turn", ""); c.Version++;
        Check.Equal("shield", c.Combat!.Standard!.Wait!.Kind); Check.Equal(5, dice.Count);
        Check.Equal(c.Character.Required().MaxHitPoints, c.Character.HitPoints);
        Check.Equal(2, c.StandardCombatFlow!.Steps[0].Strike!.AdvantageDamageDice);
        Check.Equal(2, SharedBoard.Project(c, map, true).Tokens.Length); // attack roll reveals before Shield
        StandardCombatEngine.ValidateState(c); RuntimeEncounters.ValidateState(c); SharedBoard.ValidateState(c);
        string saved = JsonSerializer.Serialize(c, JsonFiles.Options);
        var broken = JsonSerializer.Deserialize<Campaign>(saved, JsonFiles.Options)!;
        broken.StandardCombatFlow!.Steps[0].Strike = broken.StandardCombatFlow.Steps[0].Strike! with { AdvantageDamageDice = 1 };
        Check.Throws<GameException>(() => StandardCombatEngine.ValidateState(broken));
        c = JsonSerializer.Deserialize<Campaign>(saved, JsonFiles.Options)!;
        var shield = StandardSpellTests.Spell(c, "Shield", "combat.react");
        engine.Resolve(c, shield.Kind, shield.Target); c.Version++;
        Check.Equal(9, dice.Count); Check.Equal(8, c.Combat!.Log.Single(e => e.Kind == "attack").Attack!.Damage);
        Check.True(c.Combat.Log.Single(e => e.Kind == "attack").Attack!.Critical);
        StandardCombatEngine.ValidateState(c); RuntimeEncounters.ValidateState(c); SharedBoard.ValidateState(c);
        return Task.CompletedTask;
    }
    public static Task PendingDiscoveriesSurviveRevocationAndHideChoices()
    {
        var map = Map(); var c = Campaign(map); var dice = new SequenceDice(10, 20, 1, 1, 1);
        var setup = HiddenSetup(c, map, new RulesEngine(dice), 1);
        var former = new PartyMember { Id = Guid.NewGuid().ToString(), TokenHash = "fixture", Character = c.Character.Required() with { Id = Guid.NewGuid().ToString() } };
        c.PartyMembers.Add(former); string actor = c.ActingActorId;
        c.ActingActorId = former.Id; EncounterConcealment.Search(c, setup.Definition.Id, "former-discovery", 25, waitForNarrative: true);
        former.Revoked = true; c.ActingActorId = actor;
        c.RuntimeEncounters![0] = RuntimeEncounters.Current(c)! with { EngagementReason = "隔离攻击公开", SurprisedActors = [] };
        c.BoardMapContext = map; var engine = new CombatEngine(dice);
        engine.Resolve(c, "combat.start", ""); c.Version++;
        engine.Resolve(c, "combat.end_turn", ""); c.Version++;
        Check.True(RuntimeEncounters.Current(c)!.Concealment![0].KnownActors.Contains(former.Id));
        Check.Equal(5, dice.Count);
        RuntimeEncounters.ValidateState(c); StandardCombatEngine.ValidateState(c); SharedBoard.ValidateState(c);
        c = JsonSerializer.Deserialize<Campaign>(JsonSerializer.Serialize(c, JsonFiles.Options), JsonFiles.Options)!;
        RuntimeEncounters.ValidateState(c);

        var build = StandardSpellTests.Wizard(false).Build! with { Cantrips = ["acid-splash", "fire-bolt", "mage-hand"] };
        c = Campaign(map, PlayResources.Ensure(BuildEvaluator.Create(build)));
        dice = new SequenceDice(10, 20, 1); setup = HiddenSetup(c, map, new RulesEngine(dice), 1);
        EncounterConcealment.Search(c, setup.Definition.Id, "pending-discovery", 25, waitForNarrative: true);
        c.RuntimeEncounters![0] = RuntimeEncounters.Current(c)! with { EngagementReason = "隔离候选", SurprisedActors = [] };
        c.BoardMapContext = map; engine = new CombatEngine(dice); engine.Resolve(c, "combat.start", ""); c.Version++;
        string enemy = c.Combat!.Units.Single(u => u.Team == "enemy").Id;
        Check.True(EncounterConcealment.KnownTo(c, enemy, c.ActingActorId));
        Check.True(!EncounterConcealment.PresentedTo(c, enemy, c.ActingActorId));
        var choices = Adventure.Choices(c); Check.True(choices.Any(a => a.Label.StartsWith("Acid Splash /")));
        string wire = JsonSerializer.Serialize(choices, JsonFiles.Options);
        Check.True(!wire.Contains(enemy) && !choices.Any(a => a.Label.Contains("秘密甲") || (a.Details?.Note.Contains("秘密甲") ?? false)));
        var missile = StandardSpellTests.Spell(c, "Magic Missile"); engine.Resolve(c, missile.Kind, missile.Target);
        choices = Adventure.Choices(c); wire = JsonSerializer.Serialize(choices, JsonFiles.Options);
        Check.True(!wire.Contains(enemy) && !choices.Any(a => a.Label.Contains("秘密甲")));
        engine.Resolve(c, "combat.missile_allocate", "cancel");
        EncounterConcealment.PresentDiscoveries(c);
        Check.True(Adventure.Choices(c).Any(a => a.Label.StartsWith("Acid Splash /") && (a.Details?.Note.Contains("秘密甲") ?? false)));
        missile = StandardSpellTests.Spell(c, "Magic Missile"); engine.Resolve(c, missile.Kind, missile.Target);
        Check.True(Adventure.Choices(c).Any(a => a.Kind == "combat.missile_allocate" && a.Target.Contains(enemy)));
        Check.Equal(3, dice.Count);
        RuntimeEncounters.ValidateState(c); StandardCombatEngine.ValidateState(c); SharedBoard.ValidateState(c);
        return Task.CompletedTask;
    }
    public static Task GoblinRangeAndEscape()
    {
        foreach (var (distance, hidden, mode) in new[] { (80, false, "normal"), (85, false, "disadvantage"), (85, true, "normal") })
        {
            var map = Map() with { Width = 1536 };
            var c = Campaign(map); int x = 3 + distance / 5;
            var placements = new[] { new EncounterPlacement("xmm:goblin-warrior", "射程测试地精", "ranged", new((x + .5) / 24, 2.5 / 8),
                hidden ? "three-quarters-cover" : null, hidden ? "隔离伏兵在明确掩护后脱离视线" : null) };
            var values = (hidden ? new[] { 15 } : []).Concat(new[] { 20, 1, 20 }).Concat(mode == "disadvantage" ? new[] { 20 } : []).Concat(new[] { 2, 2 }).ToArray();
            var dice = new SequenceDice(values);
            var setup = RuntimeEncounters.Prepare(c, map, new() { Type = "square", CellPixels = 64 }, "射程测试", c.SceneId, "隔离来源", "隔离战术标尺",
                placements, hidden ? [new(8, 2, "three-quarters-cover")] : []);
            setup = RuntimeEncounters.Establish(c, map, setup, placements, new RulesEngine(dice)); c.Version++;
            c.RuntimeEncounters![0] = setup with { EngagementReason = "隔离射程测试", SurprisedActors = [] };
            c.BoardMapContext = map; var engine = new CombatEngine(dice); engine.Resolve(c, "combat.start", ""); c.Version++;
            engine.Resolve(c, "combat.end_turn", ""); c.Version++;
            var attack = c.Combat!.Log.Single(e => e.Kind == "attack").Attack!;
            Check.Equal(mode, attack.Mode); Check.True(attack.Critical); Check.Equal(2, attack.DamageRolls.Length); Check.Equal(6, attack.Damage);
            Check.Equal(values.Length, dice.Count); StandardCombatEngine.ValidateState(c);
        }
        {
            var map = Map(); var c = Campaign(map); var dice = new SequenceDice(20, 1, 1);
            var placements = new[] { new EncounterPlacement("xmm:goblin-warrior", "撤离测试地精", "ranged", new(2.5 / 12, 2.5 / 8)) };
            var setup = Setup(c, map, placements); setup = RuntimeEncounters.Establish(c, map, setup, placements, new RulesEngine(dice)); c.Version++;
            c.RuntimeEncounters![0] = setup with { EngagementReason = "隔离贴身撤离", SurprisedActors = [] }; c.BoardMapContext = map;
            var engine = new CombatEngine(dice); engine.Resolve(c, "combat.start", ""); c.Version++;
            engine.Resolve(c, "combat.end_turn", ""); c.Version++;
            Check.Equal(1, c.Combat!.Log.Count(e => e.Kind == "combat.nimble_escape"));
            Check.Equal(1, c.Combat.Log.Count(e => e.Kind == "attack")); Check.True(c.Combat.Standard!.Wait is null);
            Check.True(!c.Combat.Log.Any(e => e.Kind == "opportunity_attack")); Check.Equal(3, dice.Count);
            StandardCombatEngine.ValidateState(c); RuntimeEncounters.ValidateState(c); SharedBoard.ValidateState(c);
        }
        return Task.CompletedTask;
    }

    public static Task PersonalSightAndCombatSearch()
    {
        var map = Map(); var c = Campaign(map);
        c.PartyMembers.Add(new() { Id = "guest", TokenHash = "test-only", Character = c.Character.Required() with { Id = Guid.NewGuid().ToString() } });
        c.ActingActorId = "guest";
        SharedBoard.Execute(c, map, new("place-friend", c.Version, map.Id, "spawn", Spawns:
            [new("", "creature", new("player", "guest"), new("同伴"), 1.5 / 12, 4.5 / 8, "guest")], ExpectedMapVersion: map.Version));
        c.Version++; c.ActingActorId = "player";
        var dice = new SequenceDice(15, 20, 18, 1, 1, 1);
        var setup = HiddenSetup(c, map, new RulesEngine(dice), 1);
        c.RuntimeEncounters![0] = setup with { EngagementReason = "隔离回合测试", SurprisedActors = [] };
        c.BoardMapContext = map; var engine = new CombatEngine(dice);
        engine.Resolve(c, "combat.start", ""); c.Version++;
        Check.Equal(4, dice.Count); Check.True(c.RuntimeEncounters[0].Concealment![0].Hidden);
        engine.Resolve(c, "combat.move", "1,1"); c.Version++;
        engine.Resolve(c, "combat.move", "2,0"); c.Version++;
        var hidden = c.RuntimeEncounters[0].Concealment![0];
        Check.True(!hidden.Hidden); Check.True(hidden.KnownActors.SequenceEqual(["player"]));
        Check.Equal("gm", c.Board!.Entities.Single(e => e.Id == hidden.EntityId).Appearance.Visibility);
        Check.Equal(3, SharedBoard.Project(c, map, true).Tokens.Length);
        Check.True(StandardCombatEngine.RollDescription(c, new("combat.search", "")) is not null);
        engine.Resolve(c, "combat.search", ""); c.Version++;
        Check.Equal(5, dice.Count); Check.True(!c.Combat!.Units.Single(u => u.Id == "player").ActionAvailable);
        Check.True(!Adventure.Choices(c).Any(a => a.Kind == "combat.search"));
        Check.True(!c.Combat.Log.Single(e => e.Kind == "combat.search").Check!.HasDc);
        engine.Resolve(c, "combat.end_turn", ""); c.Version++; c.ActingActorId = "guest";
        Check.Equal(2, SharedBoard.Project(c, map, true).Tokens.Length);
        engine.Resolve(c, "combat.search", ""); c.Version++;
        Check.Equal(6, dice.Count); Check.True(!hidden.KnownActors.Contains("guest"));
        Check.Equal(2, SharedBoard.Project(c, map, true).Tokens.Length);
        StandardCombatEngine.ValidateState(c); RuntimeEncounters.ValidateState(c); SharedBoard.ValidateState(c);
        return Task.CompletedTask;
    }

    public static Task InvalidSetupDoesNotMutate()
    {
        var map = Map(); var c = Campaign(map);
        string before = JsonSerializer.Serialize(c, JsonFiles.Options);
        Check.Throws<GameException>(() => Setup(c, map, [new("MM:goblin", "不允许2014替代", "engage", new(.375, .3125))]));
        Check.Throws<GameException>(() => Setup(c, map, [new("xmm:skeleton", "不能重叠", "engage", new(.125, .3125))]));
        Check.Throws<GameException>(() => Setup(c, map, [new("xmm:skeleton", "不能假射击", "ranged", new(.375, .3125))]));
        Check.Throws<GameException>(() => Setup(c, map with { Published = false }));
        Check.Throws<GameException>(() => Setup(c, map with { Grid = new() { Type = "square", CellPixels = 32 } }));
        Check.Equal(before, JsonSerializer.Serialize(c, JsonFiles.Options));
        return Task.CompletedTask;
    }
}
