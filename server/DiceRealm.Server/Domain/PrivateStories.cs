using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Serialization;

namespace DiceRealm.Server.Domain;

// A source identifies one saved private field/message, never an entire action.
public sealed record PrivateStorySource(string Kind, string Id, int Sequence, string Revision,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? PartId = null);
public sealed record PrivateStoryPart(PrivateStorySource Source, string ActorId, string Text, bool Shared,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] bool? CanShare = null);
public sealed record SharePrivateStoryRequest(string RequestId, PrivateStorySource Source,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Text = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] bool Quick = false);
public sealed record SharedStory(int Sequence, int AtVersion, string ActorId, string ActorName, string Text, DateTimeOffset CreatedAt, PrivateStorySource Source,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Publication = null);
public sealed record SharedStoryPage(int After, int NextAfter, bool HasMore, SharedStory[] Entries);
public sealed record PrivateMessageRequest(string[] RecipientIds, string Text,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string[]? DiscoveryIds = null);
// Stored only inside the original event. HTTP projections remove this array and expose
// viewer-relative PrivateParts, so recipient lists and other messages cannot escape.
public sealed record PrivateStoryMessage(string PartId, string[] RecipientIds, string Text,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string[]? DiscoveryIds = null);

public static class PrivateStories
{
    public const int MaximumMessages = 12;
    public const int MaximumText = 1024;
    public static string Revision(string text) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(text)));
    public static PrivateStoryPart? Part(Campaign c, string kind, string id, int sequence, string actor, string text)
    {
        if (text.Length == 0 || !ActionUnderstanding.MaySeePrivate(c, actor)) return null;
        var source = new PrivateStorySource(kind, id, sequence, Revision(text));
        return new(source, actor, text, (c.SharedStories ?? []).Any(s => s.Source == source && s.ActorId == actor && s.Publication is null), actor == c.ActingActorId && GameLifecycle.CanAct(c) && !c.Archived);
    }
    public static PrivateStoryPart? Part(Campaign c, GameEvent e) => Part(c, "event", e.Id, e.Sequence, e.ActorId, e.PrivateText);
    public static PrivateStoryPart? Part(Campaign c, PendingRuling r) => Part(c, "ruling", r.Id, r.OriginSequence, r.ActorId, r.PrivateText);
    public static PrivateStoryPart[] Parts(Campaign c, GameEvent e, bool actorOnly = false)
    {
        if (e.HostOnly || e.ReviewActorId.Length > 0) return [];
        var parts = new List<PrivateStoryPart>();
        if ((!actorOnly || e.ActorId == c.ActingActorId) && Part(c, e) is { } legacy) parts.Add(legacy);
        foreach (var message in e.PrivateMessages ?? [])
        {
            bool recipient = message.RecipientIds.Contains(c.ActingActorId, StringComparer.Ordinal);
            if (!recipient && (actorOnly || !PartyEngine.IsHost(c))) continue;
            var source = new PrivateStorySource("event", e.Id, e.Sequence, Revision(message.Text), message.PartId);
            // A shared body is a retelling, not publication of the whole source.
            bool shared = (c.SharedStories ?? []).Any(s => s.Source == source && s.Publication is null);
            parts.Add(new(source, recipient ? c.ActingActorId : message.RecipientIds[0], message.Text, shared, recipient && GameLifecycle.CanAct(c) && !c.Archived));
        }
        return parts.ToArray();
    }
    public static PrivateStoryMessage[] Plan(Campaign c, PrivateMessageRequest[]? messages, string legacyText)
    {
        if (messages is null) return [];
        if (messages.Length > MaximumMessages || legacyText.Length > 0 && messages.Length > 0)
            throw new GameException("harness_invalid_payload", "私人消息过多，或同时使用了旧 private 正文和 privateMessages。");
        var actors = PartyEngine.Characters(c).Select(p => p.Id).ToHashSet(StringComparer.Ordinal);
        return messages.Select(message =>
        {
            if (message is null || message.RecipientIds is not { Length: > 0 and <= 4 } recipients ||
                recipients.Any(id => id is null || !actors.Contains(id)) || recipients.Distinct(StringComparer.Ordinal).Count() != recipients.Length)
                throw new GameException("harness_invalid_payload", "私人消息必须指定本战役真实、有效且不重复的获准角色席位。");
            string text = ActionUnderstanding.NormalizePrivate(message.Text, MaximumText, "harness_invalid_payload");
            if (text.Length == 0) throw new GameException("harness_invalid_payload", "无私人补充时省略消息，不保存空白或占位消息。");
            var discoveries = message.DiscoveryIds;
            if (discoveries is not null && (discoveries.Length > 32 || discoveries.Distinct(StringComparer.Ordinal).Count() != discoveries.Length ||
                discoveries.Any(id => string.IsNullOrEmpty(id) || id.Length > 80 || recipients.Any(actor => !EncounterConcealment.KnownTo(c, id, actor)) ||
                    c.RuntimeEncounters?.Any(s => s.SceneId == c.SceneId && s.Concealment?.Any(e => e.EntityId == id) == true) != true)))
                throw new GameException("harness_invalid_payload", "discoveryIds 只能列出每位收件人已实际发现的当前场景实体，不能借私聊授予发现或位置。");
            return new PrivateStoryMessage(Guid.NewGuid().ToString(), recipients.ToArray(), text, discoveries?.ToArray());
        }).ToArray();
    }
    public static bool ValidSource(PrivateStorySource? source) => source is not null && source.Kind is ("event" or "ruling") &&
        source.Sequence >= 0 && source.Id is { Length: > 0 and <= 80 } && source.Revision is { Length: 64 } &&
        source.Revision.All(char.IsAsciiHexDigit) && (source.PartId is null || source.Kind == "event" && Guid.TryParseExact(source.PartId, "D", out _));
    public static void ValidateState(Campaign c)
    {
        if (c.SharedStories is not { } entries) return;
        if (entries.Where((s, i) => s.Sequence != i + 1 || s.AtVersion < 1 || s.AtVersion > c.Version || !ValidSource(s.Source) ||
                string.IsNullOrEmpty(s.ActorId) || string.IsNullOrEmpty(s.ActorName) || string.IsNullOrEmpty(s.Text) ||
                s.Publication is not (null or "retelling") || s.Publication is null && s.Source.Revision != Revision(s.Text) ||
                s.Publication == "retelling" && s.Text.Length > MaximumText).Any() ||
            entries.Where(s => s.Publication is null).Select(s => s.Source).Distinct().Count() != entries.Count(s => s.Publication is null) ||
            entries.Where(s => s.Publication == "retelling").Select(s => (s.Source, s.ActorId, s.Text)).Distinct().Count() != entries.Count(s => s.Publication == "retelling"))
            throw new GameException("invalid_shared_story", "公开剧情记录损坏；原存档保留。", 409);
    }
}
