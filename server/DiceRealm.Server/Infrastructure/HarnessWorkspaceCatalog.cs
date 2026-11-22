using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using Microsoft.Data.Sqlite;

namespace DiceRealm.Server.Infrastructure;

// Called only under CampaignStore.Access's authenticated campaign gate. Lock order is
// campaign -> this catalog, never the reverse. Immutable source documents own text; SQLite
// owns pointers, revision identities and durable command receipts. No network in either gate.
public sealed class HarnessWorkspaceCatalog(DataDirectory directory)
{
    private sealed record State(int Version, int Active, int Latest, string Draft, string Bootstrap);
    private static GameException Corrupt() => new("workspace_corrupt", "工作区记录缺失或损坏；已保留原文件，请恢复一致备份。", 409);
    private string Folder(Campaign c) => Path.Combine(directory.Root, "workspaces", JsonFiles.CampaignId(c.Id));
    private string Database(Campaign c) => Path.Combine(Folder(c), "workspace.sqlite");
    private string Document(Campaign c, string hash)
    {
        if (hash.Length != 64 || hash.Any(ch => !char.IsAsciiHexDigit(ch)) || hash != hash.ToLowerInvariant()) throw Corrupt();
        return Path.Combine(Folder(c), "documents", hash + ".json");
    }
    private static T Guard<T>(Func<T> read)
    {
        try { return read(); }
        catch (Exception ex) when (ex is SqliteException { SqliteErrorCode: 1 or 11 or 19 or 26 } or JsonException or InvalidDataException or NullReferenceException or ArgumentException or OverflowException)
        { throw Corrupt(); }
    }
    private static SqliteConnection Open(string path, bool create = false)
    {
        var db = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = path, Pooling = false,
            Mode = create ? SqliteOpenMode.ReadWriteCreate : SqliteOpenMode.ReadWrite }.ToString());
        try
        {
            db.Open();
            using var cmd = db.CreateCommand();
            if (!create)
            {
                cmd.CommandText = "PRAGMA user_version";
                if (Convert.ToInt32(cmd.ExecuteScalar()) != 1) throw Corrupt();
            }
            // Never change persistent pragmas in an existing/unknown database on a read.
            cmd.CommandText = (create ? "PRAGMA journal_mode=DELETE; " : "") + "PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;";
            cmd.ExecuteNonQuery();
            return db;
        }
        catch { db.Dispose(); throw; }
    }
    private static SqliteCommand Command(SqliteConnection db, string sql, params (string Key, object Value)[] args)
    {
        var cmd = db.CreateCommand(); cmd.CommandText = sql;
        foreach (var (key, value) in args) cmd.Parameters.AddWithValue(key, value);
        return cmd;
    }
    private static HarnessProfile Bootstrap(Campaign c) => c.Harness ?? throw HarnessJson.Conflict("harness_campaign_required");
    private static HarnessRevision Initial(Campaign c) => new(1, Bootstrap(c).Hash, Bootstrap(c).Preset.Id, Bootstrap(c).Preset.Version, DateTimeOffset.UnixEpoch);
    private bool Exists(Campaign c)
    {
        if (File.Exists(Database(c))) return true;
        if (c.HarnessWorkspaceInitialized) throw new GameException("workspace_missing", "已启用的工作区丢失；不会退回初始预设。", 409);
        return false;
    }
    private static void ValidateProfile(HarnessProfile p)
    {
        try
        {
            HarnessProfiles.Validate(p.Preset, p.Skills);
            if (p.Hash != HarnessJson.ProfileHash(p.Preset, p.Skills)) throw Corrupt();
        }
        catch (GameException) { throw Corrupt(); }
    }
    private HarnessProfile ReadDocument(Campaign c, string hash) => Guard(() =>
    {
        string path = Document(c, hash);
        if (!File.Exists(path) || new FileInfo(path).Length > 1024 * 1024) throw Corrupt();
        using var json = JsonDocument.Parse(File.ReadAllBytes(path));
        HarnessProfile profile;
        try { profile = HarnessJson.Read<HarnessProfile>(json.RootElement); }
        catch (GameException) { throw Corrupt(); }
        ValidateProfile(profile);
        if (profile.Hash != hash) throw Corrupt();
        return profile;
    });
    private void WriteDocument(Campaign c, HarnessProfile p)
    {
        ValidateProfile(p);
        string path = Document(c, p.Hash);
        if (File.Exists(path)) { ReadDocument(c, p.Hash); return; }
        JsonFiles.Write(path, p); // authenticated per-campaign gate ensures a single writer
    }
    private static State ReadState(SqliteConnection db, Campaign c)
    {
        using var cmd = Command(db, "SELECT version,active,latest,draft,bootstrap FROM state WHERE id=1");
        using var row = cmd.ExecuteReader();
        if (!row.Read()) throw Corrupt();
        var state = new State(row.GetInt32(0), row.GetInt32(1), row.GetInt32(2), row.GetString(3), row.GetString(4));
        if (state.Version < 1 || state.Active < 1 || state.Latest < state.Active || state.Bootstrap != Bootstrap(c).Hash) throw Corrupt();
        return state;
    }
    private static HarnessRevision ReadRevision(SqliteConnection db, int revision)
    {
        using var cmd = Command(db, "SELECT json FROM revisions WHERE revision=$revision", ("$revision", revision));
        string json = cmd.ExecuteScalar() as string ?? throw new GameException("workspace_revision_not_found", "找不到此工作区版本。", 404);
        var value = JsonSerializer.Deserialize<HarnessRevision>(json, HarnessJson.Options) ?? throw Corrupt();
        if (value.Revision != revision || value.Hash is null || value.PresetId is null || value.PresetVersion < 1) throw Corrupt();
        return value;
    }
    private HarnessProfile RevisionProfile(Campaign c, HarnessRevision revision)
    {
        var profile = ReadDocument(c, revision.Hash);
        if (profile.Preset.Id != revision.PresetId || profile.Preset.Version != revision.PresetVersion) throw Corrupt();
        return profile;
    }
    private HarnessWorkspace Snapshot(SqliteConnection db, Campaign c)
    {
        var s = ReadState(db, c);
        HarnessRevision active;
        try { active = ReadRevision(db, s.Active); _ = ReadRevision(db, s.Latest); }
        catch (GameException ex) when (ex.Code == "workspace_revision_not_found") { throw Corrupt(); }
        return new(s.Version, s.Active, s.Latest, ReadDocument(c, s.Draft), RevisionProfile(c, active));
    }
    public HarnessWorkspace Get(Campaign c) => Guard(() =>
    {
        if (!Exists(c)) { ValidateProfile(Bootstrap(c)); return new HarnessWorkspace(1, 1, 1, Bootstrap(c), Bootstrap(c)); }
        using var db = Open(Database(c)); return Snapshot(db, c);
    });
    internal void ValidateGameSave(Campaign c, string database) => Guard(() =>
    {
        if (!File.Exists(database))
        {
            if (c.HarnessWorkspaceInitialized) throw Corrupt();
            return true;
        }
        if (c.Harness is null) throw Corrupt();
        using var db = Open(database); _ = Snapshot(db, c);
        return true;
    });
    public HarnessRevisionContent Revision(Campaign c, int revision) => Guard(() =>
    {
        if (revision < 1) throw new GameException("invalid_input", "版本号必须为正整数。");
        if (!Exists(c)) return revision == 1 ? new(Initial(c), Bootstrap(c)) : throw new GameException("workspace_revision_not_found", "找不到此工作区版本。", 404);
        using var db = Open(Database(c)); _ = ReadState(db, c);
        var r = ReadRevision(db, revision); return new HarnessRevisionContent(r, RevisionProfile(c, r));
    });
    public HarnessRevisionPage Revisions(Campaign c, int? before, int limit) => Guard(() =>
    {
        if (limit is < 1 or > 50 || before is < 1) throw new GameException("invalid_input", "分页范围无效。");
        if (!Exists(c)) return new HarnessRevisionPage(before is null or > 1 ? [Initial(c)] : [], null);
        using var db = Open(Database(c)); _ = ReadState(db, c);
        using var cmd = Command(db, "SELECT revision FROM revisions WHERE revision<$before ORDER BY revision DESC LIMIT $limit",
            ("$before", before ?? int.MaxValue), ("$limit", limit + 1));
        var ids = new List<int>(); using (var rows = cmd.ExecuteReader()) while (rows.Read()) ids.Add(rows.GetInt32(0));
        var result = ids.Take(limit).Select(id => ReadRevision(db, id)).ToArray();
        return new HarnessRevisionPage(result, ids.Count > limit ? result[^1].Revision : null);
    });
    private void Initialize(Campaign c, Action checkpoint)
    {
        if (Exists(c)) return;
        checkpoint(); // persisted campaign tombstone BEFORE any workspace publication
        WriteDocument(c, Bootstrap(c));
        string path = Database(c), temp = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using (var db = Open(temp, create: true))
            {
                using var tx = db.BeginTransaction();
                using var cmd = Command(db, """
                    CREATE TABLE state(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,active INTEGER NOT NULL,latest INTEGER NOT NULL,draft TEXT NOT NULL,bootstrap TEXT NOT NULL);
                    CREATE TABLE revisions(revision INTEGER PRIMARY KEY,hash TEXT NOT NULL UNIQUE,preset_id TEXT NOT NULL,preset_version INTEGER NOT NULL,json TEXT NOT NULL);
                    CREATE INDEX preset_versions ON revisions(preset_id,preset_version);
                    CREATE TABLE receipts(actor TEXT NOT NULL,request TEXT NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(actor,request));
                    INSERT INTO state VALUES(1,1,1,1,$hash,$hash);
                    INSERT INTO revisions VALUES(1,$hash,$id,$version,$json);
                    PRAGMA user_version=1;
                    """, ("$hash", Bootstrap(c).Hash), ("$id", Bootstrap(c).Preset.Id), ("$version", Bootstrap(c).Preset.Version), ("$json", HarnessJson.Serialize(Initial(c))));
                cmd.Transaction = tx; cmd.ExecuteNonQuery(); tx.Commit();
            }
            File.Move(temp, path);
        }
        finally { if (File.Exists(temp)) File.Delete(temp); }
    }
    public HarnessWorkspaceResult Mutate(Campaign c, string operation, string requestId, int expectedVersion, object payload,
        Action checkpoint, HarnessProfile? draft = null, int revision = 0) => Guard(() =>
    {
        if (!Guid.TryParseExact(requestId, "D", out var guid) || expectedVersion < 1) throw new GameException("invalid_input", "需要请求ID与工作区版本。");
        requestId = guid.ToString();
        // Normalize only request identity, not profile text. Equivalent GUID casing must replay.
        var body = HarnessJson.Element(payload); var canonical = System.Text.Json.Nodes.JsonNode.Parse(body.GetRawText())!;
        canonical["requestId"] = requestId;
        string fingerprint = operation + ":" + HarnessJson.Fingerprint(HarnessJson.Element(canonical));
        if (Exists(c))
        {
            using var existing = Open(Database(c)); _ = ReadState(existing, c);
            using var receipt = Command(existing, "SELECT fingerprint FROM receipts WHERE actor=$actor AND request=$request", ("$actor", c.ActingActorId), ("$request", requestId));
            if (receipt.ExecuteScalar() is string old)
            {
                if (old != fingerprint) throw HarnessJson.Conflict("idempotency_conflict");
                return new HarnessWorkspaceResult(Snapshot(existing, c), true);
            }
        }
        if (c.Archived) throw new GameException("archived", "战役已归档。", 409);
        if (Get(c).Version != expectedVersion) throw new GameException("workspace_stale_version", "工作区已更新；请读取当前版本，保留并比较本地草稿。", 409);
        Initialize(c, checkpoint);
        using var db = Open(Database(c));
        var s = ReadState(db, c);
        if (s.Version == int.MaxValue || s.Latest == int.MaxValue) throw Corrupt();
        if (draft is not null) WriteDocument(c, draft);
        if (operation == "activate") _ = RevisionProfile(c, ReadRevision(db, revision));
        using var tx = db.BeginTransaction();
        string draftHash = s.Draft; int active = s.Active, latest = s.Latest;
        if (operation == "draft") draftHash = draft?.Hash ?? throw new InvalidDataException();
        else if (operation == "publish")
        {
            var profile = ReadDocument(c, s.Draft);
            using var check = Command(db, "SELECT revision FROM revisions WHERE hash=$hash", ("$hash", profile.Hash)); check.Transaction = tx;
            if (check.ExecuteScalar() is not null) throw new GameException("workspace_already_published", "此草稿已有不可变版本，可直接选择该版本。", 409);
            check.CommandText = "SELECT json FROM revisions WHERE preset_id=$id AND preset_version=$version ORDER BY revision LIMIT 1";
            check.Parameters.Clear(); check.Parameters.AddWithValue("$id", profile.Preset.Id); check.Parameters.AddWithValue("$version", profile.Preset.Version);
            using (var rows = check.ExecuteReader())
                while (rows.Read())
                {
                    var prior = JsonSerializer.Deserialize<HarnessRevision>(rows.GetString(0), HarnessJson.Options) ?? throw Corrupt();
                    if (RevisionProfile(c, prior).Preset != profile.Preset)
                        throw new GameException("workspace_preset_conflict", "同名预设版本的探索或战斗 system 原文不可更改；请增加预设版本。", 409);
                }
            var next = new HarnessRevision(++latest, profile.Hash, profile.Preset.Id, profile.Preset.Version, DateTimeOffset.UtcNow);
            using var insert = Command(db, "INSERT INTO revisions VALUES($revision,$hash,$id,$version,$json)",
                ("$revision", latest), ("$hash", next.Hash), ("$id", next.PresetId), ("$version", next.PresetVersion), ("$json", HarnessJson.Serialize(next)));
            insert.Transaction = tx; insert.ExecuteNonQuery();
        }
        else if (operation == "activate") active = revision;
        else throw new InvalidDataException();
        using var commit = Command(db, """
            UPDATE state SET version=$version,active=$active,latest=$latest,draft=$draft WHERE id=1;
            INSERT INTO receipts VALUES($actor,$request,$fingerprint);
            """, ("$version", s.Version + 1), ("$active", active), ("$latest", latest), ("$draft", draftHash),
            ("$actor", c.ActingActorId), ("$request", requestId), ("$fingerprint", fingerprint));
        commit.Transaction = tx; commit.ExecuteNonQuery(); tx.Commit();
        return new HarnessWorkspaceResult(Snapshot(db, c), false);
    });
}
