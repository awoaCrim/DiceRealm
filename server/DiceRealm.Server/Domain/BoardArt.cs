namespace DiceRealm.Server.Domain;

// Display-only artwork for already-visible entities. Exact rule identities and public labels, never substring inference.
public static class BoardArt
{
    public static readonly string[] Keys = ["goblin", "wolf", "skeleton", "zombie", "spider", "bear", "boar", "npc", "chest"];
    public static string Icon(BoardEntity entity) => entity.Appearance.IconKey.Length > 0 ? entity.Appearance.IconKey
        : Default(entity.Appearance.Name, entity.Source.Kind, entity.Source.RulesId);
    public static string Default(string publicName, string sourceKind, string rulesId = "")
    {
        // Call only after the viewer has passed CanView; explicit authored art always wins.
        string sourced = sourceKind == "enemy" ? rulesId switch
        {
            StandardMonsters.GoblinWarriorId => "goblin",
            "xmm:skeleton" => "skeleton",
            "xmm:zombie" => "zombie",
            _ => ""
        } : "";
        if (sourced.Length > 0) return sourced;
        string name = publicName.Trim().ToLowerInvariant();
        return name switch
        {
            "goblin" or "地精" => "goblin",
            "wolf" or "狼" => "wolf",
            "skeleton" or "骷髅" => "skeleton",
            "zombie" or "僵尸" => "zombie",
            "spider" or "蜘蛛" => "spider",
            "bear" or "熊" => "bear",
            "boar" or "野猪" => "boar",
            "chest" or "宝箱" => "chest",
            _ => sourceKind == "npc" ? "npc" : ""
        };
    }
}
