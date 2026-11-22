namespace DiceRealm.Server.Domain;

public static partial class AdvancementEngine
{
    // Normalize only the candidate produced by an explicit level gain. Reads keep old
    // records intact; Build and historical choices remain immutable acquisition evidence.
    private static CharacterAdvancement TransferInitialSources(Character c, CharacterAdvancement state)
    {
        var classes = state.Classes.Select(cls =>
        {
            var result = cls with
            {
                OptionalFeatures = cls.OptionalFeatures.Select(id => BoundIdentity(cls, id)).ToArray(),
                Choices = cls.Choices?.Where(s => !new[] { "agonizing-blast", "eldritch-spear", "repelling-blast" }
                    .Any(id => s.Key == "optional:" + id + ":cantrip")).ToArray()
            };
            if (c.Advancement is null && cls.ClassId == c.Build!.ClassId && cls.ClassId is "cleric" or "druid")
            {
                var extra = c.BuildMechanics!.SpellGrants.Where(g => IsInitialOrderGrant(c, g)).Select(g => g.Id);
                result = result with { Cantrips = cls.Cantrips.Concat(extra).Distinct().ToArray() };
            }
            if (cls.ClassId == "warlock")
            {
                var bonus = (result.BonusSpells ?? []).ToList();
                foreach (string id in cls.OptionalFeatures)
                {
                    var spell = InvocationSpell(id);
                    if (spell is null) continue;
                    // Includes legacy advanced records whose original invocation was
                    // never copied to BonusSpells. Never revive an unowned invocation.
                    bonus.RemoveAll(b => b.Origin == spell.Origin);
                    bonus.Add(spell);
                }
                if (bonus.Count > 0) result = result with { BonusSpells = bonus.ToArray() };
            }
            return result;
        }).ToArray();
        return state with { Classes = classes };
    }

    private static bool IsInitialOrderGrant(Character c, BuildSpellGrant grant) => c.Build!.ClassId switch
    {
        "cleric" => grant.Source == "class:cleric/thaumaturge",
        "druid" => grant.Source == "class:druid/magician",
        _ => false
    };

    // Full XPHB clauses are asserted by the offline compiler. An arbitrary innate tag
    // does not gain this mode, and neither spell waives its component requirements.
    private static AdvancementBonusSpell? InvocationSpell(string id) => id switch
    {
        "armor-of-shadows" => new("mage-armor", "at-will", "optional:" + id, "cha", Condition: "self"),
        "pact-of-the-chain" => new("find-familiar", "at-will", "optional:" + id, "cha", Condition: "magic-action"),
        _ => null
    };

    private sealed partial class Evaluation
    {
        private void TransferInitialGrants()
        {
            int removed = SpellGrants.RemoveAll(g => IsInitialOrderGrant(Character, g)
                || Character.Build!.ClassId == "warlock" && g.Source == "class:warlock/invocation");
            if (removed > 0)
                Notices.Add("一级职业来源已移交当前职业记录；原始建卡保留，已替换来源不再授予旧法术。");
        }

        public string[] CurrentFeatures(AdvancementClass[] classes)
        {
            var previous = State.Classes.SelectMany(c => c.OptionalFeatures)
                .Concat(Character.Build!.Selections.Where(s => s.Key == "class:warlock/invocation").SelectMany(s => s.Values))
                .Concat(State.Steps.SelectMany(s => s.Choices.Selections.Where(v => v.Key.StartsWith("optional:", StringComparison.Ordinal))
                    .SelectMany(v => v.Values))).ToHashSet();
            var definitions = previous.Select(OptionalDefinition).ToHashSet();
            var obsoleteLabels = AdvancementCatalog.Get().OptionalFeatures.Where(f => definitions.Contains(f.Id))
                .SelectMany(f => new[] { f.Id, f.Name }).Concat(previous).ToHashSet();
            var revokedFeats = previous.Where(IsLesson).Select(LessonFeat).Where(id => !CurrentFeats.Contains(id)).ToHashSet();
            return Character.Features.Where(f => !obsoleteLabels.Contains(f) && !revokedFeats.Contains(f)).Concat(Acquired.Select(f => f.Name))
                .Concat(CurrentFeats).Concat(classes.SelectMany(c => c.OptionalFeatures)).Distinct().ToArray();
        }
    }
}
