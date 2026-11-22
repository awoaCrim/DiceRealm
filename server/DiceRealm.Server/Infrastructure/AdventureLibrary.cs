using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Infrastructure;

public sealed record AdventureLibraryEntry(string Id, string Name, string Version, string Summary,
    string Levels, string Duration, string Source, string License, string Hash, int SceneCount, int MapCount);
public sealed record AdventureLibraryMap(string File, string Sha256, MapSpecification Specification, string[] SceneIds);
public sealed record AdventureLibraryManifest(int FormatVersion, string Id, string Name, string Version,
    string Summary, string Levels, string Duration, string Source, string License, AdventureLibraryMap[] Maps);
public sealed record LoadedLibraryMap(AdventureLibraryMap Definition, byte[] Png);
public sealed record LoadedAdventure(AdventureLibraryEntry Entry, AdventureDocument Adventure, string Prompt,
    AdventureLibraryMap[] Maps, LoadedLibraryMap[] Images);

// Installed author data, never an implicit default adventure or a remote downloader.
// Original distributable stories ship here; privately acquired modules can be installed locally.
public sealed class AdventureLibrary(IConfiguration configuration)
{
    private readonly string root = Path.GetFullPath(configuration["AdventureLibrary:Directory"]
        ?? Path.Combine(AppContext.BaseDirectory, "adventures"));
    private static readonly JsonSerializerOptions Json = new(JsonFiles.Options)
    {
        PropertyNameCaseInsensitive = false, UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        RespectRequiredConstructorParameters = true, MaxDepth = 32
    };
    private static bool SafeId(string? value) => value is not null && Regex.IsMatch(value, "^[a-z0-9][a-z0-9-]{0,63}$", RegexOptions.CultureInvariant);
    public AdventureLibraryEntry[] List() => !Directory.Exists(root) ? [] : Directory.EnumerateDirectories(root)
        .Select(Path.GetFileName).Where(id => SafeId(id)).Order(StringComparer.Ordinal)
        .Select(id => Load(id!).Entry).ToArray();

    // Legacy installs have no record provenance. Verify their deterministic installation ID,
    // exact adventure document and immutable PNG against the still-installed package; never
    // infer membership from a campaign-local title or a user-supplied source URL. No writes.
    internal Dictionary<string, (MapLibrarySource Source, MapSpecification Specification)> OriginalSources(string campaignId, MapAdventureSource adventure)
    {
        var result = new Dictionary<string, (MapLibrarySource, MapSpecification)>();
        if (!Directory.Exists(root)) return result;
        foreach (var id in Directory.EnumerateDirectories(root).Select(Path.GetFileName).Where(id => SafeId(id)))
        {
            LoadedAdventure package;
            try { package = Load(id!); }
            catch (GameException ex) when (ex.Code is "library_invalid" or "library_not_found")
            { continue; } // Optional reference discovery: unverifiable packages confer no eligibility. Activation stays strict.
            var entry = package.Entry;
            if (HarnessMaps.AdventureSource(package.Adventure) != adventure) continue;
            foreach (var map in package.Maps)
            {
                var mapId = new Guid(JsonFiles.Hash("library:" + campaignId + ":" + entry.Hash + ":" + map.File + ":create")[..32]).ToString();
                result[mapId] = (new(adventure, entry.Id, entry.Hash, map.File, map.Sha256), map.Specification);
            }
        }
        return result;
    }

    public LoadedAdventure Load(string id, string? expectedHash = null, bool images = false)
    {
        if (!SafeId(id)) throw new GameException("library_not_found", "未找到该剧本。", 404);
        var folder = Path.Combine(root, id);
        if (!Directory.Exists(folder)) throw new GameException("library_not_found", "该剧本尚未安装。", 404);
        try
        {
            var manifestBytes = Read(folder, "package.json", 1024 * 1024);
            var adventureBytes = Read(folder, "adventure.json", 1024 * 1024);
            var promptBytes = Read(folder, "prompt.md", 128 * 1024);
            var manifest = JsonSerializer.Deserialize<AdventureLibraryManifest>(manifestBytes, Json) ?? throw new InvalidDataException();
            var adventure = JsonSerializer.Deserialize<AdventureDocument>(adventureBytes, Json) ?? throw new InvalidDataException();
            var prompt = new UTF8Encoding(false, true).GetString(promptBytes);
            if (manifest.FormatVersion != 1 || manifest.Id != id || manifest.Version != adventure.Version || manifest.Name != adventure.Name ||
                !Line(manifest.Name, 120) || !Line(manifest.Summary, 1600) || !Line(manifest.Levels, 120) ||
                !Line(manifest.Duration, 120) || !Line(manifest.Source, 2048) || !Line(manifest.License, 1000) ||
                manifest.Maps is null || manifest.Maps.Length > 128) throw new InvalidDataException();
            ContentValidator.Validate(adventure);
            HarnessProfiles.Validate(new HarnessPreset("primary", 1, prompt), []);
            var sceneIds = adventure.Scenes.Select(s => s.Id).ToHashSet(StringComparer.Ordinal);
            var files = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var map in manifest.Maps)
            {
                if (map is null || !SafePngName(map.File) || !files.Add(map.File) || !AssetCatalog.IsHash(map.Sha256) ||
                    map.Specification?.ImportSource is null || map.SceneIds is null || map.SceneIds.Length > 128 ||
                    map.SceneIds.Distinct().Count() != map.SceneIds.Length || map.SceneIds.Any(s => !sceneIds.Contains(s))) throw new InvalidDataException();
                MapCatalog.Validate(map.Specification);
            }
            var hash = JsonFiles.Hash(JsonFiles.Hash(manifestBytes) + JsonFiles.Hash(adventureBytes) + JsonFiles.Hash(promptBytes));
            if (expectedHash is not null && expectedHash != hash)
                throw new GameException("library_changed", "剧本库内容已更新，请重新读取后选择。", 409);
            var loaded = images ? manifest.Maps.Select(map =>
            {
                var png = Read(folder, map.File, PngGuard.MaximumMapBytes);
                if (JsonFiles.Hash(png) != map.Sha256) throw new InvalidDataException();
                PngGuard.ValidateMap(png);
                var (width, height) = PngGuard.Dimensions(png);
                if (width != map.Specification.Width || height != map.Specification.Height) throw new InvalidDataException();
                return new LoadedLibraryMap(map, png);
            }).ToArray() : [];
            return new(new(id, manifest.Name, manifest.Version, manifest.Summary, manifest.Levels, manifest.Duration,
                manifest.Source, manifest.License, hash, adventure.Scenes.Length, manifest.Maps.Length), adventure, prompt, manifest.Maps, loaded);
        }
        catch (GameException ex) when (ex.Code != "library_changed") { throw InvalidPackage(); }
        catch (Exception ex) when (ex is IOException or InvalidDataException or UnauthorizedAccessException or JsonException or ArgumentException)
        { throw InvalidPackage(); }
    }
    private static bool Line(string? value, int maximum) => !string.IsNullOrWhiteSpace(value) && value.Length <= maximum && !value.Any(char.IsControl);
    private static bool SafePngName(string? name) => name is not null && Regex.IsMatch(name, "^[a-z0-9][a-z0-9-]{0,80}\\.png$", RegexOptions.CultureInvariant);
    private static byte[] Read(string folder, string name, long maximum)
    {
        using var input = new FileStream(Path.Combine(folder, name), FileMode.Open, FileAccess.Read, FileShare.Read);
        if (input.Length > maximum) throw new InvalidDataException();
        using var output = new MemoryStream(); input.CopyTo(output);
        return output.ToArray();
    }
    private static GameException InvalidPackage() => new("library_invalid", "本机剧本包缺少文件或校验失败，尚未启用；请修复安装文件后重试。", 409);
}
