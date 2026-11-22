using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using Microsoft.Data.Sqlite;

namespace DiceRealm.Server.Infrastructure;

// A per-campaign SQLite database keeps state, append-only events and actor-scoped receipts
// in one durable commit. Only the latest 100 events are hydrated for ordinary gameplay.
// The directory lease still enforces a single server writer; this is not scale-out storage.
public sealed partial class CampaignStore(DataDirectory directory, AccountStore? accounts = null)
{
    private readonly ConcurrentDictionary<string, SemaphoreSlim> gates = new();
    private readonly RoomDirectory rooms = new(directory);
    private string LegacyPath(string id) => Path.Combine(directory.Root, "campaigns", id + ".json");
    private string DatabasePath(string id) => Path.Combine(directory.Root, "campaigns", id + ".sqlite");
    private SqliteConnection Open(string id) => OpenPath(DatabasePath(id));
    private static SqliteConnection OpenPath(string path)
    {
        var db = new SqliteConnection(new SqliteConnectionStringBuilder
        { DataSource = path, Pooling = false }.ToString());
        db.Open();
        using var command = db.CreateCommand();
        // DELETE mode leaves a self-contained file after a commit. FULL fsync is deliberate.
        command.CommandText = "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;";
        command.ExecuteNonQuery();
        return db;
    }
    private static void Schema(SqliteConnection db)
    {
        using var command = db.CreateCommand();
        command.CommandText = """
            CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY, json TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS receipts (actor TEXT NOT NULL, request TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(actor,request));
            PRAGMA user_version=1;
            """;
        command.ExecuteNonQuery();
    }
    public void Create(Campaign campaign)
    {
        JsonFiles.CampaignId(campaign.Id);
        if (File.Exists(LegacyPath(campaign.Id)) || File.Exists(DatabasePath(campaign.Id)))
            throw new InvalidOperationException("Duplicate campaign ID.");
        Import(campaign);
    }
    private void Import(Campaign campaign, bool legacy = false)
    {
        var target = DatabasePath(campaign.Id);
        var temp = target + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using (var db = OpenPath(temp)) { Schema(db); Save(db, campaign, 0, importing: true, indexed: !legacy); }
            File.Move(temp, target); // Publish only a fully committed database, never overwrite one.
        }
        finally { if (File.Exists(temp)) File.Delete(temp); }
    }
    // Only inside an authenticated Access gate, before the first workspace directory write.
    // This metadata-only checkpoint deliberately survives a later catalog failure. It prevents
    // lost/partial initialization from ever being mistaken for an untouched bootstrap profile.
    public void CheckpointWorkspaceInitialization(Campaign c)
    {
        if (c.HarnessWorkspaceInitialized) return;
        if (c.Harness is null || c.Receipts.Count != 0) throw new InvalidOperationException("Invalid workspace checkpoint context.");
        c.HarnessWorkspaceInitialized = true;
        using var db = Open(c.Id); Save(db, c, c.Version, importing: false);
    }

    public Task<T> Access<T>(string id, string token, bool write,
        Func<Campaign, Task<T>> operation, CancellationToken cancellationToken = default) =>
        Transaction(id, write, c =>
        {
            var account = accounts?.TryAuthenticate(token);
            if (account is not null)
            {
                if (!account.IsAdmin && c.OwnerUserId != account.Id)
                    throw new GameException("forbidden", "此战役不属于当前账户。", 403);
                c.ActingActorId = PartyEngine.HostId;
                c.AccountRoomFingerprintKey = accounts!.RoomFingerprintKey(account.Id, c.Id);
            }
            else if (Matches(token, c.TokenHash)) c.ActingActorId = PartyEngine.HostId;
            else
            {
                var seat = c.PartyMembers.FirstOrDefault(m => !m.Revoked && Matches(token, m.TokenHash));
                if (seat is null) throw new GameException("unauthorized", "战役凭证无效或席位已撤销。", 401);
                c.ActingActorId = seat.Id;
            }
        }, operation, cancellationToken);

    // Only a saved battle return may resume its original parent. Revalidate the original
    // account/seat credential every time; another combatant's token never impersonates it.
    internal Task<T> AccessCombatParent<T>(string id, string sessionId, string parentRunId, string? returnId, bool write,
        Func<Campaign, Task<T>> operation, CancellationToken ct = default) => Transaction(id, write, c =>
        {
            ValidateCombatSessions(c);
            var session = CombatAgentSessions.Require(c, sessionId);
            if (session.ParentRunId != parentRunId ||
                (returnId is not null ? session.Return?.Id != returnId : session.Return is null &&
                    (c.Combat?.Id != session.BattleId || CombatEngine.InCombat(c) || StandardCombatEngine.NarrationPending(c) || c.Combat?.Status is not ("victory" or "defeated" or "retreated"))))
                throw new GameException("combat_return_unavailable", "尚无此父运行的权威战斗结果。", 409);
            AuthorizeCombatCredential(c, session);
        }, operation, ct);

    // Delegation itself authorized this exact first input before initiative. This grant
    // cannot create a later input, use another seat or survive credential revocation.
    internal Task<T> AccessCombatFirstInput<T>(string id, string sessionId, string runId, bool write,
        Func<Campaign, Task<T>> operation, CancellationToken ct = default) => Transaction(id, write, c =>
        {
            ValidateCombatSessions(c);
            var session = CombatAgentSessions.Require(c, sessionId);
            if (session.Phase != "active" || session.Inputs[0].RunId != runId || session.Inputs[0].ActorId != session.ParentActorId)
                throw new GameException("combat_session_owned", "此运行不是当前战斗的原委派输入。", 409);
            AuthorizeCombatCredential(c, session);
        }, operation, ct);

    private void AuthorizeCombatCredential(Campaign c, CombatAgentSession session)
    {
        var account = accounts?.TryAuthenticateHash(session.ParentCredentialHash);
        if (account is not null)
        {
            if (!account.IsAdmin && c.OwnerUserId != account.Id) throw new GameException("forbidden", "原主持账户已失去此战役的权限。", 403);
            c.ActingActorId = PartyEngine.HostId;
            c.AccountRoomFingerprintKey = accounts!.RoomFingerprintKey(account.Id, c.Id);
        }
        else if (HashMatches(session.ParentCredentialHash, c.TokenHash)) c.ActingActorId = PartyEngine.HostId;
        else
        {
            var seat = c.PartyMembers.FirstOrDefault(m => !m.Revoked && HashMatches(session.ParentCredentialHash, m.TokenHash));
            if (seat is null) throw new GameException("unauthorized", "原委派凭证已失效，战斗结果保留待原席位恢复。", 401);
            c.ActingActorId = seat.Id;
        }
        if (c.ActingActorId != session.ParentActorId) throw new GameException("unauthorized", "战斗返回的原席位身份不符。", 401);
        if (c.Archived) throw new GameException("campaign_archived", "已归档战役不能恢复主持。", 409);
        CharacterReviews.RequireApproved(c);
    }

    private static bool HashMatches(string hash, string expected) => hash.Length == 64 &&
        CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(hash), Encoding.ASCII.GetBytes(expected));

    internal string RequireAccountOwner(string token) => (accounts ?? throw new InvalidOperationException("Account storage is unavailable.")).Require(token).Id;

    public async Task<AccountCampaign[]> ListForAccount(string token, CancellationToken ct = default)
    {
        var accountStore = accounts ?? throw new InvalidOperationException("Account storage is unavailable.");
        var account = accountStore.Require(token);
        var usernames = accountStore.Usernames();
        ct.ThrowIfCancellationRequested();
        string folder = Path.Combine(directory.Root, "campaigns");
        // Directory-level failures stay real: only individual records are isolated below.
        // SQLite is authoritative when an imported legacy JSON remains beside it.
        var ids = Directory.EnumerateFiles(folder, "*.sqlite").Concat(Directory.EnumerateFiles(folder, "*.json"))
            .Select(path => Path.GetFileNameWithoutExtension(path)).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();
        var result = new List<AccountCampaign>();
        foreach (string id in ids)
        {
            ct.ThrowIfCancellationRequested();
            // A name that cannot identify a campaign is reported as unusable, never renamed or deleted.
            if (!Guid.TryParseExact(id, "D", out var guid) || guid.ToString() != id)
            {
                if (account.IsAdmin) result.Add(Unavailable(id));
                continue;
            }
            var gate = gates.GetOrAdd(id, _ => new SemaphoreSlim(1, 1));
            await gate.WaitAsync(ct);
            try
            {
                var summary = TryReadSummary(id, usernames);
                if (summary is null)
                {
                    // Ownership of a damaged record cannot be confirmed, so only an admin sees it.
                    if (account.IsAdmin) result.Add(Unavailable(id));
                    continue;
                }
                if (account.IsAdmin || summary.OwnerUserId == account.Id) result.Add(summary);
            }
            finally { gate.Release(); }
        }
        return result.ToArray();
    }
    // One unreadable file must never abort the whole list, and its bytes are never modified.
    private AccountCampaign? TryReadSummary(string id, Dictionary<string, string> usernames)
    {
        try { return ReadSummary(id, usernames); }
        catch (Exception ex) when (ex is JsonException or InvalidDataException or SqliteException or FormatException
            or KeyNotFoundException or InvalidOperationException or IOException or UnauthorizedAccessException)
        { return null; }
    }
    private AccountCampaign ReadSummary(string id, Dictionary<string, string> usernames)
    {
        string json;
        if (File.Exists(DatabasePath(id)))
        {
            using var db = new SqliteConnection(new SqliteConnectionStringBuilder
            { DataSource = DatabasePath(id), Mode = SqliteOpenMode.ReadOnly, Pooling = false }.ToString());
            db.Open();
            using var command = db.CreateCommand();
            command.CommandText = "PRAGMA user_version";
            if (Convert.ToInt32(command.ExecuteScalar()) is not (1 or 2 or 3)) throw InvalidSummary();
            command.CommandText = "SELECT json FROM state WHERE id=1";
            json = command.ExecuteScalar() as string ?? throw InvalidSummary();
        }
        else json = File.ReadAllText(LegacyPath(id));
        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;
        if (root.GetProperty("id").GetString() != id || root.GetProperty("schemaVersion").GetInt32() != 1 ||
            root.GetProperty("ruleset").GetString() != "dnd2024") throw InvalidSummary();
        string name = root.GetProperty("name").GetString() ?? throw InvalidSummary();
        if (string.IsNullOrWhiteSpace(name) || name.Length > 80) throw InvalidSummary();
        bool archived = root.TryGetProperty("archived", out var archive) && archive.GetBoolean();
        string? owner = root.TryGetProperty("ownerUserId", out var ownerProperty) ? ownerProperty.GetString() : null;
        string? ownerName = null;
        if (owner is not null && !usernames.TryGetValue(owner, out ownerName)) throw InvalidSummary();
        return new(id, name, archived, owner, ownerName);
    }
    // Fixed text only: no path, exception or record body is exposed through the list.
    private static AccountCampaign Unavailable(string id) => new(id.Length == 0 ? "（无战役标识）" : id, "无法读取的战役", false, null, null, true);
    private static InvalidDataException InvalidSummary() => new("Campaign summary is damaged or unsupported; the original record is preserved.");

    // Invitation validation and join run under the same campaign lock.
    public Task<T> AccessInvitation<T>(string id, string inviteToken, Func<Campaign, Task<T>> operation, CancellationToken ct = default) =>
        Transaction(id, true, c =>
        {
            if (!c.Invitations.Any(i => Matches(inviteToken, i.TokenHash)))
                throw new GameException("unauthorized", "邀请凭证无效。", 401);
        }, operation, ct);

    internal string ReserveRoom(Campaign campaign)
    {
        PartyEngine.RequireHost(campaign);
        if (campaign.Room is { } existing)
        {
            if (rooms.Find(existing.Number) != campaign.Id) throw new InvalidDataException("Room directory no longer matches the campaign.");
            return existing.Number;
        }
        return rooms.Reserve(campaign.Id);
    }
    internal async Task<T> AccessRoom<T>(JoinRoomRequest request, Func<Campaign, Task<T>> operation, CancellationToken ct)
    {
        string? id = rooms.Find(request.RoomNumber);
        if (id is null)
        {
            RoomCredentials.Verify(request.Password, null);
            throw RoomCredentials.Denied();
        }
        try { return await Transaction(id, true, c =>
        {
            if (c.Room?.Number != request.RoomNumber) { RoomCredentials.Verify(request.Password, null); throw RoomCredentials.Denied(); }
            var replay = c.PartyMembers.FirstOrDefault(m => m.RoomJoin?.RequestId == request.RequestId && Matches(request.AccessToken, m.TokenHash));
            if (replay is not null)
            {
                if (replay.Revoked) throw RoomCredentials.Denied();
                c.ActingActorId = replay.Id;
            }
            else
            {
                if (!RoomCredentials.Verify(request.Password, c.Room)) throw RoomCredentials.Denied();
                c.ActingActorId = ""; // A password authorizes only new admission, never a host/old seat.
            }
        }, operation, ct); }
        catch (GameException ex) when (ex.Code == "not_found")
        {
            RoomCredentials.Verify(request.Password, null);
            throw RoomCredentials.Denied();
        }
    }

    public static bool Matches(string token, string expected) => !string.IsNullOrEmpty(token) &&
        CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(JsonFiles.Hash(token)), Encoding.ASCII.GetBytes(expected));

    // These queries take the already-authorized aggregate, only inside Access's gate. They
    // also work during first-use legacy import; no separate unauthenticated query surface.
    public ActionReceipt? FindReceipt(Campaign c, string requestId)
    {
        var pending = c.Receipts.FirstOrDefault(r => r.ActorId == c.ActingActorId && r.RequestId == requestId);
        if (pending is not null || !File.Exists(DatabasePath(c.Id))) return pending;
        using var db = Open(c.Id); using var cmd = db.CreateCommand();
        cmd.CommandText = "SELECT json FROM receipts WHERE actor=$actor AND request=$request";
        cmd.Parameters.AddWithValue("$actor", c.ActingActorId); cmd.Parameters.AddWithValue("$request", requestId);
        return cmd.ExecuteScalar() is string json ? Deserialize<ActionReceipt>(json) : null;
    }
    public GameEvent[] ReadEvents(Campaign c, int after, int limit, int through = int.MaxValue)
    {
        if (!File.Exists(DatabasePath(c.Id)))
            return c.Events.Where(e => e.Sequence > after && e.Sequence <= through).Take(limit).ToArray();
        using var db = Open(c.Id); using var cmd = db.CreateCommand();
        cmd.CommandText = "SELECT json FROM events WHERE sequence>$after AND sequence<=$through ORDER BY sequence LIMIT $limit";
        cmd.Parameters.AddWithValue("$after", after); cmd.Parameters.AddWithValue("$through", through); cmd.Parameters.AddWithValue("$limit", limit);
        using var rows = cmd.ExecuteReader(); var result = new List<GameEvent>();
        while (rows.Read()) result.Add(Deserialize<GameEvent>(rows.GetString(0)));
        return result.ToArray();
    }
    // Read only events containing this actual seat's story, including cold history.
    // Host authority is deliberately absent. JSON filters avoid hydrating unrelated
    // actions; the caller projects ONLY source/text, never input, origins or mechanics.
    public IEnumerable<GameEvent> ReadPrivateStoryEvents(Campaign c)
    {
        var rulings = c.PendingRulings.Where(r => r.ActorId == c.ActingActorId && r.PrivateText.Length > 0)
            .Select(r => r.Id).ToHashSet(StringComparer.Ordinal);
        bool Matches(GameEvent e) => !e.HostOnly && e.ReviewActorId.Length == 0 &&
            (e.ActorId == c.ActingActorId && e.PrivateText.Length > 0 ||
             e.PrivateMessages?.Any(m => m.RecipientIds.Contains(c.ActingActorId, StringComparer.Ordinal)) == true ||
             e.Resolution is { Kind: "ruling.resolve" or "ruling.request_roll" } result && rulings.Contains(result.RulingId));
        if (!File.Exists(DatabasePath(c.Id)))
        {
            foreach (var e in c.Events.Where(Matches)) yield return e;
            yield break;
        }
        using var db = Open(c.Id); using var cmd = db.CreateCommand();
        cmd.CommandText = """
            SELECT e.json FROM events e
            WHERE coalesce(json_extract(e.json,'$.hostOnly'),0)=0
              AND coalesce(json_extract(e.json,'$.reviewActorId'),'')=''
              AND ((json_extract(e.json,'$.actorId')=$actor AND length(coalesce(json_extract(e.json,'$.privateText'),''))>0)
                OR EXISTS (SELECT 1 FROM json_each(e.json,'$.privateMessages') message
                  JOIN json_each(message.value,'$.recipientIds') recipient WHERE recipient.value=$actor)
                OR (json_extract(e.json,'$.resolution.kind') IN ('ruling.resolve','ruling.request_roll')
                  AND json_extract(e.json,'$.resolution.rulingId') IN (SELECT value FROM json_each($rulings))))
            ORDER BY e.sequence
            """;
        cmd.Parameters.AddWithValue("$actor", c.ActingActorId);
        cmd.Parameters.AddWithValue("$rulings", JsonSerializer.Serialize(rulings, JsonFiles.Options));
        using var rows = cmd.ExecuteReader();
        while (rows.Read())
        {
            var e = Deserialize<GameEvent>(rows.GetString(0));
            if (Matches(e)) yield return e;
        }
    }
    private async Task<T> Transaction<T>(string id, bool write, Action<Campaign> authorize,
        Func<Campaign, Task<T>> operation, CancellationToken cancellationToken)
    {
        id = JsonFiles.CampaignId(id);
        var gate = gates.GetOrAdd(id, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(cancellationToken);
        try
        {
            GameSaveCatalog.RequireRecovered(directory.Root, id);
            bool legacy = !File.Exists(DatabasePath(id));
            Campaign campaign;
            using var reading = legacy ? null : Open(id);
            int storageVersion = 1;
            if (legacy)
            {
                if (!File.Exists(LegacyPath(id))) throw new GameException("not_found", "未找到战役。", 404);
                campaign = JsonFiles.Read<Campaign>(LegacyPath(id));
            }
            else
            {
                using var cmd = reading!.CreateCommand();
                cmd.CommandText = "PRAGMA user_version";
                storageVersion = Convert.ToInt32(cmd.ExecuteScalar());
                if (storageVersion is not (1 or 2 or 3)) throw new GameException("unsupported_save", "不支持此存储版本。", 409);
                cmd.CommandText = "SELECT json FROM state WHERE id=1";
                campaign = Deserialize<Campaign>((string?)cmd.ExecuteScalar() ?? throw new InvalidDataException("Missing campaign state."));
            }
            if (campaign.Id != id || campaign.SchemaVersion != 1 || campaign.Ruleset != "dnd2024")
                throw new GameException("unsupported_save", "存档版本或标识不支持。", 409);
            authorize(campaign);
            CampaignTimeline.ValidateAccess(campaign, write);
            PrivateStories.ValidateState(campaign);
            AdventureOpenings.ValidateState(campaign);
            PartyEngine.ValidateSeats(campaign);
        RuntimeEncounters.ValidateState(campaign);
            ValidateCombatSessions(campaign);
        SharedBoard.ValidateState(campaign);
            if (storageVersion >= 2)
            {
                if (campaign.WorldMemoryStorageVersion != 1 || campaign.WorldMemory is null || campaign.WorldMemory.Count != 0) throw WorldMemoryIndex.Invalid();
                campaign.WorldMemoryIndex = new SqliteWorldMemory(reading!, campaign.Version);
            }
            else
            {
                if (campaign.WorldMemoryStorageVersion is not null) throw WorldMemoryIndex.Invalid();
                WorldMemoryIndex.ValidateLegacy(campaign.WorldMemory, campaign.Version);
            }
            WorldRoutes.ValidateState(campaign);
            AdvancementEngine.ValidateState(campaign);
            StandardCombatEngine.ValidateState(campaign);
            AdvancementRestChoices.ValidateState(campaign);
            // Import only after successful authentication; keep the original JSON byte-for-byte.
            if (legacy)
            {
                ValidateLegacy(campaign);
                Import(campaign, legacy: true);
            }
            campaign.Events.Clear();
            using (var tail = Open(id))
            using (var recent = tail.CreateCommand())
            {
                recent.CommandText = "SELECT json FROM events ORDER BY sequence DESC LIMIT 100";
                using var rows = recent.ExecuteReader();
                while (rows.Read()) campaign.Events.Add(Deserialize<GameEvent>(rows.GetString(0)));
                campaign.Events.Reverse();
            }
            campaign.Receipts.Clear();
            if (campaign.Character is { } hostCharacter) campaign.Character = StarterCharacter.Upgrade(hostCharacter);
            foreach (var seat in campaign.PartyMembers) seat.Character = StarterCharacter.Upgrade(seat.Character);
            campaign.ElapsedSeconds = Math.Max(campaign.ElapsedSeconds, (long)campaign.ElapsedMinutes * 60);
            GameLifecycle.SynchronizeDeaths(campaign);
            CharacterEngine.Sync(campaign);
            int version = campaign.Version;
            var result = await operation(campaign);
            if (write) { using var db = Open(id); Save(db, campaign, version, importing: false); }
            return result;
        }
        finally { gate.Release(); }
    }
    private static void BackupBeforeWorldMigration(SqliteConnection db)
    {
        // DELETE journal + the directory lease and campaign gate exclude all writers.
        // No read transaction is open. Never overwrite an earlier migration backup.
        string hash;
        using (var stream = new FileStream(db.DataSource, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) hash = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
        string backup = db.DataSource + ".pre-world-v2." + hash + ".bak";
        if (File.Exists(backup))
        {
            using var stream = File.OpenRead(backup);
            if (Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant() != hash) throw WorldMemoryIndex.Invalid();
            return;
        }
        string temp = backup + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using (var input = new FileStream(db.DataSource, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (var output = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            { input.CopyTo(output); output.Flush(flushToDisk: true); }
            File.Move(temp, backup);
        }
        finally { if (File.Exists(temp)) File.Delete(temp); }
    }
    private static T Deserialize<T>(string json) => JsonSerializer.Deserialize<T>(json, JsonFiles.Options)
        ?? throw new InvalidDataException("Empty saved document.");
    private static void ValidateLegacy(Campaign c)
    {
        if (c.Events.Count != c.Version || c.Events.Where((e, i) => e.Sequence != i + 1).Any() ||
            c.Receipts.Select(r => (r.ActorId, r.RequestId)).Distinct().Count() != c.Receipts.Count)
            throw new GameException("invalid_save", "旧存档事件或回执不连续；原文件保留，请先检查备份。", 409);
    }
    private static void ValidateCombatSessions(Campaign c)
    {
        CombatAgentSessions.ValidateState(c);
        foreach (var session in c.CombatAgentSessions ?? [])
            if (!HarnessTools.Supports(session.ToolContractVersion) ||
                session.RulesCatalogVersion is not null && !LocalRulesCatalog.Version(session.RulesCatalogVersion) ||
                session.Profile.Hash != HarnessJson.ProfileHash(session.Profile.Preset, session.Profile.Skills))
                throw new GameException("invalid_combat_session", "战斗子会话的冻结合同或提示词身份不符；原记录保留。", 409);
    }

    private static void Save(SqliteConnection db, Campaign c, int previousVersion, bool importing, bool indexed = true)
    {
        // No SQL transaction spans a model call. The per-campaign gate protects the load/
        // resolve phase; this short transaction atomically appends events+receipts+state.
        var appended = c.Events.Where(e => importing || e.Sequence > previousVersion).ToArray();
        var versions = appended.Select(e => e.Sequence).Concat(c.StateOnlyVersions).Order().ToArray();
        if (c.Version < previousVersion || versions.Length != c.Version - previousVersion ||
            versions.Where((v, i) => v != previousVersion + i + 1).Any() ||
            !appended.Select(e => e.Sequence).SequenceEqual(appended.Select(e => e.Sequence).Order()))
            throw new InvalidDataException("State changes and append-only event versions must agree.");
        GameLifecycle.SynchronizeDeaths(c);
        PrivateStories.ValidateState(c);
        AdventureOpenings.ValidateState(c);
        PartyEngine.ValidateSeats(c);
        RuntimeEncounters.ValidateState(c);
        ValidateCombatSessions(c);
        SharedBoard.ValidateState(c);
        WorldRoutes.ValidateState(c);
        AdvancementEngine.ValidateState(c);
        StandardCombatEngine.ValidateState(c);
        AdvancementRestChoices.ValidateState(c);
        using var schema = db.CreateCommand(); schema.CommandText = "PRAGMA user_version";
        bool migrate = indexed && Convert.ToInt32(schema.ExecuteScalar()) == 1;
        if (indexed && c.WorldMemoryIndex is not null &&
            (c.WorldMemory is null || c.WorldMemory.Count != 0 || c.WorldMemoryIndex.Count > WorldMemories.MaximumEntries)) throw WorldMemoryIndex.Invalid();
        if (c.WorldMemoryIndex is null) WorldMemoryIndex.ValidateLegacy(c.WorldMemory, c.Version);
        if (migrate && !importing) BackupBeforeWorldMigration(db);
        using var tx = db.BeginTransaction();
        if (migrate) SqliteWorldMemory.CreateSchema(db, tx);
        if (indexed)
        {
            if (c.WorldMemoryIndex is SqliteWorldMemory world) world.Save(db, tx, c.Version);
            else SqliteWorldMemory.Write(db, tx, c.WorldMemory, c.Version);
            c.WorldMemoryStorageVersion = 1;
        }
        using var cmd = db.CreateCommand(); cmd.Transaction = tx;
        var state = JsonSerializer.SerializeToNode(c, JsonFiles.Options)!.AsObject();
        state.Remove("events"); state.Remove("receipts");
        if (indexed) state.Remove("worldMemory");
        cmd.CommandText = "INSERT INTO state(id,json) VALUES(1,$json) ON CONFLICT(id) DO UPDATE SET json=excluded.json";
        cmd.Parameters.AddWithValue("$json", state.ToJsonString(JsonFiles.Options)); cmd.ExecuteNonQuery();
        foreach (var e in appended)
        {
            cmd.Parameters.Clear(); cmd.CommandText = "INSERT INTO events(sequence,json) VALUES($sequence,$json)";
            cmd.Parameters.AddWithValue("$sequence", e.Sequence); cmd.Parameters.AddWithValue("$json", JsonSerializer.Serialize(e, JsonFiles.Options)); cmd.ExecuteNonQuery();
        }
        foreach (var r in c.Receipts)
        {
            cmd.Parameters.Clear(); cmd.CommandText = "INSERT INTO receipts(actor,request,json) VALUES($actor,$request,$json)";
            cmd.Parameters.AddWithValue("$actor", r.ActorId); cmd.Parameters.AddWithValue("$request", r.RequestId);
            cmd.Parameters.AddWithValue("$json", JsonSerializer.Serialize(r, JsonFiles.Options)); cmd.ExecuteNonQuery();
        }
        tx.Commit();
    }
}
