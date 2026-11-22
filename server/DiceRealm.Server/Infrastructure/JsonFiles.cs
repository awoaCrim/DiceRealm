using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Infrastructure;

public static class JsonFiles
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        // Fingerprints and content bindings hash this output; the platform default (CRLF on
        // Windows) would make the same data hash differently per OS. LF matches macOS data.
        NewLine = "\n",
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };
    public static string Hash(string value) => Hash(Encoding.UTF8.GetBytes(value));
    public static string Hash(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));

    public static T Read<T>(string path) => JsonSerializer.Deserialize<T>(File.ReadAllBytes(path), Options)
        ?? throw new InvalidDataException("Empty saved document.");

    public static void Write<T>(string path, T value)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temp = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using (var file = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                JsonSerializer.Serialize(file, value, Options);
                file.Flush(flushToDisk: true);
            }
            // One aggregate file contains state, event and idempotency receipt together.
            File.Move(temp, path, overwrite: true);
        }
        finally
        {
            if (File.Exists(temp)) File.Delete(temp);
        }
    }

    public static void WriteBytes(string path, byte[] bytes)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temp = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using (var file = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            { file.Write(bytes); file.Flush(true); }
            File.Move(temp, path, overwrite: true);
        }
        finally { if (File.Exists(temp)) File.Delete(temp); }
    }

    public static string CampaignId(string id) => Guid.TryParseExact(id, "D", out var guid)
        ? guid.ToString() : throw new GameException("invalid_id", "无效的战役 ID。");
}

public sealed class DataDirectory : IDisposable
{
    public string Root { get; }
    private readonly FileStream lease;
    public DataDirectory(IConfiguration configuration)
    {
        Root = Path.GetFullPath(configuration["DataPath"] ?? "data");
        Directory.CreateDirectory(Root);
        Directory.CreateDirectory(Path.Combine(Root, "campaigns"));
        Directory.CreateDirectory(Path.Combine(Root, "asset-jobs"));
        Directory.CreateDirectory(Path.Combine(Root, "assets"));
        // The prototype deliberately supports one server writer, not unsafe shared-file scale-out.
        lease = new FileStream(Path.Combine(Root, ".writer-lock"), FileMode.OpenOrCreate,
            FileAccess.ReadWrite, FileShare.None);
        try { GameSaveCatalog.Recover(Root); }
        catch { lease.Dispose(); throw; }
    }
    public void Dispose() => lease.Dispose();
}
