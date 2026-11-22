using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Server.Application;

public sealed record DmReferenceArgs(string Topic);
public sealed record EncounterPlanMember(string Id, int Count);
public sealed record EncounterPlanArgs(string Difficulty, string Query = "", int Count = 1,
    EncounterPlanMember[]? Monsters = null, int Offset = 0, int Limit = 6);
public sealed record TreasureGenerateArgs(decimal ChallengeRating, string Kind = "individual", int Creatures = 1, string Theme = "random");

// Authoring/reference tools only. Campaign authority, dice, rewards and encounter creation
// remain with the existing game operations; these functions never write to the campaign.
public static class HarnessDmTools
{
    private sealed record Monster(string Name, string Source, decimal Cr, int Xp);
    private sealed record Dice(int Count, int Sides, int Multiplier, int Adjustment);
    private sealed record Treasure(string Kind, decimal Low, decimal High, string Coin, Dice Money, Dice? Magic);
    private sealed record RarityRow(int Min, int Max, string Rarity);
    private sealed record RarityTable(int Low, int High, RarityRow[] Rows);
    private sealed record MagicRow(int Min, int Max, string[] Choices, bool VariantRequired);
    private sealed record MagicTable(string Type, MagicRow[] Rows);
    private sealed record Data(string SourceRevision, Dictionary<string, string> Evidence,
        Dictionary<string, JsonElement> References, int[][] Budgets, Monster[] Monsters,
        Treasure[] Treasure, RarityTable[] Rarities, MagicTable[] MagicTables);
    private sealed record MonsterChoice(string Id, string Name, decimal ChallengeRating, int Xp, int Count,
        int TotalXp, string? ExecutableProfileId);
    private static readonly Data Tables = Load();
    private const string Notice = "仅为主持参考或生成方案，不会创建遭遇、授予发现、扣除生命或发放奖励。按当前场景与玩家意图使用已有执行工具；不能把本结果当作已发生的事件或获物来源。不要向玩家朗读内部标识。";

    public static object Reference(int version, DmReferenceArgs args)
    {
        if (args.Topic is null || !Tables.References.TryGetValue(args.Topic, out var reference)) throw Invalid();
        return new { version, ruleset = "dnd2024", topic = args.Topic, reference, notice = Notice };
    }

    public static object Encounter(Campaign campaign, LocalRulesPackage package, EncounterPlanArgs args)
    {
        int difficulty = args.Difficulty switch { "low" => 0, "moderate" => 1, "high" => 2, _ => -1 };
        if (difficulty < 0 || args.Query is null || args.Query.Length > 120 || args.Query.Any(char.IsControl) ||
            args.Count is < 1 or > 1000 || args.Offset < 0 || args.Limit is < 1 or > 8 || args.Monsters?.Length > 12)
            throw Invalid();
        var levels = PartyEngine.Characters(campaign).Where(p => !GameLifecycle.Dead(campaign, p.Id))
            .Select(p => p.Character.Level).ToArray();
        if (levels.Length == 0) throw new GameException("encounter_party_missing", "没有可用于计算遭遇预算的实际队员。");
        var budgets = Enumerable.Range(0, 3).Select(i => levels.Sum(level => Tables.Budgets[level - 1][i])).ToArray();
        var catalog = package.Entries.Where(e => e.Category == "monster").Select(e =>
            (Rule: e, Rating: Tables.Monsters.SingleOrDefault(m => m.Source == e.Source && m.Name == e.CanonicalName)))
            .Where(pair => pair.Rating is not null).ToArray();
        MonsterChoice Choice(LocalRuleEntry rule, Monster rating, int count)
        {
            string profile = rule.Id["monster:".Length..];
            return new(rule.Id, rule.Name, rating.Cr, rating.Xp, count, checked(rating.Xp * count),
                StandardMonsters.Find(profile)?.Id);
        }
        var roster = (args.Monsters ?? []).Select(member =>
        {
            if (member is null || member.Id is null || member.Count is < 1 or > 1000) throw Invalid();
            var match = catalog.SingleOrDefault(pair => pair.Rule.Id == member.Id);
            if (match.Rule is null) throw new GameException("dm_monster_unavailable", "此怪物没有匹配的本地完整规则与2024挑战等级。");
            return Choice(match.Rule, match.Rating!, member.Count);
        }).ToArray();
        int total = roster.Sum(m => m.TotalXp);
        string[] words = args.Query.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        var options = roster.Length > 0 ? [] : catalog.Where(pair => words.All(word =>
                pair.Rule.Name.Contains(word, StringComparison.OrdinalIgnoreCase) || pair.Rule.CanonicalName.Contains(word, StringComparison.OrdinalIgnoreCase) ||
                pair.Rule.Aliases.Any(alias => alias.Contains(word, StringComparison.OrdinalIgnoreCase))))
            .Select(pair => Choice(pair.Rule, pair.Rating!, args.Count))
            .Where(option => option.TotalXp <= budgets[difficulty])
            .OrderByDescending(option => option.TotalXp).ThenBy(option => option.Id, StringComparer.Ordinal).ToArray();
        if (args.Offset > options.Length) throw Invalid();
        return new
        {
            version = campaign.Version, ruleset = "dnd2024", partyLevels = levels,
            budgets = new { low = budgets[0], moderate = budgets[1], high = budgets[2] },
            targetDifficulty = args.Difficulty, budget = budgets[difficulty], roster, totalXp = total,
            remainingXp = budgets[difficulty] - total,
            estimatedDifficulty = roster.Length == 0 ? null : total > budgets[2] ? "above_high" : total > budgets[1] ? "high" : total > budgets[0] ? "moderate" : "low",
            options = options.Skip(args.Offset).Take(args.Limit).ToArray(),
            nextOffset = args.Offset + args.Limit < options.Length ? (int?)(args.Offset + args.Limit) : null,
            notice = Notice + " 按2024每名角色预算求和，怪物XP直接相加，无2014数量倍率。预算只是估计，地形/资源/人数仍影响难度。候选按指定数量组成同类遭遇；混合名单可用monsters评估。仅带executableProfileId的怪物可用于现有encounter_prepare，其余只供规划与规则查阅，不能伪称已支持自动结算。"
        };
    }

    public static object TreasurePlan(Campaign campaign, string intentId, LocalRulesPackage package, TreasureGenerateArgs args)
    {
        if (args.ChallengeRating is < 0 or > 30 ||
            args.ChallengeRating is not (0.125m or 0.25m or 0.5m) && decimal.Truncate(args.ChallengeRating) != args.ChallengeRating ||
            args.Kind is not ("individual" or "hoard") || args.Creatures is < 1 or > 1000 ||
            args.Kind == "hoard" && args.Creatures != 1 || args.Theme is not ("random" or "arcana" or "armaments" or "implements" or "relics"))
            throw Invalid();
        var tier = Tables.Treasure.Single(t => t.Kind == args.Kind && args.ChallengeRating >= t.Low && args.ChallengeRating <= t.High);
        // Stable proposal rolls, separate from the authoritative game-dice stream. Asking
        // for the same plan again in this input cannot reroll it or spend game resources.
        string seed = string.Join('\n', campaign.Id, intentId, HarnessJson.Serialize(args));
        var random = new Random(System.Buffers.Binary.BinaryPrimitives.ReadInt32LittleEndian(SHA256.HashData(Encoding.UTF8.GetBytes(seed))));
        int Roll(Dice dice) => (Enumerable.Range(0, dice.Count).Sum(_ => random.Next(1, dice.Sides + 1)) + dice.Adjustment) * dice.Multiplier;
        int coins = checked(Roll(tier.Money) * (args.Kind == "individual" ? args.Creatures : 1));
        int count = tier.Magic is null ? 0 : Roll(tier.Magic);
        int level = campaign.ActingCharacter!.Level;
        var rarityTable = Tables.Rarities.Single(t => level >= t.Low && level <= t.High);
        var magic = Enumerable.Range(0, count).Select(_ =>
        {
            int rarityRoll = random.Next(1, 101);
            string rarity = rarityTable.Rows.Single(r => rarityRoll >= r.Min && rarityRoll <= r.Max).Rarity;
            string theme = args.Theme == "random" ? new[] { "arcana", "armaments", "implements", "relics" }[random.Next(4)] : args.Theme;
            var table = Tables.MagicTables.Single(t => t.Type == theme + "." + rarity);
            int itemRoll = random.Next(1, 101);
            var selected = table.Rows.Single(r => itemRoll >= r.Min && itemRoll <= r.Max);
            var choices = selected.Choices.Select(identity =>
            {
                string[] parts = identity.Split('|');
                var matches = package.Entries.Where(e => e.Category == "magic_item" && e.Source == parts[1] &&
                    e.CanonicalName.Equals(parts[0], StringComparison.OrdinalIgnoreCase)).ToArray();
                var rule = matches.Length == 1 ? matches[0] : null;
                return new { id = rule?.Id, name = rule?.Name, lookupName = rule is null ? parts[0] : null, available = rule is not null };
            }).ToArray();
            return new { theme, rarity, choices, selected.VariantRequired, needsChoice = selected.VariantRequired || choices.Length > 1,
                unavailable = choices.Any(choice => !choice.available) };
        }).ToArray();
        return new
        {
            version = campaign.Version, ruleset = "dnd2024", proposalOnly = true, args.Kind, args.ChallengeRating,
            args.Creatures, currency = tier.Coin, amount = coins, magicItemCount = count, rarityLevel = level,
            args.Theme, magicItems = magic,
            notice = Notice + " 魔法物品稀有度按当前角色实际等级。choices是该次表格结果允许的选项，不是多份奖励；variantRequired须选择具体变体，缺本地完整资料则明确保留缺项，不替换或重抽。先核实当前场景确有奖励，再按已有物品目录/来源规则结算；未支持货币或魔法效果不能只用叙事宣布到账。"
        };
    }

    private static Data Load()
    {
        using var stream = typeof(HarnessDmTools).Assembly.GetManifestResourceStream("DiceRealm.DmTools.2024.json")
            ?? throw new InvalidOperationException("缺少主持工具资料。");
        var data = JsonSerializer.Deserialize<Data>(stream, JsonFiles.Options) ?? throw new InvalidDataException("主持工具资料为空。");
        if (data.SourceRevision != LocalRulesCatalog.SourceRevision || data.Budgets.Length != 20)
            throw new InvalidDataException("主持工具资料版本不符。");
        return data;
    }
    private static GameException Invalid() => new("harness_invalid_payload", "主持辅助工具参数不符合当前规则。");
}
