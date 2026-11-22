namespace DiceRealm.Server.Domain;

// Additive audit data: original inputs and server-calculated changes, never client claims.
public sealed record ActionChange(string ActorId, string Operation, string Key, string Label, string Before, string After);
public sealed record ActionOrigin(string Input, string Label, string RequestedKind, string Target, string ActorName,
    string SceneId, string SceneTitle, ActionChange[] Changes, long ElapsedSecondsBefore = 0, long ElapsedSecondsAfter = 0, IntentClarification[]? Clarifications = null);
public sealed record ActivityEntry(int Sequence, int Version, string ActorId, DateTimeOffset CreatedAt, string Kind,
    string Status, bool Legacy, ActionOrigin? Origin, Resolution? InitialResult, string Narrative, string NarrativeSource, PendingRuling? Ruling, AdventureCorrection? Correction = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] HarnessActionStep[]? Steps = null, string PrivateText = "", string ActionId = "",
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingDefault)] int ContinuationOf = 0,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)] PrivateStoryPart[]? PrivateParts = null);
public sealed record HarnessActionStep(int Sequence, Resolution Result, ActionOrigin? Origin);
public sealed record ActivityPage(string CampaignId, int Version, int Through, int After, int NextAfter, bool HasMore, ActivityEntry[] Entries);
public sealed record StoryFact(string Key, bool Present);
public sealed record StoryRequest(string RequestId, int ExpectedVersion, string RulingId, string Mode, string Rationale,
    string RuleSource, string ContentActionId = "", string Outcome = "", StoryFact[]? Facts = null);
public sealed record StoryChange(string Kind, string Key, string Label, string Before, string After);
public sealed record StoryPreview(int Version, string RulingId, string Mode, string ActionLabel, string ResultText, StoryChange[] Changes, string[] Warnings);
public sealed record StorySettlement(string RequestId, string Mode, string ContentActionId, string Outcome, string Rationale,
    string RuleSource, string ResolvedBy, DateTimeOffset ResolvedAt, string ResultText, StoryChange[] Changes);
public sealed record StoryActionOption(string Id, string Label, string Outcome, bool Available, string Reason);
public sealed record StoryOptions(int Version, string RulingId, StoryFact[] Facts, StoryActionOption[] Actions, string Notice);

public static class ActivityRecords
{
    public static Dictionary<string, Character> Capture(Campaign c) => PartyEngine.Characters(c).ToDictionary(x => x.Id, x => PlayResources.Ensure(x.Character));
    public static ActionChange[] Changes(Dictionary<string, Character> before, Campaign c)
    {
        var changes = new List<ActionChange>();
        foreach (var (actor, original) in before)
        {
            var current = PlayResources.Ensure(PartyEngine.CharacterFor(c, actor));
            void Add(string op, string key, string label, object a, object b)
            { if (!Equals(a, b)) changes.Add(new(actor, op, key, original.Name + " · " + label, a.ToString()!, b.ToString()!)); }
            Add("hp", "", "HP", original.HitPoints, current.HitPoints);
            Add("temporary-hp", "", "临时 HP", original.TemporaryHitPoints, current.TemporaryHitPoints);
            Add("exhaustion", "", "Exhaustion", original.Exhaustion, current.Exhaustion);
            Add("armor-class", "", "AC", original.ArmorClass, current.ArmorClass);
            Add("level", "", "等级", original.Level, current.Level);
            foreach (var key in original.Resources.Select(x => x.Name).Union(current.Resources.Select(x => x.Name)))
                Add("resource", key, key, original.Resources.FirstOrDefault(x => x.Name == key)?.Current ?? 0, current.Resources.FirstOrDefault(x => x.Name == key)?.Current ?? 0);
            foreach (var key in original.Inventory.Select(x => x.Id).Union(current.Inventory.Select(x => x.Id)))
            {
                var a = original.Inventory.FirstOrDefault(x => x.Id == key); var b = current.Inventory.FirstOrDefault(x => x.Id == key);
                Add("inventory", key, b?.Name ?? a!.Name, a?.Quantity ?? 0, b?.Quantity ?? 0);
                Add("equipped", key, (b?.Name ?? a!.Name) + " 装备", a?.Equipped == true ? "是" : "否", b?.Equipped == true ? "是" : "否");
            }
            foreach (string itemId in WearableEquipment.Attunements(original).Select(a => a.ItemId).Union(WearableEquipment.Attunements(current).Select(a => a.ItemId)))
                Add("attunement", itemId, "同调", WearableEquipment.Attunements(original).Any(a => a.ItemId == itemId) ? "已同调" : "未同调",
                    WearableEquipment.Attunements(current).Any(a => a.ItemId == itemId) ? "已同调" : "未同调");
            Add("active-weapon", "", "当前使用武器", PlayCatalog.ActiveWeapon(original)?.Name ?? "无", PlayCatalog.ActiveWeapon(current)?.Name ?? "无");
            var oldLoadout = EquipmentLoadout.Read(original); var newLoadout = EquipmentLoadout.Read(current);
            foreach (string slot in EquipmentLoadout.HandSlots)
            {
                string Label(string id) => id == "" ? "空置" : current.Inventory.FirstOrDefault(i => i.Id == id)?.Name ?? original.Inventory.FirstOrDefault(i => i.Id == id)?.Name ?? id;
                string name = slot switch { "melee-main" => "近战主手", "melee-off" => "近战副手", "ranged-main" => "远程主手", _ => "远程副手" };
                Add("loadout", slot, name, Label(EquipmentLoadout.Id(oldLoadout, slot)), Label(EquipmentLoadout.Id(newLoadout, slot)));
            }
            Add("loadout", "active-set", "持握组合", oldLoadout.ActiveSet == "melee" ? "近战" : "远程", newLoadout.ActiveSet == "melee" ? "近战" : "远程");
            Add("loadout", "melee-grip", "近战握持", oldLoadout.MeleeGrip == "two" ? "双手" : "单手", newLoadout.MeleeGrip == "two" ? "双手" : "单手");
            Add("conditions", "", "状态", string.Join("、", original.Conditions), string.Join("、", current.Conditions));
            Add("prepared-spells", "", "准备法术", string.Join("、", original.PlayState?.PreparedSpells ?? []), string.Join("、", current.PlayState?.PreparedSpells ?? []));
        }
        return changes.ToArray();
    }
    public static void Link(Campaign c, Resolution resolution)
    {
        int i = c.PendingRulings.FindIndex(r => r.Id == resolution.RulingId);
        int root = c.PendingIntents.FirstOrDefault(p => p.Id == resolution.IntentId)?.RootSequence ?? c.Version;
        if (i >= 0 && c.PendingRulings[i].OriginSequence == 0) c.PendingRulings[i] = c.PendingRulings[i] with { OriginSequence = root };
    }
    public static bool IsRoot(GameEvent e) => e.Kind != "story.opening" && (!string.IsNullOrEmpty(e.Resolution?.IntentId) ? e.Kind == "intent.request" : (string.IsNullOrEmpty(e.Resolution?.RollId) || e.Kind == "roll.request") && (e.Origin is not null || e.Kind is "adjudicate" or "observe" or "travel" ||
        ContentRuntime.IsContentKind(e.Kind) || e.Kind.StartsWith("rest.") || e.Kind.StartsWith("party.rest.") || e.Kind.StartsWith("combat.") || e.Kind.StartsWith("growth.") ||
        e.Kind.StartsWith("equipment.") || e.Kind.StartsWith("character.") && e.Kind is not ("character.adjust" or "character.review" or "character.resubmit")));
    // Older board-first Harness turns saved board.* instead of intent.request. Recover only
    // the exact persisted root; never rewrite events or split a multi-step turn into actions.
    public static bool IsRoot(Campaign c, GameEvent e) => IsRoot(e) ||
        e.Kind.StartsWith("board.", StringComparison.Ordinal) && !string.IsNullOrEmpty(e.Resolution?.IntentId) &&
        c.PendingIntents.Any(i => i.Id == e.Resolution.IntentId && i.ActorId == e.ActorId &&
            i.RootSequence == e.Sequence && i.Source == "harness" && i.HarnessSteps is not null);
    public static ActivityEntry Project(Campaign c, GameEvent e, PendingIntent? segment = null)
    {
        if (c.PendingIntents.Any(i => i.Id == e.Resolution?.IntentId && i.PrivateRoot))
            return ProjectEvent(c, e);
        var intent = segment ?? c.PendingIntents.FirstOrDefault(p => p.Id == e.Resolution?.IntentId && p.RootSequence == e.Sequence);
        var current = intent?.Result ?? e.Resolution;
        var ruling = c.PendingRulings.FirstOrDefault(r => r.OriginSequence == e.Sequence || r.Id == current?.RulingId);
        var mechanical = intent?.HarnessSteps?.LastOrDefault(s => s.Result.Status is "resolved" or "needs_adjudication");
        var roll = c.PendingRolls.FirstOrDefault(r => r.Id == current?.RollId) ??
            c.PendingRolls.FirstOrDefault(r => r.Id == mechanical?.Result.RollId);
        var status = intent?.Status == "pending" ? current?.Status ?? "awaiting_clarification" : intent?.Status == "cancelled" ? "cancelled" :
            ruling is null ? roll?.Status == "pending" ? "awaiting_roll" : roll?.Status == "cancelled" ? "cancelled" : "completed" : ruling.Outcome == "reject" ? "rejected" : ruling.Story is not null ? "completed" :
            ruling.Status == "awaiting_roll" ? "awaiting_roll" : ruling.Status == "pending" ? "awaiting_ruling" : ruling.Outcome == "check" && ruling.EffectsRequestId == "" ? "awaiting_consequence" : "completed";
        var origin = roll?.ResultOrigin ?? mechanical?.Origin ?? intent?.ResultOrigin ?? e.Origin;
        if (intent is not null && origin is not null) origin = origin with { Input = intent.Text, Clarifications = intent.Clarifications.ToArray() };
        bool harnessNarrative = intent?.HarnessSteps is not null && intent.NarrativeSource == "harness" && intent.Narrative.Length > 0;
        var result = roll?.Result ?? mechanical?.Result ?? current;
        return new(e.Sequence, c.Version, e.ActorId, e.CreatedAt, e.Kind, status, e.Origin is null, CombatVisibility.ProjectOrigin(c, origin, result),
            result is null ? null : ActionUnderstanding.ForViewer(c, result), harnessNarrative ? intent!.Narrative :
                CombatVisibility.ProjectGeneratedText(c, roll?.Narrative ?? intent?.Narrative ?? e.Narrative, result),
            harnessNarrative ? "harness" : roll?.NarrativeSource ?? intent?.NarrativeSource ?? e.NarrativeSource, ruling is null ? null : ActionUnderstanding.ForViewer(c, ruling),
            c.AdventureCorrections.FirstOrDefault(x => x.OriginSequence == e.Sequence),
            intent?.HarnessSteps?.Select(step => step with { Result = ActionUnderstanding.ForViewer(c, step.Result), Origin = CombatVisibility.ProjectOrigin(c, step.Origin, step.Result) }).ToArray(),
            ActionUnderstanding.MaySeePrivate(c, e.ActorId) ? intent?.PrivateText is { Length: > 0 } text ? text : e.PrivateText : "", intent?.Id ?? e.Resolution?.IntentId ?? "");
    }
    // A private root cannot license an intent-wide view. Keep the event's own result,
    // narrative and mechanical step; never substitute the intent's latest mutable values.
    private static ActivityEntry ProjectEvent(Campaign c, GameEvent e)
    {
        var visible = ActionUnderstanding.ForViewer(c, e);
        if (visible.Kind == "story.private")
            return new(e.Sequence, c.Version, c.ActingActorId, e.CreatedAt, visible.Kind, "completed", false,
                null, null, "", e.NarrativeSource, null, PrivateParts: visible.PrivateParts);
        var result = visible.Resolution;
        var ruling = c.PendingRulings.FirstOrDefault(r => r.Id == result?.RulingId);
        string status = result is { Status: "awaiting_confirmation" or "awaiting_clarification" or "awaiting_roll" or "cancelled" } ? result.Status :
            ruling is null ? "completed" : ruling.Outcome == "reject" ? "rejected" : ruling.Story is not null ? "completed" :
            ruling.Status == "awaiting_roll" ? "awaiting_roll" : ruling.Status == "pending" ? "awaiting_ruling" :
            ruling.Outcome == "check" && ruling.EffectsRequestId == "" ? "awaiting_consequence" : "completed";
        var intent = c.PendingIntents.First(i => i.Id == e.Resolution!.IntentId);
        HarnessActionStep[]? steps = result is not null && intent.HarnessSteps?.Any(s => s.Sequence == e.Sequence) == true
            ? [new(e.Sequence, result, visible.Origin)] : null;
        return new(e.Sequence, c.Version, e.ActorId, e.CreatedAt, e.Kind, status, e.Origin is null,
            visible.Origin, result, visible.Narrative, visible.NarrativeSource, ruling is null ? null : ActionUnderstanding.ForViewer(c, ruling),
            c.AdventureCorrections.FirstOrDefault(x => x.OriginSequence == e.Sequence), steps, visible.PrivateText, intent.Id,
            ContinuationOf: e.Sequence == intent.RootSequence ? 0 : intent.RootSequence, PrivateParts: visible.PrivateParts);
    }
}
