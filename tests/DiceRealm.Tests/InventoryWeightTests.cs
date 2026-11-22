using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;

namespace DiceRealm.Tests;

internal static class InventoryWeightTests
{
    public static Task Projection()
    {
        var c = TestContent.Campaign("harbor");
        c.Character = PlayResources.Ensure(c.Character!) with { Inventory = [
            new("longsword", "改名武器", 2, true), new("chain-mail", "护甲", 1, true),
            new("explorer-s-pack", "套装含内容", 1, false), new("gold-piece", "金币", 53, false),
            new("instance:amulet", "护符", 1, true, "magic_item:xdmg:amulet-of-health"),
            new("instance:necklace", "项链", 1, false, "xdmg:necklace-of-adaptation"),
            new("mystery", "Longsword", 3, false), new("holy-symbol", "来源未计重", 2, false),
            new("ignored", "零数量", 0, false), new("negative", "旧负数量", -1, false)] };
        c.Character = c.Character with { PlayState = c.Character.PlayState! with {
            Attunements = [new("not-carried", "magic_item:xdmg:amulet-of-health")] } };
        string before = HarnessJson.Serialize(c);
        var weight = CharacterPlayEngine.View(c).Weight!;
        Check.Equal(119.06m, weight.TotalPounds); Check.Equal(5L, weight.UnknownCount); Check.Equal("lb", weight.Unit);
        Check.Equal(before, HarnessJson.Serialize(c));
        c.Character = c.Character with { Inventory = [
            new("shield", "显示名不定身份", 2, false, "equipment:xphb:robe"),
            new("linked", "内容身份", 1, false), new("longsword", "显式未知不回退", 4, false, "xphb:missing"),
            new("loose-coins", "金币", 50, false, "equipment:xphb:gold-piece"),
            new("silver", "银币", 1, false, "xphb:silver-piece"),
            new("copper-piece", "覆盖runtime身份", 2, false, "equipment:xphb:missing")] };
        c.Adventure = c.Adventure! with { Items = [new("linked", "披风", "magic_item:xdmg:amulet-of-health"),
            new("shield", "冲突内容身份", "equipment:xphb:chain-mail")] };
        weight = CharacterPlayEngine.View(c).Weight!;
        Check.Equal(10.02m, weight.TotalPounds); Check.Equal(6L, weight.UnknownCount);
        var empty = InventoryWeight.Project(c.Character with { Inventory = [] });
        Check.Equal(0m, empty.TotalPounds); Check.Equal(0L, empty.UnknownCount);
        Check.True(BuildCatalog.Get().Equipment.Single(e => e.Id == "spellbook").WeightPounds is null);
        return Task.CompletedTask;
    }

    public static Task CapacityAndMetadata()
    {
        var character = BuildEvaluator.Create(FullCreationTests.Complete("fighter", "human", "soldier")) with
        { Abilities = [new("strength", 10, 0)], Inventory = [], Features = [] };
        foreach (var (size, capacity) in new[] { ("T", 75m), ("S", 150m), ("M", 150m), ("L", 300m), ("H", 600m), ("G", 1200m) })
        {
            var weight = InventoryWeight.Project(character with { BuildMechanics = character.BuildMechanics! with { Size = size } });
            Check.True(weight.HasCapacity); Check.Equal(capacity, weight.CapacityPounds);
        }
        foreach (var invalid in new[] { character with { Abilities = [] }, character with { Abilities = [new("strength", 0, 0)] },
            character with { BuildMechanics = null }, character with { BuildMechanics = character.BuildMechanics! with { Size = "unknown" } } })
            Check.True(!InventoryWeight.Project(invalid).HasCapacity);
        foreach (var (size, capacity) in new[] { ("T", 150m), ("S", 150m), ("M", 300m), ("L", 600m), ("H", 1200m) })
        {
            var weight = InventoryWeight.Project(character with { Features = ["Powerful Build"], BuildMechanics = character.BuildMechanics! with { Size = size } });
            Check.True(weight.HasCapacity); Check.Equal(capacity, weight.CapacityPounds);
        }
        var goliath = BuildEvaluator.Create(FullCreationTests.Complete("fighter", "goliath", "soldier"));
        Check.Equal(goliath.Abilities.Single(a => a.Name == "strength").Score * 30m, InventoryWeight.Project(goliath).CapacityPounds);
        foreach (var equipment in BuildCatalog.Get().Equipment.Where(e => e.Id != "spellbook"))
        {
            var metadata = ItemMetadata.Find(BuildCatalog.ItemId(equipment.Id), null)!;
            Check.Equal(equipment.WeightPounds, metadata.WeightPounds);
            if (equipment.Price is not null) Check.Equal((decimal?)equipment.Price, metadata.PriceCp);
            else if (equipment.Id == "sling-bullet") Check.Equal(0.2m, metadata.PriceCp); // Sourced fractional cp cannot fit the older integer purchase catalog.
            else Check.True(metadata.PriceCp is null);
        }
        var potion = ItemMetadata.Find("not-a-catalog-id", "magic_item:xdmg:potion-of-healing")!;
        Check.Equal(0.5m, potion.WeightPounds); Check.Equal(5000m, potion.PriceCp); Check.Equal("common", potion.Rarity);
        var health = ItemMetadata.Find("renamed", "xdmg:amulet-of-health")!;
        Check.Equal(1m, health.WeightPounds); Check.Equal("rare", health.Rarity); Check.True(health.PriceCp is null);
        var cloak = ItemMetadata.Find("renamed", "magic_item:xdmg:cloak-of-protection")!;
        Check.True(cloak.WeightPounds is null && cloak.PriceCp is null); Check.Equal("uncommon", cloak.Rarity);
        Check.True(ItemMetadata.Find("longsword", "xphb:unknown") is null && ItemMetadata.Find("longsword", "") is null);
        Check.True(ItemMetadata.Find("Longsword", null) is null);
        Check.Equal(1m, ItemMetadata.Find("copper-piece", null)!.PriceCp);
        Check.Equal(10m, ItemMetadata.Find("alias", "xphb:silver-piece")!.PriceCp);
        return Task.CompletedTask;
    }

    public static async Task HttpPureRead()
    {
        await using var host = await Host.Start();
        var owner = await host.Create();
        var store = host.App.Services.GetRequiredService<CampaignStore>();
        await store.Access(owner.Snapshot.Id, owner.AccessToken, true, c =>
        {
            c.Character = c.Character! with { Inventory = [new("gold-piece", "金币", 51, false), new("unknown", "未知物品", 2, false)] };
            return Task.FromResult(0);
        });
        string db = Path.Combine(host.Root, "campaigns", owner.Snapshot.Id + ".sqlite");
        byte[] before = File.ReadAllBytes(db);
        host.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        string path = "/api/v1/campaigns/" + owner.Snapshot.Id + "/character/sheet";
        for (int i = 0; i < 2; i++)
        {
            using var response = await host.Http.GetAsync(path); Check.Equal(HttpStatusCode.OK, response.StatusCode);
            var wire = await response.Content.ReadFromJsonAsync<JsonElement>(); var weight = wire.GetProperty("weight");
            Check.True(weight.EnumerateObject().Select(p => p.Name).Order().SequenceEqual(new[] { "capacityNotice", "capacityPounds", "hasCapacity", "totalPounds", "unit", "unknownCount" }));
            Check.Equal(1.02m, weight.GetProperty("totalPounds").GetDecimal()); Check.Equal(2L, weight.GetProperty("unknownCount").GetInt64());
            Check.Equal("lb", weight.GetProperty("unit").GetString());
            var coin = wire.GetProperty("itemDetails").EnumerateArray().Single(x => x.GetProperty("id").GetString() == "gold-piece");
            Check.True(coin.GetProperty("hasWeight").GetBoolean() && coin.GetProperty("hasPrice").GetBoolean());
            Check.Equal(0.02m, coin.GetProperty("weightPounds").GetDecimal()); Check.Equal(100m, coin.GetProperty("priceCp").GetDecimal());
        }
        host.Http.DefaultRequestHeaders.Authorization = new("Bearer", "invalid");
        Check.Equal(HttpStatusCode.Unauthorized, (await host.Http.GetAsync(path)).StatusCode);
        Check.True(before.SequenceEqual(File.ReadAllBytes(db)), "Sheet weight is a pure authorized read");
        var old = CharacterPlayEngine.View(TestContent.Campaign("harbor")) with { Weight = null };
        Check.True(!JsonSerializer.SerializeToElement(old, JsonFiles.Options).TryGetProperty("weight", out _));
    }
}
