using System.Net;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;
using System.Text.Json.Serialization;
using DiceRealm.Server.Domain;
using Microsoft.Data.Sqlite;

namespace DiceRealm.Server.Infrastructure;

public sealed record AiProviderEdit(bool Enabled, string Provider, string BaseUrl, string Model, string KeyAction, string ApiKey = "", bool EndpointIsComplete = false);
public sealed record AiImageEdit(bool Enabled, string Endpoint, string EditsEndpoint, string Model, string KeyAction,
    string ApiKey = "", bool AllowReferenceUpload = false, bool SendResponseFormat = true);
public sealed record AiSettingsEdit(string RequestId, long ExpectedVersion, AiProviderEdit Main, AiProviderEdit Helper,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] AiImageEdit? Image = null);
public sealed record AiProviderView(bool Enabled, string Provider, string BaseUrl, string Model, bool HasApiKey, bool EndpointIsComplete = false);
public sealed record AiImageView(bool Enabled, string Endpoint, string EditsEndpoint, string Model, bool HasApiKey,
    bool AllowReferenceUpload, bool SendResponseFormat);
public sealed record AiSettingsView(long Version, AiProviderView Main, AiProviderView Helper,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] AiImageView? Image = null);

// This private object must never be returned, logged, or used as a browser persistence DTO.
internal sealed record AiProviderProfile(bool Enabled, string Provider, string BaseUrl, string Model, string ApiKey, bool EndpointIsComplete = false)
{
    internal AiProviderView View() => new(Enabled, Provider, SafeAddress(BaseUrl) ? BaseUrl : "", Model, ApiKey.Length > 0, EndpointIsComplete);
    internal static bool SafeAddress(string value) => Uri.TryCreate(value, UriKind.Absolute, out var uri) &&
        uri.UserInfo.Length == 0 && uri.Query.Length == 0 && uri.Fragment.Length == 0 &&
        (uri.Scheme == "https" || uri.Scheme == "http" && uri.IsLoopback);
}
internal sealed record AiImageProfile(bool Enabled, string Endpoint, string EditsEndpoint, string Model, string ApiKey,
    bool AllowReferenceUpload, bool SendResponseFormat)
{
    internal AiImageView View() => new(Enabled, AiProviderProfile.SafeAddress(Endpoint) ? Endpoint : "",
        AiProviderProfile.SafeAddress(EditsEndpoint) ? EditsEndpoint : "", Model, ApiKey.Length > 0, AllowReferenceUpload, SendResponseFormat);
    internal string CacheIdentity => OpenAiImages.Identity(Endpoint, EditsEndpoint, Model, SendResponseFormat);
}
internal sealed record AiConfiguration(long Version, AiProviderProfile Main, AiProviderProfile Helper,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] AiImageProfile? Image = null);

// Independent operator settings, not a campaign command or a mutable IConfiguration overlay.
// State and idempotency receipts commit together. Existing receipts are never pruned.
public sealed class AiConfigurationStore
{
    private readonly object gate = new();
    private readonly string path;
    private readonly IConfiguration bootstrap;
    private readonly AiImageProfile initialImage;
    private AiConfiguration current;
    public AiConfigurationStore(DataDirectory directory, IConfiguration configuration)
    {
        bootstrap = configuration;
        initialImage = InitialImage(configuration);
        string root = Path.Combine(directory.Root, "operator");
        Directory.CreateDirectory(root);
        Protect(root);
        path = Path.Combine(root, "ai-settings.sqlite");
        using var db = Open();
        using (var version = db.CreateCommand())
        {
            version.CommandText = "PRAGMA user_version";
            if (Convert.ToInt32(version.ExecuteScalar()) is not (0 or 1)) throw new InvalidDataException("Unsupported operator settings schema.");
        }
        using (var command = db.CreateCommand())
        {
            command.CommandText = "CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL); " +
                "CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,json TEXT NOT NULL); " +
                "CREATE TABLE IF NOT EXISTS probes(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,json TEXT NOT NULL); PRAGMA user_version=1;";
            command.ExecuteNonQuery();
        }
        using var read = db.CreateCommand(); read.CommandText = "SELECT json FROM settings WHERE id=1";
        var saved = read.ExecuteScalar() as string;
        if (saved is null && string.IsNullOrWhiteSpace(bootstrap["TextAi:ApiKey"]) != string.IsNullOrWhiteSpace(bootstrap["TextAi:Model"]))
            throw new InvalidOperationException("TextAi requires both ApiKey and Model; remove both for offline mode.");
        current = saved is null ? new(0, Initial("HarnessAi", true), Initial("TextAi", false)) :
            JsonSerializer.Deserialize<AiConfiguration>(saved, JsonFiles.Options) ?? throw new InvalidDataException("Invalid AI settings.");
        if (current.Version < 0 || saved is not null && current.Version == 0 || current.Main is null || current.Helper is null) throw new InvalidDataException("Invalid AI settings.");
        if (saved is not null)
        {
            try
            {
                foreach (var profile in new[] { current.Main, current.Helper })
                    Validate(new(profile.Enabled, profile.Provider, profile.BaseUrl, profile.Model,
                        string.IsNullOrEmpty(profile.ApiKey) ? "clear" : "replace", profile.ApiKey, profile.EndpointIsComplete), profile);
                if (current.Image is { } image)
                    Validate(new AiImageEdit(image.Enabled, image.Endpoint, image.EditsEndpoint, image.Model,
                        string.IsNullOrEmpty(image.ApiKey) ? "clear" : "replace", image.ApiKey, image.AllowReferenceUpload, image.SendResponseFormat), image);
            }
            catch (GameException) { throw new InvalidDataException("Invalid saved AI settings."); }
        }
    }
    private static void Protect(string root)
    {
        if (OperatingSystem.IsWindows())
        {
            var user = WindowsIdentity.GetCurrent().User ?? throw new InvalidOperationException("Operator storage requires a local identity.");
            var security = new DirectorySecurity();
            security.SetAccessRuleProtection(true, false);
            security.AddAccessRule(new FileSystemAccessRule(user, FileSystemRights.FullControl,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
            new DirectoryInfo(root).SetAccessControl(security);
        }
        else File.SetUnixFileMode(root, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
    }
    private AiProviderProfile Initial(string prefix, bool main)
    {
        string endpoint = bootstrap[prefix + ":Endpoint"] ?? (main ? "" : "https://api.openai.com/v1/chat/completions");
        string provider = endpoint == "gemini" ? "gemini" : "openai-chat";
        string address = bootstrap[prefix + ":BaseUrl"] ?? "";
        bool complete = false;
        if (address.Length == 0 && endpoint.EndsWith("/chat/completions", StringComparison.Ordinal)) address = endpoint[..^17];
        else if (address.Length == 0 && AiProviderProfile.SafeAddress(endpoint)) { address = endpoint; complete = true; }
        string model = bootstrap[prefix + ":Model"] ?? "", key = bootstrap[prefix + ":ApiKey"] ?? "";
        return new(model.Length > 0 && key.Length > 0 && (!main || endpoint.Length > 0), provider, address, model, key, complete);
    }
    private static AiImageProfile InitialImage(IConfiguration configuration)
    {
        string model = configuration["ImageAi:Model"] ?? "", key = configuration["ImageAi:ApiKey"] ?? "";
        return new(!string.IsNullOrWhiteSpace(model) && !string.IsNullOrWhiteSpace(key),
            configuration["ImageAi:Endpoint"] ?? "https://api.openai.com/v1/images/generations",
            configuration["ImageAi:EditsEndpoint"] ?? "", model, key,
            configuration.GetValue<bool>("ImageAi:AllowReferenceUpload"), configuration.GetValue("ImageAi:SendResponseFormat", true));
    }
    private SqliteConnection Open()
    {
        var db = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = path, Pooling = false }.ToString());
        db.Open(); using var command = db.CreateCommand(); command.CommandText = "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;"; command.ExecuteNonQuery(); return db;
    }
    internal AiConfiguration Capture() { lock (gate) return current; }
    public AiSettingsView Read() { lock (gate) return View(current); }
    private AiSettingsView View(AiConfiguration value) => new(value.Version, value.Main.View(), value.Helper.View(), (value.Image ?? initialImage).View());
    internal AiImageProfile CaptureImage() { lock (gate) return current.Image ?? initialImage; }
    internal static IConfiguration ImageConfiguration(AiImageProfile profile) => new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
    {
        ["ImageAi:Endpoint"] = profile.Endpoint,
        ["ImageAi:EditsEndpoint"] = profile.EditsEndpoint,
        ["ImageAi:Model"] = profile.Enabled ? profile.Model : "",
        ["ImageAi:ApiKey"] = profile.Enabled ? profile.ApiKey : "",
        ["ImageAi:AllowReferenceUpload"] = profile.AllowReferenceUpload.ToString(),
        ["ImageAi:SendResponseFormat"] = profile.SendResponseFormat.ToString()
    }).Build();
    internal IConfiguration ProviderConfiguration(AiConfiguration snapshot, bool main)
    {
        var profile = main ? snapshot.Main : snapshot.Helper;
        string prefix = main ? "HarnessAi" : "TextAi";
        // Preserve original complete endpoint compatibility until the first operator save.
        if (snapshot.Version == 0) return new ConfigurationBuilder().AddInMemoryCollection(bootstrap.AsEnumerable()).Build();
        var values = bootstrap.AsEnumerable().ToDictionary(pair => pair.Key, pair => pair.Value);
        values[prefix + ":Endpoint"] = profile.EndpointIsComplete ? profile.BaseUrl : profile.Provider;
        values[prefix + ":BaseUrl"] = profile.EndpointIsComplete ? "" : profile.BaseUrl;
        values[prefix + ":Model"] = profile.Enabled ? profile.Model : "";
        values[prefix + ":ApiKey"] = profile.Enabled ? profile.ApiKey : "";
        return new ConfigurationBuilder().AddInMemoryCollection(values).Build();
    }
    public AiSettingsView Save(AiSettingsEdit request)
    {
        string id = RequestId(request.RequestId);
        string fingerprint = JsonFiles.Hash(JsonSerializer.Serialize(request, JsonFiles.Options));
        lock (gate)
        {
            using var db = Open(); using var transaction = db.BeginTransaction();
            using (var prior = db.CreateCommand())
            {
                prior.Transaction = transaction; prior.CommandText = "SELECT fingerprint,json FROM receipts WHERE id=$id"; prior.Parameters.AddWithValue("$id", id);
                using var reader = prior.ExecuteReader();
                if (reader.Read())
                {
                    if (reader.GetString(0) != fingerprint) throw new GameException("request_conflict", "同一配置请求不能更换内容。", 409);
                    return JsonSerializer.Deserialize<AiSettingsView>(reader.GetString(1), JsonFiles.Options) ?? throw new InvalidDataException("Invalid settings receipt.");
                }
            }
            if (request.ExpectedVersion != current.Version) throw new GameException("ai_settings_stale", "AI 配置已更新，请重新读取后再保存。", 409);
            var next = new AiConfiguration(checked(current.Version + 1), Validate(request.Main, current.Main), Validate(request.Helper, current.Helper),
                request.Image is null ? current.Image : Validate(request.Image, current.Image ?? initialImage));
            var result = View(next);
            using var command = db.CreateCommand(); command.Transaction = transaction;
            command.CommandText = "INSERT INTO settings(id,json) VALUES(1,$state) ON CONFLICT(id) DO UPDATE SET json=$state; INSERT INTO receipts(id,fingerprint,json) VALUES($id,$hash,$result)";
            command.Parameters.AddWithValue("$state", JsonSerializer.Serialize(next, JsonFiles.Options));
            command.Parameters.AddWithValue("$id", id); command.Parameters.AddWithValue("$hash", fingerprint);
            command.Parameters.AddWithValue("$result", JsonSerializer.Serialize(result, JsonFiles.Options));
            command.ExecuteNonQuery(); transaction.Commit(); current = next;
            return result;
        }
    }
    internal (AiConfiguration? Configuration, AiProbeResult Result) BeginProbe(AiProbeRequest request)
    {
        string id = RequestId(request.RequestId), fingerprint = JsonFiles.Hash(JsonSerializer.Serialize(request, JsonFiles.Options));
        if (!request.ConfirmProviderUse || request.Role is not ("main" or "helper"))
            throw new GameException("ai_probe_confirmation", "请明确确认一次可能计费的模型测试。");
        lock (gate)
        {
            using var db = Open(); using var transaction = db.BeginTransaction();
            using (var prior = db.CreateCommand())
            {
                prior.Transaction = transaction; prior.CommandText = "SELECT fingerprint,json FROM probes WHERE id=$id"; prior.Parameters.AddWithValue("$id", id);
                using var reader = prior.ExecuteReader();
                if (reader.Read())
                {
                    if (reader.GetString(0) != fingerprint) throw new GameException("request_conflict", "同一测试请求不能更换内容。", 409);
                    return (null, JsonSerializer.Deserialize<AiProbeResult>(reader.GetString(1), JsonFiles.Options) ?? throw new InvalidDataException("Invalid probe receipt."));
                }
            }
            if (request.ExpectedVersion != current.Version) throw new GameException("ai_settings_stale", "AI 配置已更新，请重新读取后再测试。", 409);
            if (!(request.Role == "main" ? current.Main : current.Helper).Enabled) throw new GameException("ai_provider_disabled", "该模型尚未启用。");
            var result = new AiProbeResult(id, current.Version, request.Role, "unknown", "尚未取得最终测试结果；读取原回执不会再次调用模型。");
            using var command = db.CreateCommand(); command.Transaction = transaction;
            command.CommandText = "INSERT INTO probes(id,fingerprint,json) VALUES($id,$hash,$result)";
            command.Parameters.AddWithValue("$id", id); command.Parameters.AddWithValue("$hash", fingerprint);
            command.Parameters.AddWithValue("$result", JsonSerializer.Serialize(result, JsonFiles.Options));
            command.ExecuteNonQuery(); transaction.Commit();
            return (current, result);
        }
    }
    internal AiProbeResult FinishProbe(AiProbeResult result)
    {
        lock (gate)
        {
            using var db = Open(); using var command = db.CreateCommand();
            command.CommandText = "UPDATE probes SET json=$result WHERE id=$id";
            command.Parameters.AddWithValue("$id", RequestId(result.RequestId)); command.Parameters.AddWithValue("$result", JsonSerializer.Serialize(result, JsonFiles.Options));
            if (command.ExecuteNonQuery() != 1) throw new InvalidDataException("Missing probe receipt.");
            return result;
        }
    }
    public AiProbeResult ReadProbe(string requestId)
    {
        lock (gate)
        {
            using var db = Open(); using var command = db.CreateCommand(); command.CommandText = "SELECT json FROM probes WHERE id=$id";
            command.Parameters.AddWithValue("$id", RequestId(requestId));
            return command.ExecuteScalar() is string json ? JsonSerializer.Deserialize<AiProbeResult>(json, JsonFiles.Options) ?? throw new InvalidDataException("Invalid probe receipt.") :
                throw new GameException("ai_probe_missing", "找不到该测试回执。", 404);
        }
    }
    internal static string RequestId(string id) => Guid.TryParseExact(id, "D", out var value) ? value.ToString() :
        throw new GameException("invalid_request_id", "请求编号必须为 UUID。");
    private static AiImageProfile Validate(AiImageEdit edit, AiImageProfile old)
    {
        if (edit.Endpoint is null || edit.Endpoint.Length > 2048 || edit.EditsEndpoint is null || edit.EditsEndpoint.Length > 2048 ||
            edit.Model is null || edit.Model.Length > 256 || edit.Model.Any(char.IsControl) || edit.ApiKey is null || edit.ApiKey.Length > 8192 ||
            edit.ApiKey.Any(c => c <= ' ' || c >= '\u007f') || edit.KeyAction is not ("keep" or "replace" or "clear") ||
            edit.KeyAction != "replace" && edit.ApiKey.Length > 0 || edit.KeyAction == "replace" && edit.ApiKey.Length == 0)
            throw new GameException("invalid_ai_settings", "图片配置字段或密钥操作无效。");
        string endpoint = edit.Endpoint.Trim(), editsEndpoint = edit.EditsEndpoint.Trim(), model = edit.Model.Trim();
        string key = edit.KeyAction == "keep" ? old.ApiKey : edit.KeyAction == "clear" ? "" : edit.ApiKey;
        if (endpoint.Length > 0 && !AiProviderProfile.SafeAddress(endpoint) || editsEndpoint.Length > 0 && !AiProviderProfile.SafeAddress(editsEndpoint) ||
            edit.Enabled && (endpoint.Length == 0 || model.Length == 0 || key.Length == 0))
            throw new GameException("invalid_ai_settings", "启用图片生成需要完整生成接口、模型与 API Key；接口只允许 HTTPS 或本机 HTTP，不能含凭证、查询或片段。");
        return new(edit.Enabled, endpoint, editsEndpoint, model, key, edit.AllowReferenceUpload, edit.SendResponseFormat);
    }
    private static AiProviderProfile Validate(AiProviderEdit? edit, AiProviderProfile old)
    {
        if (edit is null || edit.Provider is not ("openai-chat" or "gemini") ||
            edit.EndpointIsComplete && edit.Provider != "openai-chat" || edit.BaseUrl is null || edit.BaseUrl.Length > 2048 || edit.Model is null || edit.Model.Length > 256 ||
            edit.Model.Any(char.IsControl) || edit.ApiKey is null || edit.ApiKey.Length > 8192 ||
            edit.ApiKey.Any(c => c <= ' ' || c >= '\u007f') || edit.KeyAction is not ("keep" or "replace" or "clear") ||
            edit.KeyAction != "replace" && edit.ApiKey.Length > 0 || edit.KeyAction == "replace" && edit.ApiKey.Length == 0)
            throw new GameException("invalid_ai_settings", "AI 配置字段、协议或密钥操作无效。");
        string key = edit.KeyAction == "keep" ? old.ApiKey : edit.KeyAction == "clear" ? "" : edit.ApiKey;
        string address = edit.BaseUrl.TrimEnd('/'), model = edit.Model.Trim();
        if ((address.Length > 0 && !AiProviderProfile.SafeAddress(address)) || edit.Enabled && (address.Length == 0 || model.Length == 0 || key.Length == 0))
            throw new GameException("invalid_ai_settings", "启用时需要 Base URL、模型与 API Key；地址只允许 HTTPS 或本机 HTTP，不能含凭证、查询或片段。");
        if (edit.Provider == "gemini" && model.Length > 0 && (!char.IsAsciiLetterOrDigit(model[0]) || model.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not ('.' or '_' or '-'))))
            throw new GameException("invalid_ai_settings", "Gemini 模型标识无效。");
        return new(edit.Enabled, edit.Provider, address, model, key, edit.EndpointIsComplete);
    }
}
