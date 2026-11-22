using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.DependencyInjection;

namespace DiceRealm.Tests;

internal static class AccountTests
{
    internal const string AdminPassword = "account-admin-fixture";
    private const string UserPassword = "account-user-fixture", NewPassword = "account-changed-fixture";
    private static string Id() => Guid.NewGuid().ToString();
    private static string AccountPath(Host host) => Path.Combine(host.Root, "accounts.json");
    private static void Bearer(Host host, string token) => host.Http.DefaultRequestHeaders.Authorization = new("Bearer", token);

    // Only isolated test data is seeded. Production exposes no password/authentication bypass.
    internal static void SeedAdminFixture(Host host)
    {
        var document = JsonNode.Parse(File.ReadAllBytes(AccountPath(host)))!.AsObject();
        var admin = document["users"]!.AsArray().Single(u => u!["id"]!.GetValue<string>() == AccountStore.AdminId)!;
        string salt = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16));
        admin["salt"] = salt;
        admin["passwordHash"] = Convert.ToHexStringLower(Rfc2898DeriveBytes.Pbkdf2(AdminPassword, Convert.FromHexString(salt),
            AccountStore.PasswordIterations, HashAlgorithmName.SHA256, 32));
        document["sessions"] = new JsonArray();
        JsonFiles.Write(AccountPath(host), document);
    }
    // A new data directory takes its first admin password from configuration.
    public static async Task ConfiguredInitialAdminPassword()
    {
        await using var host = await Host.Start(configure: b => b.Configuration["Accounts:InitialAdminPassword"] = "configured-admin-fixture");
        Check.True((await Login(host, password: "configured-admin-fixture")).User.IsAdmin);
    }
    internal static async Task<AccountLoginResponse> Login(Host host, string username = "admin", string password = AdminPassword)
    {
        var response = await host.Http.PostAsJsonAsync("/api/v1/accounts/login", new AccountLoginRequest(username, password));
        Check.Equal(HttpStatusCode.OK, response.StatusCode);
        var result = (await response.Content.ReadFromJsonAsync<AccountLoginResponse>())!;
        Bearer(host, result.AccessToken);
        return result;
    }
    private static async Task<AccountUser> CreateUser(Host host, string name, string password = UserPassword)
    {
        var response = await host.Http.PostAsJsonAsync("/api/v1/accounts/users", new CreateAccountRequest(name, password));
        Check.Equal(HttpStatusCode.OK, response.StatusCode);
        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Check.Equal("disabled,id,isAdmin,username", string.Join(',', json.RootElement.EnumerateObject().Select(p => p.Name).Order()));
        return json.RootElement.Deserialize<AccountUser>(JsonFiles.Options)!;
    }
    private static async Task<string> CreateCampaign(Host host, string name)
    {
        var response = await host.Http.PostAsJsonAsync("/api/v1/accounts/campaigns", new { name });
        Check.Equal(HttpStatusCode.Created, response.StatusCode);
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Check.Equal("campaignId", string.Join(',', document.RootElement.EnumerateObject().Select(p => p.Name)));
        return document.RootElement.GetProperty("campaignId").GetString()!;
    }
    private static async Task<AccountCampaign[]> Campaigns(Host host)
    {
        using var document = JsonDocument.Parse(await host.Http.GetStringAsync("/api/v1/accounts/campaigns"));
        return document.RootElement.GetProperty("campaigns").Deserialize<AccountCampaign[]>(JsonFiles.Options)!;
    }
    private static string DatabaseState(Host host, string id)
    {
        using var db = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = Path.Combine(host.Root, "campaigns", id + ".sqlite"), Mode = SqliteOpenMode.ReadOnly, Pooling = false }.ToString());
        db.Open(); using var command = db.CreateCommand(); command.CommandText = "SELECT json FROM state WHERE id=1";
        return (string)command.ExecuteScalar()!;
    }
    private static void AssertNoSecrets(Host host, params string[] secrets)
    {
        string saved = File.ReadAllText(AccountPath(host));
        foreach (string secret in secrets) Check.True(!saved.Contains(secret, StringComparison.Ordinal), "Account document leaked a credential");
        using var document = JsonDocument.Parse(saved);
        foreach (var user in document.RootElement.GetProperty("users").EnumerateArray())
        {
            Check.Equal(32, user.GetProperty("salt").GetString()!.Length);
            Check.Equal(64, user.GetProperty("passwordHash").GetString()!.Length);
        }
        foreach (var session in document.RootElement.GetProperty("sessions").EnumerateArray())
            Check.Equal("expiresAt,tokenHash,userId", string.Join(',', session.EnumerateObject().Select(p => p.Name).Order()));
    }

    public static async Task LoginLogoutPasswordAndRestart()
    {
        string root, token;
        await using (var host = await Host.Start())
        {
            root = host.Root;
            using (var initial = JsonDocument.Parse(File.ReadAllBytes(AccountPath(host))))
            {
                var admin = initial.RootElement.GetProperty("users")[0];
                Check.Equal("admin", admin.GetProperty("username").GetString());
                // No password ships in the source: without Accounts:InitialAdminPassword a random one is generated and logged once.
                Check.True(admin.GetProperty("salt").GetString()!.Length == 32 && admin.GetProperty("passwordHash").GetString()!.Length == 64);
            }
            Check.Equal(HttpStatusCode.Unauthorized, (await host.Http.GetAsync("/api/v1/accounts/me")).StatusCode);
            Check.Equal(HttpStatusCode.Unauthorized, (await host.Http.PostAsJsonAsync("/api/v1/accounts/login", new AccountLoginRequest("admin", AdminPassword))).StatusCode);
            SeedAdminFixture(host);
            var wrong = await host.Http.PostAsJsonAsync("/api/v1/accounts/login", new AccountLoginRequest("admin", "wrong-password"));
            var unknown = await host.Http.PostAsJsonAsync("/api/v1/accounts/login", new AccountLoginRequest("not-present", "wrong-password"));
            Check.Equal(HttpStatusCode.Unauthorized, wrong.StatusCode); Check.Equal(wrong.StatusCode, unknown.StatusCode);
            Check.Equal(await wrong.Content.ReadAsStringAsync(), await unknown.Content.ReadAsStringAsync());
            Check.Equal(HttpStatusCode.BadRequest, (await host.Http.PostAsJsonAsync("/api/v1/accounts/login", new { username = "admin", password = AdminPassword, isAdmin = true })).StatusCode);
            var login = await Login(host, "ADMIN");
            Check.True(login.User.IsAdmin && !login.User.Disabled); Check.Equal(AccountStore.AdminId, login.User.Id);
            Check.True(login.AccessToken.Length == 64 && login.AccessToken.All(char.IsAsciiHexDigit));
            Check.Equal(login.User, await host.Http.GetFromJsonAsync<AccountUser>("/api/v1/accounts/me"));
            string first = login.AccessToken;
            var second = await Login(host);
            Check.True(first != second.AccessToken);
            Bearer(host, first);
            Check.Equal(HttpStatusCode.OK, (await host.Http.PostAsync("/api/v1/accounts/logout", null)).StatusCode);
            Check.Equal(HttpStatusCode.Unauthorized, (await host.Http.GetAsync("/api/v1/accounts/me")).StatusCode);
            Check.Equal(HttpStatusCode.Unauthorized, (await host.Http.PostAsync("/api/v1/accounts/logout", null)).StatusCode);
            Bearer(host, second.AccessToken);
            Check.Equal(HttpStatusCode.Unauthorized, (await host.Http.PostAsJsonAsync("/api/v1/accounts/password", new ChangeAccountPasswordRequest("wrong-password", NewPassword))).StatusCode);
            Check.Equal(HttpStatusCode.OK, (await host.Http.GetAsync("/api/v1/accounts/me")).StatusCode);
            Check.Equal(HttpStatusCode.OK, (await host.Http.PostAsJsonAsync("/api/v1/accounts/password", new ChangeAccountPasswordRequest(AdminPassword, NewPassword))).StatusCode);
            Check.Equal(HttpStatusCode.Unauthorized, (await host.Http.GetAsync("/api/v1/accounts/me")).StatusCode);
            Check.Equal(HttpStatusCode.Unauthorized, (await host.Http.PostAsJsonAsync("/api/v1/accounts/login", new AccountLoginRequest("admin", AdminPassword))).StatusCode);
            token = (await Login(host, password: NewPassword)).AccessToken;
            AssertNoSecrets(host, AdminPassword, NewPassword, first, second.AccessToken, token);
        }
        await using var restarted = await Host.Start(root);
        Bearer(restarted, token);
        Check.Equal(HttpStatusCode.OK, (await restarted.Http.GetAsync("/api/v1/accounts/me")).StatusCode);
        Check.Equal(AccountStore.AdminId, (await Login(restarted, password: NewPassword)).User.Id);
        Check.Equal(HttpStatusCode.Unauthorized, (await restarted.Http.PostAsJsonAsync("/api/v1/accounts/login", new AccountLoginRequest("admin", AdminPassword))).StatusCode);
        // Expiry remains authoritative after restart, not merely an in-memory timer.
        var saved = JsonNode.Parse(File.ReadAllBytes(AccountPath(restarted)))!.AsObject();
        foreach (var session in saved["sessions"]!.AsArray()) session!["expiresAt"] = DateTimeOffset.UtcNow.AddMinutes(-1);
        JsonFiles.Write(AccountPath(restarted), saved);
        Bearer(restarted, token);
        Check.Equal(HttpStatusCode.Unauthorized, (await restarted.Http.GetAsync("/api/v1/accounts/me")).StatusCode);
    }

    public static async Task ManagementRevocationAndOperatorAuthorization()
    {
        await using var host = await Host.Start(); SeedAdminFixture(host);
        var admin = await Login(host);
        var alice = await CreateUser(host, "alice");
        Check.True(!alice.IsAdmin && !alice.Disabled);
        var bob = await CreateUser(host, "bob");
        Check.Equal(HttpStatusCode.Conflict, (await host.Http.PostAsJsonAsync("/api/v1/accounts/users", new CreateAccountRequest("ALICE", UserPassword))).StatusCode);
        Check.Equal(HttpStatusCode.BadRequest, (await host.Http.PostAsJsonAsync("/api/v1/accounts/users", new { username = "promoted", password = UserPassword, isAdmin = true })).StatusCode);
        Check.Equal(HttpStatusCode.Forbidden, (await host.Http.PostAsJsonAsync($"/api/v1/accounts/users/{admin.User.Id}/status", new AccountStatusRequest(true))).StatusCode);
        Check.Equal(HttpStatusCode.Forbidden, (await host.Http.PostAsJsonAsync($"/api/v1/accounts/users/{admin.User.Id}/password", new AccountPasswordRequest(NewPassword))).StatusCode);
        var a1 = await Login(host, "alice", UserPassword);
        var a2 = await Login(host, "alice", UserPassword);
        Check.Equal(HttpStatusCode.Forbidden, (await host.Http.GetAsync("/api/v1/accounts/users")).StatusCode);
        Check.Equal(HttpStatusCode.Forbidden, (await host.Http.PostAsJsonAsync("/api/v1/accounts/users", new CreateAccountRequest("forged", UserPassword))).StatusCode);
        Check.Equal(HttpStatusCode.Forbidden, (await host.Http.PostAsJsonAsync($"/api/v1/accounts/users/{bob.Id}/status", new AccountStatusRequest(true))).StatusCode);
        Check.Equal(HttpStatusCode.Forbidden, (await host.Http.PostAsJsonAsync($"/api/v1/accounts/users/{bob.Id}/password", new AccountPasswordRequest(NewPassword))).StatusCode);
        host.Http.DefaultRequestHeaders.Add("X-DiceRealm-Local-Settings", "1");
        Check.Equal(HttpStatusCode.Forbidden, (await host.Http.GetAsync("/api/v1/operator/ai-settings")).StatusCode);
        Check.Equal(HttpStatusCode.Forbidden, (await host.Http.PostAsJsonAsync("/api/v1/operator/ai-settings", new { })).StatusCode);
        Check.Equal(HttpStatusCode.Forbidden, (await host.Http.PostAsJsonAsync("/api/v1/operator/ai-settings/test", new { })).StatusCode);
        Check.Equal(HttpStatusCode.Forbidden, (await host.Http.GetAsync($"/api/v1/operator/ai-settings/tests/{Id()}")).StatusCode);
        Bearer(host, admin.AccessToken);
        Check.Equal(HttpStatusCode.OK, (await host.Http.GetAsync("/api/v1/operator/ai-settings")).StatusCode);
        Check.Equal(HttpStatusCode.OK, (await host.Http.PostAsJsonAsync($"/api/v1/accounts/users/{alice.Id}/password", new AccountPasswordRequest(NewPassword))).StatusCode);
        foreach (var old in new[] { a1.AccessToken, a2.AccessToken })
        {
            Bearer(host, old);
            Check.Equal(HttpStatusCode.Unauthorized, (await host.Http.GetAsync("/api/v1/accounts/me")).StatusCode);
        }
        Check.Equal(HttpStatusCode.Unauthorized, (await host.Http.PostAsJsonAsync("/api/v1/accounts/login", new AccountLoginRequest("alice", UserPassword))).StatusCode);
        var changed = await Login(host, "alice", NewPassword);
        Bearer(host, admin.AccessToken);
        var disable = await host.Http.PostAsJsonAsync($"/api/v1/accounts/users/{alice.Id}/status", new AccountStatusRequest(true));
        Check.Equal(HttpStatusCode.OK, disable.StatusCode); Check.True((await disable.Content.ReadFromJsonAsync<AccountUser>())!.Disabled);
        Bearer(host, changed.AccessToken);
        Check.Equal(HttpStatusCode.Unauthorized, (await host.Http.GetAsync("/api/v1/accounts/me")).StatusCode);
        Check.Equal(HttpStatusCode.Unauthorized, (await host.Http.PostAsJsonAsync("/api/v1/accounts/login", new AccountLoginRequest("alice", NewPassword))).StatusCode);
        Bearer(host, admin.AccessToken);
        Check.Equal(HttpStatusCode.OK, (await host.Http.PostAsJsonAsync($"/api/v1/accounts/users/{alice.Id}/status", new AccountStatusRequest(false))).StatusCode);
        Bearer(host, changed.AccessToken);
        Check.Equal(HttpStatusCode.Unauthorized, (await host.Http.GetAsync("/api/v1/accounts/me")).StatusCode);
        var restored = await Login(host, "alice", NewPassword);
        Check.Equal(alice.Id, restored.User.Id);
        AssertNoSecrets(host, UserPassword, NewPassword, admin.AccessToken, restored.AccessToken);
    }

    public static async Task CampaignOwnershipLegacyAndRestart()
    {
        string root, own, foreign, legacyId, oldSqliteId, oldToken, guestToken, adminToken, aliceToken, bobToken;
        byte[] legacyBytes;
        await using (var host = await Host.Start())
        {
            root = host.Root; SeedAdminFixture(host);
            var admin = await Login(host); adminToken = admin.AccessToken;
            var alice = await CreateUser(host, "alice"); var bob = await CreateUser(host, "bob");
            var old = await host.Create("Existing Unity"); oldSqliteId = old.Snapshot.Id; oldToken = old.AccessToken;
            var invitation = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
            var invited = await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{oldSqliteId}/invitations", new InviteRequest(Id(), old.Snapshot.Version, invitation));
            Check.Equal(HttpStatusCode.OK, invited.StatusCode);
            guestToken = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
            var guest = await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{oldSqliteId}/join", new JoinCampaignRequest(Id(), invitation, guestToken, "Account compatibility guest", Build: FullCreationTests.Named("Account compatibility guest")));
            Check.Equal(HttpStatusCode.OK, guest.StatusCode);
            var legacy = TestContent.Campaign(tokenHash: Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32)));
            legacyId = legacy.Id;
            legacy.Events.Add(new(Id(), 1, "arrival", Adventure.Current(legacy).Arrival, "", "authored", DateTimeOffset.UtcNow, null));
            JsonFiles.Write(Path.Combine(root, "campaigns", legacyId + ".json"), legacy);
            legacyBytes = File.ReadAllBytes(Path.Combine(root, "campaigns", legacyId + ".json"));
            var a = await Login(host, "alice", UserPassword); aliceToken = a.AccessToken;
            own = await CreateCampaign(host, "Alice campaign");
            var state = JsonNode.Parse(DatabaseState(host, own))!;
            Check.Equal(alice.Id, state["ownerUserId"]!.GetValue<string>());
            Check.True((await host.Get(own))!.Party!.IsHost); Check.True((await host.Get(own))!.Character is null);
            Check.Equal(HttpStatusCode.BadRequest, (await host.Http.PostAsJsonAsync("/api/v1/accounts/campaigns", new { name = " ", ownerUserId = bob.Id })).StatusCode);
            Check.Equal(HttpStatusCode.BadRequest, (await host.Http.PostAsJsonAsync("/api/v1/accounts/campaigns", new { name = " " })).StatusCode);
            var b = await Login(host, "bob", UserPassword); bobToken = b.AccessToken;
            foreign = await CreateCampaign(host, "Bob campaign");
            Check.Equal(foreign, (await Campaigns(host)).Single().Id);
            Check.Equal(HttpStatusCode.Forbidden, (await host.Http.GetAsync($"/api/v1/campaigns/{own}")).StatusCode);
            Check.Equal(HttpStatusCode.Forbidden, (await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{own}/room", new ConfigureRoomRequest(Id(), 1, true, UserPassword))).StatusCode);
            Check.Equal(HttpStatusCode.Forbidden, (await host.Http.GetAsync($"/api/v1/campaigns/{oldSqliteId}")).StatusCode);
            Check.Equal(HttpStatusCode.Forbidden, (await host.Http.GetAsync($"/api/v1/campaigns/{legacyId}")).StatusCode);
            Check.True(!File.Exists(Path.Combine(root, "campaigns", legacyId + ".sqlite")));
            Bearer(host, aliceToken);
            var list = await Campaigns(host);
            Check.Equal(1, list.Length); Check.Equal(own, list[0].Id); Check.Equal(alice.Id, list[0].OwnerUserId); Check.Equal("alice", list[0].OwnerUsername);
            Check.Equal(HttpStatusCode.Forbidden, (await host.Http.GetAsync($"/api/v1/campaigns/{foreign}")).StatusCode);
            Bearer(host, adminToken);
            string before = DatabaseState(host, own);
            var all = await Campaigns(host);
            Check.Equal(4, all.Length); Check.True(all.Single(c => c.Id == legacyId).OwnerUserId is null);
            Check.Equal(before, DatabaseState(host, own));
            Check.True(legacyBytes.SequenceEqual(File.ReadAllBytes(Path.Combine(root, "campaigns", legacyId + ".json"))));
            Check.True(!File.Exists(Path.Combine(root, "campaigns", legacyId + ".sqlite")), "List must not import legacy games");
            // Admin may read and write every old or owned campaign, not a read-only legacy exception.
            var archived = await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{oldSqliteId}/archive", new ArchiveCampaignRequest(Id(), (await host.Get(oldSqliteId))!.Version, true));
            Check.Equal(HttpStatusCode.OK, archived.StatusCode);
            Check.True((await Campaigns(host)).Single(c => c.Id == oldSqliteId).Archived);
            Check.Equal(HttpStatusCode.OK, (await host.Http.GetAsync($"/api/v1/campaigns/{legacyId}")).StatusCode);
            Bearer(host, oldToken); Check.True((await host.Get(oldSqliteId))!.Party!.IsHost);
            host.Http.DefaultRequestHeaders.Add("X-DiceRealm-Local-Settings", "1");
            Check.Equal(HttpStatusCode.Unauthorized, (await host.Http.GetAsync("/api/v1/operator/ai-settings")).StatusCode);
            Bearer(host, guestToken); Check.True(!(await host.Get(oldSqliteId))!.Party!.IsHost);
            Check.Equal(HttpStatusCode.Unauthorized, (await host.Http.GetAsync("/api/v1/accounts/campaigns")).StatusCode);
        }
        await using var restarted = await Host.Start(root);
        Bearer(restarted, aliceToken); Check.Equal(own, (await Campaigns(restarted)).Single().Id); Check.True((await restarted.Get(own))!.Party!.IsHost);
        Bearer(restarted, bobToken); Check.Equal(foreign, (await Campaigns(restarted)).Single().Id);
        Check.Equal(HttpStatusCode.Forbidden, (await restarted.Http.GetAsync($"/api/v1/campaigns/{own}")).StatusCode);
        Bearer(restarted, adminToken); Check.Equal(4, (await Campaigns(restarted)).Length); Check.Equal(HttpStatusCode.OK, (await restarted.Http.GetAsync($"/api/v1/campaigns/{legacyId}")).StatusCode);
        Bearer(restarted, oldToken); Check.True((await restarted.Get(oldSqliteId))!.Party!.IsHost);
        Bearer(restarted, guestToken); Check.True(!(await restarted.Get(oldSqliteId))!.Party!.IsHost);
        Check.True(legacyBytes.SequenceEqual(File.ReadAllBytes(Path.Combine(root, "campaigns", legacyId + ".json"))));
    }

    public static async Task RoomFingerprintAcrossSessionsAndLegacy()
    {
        string root, campaign, secondToken, legacyId, legacyToken;
        ConfigureRoomRequest request, oldRequest;
        int version;
        await using (var host = await Host.Start())
        {
            root = host.Root; SeedAdminFixture(host); await Login(host);
            await CreateUser(host, "alice"); await Login(host, "alice", UserPassword);
            campaign = await CreateCampaign(host, "Replay account room");
            request = new(Id(), 1, true, "private-room-fixture");
            var accepted = await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{campaign}/room", request);
            Check.Equal(HttpStatusCode.OK, accepted.StatusCode); version = (await accepted.Content.ReadFromJsonAsync<ActionResponse>())!.Snapshot.Version;
            Check.Equal(HttpStatusCode.OK, (await host.Http.PostAsync("/api/v1/accounts/logout", null)).StatusCode);
            secondToken = (await Login(host, "alice", UserPassword)).AccessToken;
            var replay = await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{campaign}/room", request);
            Check.Equal(HttpStatusCode.OK, replay.StatusCode); Check.True((await replay.Content.ReadFromJsonAsync<ActionResponse>())!.Replayed);
            Check.Equal(version, (await host.Get(campaign))!.Version);
            Check.Equal(HttpStatusCode.Conflict, (await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{campaign}/room", request with { Password = "different-room-fixture" })).StatusCode);
            Check.True(!DatabaseState(host, campaign).Contains(request.Password));
            var legacyResponse = await host.Http.PostAsJsonAsync("/api/v1/rooms", new { name = "Legacy fingerprint room" });
            var legacy = (await legacyResponse.Content.ReadFromJsonAsync<CreatedCampaign>())!; legacyId = legacy.Snapshot.Id; legacyToken = legacy.AccessToken;
            Bearer(host, legacyToken); oldRequest = new(Id(), 1, true, "legacy-private-room-fixture");
            Check.Equal(HttpStatusCode.OK, (await host.Http.PostAsJsonAsync($"/api/v1/campaigns/{legacyId}/room", oldRequest)).StatusCode);
            string expected = JsonFiles.Hash("party.room:" + JsonSerializer.Serialize(new
            {
                oldRequest.RequestId, oldRequest.ExpectedVersion, oldRequest.Enabled,
                passwordProof = Convert.ToHexStringLower(HMACSHA256.HashData(Encoding.UTF8.GetBytes(legacyToken), Encoding.UTF8.GetBytes(oldRequest.Password)))
            }, JsonFiles.Options));
            var store = host.App.Services.GetRequiredService<CampaignStore>();
            string actual = await store.Access(legacyId, legacyToken, false, c => Task.FromResult(store.FindReceipt(c, oldRequest.RequestId)!.Fingerprint));
            Check.Equal(expected, actual);
        }
        await using var restarted = await Host.Start(root);
        Bearer(restarted, secondToken);
        var replayAfterRestart = await restarted.Http.PostAsJsonAsync($"/api/v1/campaigns/{campaign}/room", request);
        Check.Equal(HttpStatusCode.OK, replayAfterRestart.StatusCode); Check.True((await replayAfterRestart.Content.ReadFromJsonAsync<ActionResponse>())!.Replayed);
        Check.Equal(version, (await restarted.Get(campaign))!.Version);
        Bearer(restarted, legacyToken);
        Check.True((await (await restarted.Http.PostAsJsonAsync($"/api/v1/campaigns/{legacyId}/room", oldRequest)).Content.ReadFromJsonAsync<ActionResponse>())!.Replayed);
    }

    public static async Task CorruptRecordsAndLoginLimiter()
    {
        await using var host = await Host.Start(); SeedAdminFixture(host); var admin = await Login(host);
        string id = Id(), legacy = Path.Combine(host.Root, "campaigns", id + ".json");
        byte[] corrupt = Encoding.UTF8.GetBytes("{invalid"); File.WriteAllBytes(legacy, corrupt);
        // A damaged record is isolated: the list stays 200, healthy entries survive and the
        // unreadable file is reported as unavailable rather than aborting the whole list.
        var isolated = await Campaigns(host);
        var broken = isolated.Single(c => c.Id == id);
        Check.True(broken.Unavailable); Check.Equal("无法读取的战役", broken.Name);
        Check.True(!broken.Archived && broken.OwnerUserId is null && broken.OwnerUsername is null);
        Check.True(corrupt.SequenceEqual(File.ReadAllBytes(legacy))); Check.True(!File.Exists(Path.ChangeExtension(legacy, ".sqlite")));
        File.Delete(legacy); // Remove only the corruption fixture created by this test.
        // One successful login already consumed one permit; malformed attempts are limited too.
        for (int i = 1; i < 20; i++) Check.Equal(HttpStatusCode.BadRequest, (await host.Http.PostAsJsonAsync("/api/v1/accounts/login", new { })).StatusCode);
        var limited = await host.Http.PostAsJsonAsync("/api/v1/accounts/login", new { });
        Check.Equal(HttpStatusCode.TooManyRequests, limited.StatusCode); Check.True(limited.Headers.RetryAfter is not null);
        Check.True((await limited.Content.ReadAsStringAsync()).Contains("account_login_rate_limited"));
        Bearer(host, admin.AccessToken); Check.Equal(HttpStatusCode.OK, (await host.Http.GetAsync("/api/v1/accounts/me")).StatusCode);
        string saved = File.ReadAllText(AccountPath(host));
        var document = JsonNode.Parse(saved)!; document["schemaVersion"] = 2;
        JsonFiles.Write(AccountPath(host), document);
        string corruptAccount = File.ReadAllText(AccountPath(host));
        Check.Equal(HttpStatusCode.Conflict, (await host.Http.GetAsync("/api/v1/accounts/me")).StatusCode);
        Check.Equal(corruptAccount, File.ReadAllText(AccountPath(host)));
    }

    // Damaged or unsupported records are isolated per file: healthy campaigns stay usable, an
    // unverifiable record is shown to the admin only, and originals are neither migrated nor modified.
    public static async Task ListIsolationKeepsHealthyAndHidesUnknownRecords()
    {
        await using var host = await Host.Start(); SeedAdminFixture(host);
        var admin = await Login(host);
        var alice = await CreateUser(host, "alice");
        var bob = await CreateUser(host, "bob");
        var aliceToken = (await Login(host, "alice", UserPassword)).AccessToken;
        var bobToken = (await Login(host, "bob", UserPassword)).AccessToken;
        Bearer(host, aliceToken);
        string own = await CreateCampaign(host, "Alice healthy");
        string folder = Path.Combine(host.Root, "campaigns");
        var store = host.App.Services.GetRequiredService<CampaignStore>();

        string ownedLegacy = Id(), unclaimedLegacy = Id(), badJson = Id(), futureSchema = Id(), brokenSqlite = Id();
        const string oddName = "not-a-guid";
        void WriteLegacy(string id, string name, string? owner = null, int schemaVersion = 1)
        {
            var node = JsonSerializer.SerializeToNode(TestContent.Campaign(name: name, id: id), JsonFiles.Options)!.AsObject();
            if (owner is not null) node["ownerUserId"] = owner;
            node["schemaVersion"] = schemaVersion;
            JsonFiles.Write(Path.Combine(folder, id + ".json"), node);
        }
        WriteLegacy(ownedLegacy, "Alice legacy", alice.Id);
        WriteLegacy(unclaimedLegacy, "Unclaimed legacy");
        WriteLegacy(futureSchema, "Future schema", schemaVersion: 2);
        File.WriteAllBytes(Path.Combine(folder, badJson + ".json"), Encoding.UTF8.GetBytes("{invalid"));
        File.WriteAllBytes(Path.Combine(folder, oddName + ".json"), Encoding.UTF8.GetBytes("{}"));
        File.WriteAllText(Path.Combine(folder, ".json"), "{}");
        // A healthy legacy JSON beside a broken SQLite file: SQLite stays authoritative.
        WriteLegacy(brokenSqlite, "Healthy legacy beside broken storage");
        File.WriteAllBytes(Path.Combine(folder, brokenSqlite + ".sqlite"), Encoding.UTF8.GetBytes("not a sqlite database"));
        var futureDb = TestContent.Campaign(name: "Future storage version");
        futureDb.Events.Add(new(Id(), 1, "arrival", Adventure.Current(futureDb).Arrival, "", "authored", DateTimeOffset.UtcNow, null));
        store.Create(futureDb);
        using (var db = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = Path.Combine(folder, futureDb.Id + ".sqlite"), Pooling = false }.ToString()))
        { db.Open(); using var command = db.CreateCommand(); command.CommandText = "PRAGMA user_version=4"; command.ExecuteNonQuery(); }

        var before = Directory.GetFiles(folder).ToDictionary(path => path, File.ReadAllBytes);
        string[] broken = [badJson, futureSchema, futureDb.Id, brokenSqlite, oddName, "（无战役标识）"];

        Bearer(host, admin.AccessToken);
        var response = await host.Http.GetAsync("/api/v1/accounts/campaigns");
        Check.Equal(HttpStatusCode.OK, response.StatusCode);
        string adminBody = await response.Content.ReadAsStringAsync();
        using var adminDocument = JsonDocument.Parse(adminBody);
        var adminList = adminDocument.RootElement.GetProperty("campaigns").Deserialize<AccountCampaign[]>(JsonFiles.Options)!;
        var byId = adminList.ToDictionary(c => c.Id);
        Check.True(!byId[own].Unavailable && byId[own].OwnerUserId == alice.Id && byId[own].OwnerUsername == "alice");
        Check.True(!byId[ownedLegacy].Unavailable && byId[ownedLegacy].OwnerUserId == alice.Id && byId[ownedLegacy].OwnerUsername == "alice");
        Check.True(!byId[unclaimedLegacy].Unavailable && byId[unclaimedLegacy].OwnerUserId is null && byId[unclaimedLegacy].OwnerUsername is null);
        foreach (string id in broken)
        {
            var entry = byId[id];
            Check.True(entry.Unavailable, id + " must be reported unavailable instead of aborting the list");
            Check.Equal("无法读取的战役", entry.Name);
            Check.True(!entry.Archived && entry.OwnerUserId is null && entry.OwnerUsername is null, id + " must not guess ownership");
        }
        Check.True(!adminList.Any(c => c.Name == "Healthy legacy beside broken storage"), "A broken SQLite file stays authoritative over the JSON beside it");
        foreach (string leak in new[] { "Exception", host.Root, "not a sqlite database", "{invalid" })
            Check.True(!adminBody.Contains(leak), "The list must not expose record bodies, paths or exceptions");

        Bearer(host, aliceToken);
        string aliceBody = await host.Http.GetStringAsync("/api/v1/accounts/campaigns");
        using (var document = JsonDocument.Parse(aliceBody))
        {
            var campaigns = document.RootElement.GetProperty("campaigns");
            Check.Equal(string.Join(',', new[] { own, ownedLegacy }.Order(StringComparer.Ordinal)),
                string.Join(',', campaigns.EnumerateArray().Select(c => c.GetProperty("id").GetString()).Order(StringComparer.Ordinal)));
            Check.Equal("archived,id,name,ownerUserId,ownerUsername",
                string.Join(',', campaigns.EnumerateArray().First().EnumerateObject().Select(p => p.Name).Order()));
        }
        foreach (string id in broken) Check.True(!aliceBody.Contains(id), "An ordinary user must not learn that an unreadable record exists");
        Check.True(!aliceBody.Contains("unavailable") && !aliceBody.Contains("无法读取"), "Healthy rows keep their previous response shape");

        Bearer(host, bobToken);
        string bobBody = await host.Http.GetStringAsync("/api/v1/accounts/campaigns");
        using (var document = JsonDocument.Parse(bobBody))
            Check.Equal(0, document.RootElement.GetProperty("campaigns").GetArrayLength());
        foreach (string id in broken) Check.True(!bobBody.Contains(id));

        var after = Directory.GetFiles(folder).ToDictionary(path => path, File.ReadAllBytes);
        Check.Equal(string.Join('\n', before.Keys.Order(StringComparer.Ordinal)), string.Join('\n', after.Keys.Order(StringComparer.Ordinal)));
        foreach (var (path, bytes) in before) Check.True(bytes.SequenceEqual(after[path]), "The list must not rewrite " + Path.GetFileName(path));
        Check.True(!File.Exists(Path.Combine(folder, ownedLegacy + ".sqlite")) && !File.Exists(Path.Combine(folder, unclaimedLegacy + ".sqlite")),
            "Reading the list must not import a legacy record");

        // Authentication, cancellation and directory-level faults stay real.
        Check.Throws<OperationCanceledException>(() => store.ListForAccount(bobToken, new CancellationToken(true)).GetAwaiter().GetResult());
        Directory.Delete(folder, recursive: true);
        Check.Throws<IOException>(() => store.ListForAccount(bobToken).GetAwaiter().GetResult());
    }
}
