using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.DependencyInjection;

namespace DiceRealm.Tests;

internal static class JournalTests
{
    private static void Auth(Host h, string token) => h.Http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
    public static async Task LargeLegacyAndReplay()
    {
        const string token = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        var root = Path.Combine(Path.GetTempPath(), "dicerealm-journal-" + Guid.NewGuid());
        var c = TestContent.Campaign(name: "Long campaign", tokenHash: token);
        c.Version = 10006;
        var first = new ActionRequest(Guid.NewGuid().ToString(), 1, "observe");
        var resolution = new Resolution("resolved", "observe", "Saved original result", null, []);
        for (int i = 1; i <= c.Version; i++)
        {
            c.Events.Add(new(Guid.NewGuid().ToString(), i, "observe", "Event " + i, "Atmosphere " + i, "authored", DateTimeOffset.UtcNow, i == 1 ? null : resolution));
            if (i > 1) c.Receipts.Add(new(i == 2 ? first.RequestId : Guid.NewGuid().ToString(), i == 2 ? JsonFiles.Hash(JsonSerializer.Serialize(first, JsonFiles.Options)) : "fixture", resolution));
        }
        string path = Path.Combine(root, "campaigns", c.Id + ".json"); JsonFiles.Write(path, c); var original = File.ReadAllBytes(path);
        var dice = new SequenceDice(20); var h = await Host.Start(root, dice);
        Auth(h, new string('b', 64));
        Check.Equal(HttpStatusCode.Unauthorized, (await h.Http.GetAsync($"/api/v1/campaigns/{c.Id}")).StatusCode);
        Check.True(!File.Exists(Path.ChangeExtension(path, ".sqlite")), "Unauthorized access must not migrate");
        Auth(h, token); var s = (await h.Get(c.Id))!;
        Check.Equal(10006, s.Version); Check.Equal(100, s.Events.Length); Check.Equal(9907, s.Events[0].Sequence);
        Check.True(original.SequenceEqual(File.ReadAllBytes(path)), "Migration preserves original JSON bytes");
        var store = h.App.Services.GetRequiredService<CampaignStore>();
        await store.Access(c.Id, token, false, loaded => { Check.Equal(100, loaded.Events.Count); Check.Equal(0, loaded.Receipts.Count); return Task.FromResult(true); });
        var replay = (await (await h.Send(c.Id, first)).Content.ReadFromJsonAsync<ActionResponse>())!;
        Check.True(replay.Replayed); Check.Equal("Saved original result", replay.Resolution.Summary); Check.Equal(0, dice.Count);
        s = (await h.Act(s, "observe")).Snapshot; Check.Equal(10007, s.Version);
        var page = (await h.Http.GetFromJsonAsync<JournalPage>($"/api/v1/campaigns/{c.Id}/journal?after=0&limit=50&through=10006"))!;
        Check.Equal(1, page.Events[0].Sequence); Check.Equal(50, page.NextAfter); Check.True(page.HasMore); Check.Equal("Atmosphere 2", page.Events[1].Narrative);
        var tail = (await h.Http.GetFromJsonAsync<JournalPage>($"/api/v1/campaigns/{c.Id}/journal?after=10000&limit=50&through=10006"))!;
        Check.Equal(6, tail.Events.Length); Check.True(!tail.HasMore); Check.Equal(10007, tail.Version);
        Check.Equal(HttpStatusCode.BadRequest, (await h.Http.GetAsync($"/api/v1/campaigns/{c.Id}/journal?after=0&limit=101")).StatusCode);
        await h.DisposeAsync(); await using var restarted = await Host.Start(root, dice); Auth(restarted, token);
        replay = (await (await restarted.Send(c.Id, first)).Content.ReadFromJsonAsync<ActionResponse>())!;
        Check.True(replay.Replayed); Check.Equal(10007, replay.Snapshot.Version); Check.True(original.SequenceEqual(File.ReadAllBytes(path)));
        Check.Equal(HttpStatusCode.Conflict, (await restarted.Send(c.Id, first with { Kind = "talk" })).StatusCode);
    }
    public static async Task AtomicRollbackAndInvalidMigration()
    {
        await using var h = await Host.Start(); var created = await h.Create(); var id = created.Snapshot.Id;
        var request = new ActionRequest(Guid.NewGuid().ToString(), 1, "observe");
        var response = (await (await h.Send(id, request)).Content.ReadFromJsonAsync<ActionResponse>())!;
        var store = h.App.Services.GetRequiredService<CampaignStore>(); bool failed = false;
        try
        {
            await store.Access(id, created.AccessToken, true, c =>
            {
                c.Version++; c.Facts.Add("must-rollback");
                c.Events.Add(new(Guid.NewGuid().ToString(), c.Version, "bad", "must-rollback", "", "system", DateTimeOffset.UtcNow, null));
                c.Receipts.Add(new(request.RequestId, "duplicate-key", response.Resolution));
                return Task.FromResult(true);
            });
        }
        catch (SqliteException) { failed = true; }
        Check.True(failed);
        bool gapRejected = false;
        try { await store.Access(id, created.AccessToken, true, c => { c.Version++; return Task.FromResult(true); }); }
        catch (InvalidDataException) { gapRejected = true; }
        Check.True(gapRejected, "A new version without its event must never commit");
        var s = (await h.Get(id))!; Check.Equal(2, s.Version); Check.True(!s.Facts.Contains("must-rollback"));
        var events = (await h.Http.GetFromJsonAsync<GameEvent[]>($"/api/v1/campaigns/{id}/events"))!; Check.Equal(2, events.Length);
        Check.True((await (await h.Send(id, request)).Content.ReadFromJsonAsync<ActionResponse>())!.Replayed);
        var bad = TestContent.Campaign(name: "Invalid legacy", tokenHash: created.AccessToken, character: s.Character);
        bad.Version = 2;
        bad.Events.Add(new(Guid.NewGuid().ToString(), 1, "arrival", "", "", "system", DateTimeOffset.UtcNow, null));
        var path = Path.Combine(h.Root, "campaigns", bad.Id + ".json"); JsonFiles.Write(path, bad); var original = File.ReadAllBytes(path);
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.GetAsync($"/api/v1/campaigns/{bad.Id}")).StatusCode);
        Check.True(original.SequenceEqual(File.ReadAllBytes(path))); Check.True(!File.Exists(Path.ChangeExtension(path, ".sqlite")));
    }
    public static async Task ResetHistoryWindowsTerminateWithoutWriting()
    {
        const string token = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        var c = TestContent.Campaign(name: "Reset history", tokenHash: token);
        c.Version = 51;
        for (int i = 1; i <= c.Version; i++)
            c.Events.Add(new(Guid.NewGuid().ToString(), i, i == 51 ? "observe" : "campaign.reset",
                "Saved event " + i, "", "system", DateTimeOffset.UtcNow, null));
        string root;
        await using (var setup = await Host.Start())
        {
            root = setup.Root;
            setup.App.Services.GetRequiredService<CampaignStore>().Create(c);
        }
        // Reproduce the approved offline reset: versions are monotonic, old story is absent.
        string path = Path.Combine(root, "campaigns", c.Id + ".sqlite");
        using (var db = new SqliteConnection($"Data Source={path};Pooling=False"))
        {
            db.Open(); using var command = db.CreateCommand();
            command.CommandText = "DELETE FROM events WHERE sequence < 45"; command.ExecuteNonQuery();
        }
        var before = File.ReadAllBytes(path);
        await using var h = await Host.Start(root); Auth(h, token);
        foreach (int through in new[] { 1, 44 })
        {
            var activity = (await h.Http.GetFromJsonAsync<ActivityPage>($"/api/v1/campaigns/{c.Id}/activity?after=0&through={through}&limit=50"))!;
            Check.Equal(51, activity.Version); Check.Equal(0, activity.Entries.Length);
            Check.Equal(through, activity.NextAfter); Check.True(!activity.HasMore, "Exhausted history must not return an immobile next page");
            var journal = (await h.Http.GetFromJsonAsync<JournalPage>($"/api/v1/campaigns/{c.Id}/journal?after=0&through={through}&limit=50"))!;
            Check.Equal(0, journal.Events.Length); Check.Equal(through, journal.NextAfter); Check.True(!journal.HasMore);
        }
        // A full storage page with no action roots still advances and keeps the next page.
        var hidden = (await h.Http.GetFromJsonAsync<ActivityPage>($"/api/v1/campaigns/{c.Id}/activity?after=0&through=51&limit=2"))!;
        Check.Equal(0, hidden.Entries.Length); Check.Equal(46, hidden.NextAfter); Check.True(hidden.HasMore);
        var firstJournal = (await h.Http.GetFromJsonAsync<JournalPage>($"/api/v1/campaigns/{c.Id}/journal?after=0&through=51&limit=2"))!;
        Check.Equal(2, firstJournal.Events.Length); Check.Equal(46, firstJournal.NextAfter); Check.True(firstJournal.HasMore);
        // Unity's latest window followed by its older empty window must both be valid.
        var latest = (await h.Http.GetFromJsonAsync<ActivityPage>($"/api/v1/campaigns/{c.Id}/activity?after=1&through=51&limit=50"))!;
        Check.Equal(1, latest.Entries.Length); Check.Equal(51, latest.Entries[0].Sequence);
        Check.Equal(51, latest.NextAfter); Check.True(!latest.HasMore);
        var end = (await h.Http.GetFromJsonAsync<ActivityPage>($"/api/v1/campaigns/{c.Id}/activity?after=51&through=51&limit=50"))!;
        Check.Equal(51, end.NextAfter); Check.True(!end.HasMore); Check.Equal(0, end.Entries.Length);
        Check.True(before.SequenceEqual(File.ReadAllBytes(path)), "History GETs must preserve the entire campaign database");
    }
    public static async Task ArchiveRecapAndExport()
    {
        var h = await Host.Start(); var owner = await h.Create(); var s = owner.Snapshot;
        var invite = new InviteRequest(Guid.NewGuid().ToString(), 1, new string('a', 64));
        await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/invitations", invite);
        var join = new JoinCampaignRequest(Guid.NewGuid().ToString(), invite.InviteToken, new string('b', 64), "Lyra", CharacterEngine.Fighter, Build: FullCreationTests.Named("Lyra", CharacterEngine.Wizard));
        var guest = (await (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/join", join)).Content.ReadFromJsonAsync<CreatedCampaign>())!;
        s = (await h.Get(s.Id))!; s = (await h.Act(s, "talk")).Snapshot;
        var req = new ActionRequest(Guid.NewGuid().ToString(), s.Version, "observe");
        s = (await (await h.Send(s.Id, req)).Content.ReadFromJsonAsync<ActionResponse>())!.Snapshot;
        Auth(h, guest.AccessToken);
        Check.Equal(HttpStatusCode.Forbidden, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/archive", new ArchiveCampaignRequest(Guid.NewGuid().ToString(), s.Version, true))).StatusCode);
        Check.Equal(HttpStatusCode.Forbidden, (await h.Http.GetAsync($"/api/v1/campaigns/{s.Id}/journal/export")).StatusCode);
        Check.Equal(HttpStatusCode.OK, (await h.Http.GetAsync($"/api/v1/campaigns/{s.Id}/recap")).StatusCode);
        Auth(h, owner.AccessToken);
        var archive = new ArchiveCampaignRequest(Guid.NewGuid().ToString(), s.Version, true);
        var results = await Task.WhenAll(Enumerable.Range(0, 2).Select(_ => h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/archive", archive)));
        foreach (var r in results) Check.Equal(HttpStatusCode.OK, r.StatusCode);
        s = (await h.Get(s.Id))!; Check.True(s.Archived); Check.Equal(archive.ExpectedVersion + 1, s.Version); Check.Equal(0, s.AvailableActions.Length); Check.True(!s.Party!.CanInvite);
        Check.Equal(HttpStatusCode.Conflict, (await h.Send(s.Id, new(Guid.NewGuid().ToString(), s.Version, "observe"))).StatusCode);
        Check.True((await (await h.Send(s.Id, req)).Content.ReadFromJsonAsync<ActionResponse>())!.Replayed);
        Check.Equal(HttpStatusCode.Gone, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/scene-asset", new ReviseSceneAssetRequest(s.SceneAsset.Id, "new", "coast", [], []))).StatusCode);
        var recap = (await h.Http.GetFromJsonAsync<CampaignRecap>($"/api/v1/campaigns/{s.Id}/recap"))!;
        Check.Equal("server-facts", recap.Source); Check.Equal(2, recap.Party.Length); Check.True(recap.Archived); Check.Equal(0, recap.Branches.Length);
        var export = await h.Http.GetAsync($"/api/v1/campaigns/{s.Id}/journal/export"); Check.Equal(HttpStatusCode.OK, export.StatusCode);
        var text = await export.Content.ReadAsStringAsync(); var lines = text.Split('\n', StringSplitOptions.RemoveEmptyEntries);
        Check.Equal(s.Version + 1, lines.Length); using var header = JsonDocument.Parse(lines[0]);
        Check.Equal("campaign-transcript", header.RootElement.GetProperty("type").GetString());
        Check.Equal(s.Version, header.RootElement.GetProperty("snapshot").GetProperty("version").GetInt32());
        foreach (var forbidden in new[] { owner.AccessToken, guest.AccessToken, invite.InviteToken, "tokenHash", "joinFingerprint", "receipts" }) Check.True(!text.Contains(forbidden));
        for (int i = 1; i < lines.Length; i++) { using var e = JsonDocument.Parse(lines[i]); Check.Equal(i, e.RootElement.GetProperty("value").GetProperty("sequence").GetInt32()); }
        var root = h.Root; await h.DisposeAsync(); await using var restarted = await Host.Start(root); Auth(restarted, owner.AccessToken);
        s = (await restarted.Get(s.Id))!; Check.True(s.Archived);
        var restored = await restarted.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/archive", new ArchiveCampaignRequest(Guid.NewGuid().ToString(), s.Version, false));
        Check.Equal(HttpStatusCode.OK, restored.StatusCode); s = (await restored.Content.ReadFromJsonAsync<ActionResponse>())!.Snapshot;
        Check.True(!s.Archived); Check.True(s.AvailableActions.Length > 0); Check.True(s.Facts.Contains("safe-route"));
        // The old journal horizon stays fixed even after the restored campaign receives new events.
        var page = (await restarted.Http.GetFromJsonAsync<JournalPage>($"/api/v1/campaigns/{s.Id}/journal?after=0&through={archive.ExpectedVersion}"))!;
        Check.Equal(archive.ExpectedVersion, page.Events.Length); Check.True(!page.HasMore);
    }
}
