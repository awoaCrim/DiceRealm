using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Data.Sqlite;

namespace DiceRealm.Tests;

internal static class HostOnlyCampaignTests
{
    private static string Id() => Guid.NewGuid().ToString();
    private static string Token() => Convert.ToHexStringLower(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32));
    private static Task<string> State(Host h, CreatedCampaign owner) => h.App.Services.GetRequiredService<CampaignStore>()
        .Access(owner.Snapshot.Id, owner.AccessToken, false, c => Task.FromResult(JsonSerializer.Serialize(c, JsonFiles.Options)));
    private static async Task Error(HttpResponseMessage response, HttpStatusCode status, string code)
    {
        Check.Equal(status, response.StatusCode);
        using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Check.Equal(code, body.RootElement.GetProperty("code").GetString());
    }
    private static async Task<CreatedCampaign> Create(Host h, object body, string route = "/api/v1/campaigns")
    {
        var response = await h.Http.PostAsJsonAsync(route, body);
        Check.Equal(HttpStatusCode.Created, response.StatusCode);
        var created = (await response.Content.ReadFromJsonAsync<CreatedCampaign>())!;
        Check.True(created.Snapshot.Character is null);
        Check.True(created.Snapshot.Party!.IsHost);
        Check.Equal(0, created.Snapshot.Party.Members.Length);
        Check.Equal(0, created.Snapshot.AvailableActions.Length);
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", created.AccessToken);
        return created;
    }
    private static async Task<CreatedCampaign> Join(Host h, CreatedCampaign owner, string name)
    {
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        var s = (await h.Get(owner.Snapshot.Id))!;
        var invite = new InviteRequest(Id(), s.Version, Token());
        Check.Equal(HttpStatusCode.OK, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/invitations", invite)).StatusCode);
        var request = new JoinCampaignRequest(Id(), invite.InviteToken, Token(), name, Build: FullCreationTests.Named(name));
        var response = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/join", request);
        Check.Equal(HttpStatusCode.OK, response.StatusCode);
        var guest = (await response.Content.ReadFromJsonAsync<CreatedCampaign>())!;
        Check.Equal("pending", guest.Snapshot.Party!.Members.Single(m => m.Id == guest.Snapshot.Party.SelfActorId).Review!.Status);
        Check.True(guest.Snapshot.Character.Required().Build is not null);
        return guest;
    }
    public static async Task CreationRoutesAndEmptyManagement()
    {
        var dice = new SequenceDice();
        var model = new HarnessTests.Model((_, _) => throw new Exception("Host must not invoke a model"));
        await using var h = await Host.Start(dice: dice, configure: HarnessTests.Configure(model));
        var blank = await Create(h, new { name = "DM only" });
        Check.Equal("draft", blank.Snapshot.Content!.Status);
        var content = await Create(h, new { name = "DM content", adventure = TestContent.Document, prompt = "User-authored prompt", methods = Array.Empty<object>() }, "/api/v1/campaigns/from-content");
        Check.Equal("active", content.Snapshot.Content!.Status);
        await Create(h, new { name = "DM harness", adventure = TestContent.Document, preset = HarnessTests.Preset }, "/api/v1/harness/campaigns");
        foreach (var body in new object[] { new { name = "Missing adventure", prompt = "Text" }, new { name = "Missing prompt", adventure = TestContent.Document } })
            Check.Equal(HttpStatusCode.BadRequest, (await h.Http.PostAsJsonAsync("/api/v1/campaigns/from-content", body)).StatusCode);
        Check.Equal(HttpStatusCode.BadRequest, (await h.Http.PostAsJsonAsync("/api/v1/harness/campaigns", new { name = "Missing preset", adventure = TestContent.Document })).StatusCode);
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", content.AccessToken);
        string id = content.Snapshot.Id, before = await State(h, content);
        foreach (string route in new[] { "", "/content", "/party/rest", "/adventure", "/adventure/memory" })
            Check.Equal(HttpStatusCode.OK, (await h.Http.GetAsync($"/api/v1/campaigns/{id}{route}")).StatusCode);
        var rest = await h.Http.GetFromJsonAsync<PartyRestView>($"/api/v1/campaigns/{id}/party/rest");
        Check.Equal(0, rest!.Participants.Length); Check.True(rest.Options.All(o => !o.Available));
        await Error(await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/party/rest", new PartyRestRequest(Id(), 1, "short")), HttpStatusCode.Conflict, "rest_unavailable");
        await Error(await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/content/trial", new TrialRequest(Id(), 1, Token(), TestContent.Document, TestContent.Prompts)), HttpStatusCode.Conflict, "trial_character_required");
        Check.Equal(before, await State(h, content));
        foreach (string route in new[] { "adventure/actions", "harness/runs" })
            await Error(await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/{route}", new { requestId = Id(), expectedVersion = 1, text = "主持不可行动" }), HttpStatusCode.Forbidden, "player_character_required");
        Check.Equal(before, await State(h, content));
        Check.True(!Directory.EnumerateFiles(h.Root, "*.json", SearchOption.AllDirectories).Any(p => p.Contains(Path.DirectorySeparatorChar + "harness" + Path.DirectorySeparatorChar)), "Rejected host command must not persist a run");
        Check.Equal(0, dice.Count); Check.Equal(0, model.Calls);
    }
    public static async Task HostCannotPlayAndPlayerCanJoin()
    {
        var dice = new SequenceDice();
        var model = new HarnessTests.Model((_, _) => throw new Exception("Host must not invoke a model"));
        await using var h = await Host.Start(dice: dice, configure: HarnessTests.Configure(model));
        var owner = await Create(h, new { name = "Host boundaries", adventure = TestContent.Document, prompts = TestContent.Prompts, startImmediately = true });
        string id = owner.Snapshot.Id, before = await State(h, owner);
        foreach (string endpoint in new[] { "actions", "actions/propose", "actions/input", "actions/interpret" })
            await Error(await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/{endpoint}", new ActionRequest(Id(), 1, endpoint.Contains("input") || endpoint.Contains("interpret") ? "natural" : "observe", Text: endpoint.Contains("input") || endpoint.Contains("interpret") ? "查看周围" : "")), HttpStatusCode.Forbidden, "player_character_required");
        foreach (string endpoint in new[] { "character/sheet", "character/advancement" })
            await Error(await h.Http.GetAsync($"/api/v1/campaigns/{id}/{endpoint}"), HttpStatusCode.Forbidden, "player_character_required");
        await Error(await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/character/commands", new CharacterPlayRequest(Id(), 1, "check", "perception")), HttpStatusCode.Forbidden, "player_character_required");
        Check.Equal(before, await State(h, owner));
        var guest = await Join(h, owner, "Client player");
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
        await Error(await h.Send(id, new ActionRequest(Id(), guest.Snapshot.Version, "observe")), HttpStatusCode.Forbidden, "character_review_required");
        guest = await h.ApproveGuest(owner, guest);
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
        var observed = await h.Act(guest.Snapshot, "observe");
        Check.Equal(guest.Snapshot.Character.Required().Id, observed.Snapshot.Character.Required().Id);
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        var hostView = (await h.Get(id))!;
        Check.True(hostView.Character is null); Check.Equal(1, hostView.Party!.Members.Length);
        var store = h.App.Services.GetRequiredService<CampaignStore>();
        await store.Access(id, owner.AccessToken, true, c =>
        {
            var member = c.PartyMembers.Single();
            member.Character = AdvancementTests.Level(member.Character) with { HitPoints = 3 };
            return Task.FromResult(true);
        });
        string sourceBefore = await State(h, owner);
        var trial = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/content/trial", new TrialRequest(Id(), hostView.Version, Token(), TestContent.Document, TestContent.Prompts));
        Check.Equal(HttpStatusCode.OK, trial.StatusCode);
        var copied = (await trial.Content.ReadFromJsonAsync<TrialResponse>())!.Trial.Snapshot.Character.Required();
        Check.Equal("Client player", copied.Name); Check.Equal(2, copied.Level); Check.Equal(3, copied.HitPoints);
        Check.Equal(sourceBefore, await State(h, owner));
        Check.Equal(0, dice.Count); Check.Equal(0, model.Calls);
    }
    public static async Task InitialRecruitmentAndFourPlayerCapacity()
    {
        await using var h = await Host.Start();
        var blank = await Create(h, new { name = "Recruit before content" });
        Check.True(blank.Snapshot.Party!.CanInvite);
        for (int i = 1; i <= 4; i++) await Join(h, blank, "Player " + i);
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", blank.AccessToken);
        var full = (await h.Get(blank.Snapshot.Id))!;
        Check.True(full.Character is null); Check.Equal(4, full.Party!.Members.Length); Check.True(!full.Party.CanInvite);
        await Error(await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{full.Id}/invitations", new InviteRequest(Id(), full.Version, Token())), HttpStatusCode.Conflict, "party_unavailable");
        var doc = TestContent.Document with { Scenes = TestContent.Document.Scenes.Select(s => s with { SafeRest = false }).ToArray() };
        var unsafeStart = await Create(h, new { name = "Recruit unsafe start", adventure = doc, prompts = TestContent.Prompts, startImmediately = true });
        Check.True(unsafeStart.Snapshot.Party!.CanInvite);
        var guest = await Join(h, unsafeStart, "First explorer");
        await h.ApproveGuest(unsafeStart, guest);
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", unsafeStart.AccessToken);
        Check.True((await h.Get(unsafeStart.Snapshot.Id))!.Party!.CanInvite, "A later player can join outside a safe-rest scene while there is no fight");
    }
    public static async Task ItemsAndStoryBelongToActingPlayer()
    {
        await using var h = await Host.Start();
        var reward = new ContentAction { Id = "qa-reward", Kind = "script.reward", Target = "qa", Label = "领取测试物品", Repeatable = true,
            Success = new("已领取", [new("item", "gold-piece", 2)]) };
        var doc = TestContent.Document with { Scenes = TestContent.Document.Scenes.Select(s => s.Id == TestContent.Document.StartSceneId ? s with { Actions = [..s.Actions, reward] } : s).ToArray() };
        var owner = await Create(h, new { name = "Player inventory", adventure = doc, prompts = TestContent.Prompts, startImmediately = true });
        var first = await h.ApproveGuest(owner, await Join(h, owner, "First"));
        var second = await h.ApproveGuest(owner, await Join(h, owner, "Second"));
        string actor = second.Snapshot.Party!.SelfActorId, id = owner.Snapshot.Id;
        int Gold(Character c) => c.Inventory.FirstOrDefault(i => i.Id == "gold-piece")?.Quantity ?? 0;
        int initial = Gold(second.Snapshot.Character.Required());
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", second.AccessToken);
        var result = await h.Act(second.Snapshot, "script.reward", "qa");
        Check.Equal(initial + 2, Gold(result.Snapshot.Character.Required()));
        Check.Equal(Gold(first.Snapshot.Character.Required()), Gold(result.Snapshot.Party!.Members.Single(m => m.Id == first.Snapshot.Party!.SelfActorId).Character));
        // Seed a pending adjudication in this isolated campaign; exercise its real HTTP preview and commit.
        string ruling = Id();
        await h.App.Services.GetRequiredService<CampaignStore>().Access(id, owner.AccessToken, true, c =>
        {
            c.PendingRulings.Add(new(ruling, "第二位玩家的剧情结果", "pending", "待主持确认", actor, c.SceneId));
            return Task.FromResult(true);
        });
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        var request = new StoryRequest(Id(), result.Snapshot.Version, ruling, "action", "验收归属", "测试剧本", reward.Id, "success");
        string before = await State(h, owner);
        Check.Equal(HttpStatusCode.OK, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/rulings/story-preview", request)).StatusCode);
        Check.Equal(before, await State(h, owner));
        var applied = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/rulings/story", request);
        Check.Equal(HttpStatusCode.OK, applied.StatusCode);
        var snapshot = (await applied.Content.ReadFromJsonAsync<ActionResponse>())!.Snapshot;
        Check.True(snapshot.Character is null);
        Check.Equal(initial + 4, Gold(snapshot.Party!.Members.Single(m => m.Id == actor).Character));
        Check.Equal(Gold(first.Snapshot.Character.Required()), Gold(snapshot.Party.Members.Single(m => m.Id == first.Snapshot.Party!.SelfActorId).Character));
        Check.True((await (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/rulings/story", request)).Content.ReadFromJsonAsync<ActionResponse>())!.Replayed);
    }
    public static async Task RestartAndInvalidLegacyNull()
    {
        var h = await Host.Start(); var owner = await Create(h, new { name = "Durable DM" });
        string before = await State(h, owner), root = h.Root;
        var legacy = await h.LoadLegacyCampaign();
        string legacyBefore = await State(h, legacy);
        await h.DisposeAsync();
        await using var restarted = await Host.Start(root);
        Check.Equal(before, await State(restarted, owner)); Check.Equal(legacyBefore, await State(restarted, legacy));
        restarted.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        Check.True((await restarted.Get(owner.Snapshot.Id))!.Character is null);
        // Deliberately damaged isolated legacy fixture: absent marker must not silently become DM-only.
        string file = Path.Combine(root, "campaigns", legacy.Snapshot.Id + ".sqlite");
        using (var db = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = file, Pooling = false }.ToString()))
        {
            db.Open(); using var command = db.CreateCommand(); command.CommandText = "UPDATE state SET json=json_set(json,'$.character',json('null')) WHERE id=1"; command.ExecuteNonQuery();
        }
        var bytes = File.ReadAllBytes(file);
        restarted.Http.DefaultRequestHeaders.Authorization = new("Bearer", legacy.AccessToken);
        await Error(await restarted.Http.GetAsync($"/api/v1/campaigns/{legacy.Snapshot.Id}"), HttpStatusCode.Conflict, "invalid_save");
        Check.True(bytes.SequenceEqual(File.ReadAllBytes(file)), "Rejected legacy save must not be rewritten");
    }
}
