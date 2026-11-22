using Microsoft.Data.Sqlite;
using DiceRealm.Server.Application;

namespace DiceRealm.Server.Infrastructure;

// Derived lookup only. Run JSON remains the authority for identity, receipts and progress.
// Populated at startup/write, never by a host's read; deleting this index permits a rebuild.
internal sealed class HarnessRunIndex(string root)
{
    private string Path => System.IO.Path.Combine(root, "harness-history.sqlite");
    private SqliteConnection Open(bool writable)
    {
        var db = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = Path, Pooling = false,
            Mode = writable ? SqliteOpenMode.ReadWriteCreate : SqliteOpenMode.ReadOnly
        }.ToString());
        db.Open(); return db;
    }
    public HashSet<string> Initialize()
    {
        using var db = Open(true); using var create = db.CreateCommand();
        create.CommandText = "CREATE TABLE IF NOT EXISTS runs(campaign TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, run TEXT NOT NULL," +
            " PRIMARY KEY(campaign,actor,action), UNIQUE(campaign,actor,run));";
        create.ExecuteNonQuery();
        using var query = db.CreateCommand(); query.CommandText = "SELECT campaign,actor,run FROM runs";
        using var rows = query.ExecuteReader(); var known = new HashSet<string>(StringComparer.Ordinal);
        while (rows.Read()) known.Add(Key(rows.GetString(0), JsonFiles.Hash(rows.GetString(1)), rows.GetString(2)));
        return known;
    }
    public static string Key(string campaign, string seat, string run) => campaign + "/" + seat + "/" + run;
    public void Add(HarnessRun run) => Add(run.CampaignId, run.ActorId, run.IntentId, run.Id);
    public void Add(string campaign, string actor, string action, string run)
    {
        using var db = Open(true); using var cmd = db.CreateCommand();
        cmd.CommandText = "INSERT OR IGNORE INTO runs(campaign,actor,action,run) VALUES($campaign,$actor,$action,$run)";
        cmd.Parameters.AddWithValue("$campaign", campaign); cmd.Parameters.AddWithValue("$actor", actor);
        cmd.Parameters.AddWithValue("$action", action); cmd.Parameters.AddWithValue("$run", run);
        cmd.ExecuteNonQuery();
        if (Find(campaign, actor, action) != run) throw HarnessJson.Conflict("harness_corrupt_run");
    }
    public void ForgetCampaign(string campaign)
    {
        if (!System.IO.File.Exists(Path)) return;
        using var db = Open(true); using var cmd = db.CreateCommand();
        cmd.CommandText = "DELETE FROM runs WHERE campaign=$campaign";
        cmd.Parameters.AddWithValue("$campaign", campaign); cmd.ExecuteNonQuery();
    }
    public string? Find(string campaign, string actor, string action)
    {
        using var db = Open(false); using var cmd = db.CreateCommand();
        cmd.CommandText = "SELECT run FROM runs WHERE campaign=$campaign AND actor=$actor AND action=$action";
        cmd.Parameters.AddWithValue("$campaign", campaign); cmd.Parameters.AddWithValue("$actor", actor); cmd.Parameters.AddWithValue("$action", action);
        return cmd.ExecuteScalar() as string;
    }
}
