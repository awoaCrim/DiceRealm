namespace DiceRealm.Server.Domain;

// Bounded dnd2024/XDMG registry, verified against the fixed local rule evidence at
// e5f3e77b303a92df10487207857200245e71957c. Identity, never an editable name, grants mechanics.
public sealed record WearableDefinition(string Id, string RulesId, string Name, string Slot, bool RequiresAttunement,
    bool Supported, string Notice, decimal? WeightPounds = null);
public static class WearableCatalog
{
    public static readonly WearableDefinition[] Items =
    [
        Entry("cloak-of-protection", "防护斗篷", "cloak", true, true, "穿戴并同调后：AC +1，所有豁免（含死亡豁免）+1。"),
        Entry("ring-of-protection", "防护戒指", "ring", true, true, "穿戴并同调后：AC +1，所有豁免（含死亡豁免）+1。"),
        Entry("bracers-of-defense", "防御护腕", "wrists", true, true, "穿戴并同调，且未穿护甲、未实际持盾时：AC +2。"),
        Entry("boots-of-elvenkind", "精灵靴", "feet", false, true, "穿戴后脚步不发声（不论地面）；不等于穿戴者完全无声或无法被察觉。敏捷（隐匿）检定优势；与劣势抵消，不叠加优势。"),
        Entry("gloves-of-thievery", "盗窃手套", "hands", false, true, "穿戴时手套本身不可察觉，不使穿戴者隐形或无法被察觉；敏捷（巧手）检定 +5，2024规则不增加盗贼工具检定。"),
        Entry("headband-of-intellect", "智力头带", "head", true, false, "已支持穿戴与同调；智力设为19及其派生值尚未自动结算。"),
        Entry("gauntlets-of-ogre-power", "食人魔力量护手", "hands", true, false, "已支持穿戴与同调；力量设为19及其派生值尚未自动结算。"),
        Entry("amulet-of-health", "健康护符", "neck", true, false, "已支持穿戴与同调；体质设为19、生命上限及派生值尚未自动结算。", 1m),
        Entry("belt-of-dwarvenkind", "矮人腰带", "waist", true, false, "已支持穿戴与同调；体质、矮人语、条件优势、黑暗视觉、毒素抗性与胡须尚未自动结算。"),
        Entry("hat-of-disguise", "易容帽", "head", true, false, "已支持穿戴与同调；易容术的施放、持续与卸下结束尚未自动结算。"),
        Entry("goggles-of-night", "夜视镜", "eyes", false, false, "已支持穿戴；60尺黑暗视觉及已有黑暗视觉的延伸尚未自动结算。"),
        Entry("necklace-of-adaptation", "适应项链", "neck", true, false, "已支持穿戴与同调；环境呼吸及避免或结束中毒的条件豁免优势尚未自动结算。", 1m)
    ];
    private static WearableDefinition Entry(string id, string name, string slot, bool attunement, bool supported, string notice, decimal? weightPounds = null) =>
        new(id, "magic_item:xdmg:" + id, name, slot, attunement, supported, notice, weightPounds);
    public static WearableDefinition? ById(string id) => Items.SingleOrDefault(i => i.Id == id);
    public static WearableDefinition? ByRulesId(string? rulesId) => Items.SingleOrDefault(i => i.RulesId == rulesId);
    // XPHB p228, same fixed revision: ordinary clothing, not armor or a magic-item grant.
    // Keep it outside Items/ById: that registry also owns frozen magic-item acquisition.
    private static readonly WearableDefinition robe = new("robe", "equipment:xphb:robe", "长袍", "clothing", false, true,
        "普通衣物，不属于护甲，不提供护甲加值，也不需要同调。", 4m);
    public static WearableDefinition? For(Item item) => ByRulesId(item.RulesId) ??
        ((item.RulesId is null ? item.Id == "robe" : item.RulesId is "equipment:xphb:robe" or "xphb:robe") ? robe : null);
}
