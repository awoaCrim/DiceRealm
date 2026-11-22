using System.Text.Json;
using DiceRealm.Server.Domain;
using Microsoft.Data.Sqlite;

namespace DiceRealm.Server.Infrastructure;

// Authority and its derived inverted index live in the SAME campaign transaction. Reads
// hydrate only selected rows. Pending writes stay in a request-local overlay until Save.
public sealed class SqliteWorldMemory : IWorldMemoryIndex
{
    private readonly SqliteConnection db;
    private readonly int version;
    private readonly Dictionary<string, WorldMemoryEntry> pending = new(StringComparer.Ordinal);
    private readonly Dictionary<string, WorldMemoryEntry?> cache = new(StringComparer.Ordinal);
    private readonly int storedCount;
    public int LoadedEntries { get; private set; }
    public int Count => storedCount + pending.Keys.Count(id => Stored(id) is null);
    private const string Columns = "id,kind,name,summary,status,sceneId,revision,originSequence,updatedSequence,actorId,source,hidden,visibility,revealSceneId,nameKey,summaryKey";
    private static readonly string[] Fields = Columns.Split(',');
    private static readonly string Overlay = "SELECT " + string.Join(',', Fields.Select(f => "json_extract(value,'$." + f + "') AS " + f)) + " FROM json_each($pending)";

    public SqliteWorldMemory(SqliteConnection db, int version)
    {
        this.db = db; this.version = version;
        try
        {
            using var cmd = db.CreateCommand();
            cmd.CommandText = "SELECT COUNT(*) FROM world_entries;";
            storedCount = Convert.ToInt32(cmd.ExecuteScalar());
            if (storedCount > WorldMemories.MaximumEntries) throw WorldMemoryIndex.Invalid();
            cmd.CommandText = "SELECT COUNT(*) FROM sqlite_master WHERE (type='table' AND name='world_terms') OR (type='index' AND name IN ('world_names','world_recent','world_scene_recent','world_terms_entry'));";
            if (Convert.ToInt32(cmd.ExecuteScalar()) != 5) throw WorldMemoryIndex.Invalid();
        }
        catch (SqliteException) { throw WorldMemoryIndex.Invalid(); }
    }
    public static void CreateSchema(SqliteConnection db, SqliteTransaction tx)
    {
        using var cmd = db.CreateCommand(); cmd.Transaction = tx;
        cmd.CommandText = """
            CREATE TABLE world_entries (
                id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, summary TEXT NOT NULL,
                status TEXT NOT NULL, sceneId TEXT NOT NULL, revision INTEGER NOT NULL,
                originSequence INTEGER NOT NULL, updatedSequence INTEGER NOT NULL,
                actorId TEXT NOT NULL, source TEXT NOT NULL, hidden INTEGER NOT NULL,
                visibility TEXT NOT NULL, revealSceneId TEXT NOT NULL,
                nameKey TEXT NOT NULL, summaryKey TEXT NOT NULL);
            CREATE UNIQUE INDEX world_names ON world_entries(kind,nameKey);
            CREATE INDEX world_recent ON world_entries(updatedSequence DESC,id);
            CREATE INDEX world_scene_recent ON world_entries(sceneId,updatedSequence DESC,id);
            CREATE TABLE world_terms (token TEXT NOT NULL, entryId TEXT NOT NULL REFERENCES world_entries(id) ON DELETE CASCADE, PRIMARY KEY(token,entryId)) WITHOUT ROWID;
            CREATE INDEX world_terms_entry ON world_terms(entryId);
            PRAGMA user_version=2;
            """;
        cmd.ExecuteNonQuery();
    }
    public WorldMemoryEntry? Find(string id) => pending.GetValueOrDefault(id) ?? Stored(id);
    private WorldMemoryEntry? Stored(string id)
    {
        if (cache.TryGetValue(id, out var entry)) return entry;
        using var cmd = db.CreateCommand(); cmd.CommandText = "SELECT " + Columns + " FROM world_entries WHERE id=$id";
        cmd.Parameters.AddWithValue("$id", id);
        using var rows = cmd.ExecuteReader(); entry = rows.Read() ? Decode(rows) : null;
        cache.Add(id, entry); return entry;
    }
    public bool NameExists(string kind, string name, string exceptId)
    {
        string key = WorldMemoryIndex.Key(name);
        if (pending.Values.Any(e => e.Id != exceptId && e.Kind == kind && WorldMemoryIndex.Key(e.Name) == key)) return true;
        using var cmd = db.CreateCommand();
        cmd.CommandText = "SELECT id FROM world_entries WHERE kind=$kind AND nameKey=$key AND id<>$except";
        cmd.Parameters.AddWithValue("$kind", kind); cmd.Parameters.AddWithValue("$key", key); cmd.Parameters.AddWithValue("$except", exceptId);
        return cmd.ExecuteScalar() is string id && !pending.ContainsKey(id);
    }
    public void Upsert(WorldMemoryEntry entry)
    {
        WorldMemoryIndex.Validate(entry, version + 1);
        pending[entry.Id] = entry;
    }
    public WorldMemorySlice Read(WorldMemoryQuery q)
    {
        using var cmd = db.CreateCommand();
        // Select one least-common posting among at most 16 deterministic query tokens.
        // Final predicates check EVERY complete word, so token selection only affects cost.
        string? token = RarestToken(q.Words);
        string index = token is null ? "" : " AND id IN (SELECT entryId FROM world_terms WHERE token=$token)";
        if (token is not null) cmd.Parameters.AddWithValue("$token", token);
        string source = pending.Count == 0
            ? "SELECT " + Columns + " FROM world_entries WHERE 1=1" + index
            : "SELECT " + Columns + " FROM world_entries WHERE id NOT IN (SELECT json_extract(value,'$.id') FROM json_each($pending))" + index + " UNION ALL " + Overlay;
        if (pending.Count != 0) cmd.Parameters.AddWithValue("$pending", JsonSerializer.Serialize(pending.Values.Select(Row), JsonFiles.Options));
        var where = new List<string>();
        if (!q.IncludePrivate)
        {
            where.Add("hidden=0 AND (visibility='public' OR (visibility='arrival' AND revealSceneId IN (SELECT value FROM json_each($visited))))");
            cmd.Parameters.AddWithValue("$visited", JsonSerializer.Serialize(q.VisitedScenes));
        }
        if (q.Kind != "") { where.Add("kind=$kind"); cmd.Parameters.AddWithValue("$kind", q.Kind); }
        if (q.Scenes is not null) { where.Add("sceneId IN (SELECT value FROM json_each($scenes))"); cmd.Parameters.AddWithValue("$scenes", JsonSerializer.Serialize(q.Scenes)); }
        for (int i = 0; i < q.Words.Length; i++)
        {
            where.Add($"(instr(nameKey,$word{i})>0 OR instr(summaryKey,$word{i})>0)");
            cmd.Parameters.AddWithValue("$word" + i, WorldMemoryIndex.Key(q.Words[i]));
        }
        string filtered = " FROM (" + source + ") WHERE " + (where.Count == 0 ? "1=1" : string.Join(" AND ", where));
        cmd.CommandText = "SELECT COUNT(*)" + filtered;
        int count = Convert.ToInt32(cmd.ExecuteScalar());
        cmd.CommandText = "SELECT " + Columns + filtered + " ORDER BY (sceneId=$preferred) DESC,updatedSequence DESC,id COLLATE BINARY LIMIT $limit OFFSET $offset";
        cmd.Parameters.AddWithValue("$preferred", q.PreferredScene); cmd.Parameters.AddWithValue("$limit", q.Limit); cmd.Parameters.AddWithValue("$offset", q.Offset);
        using var rows = cmd.ExecuteReader(); var entries = new List<WorldMemoryEntry>();
        while (rows.Read()) entries.Add(Decode(rows, pendingRead: true));
        return new(entries.ToArray(), count, q.Offset + entries.Count < count ? q.Offset + entries.Count : null);
    }
    private string? RarestToken(string[] words)
    {
        var tokens = words.SelectMany(WorldMemoryIndex.Tokens).Distinct(StringComparer.Ordinal).ToArray();
        if (tokens.Length == 0) return null;
        var sample = Enumerable.Range(0, Math.Min(16, tokens.Length)).Select(i => tokens[i * tokens.Length / Math.Min(16, tokens.Length)]).ToArray();
        using var cmd = db.CreateCommand();
        cmd.CommandText = "SELECT value,(SELECT COUNT(*) FROM world_terms WHERE token=value) AS n FROM json_each($tokens) ORDER BY n,value LIMIT 1";
        cmd.Parameters.AddWithValue("$tokens", JsonSerializer.Serialize(sample));
        using var rows = cmd.ExecuteReader(); return rows.Read() ? rows.GetString(0) : null;
    }
    private WorldMemoryEntry Decode(SqliteDataReader rows, bool pendingRead = false)
    {
        try
        {
            var entry = new WorldMemoryEntry(rows.GetString(0), rows.GetString(1), rows.GetString(2), rows.GetString(3), rows.GetString(4), rows.GetString(5),
                rows.GetInt32(6), rows.GetInt32(7), rows.GetInt32(8), rows.GetString(9), rows.GetString(10), rows.GetInt32(11) != 0, rows.GetString(12), rows.GetString(13));
            WorldMemoryIndex.Validate(entry, version + (pendingRead && pending.ContainsKey(entry.Id) ? 1 : 0));
            if (WorldMemoryIndex.Key(entry.Name) != rows.GetString(14) || WorldMemoryIndex.Key(entry.Summary) != rows.GetString(15)) throw WorldMemoryIndex.Invalid();
            LoadedEntries++; return entry;
        }
        catch (Exception ex) when (ex is InvalidCastException or FormatException or OverflowException) { throw WorldMemoryIndex.Invalid(); }
    }
    private static object Row(WorldMemoryEntry e) => new { e.Id, e.Kind, e.Name, e.Summary, e.Status, e.SceneId, e.Revision, e.OriginSequence,
        e.UpdatedSequence, e.ActorId, e.Source, hidden = e.Hidden ? 1 : 0, e.Visibility, e.RevealSceneId,
        nameKey = WorldMemoryIndex.Key(e.Name), summaryKey = WorldMemoryIndex.Key(e.Summary) };
    public void Save(SqliteConnection target, SqliteTransaction tx, int currentVersion) => Write(target, tx, pending.Values, currentVersion);
    public static void Write(SqliteConnection db, SqliteTransaction tx, IEnumerable<WorldMemoryEntry> entries, int version)
    {
        using var row = db.CreateCommand(); row.Transaction = tx;
        row.CommandText = "INSERT INTO world_entries(" + Columns + ") VALUES(" + string.Join(',', Fields.Select(f => "$" + f)) + ") ON CONFLICT(id) DO UPDATE SET " +
            string.Join(',', Fields.Skip(1).Select(f => f + "=excluded." + f));
        foreach (string field in Fields) row.Parameters.Add(new SqliteParameter("$" + field, SqliteType.Text));
        using var clear = db.CreateCommand(); clear.Transaction = tx; clear.CommandText = "DELETE FROM world_terms WHERE entryId=$id"; clear.Parameters.AddWithValue("$id", "");
        using var term = db.CreateCommand(); term.Transaction = tx; term.CommandText = "INSERT INTO world_terms(token,entryId) VALUES($token,$id)";
        term.Parameters.AddWithValue("$token", ""); term.Parameters.AddWithValue("$id", "");
        foreach (var e in entries)
        {
            WorldMemoryIndex.Validate(e, version);
            object[] values = [e.Id, e.Kind, e.Name, e.Summary, e.Status, e.SceneId, e.Revision, e.OriginSequence, e.UpdatedSequence,
                e.ActorId, e.Source, e.Hidden ? 1 : 0, e.Visibility, e.RevealSceneId, WorldMemoryIndex.Key(e.Name), WorldMemoryIndex.Key(e.Summary)];
            for (int i = 0; i < Fields.Length; i++) row.Parameters[i].Value = values[i];
            row.ExecuteNonQuery(); clear.Parameters[0].Value = e.Id; clear.ExecuteNonQuery(); term.Parameters[1].Value = e.Id;
            foreach (string token in WorldMemoryIndex.Tokens(e.Name).Concat(WorldMemoryIndex.Tokens(e.Summary)).Distinct(StringComparer.Ordinal))
            { term.Parameters[0].Value = token; term.ExecuteNonQuery(); }
        }
    }
}
