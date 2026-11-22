using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.DependencyInjection;

namespace DiceRealm.Tests;

internal static class RoomTests
{
    private const string Password = "fixture-password-one", ChangedPassword = "fixture-password-two";
    private static string Id() => Guid.NewGuid().ToString();
    private static string Token() => Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
    private static async Task<CreatedCampaign> Create(Host h)
    {
        var response = await h.Http.PostAsJsonAsync("/api/v1/campaigns", new { name = "Room test" });
        Check.Equal(HttpStatusCode.Created, response.StatusCode);
        var owner = (await response.Content.ReadFromJsonAsync<CreatedCampaign>())!;
        h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        return owner;
    }
    private static Task<RoomView?> Room(Host h, string id) => h.Http.GetFromJsonAsync<RoomView>($"/api/v1/campaigns/{id}/room");
    private static async Task<ActionResponse> Configure(Host h, string id, int version, bool enabled, string password = "")
    {
        var response = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/room", new ConfigureRoomRequest(Id(), version, enabled, password));
        Check.Equal(HttpStatusCode.OK, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<ActionResponse>())!;
    }
    private static Task<string> State(Host h, CreatedCampaign owner) => h.App.Services.GetRequiredService<CampaignStore>()
        .Access(owner.Snapshot.Id, owner.AccessToken, false, c => Task.FromResult(JsonSerializer.Serialize(c, JsonFiles.Options)));
    private static JoinRoomRequest Request(string number) => new(number, Password, Id(), Token(), FullCreationTests.Named("Room guest"));

    public static async Task LifecycleReplayAndRestart()
    {
        var h = await Host.Start(); string root = h.Root;
        CreatedCampaign owner; JoinRoomRequest request; string number;
        try
        {
            owner = await Create(h); string id = owner.Snapshot.Id;
            var initial = (await Room(h, id))!;
            Check.Equal("", initial.RoomNumber); Check.True(!initial.Enabled);
            Check.True(!File.Exists(Path.Combine(root, "rooms.sqlite")), "Reads must not initialize room storage");
            var configure = new ConfigureRoomRequest(Id(), initial.Version, true, Password);
            var set = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/room", configure); Check.Equal(HttpStatusCode.OK, set.StatusCode);
            var room = (await Room(h, id))!; number = room.RoomNumber;
            Check.True(number.Length == 8 && number.All(char.IsAsciiDigit)); Check.True(room.Enabled);
            var replay = await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/room", configure);
            Check.True((await replay.Content.ReadFromJsonAsync<ActionResponse>())!.Replayed);
            Check.Equal(room.Version, (await Room(h, id))!.Version);
            request = Request(number);
            var join = await h.Http.PostAsJsonAsync("/api/v1/rooms/join", request); Check.Equal(HttpStatusCode.OK, join.StatusCode);
            var guest = (await join.Content.ReadFromJsonAsync<CreatedCampaign>())!;
            Check.Equal("pending", guest.Snapshot.Party!.Members.Single().Review!.Status);
            Check.Equal(request.AccessToken, guest.AccessToken); Check.True(!guest.Snapshot.Party.IsHost);
            var publicJson = JsonSerializer.Serialize(guest.Snapshot, JsonFiles.Options);
            Check.True(!publicJson.Contains(Password) && !publicJson.Contains("passwordHash") && !publicJson.Contains("roomJoin") && !publicJson.Contains(number));
            string stored = await State(h, owner);
            Check.True(stored.Contains("passwordHash") && !stored.Contains(Password) && !stored.Contains(request.AccessToken));
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", guest.AccessToken);
            Check.Equal(HttpStatusCode.Forbidden, (await h.Http.GetAsync($"/api/v1/campaigns/{id}/room")).StatusCode);
            Check.Equal(HttpStatusCode.Forbidden, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/room", new ConfigureRoomRequest(Id(), guest.Snapshot.Version, false))).StatusCode);
            h.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
            var changed = await Configure(h, id, guest.Snapshot.Version, true, ChangedPassword);
            Check.Equal(number, (await Room(h, id))!.RoomNumber);
            Check.Equal(HttpStatusCode.Unauthorized, (await h.Http.PostAsJsonAsync("/api/v1/rooms/join", Request(number))).StatusCode);
            var disabled = await Configure(h, id, changed.Snapshot.Version, false);
            Check.Equal(HttpStatusCode.Unauthorized, (await h.Http.PostAsJsonAsync("/api/v1/rooms/join", Request(number) with { Password = ChangedPassword })).StatusCode);
            var acceptedReplay = await h.Http.PostAsJsonAsync("/api/v1/rooms/join", request); Check.Equal(HttpStatusCode.OK, acceptedReplay.StatusCode);
            var restored = (await acceptedReplay.Content.ReadFromJsonAsync<CreatedCampaign>())!;
            Check.Equal(guest.Snapshot.Party.SelfActorId, restored.Snapshot.Party!.SelfActorId);
            Check.Equal(disabled.Snapshot.Version, restored.Snapshot.Version);
            Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync("/api/v1/rooms/join", request with { Password = ChangedPassword })).StatusCode);
        }
        finally { await h.DisposeAsync(); }
        await using var restarted = await Host.Start(root);
        var recovered = await restarted.Http.PostAsJsonAsync("/api/v1/rooms/join", request); Check.Equal(HttpStatusCode.OK, recovered.StatusCode);
        var result = (await recovered.Content.ReadFromJsonAsync<CreatedCampaign>())!;
        restarted.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        Check.Equal(number, (await Room(restarted, owner.Snapshot.Id))!.RoomNumber);
        Check.Equal(HttpStatusCode.OK, (await restarted.Http.PostAsJsonAsync($"/api/v1/campaigns/{owner.Snapshot.Id}/seats/revoke", new RevokeSeatRequest(Id(), result.Snapshot.Version, result.Snapshot.Party!.SelfActorId))).StatusCode);
        Check.Equal(HttpStatusCode.Unauthorized, (await restarted.Http.PostAsJsonAsync("/api/v1/rooms/join", request)).StatusCode);
    }
    public static async Task RejectionsAreAtomicAndConcurrentJoinIsSingle()
    {
        await using var h = await Host.Start(); var owner = await Create(h); string id = owner.Snapshot.Id;
        await Configure(h, id, owner.Snapshot.Version, true, Password); string number = (await Room(h, id))!.RoomNumber;
        var request = Request(number); string before = await State(h, owner);
        foreach (var bad in new[] { request with { Build = null }, request with { Build = new() }, request with { Build = request.Build! with { BackgroundBonuses = [0,0,0,0,0,0] } } })
        {
            Check.Equal(HttpStatusCode.BadRequest, (await h.Http.PostAsJsonAsync("/api/v1/rooms/join", bad)).StatusCode);
            Check.Equal(before, await State(h, owner));
        }
        var wrong = await h.Http.PostAsJsonAsync("/api/v1/rooms/join", request with { Password = ChangedPassword });
        var unknown = await h.Http.PostAsJsonAsync("/api/v1/rooms/join", request with { RoomNumber = "00000000" });
        Check.Equal(HttpStatusCode.Unauthorized, wrong.StatusCode); Check.Equal(wrong.StatusCode, unknown.StatusCode);
        Check.Equal(await wrong.Content.ReadAsStringAsync(), await unknown.Content.ReadAsStringAsync());
        Check.Equal(before, await State(h, owner));
        Check.Equal(HttpStatusCode.BadRequest, (await h.Http.PostAsJsonAsync("/api/v1/rooms/join", new { request.RoomNumber, request.Password, request.RequestId, request.AccessToken, request.Build, templateId = "fighter" })).StatusCode);
        Check.Equal(before, await State(h, owner));
        var concurrent = await Task.WhenAll(Enumerable.Range(0, 4).Select(_ => h.Http.PostAsJsonAsync("/api/v1/rooms/join", request)));
        var members = new List<CreatedCampaign>();
        foreach (var response in concurrent) { Check.Equal(HttpStatusCode.OK, response.StatusCode); members.Add((await response.Content.ReadFromJsonAsync<CreatedCampaign>())!); }
        Check.Equal(1, members.Select(m => m.Snapshot.Character!.Id).Distinct().Count());
        Check.Equal(1, members.Select(m => m.Snapshot.Version).Distinct().Count());
        Check.Equal(1, members[0].Snapshot.Party!.Members.Length);
        var other = request with { AccessToken = Token() };
        Check.Equal(HttpStatusCode.Unauthorized, (await h.Http.PostAsJsonAsync("/api/v1/rooms/join", other)).StatusCode);
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync("/api/v1/rooms/join", request with { RequestId = Id() })).StatusCode);
        // A fresh request can use the same shared password without consuming an invitation.
        for (int i = 0; i < 3; i++) Check.Equal(HttpStatusCode.OK, (await h.Http.PostAsJsonAsync("/api/v1/rooms/join", Request(number))).StatusCode);
        string full = await State(h, owner);
        Check.Equal(HttpStatusCode.Conflict, (await h.Http.PostAsJsonAsync("/api/v1/rooms/join", Request(number))).StatusCode);
        Check.Equal(full, await State(h, owner));
    }
    public static async Task ReservationSurvivesOuterFailureWithoutAdmission()
    {
        var h = await Host.Start(); string root = h.Root, reserved = "";
        CreatedCampaign owner;
        try
        {
            owner = await Create(h);
            var store = h.App.Services.GetRequiredService<CampaignStore>();
            string before = await State(h, owner);
            try
            {
                await store.Access(owner.Snapshot.Id, owner.AccessToken, true, c =>
                {
                    reserved = (string)typeof(CampaignStore).GetMethod("ReserveRoom", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!.Invoke(store, [c])!;
                    c.Version++; // A failed outer transaction must discard this mutation too.
                    throw new IOException("Simulated failure before campaign commit");
#pragma warning disable CS0162
                    return Task.FromResult(0);
#pragma warning restore CS0162
                });
            }
            catch (IOException) { }
            Check.True(reserved.Length == 8); Check.Equal(before, await State(h, owner));
            Check.Equal(HttpStatusCode.Unauthorized, (await h.Http.PostAsJsonAsync("/api/v1/rooms/join", Request(reserved))).StatusCode);
            // An index pointing at a missing campaign remains indistinguishable from a wrong password.
            var index = typeof(CampaignStore).GetField("rooms", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!.GetValue(store)!;
            string missing = (string)index.GetType().GetMethod("Reserve", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!.Invoke(index, [Id()])!;
            var denied = await h.Http.PostAsJsonAsync("/api/v1/rooms/join", Request(missing));
            var unknown = await h.Http.PostAsJsonAsync("/api/v1/rooms/join", Request("00000000"));
            Check.Equal(HttpStatusCode.Unauthorized, denied.StatusCode);
            Check.Equal(await unknown.Content.ReadAsStringAsync(), await denied.Content.ReadAsStringAsync());
        }
        finally { await h.DisposeAsync(); }
        await using var restarted = await Host.Start(root);
        restarted.Http.DefaultRequestHeaders.Authorization = new("Bearer", owner.AccessToken);
        await Configure(restarted, owner.Snapshot.Id, owner.Snapshot.Version, true, Password);
        Check.Equal(reserved, (await Room(restarted, owner.Snapshot.Id))!.RoomNumber);
        var oversized = new StringContent(new string(' ', 65537), System.Text.Encoding.UTF8, "application/json");
        Check.Equal(HttpStatusCode.RequestEntityTooLarge, (await restarted.Http.PostAsync("/api/v1/rooms/join", oversized)).StatusCode);
        Check.Equal(0, (await restarted.Get(owner.Snapshot.Id))!.Party!.Members.Length);
    }
    public static async Task AdmissionBoundariesAndReservations()
    {
        await using var h = await Host.Start(); var owner = await Create(h); string id = owner.Snapshot.Id;
        string before = await State(h, owner);
        foreach (string password in new[] { "short", "        ", "has\nnewline", new string('x', 129) })
            Check.Equal(HttpStatusCode.BadRequest, (await h.Http.PostAsJsonAsync($"/api/v1/campaigns/{id}/room", new ConfigureRoomRequest(Id(), owner.Snapshot.Version, true, password))).StatusCode);
        Check.Equal(before, await State(h, owner)); Check.True(!File.Exists(Path.Combine(h.Root, "rooms.sqlite")));
        for (int i = 0; i < 20; i++)
            Check.Equal(HttpStatusCode.Unauthorized, (await h.Http.PostAsJsonAsync("/api/v1/rooms/join", Request("invalid"))).StatusCode);
        var limited = await h.Http.PostAsJsonAsync("/api/v1/rooms/join", Request("invalid"));
        Check.Equal(HttpStatusCode.TooManyRequests, limited.StatusCode); Check.True(limited.Headers.RetryAfter is not null);
        Check.Equal(before, await State(h, owner));
        // The join limiter does not throttle authenticated management or ordinary reads.
        await Configure(h, id, owner.Snapshot.Version, true, Password); Check.True((await Room(h, id))!.Enabled);
    }
}
