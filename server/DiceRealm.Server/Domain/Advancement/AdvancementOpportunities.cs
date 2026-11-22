namespace DiceRealm.Server.Domain;

public sealed record AdvancementAward(string ActorId, string Kind, int Value, string Rationale, int Sequence);
public sealed record AwardAdvancementRequest(string RequestId, int ExpectedVersion, string ActorId, string Kind, int Value, string Rationale);
public sealed record PreviewAdvancementRequest(int ExpectedVersion, AdvancementDraft Draft);
public sealed record ApplyAdvancementRequest(string RequestId, int ExpectedVersion, AdvancementDraft Draft);
public sealed record AdvancementClassOption(string Id, string Name, int Level, bool Eligible, string Reason);
public sealed record AdvancementView(int Version, int Level, int MaximumLevel, int Experience, bool Available, string Reason,
    AdvancementClassOption[] Classes, AdvancementPreview? Preview = null);

public static class AdvancementOpportunities
{
    public static int Experience(Campaign c, string actor) => (c.AdvancementAwards ?? []).Where(a => a.ActorId == actor && a.Kind == "experience").Sum(a => a.Value);
    public static int MaximumLevel(Campaign c, string actor)
    {
        int xp = Experience(c, actor);
        int level = AdvancementCatalog.Get().Experience.Count(n => n <= xp);
        level = Math.Max(level, (c.AdvancementAwards ?? []).Where(a => a.ActorId == actor && a.Kind == "milestone").Select(a => a.Value).DefaultIfEmpty(1).Max());
        if (c.Adventure?.Level2Milestone is { } milestone && ContentRuntime.Matches(c, milestone)) level = Math.Max(2, level);
        return Math.Min(20, level);
    }
    public static string Block(Campaign c)
    {
        if (c.ActingCharacter.Build is null) return "旧预设角色继续使用原有升级流程。";
        if (c.Archived) return "战役已归档。";
        if (!ContentRuntime.Ready(c)) return "请先启用冒险内容。";
        if (!CharacterReviews.CanAct(c)) return "角色尚未通过 DM 审核。";
        if (ContextualRolls.Current(c) is not null) return "请先确认或放弃待投掷请求。";
        if (ActionUnderstanding.Current(c) is not null) return "请先继续或放弃当前意图。";
        if (CombatEngine.InCombat(c)) return "请先结束战斗。";
        if (!ContentRuntime.SafeRest(c)) return "请到可安全休整的地点完成成长。";
        if (c.ActingCharacter.Level >= 20) return "角色总等级已达到 20。";
        if (MaximumLevel(c, c.ActingActorId) <= c.ActingCharacter.Level) return "尚未获得下一等级的成长资格。";
        return "";
    }
    public static AdvancementView View(Campaign c, AdvancementDraft? draft = null)
    {
        string reason = Block(c);
        var character = c.ActingCharacter;
        var state = character.Build is null ? null : AdvancementEngine.State(character);
        var options = AdvancementCatalog.Get().Classes.Select(cls =>
        {
            int level = state?.Classes.SingleOrDefault(s => s.ClassId == cls.Id)?.Level ?? 0;
            bool eligible = state is not null && (level > 0 || AdvancementEngine.MeetsPrimary(character, cls)
                && state.Classes.All(s => AdvancementEngine.MeetsPrimary(character, AdvancementCatalog.Get().Classes.Single(c => c.Id == s.ClassId))));
            return new AdvancementClassOption(cls.Id, cls.Name, level, eligible, eligible ? "" : "兼职需要当前所有职业及新职业的主要属性均满足 13 点要求。");
        }).ToArray();
        AdvancementPreview? preview = draft is null ? null : AdvancementEngine.Evaluate(character, draft, MaximumLevel(c, c.ActingActorId));
        if (preview is not null && reason != "") preview = preview with
        {
            CanApply = false, Character = null, Issues = [..preview.Issues, new("growth", "advancement_unavailable", reason, "level")]
        };
        return new(c.Version, character.Level, MaximumLevel(c, c.ActingActorId), Experience(c, c.ActingActorId), reason == "", reason, options, preview);
    }
    public static Resolution Award(Campaign c, AwardAdvancementRequest request)
    {
        if (request.ActorId is null || !PartyEngine.Characters(c).Any(p => p.Id == request.ActorId)
            || request.Kind is not ("experience" or "milestone") || request.Rationale is null
            || request.Rationale.Trim().Length is < 1 or > 1000 || request.Rationale.Any(char.IsControl))
            throw new GameException("invalid_advancement_award", "请选择有效角色、成长依据和奖励类型。");
        var ch = PartyEngine.CharacterFor(c, request.ActorId);
        if (ch.Build is null) throw new GameException("advancement_build_required", "旧预设角色不采用完整建卡的成长奖励。");
        int xp = Experience(c, request.ActorId);
        if (request.Value < 1 || request.Kind == "experience" && request.Value > 355000 - xp
            || request.Kind == "milestone" && (request.Value > 20 || request.Value <= Math.Max(ch.Level, MaximumLevel(c, request.ActorId))))
            throw new GameException("invalid_advancement_award", "经验奖励须为正数且累计不超过 355000；里程碑须高于当前已获等级且不超过 20。");
        if ((c.AdvancementAwards?.Count ?? 0) >= 10000) throw new GameException("advancement_award_capacity", "成长依据记录已达到上限，原始记录不会删除。", 409);
        c.AdvancementAwards ??= [];
        c.AdvancementAwards.Add(new(request.ActorId, request.Kind, request.Value, request.Rationale.Trim(), c.Version + 1));
        string amount = request.Kind == "experience" ? request.Value + " 经验值" : "升至 " + request.Value + " 级的里程碑资格";
        return new("resolved", "growth.award", ch.Name + " 获得 " + amount + "。依据：" + request.Rationale.Trim()
            + "。角色须逐级预览并确认选择；尚未升级或恢复资源。", null, ["growth-opportunity:" + ch.Id]);
    }
}
