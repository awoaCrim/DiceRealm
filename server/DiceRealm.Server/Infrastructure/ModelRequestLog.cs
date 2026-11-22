using System.Diagnostics;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;

namespace DiceRealm.Server.Infrastructure;

public sealed record ModelRequestSummary(long Id, DateTimeOffset StartedAt, string Client, string CampaignId, string RunId, string Input,
    int Attempt, string Method, string Url, int? Status, string Error, long? DurationMs, long RequestBytes, long? ResponseBytes, bool Finished);
public sealed record ModelRequestDetail(ModelRequestSummary Summary, string RequestBody, string ResponseBody);
public sealed record ModelRequestPage(ModelRequestSummary[] Requests, long? NextBefore);

// What the current model call belongs to. Set by the harness before Complete and per attempt;
// other callers leave it empty and the entry only names its HTTP client.
public sealed record ModelRequestScope(string CampaignId, string RunId, string Input, int Attempt = 1)
{
    private static readonly AsyncLocal<ModelRequestScope?> current = new();
    public static ModelRequestScope? Current { get => current.Value; set => current.Value = value; }
}

// Diagnostic copy of every LLM HTTP attempt for the local operator: full request/response bodies,
// never headers or API keys. Only the newest entries are kept. A logging failure never blocks play.
public sealed partial class ModelRequestLog
{
    public const int Retained = 300;
    private readonly string path;
    private readonly object gate = new();

    public ModelRequestLog(DataDirectory directory)
    {
        path = Path.Combine(directory.Root, "model-requests.sqlite");
        using var db = Open(); using var cmd = db.CreateCommand();
        cmd.CommandText = "CREATE TABLE IF NOT EXISTS requests(id INTEGER PRIMARY KEY AUTOINCREMENT, startedAt TEXT NOT NULL, client TEXT NOT NULL," +
            " campaignId TEXT NOT NULL, runId TEXT NOT NULL, input TEXT NOT NULL, attempt INTEGER NOT NULL, method TEXT NOT NULL, url TEXT NOT NULL," +
            " status INTEGER, error TEXT NOT NULL, durationMs INTEGER, requestBytes INTEGER NOT NULL, responseBytes INTEGER, finished INTEGER NOT NULL," +
            " requestBody TEXT NOT NULL, responseBody TEXT NOT NULL);" +
            "CREATE INDEX IF NOT EXISTS requests_campaign ON requests(campaignId, id);";
        cmd.ExecuteNonQuery();
    }
    private SqliteConnection Open()
    {
        var db = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = path, Pooling = false }.ToString());
        db.Open(); return db;
    }

    public long Start(string client, ModelRequestScope? scope, string method, string url, string body)
    {
        lock (gate)
        {
            using var db = Open(); using var cmd = db.CreateCommand();
            cmd.CommandText = "INSERT INTO requests(startedAt,client,campaignId,runId,input,attempt,method,url,status,error,durationMs,requestBytes,responseBytes,finished,requestBody,responseBody)" +
                " VALUES($at,$client,$campaign,$run,$input,$attempt,$method,$url,NULL,'',NULL,$bytes,NULL,0,$body,'') RETURNING id";
            cmd.Parameters.AddWithValue("$at", DateTimeOffset.UtcNow.ToString("O"));
            cmd.Parameters.AddWithValue("$client", client);
            cmd.Parameters.AddWithValue("$campaign", scope?.CampaignId ?? "");
            cmd.Parameters.AddWithValue("$run", scope?.RunId ?? "");
            cmd.Parameters.AddWithValue("$input", scope?.Input ?? "");
            cmd.Parameters.AddWithValue("$attempt", scope?.Attempt ?? 1);
            cmd.Parameters.AddWithValue("$method", method);
            cmd.Parameters.AddWithValue("$url", MaskUrl(url));
            cmd.Parameters.AddWithValue("$bytes", System.Text.Encoding.UTF8.GetByteCount(body));
            cmd.Parameters.AddWithValue("$body", body);
            long id = Convert.ToInt64(cmd.ExecuteScalar());
            using var prune = db.CreateCommand();
            prune.CommandText = "DELETE FROM requests WHERE id <= $id - $retained";
            prune.Parameters.AddWithValue("$id", id); prune.Parameters.AddWithValue("$retained", Retained);
            prune.ExecuteNonQuery();
            return id;
        }
    }
    public void Finish(long id, int? status, string error, long durationMs, string responseBody)
    {
        lock (gate)
        {
            using var db = Open(); using var cmd = db.CreateCommand();
            cmd.CommandText = "UPDATE requests SET status=$status, error=$error, durationMs=$duration, responseBytes=$bytes, responseBody=$body, finished=1 WHERE id=$id";
            cmd.Parameters.AddWithValue("$id", id);
            cmd.Parameters.AddWithValue("$status", status is null ? DBNull.Value : status.Value);
            cmd.Parameters.AddWithValue("$error", error);
            cmd.Parameters.AddWithValue("$duration", durationMs);
            cmd.Parameters.AddWithValue("$bytes", System.Text.Encoding.UTF8.GetByteCount(responseBody));
            cmd.Parameters.AddWithValue("$body", responseBody);
            cmd.ExecuteNonQuery();
        }
    }

    public ModelRequestPage List(string? campaignId, long? before, int limit, bool failedOnly, string? runId = null, bool unresolvedOnly = false)
    {
        limit = Math.Clamp(limit, 1, 100);
        lock (gate)
        {
            using var db = Open(); using var cmd = db.CreateCommand();
            cmd.CommandText = "SELECT " + Columns + " FROM requests r WHERE ($campaign IS NULL OR campaignId=$campaign) AND ($before IS NULL OR id<$before)" +
                " AND ($run IS NULL OR runId=$run) AND ($failed=0 OR (finished=1 AND (status IS NULL OR status<200 OR status>=300)))" +
                // A run contains many different model slots. Only a later retry of the exact
                // same wire request may clear this alert; an unrelated HTTP 200 is not recovery.
                " AND ($unresolved=0 OR NOT (r.finished=1 AND r.runId<>'' AND r.requestBody<>''" +
                " AND (r.status IS NULL OR r.status IN (408,429) OR r.status BETWEEN 500 AND 599)" +
                " AND EXISTS (SELECT 1 FROM requests s WHERE s.campaignId=r.campaignId AND s.runId=r.runId AND s.client=r.client" +
                " AND s.method=r.method AND s.url=r.url AND s.requestBody=r.requestBody AND s.id>r.id AND s.attempt>r.attempt" +
                " AND s.finished=1 AND s.status BETWEEN 200 AND 299" +
                " AND NOT EXISTS (SELECT 1 FROM requests reset WHERE reset.campaignId=r.campaignId AND reset.runId=r.runId" +
                " AND reset.client=r.client AND reset.id>r.id AND reset.id<s.id AND reset.attempt<=r.attempt))))" +
                " ORDER BY id DESC LIMIT $limit";
            cmd.Parameters.AddWithValue("$campaign", (object?)campaignId ?? DBNull.Value);
            cmd.Parameters.AddWithValue("$before", (object?)before ?? DBNull.Value);
            cmd.Parameters.AddWithValue("$run", (object?)runId ?? DBNull.Value);
            cmd.Parameters.AddWithValue("$failed", failedOnly ? 1 : 0);
            cmd.Parameters.AddWithValue("$unresolved", unresolvedOnly ? 1 : 0);
            cmd.Parameters.AddWithValue("$limit", limit + 1);
            using var rows = cmd.ExecuteReader();
            var result = new List<ModelRequestSummary>();
            while (rows.Read()) result.Add(Summary(rows));
            long? next = result.Count > limit ? result[limit - 1].Id : null;
            return new(result.Take(limit).ToArray(), next);
        }
    }
    public ModelRequestDetail? Get(long id, string? campaignId)
    {
        lock (gate)
        {
            using var db = Open(); using var cmd = db.CreateCommand();
            cmd.CommandText = "SELECT " + Columns + ", requestBody, responseBody FROM requests WHERE id=$id AND ($campaign IS NULL OR campaignId=$campaign)";
            cmd.Parameters.AddWithValue("$id", id);
            cmd.Parameters.AddWithValue("$campaign", (object?)campaignId ?? DBNull.Value);
            using var rows = cmd.ExecuteReader();
            return rows.Read() ? new(Summary(rows), rows.GetString(15), rows.GetString(16)) : null;
        }
    }

    private const string Columns = "id,startedAt,client,campaignId,runId,input,attempt,method,url,status,error,durationMs,requestBytes,responseBytes,finished";
    private static ModelRequestSummary Summary(SqliteDataReader r) => new(r.GetInt64(0), DateTimeOffset.Parse(r.GetString(1)), r.GetString(2),
        r.GetString(3), r.GetString(4), r.GetString(5), r.GetInt32(6), r.GetString(7), r.GetString(8),
        r.IsDBNull(9) ? null : r.GetInt32(9), r.GetString(10), r.IsDBNull(11) ? null : r.GetInt64(11), r.GetInt64(12),
        r.IsDBNull(13) ? null : r.GetInt64(13), r.GetInt64(14) == 1);

    [GeneratedRegex("([?&](?:key|api_key|apikey|access_token)=)[^&]*", RegexOptions.IgnoreCase)]
    private static partial Regex SecretQuery();
    public static string MaskUrl(string url) => SecretQuery().Replace(url, "$1***");
}

public sealed class ModelRequestLogHandler(ModelRequestLog log, string client, ILogger<ModelRequestLogHandler>? logger = null) : DelegatingHandler
{
    private const long MaximumResponseBytes = 8 * 1024 * 1024;
    internal static readonly HttpRequestOptionsKey<string> Operation = new("DiceRealm.ModelOperation");

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        string body = request.Content is null ? "" : await request.Content.ReadAsStringAsync(ct);
        long? id = null;
        var scope = ModelRequestScope.Current;
        string loggedClient = client;
        if (request.Options.TryGetValue(Operation, out var operation) && operation is "model-metadata" or "input-token-count" or "history-summary")
        {
            loggedClient += ":" + operation;
            if (scope is not null && operation != "history-summary") scope = scope with { Attempt = 0 };
        }
        try { id = log.Start(loggedClient, scope, request.Method.Method, request.RequestUri?.ToString() ?? "", body); }
        catch (Exception ex) when (ex is SqliteException or IOException) { logger?.LogWarning("Model request log write failed: {Error}", ex.GetType().Name); }
        var watch = Stopwatch.StartNew();
        try
        {
            var response = await base.SendAsync(request, ct);
            // Buffer once so the log and the original caller read the same bytes.
            await response.Content.LoadIntoBufferAsync(MaximumResponseBytes, ct);
            Record(id, (int)response.StatusCode, response.IsSuccessStatusCode ? "" : "HTTP " + (int)response.StatusCode, watch, await response.Content.ReadAsStringAsync(ct));
            return response;
        }
        catch (Exception ex)
        {
            string error = ex is OperationCanceledException ? "请求被取消（单次超时或本轮结束）" : ex.GetType().Name + ": " + ModelRequestLog.MaskUrl(ex.Message);
            Record(id, null, error, watch, "");
            throw;
        }
    }
    private void Record(long? id, int? status, string error, Stopwatch watch, string response)
    {
        if (id is null) return;
        try { log.Finish(id.Value, status, error, watch.ElapsedMilliseconds, response); }
        catch (Exception ex) when (ex is SqliteException or IOException) { logger?.LogWarning("Model request log write failed: {Error}", ex.GetType().Name); }
    }
}
