using System.Net.Http.Headers;
using DiceRealm.Server.Application;

namespace DiceRealm.Server.Infrastructure;

// Operator configuration is snapshotted on startup. Never log or serialize this object.
internal sealed class HarnessProviderSettings(IConfiguration configuration)
{
    public string Model { get; } = configuration["HarnessAi:Model"] ?? "";
    private readonly string key = configuration["HarnessAi:ApiKey"] ?? "";
    private readonly string endpoint = configuration["HarnessAi:Endpoint"] ?? "";
    private readonly string baseUrl = configuration["HarnessAi:BaseUrl"] ?? "";
    public bool Enabled => !string.IsNullOrWhiteSpace(Model) && !string.IsNullOrWhiteSpace(key) && !string.IsNullOrWhiteSpace(endpoint);
    public bool IsGemini => endpoint == "gemini";
    public string ThinkingLevel { get; } = Level(configuration);
    public bool IncludeThoughts { get; } = configuration.GetValue("HarnessAi:IncludeThoughts", true);
    public int RetryCount { get; } = Range(configuration, "RetryCount", 3, 0, 10);
    public int RetryInitialDelayMilliseconds { get; } = Range(configuration, "RetryInitialDelayMilliseconds", 1000, 1, 60000);
    // Each HTTP attempt has its own limit so a silent upstream hang becomes a retryable timeout.
    public TimeSpan AttemptTimeout { get; } = TimeSpan.FromSeconds(Range(configuration, "AttemptTimeoutSeconds", 180, 1, 600));
    public TimeSpan RetryDelay(int retry) => TimeSpan.FromMilliseconds(Math.Min(60000L, (long)RetryInitialDelayMilliseconds << (retry - 1)));
    private static int Range(IConfiguration configuration, string key, int fallback, int minimum, int maximum)
    {
        int value = configuration.GetValue("HarnessAi:" + key, fallback);
        if (value < minimum || value > maximum) throw new InvalidOperationException("HarnessAi:" + key + " is out of range.");
        return value;
    }
    private static string Level(IConfiguration configuration)
    {
        string value = configuration["HarnessAi:ThinkingLevel"] ?? "high";
        if (value is not ("off" or "minimal" or "low" or "medium" or "high"))
            throw new InvalidOperationException("HarnessAi:ThinkingLevel must be off, minimal, low, medium or high.");
        return value;
    }

    public Uri Resolve(string protocol)
    {
        if (!Enabled) throw new HarnessModelNotSentException(HarnessModelRejection.Disabled);
        string address;
        if (baseUrl.Length == 0)
        {
            // Backwards compatibility: the old Endpoint was a complete OpenAI URL.
            if (protocol != "openai-chat" || endpoint is "gemini" or "openai-chat") throw InvalidEndpoint();
            address = endpoint;
        }
        else
        {
            if (endpoint != protocol || endpoint is not ("gemini" or "openai-chat") || !SafeUri(baseUrl, out _)) throw InvalidEndpoint();
            if (IsGemini && (Model.Length > 256 || Model.Length == 0 || !char.IsAsciiLetterOrDigit(Model[0]) ||
                Model.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not ('.' or '_' or '-')))) throw InvalidEndpoint();
            address = baseUrl.TrimEnd('/') + (IsGemini ? "/models/" + Uri.EscapeDataString(Model) + ":generateContent" : "/chat/completions");
        }
        if (!SafeUri(address, out var uri)) throw InvalidEndpoint();
        return uri!;
    }
    public void Authenticate(HttpRequestMessage message)
    {
        // Reject header injection/non-ASCII before Reserve or SendAsync, for both protocols.
        if (key.Length > 8192 || key.Any(c => c <= ' ' || c >= '\u007f'))
            throw new HarnessModelNotSentException(HarnessModelRejection.Credentials);
        try
        {
            if (IsGemini) message.Headers.Add("x-goog-api-key", key);
            else message.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
        }
        catch (Exception ex) when (ex is FormatException or ArgumentException)
        { throw new HarnessModelNotSentException(HarnessModelRejection.Credentials); }
    }
    private static bool SafeUri(string value, out Uri? uri) => Uri.TryCreate(value, UriKind.Absolute, out uri) &&
        uri.UserInfo == "" && uri.Query == "" && uri.Fragment == "" &&
        (uri.Scheme == "https" || uri.Scheme == "http" && uri.IsLoopback);
    private static HarnessModelNotSentException InvalidEndpoint() => new(HarnessModelRejection.Endpoint);
}
