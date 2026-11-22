using System.Text.Json;
using DiceRealm.Server.Application;

namespace DiceRealm.Server.Infrastructure;

public sealed record AiProbeRequest(string RequestId, long ExpectedVersion, string Role, bool ConfirmProviderUse);
public sealed record AiProbeResult(string RequestId, long Version, string Role, string Status, string Message);

// One explicit, billed, minimal completion. No gameplay/prompt content, automatic retry or raw response projection.
public sealed class AiConnectionTester(AiConfigurationStore store, IHttpClientFactory clients, ProviderBudget budget)
{
    public async Task<AiProbeResult> Test(AiProbeRequest request)
    {
        var (snapshot, receipt) = store.BeginProbe(request);
        if (snapshot is null) return receipt;
        try
        {
            bool main = request.Role == "main";
            var profile = main ? snapshot.Main : snapshot.Helper;
            var probeConfiguration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["TextAi:Endpoint"] = profile.EndpointIsComplete ? profile.BaseUrl : profile.Provider,
                ["TextAi:BaseUrl"] = profile.EndpointIsComplete ? "" : profile.BaseUrl,
                ["TextAi:Model"] = profile.Model,
                ["TextAi:ApiKey"] = profile.ApiKey
            }).Build();
            var provider = new TextProviderProtocol(probeConfiguration);
            using var message = provider.CreateRequest([], "Reply with OK.", jsonOutput: false);
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            using var client = clients.CreateClient(provider.IsGemini ? nameof(GeminiHarnessModel) : nameof(OpenAiHarnessModel));
            budget.Reserve("text", "");
            using var response = await client.SendAsync(message, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            if (!response.IsSuccessStatusCode)
                return store.FinishProbe(receipt with { Status = "failed", Message = $"供应商返回 HTTP {(int)response.StatusCode}；未显示响应正文。此次尝试已记录用量。" });
            var bytes = await BoundedHttp.Read(response.Content, 32768, timeout.Token);
            using var document = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 16 });
            var root = document.RootElement;
            _ = TextProviderProtocol.ReadText(root, provider.IsGemini);
            budget.RecordTextUsage("", root, provider.IsGemini);
            return store.FinishProbe(receipt with { Status = "success", Message = "已收到有效模型回复。测试只验证基本连通与鉴权，不代表完整工具调用或叙事质量已验收。" });
        }
        catch (HarnessModelNotSentException) { return store.FinishProbe(receipt with { Status = "failed", Message = "配置或凭证校验未通过，未向供应商发送请求。" }); }
        catch (ProviderQuotaException) { return store.FinishProbe(receipt with { Status = "failed", Message = "文字调用额度不足，未向供应商发送请求。" }); }
        catch (Exception ex) when (ex is HttpRequestException or OperationCanceledException or JsonException or InvalidDataException or InvalidOperationException or KeyNotFoundException or IndexOutOfRangeException)
        {
            return store.FinishProbe(receipt with { Status = "failed", Message = "连接超时、传输失败或模型响应不符合协议。请求可能已经计费；不会自动重试。" });
        }
    }
}
