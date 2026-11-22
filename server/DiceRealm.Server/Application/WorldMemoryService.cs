using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Application;

public sealed partial class GameService
{
    public Task<WorldMemoryPage> ReadWorldMemory(string id, string token, int expectedVersion, string query, string kind,
        int offset, int limit, string scope, CancellationToken ct) => store.Access(id, token, false, c =>
    {
        if (scope is not ("public" or "host") || query is null || query.Length > 120 || query.Any(char.IsControl) ||
            kind is not ("" or "npc" or "quest" or "place" or "clue") || offset is < 0 or > WorldMemories.MaximumEntries || limit is < 1 or > 32)
            throw new GameException("invalid_world_query", "世界信息查询条件或分页范围不合法。");
        if (scope == "host") PartyEngine.RequireHost(c);
        if (expectedVersion != c.Version) throw new GameException("stale_version", "世界信息已变化，请刷新后重新检索。", 409);
        string[] words = query.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        if (words.Length > 8) throw new GameException("invalid_world_query", "每次最多八个查询词。");
        var page = WorldMemories.Read(c, words, kind, offset, limit, scope == "host", localFirst: false);
        return Task.FromResult(new WorldMemoryPage(c.Version, scope, page.Entries, page.Total, page.NextOffset));
    }, ct);

    public Task<ActionResponse> CorrectWorldMemory(string id, string token, CorrectWorldMemoryRequest request, CancellationToken ct) =>
        HostCommand(id, token, request.RequestId, request.ExpectedVersion, "world.correct", request,
            c => WorldMemories.Correct(c, request), ct, hostOnly: true);

    public Task<ActionResponse> CorrectAdventure(string id, string token, CorrectAdventureRequest request, CancellationToken ct) =>
        HostCommand(id, token, request.RequestId, request.ExpectedVersion, "adventure.correct", request, c =>
        {
            var origin = request.OriginSequence < 1 ? null : store.ReadEvents(c, request.OriginSequence - 1, 1).FirstOrDefault();
            if (origin?.Sequence != request.OriginSequence || ActionUnderstanding.PrivateDelivery(origin) ||
                !(ActivityRecords.IsRoot(c, origin) || origin.Narrative.Length > 0 && c.PendingIntents.Any(i => i.PrivateRoot && i.Id == origin.Resolution?.IntentId)) ||
                !ActionUnderstanding.RootVisibleTo(c, origin) ||
                (!string.IsNullOrEmpty(origin.Resolution?.IntentId) && !c.PendingIntents.Any(i => i.Id == origin.Resolution.IntentId && i.Published)))
                throw new GameException("activity_not_found", "找不到可以纠正的已公开玩家行动。", 404);
            string text = WorldMemories.Text(request.Text, 4096, multiline: true), reason = WorldMemories.Text(request.Reason, 1000, multiline: true);
            int index = c.AdventureCorrections.FindIndex(x => x.OriginSequence == request.OriginSequence);
            if (index < 0 && c.AdventureCorrections.Count >= 512)
                throw new GameException("adventure_correction_capacity", "本战役的叙事更正已达到当前上限。", 409);
            var correction = new AdventureCorrection(request.OriginSequence, text, reason, c.ActingActorId, DateTimeOffset.UtcNow, c.Version + 1);
            if (index < 0) c.AdventureCorrections.Add(correction); else c.AdventureCorrections[index] = correction;
            return new("resolved", "adventure.correct", "DM 更正：" + text + "\n理由：" + reason + "\n原记录和已执行规则结果保留；此更正不会重掷或改变角色资源。", null, ["origin:" + request.OriginSequence]);
        }, ct);

    private static Resolution CommitNarrative(Campaign c, PendingIntent intent, AdventureDecision decision, WorldMemoryEntry[] plan, bool root, string privateText = "", Item[]? inventory = null, bool presentDiscoveries = false, PrivateStoryMessage[]? privateMessages = null)
    {
        var before = inventory is null ? null : ActivityRecords.Capture(c);
        if (inventory is not null) PartyEngine.SetCharacter(c, c.ActingActorId, c.ActingCharacter with { Inventory = inventory });
        var changes = before is null ? [] : ActivityRecords.Changes(before, c);
        WorldMemories.Apply(c, plan);
        var result = new Resolution("narrated", "adventure.narrate", "已回应你的行动" + (plan.Length > 0 ? "，并同步 " + plan.Length + " 条公开冒险信息" : "") +
            "。本次仅推进叙事与已知信息，未结算检定、资源、奖励或路线变化。", null, plan.Select(m => "memory:" + m.Id).ToArray(), IntentId: intent.Id);
        var origin = IntentOrigin(c, intent) with { Changes = changes };
        if (changes.Length > 0)
        {
            result = new("resolved", "inventory.grant", "物品已放入背包。", null, changes.Select(change => "inventory:" + change.Key).ToArray(), IntentId: intent.Id);
            intent.ResultOrigin = origin;
        }
        RecordIntent(c, intent, result, root ? "intent.request" : "intent.narrate", decision.Narrative, decision.Source, privateText, privateMessages,
            origin: privateMessages is not null || intent.PrivateRoot ? origin : null);
        string previousNarrative = intent.Narrative, previousSource = intent.NarrativeSource;
        ActionUnderstanding.Complete(c, result, origin, decision.Narrative, decision.Source, privateText,
            publish: privateMessages is null ? null : decision.Narrative.Length > 0);
        if (privateMessages is not null && decision.Narrative.Length == 0 && previousNarrative.Length > 0)
        {
            intent.Narrative = previousNarrative; intent.NarrativeSource = previousSource;
        }
        // Publish this actor's established discoveries with the saved story. This also
        // lets an explicitly new narration deliver a prior failed run's saved result.
        if (presentDiscoveries) EncounterConcealment.PresentDiscoveries(c);
        if (privateMessages is not null) EncounterConcealment.PresentDiscoveries(c, privateMessages);
        return result;
    }
}
