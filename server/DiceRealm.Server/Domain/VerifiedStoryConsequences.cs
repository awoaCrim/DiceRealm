namespace DiceRealm.Server.Domain;

public sealed record VerifiedStoryPlan(string RulingId, string ActionId, int RootSequence);

// A narrow actor-owned continuation, not a relaxation of the host's arbitrary fact controls.
// Matching a check alone is insufficient: it must belong to this exact input root and actor.
public static class VerifiedStoryConsequences
{
    public static (VerifiedStoryPlan Plan, string Label, ActionDetails Details)[] Choices(Campaign c, string rootId)
    {
        if (rootId == "" || c.Archived || !ContentRuntime.Ready(c) || CombatEngine.InCombat(c)) return [];
        var root = c.PendingIntents.FirstOrDefault(i => i.Id == rootId && i.ActorId == c.ActingActorId && i.Published);
        if (root is null) return [];
        var result = new List<(VerifiedStoryPlan, string, ActionDetails)>();
        foreach (var ruling in c.PendingRulings.Where(r => r.ActorId == c.ActingActorId && r.OriginSequence == root.RootSequence && r.SceneId == c.SceneId &&
            r.CombatId == "" && r.Status == "resolved" && r.Outcome == "check" && r.Story is null && r.EffectsRequestId == "" && r.Check is { HasDc: true, TestKind: "ability" }))
        {
            foreach (var action in ContentRuntime.Scene(c)!.Actions.Where(a => a.Check is { } spec &&
                spec.Ability == ruling.Check!.Ability && spec.Skill == ruling.Check.Skill && spec.Dc == ruling.Check.Dc &&
                (a.Repeatable || !c.CompletedContentActions.Contains(a.Id)) && ContentRuntime.Matches(c, a.When) &&
                // A previous character command may have paid already; do not guess or refund it.
                !a.Always.Concat(a.Success.Effects).Concat(a.Failure.Effects).Any(e => e.Op == "item" && e.Amount < 0)))
            {
                var effects = action.Always.Concat(ruling.Check!.Success ? action.Success.Effects : action.Failure.Effects).ToArray();
                if (!ContentRuntime.CanApply(c, effects)) continue;
                string outcome = ruling.Check.Success ? "成功" : "未通过";
                result.Add((new(ruling.Id, action.Id, root.RootSequence), "落实已记录检定 · " + action.Label,
                    new(action.Label, "沿用本次已记录的" + outcome + "检定；不重掷、不重复扣物品", "原地点、本人当前行动",
                        "确认只应用导入剧本中对应结果的事实、章节与奖励，队伍物品奖励进入队长库存。不会把自由叙事当依据。")));
            }
        }
        return result.ToArray();
    }
    public static Resolution Apply(Campaign c, VerifiedStoryPlan plan, string rootId, string requestId)
    {
        if (!Choices(c, rootId).Any(x => x.Plan == plan))
            throw new GameException("story_action_unavailable", "原检定、行动、场景或已落实状态发生变化，不能自动追加后果。", 409);
        int index = c.PendingRulings.FindIndex(r => r.Id == plan.RulingId);
        var ruling = c.PendingRulings[index];
        var action = ContentRuntime.Scene(c)!.Actions.Single(a => a.Id == plan.ActionId);
        var before = ActivityRecords.Capture(c); var facts = c.Facts.ToArray(); int chapter = c.Chapter;
        var result = ContentRuntime.ApplyOutcome(c, action, ruling.Check);
        var changes = new List<StoryChange>();
        foreach (string fact in facts.Union(c.Facts))
            if (facts.Contains(fact) != c.Facts.Contains(fact)) changes.Add(new("fact", fact, "剧情事实", facts.Contains(fact) ? "已确认" : "未确认", c.Facts.Contains(fact) ? "已确认" : "未确认"));
        if (chapter != c.Chapter) changes.Add(new("chapter", "", "章节", chapter.ToString(), c.Chapter.ToString()));
        changes.AddRange(ActivityRecords.Changes(before, c).Select(x => new StoryChange(x.Operation, x.Key, x.Label, x.Before, x.After)));
        if (!action.Repeatable) changes.Add(new("content-action", action.Id, action.Label, "未完成", "已完成"));
        c.PendingRulings[index] = ruling with { Story = new(requestId, "action", action.Id, ruling.Check!.Success ? "success" : "failure",
            "本人确认沿用当前行动已记录且匹配的检定", "已启用导入剧本", c.ActingActorId, DateTimeOffset.UtcNow, result.Summary, changes.ToArray()) };
        return result with { Kind = "story.verified", Check = null, RulingId = ruling.Id, IntentId = rootId,
            Summary = "沿用已记录检定，未重掷：" + result.Summary };
    }
}
