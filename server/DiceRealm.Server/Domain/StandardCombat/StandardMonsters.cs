namespace DiceRealm.Server.Domain;

// Verified XMM descriptors, not name matching. Goblin Warrior uses the pinned XMM p142
// raw record (local evidence, not a successful MCP response). The flat public arena does
// not simulate Hide, darkvision/languages, or Skeleton's optional bow.
public static class StandardMonsters
{
    public const string GoblinWarriorId = "xmm:goblin-warrior";
    public static bool IsGoblinWarrior(ContentEnemy enemy) => enemy.RulesId == GoblinWarriorId && Matches(enemy);
    public sealed record Profile(string Id, int Hp, int Ac, int Speed, int Initiative, int Attack, int Die, int Bonus, string Damage,
        int Strength, int Dexterity, int Constitution, int Intelligence, int Wisdom, int Charisma);
    public static readonly Profile[] All =
    [
        new("xmm:zombie", 15, 8, 20, -2, 3, 8, 1, "Bludgeoning", 1, -2, 3, -4, 0, -3),
        new("xmm:skeleton", 13, 14, 30, 3, 5, 6, 3, "Piercing", 0, 3, 2, -2, -1, -3),
        new(GoblinWarriorId, 10, 15, 30, 2, 4, 6, 2, "Slashing", -1, 2, 0, 0, -1, -1)
    ];
    public static Profile? Find(string? id) => All.SingleOrDefault(p => p.Id == id);
    // Same pinned XMM records: Goblin Warrior p142, Skeleton p282, Zombie p346.
    public static string? Size(string? id) => id switch
    {
        GoblinWarriorId => "S", "xmm:skeleton" or "xmm:zombie" => "M", _ => null
    };
    public static bool Matches(ContentEnemy e)
    {
        var p = Find(e.RulesId);
        return p is not null && e.HitPoints == p.Hp && e.ArmorClass == p.Ac && e.Speed == p.Speed && e.InitiativeModifier == p.Initiative &&
            e.AttackBonus == p.Attack && e.DamageDice == 1 && e.DamageDie == p.Die && e.DamageBonus == p.Bonus && e.SavingThrows is null;
    }
    public static int? Save(ContentEnemy e, string ability)
    {
        var p = Find(e.RulesId);
        return p is null ? e.SavingThrows?.GetValueOrDefault(ability) : ability switch
        {
            "strength" => p.Strength, "dexterity" => p.Dexterity, "constitution" => p.Constitution,
            "intelligence" => p.Intelligence, "wisdom" => p.Wisdom, "charisma" => p.Charisma, _ => null
        };
    }
}
