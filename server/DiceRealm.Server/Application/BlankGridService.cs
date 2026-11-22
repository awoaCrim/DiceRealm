using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Server.Application;

public sealed partial class GameService
{
    // A scene whose authored fight has no published player map, and no image generation to request one,
    // gets a blank 5-foot battle grid when an action starts there: the AI DM can then place tokens and hand
    // the fight to the combat host instead of escalating to the human host. It is an ordinary published map,
    // so the host can replace or withdraw it; a withdrawn grid is not put back, because every step replays
    // by its fixed request id. Map catalog writes only, like the map API.
    private void EnsureBlankGrid(Campaign c)
    {
        if (imageGenerator.Enabled || CombatEngine.InCombat(c) || ContentRuntime.AvailableEncounter(c) is null ||
            mapCatalog.SelectedPlayerMap(c.Id, c.SceneId, null) is not null) return;
        string Request(string phase) => new Guid(JsonFiles.Hash("blank-grid:" + c.Id + ":" + c.SceneId + ":" + phase)[..32]).ToString();
        string id = Request("create");
        try
        {
            mapCatalog.Create(c.Id, new(id, new MapSpecification
            {
                Title = Adventure.Current(c).Title + " · 空白方格", Kind = "battle", Edition = "player", Purpose = "tactical",
                Width = BlankGridImage.Width, Height = BlankGridImage.Height,
                Grid = new() { Type = "square", CellPixels = BlankGridImage.CellPixels, Distance = 5, Units = "feet",
                    ScaleBasis = new("source", "空白方格：每格5尺，图上没有地形；站位按场景描述决定。") },
                ImportSource = new() { VisualStyle = "空白方格，没有地形或建筑。" }
            }), c.Archived);
            mapCatalog.Import(c.Id, id, new(Request("import"), 1), BlankGridImage.Png(), c.Archived);
            mapCatalog.ConfigureScenes(c.Id, id, new(Request("scenes"), 2, [c.SceneId]), [c.SceneId], c.Archived);
            mapCatalog.Publish(c.Id, id, new(Request("publish"), 3, true, true), c.Archived);
        }
        catch (GameException error)
        {
            // Without the grid the action still runs: the DM sees no board and asks the host, as before.
            logger.LogWarning("Blank battle grid unavailable ({Code})", error.Code);
        }
    }
}
