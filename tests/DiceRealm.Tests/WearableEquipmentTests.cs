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

internal static class WearableEquipmentTests
{
    private static Item Item(string catalog, string suffix = "0", bool worn = false)
    {
        var d = WearableCatalog.ById(catalog)!;
        return new("instance:" + catalog + ":" + suffix, d.Name, 1, worn, d.RulesId);
    }
    private static Campaign Campaign(bool fullBuild = false)
    {
        var c = TestContent.Campaign("harbor");
        c.Character = PlayResources.Ensure(fullBuild ? BuildEvaluator.Create(FullCreationTests.Named("Wearer")) : StarterCharacter.Create("Wearer"));
        c.Character = c.Character with { Inventory = [..c.Character.Inventory, ..WearableCatalog.Items.Select(d => Item(d.Id))] };
        return c;
    }
    private static Resolution Apply(Campaign c, string operation, string key) => new CharacterPlayEngine(new(new SequenceDice())).Resolve(c, new(Id(), c.Version, operation, key));
    private static string Key(Campaign c, string catalog, string verb, string suffix = "0") => verb + ":" + c.ActingCharacter.Inventory.Single(i => i.Id == Item(catalog, suffix).Id).Id;
    private static void Wear(Campaign c, string catalog, string suffix = "0") => Apply(c, "wear", Key(c, catalog, "wear", suffix));
    private static void Attune(Campaign c, string catalog, string suffix = "0") => Apply(c, "attunement", Key(c, catalog, "attune", suffix));
    private static void Reject(Campaign c, string operation, string key)
    {
        string before = HarnessJson.Serialize(c); Check.Throws<GameException>(() => Apply(c, operation, key)); Check.Equal(before, HarnessJson.Serialize(c));
    }
    private static Character WithAttunements(Character c, params string[] catalogs) => PlayResources.Ensure(c) with
    { PlayState = PlayResources.Ensure(c).PlayState! with { Attunements = catalogs.Select(id => new CharacterAttunement(Item(id).Id, WearableCatalog.ById(id)!.RulesId)).ToArray() } };

    public static Task SlotsInstancesAndAvailability()
    {
        var c = Campaign(); string before = HarnessJson.Serialize(c);
        var view = CharacterPlayEngine.View(c).Wearables!;
        Check.Equal(before, HarnessJson.Serialize(c)); Check.Equal(3, view.AttunementLimit); Check.Equal(12, view.Items.Length);
        foreach (var definition in WearableCatalog.Items)
        {
            Check.Equal("magic_item:xdmg:" + definition.Id, definition.RulesId);
            Check.True(WearableCatalog.ByRulesId("xdmg:" + definition.Id) is null, "Wearables must not accept a second RulesId alias");
        }
        Check.True(view.Items.Single(i => i.ItemId == Item("boots-of-elvenkind").Id).Notice.Contains("不等于穿戴者完全无声或无法被察觉"));
        Check.True(view.Items.Single(i => i.ItemId == Item("gloves-of-thievery").Id).Notice.Contains("手套本身不可察觉，不使穿戴者隐形"));
        Check.True(view.Slots.Take(5).Select(s => s.Id).SequenceEqual(new[] { "head", "cloak", "hands", "wrists", "feet" }));
        Check.Equal(10, view.Slots.Length); Check.Equal(5, CharacterPlayEngine.View(c).Loadout!.Slots.Length);
        foreach (var catalog in new[] { "headband-of-intellect", "cloak-of-protection", "gloves-of-thievery", "bracers-of-defense", "boots-of-elvenkind" }) Wear(c, catalog);
        Reject(c, "wear", Key(c, "hat-of-disguise", "wear")); Reject(c, "wear", Key(c, "gauntlets-of-ogre-power", "wear"));
        Check.True(c.Character!.Inventory.Single(i => i.Id == Item("gloves-of-thievery").Id).Equipped && c.Character.Inventory.Single(i => i.Id == Item("bracers-of-defense").Id).Equipped);
        c.Character = c.Character with { Inventory = [..c.Character.Inventory, Item("ring-of-protection", "1"), Item("ring-of-protection", "2")] };
        foreach (string suffix in new[] { "0", "1", "2" }) Wear(c, "ring-of-protection", suffix);
        view = CharacterPlayEngine.View(c).Wearables!;
        Check.Equal(3, view.Slots.Count(s => s.Id.StartsWith("ring:", StringComparison.Ordinal)));
        Check.True(view.Slots.Single(s => s.Id == "ring").ItemId == "");
        var unwear = view.Options.Single(o => o.Key == Key(c, "ring-of-protection", "unwear", "2"));
        Check.Equal("", unwear.ItemId); Check.Equal("ring:" + Item("ring-of-protection", "2").Id, unwear.Slot);
        Check.True(view.Options.Single(o => o.Key == Key(c, "amulet-of-health", "wear")).ItemId == Item("amulet-of-health").Id);
        var safe = c.Character;
        foreach (string condition in new[] { "Unconscious", "Incapacitated", "Paralyzed", "Petrified", "Stunned", "Dead" })
        {
            c.Character = safe with { Conditions = [condition] };
            Check.True(CharacterPlayEngine.View(c).Wearables!.Options.All(o => !o.Available));
            Reject(c, "wear", Key(c, "boots-of-elvenkind", "unwear"));
        }
        c.Character = safe with { HitPoints = 0, Conditions = [] };
        Check.True(WearableEquipment.View(c).AttunementOptions.All(o => !o.Available)); Reject(c, "attunement", Key(c, "cloak-of-protection", "attune"));
        c.Character = safe;
        c.Combat = new();
        Check.True(WearableEquipment.View(c).Options.All(o => !o.Available)); Reject(c, "wear", Key(c, "boots-of-elvenkind", "unwear"));
        Reject(c, "attunement", Key(c, "cloak-of-protection", "attune")); c.Combat = null;
        c.Archived = true;
        Check.True(WearableEquipment.View(c).AttunementOptions.All(o => !o.Available)); Reject(c, "attunement", Key(c, "cloak-of-protection", "attune")); c.Archived = false;
        c.ContentActivated = false;
        Check.True(WearableEquipment.View(c).Options.All(o => !o.Available)); Reject(c, "wear", Key(c, "boots-of-elvenkind", "unwear")); c.ContentActivated = true;
        c.SceneId = "causeway";
        Check.True(CharacterPlayEngine.View(c).Wearables!.Options.Single(o => o.Key == Key(c, "boots-of-elvenkind", "unwear")).Available);
        Check.True(CharacterPlayEngine.View(c).Wearables!.AttunementOptions.All(o => !o.Available));
        Reject(c, "attunement", Key(c, "cloak-of-protection", "attune"));
        Apply(c, "wear", Key(c, "boots-of-elvenkind", "unwear")); Wear(c, "boots-of-elvenkind"); Check.Equal(0L, c.ElapsedSeconds);
        c.SceneId = "harbor";
        c.PartyMembers.Add(new() { Id = "other", TokenHash = "unused", Character = PlayResources.Ensure(StarterCharacter.Create("Other")) });
        string otherBefore = HarnessJson.Serialize(c.PartyMembers[0].Character);
        c.PendingIntents.Add(new() { Id = Id(), ActorId = "other", Text = "队友等待确认", Version = c.Version });
        Check.True(WearableEquipment.View(c).Options.Single(o => o.Key == Key(c, "boots-of-elvenkind", "unwear")).Available);
        Check.True(WearableEquipment.View(c).AttunementOptions.All(o => !o.Available)); Reject(c, "attunement", Key(c, "cloak-of-protection", "attune"));
        Apply(c, "wear", Key(c, "boots-of-elvenkind", "unwear")); c.PendingIntents.Clear();
        c.PendingRolls.Add(new() { Id = Id(), ActorId = "other", Label = "队友等待骰子", Description = "未同意", Version = c.Version });
        Check.True(WearableEquipment.View(c).Options.Single(o => o.Key == Key(c, "boots-of-elvenkind", "wear")).Available);
        Check.True(WearableEquipment.View(c).AttunementOptions.All(o => !o.Available)); Reject(c, "attunement", Key(c, "cloak-of-protection", "attune"));
        Wear(c, "boots-of-elvenkind"); Check.Equal(0L, c.ElapsedSeconds); Check.Equal(otherBefore, HarnessJson.Serialize(c.PartyMembers[0].Character)); c.PendingRolls.Clear();
        c.PendingIntents.Add(new() { Id = Id(), ActorId = "player", Text = "等待确认", Version = c.Version });
        Check.True(CharacterPlayEngine.View(c).Wearables!.AttunementOptions.All(o => !o.Available)); Reject(c, "wear", Key(c, "boots-of-elvenkind", "unwear"));
        c.PendingIntents.Clear(); c.PendingRolls.Add(new() { Id = Id(), ActorId = "player", Label = "等待骰子", Description = "未同意", Version = c.Version });
        Reject(c, "attunement", Key(c, "cloak-of-protection", "attune")); c.PendingRolls.Clear();
        var raw = c.Character; c.Character = raw with { Inventory = raw.Inventory.Select(i => i.Id == Item("boots-of-elvenkind").Id ? i with { Quantity = 2 } : i).ToArray() };
        Reject(c, "wear", Key(c, "boots-of-elvenkind", "unwear")); Check.True(!WearableEquipment.Has(c.Character, "boots-of-elvenkind"));
        c.Character = raw;
        foreach (var invalid in new[] { new CharacterPlayRequest(Id(), c.Version, "wear", Key(c, "boots-of-elvenkind", "unwear"), 2),
            new(Id(), c.Version, "attunement", Key(c, "cloak-of-protection", "attune"), Mode: "advantage"),
            new(Id(), c.Version, "wear", Key(c, "boots-of-elvenkind", "unwear"), Choices: ["invented"]) })
        {
            before = HarnessJson.Serialize(c); Check.Throws<GameException>(() => new CharacterPlayEngine(new(new SequenceDice())).Resolve(c, invalid)); Check.Equal(before, HarnessJson.Serialize(c));
        }
        Check.True(WearableEquipment.View(c).Notice.Contains("24小时"));
        return Task.CompletedTask;
    }

    public static async Task OrdinaryRobeIdentityNoArmorAndHttpPersistence()
    {
        var c = Campaign(true); c.HostReview = new(1, "approved");
        c.Character = c.Character! with { Inventory = [..c.Character.Inventory, new("robe", "Robe", 1, false),
            new("instance:robe", "另一件长袍", 1, false, "equipment:xphb:robe"), new("fake", "Robe", 1, false),
            new("wrong", "Robe", 1, false, "magic_item:xdmg:unknown")] };
        string before = HarnessJson.Serialize(c); var sheet = CharacterPlayEngine.View(c);
        Check.Equal(before, HarnessJson.Serialize(c));
        Check.True(sheet.Wearables!.Options.Single(o => o.Key == "wear:robe").Available);
        Check.True(!sheet.Wearables.Options.Any(o => o.ItemId is "fake" or "wrong"));
        Check.True(WearableCatalog.For(new("robe", "Robe", 1, false, "")) is null);
        Check.True(WearableCatalog.For(new("instance", "Robe", 1, false, "xphb:robe"))?.Slot == "clothing");
        Check.True(WearableCatalog.ById("robe") is null, "Ordinary acquisition must not enter the magic-item instance branch");
        int ac = c.Character.ArmorClass; bool armored = BuildRuntime.Armored(c.Character);
        Apply(c, "wear", "wear:robe"); sheet = CharacterPlayEngine.View(c);
        Check.Equal("robe", sheet.Wearables!.Slots.Single(s => s.Id == "clothing:robe").ItemId);
        Check.Equal(ac, c.Character!.ArmorClass); Check.Equal(armored, BuildRuntime.Armored(c.Character));
        Check.Equal(0L, c.ElapsedSeconds); Check.True(!sheet.Wearables.AttunementOptions.Any(o => o.ItemId == "robe"));
        Check.True(sheet.Wearables.Items.Single(i => i.ItemId == "robe").Status.Contains("普通衣物"));
        Apply(c, "wear", "wear:instance:robe");
        Check.Equal(2, WearableEquipment.View(c).Slots.Count(s => s.Id.StartsWith("clothing:", StringComparison.Ordinal)));
        Reject(c, "attunement", "attune:robe");
        var self = HarnessCharacterContext.Capture(c, 24); var context = AdventureDirecting.Build(c, IntentContexts.Build(c, "穿戴长袍", [], []));
        HarnessCharacterContext.Validate(self, context.Intent.Context.Character, 24);
        Apply(c, "wear", "unwear:robe");
        var host = await Host.Start(); string token = new('e', 64); c = CloneWithToken(c, JsonFiles.Hash(token));
        c.Events.Add(new(Id(), c.Version, "arrival", "隔离长袍验收", "", "authored", DateTimeOffset.UtcNow, null));
        try
        {
            host.App.Services.GetRequiredService<CampaignStore>().Create(c);
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", token);
            string path = "/api/v1/campaigns/" + c.Id;
            string db = Path.Combine(host.Root, "campaigns", c.Id + ".sqlite"); byte[] bytes = File.ReadAllBytes(db);
            var read = (await host.Http.GetFromJsonAsync<CharacterSheetView>(path + "/character/sheet"))!;
            Check.True(read.Wearables!.Options.Single(o => o.Key == "wear:robe").Available);
            Check.True(bytes.SequenceEqual(File.ReadAllBytes(db)));
            var request = new CharacterPlayRequest(Id(), c.Version, "wear", "wear:robe");
            var response = await Post<ActionResponse>(host, c.Id, "character/commands", request);
            Check.True(response.Snapshot.Character!.Inventory.Single(i => i.Id == "robe").Equipped);
            Check.Equal(ac, response.Snapshot.Character.ArmorClass); Check.Equal(0L, response.Snapshot.ElapsedSeconds);
            string root = host.Root; await host.DisposeAsync(); host = await Host.Start(root);
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", token);
            var replay = await Post<ActionResponse>(host, c.Id, "character/commands", request);
            Check.True(replay.Replayed); Check.Equal(response.Snapshot.Version, replay.Snapshot.Version);
            Check.True(replay.Snapshot.Character!.Inventory.Single(i => i.Id == "robe").Equipped);
            var off = await Post<ActionResponse>(host, c.Id, "character/commands", new CharacterPlayRequest(Id(), replay.Snapshot.Version, "wear", "unwear:robe"));
            Check.True(!off.Snapshot.Character!.Inventory.Single(i => i.Id == "robe").Equipped);
            Check.Equal(ac, off.Snapshot.Character.ArmorClass); Check.Equal(0L, off.Snapshot.ElapsedSeconds);
        }
        finally { await host.DisposeAsync(); }
    }

    public static Task AttunementOwnRestLimitTransferAndMissingInventory()
    {
        var c = Campaign();
        c.Character = c.Character! with { HitPoints = 3, ShortRestDiceAvailable = true,
            PlayState = c.Character.PlayState! with { PreparationOpen = true, PreparedClasses = ["retained-preparation"], RestChoicesUsed = ["retained-choice"] },
            Resources = [..c.Character.Resources.Select(r => r with { Current = 0 }), new("short fixture", 0, 3, "short", "普通短休池"),
                new("one fixture", 1, 3, "short-one", "每次恢复一次"), new("long fixture", 0, 2, "long", "不能短休恢复"), new("manual fixture", 0, 2, "manual", "手工池不恢复")] };
        var teammate = PlayResources.Ensure(StarterCharacter.Create("Other"));
        teammate = teammate with { HitPoints = 4, ShortRestDiceAvailable = true, Resources = teammate.Resources.Select(r => r with { Current = 0 }).ToArray() };
        c.PartyMembers.Add(new() { Id = "other", TokenHash = "unused", Character = teammate });
        string otherBefore = HarnessJson.Serialize(teammate);
        Attune(c, "cloak-of-protection"); Check.Equal(3600L, c.ElapsedSeconds); Check.Equal(3, c.Character!.HitPoints);
        Check.Equal(1, c.Character.Resources.Single(r => r.Name == "Second Wind").Current); Check.True(c.Character.ShortRestDiceAvailable);
        Check.Equal(3, c.Character.Resources.Single(r => r.Name == "short fixture").Current); Check.Equal(2, c.Character.Resources.Single(r => r.Name == "one fixture").Current);
        Check.Equal(0, c.Character.Resources.Single(r => r.Name == "long fixture").Current); Check.Equal(0, c.Character.Resources.Single(r => r.Name == "manual fixture").Current);
        Check.True(!c.Character.PlayState!.PreparationOpen); Check.True(c.Character.PlayState.PreparedClasses!.SequenceEqual(["retained-preparation"]));
        Check.True(c.Character.PlayState.RestChoicesUsed!.SequenceEqual(["retained-choice"]));
        Check.Equal(0, c.Character.Resources.Single(r => r.Name.StartsWith("Hit Dice", StringComparison.Ordinal)).Current);
        Check.Equal(otherBefore, HarnessJson.Serialize(c.PartyMembers[0].Character)); Check.Equal(0, c.PendingRulings.Count);
        // The new focused rest opens the original own-dice choice; it neither rolls nor heals automatically.
        c.Character = c.Character with { Resources = c.Character.Resources.Select(r => r.Name == "Hit Dice (d10)" ? r with { Current = 1 } : r).ToArray() };
        Check.True(Adventure.Choices(c).Any(a => a.Kind == "rest.hit_die"));
        int hp = c.Character.HitPoints; new CharacterEngine(new SequenceDice(5)).Resolve(c, "rest.hit_die", "");
        Check.Equal(hp + 5 + CharacterEngine.Ability(c.Character, "constitution"), c.Character.HitPoints); Check.Equal(3600L, c.ElapsedSeconds);
        Check.Equal(0, c.Character.Resources.Single(r => r.Name == "Hit Dice (d10)").Current);
        Check.Equal(otherBefore, HarnessJson.Serialize(c.PartyMembers[0].Character));
        Check.True(!WearableEquipment.Has(c.Character, "cloak-of-protection")); Wear(c, "cloak-of-protection");
        Apply(c, "wear", Key(c, "cloak-of-protection", "unwear")); Check.Equal(1, WearableEquipment.Attunements(c.Character).Length); Check.True(!WearableEquipment.Has(c.Character, "cloak-of-protection"));
        Attune(c, "ring-of-protection"); Attune(c, "bracers-of-defense"); Check.Equal(10800L, c.ElapsedSeconds);
        Check.Equal(3, WearableEquipment.Attunements(c.Character).Length); Reject(c, "attunement", Key(c, "headband-of-intellect", "attune"));
        c.Character = c.Character with { Inventory = [..c.Character.Inventory, Item("ring-of-protection", "1")] };
        Reject(c, "attunement", Key(c, "ring-of-protection", "attune", "1"));
        Apply(c, "attunement", Key(c, "bracers-of-defense", "unattune")); Check.Equal(14400L, c.ElapsedSeconds);
        Check.True(c.Character.ShortRestDiceAvailable); Check.Equal(2, WearableEquipment.Attunements(c.Character).Length);
        Check.Equal(3, c.Character.Resources.Single(r => r.Name == "one fixture").Current);
        Check.Equal(hp + 5 + CharacterEngine.Ability(c.Character, "constitution"), c.Character.HitPoints);
        Reject(c, "attunement", Key(c, "ring-of-protection", "attune", "1"));
        var cloak = c.Character.Inventory.Single(i => i.Id == Item("cloak-of-protection").Id);
        c.Character = c.Character with { Inventory = c.Character.Inventory.Where(i => i.Id != cloak.Id).ToArray() };
        Check.Equal(2, WearableEquipment.Attunements(c.Character).Length); CharacterEngine.Advance(c, 2 * 86400);
        Check.Equal(2, WearableEquipment.Attunements(c.Character).Length); Check.True(WearableEquipment.View(c).Notice.Contains("不在当前库存"));
        // Explicit test transfer: the same physical ID is now in the other creature's inventory.
        c.PartyMembers[0].Character = teammate with { Inventory = [..teammate.Inventory, cloak] };
        c.ActingActorId = "other"; Attune(c, "cloak-of-protection");
        Check.True(!WearableEquipment.Attunements(c.Character).Any(a => a.ItemId == cloak.Id));
        Check.True(WearableEquipment.Attunements(c.ActingCharacter).Any(a => a.ItemId == cloak.Id));
        c.ActingActorId = "player";
        c.Character = c.Character with { HitPoints = 0, Conditions = ["Unconscious"] }; CharacterEngine.Sync(c);
        Check.Equal(1, WearableEquipment.Attunements(c.Character).Length);
        c.Character = c.Character with { Conditions = ["Dead", "Unconscious"] }; CharacterEngine.Sync(c); Check.Equal(0, WearableEquipment.Attunements(c.Character).Length);
        return Task.CompletedTask;
    }

    public static Task FiveActualEffectsArmorSourcesAndRuntimeProjection()
    {
        var c = Campaign(true); var baseCharacter = c.Character!;
        int baseAc = BuildRuntime.ArmorClass(baseCharacter, false); int baseSave = RulesEngine.TestModifier(baseCharacter, "dexterity", "", true);
        string rawMechanics = HarnessJson.Serialize(baseCharacter.BuildMechanics);
        foreach (var id in new[] { "cloak-of-protection", "ring-of-protection", "bracers-of-defense", "boots-of-elvenkind", "gloves-of-thievery" }) Wear(c, id);
        foreach (var id in new[] { "cloak-of-protection", "ring-of-protection", "bracers-of-defense" }) Attune(c, id);
        Check.Equal(baseAc + 2, c.Character!.ArmorClass); Check.Equal(baseSave + 2, RulesEngine.TestModifier(c.Character, "dexterity", "", true));
        Check.True(!WearableEquipment.Has(c.Character, "bracers-of-defense"));
        foreach (var a in c.Character.Abilities) Check.Equal(RulesEngine.TestModifier(baseCharacter, a.Name, "", true) + 2, RulesEngine.TestModifier(c.Character, a.Name, "", true));
        Check.Equal(rawMechanics, HarnessJson.Serialize(c.Character.BuildMechanics));
        var dice = new SequenceDice(9, 19, 9, 19, 9, 19, 9, 19); var rules = new RulesEngine(dice);
        var stealth = new SheetCheckOption("stealth", "隐匿", "dexterity", "Stealth", 0, false);
        Check.Equal("normal", rules.SheetTest(c.Character, stealth, "normal").Mode); // Boots cancel worn armor disadvantage.
        Check.Equal("normal", rules.AbilityCheck(c.Character, "dexterity", "Stealth", 12).Mode);
        var hand = new SheetCheckOption("hand", "巧手", "dexterity", "Sleight of Hand", 0, false);
        Check.Equal(RulesEngine.TestModifier(baseCharacter, "dexterity", "Sleight of Hand", false) + 5, rules.SheetTest(c.Character, hand, "normal").Modifier);
        Check.Equal(RulesEngine.TestModifier(baseCharacter, "dexterity", "Sleight of Hand", false) + 5, rules.AbilityCheck(c.Character, "dexterity", "Sleight of Hand", 12).Modifier);
        Check.Equal(RulesEngine.TestModifier(baseCharacter, "strength", "Sleight of Hand", false), RulesEngine.TestModifier(c.Character, "strength", "Sleight of Hand", false));
        c.Character = c.Character with { Inventory = c.Character.Inventory.Select(i => PlayCatalog.Equipment(i.Id)?.Kind is "LA" or "MA" or "HA" ? i with { Equipped = false } : i).ToArray() };
        CharacterEngine.Sync(c); int unarmored = 10 + CharacterEngine.Ability(c.Character, "dexterity");
        Check.Equal(unarmored + 4, c.Character.ArmorClass); Check.Equal("advantage", rules.SheetTest(c.Character, stealth, "normal").Mode);
        c.Character = c.Character with { Conditions = ["Poisoned"] }; Check.Equal("normal", rules.SheetTest(c.Character, stealth, "normal").Mode);
        c.Character = c.Character with { Conditions = [] };
        c.Character = c.Character with { Inventory = [..c.Character.Inventory, new("shield", "Shield", 1, false)] };
        c.Character = EquipmentLoadout.Commit(c.Character, new("", "shield")); CharacterEngine.Sync(c);
        Check.Equal(unarmored + 2 + 2, c.Character.ArmorClass); Check.True(!WearableEquipment.Has(c.Character, "bracers-of-defense"));
        c.Character = EquipmentLoadout.Commit(c.Character, EquipmentLoadout.Read(c.Character) with { ActiveSet = "ranged" }); CharacterEngine.Sync(c);
        Check.True(WearableEquipment.Has(c.Character, "bracers-of-defense"));
        string before = HarnessJson.Serialize(c);
        var sheet = CharacterPlayEngine.View(c); Check.Equal(before, HarnessJson.Serialize(c));
        Check.Equal("未穿护甲", sheet.Character.EquipmentStatus!.Armor);
        Check.Equal(c.Character.ArmorClass, sheet.Character.ArmorClass);
        Check.Equal(3, sheet.Character.EquipmentStatus.ArmorClassSources.Count(s => s.Contains(" +1") || s.Contains(" +2")));
        Check.True(sheet.Character.EquipmentStatus.ArmorClassSources.Any(s => s.Contains("防御护腕 +2")));
        Check.True(sheet.Character.BuildMechanics!.Skills.Single(s => s.Name == "Sleight of Hand").Modifier == sheet.Checks.Single(s => s.Skill == "Sleight of Hand").Modifier);
        Check.True(sheet.Character.BuildMechanics.SavingThrows.All(s => s.Modifier == sheet.Checks.Single(o => o.Id == "save:" + s.Ability).Modifier));
        Check.Equal(rawMechanics, HarnessJson.Serialize(c.Character.BuildMechanics));
        Apply(c, "check", "skill:sleight-of-hand"); Check.Equal(rawMechanics, HarnessJson.Serialize(c.Character.BuildMechanics));
        // Advancement has its own base formula, but the same owner adds wearable AC exactly once.
        c.Character = c.Character with { Advancement = AdvancementEngine.State(c.Character) };
        Check.Equal(unarmored + 4, AdvancementProjection.ArmorClass(c.Character, false)); Check.Equal(unarmored + 4, BuildRuntime.ArmorClass(c.Character, false));
        Check.Equal(13 + CharacterEngine.Ability(c.Character, "dexterity") + 4, BuildRuntime.ArmorClass(c.Character, true));
        var plain = baseCharacter with { Inventory = [new("fake", "Gloves of Thievery", 1, true)] };
        Check.Equal(0, WearableEquipment.SkillBonus(plain, "dexterity", "Sleight of Hand"));
        baseCharacter = EquipmentLoadout.Commit(baseCharacter, new()); // The following isolated item fixtures carry no weapons.
        foreach (var unsupported in WearableCatalog.Items.Where(i => !i.Supported))
        {
            var ch = WithAttunements(baseCharacter with { Inventory = [Item(unsupported.Id, worn: true)] }, unsupported.Id);
            Check.True(!WearableEquipment.Effective(ch, ch.Inventory.Single()));
            c.Character = ch; var projected = CharacterPlayEngine.View(c).Wearables!.Items.Single();
            Check.True(!projected.Effective && projected.Notice.Contains("尚未自动结算"));
            Check.Equal(unsupported.Name + "：能力尚未自动结算，详见物品说明。", CharacterPlayEngine.View(c).Character.EquipmentStatus!.Issues.Single());
        }
        c.Character = baseCharacter with { Inventory = [Item("ring-of-protection", "one", true), Item("ring-of-protection", "two", true)] };
        Check.Equal(1, WearableEquipment.Project(c, c.Character).EquipmentStatus!.Issues.Length);
        Check.Equal(2, CharacterPlayEngine.View(c).Wearables!.Items.Length); // Compact issue text never merges physical items.
        return Task.CompletedTask;
    }

    public static Task DeathSavesAndRealDeath()
    {
        var c = StandardCombatTests.Campaign(hp: 1);
        c.Character = WithAttunements(c.Character! with { Inventory = [..c.Character!.Inventory, Item("cloak-of-protection", worn: true), Item("ring-of-protection", worn: true)] }, "cloak-of-protection", "ring-of-protection");
        CharacterEngine.Sync(c);
        var combat = new CombatEngine(new SequenceDice(20, 1, 19, 4, 8, 1, 1));
        combat.Resolve(c, "combat.start", ""); Check.Equal(18, StandardCombatTests.P(c).ArmorClass);
        combat.Resolve(c, "combat.end_turn", ""); Check.Equal(0, c.Character!.HitPoints);
        Check.Equal(2, WearableEquipment.Attunements(c.Character).Length); Check.Equal("death", c.Combat!.Standard!.Wait!.Kind);
        combat.Resolve(c, "combat.death_save", "");
        var check = c.Combat.Log.Last(e => e.Kind == "death_save").Check!; Check.Equal(2, check.Modifier); Check.Equal(10, check.Total); Check.True(check.Success);
        combat.Resolve(c, "combat.death_save", "");
        Check.Equal(2, StandardCombatTests.P(c).Standard!.DeathFailures); // natural1 still two failures despite +2.
        combat.Resolve(c, "combat.death_save", "");
        Check.True(c.Character.Conditions.Contains("Dead")); Check.Equal(0, WearableEquipment.Attunements(c.Character).Length);
        var massive = StandardCombatTests.Campaign(hp: 1, damageBonus: 20);
        massive.Character = WithAttunements(massive.Character! with { Inventory = [..massive.Character!.Inventory, Item("cloak-of-protection", worn: true)] }, "cloak-of-protection");
        var killer = new CombatEngine(new SequenceDice(20, 1, 19, 4)); killer.Resolve(massive, "combat.start", ""); killer.Resolve(massive, "combat.end_turn", "");
        Check.True(StandardCombatTests.P(massive).Standard!.Dead); Check.Equal(0, WearableEquipment.Attunements(massive.Character!).Length);
        return Task.CompletedTask;
    }

    public static Task FrozenCatalogsSelfAndExactRulesId()
    {
        var golden = JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "WearablesV20Golden.json")))!;
        foreach (var catalog in golden["catalogs"]!.AsArray())
            Check.Equal(catalog!["hash"]!.GetValue<string>(), HarnessJson.Fingerprint(HarnessJson.Element(HarnessTools.ForVersion(catalog["version"]!.GetValue<int>()))));
        var c = TestContent.Campaign("harbor"); c.Character = CharacterEngine.Create("Golden", CharacterEngine.Wizard);
        var self20 = JsonSerializer.SerializeToNode(HarnessCharacterContext.Capture(c, 20), HarnessJson.Options)!;
        self20["id"] = golden["self"]!["id"]!.GetValue<string>();
        Check.True(JsonNode.DeepEquals(golden["self"], self20), "v20 self must match original parent binary");
        Check.True(HarnessTools.CurrentVersion >= 21);
        c = Campaign(); Wear(c, "boots-of-elvenkind");
        foreach (int version in new[] { 19, 20 })
        {
            var old = HarnessJson.Element(HarnessCharacterContext.Capture(c, version));
            Check.True(!old.TryGetProperty("wearables", out _) && !old.TryGetProperty("equipmentStatus", out _));
            Check.True(old.GetProperty("inventory").EnumerateArray().All(i => !i.TryGetProperty("rulesId", out _)));
        }
        Check.True(!ActionUnderstanding.Candidates(c, includeLoadout: true).Any(o => o.Character?.Operation is "wear" or "attunement"));
        var current = HarnessCharacterContext.Capture(c, 21); var context = AdventureDirecting.Build(c, IntentContexts.Build(c, "穿戴", [], []));
        var frame = HarnessExecutionProtocol.Capture(c.Version, context, null, current, 21); HarnessExecutionProtocol.Validate(frame, c.Version, 21);
        Check.True(current.Wearables!.Items.Any(i => i.Effective)); Check.True(current.EquipmentStatus!.Armor.Length > 0);
        Check.Throws<InvalidDataException>(() => HarnessExecutionProtocol.Validate(frame, c.Version, 20));
        foreach (int v in Enumerable.Range(0, 21))
        {
            var record = HarnessTools.ForVersion(v).Single(t => t.Name == "world_record").InputSchema.GetProperty("properties");
            if (!record.TryGetProperty("items", out var items)) continue;
            var ids = items.GetProperty("items").GetProperty("properties").GetProperty("itemId").GetProperty("enum").EnumerateArray().Select(e => e.GetString());
            Check.True(!ids.Contains("cloak-of-protection"));
        }
        Check.True(StoryInventory.CatalogIds(includeWearables: true).Contains("cloak-of-protection") && !StoryInventory.CatalogIds().Contains("cloak-of-protection"));
        var magic = Item("boots-of-elvenkind");
        var entries = new[] { new LocalRuleEntry(magic.RulesId!, "magic_item", "精灵靴", "Boots of Elvenkind", [], "按稳定RulesId读取的完整规则夹具", "XDMG", 239,
            BuildCatalog.Revision, new string('a', 64), "translated") };
        var package = new LocalRulesPackage(1, "dnd2024", "zh-CN", BuildCatalog.Revision, ["XDMG"], new(false, false, [], new Dictionary<string, LocalRulesCount>()), entries);
        c.Character = c.Character! with { Inventory = [magic with { Name = "已改名" }, new("fake", "Boots of Elvenkind", 1, false), new("robe", "Robe", 1, false, "magic_item:xdmg:unknown")] };
        var detail = CharacterRuleDetails.Project(CharacterPlayEngine.View(c), package); Check.Equal(1, detail.ItemDetails!.Length);
        Check.Equal(magic.Id, detail.ItemDetails.Single().Id); Check.True(detail.ItemDetails.Single().Text.Contains("完整规则夹具"));
        return Task.CompletedTask;
    }

    public static async Task HttpReplayConcurrencyRestartPermissionAndPureReads()
    {
        var host = await Host.Start(); string hostToken = new('a', 64), guestToken = new('b', 64);
        var c = Campaign(true); c.PartyMembers.Add(new() { Id = "guest", TokenHash = JsonFiles.Hash(guestToken), Review = new(1, "approved"),
            Character = PlayResources.Ensure(BuildEvaluator.Create(FullCreationTests.Named("Guest"))) });
        c.HostReview = new(1, "approved");
        c.Character = c.Character! with { Build = c.Character!.Build! with { Identity = c.Character.Build!.Identity with { Backstory = "PRIVATE_BUILD_SENTINEL" } } };
        // Isolated fixture only: no production/active game data is changed.
        c = CloneWithToken(c, JsonFiles.Hash(hostToken));
        c.Events.Add(new(Id(), c.Version, "arrival", "隔离穿戴测试夹具", "", "authored", DateTimeOffset.UtcNow, null));
        host.App.Services.GetRequiredService<CampaignStore>().Create(c);
        host.Http.DefaultRequestHeaders.Authorization = new("Bearer", hostToken); string path = "/api/v1/campaigns/" + c.Id;
        CharacterPlayRequest? last = null;
        try
        {
            string database = Path.Combine(host.Root, "campaigns", c.Id + ".sqlite"); byte[] bytes = File.ReadAllBytes(database);
            var sheet = await host.Http.GetFromJsonAsync<CharacterSheetView>(path + "/character/sheet");
            Check.True(sheet!.Wearables is not null && sheet.Character.EquipmentStatus!.Armor.Length > 0);
            var snapshot = (await host.Get(c.Id))!; Check.True(snapshot.Character!.EquipmentStatus is not null && snapshot.Party!.Members.All(m => m.Character.EquipmentStatus is not null));
            Check.True(bytes.SequenceEqual(File.ReadAllBytes(database)), "GET must not persist status or bonuses");
            last = new(Id(), snapshot.Version, "wear", Key(c, "boots-of-elvenkind", "wear"));
            var race = await Task.WhenAll(host.Http.PostAsJsonAsync(path + "/character/commands", last), host.Http.PostAsJsonAsync(path + "/character/commands", last));
            Check.True(race.All(r => r.StatusCode == HttpStatusCode.OK));
            var results = await Task.WhenAll(race.Select(r => r.Content.ReadFromJsonAsync<ActionResponse>())); Check.True(results[0]!.Replayed != results[1]!.Replayed);
            snapshot = results[0]!.Snapshot; Check.Equal(c.Version + 1, snapshot.Version); Check.True(snapshot.Character!.Inventory.Single(i => i.Id == Item("boots-of-elvenkind").Id).Equipped);
            Check.Equal(HttpStatusCode.Conflict, (await host.Http.PostAsJsonAsync(path + "/character/commands", last with { Key = Key(c, "cloak-of-protection", "wear") })).StatusCode);
            var stale = new CharacterPlayRequest(Id(), c.Version, "wear", Key(c, "cloak-of-protection", "wear"));
            Check.Equal(HttpStatusCode.Conflict, (await host.Http.PostAsJsonAsync(path + "/character/commands", stale)).StatusCode);
            var competing = await Task.WhenAll(new[] { "cloak-of-protection", "ring-of-protection" }.Select(id => host.Http.PostAsJsonAsync(path + "/character/commands", new CharacterPlayRequest(Id(), snapshot.Version, "wear", Key(c, id, "wear")))));
            Check.Equal(1, competing.Count(r => r.StatusCode == HttpStatusCode.OK)); Check.Equal(1, competing.Count(r => r.StatusCode == HttpStatusCode.Conflict));
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", guestToken);
            snapshot = (await host.Get(c.Id))!;
            Check.True(snapshot.Party!.Members.Single(m => m.Id == "player").Character.Build is null);
            Check.True(!HarnessJson.Serialize(snapshot).Contains("PRIVATE_BUILD_SENTINEL"));
            bytes = File.ReadAllBytes(database);
            var denied = await host.Http.PostAsJsonAsync(path + "/character/commands", new CharacterPlayRequest(Id(), snapshot.Version, "wear", Key(c, "boots-of-elvenkind", "wear")));
            Check.Equal(HttpStatusCode.BadRequest, denied.StatusCode); Check.True(bytes.SequenceEqual(File.ReadAllBytes(database)));
            var guestSheet = await host.Http.GetFromJsonAsync<CharacterSheetView>(path + "/character/sheet"); Check.Equal("Guest", guestSheet!.Character.Name);
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", "invalid"); Check.Equal(HttpStatusCode.Unauthorized, (await host.Http.PostAsJsonAsync(path + "/character/commands", last)).StatusCode);
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", hostToken); snapshot = (await host.Get(c.Id))!;
            var attune = new CharacterPlayRequest(Id(), snapshot.Version, "attunement", Key(c, "cloak-of-protection", "attune"));
            var rest = await host.Http.PostAsJsonAsync(path + "/character/commands", attune); Check.Equal(HttpStatusCode.OK, rest.StatusCode);
            var restored = (await rest.Content.ReadFromJsonAsync<ActionResponse>())!; Check.Equal(3600L, restored.Snapshot.ElapsedSeconds); Check.True(restored.Snapshot.Character!.ShortRestDiceAvailable);
            Check.Equal(0, restored.Snapshot.PendingRulings.Length); Check.Equal(HttpStatusCode.Conflict, (await host.Http.PostAsJsonAsync(path + "/character/commands", attune with { Key = Key(c, "ring-of-protection", "attune") })).StatusCode);
            string root = host.Root; await host.DisposeAsync(); host = await Host.Start(root); host.Http.DefaultRequestHeaders.Authorization = new("Bearer", hostToken);
            var replay = await host.Http.PostAsJsonAsync(path + "/character/commands", attune); Check.Equal(HttpStatusCode.OK, replay.StatusCode);
            var replayed = (await replay.Content.ReadFromJsonAsync<ActionResponse>())!; Check.True(replayed.Replayed); Check.Equal(3600L, replayed.Snapshot.ElapsedSeconds);
            Check.Equal(HarnessJson.Serialize(restored.Resolution), HarnessJson.Serialize(replayed.Resolution));
            Check.True((await (await host.Http.PostAsJsonAsync(path + "/character/commands", last)).Content.ReadFromJsonAsync<ActionResponse>())!.Replayed);
            var store = host.App.Services.GetRequiredService<CampaignStore>();
            await store.Access(c.Id, hostToken, false, raw =>
            {
                Check.True(raw.Character!.EquipmentStatus is null); Check.Equal(HarnessJson.Serialize(c.Character!.BuildMechanics), HarnessJson.Serialize(raw.Character.BuildMechanics)); return Task.FromResult(0);
            }, default);
        }
        finally { await host.DisposeAsync(); }
    }
    public static async Task MissingAttunementHttpDetailsSelfAndRestart()
    {
        string root = Path.Combine(Path.GetTempPath(), "dicerealm-missing-attunement-" + Id()), rules = Path.Combine(root, "rules");
        Directory.CreateDirectory(rules);
        var cloak = Item("cloak-of-protection");
        var entry = new LocalRuleEntry(cloak.RulesId!, "magic_item", "防护斗篷", "Cloak of Protection", [], "缺库存同调的完整规则夹具", "XDMG", 1,
            BuildCatalog.Revision, new string('a', 64), "translated");
        var package = new LocalRulesPackage(1, "dnd2024", "zh-CN", BuildCatalog.Revision, ["XDMG"], new(false, false, ["synthetic"],
            new[] { "spell", "class", "subclass", "feature", "species", "background", "feat", "equipment", "magic_item", "monster", "condition", "rule", "language" }
                .ToDictionary(category => category, category => new LocalRulesCount(category == "magic_item" ? 1 : 0, category == "magic_item" ? 1 : 0))), [entry]);
        byte[] ruleBytes = System.Text.Encoding.UTF8.GetBytes(HarnessJson.Serialize(package)); string ruleVersion = JsonFiles.Hash(ruleBytes);
        JsonFiles.WriteBytes(Path.Combine(rules, ruleVersion + ".json"), ruleBytes); JsonFiles.Write(Path.Combine(rules, "active.json"), new LocalRulesPointer(ruleVersion));
        var dice = new SequenceDice(); var host = await Host.Start(root, dice, configure: b => b.Configuration["LocalRules:Directory"] = rules);
        string token = new('c', 64), otherToken = new('d', 64);
        try
        {
            var c = Campaign(true); c.HostReview = new(1, "approved"); c.SceneId = "causeway";
            c.Character = WithAttunements(c.Character!, "cloak-of-protection", "ring-of-protection", "headband-of-intellect");
            c.Character = c.Character with { HitPoints = 3, Inventory = c.Character.Inventory.Where(i => i.Id != cloak.Id).ToArray(),
                Resources = c.Character.Resources.Select(r => r with { Current = 0 }).ToArray() };
            var other = PlayResources.Ensure(BuildEvaluator.Create(FullCreationTests.Named("Other")));
            other = other with { HitPoints = 4, Resources = other.Resources.Select(r => r with { Current = 0 }).ToArray() };
            c.PartyMembers.Add(new() { Id = "other", TokenHash = JsonFiles.Hash(otherToken), Review = new(1, "approved"), Character = other });
            c.PendingIntents.Add(new() { Id = Id(), ActorId = "other", Text = "队友等待确认", Version = c.Version });
            c.PendingRolls.Add(new() { Id = Id(), ActorId = "other", Label = "队友待投掷", Description = "未同意", Version = c.Version });
            c = CloneWithToken(c, JsonFiles.Hash(token));
            c.Events.Add(new(Id(), c.Version, "arrival", "隔离缺库存同调夹具", "", "authored", DateTimeOffset.UtcNow, null));
            var store = host.App.Services.GetRequiredService<CampaignStore>(); store.Create(c);
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", token); string path = "/api/v1/campaigns/" + c.Id;
            string database = Path.Combine(root, "campaigns", c.Id + ".sqlite"); byte[] bytes = File.ReadAllBytes(database);
            var sheet = (await host.Http.GetFromJsonAsync<CharacterSheetView>(path + "/character/sheet"))!;
            var missing = sheet.Wearables!.Items.Single(i => i.ItemId == cloak.Id);
            Check.True(missing.Attuned && !missing.Equipped && !missing.Effective); Check.Equal("不在库存 · 仍同调", missing.Status);
            Check.True(!sheet.Character.Inventory.Any(i => i.Id == cloak.Id)); Check.Equal(3, sheet.Wearables.AttunementUsed);
            Check.True(!sheet.Wearables.Options.Any(o => o.ItemId == cloak.Id)); Check.True(!sheet.Wearables.Slots.Any(s => s.ItemId == cloak.Id));
            var ending = sheet.Wearables.AttunementOptions.Single(o => o.Key == "unattune:" + cloak.Id);
            Check.Equal(cloak.Id, ending.ItemId); Check.Equal(3600, ending.Seconds); Check.Equal("结束同调 防护斗篷", ending.Label); Check.True(!ending.Available);
            Check.Equal(entry.Text, sheet.ItemDetails!.Single(i => i.Id == cloak.Id).Text); Check.True(bytes.SequenceEqual(File.ReadAllBytes(database)));
            var blocked = new CharacterPlayRequest(Id(), sheet.Version, "attunement", ending.Key);
            Check.Equal(HttpStatusCode.Conflict, (await host.Http.PostAsJsonAsync(path + "/character/commands", blocked)).StatusCode);
            Check.True(bytes.SequenceEqual(File.ReadAllBytes(database)));
            // Shared pending and an unsafe rest location cannot block this instantaneous wear.
            var wear = new CharacterPlayRequest(Id(), sheet.Version, "wear", "wear:" + Item("boots-of-elvenkind").Id);
            var worn = await Post<ActionResponse>(host, c.Id, "character/commands", wear); Check.Equal(0L, worn.Snapshot.ElapsedSeconds);
            Check.True(worn.Snapshot.Character!.Inventory.Single(i => i.Id == Item("boots-of-elvenkind").Id).Equipped);
            await store.Access(c.Id, token, true, raw => { raw.SceneId = "harbor"; raw.PendingIntents.Clear(); raw.PendingRolls.Clear(); return Task.FromResult(0); }, default);
            sheet = (await host.Http.GetFromJsonAsync<CharacterSheetView>(path + "/character/sheet"))!;
            Check.True(sheet.Wearables!.AttunementOptions.Single(o => o.Key == ending.Key).Available);
            await store.Access(c.Id, token, false, raw =>
            {
                string before = HarnessJson.Serialize(raw);
                var self = HarnessCharacterContext.Capture(raw, 21); var context = AdventureDirecting.Build(raw, IntentContexts.Build(raw, "结束缺失实物的同调", [], []));
                var frame = HarnessExecutionProtocol.Capture(raw.Version, context, null, self, 21); HarnessExecutionProtocol.Validate(frame, raw.Version, 21);
                Check.True(self.Wearables!.Items.Single(i => i.ItemId == cloak.Id).Attuned && !self.Inventory.Any(i => i.Id == cloak.Id));
                Check.True(self.Wearables.Options.Length == 0 && self.Wearables.AttunementOptions.Length == 0);
                Check.True(HarnessCharacterContext.Capture(raw, 20).Wearables is null); Check.Equal(before, HarnessJson.Serialize(raw));
                return Task.FromResult(0);
            }, default);
            string inventory = HarnessJson.Serialize(sheet.Character.Inventory), mechanics = HarnessJson.Serialize(c.Character!.BuildMechanics), otherBefore = HarnessJson.Serialize(other);
            var request = new CharacterPlayRequest(Id(), sheet.Version, "attunement", ending.Key);
            var race = await Task.WhenAll(host.Http.PostAsJsonAsync(path + "/character/commands", request), host.Http.PostAsJsonAsync(path + "/character/commands", request));
            Check.True(race.All(r => r.StatusCode == HttpStatusCode.OK));
            var responses = await Task.WhenAll(race.Select(r => r.Content.ReadFromJsonAsync<ActionResponse>())); Check.True(responses[0]!.Replayed != responses[1]!.Replayed);
            var first = responses[0]!; Check.Equal(3600L, first.Snapshot.ElapsedSeconds); Check.Equal(sheet.Version + 1, first.Snapshot.Version);
            Check.Equal(2, WearableEquipment.Attunements(first.Snapshot.Character!).Length); Check.Equal(3, first.Snapshot.Character!.HitPoints);
            Check.Equal(1, first.Snapshot.Character.Resources.Single(r => r.Name == "Second Wind").Current); Check.True(first.Snapshot.Character.ShortRestDiceAvailable);
            Check.Equal(inventory, HarnessJson.Serialize(first.Snapshot.Character.Inventory)); Check.Equal(0, dice.Count); Check.Equal(0, first.Snapshot.PendingRulings.Length);
            bytes = File.ReadAllBytes(database);
            Check.Equal(HttpStatusCode.Conflict, (await host.Http.PostAsJsonAsync(path + "/character/commands", request with { Key = "attune:" + Item("ring-of-protection").Id })).StatusCode);
            Check.Equal(HttpStatusCode.Conflict, (await host.Http.PostAsJsonAsync(path + "/character/commands", request with { RequestId = Id() })).StatusCode);
            Check.True(bytes.SequenceEqual(File.ReadAllBytes(database)));
            await host.DisposeAsync(); host = await Host.Start(root, dice, configure: b => b.Configuration["LocalRules:Directory"] = rules);
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", token);
            var replay = await Post<ActionResponse>(host, c.Id, "character/commands", request);
            Check.True(replay.Replayed); Check.Equal(first.Snapshot.Version, replay.Snapshot.Version); Check.Equal(3600L, replay.Snapshot.ElapsedSeconds);
            Check.Equal(HarnessJson.Serialize(first.Resolution), HarnessJson.Serialize(replay.Resolution)); Check.Equal(inventory, HarnessJson.Serialize(replay.Snapshot.Character!.Inventory));
            Check.True((await Post<ActionResponse>(host, c.Id, "character/commands", wear)).Replayed);
            sheet = (await host.Http.GetFromJsonAsync<CharacterSheetView>(path + "/character/sheet"))!;
            Check.True(!sheet.Wearables!.Items.Any(i => i.ItemId == cloak.Id) && !sheet.ItemDetails!.Any(i => i.Id == cloak.Id));
            Check.True(!sheet.Wearables.AttunementOptions.Any(o => o.Key == ending.Key)); Check.Equal(0, dice.Count);
            await host.App.Services.GetRequiredService<CampaignStore>().Access(c.Id, token, false, raw =>
            {
                Check.True(raw.Character!.EquipmentStatus is null); Check.Equal(mechanics, HarnessJson.Serialize(raw.Character.BuildMechanics));
                Check.Equal(otherBefore, HarnessJson.Serialize(raw.PartyMembers[0].Character)); Check.True(!raw.Character.Inventory.Any(i => i.Id == cloak.Id));
                return Task.FromResult(0);
            }, default);
        }
        finally { await host.DisposeAsync(); }
    }

    public static async Task RealPiV21WearDirectAttunementOwnConsent()
    {
        Exception? failure = null;
        var model = new Model((call, request) =>
        {
            try
            {
                var frame = HarnessExecutionProtocolTests.Frame(request);
                var self = frame.GetProperty("self");
                Check.True(self.TryGetProperty("equipmentStatus", out _));
                var itemSchema = request.Tools.Single(t => t.Name == "world_record").InputSchema.GetProperty("properties").GetProperty("items").GetProperty("items");
                Check.True(!itemSchema.GetProperty("properties").GetProperty("itemId").TryGetProperty("enum", out _));
                Check.True(itemSchema.GetProperty("required").EnumerateArray().Any(e => e.GetString() == "source"));
                if (call == 1)
                {
                    Check.True(!self.TryGetProperty("wearables", out _)); // Initial conversation is compact; persisted self stays complete.
                    var source = new StoryItemSource("current_scene", frame.GetProperty("map").GetProperty("sceneId").GetString()!, "主人备有一双精灵靴和一件防护斗篷，允许玩家取用。");
                    return Tool("world_record", new NarrativeHarnessArgs("收到精灵靴和防护斗篷。", [], Items: [new("boots-of-elvenkind", "", 1, source), new("cloak-of-protection", "", 1, source)], Complete: false));
                }
                var items = self.TryGetProperty("wearables", out var wearables) ? wearables.GetProperty("items").EnumerateArray().ToArray() : [];
                if (call != 6) Check.Equal(3, wearables.GetProperty("attunementLimit").GetInt32());
                if (call == 3) Check.True(items.Single(i => i.GetProperty("rulesId").GetString() == WearableCatalog.ById("boots-of-elvenkind")!.RulesId).GetProperty("effective").GetBoolean());
                if (call == 5)
                {
                    Check.True(self.GetProperty("equipmentStatus").GetProperty("armorClassSources").EnumerateArray().Any(s => s.GetString()!.Contains("防护斗篷 +1")));
                    Check.True(items.Single(i => i.GetProperty("rulesId").GetString() == WearableCatalog.ById("cloak-of-protection")!.RulesId).GetProperty("attuned").GetBoolean());
                    return Text("穿戴并完成本人一小时同调。");
                }
                if (call == 6)
                {
                    Check.True(!self.TryGetProperty("wearables", out _));
                    Check.True(!self.GetProperty("inventory").EnumerateArray().Any(i => i.TryGetProperty("rulesId", out var rules) && rules.GetString() == WearableCatalog.ById("cloak-of-protection")!.RulesId));
                }
                if (call == 7)
                {
                    Check.True(!items.Any(i => i.GetProperty("rulesId").GetString() == WearableCatalog.ById("cloak-of-protection")!.RulesId));
                    return Text("缺失实物的同调已结束，没有重造库存。");
                }
                string label = call == 2 ? "穿戴 精灵靴" : call == 3 ? "穿戴 防护斗篷" : call == 6 ? "结束同调 防护斗篷" : "同调 防护斗篷";
                var candidate = frame.GetProperty("context").GetProperty("intent").GetProperty("candidates").EnumerateArray().Single(c => c.GetProperty("label").GetString() == label);
                return Tool("actions_propose", new { candidateId = candidate.GetProperty("id").GetString() });
            }
            catch (Exception e) { failure = e; throw; }
        });
        var configure = Configure(model, extra: b =>
        {
            b.Configuration["Harness:AgentHostPath"] = HarnessPiTests.Entry();
            b.Services.AddSingleton<IHarnessRuntime, PiHarnessRuntime>();
        });
        var dice = new SequenceDice(); var host = await Host.Start(dice: dice, configure: configure);
        try
        {
            var owner = await Create(host, HarnessItemSearchTests.WithEvidence("主人备有一双精灵靴和一件防护斗篷，允许玩家取用。")); var guest = await HarnessBoundaryTests.Guest(host, owner); string id = owner.Snapshot.Id;
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken); var state = (await host.Get(id))!;
            var input = new HarnessInputRequest(Id(), state.Version, "收下靴子与斗篷，穿戴两件并同调斗篷");
            var run = await Settled(host, id, (await Post<HarnessRunView>(host, id, "harness/runs", input)).Id, 3000);
            Check.True(run.Status == "waiting", run.Status + "/" + run.Error + " " + failure); Check.Equal("intent", run.Wait!.Kind); Check.Equal(4, model.Calls); Check.Equal(0, dice.Count);
            state = (await host.Get(id))!; Check.Equal(0L, state.ElapsedSeconds);
            Check.True(state.Character!.Inventory.Where(i => i.RulesId is not null).All(i => i.Equipped));
            Check.Equal(0, WearableEquipment.Attunements(state.Character).Length); Check.Equal(1, state.PendingIntent!.Options.Length);
            Check.True(state.PendingIntent.Options.Single().Details.Cost.Contains("3600"));
            var consent = new IntentResponseRequest(Id(), state.Version, state.PendingIntent.Id, "choose", state.PendingIntent.Options.Single().Id);
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
            Check.Equal(HttpStatusCode.Conflict, (await host.Http.PostAsJsonAsync("/api/v1/campaigns/" + id + "/intents/respond", consent)).StatusCode);
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var confirmed = await Post<ActionResponse>(host, id, "intents/respond", consent);
            Check.Equal(3600L, confirmed.Snapshot.ElapsedSeconds); Check.True(confirmed.Snapshot.Character!.ShortRestDiceAvailable); Check.Equal(0, dice.Count); Check.Equal(0, confirmed.Snapshot.PendingRulings.Length);
            Check.True((await Post<ActionResponse>(host, id, "intents/respond", consent)).Replayed);
            await Post<HarnessRunView>(host, id, $"harness/runs/{run.Id}/resume", new HarnessResumeRequest(Id(), confirmed.Snapshot.Version));
            run = await Settled(host, id, run.Id, 3000); Check.True(run.Status == "completed", run.Status + "/" + run.Error + " " + failure); Check.Equal(5, model.Calls);
            var saved = host.App.Services.GetRequiredService<HarnessRunStore>().Read(id, "player", run.Id)!;
            Check.Equal(HarnessTools.CurrentVersion, saved.ToolContractVersion); Check.True(saved.Steps.Where(s => s.Kind == "model").All(s => s.ExecutionFrame!.Self!.Wearables is not null));
            await host.App.Services.GetRequiredService<CampaignStore>().Access(id, owner.AccessToken, true, raw =>
            {
                raw.Character = raw.Character! with { Inventory = raw.Character!.Inventory.Where(i => i.RulesId != WearableCatalog.ById("cloak-of-protection")!.RulesId).ToArray() };
                return Task.FromResult(0);
            }, default);
            state = (await host.Get(id))!;
            var missingInput = new HarnessInputRequest(Id(), state.Version, "结束不在库存的防护斗篷同调");
            var missingRun = await Settled(host, id, (await Post<HarnessRunView>(host, id, "harness/runs", missingInput)).Id, 3000);
            Check.True(missingRun.Status == "waiting", missingRun.Status + "/" + missingRun.Error + " " + failure); Check.Equal(6, model.Calls);
            var missingFrame = host.App.Services.GetRequiredService<HarnessRunStore>().Read(id, "player", missingRun.Id)!.Steps.First(s => s.Kind == "model").ExecutionFrame!.Self!;
            var missingItem = missingFrame.Wearables!.Items.Single(i => i.RulesId == WearableCatalog.ById("cloak-of-protection")!.RulesId);
            Check.Equal("不在库存 · 仍同调", missingItem.Status); Check.True(missingItem.Attuned && !missingItem.Effective);
            state = (await host.Get(id))!; Check.Equal(3600L, state.ElapsedSeconds); Check.Equal(1, WearableEquipment.Attunements(state.Character!).Length);
            Check.True(state.PendingIntent!.Options.Single().Details.Cost.Contains("3600"));
            var missingConsent = new IntentResponseRequest(Id(), state.Version, state.PendingIntent.Id, "choose", state.PendingIntent.Options.Single().Id);
            var ended = await Post<ActionResponse>(host, id, "intents/respond", missingConsent);
            Check.Equal(7200L, ended.Snapshot.ElapsedSeconds); Check.Equal(0, WearableEquipment.Attunements(ended.Snapshot.Character!).Length);
            Check.True(!ended.Snapshot.Character!.Inventory.Any(i => i.RulesId == WearableCatalog.ById("cloak-of-protection")!.RulesId));
            await Post<HarnessRunView>(host, id, $"harness/runs/{missingRun.Id}/resume", new HarnessResumeRequest(Id(), ended.Snapshot.Version));
            missingRun = await Settled(host, id, missingRun.Id, 3000);
            Check.True(missingRun.Status == "completed", missingRun.Status + "/" + missingRun.Error + " " + failure); Check.Equal(7, model.Calls);
            string root = host.Root; await host.DisposeAsync(); host = await Host.Start(root, configure: Configure(model, extra: b => b.Configuration["Harness:Enabled"] = "false"));
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            Check.True((await Post<HarnessRunView>(host, id, "harness/runs", input)).Replayed);
            Check.True((await Post<HarnessRunView>(host, id, "harness/runs", missingInput)).Replayed);
            Check.True((await Post<ActionResponse>(host, id, "intents/respond", missingConsent)).Replayed);
            Check.Equal(7, model.Calls); Check.Equal(0, dice.Count); Check.Equal(7200L, (await host.Get(id))!.ElapsedSeconds);
        }
        finally { await host.DisposeAsync(); }
    }
    private static Campaign CloneWithToken(Campaign c, string tokenHash)
    {
        var node = JsonSerializer.SerializeToNode(c, JsonFiles.Options)!; node["tokenHash"] = tokenHash; return node.Deserialize<Campaign>(JsonFiles.Options)!;
    }

    public static async Task AcquisitionVersionBoundaryReplayLossAndNewToolId()
    {
        var model = new Model((_, _) => throw new Exception("No model call allowed in this domain transaction test"));
        var host = await Host.Start(configure: Configure(model));
        try
        {
            var owner = await Create(host); string id = owner.Snapshot.Id; var game = host.App.Services.GetRequiredService<GameService>();
            var auth = await game.AuthorizeHarness(id, owner.AccessToken, default); string rootId = Id();
            var grant = new NarrativeHarnessArgs("得到两枚戒指。", [], Items: [new("ring-of-protection", "", 2)]);
            async Task<HarnessToolOutcome> ToolCall(NarrativeHarnessArgs args, int version, int contract, string? command = null) => await game.HarnessTool(id, owner.AccessToken, "player", rootId,
                "获得两枚戒指", version, command ?? Id(), HarnessJson.Fingerprint(HarnessJson.Element(args)), new("world_record", HarnessJson.Element(args), Id()), [], default, auth.Profile, contract, true, []);
            var database = Path.Combine(host.Root, "campaigns", id + ".sqlite"); byte[] bytes = File.ReadAllBytes(database);
            for (int v = 18; v <= 20; v++)
            {
                try { await ToolCall(grant, auth.Version, v); throw new Exception("old contract must reject new catalog id"); }
                catch (GameException e) { Check.Equal("invalid_story_items", e.Code); }
                Check.True(bytes.SequenceEqual(File.ReadAllBytes(database)));
            }
            try { await ToolCall(grant with { Items = [new("ring-of-protection", "伪造名字", 2)] }, auth.Version, 21); throw new Exception("catalog names are server-owned"); }
            catch (GameException e) { Check.Equal("invalid_story_items", e.Code); }
            Check.True(bytes.SequenceEqual(File.ReadAllBytes(database)));
            string command = Id(); var first = await ToolCall(grant, auth.Version, 21, command);
            var snapshot = (await host.Get(id))!; var rings = snapshot.Character!.Inventory.Where(i => i.RulesId == WearableCatalog.ById("ring-of-protection")!.RulesId).ToArray();
            Check.Equal(2, rings.Length); Check.True(rings.All(i => i.Quantity == 1)); Check.True(rings.Select(i => i.Id).Distinct().Count() == 2);
            Check.True(rings.All(i => i.Id.StartsWith(StoryInventory.InstancePrefix(rootId, "ring-of-protection"), StringComparison.Ordinal)));
            Check.Equal(HarnessJson.Serialize(first), HarnessJson.Serialize(await ToolCall(grant, auth.Version, 21, command)));
            var store = host.App.Services.GetRequiredService<CampaignStore>();
            await store.Access(id, owner.AccessToken, true, raw =>
            {
                raw.ActingCharacter = raw.ActingCharacter with { Inventory = raw.ActingCharacter.Inventory.Where(i => i.RulesId != rings[0].RulesId).ToArray() };
                return Task.FromResult(0);
            }, default);
            await ToolCall(grant, snapshot.Version, 21); Check.True(!(await host.Get(id))!.Character!.Inventory.Any(i => i.RulesId == rings[0].RulesId));
            snapshot = (await host.Get(id))!; bytes = File.ReadAllBytes(database);
            try { await ToolCall(grant with { Items = [new("ring-of-protection", "", 3)] }, snapshot.Version, 21); throw new Exception("different quantity must conflict"); }
            catch (GameException e) { Check.Equal("invalid_story_items", e.Code); }
            Check.True(bytes.SequenceEqual(File.ReadAllBytes(database)));
            var custom = new NarrativeHarnessArgs("同名剧情道具不是魔法物品。", [], Items: [new("", "Ring of Protection", 1), new("torch", "", 2)]);
            await ToolCall(custom, snapshot.Version, 21); snapshot = (await host.Get(id))!;
            var prop = snapshot.Character!.Inventory.Single(i => i.Name == "Ring of Protection"); Check.True(prop.RulesId is null && prop.Id.StartsWith("story-item:", StringComparison.Ordinal));
            Check.True(!CharacterPlayEngine.View(TestContent.Campaign(character: snapshot.Character)).Wearables!.Items.Any(i => i.ItemId == prop.Id));
            Check.Equal(0, model.Calls);
            string root = host.Root; await host.DisposeAsync(); host = await Host.Start(root, configure: Configure(model)); game = host.App.Services.GetRequiredService<GameService>();
            host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var current = (await host.Get(id))!; await ToolCall(grant, current.Version, 21);
            Check.True(!(await host.Get(id))!.Character!.Inventory.Any(i => i.RulesId == rings[0].RulesId)); Check.Equal(0, model.Calls);
        }
        finally { await host.DisposeAsync(); }
    }
}
