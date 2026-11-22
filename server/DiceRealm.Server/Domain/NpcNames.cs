using System.Text.RegularExpressions;

namespace DiceRealm.Server.Domain;

// XDMG 84 permits adapted/invented names and nicknames. These short Chinese combinations
// are original fallback nicknames, not an official translation or a reproduced book table.
public static class NpcNames
{
    public const int Version = 41;
    private static readonly Regex Generic = new(
        @"^(?:地精战士|地精伏兵|地精|骷髅战士|骷髅兵|骷髅|僵尸|伏兵|敌人|敌方|敌方单位|守卫|卫兵|强盗|土匪|村民|路人|人物|无名氏|未命名|狼|野狼|熊|野猪|蜘蛛|NPC|enemy|ambusher|guard|bandit|goblin warrior|goblin|skeleton|zombie|wolf|bear|boar|spider)(?:[\s#＃·._-]*[0-9０-９]+)?$",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly string[] First = ["苔", "雾", "岚", "砂", "墨", "霜", "暮", "松", "榆", "溪", "榛", "栎", "芦", "杉", "砚", "岫"];
    private static readonly string[] Last = ["铃", "枝", "石", "穗", "翎", "叶", "砾", "弦", "扣", "笛", "芽", "纹", "棱", "帆", "豆", "缕"];

    public static bool IsGeneric(string name) => Generic.IsMatch(name.Trim());

    public static HashSet<string> Reserved(Campaign c, IEnumerable<string> proposed) =>
        (c.Board?.Entities.Select(e => e.Appearance.Name) ?? []).Concat(PartyEngine.Characters(c).Select(p => p.Character.Name))
            .Concat(proposed).ToHashSet(StringComparer.OrdinalIgnoreCase);

    // Only fallbacks must be distinct. Deliberately equal supplied proper names remain valid;
    // mechanical identity always comes from an entity/source ID, never from this set.
    public static string ForCreation(string name, ISet<string> reserved)
    {
        if (!IsGeneric(name)) { reserved.Add(name); return name; }
        return Combinations().First(reserved.Add);
    }

    public static ContentEnemy[] EncounterInstances(Campaign c, ContentEnemy[] templates, int namingVersion)
    {
        if (namingVersion < Version) return templates;
        var reserved = Reserved(c, templates.Select(e => e.Name));
        return templates.Select(e => e with { Name = ForCreation(e.Name, reserved) }).ToArray();
    }

    private static IEnumerable<string> Combinations()
    {
        for (int offset = 0; offset < Last.Length; offset++)
            for (int i = 0; i < First.Length; i++) yield return First[i] + Last[(i + offset) % Last.Length];
        // The board holds at most 2048 entities; these original combinations also cover a
        // full board without changing a nickname into a creature-type serial number.
        foreach (string first in First)
            foreach (string middle in First)
                foreach (string last in Last) yield return first + middle + last;
    }
}
