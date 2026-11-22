using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Server.Application;

// Read-only, character-scoped references. Never turn a book entry into an acquired ability
// or an executable action. Full licensed text stays in the deployment's private rules pack.
public static class CharacterRuleDetails
{
    private const int EntryLimit = 32768, TotalLimit = 262144;
    private sealed record SpeciesSection(string CanonicalName, string Name, string SelectionKey, string SelectionValue,
        string Path, int Offset, int Length);
    private sealed record SpeciesSections(string Id, string TextHash, SpeciesSection[] Sections);
    private sealed record FeatureBody(string Id, string SourceHash, string BodyKey);
    private sealed record RuleIndex(SpeciesSections[] Species, FeatureBody[] FeatureBodies);
    private static readonly Lazy<RuleIndex> ruleIndex = new(() =>
    {
        using var stream = typeof(CharacterRuleDetails).Assembly.GetManifestResourceStream("DiceRealm.RuleSections.json")!;
        return JsonSerializer.Deserialize<RuleIndex>(stream, JsonFiles.Options)!;
    });

    public static CharacterRuleReferences References(int version, string actorId, Character character, LocalRulesCatalog catalog)
    {
        // Resolve the exact acquired sources, but return neither personal build prose nor command options.
        var sheet = new CharacterSheetView(version, false, "", character with { Inventory = [] }, [], [], [],
            new(false, "", 0, 0, [], []), "");
        var details = Enrich(sheet, catalog);
        return new(version, actorId, character.Id, details.FeatureDetails ?? [], details.RuleDetailsNotice);
    }

    public static CharacterSheetView Enrich(CharacterSheetView sheet, LocalRulesCatalog catalog, ContentItem[]? contentItems = null)
    {
        try
        {
            string? version = catalog.CaptureVersion();
            return Project(sheet, version is null ? null : catalog.Read(version),
                version is null ? "未配置本地中文规则库；仅显示已有速查，未匹配的能力不会猜测说明。" : "", contentItems);
        }
        catch (GameException error) when (error.Code is "rules_catalog_corrupt" or "rules_catalog_unavailable")
        {
            return Project(sheet, null, error.Message, contentItems);
        }
    }

    public static CharacterSheetView Project(CharacterSheetView sheet, LocalRulesPackage? package, string notice = "", ContentItem[]? contentItems = null)
    {
        if (package is null) return sheet with { FeatureDetails = [], ItemDetails = Items(sheet, null, contentItems, TotalLimit), RuleDetailsNotice = notice };
        var character = sheet.Character;
        var build = BuildCatalog.Get();
        var advancement = AdvancementCatalog.Get();
        var classes = character.Advancement?.Classes.Select(c => (Id: c.ClassId, c.Level, Subclass: c.SubclassId)).ToArray()
            ?? [(character.Build?.ClassId ?? build.Classes.FirstOrDefault(c => c.Name == character.ClassName)?.Id ?? "", character.Level, "")];
        var species = build.Species.FirstOrDefault(s => s.Id == character.Build?.SpeciesId || s.Name == character.Species);
        var speciesRule = package.Entries.SingleOrDefault(e => e.Id == "species:xphb:" + species?.Id && e.Category == "species");
        var sections = speciesRule is null ? null : ruleIndex.Value.Species.SingleOrDefault(s => s.Id == speciesRule.Id &&
            s.TextHash == Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(speciesRule.Text))));
        var results = new List<SheetFeatureDetail>();
        int remaining = TotalLimit;
        for (int index = 0; index < character.Features.Length; index++)
        {
            string original = character.Features[index];
            // Explicit acquired IDs take precedence over all canonical-name lookup.
            var identity = original.Split('/', 2);
            var optional = advancement.OptionalFeatures.FirstOrDefault(f => f.Id == identity[0]);
            var feat = advancement.Feats.FirstOrDefault(f => f.Id == original);
            string name = feat?.Name ?? optional?.Name ?? original;
            string bindingId = identity.Length == 2 && optional is not null ? identity[1] : "";
            string binding = package.Entries.FirstOrDefault(e => e.Id == "spell:xphb:" + bindingId || e.Id == "feat:xphb:" + bindingId)?.Name
                ?? advancement.Spells.FirstOrDefault(s => s.Id == bindingId)?.Name
                ?? advancement.Feats.FirstOrDefault(f => f.Id == bindingId)?.Name ?? bindingId;
            // Only the server-authored summary delimiters; never arbitrary word/substring matches.
            string heading = name.Split([" (", ": "], StringSplitOptions.None)[0];
            string text = "", label = "", group = "";
            bool isSpecies = optional is null && feat is null && species?.Features.Contains(heading) == true;
            if (isSpecies)
            {
                group = "物种能力";
                var candidates = sections?.Sections.Where(s => s.CanonicalName == heading).ToArray() ?? [];
                var section = candidates.FirstOrDefault(s => s.SelectionKey != "" && character.Build?.Selections.Any(
                    choice => choice.Key == s.SelectionKey && choice.Values.Contains(s.SelectionValue)) == true)
                    ?? candidates.FirstOrDefault(s => s.SelectionKey == "");
                if (section is not null && speciesRule is not null)
                {
                    label = section.Name;
                    text = speciesRule.Text.Substring(section.Offset, section.Length);
                }
                else
                {
                    results.Add(new(index, "", "", "尚未匹配这项物种能力的独立正文；未使用整个物种说明代替。", group));
                    continue;
                }
            }
            else
            {
                string? exactId = feat is not null ? "feat:xphb:" + feat.Id : optional is not null ? "optional-feature:xphb:" + optional.Id : null;
                var matches = package.Entries.Where(e => e.Source == "XPHB" && e.Category is "feature" or "feat" &&
                    (exactId is not null ? e.Id == exactId : string.Equals(e.CanonicalName, heading, StringComparison.OrdinalIgnoreCase) && OwnedContext(e.Id))).ToArray();
                // A class's ASI description is not the same entry as the selectable ASI feat.
                if (exactId is null && matches.Any(e => e.Id.StartsWith("class-feature:", StringComparison.Ordinal) || e.Id.StartsWith("subclass-feature:", StringComparison.Ordinal)))
                    matches = matches.Where(e => e.Category == "feature").ToArray();
                matches = matches.OrderBy(e => FeatureLevel(e.Id)).GroupBy(e =>
                    ruleIndex.Value.FeatureBodies.FirstOrDefault(b => b.Id == e.Id && b.SourceHash == e.SourceHash)?.BodyKey ?? e.Id)
                    .Select(group => group.First()).ToArray();
                group = feat is not null || matches.Any(e => e.Category == "feat") ? "专长"
                    : matches.Any(e => e.Id.StartsWith("class-feature:", StringComparison.Ordinal) || e.Id.StartsWith("subclass-feature:", StringComparison.Ordinal)) || optional is not null ? "职业能力" : "";
                label = matches.FirstOrDefault()?.Name ?? "";
                text = string.Join("\n\n", matches.Select(e => (matches.Length > 1 ? ContextLabel(e) + "\n" : "") + e.Text));
                if (matches.Length > 0 && binding != "")
                {
                    label += " · " + binding;
                    text = "本角色绑定选择：" + binding + "\n\n" + text;
                }
            }
            if (text.Length == 0) continue;
            if (text.Length > EntryLimit || text.Length > remaining)
            {
                results.Add(new(index, label, "", "该能力完整正文超过本页容量；未截取片段冒充完整规则。", group));
                continue;
            }
            remaining -= text.Length;
            results.Add(new(index, label, text, "规则说明仅供查阅；当前次数、加值和可执行选项以角色状态与服务端操作条件为准。", group));
        }
        return sheet with { FeatureDetails = results.ToArray(), ItemDetails = Items(sheet, package, contentItems, remaining), RuleDetailsNotice = notice };

        bool OwnedContext(string id)
        {
            var parts = id.Split(':');
            if (parts[0] == "class-feature")
                return parts.Length >= 5 && int.TryParse(parts[2], out int level) && classes.Any(c => c.Id == parts[1] && c.Level >= level);
            if (parts[0] == "subclass-feature")
                return parts.Length >= 6 && int.TryParse(parts[3], out int level) && classes.Any(c => c.Id == parts[1] && c.Subclass == parts[1] + ":" + parts[2] && c.Level >= level);
            if (parts[0] == "feat") return character.BuildMechanics?.Feats.Contains(parts[^1]) == true;
            if (parts[0] == "optional-feature") return character.Advancement?.Classes.Any(c => c.OptionalFeatures.Any(f => f.Split('/')[0] == parts[^1])) == true;
            return false;
        }
        static int FeatureLevel(string id)
        {
            var parts = id.Split(':');
            int position = parts[0] == "subclass-feature" ? 3 : 2;
            return parts.Length > position && int.TryParse(parts[position], out int level) ? level : 0;
        }
        string ContextLabel(LocalRuleEntry entry)
        {
            var parts = entry.Id.Split(':');
            string category = parts[0] == "subclass-feature" ? "subclass" : "class";
            string sourceId = category == "subclass" ? "subclass:" + parts[1] + ":xphb:" + parts[2] : "class:xphb:" + parts[1];
            return (package.Entries.FirstOrDefault(e => e.Id == sourceId)?.Name ?? build.Classes.FirstOrDefault(c => c.Id == parts[1])?.Name ?? entry.Name) + " · " + entry.Name;
        }
    }

    private static SheetItemDetail[] Items(CharacterSheetView sheet, LocalRulesPackage? package, ContentItem[]? contentItems, int remaining)
    {
        var character = sheet.Character;
        var items = new List<SheetItemDetail>();
        // A retained attunement can be read without adding a fake carried item.
        var references = character.Inventory.Where(i => i.Quantity > 0).Select(i => (i.Id, i.RulesId))
            .Concat((sheet.Wearables?.Items ?? []).Where(i => i.Attuned && !character.Inventory.Any(owned => owned.Id == i.ItemId && owned.Quantity > 0))
                .Select(i => (Id: i.ItemId, RulesId: (string?)i.RulesId)));
        foreach (var item in references)
        {
            string? rulesId = item.RulesId ?? contentItems?.FirstOrDefault(i => i.Id == item.Id)?.RulesId;
            var metadata = ItemMetadata.Find(item.Id, rulesId);
            // Metadata and full text use the same exact identity; unknown explicit identities never fall back.
            string? identity = rulesId ?? metadata?.Id;
            var matches = package?.Entries.Where(e => e.Category is "equipment" or "magic_item" &&
                (e.Id == identity || e.Id == e.Category + ":" + identity)).ToArray() ?? [];
            var rule = matches.Length == 1 ? matches[0] : null;
            if (rule is null && metadata is null) continue;
            string text = rule?.Text ?? "", notice = "";
            if (text.Length > EntryLimit || text.Length > remaining)
            {
                text = "";
                notice = "该物品完整属性超过本页容量；未截取片段冒充完整规则。";
            }
            remaining -= text.Length;
            var equipment = metadata is null ? null : BuildCatalog.Get().Equipment.FirstOrDefault(e => "equipment:xphb:" + e.Id == metadata.Id);
            string category = (metadata?.Id ?? rule?.Id ?? "").StartsWith("magic_item:", StringComparison.Ordinal) ? "magic"
                : equipment is null ? "" : equipment.WeaponCategory != "" ? "weapon"
                : equipment.Kind is "LA" or "MA" or "HA" or "S" ? "armor"
                : equipment.Kind is "T" or "AT" or "INS" or "GS" ? "tool" : "gear";
            items.Add(new(item.Id, rule?.Name ?? "", text, notice,
                metadata?.WeightPounds is not null, metadata?.WeightPounds ?? 0,
                metadata?.PriceCp is not null, metadata?.PriceCp ?? 0, metadata?.Rarity ?? "", category));
        }
        return items.ToArray();
    }
}
