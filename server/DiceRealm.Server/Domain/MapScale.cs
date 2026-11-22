namespace DiceRealm.Server.Domain;

// Conversion only: purpose never supplies a distance and image dimensions never imply one.
public static class MapScale
{
    public static double FeetPerPixel(MapGrid grid)
    {
        double feet = grid.Units switch
        {
            "feet" => 1, "miles" => 5280, "meters" => 1 / 0.3048, "kilometers" => 1000 / 0.3048, _ => double.NaN
        };
        if (grid.Uncalibrated || grid.ScaleBasis?.Kind == "unknown" ||
            !double.IsFinite(grid.Distance) || grid.Distance <= 0 || !double.IsFinite(grid.CellPixels) || grid.CellPixels <= 0)
            return double.NaN;
        return grid.Distance * feet / grid.CellPixels;
    }

    public static MapGrid TacticalGrid(MapAssetView map)
    {
        double scale = FeetPerPixel(map.Grid);
        if (map.Purpose != "tactical" || map.Grid.Type is not ("none" or "square") ||
            !double.IsFinite(scale) || scale <= 0)
            throw new GameException("board_combat_scale_unsupported",
                "需要已校准的局部战术图；区域、城镇或未知尺度不能直接改成五尺。请选择或补充局部图。", 409);
        if (map.Grid.Distance == 5 && map.Grid.Units == "feet") return map.Grid with { Type = "square" };
        // Both the physical pixel ratio and the actual image origin survive subdivision.
        return map.Grid with { Type = "square", CellPixels = 5 / scale, Distance = 5, Units = "feet" };
    }
}
