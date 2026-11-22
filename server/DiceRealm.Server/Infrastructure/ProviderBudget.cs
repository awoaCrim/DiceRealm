using DiceRealm.Server.Domain;
using Microsoft.Data.Sqlite;
using System.Text.Json;

namespace DiceRealm.Server.Infrastructure;

public sealed record ProviderUsage(string Kind, string Day, int GlobalToday, int GlobalDailyLimit,
    int CampaignToday, int CampaignDailyLimit, int Total, int TotalLimit, int RemainingToday, bool Enabled, bool Unlimited = false);
public sealed record ProviderTokenUsage(string Day, long GlobalTodayInput, long GlobalTodayOutput, long CampaignTodayInput,
    long CampaignTodayOutput, long TotalInput, long TotalOutput, long ReportedResponses, long UnreportedResponses,
    string Note = "仅累计已收到的有效响应中供应商实际上报的 Token；不含估算、历史未记录、失败及未收到响应的调用。不是精确费用。");
public sealed class ProviderUsagePersistenceException : Exception
{
    public ProviderUsagePersistenceException() : base("Provider usage persistence failed; do not repeat the provider request.") { }
}
public sealed class ProviderQuotaException(string kind) : Exception(kind + "_quota_exceeded")
{
    public string Kind { get; } = kind;
}

// Reservations are durable BEFORE HTTP. Failed/rejected/timed-out calls remain counted;
// a crash between reserving and sending conservatively consumes one attempt. No refunds,
// token-price guesses, or resets on job retry, campaign creation or provider changes.
public sealed class ProviderBudget
{
    private readonly string path;
    private readonly object gate = new();
    private readonly Dictionary<string, (int Daily, int Campaign, int Total)> limits;
    private readonly TimeProvider clock;
    public ProviderBudget(DataDirectory directory, IConfiguration configuration, TimeProvider? clock = null)
    {
        path = Path.Combine(directory.Root, "provider-usage.sqlite");
        this.clock = clock ?? TimeProvider.System;
        limits = new()
        {
            ["text"] = (Limit(configuration, "TextDaily", -1), Limit(configuration, "TextCampaignDaily", -1), Limit(configuration, "TextTotal", -1)),
            ["image"] = (Limit(configuration, "ImageDaily", -1), Limit(configuration, "ImageCampaignDaily", -1), Limit(configuration, "ImageTotal", -1))
        };
        using var db = Open(); using var cmd = db.CreateCommand();
        cmd.CommandText = "CREATE TABLE IF NOT EXISTS usage (kind TEXT NOT NULL, period TEXT NOT NULL, scope TEXT NOT NULL, count INTEGER NOT NULL CHECK(count>=0), PRIMARY KEY(kind,period,scope));" +
            "CREATE TABLE IF NOT EXISTS token_usage(period TEXT NOT NULL,scope TEXT NOT NULL,input INTEGER NOT NULL,output INTEGER NOT NULL,reported INTEGER NOT NULL,missing INTEGER NOT NULL,PRIMARY KEY(period,scope));";
        cmd.ExecuteNonQuery();
    }
    private static int Limit(IConfiguration c, string key, int fallback)
    {
        int value = c.GetValue("ProviderLimits:" + key, fallback);
        if (value is < -1 or > 1000000) throw new InvalidOperationException("ProviderLimits:" + key + " must be -1 (unlimited) or in 0..1000000 (0 disables calls).");
        return value;
    }
    private SqliteConnection Open()
    {
        var db = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = path, Pooling = false }.ToString());
        db.Open(); using var cmd = db.CreateCommand(); cmd.CommandText = "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;"; cmd.ExecuteNonQuery(); return db;
    }
    private static string Scope(string campaignId) => string.IsNullOrEmpty(campaignId) ? "anonymous" : JsonFiles.CampaignId(campaignId);
    private static int Count(SqliteConnection db, SqliteTransaction? tx, string kind, string period, string scope)
    {
        using var cmd = db.CreateCommand(); cmd.Transaction = tx;
        cmd.CommandText = "SELECT count FROM usage WHERE kind=$kind AND period=$period AND scope=$scope";
        cmd.Parameters.AddWithValue("$kind", kind); cmd.Parameters.AddWithValue("$period", period); cmd.Parameters.AddWithValue("$scope", scope);
        return Convert.ToInt32(cmd.ExecuteScalar() ?? 0);
    }
    public ProviderUsage Read(string kind, string campaignId, bool enabled)
    {
        lock (gate) { using var db = Open(); return Read(db, null, kind, Scope(campaignId), enabled); }
    }
    private ProviderUsage Read(SqliteConnection db, SqliteTransaction? tx, string kind, string scope, bool enabled)
    {
        var cap = limits[kind]; string day = clock.GetUtcNow().ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
        int global = Count(db, tx, kind, day, "all"), campaign = Count(db, tx, kind, day, scope), total = Count(db, tx, kind, "total", "all");
        static int Remaining(int limit, int used) => limit < 0 ? int.MaxValue : Math.Max(0, limit - used);
        bool unlimited = cap.Daily < 0 && cap.Campaign < 0 && cap.Total < 0;
        return new(kind, day, global, cap.Daily, campaign, cap.Campaign, total, cap.Total,
            unlimited ? -1 : Math.Min(Math.Min(Remaining(cap.Daily, global), Remaining(cap.Campaign, campaign)), Remaining(cap.Total, total)), enabled, unlimited);
    }
    public void RecordTextUsage(string campaignId, JsonElement response, bool gemini = false)
    {
        try { RecordTextUsageCore(campaignId, response, gemini); }
        catch (Exception ex) when (ex is SqliteException or IOException or UnauthorizedAccessException or InvalidOperationException)
        { throw new ProviderUsagePersistenceException(); }
    }
    private void RecordTextUsageCore(string campaignId, JsonElement response, bool gemini)
    {
        long? input = null, output = null;
        if (response.ValueKind == JsonValueKind.Object && response.TryGetProperty(gemini ? "usageMetadata" : "usage", out var usage) && usage.ValueKind == JsonValueKind.Object)
        {
            static long? Count(JsonElement value, string name) => value.TryGetProperty(name, out var field) && field.ValueKind == JsonValueKind.Number && field.TryGetInt64(out long count) && count is >= 0 and <= int.MaxValue ? count : null;
            input = Count(usage, gemini ? "promptTokenCount" : "prompt_tokens");
            output = Count(usage, gemini ? "candidatesTokenCount" : "completion_tokens");
            if (gemini && usage.TryGetProperty("thoughtsTokenCount", out _)) output += Count(usage, "thoughtsTokenCount");
        }
        bool reported = input.HasValue && output.HasValue;
        lock (gate)
        {
            using var db = Open(); using var transaction = db.BeginTransaction();
            string day = clock.GetUtcNow().ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture), scope = Scope(campaignId);
            foreach (var (period, owner) in new[] { (day, "all"), (day, scope), ("total", "all") })
            {
                using var command = db.CreateCommand(); command.Transaction = transaction;
                command.CommandText = "INSERT INTO token_usage(period,scope,input,output,reported,missing) VALUES($period,$scope,$input,$output,$reported,$missing) " +
                    "ON CONFLICT(period,scope) DO UPDATE SET input=input+$input,output=output+$output,reported=reported+$reported,missing=missing+$missing";
                command.Parameters.AddWithValue("$period", period); command.Parameters.AddWithValue("$scope", owner);
                command.Parameters.AddWithValue("$input", reported ? input!.Value : 0); command.Parameters.AddWithValue("$output", reported ? output!.Value : 0);
                command.Parameters.AddWithValue("$reported", reported ? 1 : 0); command.Parameters.AddWithValue("$missing", reported ? 0 : 1);
                command.ExecuteNonQuery();
            }
            transaction.Commit();
        }
    }
    public ProviderTokenUsage ReadTokens(string campaignId)
    {
        lock (gate)
        {
            using var db = Open();
            (long Input, long Output, long Reported, long Missing) Read(string period, string scope)
            {
                using var command = db.CreateCommand(); command.CommandText = "SELECT input,output,reported,missing FROM token_usage WHERE period=$period AND scope=$scope";
                command.Parameters.AddWithValue("$period", period); command.Parameters.AddWithValue("$scope", scope);
                using var reader = command.ExecuteReader(); return reader.Read() ? (reader.GetInt64(0), reader.GetInt64(1), reader.GetInt64(2), reader.GetInt64(3)) : (0, 0, 0, 0);
            }
            string day = clock.GetUtcNow().ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
            var today = Read(day, "all"); var campaign = Read(day, Scope(campaignId)); var total = Read("total", "all");
            return new(day, today.Input, today.Output, campaign.Input, campaign.Output, total.Input, total.Output, total.Reported, total.Missing);
        }
    }
    public void Reserve(string kind, string campaignId)
    {
        lock (gate)
        {
            using var db = Open(); using var tx = db.BeginTransaction();
            string scope = Scope(campaignId); var usage = Read(db, tx, kind, scope, true);
            if (usage.RemainingToday == 0) throw new ProviderQuotaException(kind);
            foreach (var (period, owner) in new[] { (usage.Day, "all"), (usage.Day, scope), ("total", "all") })
            {
                using var cmd = db.CreateCommand(); cmd.Transaction = tx;
                cmd.CommandText = "INSERT INTO usage(kind,period,scope,count) VALUES($kind,$period,$scope,1) ON CONFLICT(kind,period,scope) DO UPDATE SET count=count+1";
                cmd.Parameters.AddWithValue("$kind", kind); cmd.Parameters.AddWithValue("$period", period); cmd.Parameters.AddWithValue("$scope", owner); cmd.ExecuteNonQuery();
            }
            tx.Commit();
        }
    }
}
