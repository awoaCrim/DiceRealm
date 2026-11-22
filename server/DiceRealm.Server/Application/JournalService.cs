using System.Text.Json;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;

namespace DiceRealm.Server.Application;

public sealed record JournalPage(string CampaignId, int Version, int Through, int After, int NextAfter, bool HasMore, GameEvent[] Events);
public sealed record CampaignRecap(string CampaignId, string Name, int Version, int Chapter, bool Archived,
    string SceneTitle, int ElapsedMinutes, string[] Party, string[] Quests, string[] Branches, int PendingRulings,
    string Source = "server-facts", string Note = "由已保存的剧情事实与角色状态生成；不调用 AI，不改写历史叙事。", QuestView[]? QuestDetails = null);
public sealed record ArchiveCampaignRequest(string RequestId, int ExpectedVersion, bool Archived);

public sealed partial class GameService
{
    private static void RequireActive(Campaign c)
    {
        if (c.Archived) throw new GameException("campaign_archived", "战役已归档为只读；队长可恢复后继续。", 409);
    }
    public Task<JournalPage> Journal(string id, string token, int after, int? through, int limit, CancellationToken ct)
    {
        if (after < 0 || limit is < 1 or > 100 || through is < 1)
            throw new GameException("invalid_pagination", "after >= 0，through >= 1，limit 在 1..100 之间。");
        return store.Access(id, token, false, c =>
        {
            int horizon = through ?? c.Version;
            if (horizon > c.Version || after > horizon) throw new GameException("invalid_pagination", "分页游标超出已保存的历史范围。");
            var events = store.ReadEvents(c, after, limit, horizon);
            // An exhausted stored range can precede the first retained event after a reset.
            // Advance to the frozen horizon, not the unchanged cursor; filter only afterwards.
            int next = events.Length < limit ? horizon : events[^1].Sequence;
            return Task.FromResult(new JournalPage(c.Id, c.Version, horizon, after, next, next < horizon, events.Where(e => ActionUnderstanding.VisibleTo(c, e)).Select(e => ActionUnderstanding.ForViewer(c, e)).ToArray()));
        }, ct);
    }
    public Task<CampaignRecap> Recap(string id, string token, CancellationToken ct) =>
        store.Access(id, token, false, c => Task.FromResult(BuildRecap(c)), ct);
    private static CampaignRecap BuildRecap(Campaign c)
    {
        var world = StoryEngine.Snapshot(c);
        return new(c.Id, c.Name, c.Version, c.Chapter, c.Archived, Adventure.Current(c).Title, c.ElapsedMinutes,
            PartyEngine.Snapshot(c).Members.Where(p => !p.Revoked).Select(p => p.Character.Name + " · " + p.Character.ClassName + " " + p.Character.Level +
                " · HP " + p.Character.HitPoints + "/" + p.Character.MaxHitPoints).ToArray(),
            world.Quests.Select(q => q.Title + " [" + q.Status + "] · " + string.Join("；", q.Objectives.Select(o =>
                (o.Complete ? "✓ " : "○ ") + o.Text))).ToArray(),
            world.Branches.Select(b => b.Label + "：" + b.Choice).ToArray(),
            c.PendingRulings.Count(r => r.Status == "pending"), QuestDetails: world.Quests);
    }
    public Task<ActionResponse> Archive(string id, string token, ArchiveCampaignRequest request, CancellationToken ct) =>
        HostCommand(id, token, request.RequestId, request.ExpectedVersion, "campaign.archive", request, c =>
        {
            if (CombatEngine.InCombat(c)) throw new GameException("combat_active", "请先结束战斗，再归档战役。", 409);
            if (c.Archived == request.Archived) throw new GameException("archive_unchanged", "战役已经处于此状态。", 409);
            c.Archived = request.Archived;
            return new("resolved", "campaign.archive", request.Archived ? "战役已归档。角色、世界和完整历史保留，可以随时恢复。" : "战役已恢复，可以继续冒险。",
                null, ["archived:" + request.Archived.ToString().ToLowerInvariant()]);
        }, ct, allowArchived: true);

    // Bounded-memory JSON Lines transcript: header has public snapshot+recap, followed by one
    // event per line. This is NOT a credential backup / import format. A slow client has a
    // bounded deadline; the campaign gate keeps the exported horizon internally consistent.
    public async Task ExportJournal(string id, string token, HttpResponse response, CancellationToken ct)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromSeconds(60));
        await store.Access(id, token, false, async c =>
        {
            PartyEngine.RequireHost(c);
            response.ContentType = "application/x-ndjson; charset=utf-8";
            response.Headers.ContentDisposition = "attachment; filename=campaign-" + c.Id + "-v" + c.Version + ".ndjson";
            var compact = new JsonSerializerOptions(JsonFiles.Options) { WriteIndented = false };
            await response.WriteAsync(JsonSerializer.Serialize(new { type = "campaign-transcript", formatVersion = 1,
                snapshot = Snapshot(c), recap = BuildRecap(c) }, compact) + "\n", deadline.Token);
            int after = 0;
            while (after < c.Version)
            {
                var page = store.ReadEvents(c, after, 100, c.Version);
                if (page.Length == 0) break; // Ordinary state-only operations have no journal entries.
                foreach (var e in page.Where(e => ActionUnderstanding.VisibleTo(c, e)))
                    await response.WriteAsync(JsonSerializer.Serialize(new { type = "event", value = ActionUnderstanding.ForViewer(c, e) }, compact) + "\n", deadline.Token);
                after = page[^1].Sequence;
            }
            return true;
        }, deadline.Token);
    }
}
