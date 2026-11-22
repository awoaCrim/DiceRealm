using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using Microsoft.Data.Sqlite;

namespace DiceRealm.Server.Infrastructure;

public sealed partial class CampaignStore
{
    // Only within an authorized campaign gate. This table is derived history, never state
    // or command authority. Whole-database game saves include it without a second store.
    internal HarnessHistorySummary[] ReadHistorySummaries(Campaign c, string scope)
    {
        using var db = Open(c.Id);
        using var cmd = db.CreateCommand();
        cmd.CommandText = "PRAGMA user_version";
        int schema = Convert.ToInt32(cmd.ExecuteScalar());
        if (schema is 1 or 2) return [];
        if (schema != 3) throw new GameException("unsupported_save", "不支持此存储版本。", 409);
        cmd.CommandText = "SELECT json FROM history_summaries WHERE scope=$scope AND (audience='public' OR audience=$actor) ORDER BY publication";
        cmd.Parameters.AddWithValue("$scope", scope);
        cmd.Parameters.AddWithValue("$actor", c.ActingActorId);
        using var rows = cmd.ExecuteReader();
        var summaries = new List<HarnessHistorySummary>();
        while (rows.Read()) summaries.Add(Deserialize<HarnessHistorySummary>(rows.GetString(0)));
        return summaries.ToArray();
    }

    internal HarnessHistorySummary PublishHistorySummary(Campaign c, HarnessHistorySummary candidate,
        HarnessHistorySummaryRange frozen, HarnessHistoryFragment[] currentSources)
    {
        if (candidate.Audience != "public" && candidate.Audience != c.ActingActorId)
            throw new GameException("forbidden", "摘要来源不属于当前知情范围。", 403);
        // The campaign gate excludes concurrent publications and source edits. Validation
        // precedes schema changes; a failed or stale draft leaves originals untouched.
        var published = ReadHistorySummaries(c, candidate.Scope);
        candidate = candidate with { Publication = published.Where(s => s.Audience == candidate.Audience)
            .Select(s => s.Publication).DefaultIfEmpty().Max() + 1 };
        var accepted = HarnessHistorySummaries.PreparePublication(candidate, frozen, currentSources, published);
        using var db = Open(c.Id);
        bool migrate = PrepareHistorySchema(db, c);
        using var tx = db.BeginTransaction();
        if (migrate) CreateHistorySchema(db, tx);
        using var cmd = db.CreateCommand(); cmd.Transaction = tx;
        cmd.CommandText = "INSERT INTO history_summaries(id,scope,audience,publication,json) VALUES($id,$scope,$audience,$publication,$json)";
        cmd.Parameters.AddWithValue("$id", accepted.Id);
        cmd.Parameters.AddWithValue("$scope", accepted.Scope);
        cmd.Parameters.AddWithValue("$audience", accepted.Audience);
        cmd.Parameters.AddWithValue("$publication", accepted.Publication);
        cmd.Parameters.AddWithValue("$json", JsonSerializer.Serialize(accepted, JsonFiles.Options));
        cmd.ExecuteNonQuery();
        tx.Commit();
        return accepted;
    }

    private sealed record HistoryIssued(int SchemaVersion, HarnessHistoryWork[] Work);
    private string HistoryIssuedPath(string campaign) => Path.Combine(directory.Root, "harness-issued", JsonFiles.CampaignId(campaign), "history.json");

    internal HarnessHistoryWork? BeginHistoryWork(Campaign c, string providerIdentity, HarnessHistorySummaryRange range)
    {
        // Like model-slot issued receipts, this metadata is outside game-save replacement.
        // Restoring an older world must never turn an uncertain paid call into a fresh one.
        string issuedPath = HistoryIssuedPath(c.Id);
        var issued = File.Exists(issuedPath) ? JsonFiles.Read<HistoryIssued>(issuedPath) : new(1, []);
        if (issued.SchemaVersion != 1 || issued.Work is null || issued.Work.Any(w => w is null ||
            !Guid.TryParseExact(w.Id, "D", out _) || !AssetCatalog.IsHash(w.ProviderIdentity) || w.Range?.Sources is not { Length: > 0 }))
            throw new InvalidDataException("Invalid history issued receipts.");
        bool Same(HarnessHistoryWork work) => work.ProviderIdentity == providerIdentity && work.Range.Scope == range.Scope &&
            work.Range.Audience == range.Audience && work.Range.Sources.ToHashSet().SetEquals(range.Sources);
        if (issued.Work.Any(Same)) return null;
        using var db = Open(c.Id);
        using var cmd = db.CreateCommand();
        cmd.CommandText = "PRAGMA user_version";
        if (Convert.ToInt32(cmd.ExecuteScalar()) == 3)
        {
            cmd.CommandText = "SELECT json FROM history_work WHERE scope=$scope AND audience=$audience";
            cmd.Parameters.AddWithValue("$scope", range.Scope); cmd.Parameters.AddWithValue("$audience", range.Audience);
            using var rows = cmd.ExecuteReader();
            while (rows.Read())
            {
                var old = Deserialize<HarnessHistoryWork>(rows.GetString(0));
                // No retry of an unknown/failed attempt for the same source set and provider.
                // A newly closed range or explicitly changed helper can start different work.
                if (Same(old))
                {
                    JsonFiles.Write(issuedPath, issued with { Work = [.. issued.Work, old] });
                    return null;
                }
            }
        }
        bool migrate = PrepareHistorySchema(db, c);
        var work = new HarnessHistoryWork(Guid.NewGuid().ToString(), c.TimelineId ?? "", providerIdentity, range, "started");
        JsonFiles.Write(issuedPath, issued with { Work = [.. issued.Work, work] });
        using var tx = db.BeginTransaction();
        if (migrate) CreateHistorySchema(db, tx);
        cmd.Transaction = tx; cmd.Parameters.Clear();
        cmd.CommandText = "INSERT INTO history_work(id,scope,audience,json) VALUES($id,$scope,$audience,$json)";
        cmd.Parameters.AddWithValue("$id", work.Id); cmd.Parameters.AddWithValue("$scope", range.Scope);
        cmd.Parameters.AddWithValue("$audience", range.Audience); cmd.Parameters.AddWithValue("$json", JsonSerializer.Serialize(work, JsonFiles.Options));
        cmd.ExecuteNonQuery(); tx.Commit();
        return work;
    }

    internal void FinishHistoryWork(Campaign c, HarnessHistoryWork work, bool published, string error)
    {
        using var db = Open(c.Id); using var cmd = db.CreateCommand();
        cmd.CommandText = "UPDATE history_work SET json=$json WHERE id=$id";
        cmd.Parameters.AddWithValue("$id", work.Id);
        cmd.Parameters.AddWithValue("$json", JsonSerializer.Serialize(work with { Status = published ? "published" : "failed", Error = error }, JsonFiles.Options));
        if (cmd.ExecuteNonQuery() != 1) throw new InvalidDataException("Missing history work marker.");
    }

    private static bool PrepareHistorySchema(SqliteConnection db, Campaign c)
    {
        using var cmd = db.CreateCommand(); cmd.CommandText = "PRAGMA user_version";
        int schema = Convert.ToInt32(cmd.ExecuteScalar());
        if (schema == 1) { Save(db, c, c.Version, importing: false); schema = 2; }
        if (schema == 3) return false;
        if (schema != 2) throw new GameException("unsupported_save", "不支持此存储版本。", 409);
        string backup = db.DataSource + ".pre-history-v3." + Guid.NewGuid().ToString("N") + ".bak";
        GameSaveCatalog.CopyDatabase(db.DataSource, backup);
        return true;
    }

    private static void CreateHistorySchema(SqliteConnection db, SqliteTransaction tx)
    {
        using var cmd = db.CreateCommand(); cmd.Transaction = tx;
        cmd.CommandText = """
            CREATE TABLE history_summaries (
                id TEXT PRIMARY KEY, scope TEXT NOT NULL, audience TEXT NOT NULL,
                publication INTEGER NOT NULL, json TEXT NOT NULL, UNIQUE(scope,audience,publication));
            CREATE TABLE history_work (id TEXT PRIMARY KEY, scope TEXT NOT NULL, audience TEXT NOT NULL, json TEXT NOT NULL);
            CREATE INDEX history_work_scope ON history_work(scope,audience);
            PRAGMA user_version=3;
            """;
        cmd.ExecuteNonQuery();
    }
}
