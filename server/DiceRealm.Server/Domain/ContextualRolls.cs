namespace DiceRealm.Server.Domain;

public sealed record Intent(string Kind, string Target);

public sealed record RollResponseRequest(string RequestId, int ExpectedVersion, string RollId, string Decision);
public sealed record PendingRollView(string Id, string Label, string Description, int Version, bool Available, string Reason,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] string? BattleSessionId = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] RollPreview? Preview = null);
public sealed record RollPreview(string Ability, string Skill, string TestKind, int Modifier, string Mode, bool HasDc, int Dc, bool Opposed,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] int[]? DifficultyClasses = null);

// Private persisted continuation. Never expose the action/intent or host check specification as writable client state.
public sealed record SceneCheckSpecification(string SceneId, string Ability, string Skill, int? Dc, string Mode, string SourceId, string Quote,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] string? EncounterId = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingDefault)] bool WaitForNarrative = false,
    // Missing fields retain the historical ability-check contract without migrating old requests.
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] string? CheckType = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] string? Reason = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingDefault)] bool SingleAttempt = false,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] string? CircumstancesHash = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] int[]? DifficultyClasses = null);

public sealed class PendingRoll
{
    public required string Id { get; init; }
    public required string ActorId { get; init; }
    public required string Label { get; init; }
    public required string Description { get; init; }
    public int Version { get; set; }
    public string Status { get; set; } = "pending";
    public string GroupId { get; init; } = "";
    public string IntentId { get; init; } = "";
    public bool Confirmed { get; set; }
    public ActionRequest? Action { get; init; }
    public Intent? Intent { get; init; }
    // Only combat creation uses this; old saved consent must not acquire new naming semantics.
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingDefault)]
    public int NpcNamingVersion { get; init; }
    // Freeze the map-selection policy through later initiative confirmation/restart.
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingDefault)]
    public bool UseCurrentBoardMap { get; init; }
    public ResolveRulingRequest? Ruling { get; init; }
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public SceneCheckSpecification? SceneCheck { get; init; }
    public PromptCallTrace[] PromptCalls { get; init; } = [];
    public Resolution? Result { get; set; }
    public ActionOrigin? ResultOrigin { get; set; }
    public string Narrative { get; set; } = "";
    public string NarrativeSource { get; set; } = "system";
}

public static class ContextualRolls
{
    public static PendingRoll? Current(Campaign c, string? actor = null) =>
        c.PendingRolls.FirstOrDefault(r => r.ActorId == (actor ?? c.ActingActorId) && r.Status == "pending");

    public static void RequireNoPending(Campaign c, string? actor = null)
    {
        if (Current(c, actor) is not null)
            throw new GameException("roll_pending", "仍有待处理的投掷。请确认或明确放弃；若上下文已变化，放弃后重新选择行动。", 409);
    }

    public static PendingRollView? View(Campaign c)
    {
        var roll = Current(c);
        if (roll is null) return null;
        string reason = c.Archived ? "战役已归档，不能继续投掷。" : c.Version != roll.Version ? "行动上下文已变化。请放弃此请求后重新选择；不会自动重掷。" : PartyRest.IsInitiation(roll.Intent?.Kind ?? roll.Action?.Kind ?? "") ? "休整现由主持人发起。请放弃这个旧请求；不会投掷或扣除资源。" : roll.Confirmed ? "你已确认，等待其他队员确认。全队确认前不会掷先攻或开始战斗。" : "";
        string intentId = roll.GroupId == "" ? roll.IntentId : c.PendingRolls.FirstOrDefault(r => r.Id == roll.GroupId)?.IntentId ?? "";
        var battle = CombatAgentSessions.Current(c);
        string? battleSessionId = battle?.Inputs.Any(i => i.IntentId == intentId) == true ? battle.Id : null;
        return new(roll.Id, roll.Label, roll.Description, roll.Version, reason == "", reason, battleSessionId,
            c.Version == roll.Version ? Preview(c, roll) : null);
    }

    private static RollPreview? Preview(Campaign c, PendingRoll roll)
    {
        if (roll.SceneCheck is { } scene)
            return Sheet(scene.Ability, scene.Skill, scene.CheckType == "save", scene.Mode, scene.Dc, scene.EncounterId is not null) with { DifficultyClasses = scene.DifficultyClasses };
        if (roll.Ruling is { Outcome: "check" } ruling)
            return Sheet(ruling.Ability, ruling.Skill, ruling.CheckType == "save", ruling.Mode, ruling.Dc, false);
        if (roll.Intent is { } action)
        {
            if (StandardCombatEngine.PreviewRoll(c, action) is { } combat) return combat;
            if (ContentRuntime.FindAction(c, action.Kind, action.Target)?.Check is { } authored)
            {
                // Authored actions use AbilityCheck, whose mode does not add sheet-only conditions.
                bool advantage = WearableEquipment.Advantage(c.ActingCharacter, authored.Ability, authored.Skill);
                bool disadvantage = authored.Ability == "dexterity" && authored.Skill == "Stealth" && BuildRuntime.StealthDisadvantage(c.ActingCharacter);
                return new(authored.Ability, authored.Skill, "ability", RulesEngine.TestModifier(c.ActingCharacter, authored.Ability, authored.Skill, false),
                    advantage == disadvantage ? "normal" : advantage ? "advantage" : "disadvantage", true, authored.Dc, false);
            }
        }
        // Other operations can contain several different dice (initiative/attack/damage).
        // Their original description remains authoritative; do not guess one d20 or DC.
        return null;
        RollPreview Sheet(string ability, string skill, bool save, string mode, int? dc, bool opposed) => new(
            ability, skill, save ? "save" : "ability", RulesEngine.TestModifier(c.ActingCharacter, ability, skill, save),
            RulesEngine.SheetTestMode(c.ActingCharacter, ability, skill, save, mode), !opposed && dc.HasValue, opposed ? 0 : dc ?? 0, opposed);
    }

    // These are the existing Domain operations that roll for the acting player. Enemy turns and
    // opportunity attacks remain automatic; this is a lifecycle declaration, not another rules engine.
    public static string? Describe(Campaign c, Intent intent)
    {
        if (StandardCombatEngine.Uses(c, intent.Kind)) return StandardCombatEngine.RollDescription(c, intent);
        if (ContentRuntime.FindAction(c, intent.Kind, intent.Target)?.Check is { } check)
            return $"此行动需要 {check.Ability} / {check.Skill} 检定（DC {check.Dc}）。确认后由服务端掷骰并应用剧本结果。";
        return intent.Kind switch
        {
            "combat.start" => "此遭遇需要确定先攻。每位队员分别确认后，服务端才统一投掷先攻并开始遭遇。你的确认不会替队友确认。",
            "combat.attack" => "此攻击需要投掷攻击骰；命中后服务端继续投掷伤害并保存结果。",
            "combat.cast" when intent.Target.StartsWith("fire-bolt:", StringComparison.Ordinal) => "Fire Bolt 需要投掷法术攻击骰；命中后结算伤害。",
            "combat.cast" when intent.Target.StartsWith("magic-missile:", StringComparison.Ordinal) => "Magic Missile 需要投掷伤害骰，无攻击检定。",
            "combat.second_wind" => "Second Wind 需要投掷恢复骰；确认后服务端结算恢复与资源消耗。",
            "rest.hit_die" => "需要投掷生命骰；确认后服务端结算恢复与生命骰消耗。",
            "rest.short" when intent.Target.Contains("hit_die", StringComparison.Ordinal) => "此次短休包含生命骰。确认后开始短休并由服务端投掷、结算恢复与消耗。",
            "character.tactical_mind" => "Tactical Mind 需要为刚才的检定投掷追加骰；结果及消耗由服务端判定。",
            _ => null
        };
    }
}
