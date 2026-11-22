using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class EquipmentLoadoutTests
{
    private static Campaign Three()
    {
        var c = TestContent.Campaign("harbor");
        c.Character = PlayResources.Ensure(StarterCharacter.Create("Hands")) with
        { Inventory = [new("shortsword", "Shortsword", 1, false), new("dagger", "Dagger", 2, false), new("shortbow", "Shortbow", 1, false),
            new("shield", "Shield", 1, false), new("longsword", "Longsword", 1, false), new("greatsword", "Greatsword", 1, false)] };
        return c;
    }
    private static void Apply(Campaign c, string key) => new CharacterPlayEngine(new(new SequenceDice())).Resolve(c, new(Guid.NewGuid().ToString(), c.Version, "loadout", key));
    private static void Reject(Campaign c, string key)
    {
        string before = HarnessJson.Serialize(c); Check.Throws<GameException>(() => Apply(c, key)); Check.Equal(before, HarnessJson.Serialize(c));
    }
    public static Task SlotsHandsQuantityAndShield()
    {
        var c = Three(); string before = HarnessJson.Serialize(c);
        var sheet = CharacterPlayEngine.View(c); Check.Equal(before, HarnessJson.Serialize(c)); Check.True(c.Character!.PlayState!.Loadout is null);
        Apply(c, "assign:melee-main:shortsword"); Apply(c, "assign:melee-off:dagger"); Apply(c, "assign:ranged-main:shortbow");
        Check.Equal(3, c.Character!.Inventory.Count(i => i.Equipped)); Check.Equal(2, PlayCatalog.HeldItems(c.Character).Length);
        Check.Equal("shortsword", PlayCatalog.ActiveWeapon(c.Character)!.Id); Check.True(!EquipmentLoadout.GestureHand(c.Character));
        Reject(c, "assign:melee-main:greatsword"); Reject(c, "grip:two");
        Check.True(!CharacterPlayEngine.View(c).Loadout!.Options.Any(o => o.Key.StartsWith("grip:", StringComparison.Ordinal)));
        Apply(c, "set:ranged"); Check.Equal("shortbow", PlayCatalog.ActiveWeapon(c.Character)!.Id);
        Check.Equal(2, EquipmentLoadout.OccupiedHands(c.Character)); Check.True(EquipmentLoadout.GestureHand(c.Character));
        var slots = CharacterPlayEngine.View(c).Loadout!.Slots; Check.Equal("shortbow", slots.Single(s => s.Id == "ranged-off").OccupiedBy);
        Check.Equal("", slots.Single(s => s.Id == "ranged-off").ItemId); Check.True(c.Character.Inventory.Single(i => i.Id == "shortsword").Equipped);
        Apply(c, "set:melee"); Apply(c, "clear:melee-off"); Check.True(EquipmentLoadout.GestureHand(c.Character));
        Apply(c, "assign:melee-off:longsword"); // Light is not a holding prerequisite.
        Apply(c, "clear:melee-off"); Apply(c, "assign:melee-off:shield"); Check.Equal(13, c.Character.ArmorClass); Check.Equal(6L, c.ElapsedSeconds);
        Apply(c, "set:ranged"); Check.Equal(11, c.Character.ArmorClass); Check.Equal(12L, c.ElapsedSeconds);
        Apply(c, "set:melee"); Check.Equal(13, c.Character.ArmorClass); Check.Equal(18L, c.ElapsedSeconds);
        Reject(c, "assign:melee-main:greatsword"); Apply(c, "clear:melee-off");
        Apply(c, "assign:melee-main:dagger"); Apply(c, "assign:melee-off:dagger");
        Check.Equal(2, EquipmentLoadout.Held(c.Character).Length); Check.Equal(2, c.Character.Inventory.Single(i => i.Id == "dagger").Quantity);
        c.Character = c.Character with { Inventory = c.Character.Inventory.Select(i => i.Id == "dagger" ? i with { Quantity = 1 } : i).ToArray() };
        Check.True(CharacterPlayEngine.View(c).Loadout!.Notice.Contains("两件")); Check.True(PlayCatalog.ActiveWeapon(c.Character) is null);
        Reject(c, "set:ranged"); Apply(c, "clear:melee-off");
        Apply(c, "assign:ranged-main:dagger"); // same physical item may be referenced by either stowed set
        Check.Equal(1, c.Character.Inventory.Single(i => i.Id == "dagger").Quantity);
        Reject(c, "assign:melee-off:dagger");
        return Task.CompletedTask;
    }
    public static Task GripAttacksAndLegacyReads()
    {
        var old = CharacterEngine.Create("Old", CharacterEngine.Wizard); string bytes = HarnessJson.Serialize(old);
        Check.Equal("two", EquipmentLoadout.Read(old).MeleeGrip); Check.Equal(bytes, HarnessJson.Serialize(old));
        old = PlayResources.Ensure(old);
        var c = TestContent.Campaign("harbor"); c.Character = old;
        Apply(c, "grip:one"); Check.Equal("1d6", EquipmentLoadout.Damage(c.Character!, PlayCatalog.Equipment("quarterstaff")!));
        var attack = new CombatEngine(new SequenceDice(15, 6)).WeaponAttack(c.Character!, 10, savageAttacker: false);
        Check.Equal(6, attack.DamageRolls.Single());
        Apply(c, "grip:two"); attack = new CombatEngine(new SequenceDice(15, 8)).WeaponAttack(c.Character!, 10, savageAttacker: false);
        Check.Equal(8, attack.DamageRolls.Single());
        c = Three(); Apply(c, "assign:melee-main:longsword");
        Check.Equal("1d8", EquipmentLoadout.Damage(c.Character!, PlayCatalog.Equipment("longsword")!));
        Apply(c, "grip:two"); Check.Equal("1d10", EquipmentLoadout.Damage(c.Character!, PlayCatalog.Equipment("longsword")!));
        Reject(c, "assign:melee-off:dagger"); Reject(c, "assign:melee-off:shield"); Apply(c, "grip:one");
        foreach (var grip in new[] { "one", "two" })
        {
            var standard = StandardCombatTests.Campaign();
            standard.Character = EquipmentLoadout.Commit(PlayResources.Ensure(standard.Character.Required()) with
                { Inventory = [new("longsword", "Longsword", 1, false)] }, new("longsword", MeleeGrip: grip));
            int die = grip == "one" ? 8 : 10;
            var combat = new CombatEngine(new SequenceDice(20, 1, 15, die, die));
            combat.Resolve(standard, "combat.start", ""); StandardCombatTests.E(standard).X = 2; StandardCombatTests.E(standard).Y = 2;
            combat.Resolve(standard, "combat.attack", "guardian");
            Check.Equal(die, standard.Combat!.Log.Single(e => e.Kind == "attack").Attack!.DamageRolls.Single());
        }
        Apply(c, "assign:melee-main:greatsword"); Reject(c, "grip:two");
        Check.True(!CharacterPlayEngine.View(c).Loadout!.Options.Any(o => o.Key.StartsWith("grip:", StringComparison.Ordinal)));
        Apply(c, "assign:melee-main:longsword"); Apply(c, "grip:two"); Apply(c, "assign:melee-main:shortsword");
        Check.Equal("one", c.Character!.PlayState!.Loadout!.MeleeGrip);
        Reject(c, "assign:ranged-off:longsword");
        // A bad explicit reference does not choose an available spare or rewrite the save.
        c.Character = c.Character! with { PlayState = c.Character.PlayState! with { Loadout = new("missing") } };
        bytes = HarnessJson.Serialize(c); Check.True(PlayCatalog.ActiveWeapon(c.Character) is null);
        Check.True(CharacterPlayEngine.View(c).Loadout!.Notice.Contains("缺失")); Check.Equal(bytes, HarnessJson.Serialize(c));
        Apply(c, "clear:melee-main");
        return Task.CompletedTask;
    }
    public static Task StandardDualDropAndSlotPickup()
    {
        var c = StandardCombatTests.Campaign(hp: 1); var ch = c.Character.Required();
        ch = PlayResources.Ensure(ch) with { Inventory = [new("dagger", "Dagger", 2, false), new("shortbow", "Shortbow", 1, false)] };
        c.Character = EquipmentLoadout.Commit(ch, new("dagger", "dagger", "shortbow"));
        Check.True(!BuildRuntime.CanAutomateCombat(c.Character));
        var legacy = TestContent.Campaign("causeway"); legacy.Character = c.Character;
        Check.True(!Adventure.Choices(legacy).Any(a => a.Kind == "combat.start"));
        var combat = new CombatEngine(new SequenceDice(20, 1, 15, 4)); combat.Resolve(c, "combat.start", "");
        StandardCombatTests.E(c).X = 2; StandardCombatTests.E(c).Y = 2;
        combat.Resolve(c, "combat.end_turn", ""); Check.Equal(0, c.Character!.HitPoints);
        var p = StandardCombatTests.P(c); Check.Equal(2, p.Standard!.DroppedItems.Length);
        Check.Equal(2, p.Standard.DroppedItems.Select(i => i.Slot).Distinct().Count());
        Check.Equal(2, c.Character.Inventory.Single(i => i.Id == "dagger").Quantity);
        Check.Equal("shortbow", c.Character.PlayState!.Loadout!.RangedMainHandId);
        Check.True(c.Character.Inventory.Single(i => i.Id == "shortbow").Equipped);
        StandardCombatEngine.ValidateState(c);
        c = JsonSerializer.Deserialize<Campaign>(JsonSerializer.Serialize(c, JsonFiles.Options), JsonFiles.Options)!;
        p = StandardCombatTests.P(c); p.HitPoints = 1; p.Standard!.Conditions = ["Prone"]; p.Standard.ZeroHitPointUnconscious = false;
        c.Character = c.Character! with { HitPoints = 1, Conditions = ["Prone"] }; c.Combat!.ActiveActorId = "player"; c.Combat.Standard!.Wait = null; p.ActionAvailable = true;
        combat.Resolve(c, "combat.pick_up", "melee-main:dagger"); Check.Equal(1, p.Standard.DroppedItems.Length);
        Check.Equal("dagger", c.Character.PlayState!.Loadout!.MeleeMainHandId); Check.Equal("", c.Character.PlayState.Loadout.MeleeOffHandId);
        p.ActionAvailable = true; combat.Resolve(c, "combat.pick_up", "melee-off:dagger");
        Check.Equal(0, p.Standard.DroppedItems.Length); Check.Equal(2, EquipmentLoadout.Held(c.Character).Length);
        StandardCombatEngine.ValidateState(c);
        return Task.CompletedTask;
    }
    public static Task ReviewRegressionsAndActivity()
    {
        // A real lethal drop, stable defeat and recovery retain the old board but cannot lock future gear.
        var c = StandardCombatTests.Campaign(hp: 1);
        var combat = new CombatEngine(new SequenceDice(20, 1, 15, 4, 10, 10, 10, 2));
        combat.Resolve(c, "combat.start", ""); combat.Resolve(c, "combat.end_turn", "");
        for (int i = 0; i < 3; i++) combat.Resolve(c, "combat.death_save", "");
        combat.Resolve(c, "combat.recover_stable", ""); combat.Resolve(c, "rest.recover", "");
        string board = HarnessJson.Serialize(c.Combat!);
        Check.True(StandardCombatTests.P(c).Standard!.DroppedItems.Length > 0);
        Check.True(CharacterPlayEngine.View(c).Loadout!.Options.Single(o => o.Key == "assign:melee-main:greatsword").Available);
        Check.True(CharacterEngine.Choices(c).Any(o => o.Kind == "equipment.equip" && o.Target == "greatsword"));
        var legacy = JsonSerializer.Deserialize<Campaign>(JsonSerializer.Serialize(c, JsonFiles.Options), JsonFiles.Options)!;
        Apply(c, "assign:melee-main:greatsword"); Check.Equal("greatsword", PlayCatalog.ActiveWeapon(c.Character!)!.Id);
        Check.Equal(board, HarnessJson.Serialize(c.Combat!));
        Check.True(HarnessCharacterContext.Capture(c, 20).Loadout!.Slots.Single(s => s.Id == "melee-main").Active);
        new CharacterEngine(new SequenceDice()).Resolve(legacy, "equipment.equip", "greatsword");
        Check.Equal(board, HarnessJson.Serialize(legacy.Combat!));
        // Old action path must pay the same shield cost as the new slot command.
        c = Three(); Apply(c, "assign:melee-main:dagger"); Apply(c, "assign:melee-off:shield"); Apply(c, "assign:ranged-main:shortbow"); Apply(c, "set:ranged");
        long time = c.ElapsedSeconds; int ac = c.Character!.ArmorClass;
        Check.True(CharacterEngine.Choices(c).Single(o => o.Kind == "equipment.equip" && o.Target == "dagger").Label.Contains("6 秒"));
        new CharacterEngine(new SequenceDice()).Resolve(c, "equipment.equip", "dagger");
        Check.Equal(time + 6, c.ElapsedSeconds); Check.Equal(ac + 2, c.Character.ArmorClass);
        // Two-handed grip is not the Heavy property (STR 12 is valid with a versatile weapon).
        foreach (var (weapon, grip, expected) in new[] { ("longsword", "one", "normal"), ("longsword", "two", "normal"), ("greatsword", "one", "disadvantage") })
        {
            c = StandardCombatTests.Campaign(); var ch = PlayResources.Ensure(c.Character.Required());
            ch = ch with { Inventory = [new(weapon, weapon, 1, false)], Abilities = ch.Abilities.Select(a => a.Name == "strength" ? a with { Score = 12 } : a).ToArray() };
            c.Character = EquipmentLoadout.Commit(ch, new(weapon, MeleeGrip: grip));
            combat = new CombatEngine(expected == "normal" ? new SequenceDice(20, 1, 15, 4, 4) : new SequenceDice(20, 1, 15, 15, 4, 4, 4, 4)); combat.Resolve(c, "combat.start", "");
            StandardCombatTests.E(c).X = 2; StandardCombatTests.E(c).Y = 2; combat.Resolve(c, "combat.attack", "guardian");
            Check.Equal(expected, c.Combat!.Log.Single(e => e.Kind == "attack").Attack!.Mode);
        }
        c = Three(); Apply(c, "assign:melee-main:longsword"); Apply(c, "assign:ranged-main:shortbow");
        var captured = ActivityRecords.Capture(c); Apply(c, "assign:melee-off:dagger");
        Check.True(ActivityRecords.Changes(captured, c).Any(x => x.Operation == "loadout" && x.Key == "melee-off"));
        Apply(c, "clear:melee-off"); captured = ActivityRecords.Capture(c); Apply(c, "grip:two");
        Check.True(ActivityRecords.Changes(captured, c).Any(x => x.Operation == "loadout" && x.Key == "melee-grip" && x.After == "双手"));
        captured = ActivityRecords.Capture(c); Apply(c, "set:ranged");
        Check.True(ActivityRecords.Changes(captured, c).Any(x => x.Operation == "loadout" && x.Key == "active-set" && x.After == "远程"));
        return Task.CompletedTask;
    }
    public static Task FrozenCatalogsAndVersionedSelf()
    {
        var golden = JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "EquipmentLoadoutV19Golden.json")))!;
        foreach (var catalog in golden["catalogs"]!.AsArray())
            Check.Equal(catalog!["hash"]!.GetValue<string>(), HarnessJson.Fingerprint(HarnessJson.Element(HarnessTools.ForVersion(catalog["version"]!.GetValue<int>()))));
        var c = TestContent.Campaign("harbor"); c.Character = CharacterEngine.Create("Golden", CharacterEngine.Wizard);
        var self19 = JsonSerializer.SerializeToNode(HarnessCharacterContext.Capture(c, 19), HarnessJson.Options)!;
        self19["id"] = golden["self"]!["id"]!.GetValue<string>();
        Check.True(JsonNode.DeepEquals(golden["self"], self19), "v19 self changed from the pre-edit binary");
        Check.True(self19["loadout"] is null);
        c = Three(); Apply(c, "assign:melee-main:shortsword"); Apply(c, "assign:melee-off:dagger"); Apply(c, "assign:ranged-main:shortbow");
        var context = AdventureDirecting.Build(c, IntentContexts.Build(c, "装备", [], []));
        var self = HarnessCharacterContext.Capture(c, 20); Check.Equal("shortsword", self.Loadout!.Slots.Single(s => s.Id == "melee-main").ItemId);
        var frame = HarnessExecutionProtocol.Capture(c.Version, context, null, self, 20); HarnessExecutionProtocol.Validate(frame, c.Version, 20);
        Check.Throws<InvalidDataException>(() => HarnessExecutionProtocol.Validate(frame, c.Version, 19));
        var candidates = ActionUnderstanding.Candidates(c, includeLoadout: true);
        Check.True(candidates.Any(o => o.Character?.Operation == "loadout"));
        Check.True(!candidates.Any(o => o.Action?.Kind == "equipment.equip" || o.Character?.Operation == "equip" && PlayCatalog.Equipment(o.Character.Key)?.Kind is not ("LA" or "MA" or "HA")));
        Check.True(!ActionUnderstanding.Candidates(c).Any(o => o.Character?.Operation == "loadout"));
        Check.Equal(15, HarnessExecutionProtocol.Version); Check.True(HarnessTools.CurrentVersion >= 20);
        return Task.CompletedTask;
    }
    public static async Task RealPiV20LoadoutCandidateAndSelf()
    {
        var model = new Model((call, request) =>
        {
            var frame = HarnessExecutionProtocolTests.Frame(request);
            if (call == 1)
            {
                Check.True(!frame.GetProperty("self").TryGetProperty("loadout", out _));
                Check.True(frame.GetProperty("self").GetProperty("coverage").GetString()!.Contains("scope=character"));
                var candidate = frame.GetProperty("context").GetProperty("intent").GetProperty("candidates").EnumerateArray()
                    .First(c => c.GetProperty("label").GetString() == "近战主手 → Flail");
                return Tool("actions_propose", new { candidateId = candidate.GetProperty("id").GetString() });
            }
            Check.True(frame.GetProperty("self").TryGetProperty("loadout", out var loadout));
            Check.Equal("flail", loadout.GetProperty("slots").EnumerateArray().Single(s => s.GetProperty("id").GetString() == "melee-main").GetProperty("itemId").GetString());
            return Text("已将连枷配置为近战主手；没有攻击。");
        });
        await using var h = await Host.Start(configure: Configure(model)); var owner = await Create(h); var state = owner.Snapshot;
        var run = await Post<HarnessRunView>(h, state.Id, "harness/runs", new HarnessInputRequest(Id(), state.Version, "装备 近战主手 Flail"));
        run = await Settled(h, state.Id, run.Id); Check.Equal("waiting", run.Status); Check.Equal("intent", run.Wait!.Kind);
        state = (await h.Get(state.Id))!;
        var choice = state.PendingIntent!.Options.Single();
        var confirmed = await Post<ActionResponse>(h, state.Id, "intents/respond", new IntentResponseRequest(Id(), state.Version, state.PendingIntent.Id, "choose", choice.Id));
        Check.Equal("flail", confirmed.Snapshot.Character!.PlayState!.Loadout!.MeleeMainHandId);
        await Post<HarnessRunView>(h, state.Id, $"harness/runs/{run.Id}/resume", new HarnessResumeRequest(Id(), confirmed.Snapshot.Version));
        run = await Settled(h, state.Id, run.Id); Check.Equal("completed", run.Status); Check.Equal(2, model.Calls);
        var stored = h.App.Services.GetRequiredService<HarnessRunStore>().Read(state.Id, PartyEngine.HostId, run.Id)!;
        Check.Equal(HarnessTools.CurrentVersion, stored.ToolContractVersion); Check.True(stored.Steps.Where(s => s.Kind == "model").All(s => s.ExecutionFrame!.Self!.Loadout is not null));
    }
    public static async Task HttpZeroWritesReceiptsAndRestart()
    {
        var h = await Host.Start(broken: new BrokenText());
        try
        {
            var owner = await h.Create(); var s = owner.Snapshot; string path = $"/api/v1/campaigns/{s.Id}";
            var granted = await h.Http.PostAsJsonAsync(path + "/characters/adjust", new AdjustCharacterRequest(Guid.NewGuid().ToString(), s.Version, "player", "isolated test", "XPHB 2024",
                [new("inventory", "shortsword", 1), new("inventory", "dagger", 1), new("inventory", "shortbow", 1), new("inventory", "shield", 1)]));
            Check.Equal(HttpStatusCode.OK, granted.StatusCode); s = (await granted.Content.ReadFromJsonAsync<ActionResponse>())!.Snapshot;
            var originalEvents = JsonFiles.Hash(HarnessJson.Serialize(s.Events));
            CharacterPlayRequest? last = null;
            foreach (var key in new[] { "assign:melee-main:shortsword", "assign:melee-off:dagger", "assign:ranged-main:shortbow" })
            {
                last = new(Guid.NewGuid().ToString(), s.Version, "loadout", key);
                var response = await h.Http.PostAsJsonAsync(path + "/character/commands", last); Check.Equal(HttpStatusCode.OK, response.StatusCode);
                s = (await response.Content.ReadFromJsonAsync<ActionResponse>())!.Snapshot;
                var activity = await h.Http.GetFromJsonAsync<ActivityPage>(path + "/activity");
                Check.True(activity!.Entries.All(e => e.Kind != "character.loadout"));
                Check.Equal(originalEvents, JsonFiles.Hash(HarnessJson.Serialize(s.Events)));
            }
            string db = Path.Combine(h.Root, "campaigns", s.Id + ".sqlite"); var before = File.ReadAllBytes(db);
            var sheet = await h.Http.GetFromJsonAsync<CharacterSheetView>(path + "/character/sheet"); Check.Equal(5, sheet!.Loadout!.Slots.Length);
            Check.True(before.SequenceEqual(File.ReadAllBytes(db)));
            foreach (var key in new[] { "assign:melee-main:greatsword", "assign:melee-main:dagger", "grip:two", "assign:melee-off:forged" })
            {
                var response = await h.Http.PostAsJsonAsync(path + "/character/commands", new CharacterPlayRequest(Guid.NewGuid().ToString(), s.Version, "loadout", key));
                Check.True(!response.IsSuccessStatusCode); Check.True(before.SequenceEqual(File.ReadAllBytes(db)));
            }
            var adjust = await h.Http.PostAsJsonAsync(path + "/characters/adjust", new AdjustCharacterRequest(Guid.NewGuid().ToString(), s.Version, "player", "isolated test", "XPHB 2024", [new("inventory", "dagger", 0)]));
            Check.Equal(HttpStatusCode.Conflict, adjust.StatusCode); Check.True(before.SequenceEqual(File.ReadAllBytes(db)));
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, broken: new BrokenText()); h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var replay = await h.Http.PostAsJsonAsync(path + "/character/commands", last); Check.Equal(HttpStatusCode.OK, replay.StatusCode);
            Check.True((await replay.Content.ReadFromJsonAsync<ActionResponse>())!.Replayed);
            var reopened = await h.Http.GetFromJsonAsync<CharacterSheetView>(path + "/character/sheet"); Check.Equal("dagger", reopened!.Character.PlayState!.Loadout!.MeleeOffHandId);
            Check.True(before.SequenceEqual(File.ReadAllBytes(db)));
        }
        finally { await h.DisposeAsync(); }
    }
}
