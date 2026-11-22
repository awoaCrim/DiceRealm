using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Application;

// Request/execution-local identity only, never a response cache or an authorization grant.
// All comparisons happen after authorization, while holding the actual campaign gate.
public static class CampaignTimeline
{
    private sealed record Context(string Id, bool Mutation, bool Control);
    private static readonly AsyncLocal<Context?> current = new();
    public static IDisposable Bind(string? id, bool mutation, bool control = false)
    {
        var previous = current.Value;
        current.Value = new(id ?? "", mutation, control);
        return new Scope(() => current.Value = previous);
    }
    internal static void ValidateAccess(Campaign c, bool write)
    {
        if (current.Value is { Control: false } context && (write || context.Mutation)) Require(c, context.Id);
    }
    internal static void RequireRequest(Campaign c) => Require(c, current.Value?.Id ?? "");
    internal static void Require(Campaign c, string? timeline)
    {
        // The legacy branch keeps its original contract until its first restore/restart.
        if (!string.IsNullOrEmpty(c.TimelineId) && c.TimelineId != (timeline ?? ""))
            throw new GameException("campaign_timeline_changed", "游戏已读档或重开，请同步新的时间线；旧请求不会在新进度执行。", 409);
    }
    private sealed class Scope(Action close) : IDisposable
    {
        public void Dispose() => close();
    }
}
