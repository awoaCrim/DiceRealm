using System.IO.Compression;
using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.DependencyInjection;
using static DiceRealm.Tests.HarnessTests;

namespace DiceRealm.Tests;

internal static class HarnessWorkspaceTests
{
    private static string Url(string id, string suffix = "") => $"/api/v1/campaigns/{id}/harness/workspace" + suffix;
    private static async Task<HarnessWorkspace> Workspace(Host h, string id) => (await h.Http.GetFromJsonAsync<HarnessWorkspace>(Url(id)))!;
    private static HarnessPreset Changed(int version = 2) => Preset with { Version = version, SystemPrompt = "  新原文\n逐字保留\t结尾  \n" };
    private static HarnessSkill[] Skills(string content = "  Skill 原文\n\t保留空白  ") => [new("guide", "说明", content)];
    private static Task<HarnessWorkspaceResult> Save(Host h, string id, HarnessWorkspace w, HarnessPreset? preset = null, HarnessSkill[]? skills = null) =>
        Post<HarnessWorkspaceResult>(h, id, "harness/workspace/draft", new SaveHarnessDraftRequest(Id(), w.Version, preset ?? Changed(), skills ?? Skills()));
    private static Task<HarnessWorkspaceResult> Publish(Host h, string id, HarnessWorkspace w) =>
        Post<HarnessWorkspaceResult>(h, id, "harness/workspace/publish", new PublishHarnessRequest(Id(), w.Version));
    private static Task<HarnessWorkspaceResult> Activate(Host h, string id, HarnessWorkspace w, int revision) =>
        Post<HarnessWorkspaceResult>(h, id, "harness/workspace/activate", new ActivateHarnessRequest(Id(), w.Version, revision));
    private static async Task Error(HttpResponseMessage response, HttpStatusCode status, string code)
    {
        Check.Equal(status, response.StatusCode);
        using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync()); Check.Equal(code, body.RootElement.GetProperty("code").GetString()!);
    }
    public static async Task LifecycleReplayAndVersionIsolation()
    {
        var model = new Model((_, _) => Text()); var h = await Host.Start(configure: Configure(model));
        var owner = await Create(h); string id = owner.Snapshot.Id;
        var w = await Workspace(h, id); Check.Equal(1, w.Version); Check.Equal(Preset.SystemPrompt, w.Active.Preset.SystemPrompt);
        Check.True(!Directory.Exists(Path.Combine(h.Root, "workspaces")), "GET must not initialize disk");
        var preview = await h.Http.PostAsJsonAsync(Url(id, "/preview"), new HarnessProfileRequest(Changed(), Skills()));
        Check.Equal(HttpStatusCode.OK, preview.StatusCode); Check.Equal(Changed().SystemPrompt, (await preview.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("profile").GetProperty("preset").GetProperty("systemPrompt").GetString()!);
        Check.True(!Directory.Exists(Path.Combine(h.Root, "workspaces")), "preview must be pure");
        var request = new SaveHarnessDraftRequest(Id(), w.Version, Changed(), Skills());
        var concurrent = await Task.WhenAll(Enumerable.Range(0, 2).Select(_ => Post<HarnessWorkspaceResult>(h, id, "harness/workspace/draft", request)));
        Check.Equal(1, concurrent.Count(r => r.Replayed)); w = concurrent[0].Workspace;
        Check.Equal(2, w.Version); Check.Equal(1, w.ActiveRevision); Check.Equal(Changed().SystemPrompt, w.Draft.Preset.SystemPrompt);
        await Error(await h.Http.PostAsJsonAsync(Url(id, "/draft"), request with { Skills = [] }), HttpStatusCode.Conflict, "idempotency_conflict");
        await Error(await h.Http.PostAsJsonAsync(Url(id, "/publish"), new PublishHarnessRequest(Id(), 1)), HttpStatusCode.Conflict, "workspace_stale_version");
        w = (await Publish(h, id, w)).Workspace; Check.Equal(2, w.LatestRevision); Check.Equal(1, w.ActiveRevision);
        await Error(await h.Http.PostAsJsonAsync(Url(id, "/publish"), new PublishHarnessRequest(Id(), w.Version)), HttpStatusCode.Conflict, "workspace_already_published");
        w = (await Activate(h, id, w, 2)).Workspace; Check.Equal(Changed().SystemPrompt, w.Active.Preset.SystemPrompt);
        var original = await h.Http.GetFromJsonAsync<HarnessRevisionContent>(Url(id, "/revisions/1")); Check.Equal(Preset.SystemPrompt, original!.Profile.Preset.SystemPrompt);
        w = (await Save(h, id, w, Changed() with { SystemPrompt = "不同的同名版本" })).Workspace;
        await Error(await h.Http.PostAsJsonAsync(Url(id, "/publish"), new PublishHarnessRequest(Id(), w.Version)), HttpStatusCode.Conflict, "workspace_preset_conflict");
        w = (await Save(h, id, w, Changed(), Skills("Skill 新版本，同 system 允许"))).Workspace;
        w = (await Publish(h, id, w)).Workspace; Check.Equal(3, w.LatestRevision);
        var page = await h.Http.GetFromJsonAsync<HarnessRevisionPage>(Url(id, "/revisions?limit=2")); Check.Equal(2, page!.Items.Length); Check.Equal(3, page.Items[0].Revision); Check.Equal(2, page.NextBefore!.Value);
        var tail = await h.Http.GetFromJsonAsync<HarnessRevisionPage>(Url(id, "/revisions?before=2&limit=2")); Check.Equal(1, tail!.Items.Single().Revision); Check.True(tail.NextBefore is null);
        w = (await Activate(h, id, w, 1)).Workspace; Check.Equal(Preset.SystemPrompt, w.Active.Preset.SystemPrompt);
        var s = (await h.Get(id))!; Check.Equal(owner.Snapshot.Version, s.Version); Check.Equal(owner.Snapshot.Character.Required().HitPoints, s.Character.Required().HitPoints); Check.Equal(0, model.Calls);
        string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, configure: Configure(model)); h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        var replay = await Post<HarnessWorkspaceResult>(h, id, "harness/workspace/draft", request with { RequestId = request.RequestId.ToUpperInvariant() });
        Check.True(replay.Replayed); Check.Equal(w.Version, replay.Workspace.Version);
        await Post<ActionResponse>(h, id, "archive", new ArchiveCampaignRequest(Id(), s.Version, true));
        Check.True((await Post<HarnessWorkspaceResult>(h, id, "harness/workspace/draft", request)).Replayed);
        await Error(await h.Http.PostAsJsonAsync(Url(id, "/activate"), new ActivateHarnessRequest(Id(), w.Version, 1)), HttpStatusCode.Conflict, "archived");
        var another = await Create(h); var other = await Post<HarnessWorkspaceResult>(h, another.Snapshot.Id, "harness/workspace/draft", request);
        Check.True(!other.Replayed); Check.Equal(2, other.Workspace.Version);
        await h.DisposeAsync();
    }
    public static async Task RevisionHistoryHasNoLifetimeCap()
    {
        var model = new Model((_, _) => Text()); await using var h = await Host.Start(configure: Configure(model)); var owner = await Create(h); string id = owner.Snapshot.Id;
        var w = await Workspace(h, id);
        // Newly permitted IDs do not normalize or alter the original profile/hash algorithm.
        var dotted = Changed() with { Id = "preset." + new string('a', 73) };
        var skills = Skills(); skills[0] = skills[0] with { Id = "skill." + new string('b', 74) };
        w = (await Save(h, id, w, dotted, skills)).Workspace;
        Check.Equal(HarnessJson.ProfileHash(dotted, skills), w.Draft.Hash);
        var originals = new List<PublishHarnessRequest>();
        for (int i = 0; i < 70; i++)
        {
            if (i > 0) w = (await Save(h, id, w, dotted, Skills("content-" + i))).Workspace;
            var request = new PublishHarnessRequest(Id(), w.Version); originals.Add(request);
            w = (await Post<HarnessWorkspaceResult>(h, id, "harness/workspace/publish", request)).Workspace;
        }
        Check.Equal(71, w.LatestRevision);
        Check.True((await Post<HarnessWorkspaceResult>(h, id, "harness/workspace/publish", originals[0])).Replayed);
        var race = new[] { new ActivateHarnessRequest(Id(), w.Version, 1), new ActivateHarnessRequest(Id(), w.Version, 2) };
        var results = await Task.WhenAll(race.Select(r => h.Http.PostAsJsonAsync(Url(id, "/activate"), r)));
        Check.Equal(1, results.Count(r => r.StatusCode == HttpStatusCode.OK)); Check.Equal(1, results.Count(r => r.StatusCode == HttpStatusCode.Conflict));
        Check.Equal(w.Version + 1, (await Workspace(h, id)).Version); Check.Equal(0, model.Calls);
    }
    public static async Task InitializationCrashNeverReverts()
    {
        var model = new Model((_, _) => Text()); var h = await Host.Start(configure: Configure(model)); var owner = await Create(h); string id = owner.Snapshot.Id;
        string campaignDb = Path.Combine(h.Root, "campaigns", id + ".sqlite");
        Sql(campaignDb, "CREATE TABLE fixture_writes(n INTEGER); INSERT INTO fixture_writes VALUES(0); " +
            "CREATE TRIGGER fail_state BEFORE UPDATE ON state WHEN (SELECT n FROM fixture_writes)=1 BEGIN SELECT RAISE(ABORT,'fixture'); END; " +
            "CREATE TRIGGER count_state AFTER UPDATE ON state BEGIN UPDATE fixture_writes SET n=n+1; END;");
        var request = new SaveHarnessDraftRequest(Id(), 1, Changed(), Skills());
        await Error(await h.Http.PostAsJsonAsync(Url(id, "/draft"), request), HttpStatusCode.InternalServerError, "server_error");
        Check.Equal(2, (await Workspace(h, id)).Version);
        string root = h.Root, workspace = Path.Combine(root, "workspaces", id);
        Directory.Move(workspace, workspace + ".lost-fixture"); await h.DisposeAsync();
        h = await Host.Start(root, configure: Configure(model)); h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        await Error(await h.Http.GetAsync(Url(id)), HttpStatusCode.Conflict, "workspace_missing");
        await Error(await h.Http.PostAsJsonAsync(Url(id, "/draft"), request), HttpStatusCode.Conflict, "workspace_missing");
        Check.True(!Directory.Exists(workspace)); Check.Equal(0, model.Calls); Check.Equal(owner.Snapshot.Version, (await h.Get(id))!.Version);
        await h.DisposeAsync();
    }
    public static async Task FrozenRunSkillsMemoryAndRestart()
    {
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var model = new Model(async (n, r, ct) =>
        {
            if (n == 1) return Text("第一个已公开的记忆。");
            if (n == 2) { entered.SetResult(); await release.Task.WaitAsync(ct); return Tool("skills_read", new { id = "guide" }); }
            if (n == 3)
            {
                Check.True(r.Messages.Any(m => m.Role == "tool" && m.Content.Contains("old-skill")));
                return Tool("ask_player", new { question = "是否继续？" });
            }
            return Text("完成冻结运行。");
        });
        var h = await Host.Start(configure: Configure(model)); var owner = await Create(h, skills: Skills("old-skill")); string id = owner.Snapshot.Id;
        var first = await Start(h, owner.Snapshot, "第一个公开输入"); first = await Settled(h, id, first.Id); Check.Equal("completed", first.Status);
        var s = (await h.Get(id))!; var second = await Start(h, s, "第二个输入"); await entered.Task.WaitAsync(TimeSpan.FromSeconds(3));
        var w = await Workspace(h, id); w = (await Save(h, id, w, skills: Skills("new-skill"))).Workspace; w = (await Publish(h, id, w)).Workspace;
        w = (await Activate(h, id, w, 2)).Workspace;
        release.SetResult(); second = await Settled(h, id, second.Id); Check.Equal("waiting", second.Status);
        var stored = h.App.Services.GetRequiredService<HarnessRunStore>().Read(id, PartyEngine.HostId, second.Id)!;
        Check.Equal(Preset.SystemPrompt, stored.Profile.Preset.SystemPrompt); Check.Equal("old-skill", stored.Profile.Skills[0].Content);
        Check.Equal("第一个公开输入", stored.MemorySnapshot!.Entries.Single().Input); string frozen = stored.Turns[0];
        string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, configure: Configure(model)); h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        await Post<HarnessRunView>(h, id, $"harness/runs/{second.Id}/resume", new HarnessResumeRequest(Id(), second.Version, "继续"));
        second = await Settled(h, id, second.Id); Check.Equal("completed", second.Status); Check.Equal(4, model.Calls);
        Check.True(model.Requests.Take(4).All(r => r.System == Preset.SystemPrompt));
        stored = h.App.Services.GetRequiredService<HarnessRunStore>().Read(id, PartyEngine.HostId, second.Id)!; Check.Equal(frozen, stored.Turns[0]);
        s = (await h.Get(id))!;
        await Post<ActionResponse>(h, id, "adventure/correct", new CorrectAdventureRequest(Id(), s.Version, stored.MemorySnapshot!.Entries.Single().OriginSequence, "修订后的公开记忆", "SECRET-CORRECTION-REASON"));
        s = (await h.Get(id))!; var third = await Start(h, s, "读取新版绑定与更正"); third = await Settled(h, id, third.Id); Check.Equal("completed", third.Status);
        Check.Equal(Changed().SystemPrompt, model.Requests.Last().System);
        Check.True(model.Requests.Last().Messages.Any(m => m.Content.Contains("修订后的公开记忆") || m.Content.Contains("\\u4FEE\\u8BA2")));
        var newer = h.App.Services.GetRequiredService<HarnessRunStore>().Read(id, PartyEngine.HostId, third.Id)!;
        Check.True(newer.MemorySnapshot!.Entries.Any(e => e.Corrected && e.Narrative == "修订后的公开记忆"));
        Check.True(!HarnessJson.Serialize(newer.MemorySnapshot).Contains("SECRET-CORRECTION-REASON"));
        Check.Equal(frozen, h.App.Services.GetRequiredService<HarnessRunStore>().Read(id, PartyEngine.HostId, second.Id)!.Turns[0]);
        await h.DisposeAsync();
    }
    private static void Sql(string path, string sql)
    {
        using var db = new SqliteConnection($"Data Source={path};Pooling=False"); db.Open(); using var cmd = db.CreateCommand(); cmd.CommandText = sql; cmd.ExecuteNonQuery();
    }
    public static async Task AtomicFailuresAndCorruptPreservation()
    {
        var model = new Model((_, _) => Text()); await using var h = await Host.Start(configure: Configure(model)); var owner = await Create(h); string id = owner.Snapshot.Id;
        var request = new SaveHarnessDraftRequest(Id(), 1, Changed(), Skills()); string campaignDb = Path.Combine(h.Root, "campaigns", id + ".sqlite");
        Sql(campaignDb, "CREATE TABLE fixture_writes(n INTEGER); INSERT INTO fixture_writes VALUES(0); " +
            "CREATE TRIGGER fail_state BEFORE UPDATE ON state WHEN (SELECT n FROM fixture_writes)=1 BEGIN SELECT RAISE(ABORT,'fixture'); END; " +
            "CREATE TRIGGER count_state AFTER UPDATE ON state BEGIN UPDATE fixture_writes SET n=n+1; END;");
        await Error(await h.Http.PostAsJsonAsync(Url(id, "/draft"), request), HttpStatusCode.InternalServerError, "server_error");
        Check.Equal(2, (await Workspace(h, id)).Version); // catalog committed, final save failed; pre-publication marker survives
        Sql(campaignDb, "DROP TRIGGER fail_state; DROP TRIGGER count_state; DROP TABLE fixture_writes;");
        Check.True((await Post<HarnessWorkspaceResult>(h, id, "harness/workspace/draft", request)).Replayed);
        string db = Path.Combine(h.Root, "workspaces", id, "workspace.sqlite");
        Sql(db, "CREATE TRIGGER fail_receipt BEFORE INSERT ON receipts BEGIN SELECT RAISE(ABORT,'fixture'); END;");
        var publish = new PublishHarnessRequest(Id(), 2);
        await Error(await h.Http.PostAsJsonAsync(Url(id, "/publish"), publish), HttpStatusCode.Conflict, "workspace_corrupt");
        var state = await Workspace(h, id); Check.Equal(2, state.Version); Check.Equal(1, state.LatestRevision);
        Sql(db, "DROP TRIGGER fail_receipt;");
        var w = (await Post<HarnessWorkspaceResult>(h, id, "harness/workspace/publish", publish)).Workspace; Check.Equal(2, w.LatestRevision);
        string document = Path.Combine(h.Root, "workspaces", id, "documents", w.Draft.Hash + ".json"); byte[] good = File.ReadAllBytes(document);
        File.WriteAllText(document, "{bad-source-keep-it}");
        await Error(await h.Http.GetAsync(Url(id)), HttpStatusCode.Conflict, "workspace_corrupt");
        await Error(await h.Http.PostAsJsonAsync(Url(id, "/draft"), request with { RequestId = Id(), ExpectedWorkspaceVersion = w.Version }), HttpStatusCode.Conflict, "workspace_corrupt");
        Check.Equal("{bad-source-keep-it}", File.ReadAllText(document)); File.WriteAllBytes(document, good);
        Sql(db, "PRAGMA user_version=99;"); byte[] future = File.ReadAllBytes(db);
        await Error(await h.Http.GetAsync(Url(id)), HttpStatusCode.Conflict, "workspace_corrupt"); Check.True(future.SequenceEqual(File.ReadAllBytes(db)));
        Sql(db, "PRAGMA user_version=1;");
        File.Move(db, db + ".missing-fixture"); await Error(await h.Http.GetAsync(Url(id)), HttpStatusCode.Conflict, "workspace_missing");
        Check.Equal(0, model.Calls); Check.Equal(owner.Snapshot.Version, (await h.Get(id))!.Version);
    }
    public static async Task MemoryPrivacyAndExportIntegrity()
    {
        var model = new Model((_, _) => Text()); await using var h = await Host.Start(configure: Configure(model)); var owner = await Create(h); string id = owner.Snapshot.Id;
        var w = await Workspace(h, id); w = (await Save(h, id, w)).Workspace; w = (await Publish(h, id, w)).Workspace;
        var store = h.App.Services.GetRequiredService<CampaignStore>();
        await store.Access(id, owner.AccessToken, true, c =>
        {
            for (int i = 0; i < 20; i++)
                c.PendingIntents.Add(new() { Id = Id(), ActorId = PartyEngine.HostId, Text = "public-input-" + i + new string('中', 260), RootSequence = i + 1,
                    Version = i + 1, Status = "completed", Published = true, Source = "harness", Narrative = new string('界', 850), Result = new("narrated", "adventure.narrate", "公开", null, []) });
            c.PendingIntents.Add(new() { Id = Id(), ActorId = "other-seat", Text = "OTHER-SEAT-SECRET", Published = true, Status = "completed", Source = "harness", Result = new("narrated", "test", "other", null, []) });
            c.PendingIntents.Add(new() { Id = Id(), ActorId = PartyEngine.HostId, Text = "PRIVATE-PENDING-SECRET", Published = false, Source = "harness" });
            c.PendingIntents.Add(new() { Id = Id(), ActorId = PartyEngine.HostId, Text = "UNRESOLVED-SECRET", Published = true, Status = "completed", Source = "harness", Result = new("needs_adjudication", "test", "waiting", null, []) });
            c.AdventureCorrections.Add(new(20, "公开更正", "PRIVATE-REASON", PartyEngine.HostId, DateTimeOffset.UtcNow, c.Version));
            return Task.FromResult(true);
        });
        var memory = (await h.Http.GetFromJsonAsync<HarnessMemory>($"/api/v1/campaigns/{id}/harness/memory"))!;
        Check.True(memory.Entries.Length is > 0 and <= 12); Check.True(memory.Entries.All(e => e.Input.Length <= 240 && e.Narrative.Length <= 800));
        Check.True(Encoding.UTF8.GetByteCount(HarnessJson.Serialize(memory)) <= HarnessMemories.MaximumBytes); Check.True(memory.Entries.Last().Corrected);
        foreach (var secret in new[] { "OTHER-SEAT-SECRET", "PRIVATE-PENDING-SECRET", "UNRESOLVED-SECRET", "PRIVATE-REASON" }) Check.True(!HarnessJson.Serialize(memory).Contains(secret));
        var response = await h.Http.GetAsync(Url(id, "/export?revision=2&includeDraft=true")); Check.Equal(HttpStatusCode.OK, response.StatusCode);
        Check.Equal("application/zip", response.Content.Headers.ContentType!.MediaType!);
        Check.True(response.Content.Headers.ContentDisposition is null, "Bearer fetch endpoint; browser owns download filename");
        using var stream = new MemoryStream(await response.Content.ReadAsByteArrayAsync()); using var zip = new ZipArchive(stream);
        string Read(string path) { using var reader = new StreamReader(zip.GetEntry(path)!.Open()); return reader.ReadToEnd(); }
        using var manifest = JsonDocument.Parse(Read("manifest.json"));
        Check.Equal("selected-binding-and-optional-draft-not-game-backup", manifest.RootElement.GetProperty("scope").GetString()!);
        foreach (var file in manifest.RootElement.GetProperty("files").EnumerateArray())
        {
            var entry = zip.GetEntry(file.GetProperty("path").GetString()!)!;
            using var fileStream = entry.Open(); using var bytes = new MemoryStream(); fileStream.CopyTo(bytes);
            Check.Equal(file.GetProperty("byteLength").GetInt32(), (int)bytes.Length);
            Check.Equal(file.GetProperty("sha256").GetString()!, Convert.ToHexStringLower(SHA256.HashData(bytes.ToArray())));
        }
        Check.Equal(Changed().SystemPrompt, Read("selected/preset.md")); Check.Equal(Skills()[0].Content, Read("selected/skills/01.md"));
        Check.True(zip.GetEntry("draft/profile.json") is not null); Check.True(zip.GetEntry("adventure.json") is not null);
        foreach (var entry in zip.Entries)
        {
            Check.True(!entry.FullName.Contains("..")); string body = Read(entry.FullName);
            foreach (var secret in new[] { owner.AccessToken, "OTHER-SEAT-SECRET", "PRIVATE-PENDING-SECRET", "UNRESOLVED-SECRET", "PRIVATE-REASON" }) Check.True(!body.Contains(secret));
        }
        Check.Equal(owner.Snapshot.Version, (await h.Get(id))!.Version); Check.Equal(0, model.Calls);
    }
    public static async Task PermissionsAndLegacyRecord()
    {
        var model = new Model((_, _) => Text()); await using var h = await Host.Start(configure: Configure(model)); var owner = await Create(h); string id = owner.Snapshot.Id;
        var invite = new InviteRequest(Id(), owner.Snapshot.Version, new string('d', 64)); await Post<ActionResponse>(h, id, "invitations", invite);
        var guest = await Post<CreatedCampaign>(h, id, "join", new JoinCampaignRequest(Id(), invite.InviteToken, new string('e', 64), "Guest", Build: FullCreationTests.Named("Guest")));
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
        foreach (string suffix in new[] { "", "/revisions", "/revisions/1", "/export" }) await Error(await h.Http.GetAsync(Url(id, suffix)), HttpStatusCode.Forbidden, "forbidden");
        await Error(await h.Http.PostAsJsonAsync(Url(id, "/draft"), new SaveHarnessDraftRequest(Id(), 1, Changed(), Skills())), HttpStatusCode.Forbidden, "forbidden");
        foreach (string route in new[] { "/preview", "/draft", "/publish", "/activate" })
        {
            await Error(await h.Http.PostAsync(Url(id, route), new StringContent("{malformed", Encoding.UTF8, "application/json")), HttpStatusCode.Forbidden, "forbidden");
            using var oversized = new HttpRequestMessage(HttpMethod.Post, Url(id, route)) { Content = new StringContent(new string('x', 1024 * 1024 + 1), Encoding.UTF8, "application/json") };
            oversized.Headers.ExpectContinue = true; // no body should be requested before authorization
            await Error(await h.Http.SendAsync(oversized), HttpStatusCode.Forbidden, "forbidden");
        }
        var memory = await h.Http.GetFromJsonAsync<HarnessMemory>($"/api/v1/campaigns/{id}/harness/memory"); Check.Equal(guest.Snapshot.Party!.SelfActorId, memory!.ActorId); Check.Equal(0, memory.Entries.Length);
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken); var s = (await h.Get(id))!;
        await Post<ActionResponse>(h, id, "seats/revoke", new RevokeSeatRequest(Id(), s.Version, guest.Snapshot.Party.SelfActorId));
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
        await Error(await h.Http.GetAsync($"/api/v1/campaigns/{id}/harness/memory"), HttpStatusCode.Unauthorized, "unauthorized");
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        // An authentic P0-style persisted record has no memory field and retains its old turn.
        var profile = (await Workspace(h, id)).Active;
        var request = new HarnessInputRequest(Id(), 1, "old-run-input");
        var old = new HarnessRun { Id = request.RequestId, IntentId = Id(), CampaignId = id, ActorId = PartyEngine.HostId, Fingerprint = HarnessJson.Fingerprint(HarnessJson.Element(request)),
            Input = request.Text, Profile = profile, Limits = new(), Version = 1, Status = "completed", Text = "old-result", Turns = [HarnessJson.Serialize(new { input = request.Text, ruleset = "dnd2024" })] };
        h.App.Services.GetRequiredService<HarnessRunStore>().Create(old);
        var replay = await Post<HarnessRunView>(h, id, "harness/runs", request); Check.True(replay.Replayed); Check.Equal("old-result", replay.Text); Check.Equal(0, model.Calls);
        Check.True(!HarnessJson.Serialize(old).Contains("memorySnapshot"));
        var legacy = await h.Create(); await Error(await h.Http.GetAsync(Url(legacy.Snapshot.Id)), HttpStatusCode.Conflict, "harness_campaign_required");
    }
}
