namespace DiceRealm.Server.Domain;

// The imported document supplies names, text, topology and authored consequences.
// Only these typed operations may change state; AI prose never enters this module.
public static class ContentRuntime
{
    public static bool Ready(Campaign c) => c.ContentActivated && c.Adventure is not null && (c.Prompts is not null || c.Harness is not null);
    public static bool Matches(Campaign c, ContentCondition condition)
    {
        bool Has(string fact) => fact.StartsWith("visited:", StringComparison.Ordinal)
            ? c.VisitedScenes.Contains(fact[8..]) : c.Facts.Contains(fact);
        return condition.All.All(Has) && (condition.Any.Length == 0 || condition.Any.Any(Has)) && !condition.None.Any(Has);
    }
    public static ContentScene? Scene(Campaign c) => Ready(c) ? c.Adventure!.Scenes.FirstOrDefault(s => s.Id == c.SceneId) ?? WorldRoutes.Scene(c, c.SceneId) : null;
    public static bool SafeRest(Campaign c) => Scene(c)?.SafeRest == true;
    public static bool IsContentKind(string kind) => kind is "talk" or "investigate" || kind.StartsWith("story.", StringComparison.Ordinal) || kind.StartsWith("script.", StringComparison.Ordinal);
    public static ContentAction? FindAction(Campaign c, string kind, string target) => Scene(c)?.Actions.FirstOrDefault(a => a.Kind == kind && a.Target == target);
    public static ActionChoice[] Choices(Campaign c) => Scene(c)?.Actions
        .Where(a => (a.Repeatable || !c.CompletedContentActions.Contains(a.Id)) && Matches(c, a.When) && CanApply(c, [..a.Always, ..a.Success.Effects]) && CanApply(c, [..a.Always, ..a.Failure.Effects]))
        .Select(a => new ActionChoice(a.Kind, a.Target, a.Label)).ToArray() ?? [];
    // Legacy campaigns keep their shared host inventory. DM-only campaigns bind items
    // to the actual acting player; a DM never receives an invented inventory.
    internal static string ItemActor(Campaign c) => c.HostOnlySeat ? c.ActingActorId : PartyEngine.HostId;
    internal static bool CanApply(Campaign c, ContentEffect[] effects)
    {
        if (effects.Any(e => e.Op == "item") && !PartyEngine.HasCharacter(c, ItemActor(c))) return false;
        foreach (var group in effects.Where(e => e.Op == "item").GroupBy(e => e.Key))
        {
            long current = PartyEngine.CharacterFor(c, ItemActor(c)).Inventory.Where(i => i.Id == group.Key).Sum(i => (long)i.Quantity);
            // Respect order too: a later reward cannot pay an earlier item cost.
            foreach (var effect in group) { current += effect.Amount; if (current < 0 || current > 1000000) return false; }
        }
        return true;
    }
    public static Resolution Resolve(Campaign c, string kind, string target, RulesEngine rules)
    {
        if (!CharacterReviews.CanAct(c) || !Choices(c).Any(a => a.Kind == kind && a.Target == target))
            throw new GameException("action_unavailable", "此剧本行动的条件、物品或权限不满足。", 409);
        var action = FindAction(c, kind, target)!;
        DiceCheck? check = action.Check is { } spec ? rules.AbilityCheck(c.ActingCharacter, spec.Ability, spec.Skill, spec.Dc) : null;
        return ApplyOutcome(c, action, check);
    }
    internal static Resolution ApplyOutcome(Campaign c, ContentAction action, DiceCheck? check)
    {
        var outcome = check?.Success == false ? action.Failure : action.Success;
        var changes = Apply(c, [..action.Always, ..outcome.Effects]);
        if (!action.Repeatable) c.CompletedContentActions.Add(action.Id);
        return new("resolved", action.Kind, outcome.Text, check, changes, ContentActionId: action.Id);
    }
    public static string CorrectCheck(Campaign c, string actionId)
    {
        var action = Scene(c)?.Actions.FirstOrDefault(a => a.Id == actionId)
            ?? throw new GameException("check_context_changed", "检定所属剧本或场景已变化。", 409);
        if (action.Failure.Effects.Length != 0) throw new GameException("unsupported_check_correction", "此检定已应用失败后果，需要主持人裁定。", 409);
        Apply(c, action.Success.Effects);
        return action.Success.Text;
    }
    public static string[] Apply(Campaign c, ContentEffect[] effects)
    {
        if (!CanApply(c, effects)) throw new GameException("insufficient_items", "剧本行动所需物品不足或物品数量超出上限。", 409);
        var changes = new List<string>();
        foreach (var effect in effects)
        {
            switch (effect.Op)
            {
                case "fact": if (!c.Facts.Contains(effect.Key)) { c.Facts.Add(effect.Key); changes.Add(effect.Key); } break;
                case "removeFact": c.Facts.Remove(effect.Key); changes.Add("fact:removed:" + effect.Key); break;
                case "chapter": c.Chapter = Math.Max(c.Chapter, effect.Amount); changes.Add("chapter:" + c.Chapter); break;
                case "item":
                    var actor = ItemActor(c);
                    var character = PartyEngine.CharacterFor(c, actor);
                    var inventory = character.Inventory.ToList();
                    int index = inventory.FindIndex(i => i.Id == effect.Key);
                    if (index >= 0)
                    {
                        int amount = inventory[index].Quantity + effect.Amount;
                        if (amount == 0) inventory.RemoveAt(index); else inventory[index] = inventory[index] with { Quantity = amount };
                    }
                    else
                    {
                        var name = c.Adventure!.Items.FirstOrDefault(i => i.Id == effect.Key)?.Name ?? effect.Key;
                        inventory.Add(new(effect.Key, name, effect.Amount, false));
                    }
                    PartyEngine.SetCharacter(c, actor, character with { Inventory = inventory.ToArray() });
                    changes.Add("item:" + effect.Key + ":" + effect.Amount.ToString("+0;-0;0")); break;
                default: throw new InvalidOperationException("Unvalidated content operation.");
            }
        }
        return changes.ToArray();
    }
    public static WorldView World(Campaign c)
    {
        if (!Ready(c)) return new([], [], [], []);
        var d = c.Adventure!;
        return new(d.Quests.Where(q => Matches(c, q.Visible)).Select(q => new QuestView(q.Id, q.Title,
            Matches(c, q.Complete) ? "completed" : Matches(c, q.Active) ? "active" : "available", q.Summary,
            q.Objectives.Where(o => o.Visible is null || Matches(c, o.Visible))
                .Select(o => new QuestObjective(o.Text, Matches(c, o.Complete))).ToArray(), q.Reward)).ToArray(),
            d.Npcs.Where(n => Matches(c, n.Visible)).Select(n => ProjectNpc(c, n)).ToArray(),
            d.Factions.Where(f => Matches(c, f.Visible)).Select(f =>
            {
                int score = f.Adjustments.Where(a => Matches(c, a.When)).Sum(a => a.Amount);
                return new FactionView(f.Id, f.Name, score, score > 0 ? "友好" : score < 0 ? "保留意见" : "中立");
            }).ToArray(),
            d.Branches.Where(b => Matches(c, b.When)).Select(b => new BranchView(b.Id, b.Choice, b.Label)).ToArray());
    }
    public static NpcView ProjectNpc(Campaign c, ContentNpc npc) => new(npc.Id, npc.Name,
        npc.Locations.FirstOrDefault(l => Matches(c, l.When))?.SceneId ?? npc.SceneId,
        npc.FactionId, Matches(c, npc.Met), npc.Summary);

    public static ContentEncounter? FindEncounter(Campaign c, string id) =>
        c.Adventure?.Scenes.Select(s => s.Encounter).FirstOrDefault(e => e?.Id == id) ??
        c.RuntimeEncounters?.Select(e => e.Definition).FirstOrDefault(e => e.Id == id);
    public static ContentEncounter? SceneEncounter(Campaign c) => Scene(c)?.Encounter ?? RuntimeEncounters.Current(c)?.Definition;
    public static ContentEncounter? AvailableEncounter(Campaign c)
    {
        var encounter = Scene(c)?.Encounter ?? (RuntimeEncounters.Current(c) is { EngagementReason: not null, Layout: not null } runtime ? runtime.Definition : null);
        return encounter is not null && (encounter.Repeatable || !c.AttemptedEncounters.Contains(encounter.Id)) && Matches(c, encounter.When) && CanApply(c, [..encounter.OnStart, ..encounter.Victory.Effects]) ? encounter : null;
    }
}
