using System.Text.Json;
using System.Text.Json.Serialization;
using DiceRealm.Server.Domain;
using Microsoft.Data.Sqlite;

namespace DiceRealm.Server.Infrastructure;

internal sealed record SavedGameSlot(GameSaveView View, string PayloadId);
internal sealed record GameControlReceipt(string RequestId, string Fingerprint, string? SaveId);
internal sealed class GameSaveIndex
{
    [JsonRequired] public int SchemaVersion { get; init; } = 1;
    [JsonRequired] public List<SavedGameSlot> Entries { get; init; } = [];
    [JsonRequired] public List<GameControlReceipt> Receipts { get; init; } = [];
}
internal sealed record GameSaveManifest(int SchemaVersion, string CampaignId, string[] Files);
internal sealed record GameRestoreJournal(int SchemaVersion, string CampaignId, string BeforeId, string AfterId,
    string RequestId, string Fingerprint);

// A room-local control plane. Immutable payloads contain only this campaign's mutable
// game stores. Accounts, room directory, provider configuration, budgets, issued model
// slots and shared immutable images/documents are deliberately outside every payload.
internal sealed class GameSaveCatalog(DataDirectory directory)
{
    private string Root(string campaign) => Folder(directory.Root, campaign);
    private static string Folder(string root, string campaign) => Path.Combine(root, "game-saves", JsonFiles.CampaignId(campaign));
    private string IndexPath(string campaign) => Path.Combine(Root(campaign), "index.json");
    private static string JournalPath(string root, string campaign) => Path.Combine(Folder(root, campaign), "restore.json");
    internal string Payload(string campaign, string id) => Payload(directory.Root, campaign, id);
    private static string Payload(string root, string campaign, string id) => Path.Combine(Folder(root, campaign), "payloads", JsonFiles.CampaignId(id));
    internal static GameException Corrupt() => new("game_save_corrupt", "存档记录缺失或损坏；原文件与当前游戏保留，请检查恢复点。", 409);
    internal GameSaveIndex Read(string campaign)
    {
        string path = IndexPath(campaign);
        if (!File.Exists(path)) return new();
        return ReadIndex(path);
    }
    private static T ReadSaved<T>(string path)
    {
        try { return JsonFiles.Read<T>(path); }
        catch (Exception error) when (error is JsonException or InvalidDataException or FileNotFoundException or DirectoryNotFoundException)
        { throw Corrupt(); }
    }
    private static GameSaveIndex ReadIndex(string path)
    {
        var index = ReadSaved<GameSaveIndex>(path);
        if (index.SchemaVersion != 1 || index.Entries is null || index.Receipts is null ||
            index.Entries.Any(s => s is null || s.View is null || !Uuid(s.View.Id) || !Uuid(s.PayloadId) || s.View.Revision < 1 ||
                string.IsNullOrWhiteSpace(s.View.Name) || s.View.Name.Length > 80 || s.View.Kind is not ("manual" or "recovery") ||
                s.View.Version < 1 || s.View.Party is null) ||
            index.Entries.Select(s => s.View.Id).Distinct().Count() != index.Entries.Count ||
            index.Receipts.Any(r => r is null || !Uuid(r.RequestId) || !AssetCatalog.IsHash(r.Fingerprint) || r.SaveId is not null && !Uuid(r.SaveId)) ||
            index.Receipts.Select(r => r.RequestId).Distinct().Count() != index.Receipts.Count) throw Corrupt();
        return index;
    }
    private static bool Uuid(string? id) => Guid.TryParseExact(id, "D", out var parsed) && parsed != Guid.Empty && parsed.ToString() == id;
    internal void Commit(string campaign, GameSaveIndex index) => JsonFiles.Write(IndexPath(campaign), index);
    internal static GameControlReceipt? Receipt(GameSaveIndex index, string requestId, string fingerprint)
    {
        var receipt = index.Receipts.FirstOrDefault(r => r.RequestId == requestId);
        if (receipt is not null && receipt.Fingerprint != fingerprint)
            throw new GameException("idempotency_conflict", "请求 ID 已用于另一项存档操作。", 409);
        return receipt;
    }
    internal static SavedGameSlot RequireSlot(GameSaveIndex index, string id, int revision)
    {
        var slot = index.Entries.FirstOrDefault(s => s.View.Id == id) ??
            throw new GameException("game_save_not_found", "找不到此存档，请刷新存档列表。", 404);
        if (slot.View.Revision != revision) throw new GameException("game_save_changed", "此档位已被覆盖，请刷新后重新选择。", 409);
        return slot;
    }

    // No arbitrary directory recursion: these are the complete mutable per-room stores.
    // Workspace documents/reference PNGs and map/portrait images are append-only and stay
    // addressable in their original stores. Portrait jobs are shared by build identity;
    // rewinding that shared catalog would affect other rooms and could resend a billed job.
    internal string Capture(Campaign c, CampaignStore store)
    {
        string id = Guid.NewGuid().ToString(), target = Payload(c.Id, id);
        Directory.CreateDirectory(target);
        store.CaptureGame(c, Path.Combine(target, "campaign.sqlite"));
        CopyTree(Path.Combine(directory.Root, "maps", c.Id), Path.Combine(target, "maps"));
        CopyTree(Path.Combine(directory.Root, "harness", c.Id), Path.Combine(target, "harness"));
        CopyTree(Path.Combine(directory.Root, "references", c.Id), Path.Combine(target, "references"));
        string workspace = Path.Combine(directory.Root, "workspaces", c.Id, "workspace.sqlite");
        if (File.Exists(workspace)) CopyDatabase(workspace, Path.Combine(target, "workspace.sqlite"));
        Seal(c.Id, target);
        return id;
    }
    internal string Clone(string campaign, string payloadId)
    {
        string source = Payload(campaign, payloadId);
        var manifest = ReadManifest(source, campaign);
        string id = Guid.NewGuid().ToString(), target = Payload(campaign, id);
        foreach (string file in manifest.Files)
        {
            string destination = Path.Combine(target, file);
            if (file.EndsWith(".sqlite", StringComparison.Ordinal)) CopyDatabase(Path.Combine(source, file), destination);
            else JsonFiles.WriteBytes(destination, File.ReadAllBytes(Path.Combine(source, file)));
        }
        return id; // caller prepares the clone, validates it, then seals it
    }
    internal static void Seal(string campaign, string folder)
    {
        var files = Directory.EnumerateFiles(folder, "*", SearchOption.AllDirectories)
            .Where(f => Path.GetFileName(f) != "manifest.json")
            .Select(f => Path.GetRelativePath(folder, f).Replace('\\', '/')).Order(StringComparer.Ordinal).ToArray();
        if (!files.Contains("campaign.sqlite") || files.Any(f => !ValidFile(f))) throw Corrupt();
        JsonFiles.Write(Path.Combine(folder, "manifest.json"), new GameSaveManifest(1, campaign, files));
    }
    private static GameSaveManifest ReadManifest(string folder, string campaign)
    {
        var manifest = ReadSaved<GameSaveManifest>(Path.Combine(folder, "manifest.json"));
        if (manifest.SchemaVersion != 1 || manifest.CampaignId != campaign || manifest.Files is null ||
            !manifest.Files.Contains("campaign.sqlite") || manifest.Files.Distinct().Count() != manifest.Files.Length ||
            manifest.Files.Any(f => !ValidFile(f) || !File.Exists(Path.Combine(folder, f)))) throw Corrupt();
        return manifest;
    }
    private static bool ValidFile(string file)
    {
        if (string.IsNullOrEmpty(file)) return false;
        if (file is "campaign.sqlite" or "workspace.sqlite") return true;
        var parts = file.Split('/');
        if (parts.Any(p => p is "" or "." or ".." || p.Contains('\\') || p.Contains(':'))) return false;
        if (parts.Length == 2 && parts[0] is "maps" or "references")
            return parts[1].EndsWith(".json", StringComparison.Ordinal) && (parts[0] == "maps" ? Uuid(parts[1][..^5]) : AssetCatalog.IsHash(parts[1][..^5]));
        if (parts.Length is 3 or 5 && parts[0] == "harness" && AssetCatalog.IsHash(parts[1]) && parts[^1].EndsWith(".json", StringComparison.Ordinal))
        {
            string run = parts[^1][..^5];
            return Uuid(run) && (parts.Length == 3 || parts[2] == "closed" && parts[3] == run[..2]);
        }
        return false;
    }
    private static void CopyTree(string source, string destination)
    {
        if (!Directory.Exists(source)) return;
        foreach (string file in Directory.EnumerateFiles(source, "*.json", SearchOption.AllDirectories))
            JsonFiles.WriteBytes(Path.Combine(destination, Path.GetRelativePath(source, file)), File.ReadAllBytes(file));
    }
    internal static void CopyDatabase(string source, string destination)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
        using var from = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = source, Mode = SqliteOpenMode.ReadOnly, Pooling = false }.ToString());
        using var to = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = destination, Pooling = false }.ToString());
        from.Open(); to.Open();
        using var sync = to.CreateCommand(); sync.CommandText = "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;"; sync.ExecuteNonQuery();
        from.BackupDatabase(to);
    }

    // The recovery entry is published before replacement. The independent receipt is the
    // commit marker. On a crash, no marker means roll back; a marker means finish the same
    // replacement. Never reopen workers on a partially replaced game.
    internal void Restore(Campaign c, string before, string after, GameSaveIndex index, GameControlReceipt receipt, Action reindex)
    {
        string path = JournalPath(directory.Root, c.Id);
        var journal = new GameRestoreJournal(1, c.Id, before, after, receipt.RequestId, receipt.Fingerprint);
        ReadManifest(Payload(c.Id, before), c.Id); ReadManifest(Payload(c.Id, after), c.Id);
        JsonFiles.Write(path, journal);
        try
        {
            Apply(directory.Root, c.Id, after);
            reindex();
            index.Receipts.Add(receipt);
            Commit(c.Id, index);
            File.Delete(path);
        }
        catch
        {
            // A failure after atomic receipt publication is still an accepted operation.
            // Leave the journal for startup/retry instead of lying about a rollback.
            var committed = Receipt(Read(c.Id), receipt.RequestId, receipt.Fingerprint);
            if (committed is null)
            {
                Apply(directory.Root, c.Id, before);
                reindex();
                File.Delete(path);
            }
            throw;
        }
    }
    private static void Apply(string root, string campaign, string payloadId)
    {
        string source = Payload(root, campaign, payloadId);
        var manifest = ReadManifest(source, campaign);
        CopyDatabase(Path.Combine(source, "campaign.sqlite"), Path.Combine(root, "campaigns", campaign + ".sqlite"));
        ReplaceTree("maps", Path.Combine(root, "maps", campaign));
        ReplaceTree("harness", Path.Combine(root, "harness", campaign));
        ReplaceTree("references", Path.Combine(root, "references", campaign));
        string workspace = Path.Combine(root, "workspaces", campaign, "workspace.sqlite");
        if (manifest.Files.Contains("workspace.sqlite")) CopyDatabase(Path.Combine(source, "workspace.sqlite"), workspace);
        else if (File.Exists(workspace)) File.Delete(workspace);
        new HarnessRunIndex(root).ForgetCampaign(campaign);

        void ReplaceTree(string prefix, string destination)
        {
            var selected = manifest.Files.Where(f => f.StartsWith(prefix + "/", StringComparison.Ordinal)).ToArray();
            var names = selected.Select(f => f[(prefix.Length + 1)..]).ToHashSet(StringComparer.Ordinal);
            // All superseded bytes remain in the durable pre-replacement recovery payload.
            if (Directory.Exists(destination))
                foreach (string file in Directory.EnumerateFiles(destination, "*.json", SearchOption.AllDirectories))
                    if (!names.Contains(Path.GetRelativePath(destination, file).Replace('\\', '/'))) File.Delete(file);
            foreach (string file in selected)
                JsonFiles.WriteBytes(Path.Combine(destination, file[(prefix.Length + 1)..]), File.ReadAllBytes(Path.Combine(source, file)));
        }
    }
    internal static bool IsRestoring(string root, string campaign) => File.Exists(JournalPath(root, campaign));
    internal static void RequireRecovered(string root, string campaign)
    {
        string path = JournalPath(root, campaign);
        if (!File.Exists(path)) return;
        var journal = ReadJournal(path, campaign);
        var index = ReadIndex(Path.Combine(Folder(root, campaign), "index.json"));
        if (Receipt(index, journal.RequestId, journal.Fingerprint) is not null) { File.Delete(path); return; }
        throw new GameException("game_restore_incomplete", "进度恢复尚未完成，当前游戏已暂停写入。请重新启动服务完成恢复；恢复点仍保留。", 409);
    }
    private static GameRestoreJournal ReadJournal(string path, string campaign)
    {
        var journal = ReadSaved<GameRestoreJournal>(path);
        if (journal.SchemaVersion != 1 || journal.CampaignId != campaign || !Uuid(journal.BeforeId) || !Uuid(journal.AfterId) ||
            !Uuid(journal.RequestId) || !AssetCatalog.IsHash(journal.Fingerprint)) throw Corrupt();
        return journal;
    }
    internal static void Recover(string root)
    {
        string folder = Path.Combine(root, "game-saves");
        if (!Directory.Exists(folder)) return;
        foreach (string campaignFolder in Directory.EnumerateDirectories(folder))
        {
            string campaign = JsonFiles.CampaignId(Path.GetFileName(campaignFolder));
            string path = JournalPath(root, campaign);
            if (!File.Exists(path)) continue;
            var journal = ReadJournal(path, campaign);
            var index = ReadIndex(Path.Combine(campaignFolder, "index.json"));
            var receipt = Receipt(index, journal.RequestId, journal.Fingerprint);
            Apply(root, campaign, receipt is null ? journal.BeforeId : journal.AfterId);
            File.Delete(path);
        }
    }
}
