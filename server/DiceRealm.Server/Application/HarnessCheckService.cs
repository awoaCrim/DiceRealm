using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Application;

public sealed record HarnessCheckReadArgs(string Scope = "current", int Offset = 0, int Limit = 8);
internal sealed record HarnessSceneCheckRecord(string Id, string IntentId, string Status, SceneCheckSpecification Specification, Resolution? Result);

public sealed record HarnessCheckArgs(string Ability, string Skill, string Mode, string SourceId, string Quote, int? Dc = null, bool Passive = false, string? EncounterId = null);

// Keep the old DTO strict: saved v0..43 calls must not accept the new adjudication fields.
public sealed record HarnessCheckV44Args(string Ability, string Skill, string Mode, string SourceId, string Quote,
    int? Dc = null, bool Passive = false, string? EncounterId = null, string CheckType = "ability", string Reason = "")
{
    internal HarnessCheckArgs Check() => new(Ability, Skill, Mode, SourceId, Quote, Dc, Passive, EncounterId);
}

public sealed partial class GameService
{
    private (HarnessToolOutcome Outcome, Resolution Resolution) RequestHarnessCheck(Campaign c, string runId,
        string input, HarnessCheckArgs args, AdventureContext context, int contract, string checkType = "ability", string reason = "")
    {
        bool savingThrow = checkType == "save";
        if (contract >= 44)
        {
            if (reason is null || reason.Length > 500 || reason.Any(ch => char.IsControl(ch) && ch is not ('\n' or '\r')))
                throw new GameException("harness_invalid_payload", "检定裁定依据不能超过500字符或含不允许的控制字符。");
            reason = reason.Trim();
        }
        ContextualRolls.RequireNoPending(c);
        if ((savingThrow ? CombatEngine.InCombat(c) : CombatEngine.Restricted(c)) || ActionUnderstanding.Current(c) is not null ||
            c.PendingRulings.Any(r => r.ActorId == c.ActingActorId && r.Status is "pending" or "awaiting_roll"))
            throw new GameException("check_context_unavailable", "请先完成当前行动；此入口只用于战斗外的本人检定。", 409);
        if (c.ActingCharacter.Exhaustion >= 6 || !savingThrow && c.ActingCharacter.Conditions.Contains("Unconscious"))
            throw new GameException("check_context_unavailable", "当前角色无法进行主动检定。", 409);
        if (contract < 34 && args.Dc is null)
            throw new GameException("invalid_ruling_check", "旧检定请求缺少DC。");
        if (contract >= 50 && !args.Passive && args.EncounterId is null && args.Dc is null)
            throw new GameException("invalid_ruling_check", "主动检定或豁免必须在投掷前确定DC；没有作者阈值时由AI DM选择DC 5..30并提供reason，不可先投骰再定难度。");
        // Reuse the check/save validator; 10 is validation-only, never a saved DC.
        RulingEngine.ValidateCheck(args.Ability, args.Skill, args.Dc ?? 10, args.Mode, checkType);
        var opposition = args.EncounterId is null ? null : RuntimeEncounters.Current(c);
        if (args.EncounterId is not null && (contract < 35 || savingThrow || args.Dc is not null || args.Ability != "wisdom" || args.Skill != "Perception" ||
            opposition?.Definition.Id != args.EncounterId || opposition.Concealment is not { Length: > 0 } ||
            args.SourceId != opposition.SourceId || args.Quote != opposition.Quote))
            throw new GameException("check_source_unavailable", "对抗检定必须引用已保存的当前遭遇隐匿记录，不接收模型DC。", 409);
        if (args.Passive && (savingThrow || args.Ability != "wisdom" || args.Skill != "Perception"))
            throw new GameException("invalid_ruling_check", "被动判断只支持 Wisdom (Perception)。");
        string quote = WorldMemories.Text(args.Quote, 800, multiline: true);
        bool grounded = opposition is not null || HasSceneEvidence(c, context, contract, args.SourceId, quote);
        if (!grounded) throw new GameException("check_source_unavailable", "检定需要当前提供的场景依据；模型叙事不能自证。", 409);
        if (contract >= 34 && args.Dc is { } threshold)
        {
            bool matchingDc = System.Text.RegularExpressions.Regex.IsMatch(quote,
                @"(?i)(?<![A-Z0-9])DC\s*[:：]?\s*" + threshold.ToString(System.Globalization.CultureInfo.InvariantCulture) + @"(?!\d|\.\d)");
            if (!matchingDc)
            {
                if (contract < 44)
                    throw new GameException("check_source_unavailable", "所引原文没有对应的明确DC。不要推算敌方隐匿；缺少阈值时先裁定，不先掷无从判定的骰子。", 409);
                if (System.Text.RegularExpressions.Regex.IsMatch(quote, @"(?i)(?<![A-Z0-9])DC\s*[:：]?\s*\d"))
                    throw new GameException("check_source_unavailable", "所引原文已给出DC，须使用对应阈值，不能用裁定理由替换。", 409);
                if (reason.Length == 0)
                    throw new GameException("invalid_ruling_check", "普通场景未预写DC时，由AI DM在投掷前确定难度并提供reason说明判断目标、环境与难度依据，无需人工主持发起。");
            }
        }
        // Publish only distinct numeric targets, not creature identities/counts/positions.
        // Freeze before consent; old requests retain their original disclosure contract.
        int[]? difficulties = contract >= 50 && !args.Passive && opposition is not null
            ? EncounterConcealment.Difficulties(c) : null;
        // Failed concealment is automatically discoverable but may not yet have been
        // delivered to this actor. Resolve it through the existing zero-dice observation.
        bool noUncertainOpposition = difficulties is { Length: 0 };
        if (noUncertainOpposition) args = args with { Passive = true };
        var (intent, root) = HarnessRoot(c, runId, input);
        var circumstances = contract >= 47 && !savingThrow && opposition is null ? HarnessSceneContexts.Build(c, context, contract) : null;
        var specification = new SceneCheckSpecification(c.SceneId, args.Ability, args.Skill, args.Dc, args.Mode, args.SourceId, quote, args.EncounterId,
            WaitForNarrative: contract >= 40, CheckType: contract >= 44 ? checkType : null, Reason: contract >= 44 ? reason : null, SingleAttempt: contract >= 47 && !savingThrow,
            CircumstancesHash: circumstances is not null
                ? HarnessJson.Fingerprint(HarnessJson.Element(new { character = c.ActingCharacter, scene = Adventure.Current(c).Summary,
                    evidence = circumstances.PublicEvidence.Concat(circumstances.DmOnly)
                        .Where(e => e.Id == args.SourceId).Select(e => e.Summary).ToArray() })) : null, DifficultyClasses: difficulties);
        bool SameTask(SceneCheckSpecification check) => check.SceneId == c.SceneId && check.Ability == args.Ability &&
            check.Skill == args.Skill && check.SourceId == args.SourceId && check.Quote == quote && (check.CheckType ?? "ability") == checkType;
        if (specification.SingleAttempt) RequireUnusedSceneCheck(c, specification, args.Passive, runId);
        if (!specification.SingleAttempt && (c.PendingRolls.Any(r => r.IntentId == runId && r.SceneCheck is { } check && SameTask(check)) ||
            intent.PassiveChecks?.Any(SameTask) == true))
            throw new GameException("check_already_requested", "本次行动已有此项判断，请承接结果，不要更换阈值或重新检定。", 409);
        if (args.Passive)
        {
            (intent.PassiveChecks ??= []).Add(specification);
            int modifier = RulesEngine.TestModifier(c.ActingCharacter, "wisdom", "Perception", false);
            int score = RulesEngine.PassivePerception(c.ActingCharacter, args.Mode);
            var check = new DiceCheck("wisdom", "Perception", [], 0, modifier, score, args.Dc ?? 0, args.Dc is { } dc && score >= dc, "passive", HasDc: args.Dc.HasValue);
            if (args.EncounterId is not null) EncounterConcealment.Search(c, args.EncounterId, runId, score, specification.WaitForNarrative,
                specification.SingleAttempt ? "passive" : null);
            var passive = new Resolution("resolved", "check.passive", args.EncounterId is not null
                ? noUncertainOpposition ? "当前对抗无需掷骰；已登记本人可知的观察，等待叙事交付。"
                    : "已完成被动察觉；发现记录仅供本人和主持使用，未掷骰。" : args.Dc.HasValue
                ? "已按当前角色能力完成被动察觉判断；未掷骰。发现与后续反应由DM继续处理。"
                : "已记录当前被动察觉数值；没有已确认的阈值，尚未判定发现与否，未掷骰。", check, [], IntentId: runId);
            RecordIntent(c, intent, passive, root ? "intent.request" : passive.Kind);
            ActionUnderstanding.Complete(c, passive, intent.ResultOrigin);
            return (ToolOutcome(c, new { version = c.Version, resolution = passive }), passive);
        }
        string label = savingThrow ? "行动豁免" : "行动检定";
        bool automaticFailure = savingThrow && RulesEngine.AutomaticSaveFailure(c.ActingCharacter, args.Ability);
        string description = savingThrow
            ? $"{args.Ability} 豁免 · {args.Mode}。" + (automaticFailure
                ? "当前状态按规则自动失败，直接保存结果，不需投掷。" : "确认后由服务端投掷。") + "此步骤不会自动改变角色资源或应用剧情后果。"
            : $"{args.Ability} / {args.Skill} · {args.Mode}。确认后由服务端投掷；不会自动公开发现或改变角色资源。";
        var roll = new PendingRoll
        {
            Id = Guid.NewGuid().ToString(), ActorId = c.ActingActorId, IntentId = runId, Version = c.Version + 1,
            Label = label, Description = description +
                (difficulties is not null ? "DC " + string.Join(" / ", difficulties) + "。分别与已保存的对抗阈值比较。"
                    : args.EncounterId is not null ? "服务端将与已保存的对抗记录比较，不公开对方阈值。"
                    : args.Dc is null ? "当前未确认难度，只记录骰点，不预判成功或失败。" : "DC " + args.Dc + "。"),
            SceneCheck = specification
        };
        c.PendingRolls.Add(roll);
        if (automaticFailure)
        {
            // The existing save rules require no dice here. Keep the same persisted result
            // link/deduplication as a confirmed roll, without inventing a consent step.
            var automatic = CompleteSceneCheck(c, roll);
            roll.Status = "resolved";
            roll.Result = automatic;
            RecordIntent(c, intent, automatic, root ? "intent.request" : automatic.Kind);
            ActionUnderstanding.Complete(c, automatic, intent.ResultOrigin);
            return (ToolOutcome(c, new { version = c.Version, resolution = automatic }), automatic);
        }
        var resolution = new Resolution("awaiting_roll", "check.request", $"等待本人确认{label}，尚未产生结果。", null, [], RollId: roll.Id, IntentId: runId);
        RecordIntent(c, intent, resolution, root ? "intent.request" : resolution.Kind);
        ActionUnderstanding.Complete(c, resolution, intent.ResultOrigin);
        return (ToolOutcome(c, new { version = c.Version, resolution }, WaitFor(resolution)), resolution);
    }

    private static object ReadSceneChecks(Campaign c, HarnessCheckReadArgs args)
    {
        var entries = c.PendingRolls.Where(r => r.ActorId == c.ActingActorId && r.SceneCheck?.SceneId == c.SceneId)
            .Select(r => new HarnessSceneCheckRecord(r.Id, r.IntentId, r.Status, r.SceneCheck!, r.Result))
            .Concat(c.PendingIntents.Where(i => i.ActorId == c.ActingActorId).SelectMany(i =>
                (i.PassiveChecks ?? []).Select((s, index) => new HarnessSceneCheckRecord(
                    i.Id, i.Id, "passive", s, i.HarnessSteps?.Count(step => step.Result.Kind == "check.passive") == i.PassiveChecks?.Count
                        ? i.HarnessSteps?.Where(step => step.Result.Kind == "check.passive").ElementAtOrDefault(index)?.Result : null))
                    .Where(r => r.Specification.SceneId == c.SceneId)))
            .ToArray();
        return new { version = c.Version, scope = "scene", actorId = c.ActingActorId, entries = entries.Skip(args.Offset).Take(args.Limit).ToArray(),
            total = entries.Length, nextOffset = args.Offset + args.Limit < entries.Length ? (int?)(args.Offset + args.Limit) : null };
    }

    private static bool SameSceneCheckTask(SceneCheckSpecification first, SceneCheckSpecification second) =>
        first.SceneId == second.SceneId && (first.CheckType ?? "ability") == (second.CheckType ?? "ability") &&
        (first.EncounterId is not null || second.EncounterId is not null
            ? first.EncounterId is not null && first.EncounterId == second.EncounterId
            : first.SourceId == second.SourceId && first.Quote == second.Quote &&
                first.Ability == second.Ability && first.Skill == second.Skill);

    private static void RequireUnusedSceneCheck(Campaign c, SceneCheckSpecification specification, bool passive,
        string intentId, string? confirmingRollId = null)
    {
        // These are persisted authoritative records, not a bounded event/history window.
        // Encounter identity survives a new input, changed phrasing and tactical-map binding.
        // A new input or map is not a changed task. A real character/source change can
        // permit a new attempt, but the DM must explain its relevance in reason. The hash
        // is evidence of change, not a claim that every equipment/condition change matters.
        bool Unchanged(SceneCheckSpecification prior) => specification.EncounterId is not null ||
            prior.CircumstancesHash is null || string.IsNullOrWhiteSpace(specification.Reason) ||
            prior.CircumstancesHash == specification.CircumstancesHash;
        bool active = c.PendingRolls.Any(r => r.Id != confirmingRollId && r.ActorId == c.ActingActorId &&
            r.SceneCheck is { } prior && SameSceneCheckTask(prior, specification) &&
            (r.IntentId == intentId || r.Status == "resolved" && r.Result?.Check is not null && Unchanged(prior)));
        bool repeatedPassive = passive && c.PendingIntents.Any(i => i.ActorId == c.ActingActorId &&
            i.PassiveChecks?.Any(prior => SameSceneCheckTask(prior, specification) && (i.Id == intentId || Unchanged(prior))) == true);
        if (active || repeatedPassive)
            throw new GameException("check_already_requested", "此项判断已有记录。请承接已保存结果，不因换一句输入、阈值或地图重新检定；可用checks_result读取本人场景记录。", 409);
    }

    private Resolution CompleteSceneCheck(Campaign c, PendingRoll roll)
    {
        var spec = roll.SceneCheck!;
        bool savingThrow = spec.CheckType == "save";
        if (c.SceneId != spec.SceneId || (savingThrow ? CombatEngine.InCombat(c) : CombatEngine.Restricted(c)) || c.ActingCharacter.Exhaustion >= 6 ||
            !savingThrow && c.ActingCharacter.Conditions.Contains("Unconscious"))
            throw new GameException("roll_context_changed", "原场景或角色状态已变化，请放弃旧请求。", 409);
        RulingEngine.ValidateCheck(spec.Ability, spec.Skill, spec.Dc ?? 10, spec.Mode, spec.CheckType ?? "ability");
        if (spec.SingleAttempt) RequireUnusedSceneCheck(c, spec, passive: false, roll.IntentId, roll.Id);
        var check = rules.SheetTest(c.ActingCharacter, new("", "", spec.Ability, spec.Skill, 0, savingThrow), spec.Mode);
        check = check with { HasDc = spec.Dc.HasValue, Dc = spec.Dc ?? 0, Success = check.Mode != "automatic-failure" && spec.Dc is { } dc && check.Total >= dc,
            DifficultyClasses = spec.DifficultyClasses };
        if (spec.EncounterId is not null) EncounterConcealment.Search(c, spec.EncounterId, roll.IntentId, check.Total, spec.WaitForNarrative,
            spec.SingleAttempt ? "active" : null);
        return new("resolved", "check.resolve", spec.EncounterId is not null
            ? "搜寻检定已完成；发现记录仅供本人和主持使用，不自动公开或发动攻击。" : check.Mode == "automatic-failure"
            ? "已按角色当前状态记录豁免自动失败；未掷骰，也未自动应用剧情后果。" : spec.Dc.HasValue
            ? savingThrow ? "行动豁免已完成，后续反应由AI DM根据结果继续处理；此步骤未自动应用剧情后果。"
                : "行动检定已完成，发现与后续反应由DM根据结果继续处理。"
            : "行动骰点已记录；当前没有已确认的难度，尚未判定成功或失败，不得据此宣称发现或安全。", check, [], RollId: roll.Id, IntentId: roll.IntentId);
    }
}
