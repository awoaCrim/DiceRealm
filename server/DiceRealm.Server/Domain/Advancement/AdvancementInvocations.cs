namespace DiceRealm.Server.Domain;

public static partial class AdvancementEngine
{
    private static bool BindsCantrip(string id) => id is "agonizing-blast" or "eldritch-spear" or "repelling-blast";
    private static string OptionalDefinition(string identity) => identity.Split('/')[0];
    private static string BoundIdentity(AdvancementClass cls, string identity)
    {
        if (!BindsCantrip(identity)) return identity;
        var records = cls.Choices?.Where(s => s is not null && s.Key == "optional:" + identity + ":cantrip").ToArray();
        var old = records is { Length: 1 } ? records[0].Values : null;
        return old is { Length: 1 } ? identity + "/" + old[0] : identity;
    }
    private static bool EligibleCantrip(string invocation, AdvancementSpellData spell) => spell.Level == 0
        && spell.Classes.Contains("warlock") && spell.DealsDamage
        && (invocation != "repelling-blast" || spell.SpellAttack)
        && (invocation != "eldritch-spear" || spell.Range.TryGetProperty("type", out var type) && type.GetString() == "point"
            && spell.Range.TryGetProperty("distance", out var distance) && distance.TryGetProperty("type", out var unit)
            && unit.GetString() == "feet" && distance.TryGetProperty("amount", out var amount) && amount.GetInt32() >= 10);

    private static bool ValidOptional(AdvancementClass cls, string id)
    {
        if (id is null) return false;
        string definition = OptionalDefinition(id);
        if (!AdvancementCatalog.Get().OptionalFeatures.Any(f => f.Id == definition)) return false;
        if (definition == Lessons)
            return cls.ClassId == "warlock" && cls.Level >= 2 && IsLesson(id)
                && AdvancementCatalog.Get().Feats.Any(f => f.Id == LessonFeat(id) && f.Category == "O");
        if (!BindsCantrip(definition)) return id == definition;
        var parts = BoundIdentity(cls, id).Split('/');
        return cls.ClassId == "warlock" && cls.Level >= 2 && parts.Length == 2 && cls.Cantrips.Contains(parts[1])
            && AdvancementCatalog.Get().Spells.Any(s => s.Id == parts[1] && EligibleCantrip(definition, s));
    }

    private sealed partial class Evaluation
    {
        private IEnumerable<BuildOption> OptionalOptions(AdvancementOptionalData feature, AdvancementClass cls)
        {
            if (feature.Id == Lessons)
            {
                foreach (var feat in AdvancementCatalog.Get().Feats.Where(f => f.Category == "O"))
                {
                    string id = Lessons + "/" + feat.Id;
                    bool retained = State.Classes.Any(s => s.OptionalFeatures.Contains(id));
                    if (!retained && CurrentFeats.Contains(feat.Id) && !Flag(feat.Mechanics, "repeatable")) continue;
                    if (!retained && feat.Id == "magic-initiate" && OwnedMagicInitiateLists().Count >= MagicInitiateLists.Length) continue;
                    yield return new(id, feature.Name + " · " + feat.Name, "本来源撤销时只移除其贡献；同一祈唤必须选择不同 Origin 专长。");
                }
                yield break;
            }
            if (!BindsCantrip(feature.Id))
            {
                yield return new(feature.Id, feature.Name);
                yield break;
            }
            foreach (var spell in AdvancementCatalog.Get().Spells.Where(s => cls.Cantrips.Contains(s.Id) && EligibleCantrip(feature.Id, s)))
                yield return new(feature.Id + "/" + spell.Id, feature.Name + " · " + spell.Name,
                    "每个合格戏法各占一次祈唤选择；同一祈唤不能重复绑定同一戏法。实际战斗效果仍按支持范围执行。");
        }
    }
}
