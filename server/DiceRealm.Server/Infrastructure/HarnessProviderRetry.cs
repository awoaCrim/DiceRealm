using System.Net;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Infrastructure;

// Only a live model slot or active historian work retries. Nothing here restarts a run, executes a tool, changes the
// request bytes or resumes an old unknown slot. Every HTTP attempt has a durable reservation.
internal static class HarnessProviderRetry
{
    private sealed class TransientStatus(HttpStatusCode status, TimeSpan? retryAfter)
        : HttpRequestException("Transient provider response.", null, status)
    { public TimeSpan? RetryAfter { get; } = retryAfter; }

    public static void EnsureSuccess(HttpResponseMessage response)
    {
        if (Transient(response.StatusCode))
        {
            var header = response.Headers.RetryAfter;
            TimeSpan? wait = header?.Delta ?? (header?.Date is { } date ? date - DateTimeOffset.UtcNow : null);
            throw new TransientStatus(response.StatusCode, wait);
        }
        response.EnsureSuccessStatusCode();
    }
    private static bool Transient(HttpStatusCode status) => status is HttpStatusCode.RequestTimeout or HttpStatusCode.TooManyRequests || (int)status is >= 500 and <= 599;
    private static bool Retryable(Exception ex, CancellationToken ct) => !ct.IsCancellationRequested && ex switch
    {
        TransientStatus status => status.RetryAfter is null || status.RetryAfter <= TimeSpan.FromSeconds(60),
        HttpRequestException http => http.StatusCode is null || Transient(http.StatusCode.Value),
        IOException => true,
        OperationCanceledException => true, // per-HTTP timeout only; the owner token above must still be live
        JsonException or InvalidOperationException or KeyNotFoundException or FormatException or OverflowException => true,
        GameException game => game.Code is "harness_model_output" or "harness_invalid_payload",
        _ => false
    };
    public static Task<HarnessModelReply> Execute(HarnessProviderSettings settings, ProviderBudget budget,
        HarnessModelRequest request, string campaignId, Func<CancellationToken, Task<HarnessModelReply>> send,
        ILogger? logger, CancellationToken ct) => Execute(settings, budget, campaignId, send, request.BeforeProviderRetry, logger, ct);

    public static async Task<T> Execute<T>(HarnessProviderSettings settings, ProviderBudget budget,
        string campaignId, Func<CancellationToken, Task<T>> send, Func<CancellationToken, Task>? beforeRetry,
        ILogger? logger, CancellationToken ct)
    {
        for (int attempt = 0; ; attempt++)
        {
            ct.ThrowIfCancellationRequested();
            if (attempt > 0 && beforeRetry is { } before) await before(ct);
            ct.ThrowIfCancellationRequested();
            try { budget.Reserve("text", campaignId); }
            catch (ProviderQuotaException) when (attempt == 0) { throw new HarnessModelNotSentException(HarnessModelRejection.Quota); }
            // A quota/permission/cancellation failure after an earlier send must never acquire
            // the first-attempt NotSent proof. The unresolved slot remains conservative unknown.
            if (ModelRequestScope.Current is { } scope) ModelRequestScope.Current = scope with { Attempt = attempt + 1 };
            using var attemptTimeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            attemptTimeout.CancelAfter(settings.AttemptTimeout);
            try { return await send(attemptTimeout.Token); }
            catch (Exception ex) when (attempt < settings.RetryCount && Retryable(ex, ct))
            {
                var delay = settings.RetryDelay(attempt + 1);
                if (ex is TransientStatus { RetryAfter: { } required } && required > delay) delay = required;
                logger?.LogWarning("Harness provider retry: retry={Retry}, delayMs={DelayMs}, error={ErrorType}",
                    attempt + 1, (int)delay.TotalMilliseconds, ex.GetType().Name);
                await Task.Delay(delay, ct);
            }
        }
    }
}
