namespace DiceRealm.Server.Domain;

public sealed record ResolveRulingRequest(string RequestId, int ExpectedVersion, string RulingId, string Outcome,
    string Rationale, string RuleSource, string Ability = "", string Skill = "", int Dc = 0, string Mode = "normal", string CheckType = "ability", string PrivateText = "");

// Human-authored disposition of an unsupported action, never a general state patch.
// Check DC/mode are explicitly attributed to the DM; dice/modifiers stay server-owned.
public sealed class RulingEngine(RulesEngine rules)
{
    // XPHB p14 standard Skills table (verify_ruling_rules.py). Alternate-ability
    // skill checks can be legal under that page; this bounded form does not expose them.
    private static readonly Dictionary<string, string[]> Skills = new()
    {
        ["strength"] = ["Athletics"], ["dexterity"] = ["Acrobatics", "Sleight of Hand", "Stealth"],
        ["constitution"] = [], ["intelligence"] = ["Arcana", "History", "Investigation", "Nature", "Religion"],
        ["wisdom"] = ["Animal Handling", "Insight", "Medicine", "Perception", "Survival"],
        ["charisma"] = ["Deception", "Intimidation", "Performance", "Persuasion"]
    };
    public Resolution Resolve(Campaign c, ResolveRulingRequest request, bool requestRoll = false)
    {
        PartyEngine.RequireHost(c);
        int index = c.PendingRulings.FindIndex(r => r.Id == request.RulingId && r.Status == "pending");
        if (index < 0) throw new GameException("ruling_unavailable", "记录不存在或已经完成裁定。", 409);
        string rationale = Text(request.Rationale, 1000, "裁定理由"), source = Text(request.RuleSource, 240, "规则来源或本场裁定依据");
        string privateText = ActionUnderstanding.NormalizePrivate(request.PrivateText, 1000, "invalid_ruling");
        if (request.Outcome is not ("reject" or "narrative" or "check" or "board_move")) throw new GameException("invalid_ruling", "选择 reject、narrative、check 或待处理棋盘移动的 board_move。");
        var pending = c.PendingRulings[index]; DiceCheck? check = null;
        if (request.Outcome == "check")
        {
            if (CombatEngine.InCombat(c) || pending.CombatId.Length > 0 || pending.SceneId != c.SceneId)
                throw new GameException("ruling_context_changed", "此检定只能在原场景的战斗外进行。旧战斗请求可驳回或作为无数值叙事记录。", 409);
            if (pending.ActorId != PartyEngine.HostId && !c.PartyMembers.Any(m => m.Id == pending.ActorId && !m.Revoked))
                throw new GameException("ruling_actor_unavailable", "原行动角色席位已撤销。", 409);
            var ch = PartyEngine.CharacterFor(c, pending.ActorId);
            if (ch.Conditions.Contains("Unconscious") && request.CheckType != "save") throw new GameException("ruling_actor_unavailable", "原行动角色当前无法进行检定。", 409);
            ValidateCheck(request.Ability, request.Skill, request.Dc, request.Mode, request.CheckType);
            if (requestRoll && !(request.CheckType == "save" && RulesEngine.AutomaticSaveFailure(ch, request.Ability)))
            {
                ContextualRolls.RequireNoPending(c, pending.ActorId);
                var roll = new PendingRoll { Id = Guid.NewGuid().ToString(), ActorId = pending.ActorId, Version = c.Version + 1,
                    Label = "主持要求的" + (request.CheckType == "save" ? "豁免" : "检定"),
                    Description = $"{rationale}\n{request.Ability} / {request.Skill} · DC {request.Dc} · {request.Mode}\n依据：{source}\n确认后服务端投掷并保存；此步骤不自动应用剧情或角色后果。",
                    Ruling = request };
                c.PendingRolls.Add(roll);
                c.PendingRulings[index] = pending with { Status = "awaiting_roll", Outcome = "check", Rationale = rationale,
                    RuleSource = source, ResolvedBy = c.ActingActorId, PrivateText = privateText };
                return new("awaiting_roll", "ruling.request_roll", "已要求原行动角色投掷，等待玩家确认；尚未产生检定结果。", null, [], pending.Id, RollId: roll.Id);
            }
            check = rules.SheetTest(ch,new("", "",request.Ability,request.Skill,0,request.CheckType=="save"),request.Mode);
            check = check with {HasDc=true,Dc=request.Dc,Success=check.Mode!="automatic-failure" && check.Total>=request.Dc};
        }
        else if (request.Ability != "" || request.Skill != "" || request.Dc != 0 || request.Mode != "normal" || request.CheckType!="ability")
            throw new GameException("invalid_ruling", "无检定裁定不能携带检定参数。");
        c.PendingRulings[index] = pending with { Status = "resolved", Outcome = request.Outcome, Rationale = rationale,
            RuleSource = source, ResolvedBy = c.ActingActorId, ResolvedAt = DateTimeOffset.UtcNow, Check = check, PrivateText = privateText };
        string boardNotice = SharedBoard.ResolveMoveRuling(c, pending.Id, request.Outcome == "board_move");
        string outcome = request.Outcome switch { "reject" => "请求未获准", "narrative" => "仅记录叙事结果", "board_move" => "已结算原棋盘移动", _ => check!.Success ? "属性检定成功" : "属性检定未通过" };
        return new("resolved", "ruling.resolve", $"DM 裁定：{outcome}。理由：{rationale}。依据：{source}。{boardNotice}本次裁定不修改 HP、装备、法术位、状态或剧情事实。需要追加剧情变化时可另行预览；无需为了结束文字回应再次提交。原行动已发生的消耗不会自动退还。",
            check, ["ruling:" + pending.Id + ":" + request.Outcome], pending.Id);
    }
    public Resolution CompleteRoll(Campaign c, PendingRoll roll)
    {
        if (roll.ActorId != c.ActingActorId || roll.Ruling is not { } request)
            throw new GameException("roll_unavailable", "当前席位不能确认此投掷。", 409);
        int index = c.PendingRulings.FindIndex(r => r.Id == request.RulingId && r.Status == "awaiting_roll" && r.ActorId == roll.ActorId);
        if (index < 0) throw new GameException("roll_unavailable", "原裁定不再等待投掷。", 409);
        string actor = c.ActingActorId;
        try
        {
            c.PendingRulings[index] = c.PendingRulings[index] with { Status = "pending" };
            c.ActingActorId = PartyEngine.HostId;
            return Resolve(c, request);
        }
        finally { c.ActingActorId = actor; }
    }

    public static void ValidateCheck(string ability, string skill, int dc, string mode, string checkType)
    {
        if (ability is null || !Skills.TryGetValue(ability, out var eligible) || skill is null ||
            (skill.Length > 0 && !eligible.Contains(skill)) || dc is < 5 or > 30 ||
            mode is not ("normal" or "advantage" or "disadvantage") || checkType is not ("ability" or "save") ||
            checkType == "save" && skill != "")
            throw new GameException("invalid_ruling_check", "选择标准属性/对应技能、DC 5..30 及正常/优势/劣势；不接受自定义骰点或加值。");
    }

    private static string Text(string? value, int maximum, string field)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > maximum || value.Any(char.IsControl)) throw new GameException("invalid_ruling", field + "不能为空、过长或含控制字符。");
        return value.Trim();
    }
}
