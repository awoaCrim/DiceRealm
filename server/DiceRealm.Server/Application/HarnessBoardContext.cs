using System.Text.Json.Serialization;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Server.Application;

public sealed record BoardSourceOption(string Kind, string Id, string EncounterId, string Name, string Notice);
public sealed record HarnessBoardImage(string Kind, string MediaType, string Base64, string Hash, int Width, int Height,
    double Left, double Top, double Right, double Bottom);
public sealed record HarnessBoardContext(int Version, string SceneId, string Status, BoardView? State,
    BoardSourceOption[] Sources, HarnessBoardImage[] Images, string Coordinates, string Notice)
{
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public BoardMapView[]? Maps { get; init; }
    public const string CoordinateContract = "Coordinates use the actual map image: origin top-left, X increases right, Y increases down, normalized 0..1; the point is the token center. Each attached image fills its entire pixel rectangle with the stated [left,top,right,bottom] map bounds, with no padding. Labels identify instances, not templates. Viewing/panning another map never moves a unit or changes sceneId; travel/scene actions own scene changes. A saved ordinary move does not verify terrain, walls or hazards.";
    public static HarnessBoardContext Unavailable(int version, string sceneId) => new(version, sceneId, "unavailable", null, [], [], CoordinateContract,
        "No published player map is available for this current scene. No board image was supplied; do not claim visual inspection. GM maps are never substituted.");

    public static void Validate(HarnessBoardContext board, int version, string sceneId, bool allowPersonal = false, int toolContractVersion = 41)
    {
        if (board.Version != version || board.SceneId != sceneId || board.Coordinates != CoordinateContract || board.Notice is null || board.Notice.Length > 1000 ||
            board.Status is not ("ready" or "unavailable" or "image_failed") || board.Sources is null || board.Sources.Length > 128 || board.Images is null || board.Images.Length > 2 ||
            (board.Status == "unavailable") != (board.State is null) || board.Status == "ready" && board.Images.Length == 0 || board.Status != "ready" && board.Images.Length != 0)
            throw new InvalidDataException("Invalid board context.");
        if (board.State is { } state && (state.Version != version || state.SceneId != sceneId || state.Tokens is null ||
            state.Tokens.Any(t => t.Visibility != "player" && !(allowPersonal && t.Visibility == "actor") || !double.IsFinite(t.X) || !double.IsFinite(t.Y) || t.X is < 0 or > 1 || t.Y is < 0 or > 1)))
            throw new InvalidDataException("Invalid board projection.");
        if ((toolContractVersion >= 42) != (board.Maps is not null) || board.Maps is { } maps &&
            (maps.Length > 128 || maps.Any(m => m is null) || maps.Select(m => m.Id).Distinct(StringComparer.Ordinal).Count() != maps.Length))
            throw new InvalidDataException("Invalid board map options.");
        if (toolContractVersion < 42 && (board.State?.Map.Purpose is not null || board.State?.Map.Grid.ScaleBasis is not null ||
            board.State?.Tokens.Any(t => t.Size is not null) == true))
            throw new InvalidDataException("New map metadata in historical board contract.");
        if (toolContractVersion >= 42)
        {
            foreach (var map in board.Maps ?? [])
            {
                try { MapCatalog.ValidatePurpose(map.Purpose); MapCatalog.ValidateGrid(map.Grid); }
                catch (GameException ex) { throw new InvalidDataException("Invalid board map scale metadata.", ex); }
                if (!Guid.TryParseExact(map.Id, "D", out var id) || id == Guid.Empty || map.Version < 1 ||
                    !AssetCatalog.IsHash(map.ContentHash) && !(board.Status == "image_failed" && map.Id == board.State?.Map.Id && map.ContentHash == "") ||
                    map.Width is < 1 or > 8192 || map.Height is < 1 or > 8192 || (long)map.Width * map.Height > 33554432)
                    throw new InvalidDataException("Invalid board map identity.");
            }
            // Logical subdivision can be finer than the catalog's raster-cell input bound.
            if (board.State is { } logical)
            {
                if (logical.Map.Grid is null || !double.IsFinite(logical.Map.Grid.CellPixels) || logical.Map.Grid.CellPixels <= 0)
                    throw new InvalidDataException("Invalid logical map scale.");
                try { MapCatalog.ValidatePurpose(logical.Map.Purpose); MapCatalog.ValidateGrid(logical.Map.Grid with { CellPixels = 64 }); }
                catch (GameException ex) { throw new InvalidDataException("Invalid logical map metadata.", ex); }
            }
            if (board.State is { } current && !(board.Maps ?? []).Any(m => m.Id == current.Map.Id && m.Version == current.Map.Version &&
                m.ContentHash == current.Map.ContentHash && m.Width == current.Map.Width && m.Height == current.Map.Height))
                throw new InvalidDataException("Selected map differs from frozen map options.");
        }
        foreach (var image in board.Images)
        {
            if (image is null || image.Kind is not ("overview" or "detail") || image.MediaType != "image/jpeg" || image.Base64 is null || image.Base64.Length > 131072 ||
                image.Width is < 1 or > 1024 || image.Height is < 1 or > 1024 || image.Left < 0 || image.Top < 0 || image.Right > 1 || image.Bottom > 1 ||
                image.Left >= image.Right || image.Top >= image.Bottom || !double.IsFinite(image.Left + image.Top + image.Right + image.Bottom))
                throw new InvalidDataException("Invalid board image.");
            byte[] bytes;
            try { bytes = Convert.FromBase64String(image.Base64); }
            catch (FormatException) { throw new InvalidDataException("Invalid board image bytes."); }
            if (Infrastructure.JsonFiles.Hash(bytes) != image.Hash) throw new InvalidDataException("Invalid board image hash.");
        }
    }
}
