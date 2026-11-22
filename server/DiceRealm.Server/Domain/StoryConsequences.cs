using System.Text.Json;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Server.Domain;

// The same evaluation powers preview and commit. Only authored facts/outcomes are writable.
// No dice, provider calls, arbitrary patches, or client-calculated character adjustments.
public static class StoryConsequences
{
    private sealed record Evaluation(Campaign Copy, int Index, StoryPreview Preview);
    public static StoryPreview Preview(Campaign c, StoryRequest request, GameEvent? origin) => Evaluate(c, request, origin).Preview;
    public static Resolution Apply(Campaign c, StoryRequest request, GameEvent? origin)
    {
        var result = Evaluate(c, request, origin); var p = result.Preview; var r = c.PendingRulings[result.Index];
        c.Facts.Clear(); c.Facts.AddRange(result.Copy.Facts); c.Chapter = result.Copy.Chapter; c.Character = result.Copy.Character;
        if (c.HostOnlySeat)
            foreach (var seat in c.PartyMembers) seat.Character = result.Copy.PartyMembers.Single(m => m.Id == seat.Id).Character;
        c.CompletedContentActions.Clear(); c.CompletedContentActions.AddRange(result.Copy.CompletedContentActions);
        var now = DateTimeOffset.UtcNow;
        c.PendingRulings[result.Index] = r with { Status = "resolved", Outcome = r.Status == "pending" ? "story" : r.Outcome,
            Rationale = r.Status == "pending" ? request.Rationale.Trim() : r.Rationale, RuleSource = r.Status == "pending" ? request.RuleSource.Trim() : r.RuleSource,
            ResolvedBy = r.Status == "pending" ? c.ActingActorId : r.ResolvedBy, ResolvedAt = r.Status == "pending" ? now : r.ResolvedAt,
            Story = new(request.RequestId, request.Mode, request.ContentActionId, request.Outcome, request.Rationale.Trim(), request.RuleSource.Trim(), c.ActingActorId, now, p.ResultText, p.Changes) };
        return new("resolved", "ruling.story", p.ResultText + " 理由：" + request.Rationale.Trim() + "。依据：" + request.RuleSource.Trim() + "。", null,
            p.Changes.Select(x => x.Kind + ":" + x.Key + ":" + x.Before + "->" + x.After).ToArray(), r.Id);
    }
    public static StoryOptions Options(Campaign c, string rulingId, GameEvent? origin)
    {
        PartyEngine.RequireHost(c); var r = c.PendingRulings.FirstOrDefault(r => r.Id == rulingId)
            ?? throw new GameException("ruling_unavailable", "找不到裁定记录。", 404);
        var options = (ContentRuntime.Scene(c)?.Actions ?? []).Select(a =>
        {
            string outcome = a.Check is null || r.Check?.Success == true ? "success" : "failure";
            try
            {
                Evaluate(c, new(Guid.NewGuid().ToString(), c.Version, r.Id, "action", "选项可用性预检", "导入内容", a.Id, outcome), origin);
                return new StoryActionOption(a.Id, a.Label, outcome, true, "");
            }
            catch (GameException ex) { return new StoryActionOption(a.Id, a.Label, outcome, false, ex.Message); }
        }).ToArray();
        return new(c.Version, r.Id, KnownFacts(c).Select(f => new StoryFact(f, c.Facts.Contains(f))).ToArray(), options,
            "仅列出导入内容声明或引用的事实。已付出的角色消耗不会自动退款；剧情后果不会重掷检定。" + (c.HostOnlySeat ? "物品后果作用于原行动的玩家角色。" : "物品奖励进入队长库存。"));
    }
    private static Evaluation Evaluate(Campaign c, StoryRequest q, GameEvent? origin)
    {
        PartyEngine.RequireHost(c);
        if (c.Archived || !ContentRuntime.Ready(c)) throw new GameException("story_unavailable", "归档或未启用内容的战役不能落实剧情后果。", 409);
        if (c.Version != q.ExpectedVersion) throw new GameException("stale_version", "状态已更新，请重新预览剧情后果。", 409);
        Text(q.Rationale, 1000, "理由"); Text(q.RuleSource, 240, "依据");
        if (q.Mode is not ("facts" or "action" or "none") || q.RulingId is null || q.ContentActionId is null || q.Outcome is null ||
            q.RulingId.Length > 80 || q.ContentActionId.Length > 80 || q.Facts?.Length > 16)
            throw new GameException("invalid_story", "剧情后果字段无效；每次最多 16 个事实。");
        int index = c.PendingRulings.FindIndex(r => r.Id == q.RulingId);
        if (index < 0) throw new GameException("ruling_unavailable", "裁定记录不存在。", 409);
        var ruling = c.PendingRulings[index];
        if (ruling.Story is not null || ruling.Outcome == "reject") throw new GameException("story_already_closed", "此行动已落实剧情后果或已驳回，不重复应用。", 409);
        if (q.Mode != "none" && (CombatEngine.InCombat(c) || ruling.CombatId != "" || ruling.SceneId != c.SceneId ||
            !PartyEngine.Characters(c).Any(x => x.Id == ruling.ActorId)))
            throw new GameException("ruling_context_changed", "原行动的场景、战斗或角色席位已改变；只能明确结束且不改变世界。", 409);
        var facts = q.Facts ?? [];
        if (q.Mode != "facts" && facts.Length > 0 || q.Mode != "action" && (q.ContentActionId != "" || q.Outcome != ""))
            throw new GameException("invalid_story", "不能混用不同模式的字段。");
        var effects = new List<ContentEffect>(); ContentAction? action = null;
        string text = "主持确认：此行动到此结束，不追加剧情变化。", label = "不追加剧情变化";
        if (q.Mode == "facts")
        {
            var known = KnownFacts(c).ToHashSet(StringComparer.Ordinal); var distinct = new HashSet<string>();
            if (facts.Length == 0 || facts.Any(f => f is null || f.Key is null || !known.Contains(f.Key) || !distinct.Add(f.Key)))
                throw new GameException("invalid_story_fact", "只能选择不重复的已声明事实，不能伪造 visited 地点记录。");
            effects.AddRange(facts.Select(f => new ContentEffect(f.Present ? "fact" : "removeFact", f.Key)));
            label = "确认剧情事实"; text = "主持已确认剧情事实；任务、地点与路线按导入内容更新。";
        }
        if (q.Mode == "action")
        {
            action = ContentRuntime.Scene(c)!.Actions.FirstOrDefault(a => a.Id == q.ContentActionId)
                ?? throw new GameException("story_action_unavailable", "只能选择原场景中的已有后果。", 409);
            if (!ContentRuntime.Matches(c, action.When) || !action.Repeatable && c.CompletedContentActions.Contains(action.Id))
                throw new GameException("story_action_unavailable", "行动条件不满足或一次性后果已经使用。", 409);
            string outcome = "success";
            if (action.Check is { } spec)
            {
                var check = ruling.Check;
                if (check is null || !check.HasDc || check.TestKind != "ability" || check.Ability != spec.Ability || check.Skill != spec.Skill || check.Dc != spec.Dc)
                    throw new GameException("story_check_mismatch", "此后果需要已记录且属性、技能、DC 相同的检定；不会自动掷骰。", 409);
                outcome = check.Success ? "success" : "failure";
            }
            if (q.Outcome != outcome) throw new GameException("story_outcome_mismatch", "必须使用已记录检定对应的结果；无检定行动只接受 success。", 409);
            var branch = outcome == "success" ? action.Success : action.Failure;
            effects.AddRange(action.Always); effects.AddRange(branch.Effects); text = branch.Text; label = action.Label;
            foreach (var cost in effects.Where(e => e.Op == "item" && e.Amount < 0))
            {
                // Legacy records cannot prove whether an earlier character command already paid.
                string itemActor = c.HostOnlySeat ? ruling.ActorId : PartyEngine.HostId;
                bool paid = origin?.Origin?.Changes.Any(x => x.ActorId == itemActor && x.Operation == "inventory" && x.Key == cost.Key &&
                    int.TryParse(x.Before, out int before) && int.TryParse(x.After, out int after) && after < before) == true;
                bool adjusted = ruling.ActorId == itemActor && ruling.Effects?.Any(x => x.Operation == "inventory" && x.Key == cost.Key &&
                    int.TryParse(x.Before, out int before) && int.TryParse(x.After, out int after) && after < before) == true;
                if (paid || adjusted || origin?.Origin is null)
                    throw new GameException("story_cost_overlap", "此后果可能重复扣除已付物品。请改为确认事实，并单独预览角色调整。", 409);
            }
        }
        var copy = JsonSerializer.Deserialize<Campaign>(JsonSerializer.Serialize(c, JsonFiles.Options), JsonFiles.Options)!;
        copy.ActingActorId = c.HostOnlySeat ? ruling.ActorId : c.ActingActorId;
        // Consequences read topology only; they never mutate world knowledge. Share the
        // authorized request index instead of cloning all cold world bodies through JSON.
        copy.WorldMemoryIndex = c.WorldMemoryIndex;
        ContentRuntime.Apply(copy, effects.ToArray());
        if (action is { Repeatable: false }) copy.CompletedContentActions.Add(action.Id);
        var changes = Diff(c, copy).ToList();
        if (action is { Repeatable: false }) changes.Add(new("content-action", action.Id, action.Label, "未完成", "已完成（不再重复领取）"));
        if (q.Mode == "facts" && changes.Count == 0) throw new GameException("story_no_change", "所选事实没有变化；若要结束行动，请选择不追加剧情变化。", 409);
        string[] warnings = ["原行动已发生的消耗保持不变；不会退款、再次掷骰或自动处理其他角色效果。", "预览只对当前版本有效。主持确认后，其他席位会看到已落实的变化。"];
        return new(copy, index, new(c.Version, ruling.Id, q.Mode, label, text, changes.ToArray(), warnings));
    }
    private static IEnumerable<StoryChange> Diff(Campaign a, Campaign b)
    {
        var changes = new List<StoryChange>();
        void Add(string kind, string key, string label, object before, object after)
        { if (!Equals(before, after)) changes.Add(new(kind, key, label, before.ToString()!, after.ToString()!)); }
        foreach (string f in a.Facts.Union(b.Facts)) Add("fact", f, "事实 · " + f, a.Facts.Contains(f) ? "已确认" : "未确认", b.Facts.Contains(f) ? "已确认" : "未确认");
        Add("chapter", "", "章节", a.Chapter, b.Chapter);
        foreach (var x in ActivityRecords.Changes(ActivityRecords.Capture(a), b)) changes.Add(new(x.Operation, x.Key, x.Label, x.Before, x.After));
        var sa = Adventure.Current(a); var sb = Adventure.Current(b);
        Add("scene", a.SceneId, "当前地点", sa.Title + "\n" + sa.Summary, sb.Title + "\n" + sb.Summary);
        var exitsA = Adventure.Choices(a).Where(x => x.Kind == "travel").ToDictionary(x => x.Target, x => x.Label);
        var exitsB = Adventure.Choices(b).Where(x => x.Kind == "travel").ToDictionary(x => x.Target, x => x.Label);
        foreach (var id in exitsA.Keys.Union(exitsB.Keys)) Add("route", id, exitsB.GetValueOrDefault(id) ?? exitsA[id], exitsA.ContainsKey(id) ? "可前往" : "不可前往", exitsB.ContainsKey(id) ? "可前往" : "不可前往");
        var wa = ContentRuntime.World(a); var wb = ContentRuntime.World(b);
        void Views<T>(string kind, T[] old, T[] next, Func<T, string> key, Func<T, string> label, Func<T, string> value)
        {
            var oldByKey = old.ToDictionary(key); var newByKey = next.ToDictionary(key);
            foreach (string id in oldByKey.Keys.Union(newByKey.Keys))
            {
                bool hasOld = oldByKey.TryGetValue(id, out var ov), hasNew = newByKey.TryGetValue(id, out var nv);
                Add(kind, id, label(hasNew ? nv! : ov!), hasOld ? value(ov!) : "未显示", hasNew ? value(nv!) : "不再显示");
            }
        }
        Views("quest", wa.Quests, wb.Quests, q => q.Id, q => q.Title, q => q.Status + " · " + string.Join("；", q.Objectives.Select(o => (o.Complete ? "✓ " : "○ ") + o.Text)));
        Views("npc", wa.Npcs, wb.Npcs, n => n.Id, n => n.Name, n => n.SceneId + (n.Met ? " · 已结识" : " · 未结识"));
        Views("faction", wa.Factions, wb.Factions, f => f.Id, f => f.Name, f => f.Reputation + " · " + f.Standing);
        Views("branch", wa.Branches, wb.Branches, x => x.Id, x => x.Label, x => x.Choice);
        return changes;
    }
    private static string[] KnownFacts(Campaign c)
    {
        if (c.Adventure is not { } d) return [];
        var facts = new HashSet<string>(StringComparer.Ordinal);
        void Condition(ContentCondition? x) { if (x is not null) foreach (var f in x.All.Concat(x.Any).Concat(x.None)) facts.Add(f); }
        void Effects(IEnumerable<ContentEffect> xs) { foreach (var e in xs.Where(e => e.Op is "fact" or "removeFact")) facts.Add(e.Key); }
        Condition(d.Level2Milestone);
        foreach (var s in d.Scenes)
        {
            foreach (var e in s.Exits) Condition(e.When);
            foreach (var v in s.Variants) Condition(v.When);
            foreach (var a in s.Actions) { Condition(a.When); Effects(a.Always); Effects(a.Success.Effects); Effects(a.Failure.Effects); }
            if (s.Encounter is { } encounter) { Condition(encounter.When); Effects(encounter.OnStart); Effects(encounter.Victory.Effects); }
        }
        foreach (var q in d.Quests) { Condition(q.Visible); Condition(q.Active); Condition(q.Complete); foreach (var o in q.Objectives) { Condition(o.Complete); Condition(o.Visible); } }
        foreach (var n in d.Npcs) { Condition(n.Visible); Condition(n.Met); foreach (var l in n.Locations) Condition(l.When); }
        foreach (var f in d.Factions) { Condition(f.Visible); foreach (var a in f.Adjustments) Condition(a.When); }
        foreach (var b in d.Branches) Condition(b.When);
        return facts.Where(x => !x.StartsWith("visited:", StringComparison.Ordinal)).Order(StringComparer.Ordinal).ToArray();
    }
    private static void Text(string? value, int max, string label)
    { if (string.IsNullOrWhiteSpace(value) || value.Length > max || value.Any(char.IsControl)) throw new GameException("invalid_story", label + "不能为空、过长或含控制字符。"); }
}
