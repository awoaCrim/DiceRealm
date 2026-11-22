using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Application;

// Validates provenance before the existing transaction commits. A literal quote proves
// that evidence exists, not that arbitrary prose or quantities semantically follow from it.
public static class HarnessItemEvidence
{
    public const string Guidance = "物品陈述必须有依据：规则目录/模糊候选只说明物品类型，不证明此地有物、归属、数量或许可。只依据当前已确认场景资料、实际库存和权威结果；未知先读资料，不补造背景道具或赠物。旧模型正文/continuity/模型记录不能自证。新物资或即时获物的source.detail须摘录本次之前已存在的导入场景或当地公开preparation/dm记录；同次新写叙事/记忆不能作依据。保存前删除正文和记忆中无依据的物品陈述。";

    public static void Validate(Campaign c, StorySupplyProposal[]? proposals, StoryItemGrant[]? grants,
        IReadOnlyList<StorySupply>? supplies, IReadOnlySet<string> memoryIds, WorldMemoryEntry[] memoryPlan)
    {
        // A model edit changes a trusted author/DM record into a model record. Do not
        // validate against the old row then commit stock whose own evidence is invalid.
        var changedSources = memoryPlan.Select(m => m.Id).ToHashSet(StringComparer.Ordinal);
        var sources = (supplies ?? []).Select(s => s.Source).Concat((grants ?? []).Where(g => g.Source is not null).Select(g => g.Source!));
        if (sources.Any(s => s.Kind == "public_memory" && changedSources.Contains(s.Id) &&
            WorldMemories.Find(c, s.Id)?.Source is "preparation" or "dm"))
            throw new GameException("invalid_story_items", "本次记忆改写会使物资来源失效；请保留原作者/DM依据，把新增观察另记为continuity。整笔内容未保存。");
        foreach (var proposal in proposals ?? []) RequireQuote(c, proposal.Source);
        foreach (var grant in grants ?? [])
        {
            if (grant.Source?.Kind == "supply")
            {
                var stock = supplies?.FirstOrDefault(s => s.Id == grant.Source.Id);
                if (stock is null) throw Invalid();
                RequireQuote(c, stock.Source);
            }
            else
            {
                StoryInventory.ValidateSource(c, grant.Source, memoryIds);
                RequireQuote(c, grant.Source!);
            }
        }
    }

    private static void RequireQuote(Campaign c, StoryItemSource source)
    {
        string quote = source.Detail.Trim();
        if (quote.Length == 0 || !c.VisitedScenes.Contains(c.SceneId)) throw Invalid();
        if (source.Kind == "current_scene" && source.Id == c.SceneId &&
            c.Adventure?.Scenes.Any(s => s.Id == c.SceneId) == true)
        {
            var scene = Adventure.Current(c);
            if (scene.Summary.Contains(quote, StringComparison.Ordinal) || scene.Arrival.Contains(quote, StringComparison.Ordinal)) return;
        }
        else if (source.Kind == "public_memory" && WorldMemories.Find(c, source.Id) is { } entry &&
            entry.Source is "preparation" or "dm" && entry.SceneId == c.SceneId && WorldMemories.IsPublic(c, entry) &&
            entry.Kind is "npc" or "place" or "clue" && entry.Summary.Contains(quote, StringComparison.Ordinal)) return;
        throw Invalid();
    }
    private static GameException Invalid() => new("invalid_story_items",
        "物品缺少预先存在的现场依据。source.detail须逐字引用当前导入场景公开摘要/入场文，或当地公开preparation/dm记录；规则搜索、当前新写内容及旧模型记录不能自证。请读取实际资料，删除无依据的物品陈述；叙事、记忆、物资和背包均未保存。");
}
