namespace DiceRealm.Server.Domain;

public static partial class AdvancementEngine
{
    private const string Lessons = "lessons-of-the-first-ones";
    private const string LessonPrefix = "optional:" + Lessons + "/";
    private static bool IsLesson(string id) => id.StartsWith(Lessons + "/", StringComparison.Ordinal);
    private static string LessonFeat(string id) => id[(Lessons.Length + 1)..];
    private static bool MagicInitiateSource(string origin) => origin.StartsWith("feat:magic-initiate:", StringComparison.Ordinal)
        || origin == LessonPrefix + "magic-initiate";

    private sealed partial class Evaluation
    {
        private sealed class Contribution(AdvancementFeatSource source)
        {
            public readonly HashSet<string> Feats = source.Feats.ToHashSet(), Skills = source.Skills.ToHashSet(),
                Expertise = source.Expertise.ToHashSet(), Tools = source.Tools.ToHashSet(), Weapons = source.Weapons.ToHashSet();
            public AdvancementFeatSource Record(string id) => new(id, Feats.Order().ToArray(), Skills.Order().ToArray(),
                Expertise.Order().ToArray(), Tools.Order().ToArray(), Weapons.Order().ToArray());
        }
        private readonly Dictionary<string, Contribution> Contributions = [];
        private string TrainingOrigin = "permanent";
        public AdvancementRetiredResource[]? RetiredResources;
        private Contribution Training => Contributions[TrainingOrigin];
        public string[] CurrentFeats => Contributions.Values.SelectMany(s => s.Feats).Distinct().Order().ToArray();
        public string[] CurrentExpertise => Contributions.Values.SelectMany(s => s.Expertise).Where(Skills.Contains).Distinct().Order().ToArray();
        public AdvancementFeatSource[]? FeatSources => State.FeatSources is null && Contributions.Count == 1 ? null
            : Contributions.OrderBy(s => s.Key).Select(s => s.Value.Record(s.Key)).ToArray();

        private void InitializeFeatSources()
        {
            var records = State.FeatSources ?? [new("permanent", Character.BuildMechanics!.Feats, Character.Skills,
                Character.Expertise ?? [], Character.BuildMechanics.Tools, Character.BuildMechanics.WeaponTraining)];
            foreach (var record in records) Contributions.Add(record.Id, new(record));
            // Candidate-only removal before other training choices. A malformed proposed
            // set still fails OptionalChoices; no live character/source record is edited.
            var proposed = Draft.ClassId == "warlock" ? Draft.Selections.SingleOrDefault(s => s.Key == "optional:EI")?.Values : null;
            if (proposed is not null)
                foreach (var key in Contributions.Keys.Where(k => k.StartsWith(LessonPrefix, StringComparison.Ordinal) && !proposed.Contains(k[9..])).ToArray())
                    Contributions.Remove(key);
            Reset(Skills, Contributions.Values.SelectMany(s => s.Skills));
            Reset(Expertise, CurrentExpertise);
            Reset(Tools, Contributions.Values.SelectMany(s => s.Tools));
            Reset(Weapons, Contributions.Values.SelectMany(s => s.Weapons));
        }
        private static void Reset(HashSet<string> target, IEnumerable<string> values)
        {
            var copy = values.ToArray();
            target.Clear(); target.UnionWith(copy);
        }
        private void GainTraining(HashSet<string> target, string value)
        {
            target.Add(value);
            if (ReferenceEquals(target, Skills)) Training.Skills.Add(value);
            else if (ReferenceEquals(target, Expertise)) Training.Expertise.Add(value);
            else if (ReferenceEquals(target, Tools)) Training.Tools.Add(value);
            else if (ReferenceEquals(target, Weapons)) Training.Weapons.Add(value);
        }
        private void GainFeat(string id)
        {
            Training.Feats.Add(id);
            if (TrainingOrigin == "permanent") Feats.Add(id);
        }
        private void LessonTraining(string identity)
        {
            string source = "optional:" + identity;
            if (Contributions.ContainsKey(source)) return;
            var feat = AdvancementCatalog.Get().Feats.Single(s => s.Id == LessonFeat(identity));
            Contributions.Add(source, new(new(source, [], [], [], [], [])));
            TrainingOrigin = source;
            try
            {
                GainFeat(feat.Id);
                Proficiencies(source, feat.Mechanics);
            }
            finally { TrainingOrigin = "permanent"; }
        }
        private bool SourceStillOwned(string origin)
        {
            if (!origin.StartsWith(LessonPrefix, StringComparison.Ordinal)) return true;
            return Contributions.ContainsKey(origin);
        }

        // Removed sources cannot stay as usable counters, nor may dropping and taking
        // the same source again refresh its spent uses before another actual long rest.
        private Character PreserveSourceResources(Character previous, AdvancementClass[] classes)
        {
            var active = classes.SelectMany(s => s.BonusSpells ?? []).Where(b => b.Origin.StartsWith(LessonPrefix, StringComparison.Ordinal) && b.Uses > 0)
                .Select(AdvancementSheet.FreeSpell).ToHashSet();
            if (CurrentFeats.Contains("lucky")) active.Add("Luck Points");
            var retired = (State.RetiredResources ?? []).ToDictionary(r => r.Name);
            var resources = previous.Resources.ToList();
            bool Managed(string name) => name == "Luck Points" && Character.BuildMechanics!.Feats.Contains("lucky")
                || name.StartsWith("Free: ", StringComparison.Ordinal) && name.Contains("[" + LessonPrefix, StringComparison.Ordinal);
            foreach (var resource in resources.Where(r => Managed(r.Name) && !active.Contains(r.Name)).ToArray())
            {
                retired[resource.Name] = new(resource.Name, resource.Current, resource.Maximum, Character.NextLongRestAtSeconds);
                resources.Remove(resource);
            }
            foreach (string name in active)
            {
                if (!retired.Remove(name, out var old) || resources.Any(r => r.Name == name)) continue;
                resources.Add(new(name, old.RestBoundary == Character.NextLongRestAtSeconds ? old.Current : old.Maximum,
                    old.Maximum, "long", "来源重新取得；保留本长休周期的已消耗量。", "XPHB"));
            }
            RetiredResources = retired.Count == 0 ? null : retired.Values.OrderBy(r => r.Name).ToArray();
            return previous with { Resources = resources.ToArray() };
        }
    }
}
