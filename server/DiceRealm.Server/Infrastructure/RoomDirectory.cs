using System.Security.Cryptography;
using Microsoft.Data.Sqlite;

namespace DiceRealm.Server.Infrastructure;

// A reservation is only an index, never permission. Campaign.Room is the authority.
// A failed outer campaign commit retains its reservation for the next explicit host command.
internal sealed class RoomDirectory(DataDirectory directory)
{
    private readonly object gate = new();
    private string PathName => Path.Combine(directory.Root, "rooms.sqlite");
    private static SqliteConnection Open(string path, bool readOnly = false)
    {
        var db = new SqliteConnection(new SqliteConnectionStringBuilder
        { DataSource = path, Pooling = false, Mode = readOnly ? SqliteOpenMode.ReadOnly : SqliteOpenMode.ReadWriteCreate }.ToString());
        db.Open();
        return db;
    }
    private static void CheckSchema(SqliteConnection db)
    {
        using var cmd = db.CreateCommand(); cmd.CommandText = "PRAGMA user_version";
        if (Convert.ToInt32(cmd.ExecuteScalar()) != 1) throw new InvalidDataException("Unsupported room directory.");
    }
    internal string? Find(string number)
    {
        lock (gate)
        {
            if (!File.Exists(PathName)) return null;
            using var db = Open(PathName, true); CheckSchema(db);
            using var cmd = db.CreateCommand(); cmd.CommandText = "SELECT campaign FROM rooms WHERE number=$number";
            cmd.Parameters.AddWithValue("$number", number);
            return cmd.ExecuteScalar() as string;
        }
    }
    internal string Reserve(string campaign)
    {
        JsonFiles.CampaignId(campaign);
        lock (gate)
        {
            if (!File.Exists(PathName))
            {
                string temp = PathName + "." + Guid.NewGuid().ToString("N") + ".tmp";
                try
                {
                    using (var fresh = Open(temp))
                    {
                        using var schema = fresh.CreateCommand();
                        schema.CommandText = "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE rooms(number TEXT PRIMARY KEY, campaign TEXT UNIQUE NOT NULL); PRAGMA user_version=1;";
                        schema.ExecuteNonQuery();
                    }
                    File.Move(temp, PathName);
                }
                finally { if (File.Exists(temp)) File.Delete(temp); }
            }
            using var db = Open(PathName); CheckSchema(db);
            using var cmd = db.CreateCommand();
            cmd.CommandText = "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;"; cmd.ExecuteNonQuery();
            cmd.CommandText = "SELECT number FROM rooms WHERE campaign=$campaign"; cmd.Parameters.AddWithValue("$campaign", campaign);
            if (cmd.ExecuteScalar() is string reserved) return reserved;
            for (int attempt = 0; attempt < 64; attempt++)
            {
                string number = RandomNumberGenerator.GetInt32(10_000_000, 100_000_000).ToString(System.Globalization.CultureInfo.InvariantCulture);
                cmd.CommandText = "INSERT OR IGNORE INTO rooms(number,campaign) VALUES($number,$campaign)";
                cmd.Parameters.Clear(); cmd.Parameters.AddWithValue("$number", number); cmd.Parameters.AddWithValue("$campaign", campaign);
                if (cmd.ExecuteNonQuery() == 1) return number;
            }
            throw new IOException("Room number reservation unavailable.");
        }
    }
}
