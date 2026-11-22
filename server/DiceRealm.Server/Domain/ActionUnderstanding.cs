namespace DiceRealm.Server.Domain;

public sealed record IntentResponseRequest(string RequestId, int ExpectedVersion, string IntentId,
    string Decision, string OptionId = "", string Text = "");
public sealed record IntentClarification(string Question, string Answer);
public sealed record IntentOptionView(string Id, string Label, string Category, ActionDetails Details);
public sealed record PendingIntentView(string Id, string Text, string Question, IntentOptionView[] Options,
    IntentClarification[] Clarifications, int Version, bool Available, string Reason, string Source);

// Private, server-created commands. A model/player may select an offered id, never populate these fields.
public sealed record CharacterActionIntent(string Operation, string Key, int Value = 1,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] string? ChoiceIds = null);
public sealed record ActionCandidate(string Id, string Label, string Category, ActionDetails Details,
    Intent? Action = null, CharacterActionIntent? Character = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] WorldRoutePlan? WorldRoute = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] VerifiedStoryPlan? Consequence = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] BoardCommandRequest? BoardCommand = null)
{
    public IntentOptionView View() => new(Id, Label, Category, Details);
    public bool SameCommand(ActionCandidate other) => Action == other.Action && Character == other.Character && WorldRoute == other.WorldRoute && Consequence == other.Consequence && BoardCommand == other.BoardCommand;
}

public sealed class PendingIntent
{
    public required string Id { get; init; }
    public required string ActorId { get; init; }
    public required string Text { get; init; }
    public int RootSequence { get; init; }
    public int Version { get; set; }
    public string Status { get; set; } = "pending";
    public bool Published { get; set; }
    // An empty-public v43 root never publishes its input by publishing a later result.
    // Stored with the intent so projections of cold continuation events need no root lookup.
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingDefault)]
    public bool PrivateRoot { get; set; }
    public string Question { get; set; } = "";
    public string Source { get; set; } = "";
    public ActionCandidate[] Options { get; set; } = [];
    // Frozen creation policy for a later selected combat/board command. Missing means legacy.
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingDefault)]
    public int NpcNamingVersion { get; set; }
    // Missing keeps pre-v42 combat preparation when an old option is later confirmed.
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingDefault)]
    public bool UseCurrentBoardMap { get; set; }
    public List<IntentClarification> Clarifications { get; init; } = [];
    public PromptCallTrace[] PromptCalls { get; set; } = [];
    public Resolution? Result { get; set; }
    public ActionOrigin? ResultOrigin { get; set; }
    public string Narrative { get; set; } = "";
    public string NarrativeSource { get; set; } = "system";
    public string PrivateText { get; set; } = "";
    // Harness can execute several authoritative steps under one input. Narrative decoration
    // must never erase the earlier dice, costs or per-step origins from the activity projection.
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public List<HarnessActionStep>? HarnessSteps { get; set; }
    // Private model notes for future read-only history; never an authoritative state update.
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public NarrativeContinuityEntry[]? Continuity { get; set; }
    // Accepted current acquisitions retain the model-supplied delivery basis alongside
    // authoritative inventory changes; the basis is not itself proof of ownership.
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public StoryItemGrant[]? StoryAcquisitions { get; set; }
    // Exact no-dice comparisons already applied in this action; prevent replacing a failed
    // active check with a passive success, or changing a settled threshold on retry.
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public List<SceneCheckSpecification>? PassiveChecks { get; set; }
}

public static class ActionUnderstanding
{
    public const int MaximumClarifications = 3;
    public const string RulingRequestSummary = "已交给主持判断，等待回应。";
    // Interpretation is private until the actor chooses an action or sends it for adjudication.
    // Cancellation before publication must not reveal the abandoned original text/history.
    public static bool RootVisibleTo(Campaign c, GameEvent e)
    {
        if (e.HostOnly && !PartyEngine.IsHost(c)) return false;
        if (e.ReviewActorId.Length > 0 && !PartyEngine.IsHost(c) && e.ReviewActorId != c.ActingActorId) return false;
        if (string.IsNullOrEmpty(e.Resolution?.IntentId)) return true;
        var intent = c.PendingIntents.FirstOrDefault(i => i.Id == e.Resolution.IntentId);
        if (intent is null) return false;
        if (intent.ActorId == c.ActingActorId) return true;
        if (!intent.PrivateRoot) return intent.Published;
        // Continuations publish only their own result, never earlier private requests.
        return e.Sequence != intent.RootSequence && !PrivateDelivery(e) && e.Kind != "intent.cancel" &&
            e.Resolution?.Status is not ("awaiting_confirmation" or "awaiting_clarification");
    }
    // New empty-public deliveries do not expose the private action's existence or audit.
    public static bool PrivateDelivery(GameEvent e) => e.PrivateMessages is not null && e.Narrative.Length == 0;
    public static bool VisibleTo(Campaign c, GameEvent e) =>
        (RootVisibleTo(c, e) && !PrivateDelivery(e)) || e.PrivateMessages is not null && PrivateStories.Parts(c, e).Length > 0;
    // Private story text reaches only its actor seat and the host; everyone else gets it blanked.
    public static bool MaySeePrivate(Campaign c, string actorId) => PartyEngine.IsHost(c) || actorId == c.ActingActorId;
    // An adjudication request is not a public result. Old saves/receipts can contain
    // the host's full question in Summary/Text; redact only on read, including for its actor.
    private static bool IsRulingRequest(Resolution? result) => result is { Status: "needs_adjudication", Kind: "adjudicate" };
    public static Resolution ForViewer(Campaign c, Resolution result) => CombatVisibility.ForViewer(c,
        !PartyEngine.IsHost(c) && IsRulingRequest(result) ? result with { Summary = RulingRequestSummary } : result);
    public static GameEvent ForViewer(Campaign c, GameEvent e)
    {
        var parts = e.PrivateMessages is not null ? PrivateStories.Parts(c, e) : null;
        if (!RootVisibleTo(c, e) || PrivateDelivery(e))
            return new(e.Id, e.Sequence, "story.private", "", "", e.NarrativeSource, e.CreatedAt, null, c.ActingActorId, PrivateParts: PrivateStories.Parts(c, e));
        if (PartyEngine.IsHost(c)) return e with { Origin = ProjectOrigin(c, e.Origin, e.Resolution), PrivatePart = PrivateStories.Part(c, e), PrivateMessages = null, PrivateParts = parts };
        return e with
        {
            Text = IsRulingRequest(e.Resolution) ? RulingRequestSummary : CombatVisibility.ProjectGeneratedText(c, e.Text, e.Resolution),
            Narrative = CombatVisibility.ProjectGeneratedText(c, e.Narrative, e.Resolution),
            Origin = ProjectOrigin(c, e.Origin, e.Resolution),
            Resolution = e.Resolution is { } result ? ForViewer(c, result) : null,
            PrivateText = MaySeePrivate(c, e.ActorId) ? e.PrivateText : "",
            PrivatePart = PrivateStories.Part(c, e), PrivateMessages = null, PrivateParts = parts
        };
    }
    public static ActionOrigin? ProjectOrigin(Campaign c, ActionOrigin? origin, Resolution? result)
    {
        origin = CombatVisibility.ProjectOrigin(c, origin, result);
        var intent = c.PendingIntents.FirstOrDefault(i => i.Id == result?.IntentId);
        return origin is not null && intent is { PrivateRoot: true } && intent.ActorId != c.ActingActorId
            ? origin with { Input = "", Label = "", Clarifications = null } : origin;
    }
    public static PendingRuling ForViewer(Campaign c, PendingRuling r)
    {
        if (r.ActorId != c.ActingActorId && c.PendingIntents.Any(i => i.PrivateRoot && i.RootSequence == r.OriginSequence))
            r = r with { Text = "" };
        if (PartyEngine.IsHost(c)) return r with { PrivatePart = PrivateStories.Part(c, r) };
        // Reason is the host-facing request. Text is the player's original action;
        // Rationale, Check and Story are explicitly published dispositions and stay readable.
        return r with { Reason = RulingRequestSummary, PrivateText = MaySeePrivate(c, r.ActorId) ? r.PrivateText : "", PrivatePart = PrivateStories.Part(c, r) };
    }
    public static string NormalizePrivate(string? value, int maximum, string code)
    {
        if (string.IsNullOrEmpty(value)) return "";
        if (value.Length > maximum || value.Any(ch => char.IsControl(ch) && ch is not ('\n' or '\r')))
            throw new GameException(code, "仅该玩家可见的文字过长或含不允许的控制字符。");
        return value.Trim();
    }
    public static PendingIntent? Current(Campaign c) => c.PendingIntents.FirstOrDefault(i => i.ActorId == c.ActingActorId && i.Status == "pending");
    public static PendingIntentView? View(Campaign c)
    {
        var intent = Current(c);
        if (intent is null) return null;
        string reason = !GameLifecycle.CanAct(c) ? GameLifecycle.View(c).Message : c.Archived ? "战役已归档，请放弃此意图。" : c.Version != intent.Version
            ? "冒险状态已变化，请放弃旧意图后重新描述；不会自动执行。" : "";
        return new(intent.Id, intent.Text, intent.Question, intent.Options.Select(o => o.View()).ToArray(),
            intent.Clarifications.ToArray(), intent.Version, reason == "", reason, intent.Source);
    }

    // Uses the same available projections as the existing UI. No new rule implementation lives here.
    public static ActionCandidate[] Candidates(Campaign c, bool includeNatural = true, string rootId = "", bool includeStandard = true, bool includeStandardExpansion = true, bool includeRestChoices = true, bool includeRecording = true, bool includeWeaponSelection = true, bool includeLoadout = false, bool includeWearables = false)
    {
        if (!GameLifecycle.CanAct(c)) return [];
        var result = new List<ActionCandidate>();
        void Add(string label, string category, ActionDetails details, Intent? action = null, CharacterActionIntent? character = null)
            => result.Add(new("option-" + result.Count, label, category, details, action, character));
        var available = Adventure.Choices(c).Where(a => (!includeLoadout || a.Kind != "equipment.equip") && (includeStandard || !StandardCombatEngine.Uses(c, a.Kind)) && (includeStandardExpansion || !StandardCombatEngine.ExpandedChoice(c, a))).ToArray();
        foreach (var choice in ActionInformation.Build(c, available).Where(a => available.Any(x => x.Kind == a.Kind && x.Target == a.Target)))
            Add(choice.Label, "action", choice.Details ?? new("", "", ""), new(choice.Kind, choice.Target));
        var sheet = CharacterPlayEngine.View(c, executingIntentId: rootId);
        if (!sheet.Enabled) return result.ToArray();
        foreach (var equipment in sheet.Equipment.Where(e => e.Available && (!includeLoadout || PlayCatalog.Equipment(e.Id)?.Kind is "LA" or "MA" or "HA")))
            Add((equipment.Equipped ? "收起 / 卸下 " : "准备 ") + equipment.Name, "equipment",
                new(equipment.Name, equipment.Seconds + " 秒", "当前角色", "只改变装备准备状态，不自动攻击。"),
                character: new("equip", equipment.Id, equipment.Equipped ? 0 : 1));
        if (includeWeaponSelection && !includeLoadout)
            foreach (var equipment in sheet.Equipment.Where(e => e.CanActivate))
                Add("当前使用 " + equipment.Name, "equipment",
                    new(equipment.Name, "0 秒", "当前角色", "切换当前攻击武器，其他已准备武器保持携带；不自动攻击。"),
                    character: new("equip", equipment.Id));
        if (includeLoadout)
            foreach (var loadout in (sheet.Loadout?.Options ?? []).Where(o => o.Available))
                Add(loadout.Label, "equipment", new(loadout.Label, loadout.Seconds + " 秒", "本人装备槽", "只修改指定槽位/组合/握持，不自动攻击。"),
                    character: new("loadout", loadout.Key));
        if (includeWearables && sheet.Wearables is { } wearables)
        {
            foreach (var wear in wearables.Options.Where(o => o.Available))
                Add(wear.Label, "equipment", new(wear.Label, "0 秒", "本人穿戴槽", "只改变真实穿戴；卸下不结束同调。"), character: new("wear", wear.Key));
            foreach (var attune in wearables.AttunementOptions.Where(o => o.Available))
                Add(attune.Label, "attunement", new(attune.Label, "本人专注短休1小时（3600秒）",
                    attune.Key == "unattune:" + attune.ItemId ? "本人已记录的同调" : "本人接触该实物",
                    "正常恢复本人短休资源并可选择生命骰；不替全队恢复，不借用先前短休，等待本人确认。"), character: new("attunement", attune.Key));
        }
        foreach (var spell in sheet.Spells.Where(s => includeRecording && s.Available))
            Add(spell.Name + "（" + spell.Source + (spell.Resource == "" ? " · 不消耗已记录资源" : " · " + spell.Resource) + "）", "spell",
                new(spell.Name, spell.Resource == "" ? "不消耗已记录的法术资源" : spell.Resource + " ×1（余 " + spell.Remaining + "）",
                    "目标与效果待裁定", "只记录这一来源的施法；材料、专注、时间与目标效果仍由主持确认。"),
                character: new("spell", spell.Id));
        if (includeRecording && sheet.ActionBlock == "")
        {
            foreach (var item in sheet.Character.Inventory.Where(i => i.Quantity > 0))
                Add("使用 " + item.Name, "item", new(item.Name, "请求阶段不扣除物品", "用法与目标待裁定", "持有 " + item.Quantity + "；不会自动应用物品效果。"),
                    character: new("use", item.Id));
            for (int index = 0; index < sheet.Character.Features.Length; index++)
                Add("运用能力：" + sheet.Character.Features[index], "feature", new(sheet.Character.Features[index], "请求阶段不扣资源", "触发与目标待裁定",
                    "仅请求已有能力的裁定，不代表已经生效。"), character: new("feature", index.ToString(System.Globalization.CultureInfo.InvariantCulture)));
        }
        if (includeNatural)
        {
            foreach (var choice in NaturalActions.Choices(c, sheet))
                Add(choice.Label, "effect", NaturalActions.Details(choice), character: new("execute", choice.Key));
            foreach (var choice in VerifiedStoryConsequences.Choices(c, rootId))
                result.Add(new("option-" + result.Count, choice.Label, "story", choice.Details, Consequence: choice.Plan));
        }
        if (includeRestChoices && sheet.ActionBlock == "")
            foreach (var choice in (sheet.RestChoices ?? []).Where(s => s.Available))
            {
                IEnumerable<BuildOption[]> selections = choice.Count == 1 ? choice.Options.Select(o => new[] { o })
                    : choice.Options.SelectMany((first, index) => choice.Options.Skip(index + 1).Select(second => new[] { first, second }));
                foreach (var selected in selections)
                {
                    string names = string.Join("、", selected.Select(o => o.Label));
                    Add("长休调整 · " + choice.Label + " → " + names, "rest-choice",
                        new(names, "本来源的一次长休调整机会；不恢复资源", "本人 · " + choice.Label, "只替换选定来源，其他取得与历史不变；等待本人确认。"),
                        character: new("rest-choice", choice.Key, ChoiceIds: string.Join(",", selected.Select(o => o.Id))));
                }
            }
        return result.ToArray();
    }

    public static void Complete(Campaign c, Resolution result, ActionOrigin? origin = null, string narrative = "", string source = "system", string privateText = "", bool? publish = null)
    {
        var intent = c.PendingIntents.FirstOrDefault(i => i.Id == result.IntentId);
        if (intent is null) return;
        intent.Status = result.Status == "cancelled" ? "cancelled" : "completed";
        if (result.Status != "cancelled" && publish != false) intent.Published = true;
        intent.Result = result;
        // Direct execution can advance beyond the preceding intent.request/clarify event.
        // Keep the result marker in the same transaction as the actual completed step.
        intent.Version = c.Version;
        if (origin is not null) intent.ResultOrigin = origin with { Input = intent.Text, Clarifications = intent.Clarifications.ToArray() };
        intent.Narrative = narrative;
        intent.NarrativeSource = source;
        intent.PrivateText = privateText;
        if (c.Harness is not null && result.Status != "narrated")
        {
            intent.HarnessSteps ??= [];
            intent.HarnessSteps.Add(new(c.Version, result, origin));
        }
    }
}
