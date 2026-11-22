using System.Collections.Concurrent;
using System.Text.Json.Serialization;
using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Infrastructure;

public sealed class PreparationCatalogDocument
{
    [JsonRequired] public int SchemaVersion { get; init; } = 1;
    [JsonRequired] public List<PreparationRecord> Records { get; init; } = [];
}

// A durable preparation record is stored before any external call and replayed byte-for-byte by
// request id. It is a separate owner from the campaign aggregate: preparation never writes state,
// events or receipts of the campaign being prepared.
public sealed record PreparationRecord(string RequestId, string Fingerprint, PreparationResult Result, DateTimeOffset UpdatedAt);

public sealed class PreparationCatalog(DataDirectory directory)
{
    // Bounded per-campaign history. A full catalog refuses new ids instead of dropping results
    // that the host has not reviewed or exported yet.
    public const int MaximumRecords = 128;
    private readonly ConcurrentDictionary<string, SemaphoreSlim> gates = new();

    private string Path(string id) => System.IO.Path.Combine(directory.Root, "preparation", id + ".json");

    public PreparationRecord? Find(string campaignId, string requestId)
    {
        var id = JsonFiles.CampaignId(campaignId);
        var path = Path(id);
        if (!File.Exists(path)) return null;
        // Atomic publish means a reader sees a whole previous or whole next document, never a splice.
        var document = Load(path);
        return document.Records.FirstOrDefault(r => r.RequestId == requestId);
    }

    private static PreparationCatalogDocument Load(string path)
    {
        var document = JsonFiles.Read<PreparationCatalogDocument>(path);
        if (document.SchemaVersion != 1 || document.Records is null || document.Records.Count > MaximumRecords)
            throw new InvalidDataException("Unsupported or damaged preparation catalog; original preserved.");
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var record in document.Records)
        {
            if (record is null || !Guid.TryParseExact(record.RequestId, "D", out _) || !ids.Add(record.RequestId) ||
                record.Fingerprint is not { Length: 64 } || !record.Fingerprint.All(char.IsAsciiHexDigit) ||
                record.Result is not { } result || result.RequestId != record.RequestId ||
                result.Status is not ("ready" or "needs_clarification" or "failed" or "unknown") ||
                result.InputHash is not { Length: 64 } || result.PromptHash is not { Length: 64 } ||
                result.Issues is null || result.Issues.Any(i => i is null) ||
                result.Status == "ready" && (result.Document is null || result.Proposal is null))
                throw new InvalidDataException("Damaged preparation receipt; original preserved.");
        }
        return document;
    }

    // The per-campaign gate is held across the whole operation, including an in-flight external
    // call, so concurrent requests with the same id cannot send twice.
    public async Task<T> Access<T>(string campaignId, Func<PreparationCatalogDocument, Func<Task>, Task<T>> operation, CancellationToken ct)
    {
        var id = JsonFiles.CampaignId(campaignId);
        var gate = gates.GetOrAdd(id, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(ct);
        try
        {
            var path = Path(id);
            var document = File.Exists(path) ? Load(path) : new PreparationCatalogDocument();
            return await operation(document, () =>
            {
                JsonFiles.Write(path, document);
                return Task.CompletedTask;
            });
        }
        finally { gate.Release(); }
    }
}
