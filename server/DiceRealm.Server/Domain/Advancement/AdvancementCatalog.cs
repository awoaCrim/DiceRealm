using System.Text.Json;

namespace DiceRealm.Server.Domain;

public static class AdvancementCatalog
{
    private static readonly Lazy<AdvancementCatalogData> Data = new(Load);
    public static AdvancementCatalogData Get() => Data.Value;
    private static AdvancementCatalogData Load()
    {
        using var stream = typeof(AdvancementCatalog).Assembly.GetManifestResourceStream("DiceRealm.Advancement.catalog.json")
            ?? throw new InvalidOperationException("Advancement catalogue resource missing.");
        var data = JsonSerializer.Deserialize<AdvancementCatalogData>(stream, new JsonSerializerOptions(JsonSerializerDefaults.Web))
            ?? throw new InvalidOperationException("Advancement catalogue invalid.");
        if (data.SchemaVersion != 1 || data.Ruleset != "dnd2024" || data.Source != "XPHB" || data.Revision != BuildCatalog.Revision
            || data.Classes.Length != 12 || data.Subclasses.Length != 48 || data.Spells.Length != 391
            || data.Experience.Length != 20 || data.Proficiency.Length != 20 || data.FullCasterSlots.Length != 20
            || data.FullCasterSlots.Any(row => row.Length != 9)
            || data.LineageSpells is not { Length: 12 }
            || data.LineageSpells.Any(g => g.SpeciesId is not ("elf" or "tiefling") || g.Level is not (3 or 5)
                || !data.Spells.Any(s => s.Id == g.SpellId && s.Level > 0)))
            throw new InvalidOperationException("Advancement catalogue version mismatch.");
        return data;
    }
    public static int At(int[]? values, int level) => values is not null && level > 0 && level <= values.Length ? values[level - 1] : 0;
    public static int Table(AdvancementTable[] tables, string column, int level)
    {
        foreach (var table in tables)
        {
            int index = Array.IndexOf(table.ColLabels, column);
            if (index < 0 || table.Rows is null || level < 1 || level > table.Rows.Length) continue;
            var cell = table.Rows[level - 1][index];
            if (cell.ValueKind == JsonValueKind.Number) return cell.GetInt32();
            if (cell.ValueKind == JsonValueKind.String && int.TryParse(cell.GetString(), out int value)) return value;
            if (cell.ValueKind == JsonValueKind.Object && cell.TryGetProperty("value", out var number)) return number.GetInt32();
            throw new InvalidOperationException("Unsupported progression table cell.");
        }
        return 0;
    }
    public static string Slug(string name) => System.Text.RegularExpressions.Regex.Replace(name.ToLowerInvariant(), "[^a-z0-9]+", "-").Trim('-');
    public static int[] ClassSlots(AdvancementClass state)
    {
        var c = Get().Classes.Single(x => x.Id == state.ClassId);
        var sub = Get().Subclasses.SingleOrDefault(x => x.Id == state.SubclassId);
        var table = (sub?.CasterProgression == "1/3" ? sub.Tables : c.Tables).FirstOrDefault(t => t.RowsSpellProgression is not null);
        return table?.RowsSpellProgression?[state.Level - 1].ToArray() ?? new int[9];
    }
    public static int[] SharedSlots(AdvancementClass[] states)
    {
        var casters = states.Where(s => Progression(s) is "full" or "half" or "1/3").ToArray();
        if (casters.Length == 0) return new int[9];
        if (casters.Length == 1) return ClassSlots(casters[0]);
        int level = casters.Sum(s => Progression(s) switch
        {
            "full" => s.Level,
            "half" => (s.Level + 1) / 2,
            "1/3" => s.Level / 3,
            _ => 0
        });
        return level == 0 ? new int[9] : Get().FullCasterSlots[level - 1].ToArray();
    }
    public static string Progression(AdvancementClass state) =>
        Get().Subclasses.SingleOrDefault(s => s.Id == state.SubclassId)?.CasterProgression is { Length: > 0 } sub
            ? sub : Get().Classes.Single(c => c.Id == state.ClassId).CasterProgression;
    public static int MaximumSpellLevel(AdvancementClass state) => Progression(state) == "pact"
        ? Table(Get().Classes.Single(c => c.Id == state.ClassId).Tables, "Slot Level", state.Level)
        : Array.FindLastIndex(ClassSlots(state), n => n > 0) + 1;
}
