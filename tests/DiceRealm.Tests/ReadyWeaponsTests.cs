using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Tests;

internal static class ReadyWeaponsTests
{
    private static CharacterPlayRequest Equip(Campaign c, string id, int value = 1) => new(Guid.NewGuid().ToString(), c.Version, "equip", id, value);
    public static Task MultipleReadyAndActive()
    {
        var c = TestContent.Campaign("harbor");
        c.Character = CharacterEngine.Create("Three weapons", CharacterEngine.Wizard) with
        { Inventory = [new("dagger", "Dagger", 2, false), new("shortsword", "Shortsword", 1, false), new("shortbow", "Shortbow", 1, false)] };
        var engine = new CharacterPlayEngine(new(new SequenceDice()));
        foreach (var id in new[] { "dagger", "shortsword", "shortbow" }) engine.Resolve(c, Equip(c, id));
        Check.Equal(3, c.Character.Inventory.Count(i => i.Equipped));
        Check.Equal(2, c.Character.Inventory.Single(i => i.Id == "dagger").Quantity);
        Check.Equal("shortbow", PlayCatalog.ActiveWeapon(c.Character)!.Id);
        Check.True(CharacterPlayEngine.View(c).Equipment.Single(e => e.Id == "dagger").CanActivate);
        engine.Resolve(c, Equip(c, "dagger"));
        Check.Equal("dagger", PlayCatalog.ActiveWeapon(c.Character)!.Id);
        Check.Equal(3, c.Character.Inventory.Count(i => i.Equipped));
        Check.Equal("dagger", CharacterEngine.Weapon(c.Character)!.Id);
        Check.True(ActionUnderstanding.Candidates(c).Any(a => a.Character is { Operation: "equip", Key: "shortsword", Value: 1 }));
        Check.True(!ActionUnderstanding.Candidates(c, includeWeaponSelection: false).Any(a => a.Character is { Operation: "equip", Key: "shortsword", Value: 1 }));
        string current = JsonSerializer.Serialize(c, JsonFiles.Options);
        c = JsonSerializer.Deserialize<Campaign>(current, JsonFiles.Options)!;
        Check.Equal("dagger", PlayCatalog.ActiveWeapon(c.ActingCharacter)!.Id);
        Check.Equal(current, JsonSerializer.Serialize(c, JsonFiles.Options));
        engine.Resolve(c, Equip(c, "dagger", 0));
        Check.True(PlayCatalog.ActiveWeapon(c.ActingCharacter) is null);
        Check.Equal(2, c.ActingCharacter.Inventory.Count(i => i.Equipped));
        Check.Equal(0, PlayCatalog.HeldItems(c.ActingCharacter).Length);
        // Historical single equipped weapon remains readable without a migration/write.
        var old = CharacterEngine.Create("Old", CharacterEngine.Wizard);
        Check.Equal("quarterstaff", PlayCatalog.ActiveWeapon(old)!.Id);
        Check.True(!JsonSerializer.Serialize(old, JsonFiles.Options).Contains("activeWeaponId"));
        // A shield considers the current weapon, not a bow carried on the back.
        c.Character = PlayResources.Ensure(StarterCharacter.Create("Shield")) with
        { Inventory = [new("dagger", "Dagger", 1, true), new("shortbow", "Shortbow", 1, true), new("shield", "Shield", 1, false)] };
        c.Character = c.Character with { PlayState = c.Character.PlayState! with { ActiveWeaponId = "dagger" } };
        engine.Resolve(c, Equip(c, "shield"));
        Check.Equal(13, c.Character.ArmorClass); // unarmored DEX + shield, not a carried bow
        long shieldTime = c.ElapsedSeconds;
        engine.Resolve(c, Equip(c, "shortbow"));
        Check.Equal(shieldTime + 6, c.ElapsedSeconds); Check.Equal(11, c.Character.ArmorClass);
        engine.Resolve(c, Equip(c, "dagger"));
        Check.Equal(shieldTime + 12, c.ElapsedSeconds); Check.Equal(13, c.Character.ArmorClass);
        Check.True(c.Character.Inventory.Single(i => i.Id == "shortbow").Equipped);
        c.Character = c.Character with { Conditions = ["Prone"], Inventory = [.. c.Character.Inventory, new("greatsword", "Greatsword", 1, true)] };
        new CharacterEngine(new SequenceDice()).Resolve(c, "rest.recover", "");
        Check.Equal("dagger", PlayCatalog.ActiveWeapon(c.Character)!.Id);
        Check.True(c.Character.Inventory.Single(i => i.Id == "shield").Equipped);
        Check.True(!c.Character.Conditions.Contains("Prone"));
        return Task.CompletedTask;
    }
    public static Task CreationAndStandardCombat()
    {
        var build = FullCreationTests.Complete("rogue", "elf", "sage");
        // Use the actual owned equipment of this complete build and add affordable weapons if needed.
        var preview = BuildEvaluator.Create(build);
        var owned = preview.Inventory.Select(i => i.Id).ToHashSet();
        build = build with { Purchases = build.Purchases.Concat(new[] { "dagger", "shortsword", "shortbow" }.Where(id => !owned.Contains(id)).Select(id => new BuildPurchase(id, 1))).ToArray(),
            Equipped = ["dagger", "shortsword", "shortbow"] };
        var created = BuildEvaluator.Create(build);
        Check.Equal(3, created.Inventory.Count(i => i.Equipped));
        Check.Equal("dagger", PlayCatalog.ActiveWeapon(created)!.Id);
        var c = StandardCombatTests.Campaign(hp: 1);
        c.Character = c.Character.Required() with { Inventory = c.Character.Required().Inventory.Concat([new Item("dagger", "Dagger", 2, false), new Item("shortbow", "Shortbow", 1, false)]).ToArray() };
        c.Character = PlayCatalog.SetEquipment(PlayCatalog.SetEquipment(c.Character, "shortbow", true), "dagger", true);
        var combat = new CombatEngine(new SequenceDice(20, 1, 15, 4));
        combat.Resolve(c, "combat.start", "");
        StandardCombatTests.E(c).X = 2; StandardCombatTests.E(c).Y = 2;
        Check.True(Adventure.Choices(c).Any(a => a.Kind == "combat.attack" && a.Label.Contains("Dagger")));
        combat.Resolve(c, "combat.end_turn", "");
        Check.Equal(0, c.Character.HitPoints);
        Check.True(!c.Character.Inventory.Single(i => i.Id == "dagger").Equipped);
        Check.True(c.Character.Inventory.Single(i => i.Id == "greatsword").Equipped && c.Character.Inventory.Single(i => i.Id == "shortbow").Equipped);
        Check.True(PlayCatalog.ActiveWeapon(c.Character) is null);
        Check.Equal("dagger", StandardCombatTests.P(c).Standard!.DroppedItems.Single().Id);
        StandardCombatEngine.ValidateState(c);
        return Task.CompletedTask;
    }
    public static async Task HttpReplayAndRestart()
    {
        var h = await Host.Start(broken: new BrokenText());
        var owner = await h.Create(); var s = owner.Snapshot; string path = $"/api/v1/campaigns/{s.Id}";
        var grant = new AdjustCharacterRequest(Guid.NewGuid().ToString(), s.Version, "player", "isolated equipment regression", "XPHB 2024",
            [new("inventory", "dagger", 2), new("inventory", "shortsword", 1), new("inventory", "shortbow", 1)]);
        var granted = await h.Http.PostAsJsonAsync(path + "/characters/adjust", grant);
        Check.Equal(HttpStatusCode.OK, granted.StatusCode); s = (await granted.Content.ReadFromJsonAsync<ActionResponse>())!.Snapshot;
        CharacterPlayRequest? last = null;
        foreach (var id in new[] { "dagger", "shortsword", "shortbow" })
        {
            last = new(Guid.NewGuid().ToString(), s.Version, "equip", id);
            var response = await h.Http.PostAsJsonAsync(path + "/character/commands", last);
            Check.Equal(HttpStatusCode.OK, response.StatusCode); s = (await response.Content.ReadFromJsonAsync<ActionResponse>())!.Snapshot;
        }
        Check.True(new[] { "dagger", "shortsword", "shortbow" }.All(id => s.Character.Required().Inventory.Single(i => i.Id == id).Equipped));
        var root = h.Root; await h.DisposeAsync();
        await using var reopened = await Host.Start(root, broken: new BrokenText());
        reopened.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        var replay = await reopened.Http.PostAsJsonAsync(path + "/character/commands", last);
        Check.True((await replay.Content.ReadFromJsonAsync<ActionResponse>())!.Replayed);
        var sheet = (await reopened.Http.GetFromJsonAsync<CharacterSheetView>(path + "/character/sheet"))!;
        Check.Equal(s.Version, sheet.Version); Check.True(sheet.Equipment.Single(e => e.Id == "shortbow").IsActive);
        Check.True(sheet.Equipment.Single(e => e.Id == "dagger").CanActivate);
    }
}
