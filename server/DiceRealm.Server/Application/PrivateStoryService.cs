using System.Text.Json;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Server.Application;

public sealed partial class GameService
{
    public Task<ActionResponse> SharePrivateStory(string id, string token, SharePrivateStoryRequest request, CancellationToken ct = default)
    {
        RequestId(request.RequestId);
        if (!PrivateStories.ValidSource(request.Source))
            throw new GameException("invalid_story_source", "需要准确的私人消息来源。");
        if (request.Quick && request.Text is not null)
            throw new GameException("invalid_story_text", "快速转述不同时提交手写正文。");
        if (request.Text is { } text && (string.IsNullOrWhiteSpace(text) || text.Length > PrivateStories.MaximumText ||
            text.Any(ch => char.IsControl(ch) && ch is not ('\n' or '\r'))))
            throw new GameException("invalid_story_text", "请填写要说出的内容，最多 1024 字。不要包含不允许的控制字符。");
        string fingerprint = JsonFiles.Hash("adventure/story/share:" + JsonSerializer.Serialize(request, JsonFiles.Options));
        return request.Quick ? QuickRetelling(id, token, request, fingerprint, ct) :
            PublishPrivateStory(id, token, request, fingerprint, request.Text, null, ct);
    }

    private ActionResponse? SharedStoryReceipt(Campaign c, SharePrivateStoryRequest request, string fingerprint)
    {
        var receipt = store.FindReceipt(c, request.RequestId);
        if (receipt is null) return null;
        if (receipt.Fingerprint != fingerprint) throw new GameException("idempotency_conflict", "此请求 ID 已用于另一份内容。", 409);
        return new(Snapshot(c), receipt.Resolution, true, receipt.SharedStoryOutput);
    }

    private async Task<ActionResponse> QuickRetelling(string id, string token, SharePrivateStoryRequest request, string fingerprint, CancellationToken ct)
    {
        var context = await store.Access(id, token, false, c =>
        {
            var prior = SharedStoryReceipt(c, request, fingerprint);
            if (prior is not null) return Task.FromResult((Prior: (ActionResponse?)prior, Actor: "", Name: "", Timeline: "", Text: ""));
            RequireActive(c); GameLifecycle.RequireAction(c);
            if (c.OfflineTrial) throw new GameException("story_retelling_disabled", "离线试跑不会调用模型，请使用手写转述。", 409);
            var part = ShareablePrivateStory(c, request.Source);
            return Task.FromResult((Prior: (ActionResponse?)null, Actor: c.ActingActorId, Name: c.ActingCharacter.Name, Timeline: c.TimelineId ?? "", Text: part.Text));
        }, ct);
        if (context.Prior is not null) return context.Prior;
        async Task Authorize(CancellationToken cancellation) => await store.Access(id, token, false, c =>
        {
            if (SharedStoryReceipt(c, request, fingerprint) is not null) return Task.FromResult(true);
            RequireActive(c); GameLifecycle.RequireAction(c);
            if (c.ActingActorId != context.Actor || (c.TimelineId ?? "") != context.Timeline) throw PrivateStoryUnavailable();
            _ = ShareablePrivateStory(c, request.Source);
            return Task.FromResult(true);
        }, cancellation);
        string generated = await retellings.Generate(id, context.Actor, request.RequestId, fingerprint, context.Timeline,
            context.Name, context.Text, Authorize, ct);
        return await PublishPrivateStory(id, token, request, fingerprint, generated, context.Timeline, ct);
    }

    private Task<ActionResponse> PublishPrivateStory(string id, string token, SharePrivateStoryRequest request, string fingerprint,
        string? words, string? timeline, CancellationToken ct) => store.Access(id, token, true, c =>
        {
            var source = request.Source;
            if (SharedStoryReceipt(c, request, fingerprint) is { } prior) return Task.FromResult(prior);
            if (timeline is not null && (c.TimelineId ?? "") != timeline) throw PrivateStoryUnavailable();
            RequireActive(c);
            GameLifecycle.RequireAction(c);
            bool retelling = words is not null;
            if (request.Quick) _ = ShareablePrivateStory(c, source);
            var shared = c.SharedStories?.FirstOrDefault(s => s.Source == source &&
                (retelling ? s.Publication == "retelling" && s.ActorId == c.ActingActorId && s.Text == words : s.Publication is null));
            if (shared is not null && shared.ActorId != c.ActingActorId) throw PrivateStoryUnavailable();
            if (shared is null)
            {
                var part = ShareablePrivateStory(c, source);
                c.SharedStories ??= [];
                shared = new(c.SharedStories.Count + 1, c.Version, c.ActingActorId, c.ActingCharacter.Name,
                    retelling ? words! : part.Text, DateTimeOffset.UtcNow, source, retelling ? "retelling" : null);
                c.SharedStories.Add(shared);
            }
            var result = new Resolution("resolved", "story.share", retelling ? "已说出这段内容。" : "已公开这条私人信息。", null, ["story-share:" + shared.Sequence]);
            c.Receipts.Add(new(request.RequestId, fingerprint, result, c.ActingActorId, SharedStoryOutput: shared));
            // A retelling changes no mechanical cursor, source publication or map knowledge.
            return Task.FromResult(new ActionResponse(Snapshot(c), result, false, shared));
        }, ct);

    private PrivateStoryPart ShareablePrivateStory(Campaign c, PrivateStorySource source)
    {
        PrivateStoryPart? part = null;
        if (source.Kind == "event" && source.Sequence > 0)
        {
            var e = store.ReadEvents(c, source.Sequence - 1, 1).FirstOrDefault();
            if (e?.Sequence == source.Sequence && e.Id == source.Id && !e.HostOnly &&
                (source.PartId is not null || e.ActorId == c.ActingActorId && ActionUnderstanding.RootVisibleTo(c, e)))
                part = PrivateStories.Parts(c, e, actorOnly: true).FirstOrDefault(p => p.Source == source);
        }
        else if (source.Kind == "ruling")
        {
            var ruling = c.PendingRulings.FirstOrDefault(r => r.Id == source.Id && r.ActorId == c.ActingActorId);
            if (ruling is not null) part = PrivateStories.Part(c, ruling);
        }
        if (part is null || part.Source != source || part.CanShare != true) throw PrivateStoryUnavailable();
        return part;
    }

    public Task<SharedStoryPage> SharedStories(string id, string token, int after, int limit, CancellationToken ct = default)
    {
        if (after < 0 || limit is < 1 or > 100) throw new GameException("invalid_pagination", "after >= 0，limit 在 1..100 之间。");
        return store.Access(id, token, false, c => Task.FromResult(SharedStoryPage(c, after, limit)), ct);
    }
    private static SharedStoryPage SharedStoryPage(Campaign c, int after, int limit)
    {
        var entries = (c.SharedStories ?? []).Where(s => s.Sequence > after).Take(limit).ToArray();
        int next = entries.LastOrDefault()?.Sequence ?? after;
        return new(after, next, (c.SharedStories?.Count ?? 0) > next, entries);
    }
    private static GameException PrivateStoryUnavailable() => new("private_story_unavailable", "这条私人内容不存在、已变化，或不属于当前角色。请刷新消息。", 409);

    private ActivityEntry WithPrivateStories(Campaign c, ActivityEntry entry, IEnumerable<GameEvent> events)
    {
        var parts = events.Where(e => !ActionUnderstanding.PrivateDelivery(e) || e.Sequence == entry.Sequence).SelectMany(e => PrivateStories.Parts(c, e)).ToList();
        if (entry.Ruling is { } ruling && PrivateStories.Part(c, ruling) is { } part) parts.Add(part);
        return entry with { PrivateParts = parts.DistinctBy(p => p.Source).ToArray() };
    }
    private IEnumerable<GameEvent> PrivateStoryEvents(Campaign c, ActivityEntry entry)
    {
        int through = c.PendingIntents.FirstOrDefault(i => i.Id == entry.ActionId)?.Version ?? entry.Sequence;
        int cursor = entry.Sequence - 1;
        while (cursor < through)
        {
            var page = store.ReadEvents(c, cursor, 100, through);
            if (page.Length == 0) yield break;
            foreach (var e in page)
                if (e.Sequence == entry.Sequence || entry.ActionId.Length > 0 && e.Resolution?.IntentId == entry.ActionId) yield return e;
            cursor = page[^1].Sequence;
        }
    }
    private static ActivityEntry PrivateMessageActivity(Campaign c, GameEvent e) =>
        new(e.Sequence, c.Version, c.ActingActorId, e.CreatedAt, "story.private", "completed", false, null, null, "", e.NarrativeSource, null,
            PrivateParts: PrivateStories.Parts(c, e));

    private AdventureOpeningView? OpeningView(Campaign c) => AdventureOpenings.View(c,
        c.Opening?.Entries.Select(entry => c.Events.FirstOrDefault(e => e.Sequence == entry.Sequence && e.Id == entry.EventId) ??
            store.ReadEvents(c, entry.Sequence - 1, 1, entry.Sequence).FirstOrDefault())
            .OfType<GameEvent>() ?? []);
}
