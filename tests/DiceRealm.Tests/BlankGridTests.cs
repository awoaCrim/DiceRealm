using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

// An authored fight in a scene without a battle map: the first action started there installs one
// blank 5-foot grid, an ordinary published player map the board and the combat engine can use.
internal static class BlankGridTests
{
    public static async Task AuthoredFightWithoutMapGetsOneBlankGrid()
    {
        var model = new Model((_, _) => throw new Exception("Starting an action check never calls the model"));
        await using var h = await Host.Start(configure: Configure(model));
        var owner = await Create(h, StandardCombatTests.Document());
        string id = owner.Snapshot.Id;
        Check.Equal("causeway", owner.Snapshot.Scene.Id);
        var game = h.App.Services.GetRequiredService<GameService>();
        var maps = h.App.Services.GetRequiredService<MapCatalog>();
        Check.Equal(0, maps.List(id, true, true).Maps.Length);
        await game.ValidateHarnessStart(id, owner.AccessToken, owner.Snapshot.Version, default, "向守卫发起挑战");
        MapAssetView? Shown() => maps.List(id, false, false, true, "causeway").Maps.SingleOrDefault(m => m.CurrentScene);
        var grid = Shown()!;
        Check.True(grid is { Status: "ready", Published: true, Edition: "player", Kind: "battle", Purpose: "tactical", Width: 768, Height: 512 },
            HarnessJson.Serialize(grid));
        // The engine reads it as a calibrated 12x8 board of 5-foot cells.
        var layout = BoardCombat.Layout(grid with { Grid = MapScale.TacticalGrid(grid) });
        Check.Equal(12, layout.Width); Check.Equal(8, layout.Height);
        // The DM's frame now has a board on it, and (v58) is told the authored enemies can fight as they are.
        var auth = await game.AuthorizeHarness(id, owner.AccessToken, default);
        var frame = await game.ReadHarnessExecution(id, owner.AccessToken, auth.ActorId, Id(), "向守卫发起挑战", auth.Version, default, 58);
        Check.Equal(grid.Id, frame.Board!.State!.Map.Id);
        Check.True(frame.WorkingContext!.Guidance.Contains(GameService.AuthoredEncounterRule));
        HarnessExecutionProtocol.Validate(frame, frame.Version, 58);
        var older = await game.ReadHarnessExecution(id, owner.AccessToken, auth.ActorId, Id(), "向守卫发起挑战", auth.Version, default, 57);
        Check.True(!older.WorkingContext!.Guidance.Contains(GameService.AuthoredEncounterRule));
        // Starting another action there replays; nothing is added.
        await game.ValidateHarnessStart(id, owner.AccessToken, owner.Snapshot.Version, default, "再看一眼守卫");
        Check.Equal(1, maps.List(id, true, true).Maps.Length);
        // The host withdraws it: the grid is not put back by the next action.
        grid = maps.Publish(id, grid.Id, new(Id(), grid.Version, false, false));
        await game.ValidateHarnessStart(id, owner.AccessToken, owner.Snapshot.Version, default, "继续");
        Check.True(Shown() is null);
        Check.Equal(1, maps.List(id, true, true).Maps.Length);
    }

    // No authored fight here, or an image provider that can draw a real map: no grid.
    public static async Task NoBlankGridWithoutFightOrWhenImagesCanBeGenerated()
    {
        var model = new Model((_, _) => throw new Exception("Starting an action check never calls the model"));
        await using (var h = await Host.Start(configure: Configure(model)))
        {
            var owner = await Create(h, TestContent.Document);
            var game = h.App.Services.GetRequiredService<GameService>();
            Check.True(TestContent.Document.Scenes.Single(s => s.Id == owner.Snapshot.Scene.Id).Encounter is null);
            await game.ValidateHarnessStart(owner.Snapshot.Id, owner.AccessToken, owner.Snapshot.Version, default, "看看四周");
            Check.Equal(0, h.App.Services.GetRequiredService<MapCatalog>().List(owner.Snapshot.Id, true, true).Maps.Length);
        }
        await using (var h = await Host.Start(images: new TestImages(), configure: Configure(model)))
        {
            var owner = await Create(h, StandardCombatTests.Document());
            await h.App.Services.GetRequiredService<GameService>().ValidateHarnessStart(owner.Snapshot.Id, owner.AccessToken, owner.Snapshot.Version, default, "向守卫发起挑战");
            Check.Equal(0, h.App.Services.GetRequiredService<MapCatalog>().List(owner.Snapshot.Id, true, true).Maps.Length);
        }
    }
}
