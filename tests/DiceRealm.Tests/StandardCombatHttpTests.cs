using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Data.Sqlite;

namespace DiceRealm.Tests;

internal static class StandardCombatHttpTests
{
    private static string Id() => Guid.NewGuid().ToString();
    private static string Secret() => Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
    private static void Auth(Host h, string token) => h.Http.DefaultRequestHeaders.Authorization = new("Bearer", token);
    private static async Task<ActionResponse> Read(HttpResponseMessage response)
    {
        string text = await response.Content.ReadAsStringAsync();
        Check.True(response.StatusCode == HttpStatusCode.OK, response.StatusCode + " " + text);
        return JsonSerializer.Deserialize<ActionResponse>(text, new JsonSerializerOptions(JsonSerializerDefaults.Web))!;
    }
    private static Task<HttpResponseMessage> Roll(Host h, CampaignSnapshot s, RollResponseRequest request) =>
        h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/rolls/respond", request);
    private static async Task<CampaignSnapshot> Confirm(Host h, CampaignSnapshot s) =>
        (await Read(await Roll(h, s, new(Id(), s.Version, s.PendingRoll!.Id, "roll")))).Snapshot;
    private static async Task<CreatedCampaign> Create(Host h, AdventureDocument document)
    {
        var response = await h.Http.PostAsJsonAsync("/api/v1/campaigns", new CreateCampaignRequest("标准战斗隔离测试", "Arden", Adventure: document, Prompts: TestContent.Prompts, StartImmediately: true, Build: FullCreationTests.Named("Arden")));
        Check.Equal(HttpStatusCode.Created, response.StatusCode);
        var created = (await response.Content.ReadFromJsonAsync<CreatedCampaign>())!; Auth(h, created.AccessToken); return created;
    }
    public static async Task AutomaticDeathSaveStillNeedsOwnRoll()
    {
        var dice = new SequenceDice(20, 1, 15, 4, 1, 20);
        var h = await Host.Start(dice: dice);
        try
        {
            var owner = await Create(h, StandardCombatTests.Document(damageBonus: 8));
            var s = await Confirm(h, (await h.Act(owner.Snapshot, "combat.start")).Snapshot);
            s = (await h.Act(s, "combat.end_turn")).Snapshot;
            Check.Equal(0, s.Character!.HitPoints); Check.Equal("death", s.Combat!.Standard!.Wait!.Kind);
            Check.Equal(4, dice.Count); Check.True(s.PendingRoll is { Available: true }, "Death wait must create its own roll request");
            Check.Equal("Death Saving Throw", s.PendingRoll!.Preview!.Skill);
            Check.Equal(10, s.PendingRoll.Preview.Dc);
            string first = s.PendingRoll.Id;
            var root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, dice); Auth(h, owner.AccessToken);
            string db = Path.Combine(root, "campaigns", s.Id + ".sqlite"); byte[] before = File.ReadAllBytes(db);
            s = (await h.Get(s.Id))!; Check.Equal(first, s.PendingRoll!.Id);
            s = (await h.Get(s.Id))!; Check.Equal(first, s.PendingRoll!.Id);
            Check.True(before.SequenceEqual(File.ReadAllBytes(db))); Check.Equal(4, dice.Count);
            var confirm = new RollResponseRequest(Id(), s.Version, first, "roll");
            var resolved = await Read(await Roll(h, s, confirm)); s = resolved.Snapshot;
            Check.Equal(5, dice.Count); Check.Equal(2, s.Combat!.Units.Single(u => u.Id == "player").Standard!.DeathFailures);
            Check.True(s.PendingRoll is { Available: true }, "An unconscious turn advances without another end-turn command");
            string next = s.PendingRoll!.Id; Check.True(next != first); Check.Equal(3, s.Combat.Round);
            var replay = await Read(await Roll(h, s, confirm)); Check.True(replay.Replayed);
            Check.Equal(next, replay.Snapshot.PendingRoll!.Id); Check.Equal(5, dice.Count);
            s = (await Read(await Roll(h, s, new(Id(), s.Version, s.PendingRoll.Id, "cancel")))).Snapshot;
            Check.True(s.PendingRoll is null); Check.Equal("death", s.Combat!.Standard!.Wait!.Kind); Check.Equal(5, dice.Count);
            s = (await h.Get(s.Id))!; Check.True(s.PendingRoll is null); Check.Equal(5, dice.Count);
            s = (await h.Act(s, "combat.death_save")).Snapshot;
            s = await Confirm(h, s); Check.Equal(6, dice.Count); Check.Equal(1, s.Character!.HitPoints);
            Check.True(s.PendingRoll is null && s.Combat!.Standard!.Wait is null);
        }
        finally { await h.DisposeAsync(); }
    }

    public static async Task AutomaticDeathSaveBelongsToTheFallenSeat()
    {
        var dice = new SequenceDice(20, 19, 1, 20);
        await using var h = await Host.Start(dice: dice);
        var owner = await Create(h, StandardCombatTests.Document() with { StartSceneId = "harbor" });
        var guest = await HarnessBoundaryTests.Guest(h, owner);
        Auth(h, owner.AccessToken);
        var s = (await h.Get(owner.Snapshot.Id))!;
        s = (await h.Act(s, "talk")).Snapshot; s = (await h.Act(s, "travel", "causeway")).Snapshot;
        s = await Confirm(h, (await h.Act(s, "combat.start")).Snapshot);
        Auth(h, guest.AccessToken); s = await Confirm(h, (await h.Get(s.Id))!); Check.Equal(3, dice.Count);
        string guestId = guest.Snapshot.Party!.SelfActorId;
        await h.App.Services.GetRequiredService<CampaignStore>().Access(s.Id, guest.AccessToken, true, c =>
        {
            c.ActingCharacter = c.ActingCharacter with { HitPoints = 0, Conditions = ["Unconscious", "Prone"] };
            CharacterEngine.Sync(c);
            var fallen = c.Combat!.Units.Single(u => u.Id == guestId).Standard!;
            fallen.Conditions = c.ActingCharacter.Conditions.ToArray(); fallen.ZeroHitPointUnconscious = true;
            return Task.FromResult(0);
        });
        Auth(h, owner.AccessToken); s = (await h.Get(s.Id))!;
        s = (await h.Act(s, "combat.end_turn")).Snapshot;
        Check.Equal(guestId, s.Combat!.Standard!.Wait!.ActorId); Check.True(s.PendingRoll is null); Check.Equal(3, dice.Count);
        Auth(h, guest.AccessToken); var fallen = (await h.Get(s.Id))!;
        Check.True(fallen.PendingRoll is { Available: true }, "The fallen seat receives the automatic request");
        string rollId = fallen.PendingRoll!.Id;
        Auth(h, owner.AccessToken);
        Check.Equal(HttpStatusCode.Conflict, (await Roll(h, s, new(Id(), s.Version, rollId, "roll"))).StatusCode);
        Check.Equal(3, dice.Count);
        Auth(h, guest.AccessToken); fallen = await Confirm(h, fallen);
        Check.Equal(4, dice.Count); Check.Equal(1, fallen.Character!.HitPoints);
        Check.True(fallen.PendingRoll is null && fallen.Combat!.Standard!.Wait is null);
    }

    public static async Task ConsentSeatsRestartAndReplay()
    {
        var dice = new SequenceDice(20, 19, 1, 1);
        Host h = await Host.Start(dice: dice);
        try
        {
            var owner = await Create(h, StandardCombatTests.Document("withdraw") with { StartSceneId = "harbor" });
            var s = owner.Snapshot;
            var invite = new InviteRequest(Id(), s.Version, Secret());
            await Read(await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/invitations", invite));
            var join = new JoinCampaignRequest(Id(), invite.InviteToken, Secret(), "Guest", CharacterEngine.Fighter, Build: FullCreationTests.Named("Guest"));
            h.Http.DefaultRequestHeaders.Authorization = null;
            var joined = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/join", join);
            Check.Equal(HttpStatusCode.OK, joined.StatusCode);
            var guest = (await joined.Content.ReadFromJsonAsync<CreatedCampaign>())!;
            guest = await h.ApproveGuest(owner, guest); Auth(h, owner.AccessToken);
            s = (await h.Get(s.Id))!; s = (await h.Act(s, "talk")).Snapshot; s = (await h.Act(s, "travel", "causeway")).Snapshot;
            // Even the old direct action endpoint cannot roll a NEW standard encounter.
            var start = new ActionRequest(Id(), s.Version, "combat.start");
            var proposed = await Read(await h.Send(s.Id, start)); s = proposed.Snapshot;
            Check.Equal("awaiting_roll", proposed.Resolution.Status); Check.Equal(0, dice.Count); Check.True(s.Combat is null);
            s = await Confirm(h, s); Check.Equal(0, dice.Count); Check.True(s.PendingRoll!.Available == false);
            Auth(h, guest.AccessToken); s = (await h.Get(s.Id))!; s = await Confirm(h, s);
            Check.Equal(3, dice.Count); Check.Equal("player", s.Combat!.ActiveActorId);
            Auth(h, owner.AccessToken); s = (await h.Get(s.Id))!; s = (await h.Act(s, "combat.end_turn")).Snapshot;
            Check.Equal(guest.Snapshot.Party!.SelfActorId, s.Combat!.ActiveActorId);
            Auth(h, guest.AccessToken); s = (await h.Get(s.Id))!; s = (await h.Act(s, "combat.end_turn")).Snapshot;
            Check.Equal("player", s.Combat!.Standard!.Wait!.ActorId); Check.Equal(0, s.AvailableActions.Length); Check.Equal(3, dice.Count);
            Check.Equal(HttpStatusCode.Conflict, (await h.Send(s.Id, new(Id(), s.Version, "combat.react", "attack"))).StatusCode);
            Auth(h, owner.AccessToken); s = (await h.Get(s.Id))!;
            var board = JsonSerializer.Serialize(s.Combat);
            var reaction = new ActionRequest(Id(), s.Version, "combat.react", "attack");
            s = (await Read(await h.Send(s.Id, reaction))).Snapshot;
            Check.True(s.PendingRoll is not null); Check.Equal(3, dice.Count); Check.Equal(board, JsonSerializer.Serialize(s.Combat));
            string rollId = s.PendingRoll!.Id;
            Auth(h, guest.AccessToken);
            Check.Equal(HttpStatusCode.Conflict, (await Roll(h, s, new(Id(), s.Version, rollId, "roll"))).StatusCode);
            Auth(h, owner.AccessToken);
            s = (await Read(await Roll(h, s, new(Id(), s.Version, rollId, "cancel")))).Snapshot;
            Check.Equal(board, JsonSerializer.Serialize(s.Combat)); Check.Equal(3, dice.Count);
            s = (await Read(await h.Send(s.Id, reaction with { RequestId = Id(), ExpectedVersion = s.Version }))).Snapshot;
            var confirmation = new RollResponseRequest(Id(), s.Version, s.PendingRoll!.Id, "roll");
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, dice); Auth(h, owner.AccessToken);
            s = (await h.Get(s.Id))!; Check.Equal(confirmation.RollId, s.PendingRoll!.Id); Check.Equal(board, JsonSerializer.Serialize(s.Combat)); Check.Equal(3, dice.Count);
            var raw = await h.Http.GetStringAsync($"/api/v1/campaigns/{s.Id}");
            Check.True(!raw.Contains("standardCombatFlow", StringComparison.OrdinalIgnoreCase));
            var otherConfirmation = confirmation with { RequestId = Id() };
            var race = await Task.WhenAll(Roll(h, s, confirmation), Roll(h, s, otherConfirmation));
            Check.Equal(1, race.Count(r => r.StatusCode == HttpStatusCode.OK)); Check.Equal(1, race.Count(r => r.StatusCode == HttpStatusCode.Conflict));
            var accepted = await Read(race.Single(r => r.StatusCode == HttpStatusCode.OK)); s = accepted.Snapshot;
            var usedRequest = race[0].StatusCode == HttpStatusCode.OK ? confirmation : otherConfirmation;
            Check.Equal(4, dice.Count); Check.Equal(47, s.Combat!.Units.Single(u => u.Id == "guardian").HitPoints);
            Check.Equal(1, s.Combat.Log.Count(e => e.Kind == "opportunity_attack"));
            // Always replay the proposal; if the original confirmation won, replay it as well.
            var original = await Read(await h.Send(s.Id, reaction)); Check.True(original.Replayed && original.Resolution.Status == "awaiting_roll");
            Check.Equal(4, dice.Count);
            string acceptedBoard = JsonSerializer.Serialize(s.Combat);
            await h.DisposeAsync(); h = await Host.Start(root, dice); Auth(h, owner.AccessToken);
            var afterRestart = (await h.Get(s.Id))!; Check.Equal(acceptedBoard, JsonSerializer.Serialize(afterRestart.Combat));
            var replay = await Read(await Roll(h, afterRestart, usedRequest)); Check.True(replay.Replayed);
            Check.Equal(JsonSerializer.Serialize(accepted.Resolution), JsonSerializer.Serialize(replay.Resolution));
            Check.Equal(4, dice.Count);
        }
        finally { await h.DisposeAsync(); }
    }
    public static async Task NewMemberAfterBattleKeepsHistoricalBoardAndJoinReplay()
    {
        var dice = new SequenceDice(20, 1);
        var h = await Host.Start(dice: dice);
        try
        {
            var document = StandardCombatTests.Document("withdraw");
            document = document with { Scenes = document.Scenes.Select(s => s.Id == "causeway" ? s with { SafeRest = true } : s).ToArray() };
            var owner = await Create(h, document); var s = owner.Snapshot;
            s = await Confirm(h, (await h.Act(s, "combat.start")).Snapshot);
            s = (await h.Act(s, "combat.end_turn")).Snapshot;
            s = (await h.Act(s, "combat.react", "pass")).Snapshot;
            Check.Equal("victory", s.Combat!.Status); Check.Equal(2, dice.Count);
            string board = JsonSerializer.Serialize(s.Combat);
            await Read(await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{s.Id}/room", new ConfigureRoomRequest(Id(), s.Version, true, "fixture-after-battle")));
            var room = (await h.Http.GetFromJsonAsync<RoomView>($"/api/v1/campaigns/{s.Id}/room"))!;
            var request = new JoinRoomRequest(room.RoomNumber, "fixture-after-battle", Id(), Secret(), FullCreationTests.Named("New arrival"));
            h.Http.DefaultRequestHeaders.Authorization = null;
            var response = await h.Http.PostAsJsonAsync("/api/v1/rooms/join", request);
            Check.Equal(HttpStatusCode.OK, response.StatusCode);
            var guest = (await response.Content.ReadFromJsonAsync<CreatedCampaign>())!;
            Check.Equal("pending", guest.Snapshot.Party!.Members.Single(m => m.Id == guest.Snapshot.Party.SelfActorId).Review!.Status);
            Check.Equal(board, JsonSerializer.Serialize(guest.Snapshot.Combat));
            Check.True(!guest.Snapshot.Combat!.Units.Any(u => u.Id == guest.Snapshot.Party.SelfActorId));
            guest = await h.ApproveGuest(owner, guest);
            Check.True(!guest.Snapshot.AvailableActions.Any(a => a.Kind.StartsWith("combat.", StringComparison.Ordinal)));
            string root = h.Root; await h.DisposeAsync(); h = await Host.Start(root, dice);
            var replay = await h.Http.PostAsJsonAsync("/api/v1/rooms/join", request);
            Check.Equal(HttpStatusCode.OK, replay.StatusCode);
            var recovered = (await replay.Content.ReadFromJsonAsync<CreatedCampaign>())!;
            Check.Equal(guest.Snapshot.Party!.SelfActorId, recovered.Snapshot.Party!.SelfActorId);
            Check.Equal(guest.Snapshot.Version, recovered.Snapshot.Version);
            Check.Equal(2, recovered.Snapshot.Party.Members.Length);
            Check.Equal(board, JsonSerializer.Serialize(recovered.Snapshot.Combat)); Check.Equal(2, dice.Count);
            Auth(h, guest.AccessToken); var read = (await h.Get(s.Id))!;
            Check.Equal(board, JsonSerializer.Serialize(read.Combat));
        }
        finally { await h.DisposeAsync(); }
    }
    public static async Task CorruptionIsAuthorizedAndPreserved()
    {
        var dice = new SequenceDice(20, 1);
        await using var h = await Host.Start(dice: dice);
        var owner = await Create(h, StandardCombatTests.Document("withdraw"));
        var s = (await h.Act(owner.Snapshot, "combat.start")).Snapshot; s = await Confirm(h, s);
        s = (await h.Act(s, "combat.end_turn")).Snapshot; Check.Equal("opportunity", s.Combat!.Standard!.Wait!.Kind);
        string file = Path.Combine(h.Root, "campaigns", s.Id + ".sqlite");
        using (var db = new SqliteConnection($"Data Source={file};Pooling=False"))
        {
            db.Open(); using var command = db.CreateCommand();
            command.CommandText = "UPDATE state SET json=json_set(json,'$.standardCombatFlow.schemaVersion',99)";
            command.ExecuteNonQuery();
        }
        byte[] bytes = File.ReadAllBytes(file);
        Auth(h, Secret()); Check.Equal(HttpStatusCode.Unauthorized, (await h.Http.GetAsync($"/api/v1/campaigns/{s.Id}")).StatusCode);
        Auth(h, owner.AccessToken); var invalid = await h.Http.GetAsync($"/api/v1/campaigns/{s.Id}");
        Check.Equal(HttpStatusCode.Conflict, invalid.StatusCode);
        using var error = JsonDocument.Parse(await invalid.Content.ReadAsStringAsync());
        Check.Equal("invalid_standard_combat", error.RootElement.GetProperty("code").GetString());
        Check.True(bytes.SequenceEqual(File.ReadAllBytes(file))); Check.Equal(2, dice.Count);
    }
}
