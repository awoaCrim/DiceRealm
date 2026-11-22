using System.Text.Json;

namespace DiceRealm.Server.Domain;

public static class BuildCatalog
{
    public const string Revision = "e5f3e77b303a92df10487207857200245e71957c";
    private static readonly Lazy<BuildCatalogData> Data = new(Load);
    public static BuildCatalogData Get() => Data.Value;
    private static BuildCatalogData Load()
    {
        using var stream = typeof(BuildCatalog).Assembly.GetManifestResourceStream("DiceRealm.Creation.catalog.json")
            ?? throw new InvalidOperationException("Creation catalogue resource missing.");
        var data = JsonSerializer.Deserialize<BuildCatalogData>(stream, new JsonSerializerOptions(JsonSerializerDefaults.Web))
            ?? throw new InvalidOperationException("Creation catalogue invalid.");
        if (data.Ruleset != "dnd2024" || data.Source != "XPHB" || data.Revision != Revision || data.Level != 1 || data.Classes.Length != 12 || data.Species.Length != 10 || data.Backgrounds.Length != 16)
            throw new InvalidOperationException("Creation catalogue version mismatch.");
        return data;
    }
    public static readonly string[] Steps = ["class", "origin", "abilities", "choices", "spells", "equipment", "details", "review"];
    public static readonly string[] Alignments = ["lawful-good", "neutral-good", "chaotic-good", "lawful-neutral", "neutral", "chaotic-neutral", "lawful-evil", "neutral-evil", "chaotic-evil"];
    public static string AbilityName(string id) => id switch { "str" => "strength", "dex" => "dexterity", "con" => "constitution", "int" => "intelligence", "wis" => "wisdom", "cha" => "charisma", _ => throw new ArgumentOutOfRangeException(nameof(id)) };
    public static string ItemId(string id) => id switch { "dungeoneer-s-pack" => "dungeoneers-pack", "scholar-s-pack" => "scholars-pack", _ => id };
}
