using System.Text.Json;
using DiceRealm.Server.Domain;
using DiceRealm.Server.Infrastructure;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

namespace DiceRealm.Server.Application;

// Read-only preparation over a campaign. It never writes the campaign aggregate: the durable
// preparation catalog is a separate owner, so an interrupted generation cannot leave a half
// imported adventure or change the live campaign.
public sealed class PreparationService(CampaignStore store, PreparationCatalog catalog, IPreparationGenerator generator,
    IConfiguration configuration, ILogger<PreparationService> logger)
{
    public const int MaximumRequestBytes = PreparationLimits.MaximumRequestBytes;
    private readonly TimeSpan deadline = TimeSpan.FromSeconds(Math.Clamp(configuration.GetValue("PreparationAi:TimeoutSeconds", 120), 5, 300));

    public Task<PreparationStatus> Status(string id, string token, CancellationToken ct) =>
        store.Access(id, token, false, c =>
        {
            PartyEngine.RequireHost(c);
            var provider = generator.Capture();
            bool enabled = provider.Enabled && !c.OfflineTrial && !c.Archived;
            string notice = !provider.Enabled
                ? "服务端未配置文本模型：可以保存草稿、导出和手工检查，但不能请求系统整理。"
                : c.Archived ? "战役已归档；可以读取、保存本地草稿和检查提议，但不能新发起收费整理。"
                : c.OfflineTrial
                    ? "离线试跑不能发起内容准备；请在原战役中整理后再试跑。"
                    : "整理会把本次原文与意图发送到已配置的文本模型。来源匹配只证明引用了原文，不证明语义真实；请逐项检查后再采用。";
            return Task.FromResult(new PreparationStatus(enabled, enabled ? provider.Model : "",
                PreparationLimits.MaximumSourceCharacters, MaximumRequestBytes, notice));
        }, ct);

    public async Task<PreparationResult> Prepare(string id, string token, PreparationRequest request, CancellationToken ct)
    {
        // Authentication runs before shape checks so an anonymous caller never learns whether a
        // payload shape is acceptable.
        var campaign = await store.Access(id, token, false, c =>
        {
            PartyEngine.RequireHost(c);
            return Task.FromResult((c.Id, c.OfflineTrial, c.Archived));
        }, ct);
        PreparationProjection.ValidateRequestShape(request);
        string inputHash = Hash(request.Input);
        string promptHash = Hash(request.Prompt);
        string fingerprint = JsonFiles.Hash("preparation:" + JsonSerializer.Serialize(request, JsonFiles.Options));
        return await catalog.Access(campaign.Id, async (document, persist) =>
        {
            // Replay and conflict resolution are checked before the mutable offline/configuration
            // limits, but only after authentication above.
            var existing = document.Records.FirstOrDefault(r => r.RequestId == request.RequestId);
            if (existing is not null)
            {
                if (existing.Fingerprint != fingerprint)
                    throw new GameException("preparation_conflict", "该请求编号已用于其他内容准备。", 409);
                return existing.Result;
            }
            if (campaign.Archived)
                throw new GameException("campaign_archived", "战役已归档，不能发起新的内容整理。", 409);
            if (campaign.OfflineTrial)
                throw new GameException("preparation_disabled", "离线试跑不能发起内容准备。", 409);
            var provider = generator.Capture();
            if (!provider.Enabled)
                throw new GameException("preparation_disabled", "服务端未配置文本模型；可以保存草稿、导出和手工检查。", 409);
            if (document.Records.Count >= PreparationCatalog.MaximumRecords)
                throw new GameException("preparation_capacity", "本战役的内容准备记录已达到上限；请先处理已有记录。不会自动删除未确认结果。", 409);
            // The request may have waited behind another preparation. Revalidate its
            // frozen timeline in the real campaign gate before recording/sending new work.
            await store.Access(campaign.Id, token, false, c =>
            {
                PartyEngine.RequireHost(c); CampaignTimeline.RequireRequest(c);
                return Task.FromResult(true);
            }, ct);
            // The in-flight record is durable BEFORE any possible external call. A crash between
            // here and the result leaves an unknown record that is replayed as unknown and is never
            // sent a second time.
            var index = document.Records.Count;
            document.Records.Add(new(request.RequestId, fingerprint,
                new PreparationResult(request.RequestId, "unknown", inputHash, promptHash, null, null, [], provider.Model),
                DateTimeOffset.UtcNow));
            await persist();
            PreparationResult result;
            try
            {
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
                timeout.CancelAfter(deadline);
                var proposal = await provider.Generate(
                    new(request.Input.SourceText, request.Input.Intent, request.Prompt.Text), timeout.Token, campaign.Id);
                var outcome = PreparationProjection.Project(request.Input, proposal);
                result = new(request.RequestId, outcome.Status, inputHash, promptHash, proposal, outcome.Document, outcome.Issues, provider.Model);
            }
            catch (Exception ex)
            {
                // Never echo provider/body text: the failure record only states that no usable result
                // came back. Provider attempts stay counted by ProviderBudget.
                logger.LogWarning("Preparation generation failed ({ErrorType})", ex.GetType().Name);
                result = new(request.RequestId, "failed", inputHash, promptHash, null, null,
                    [new(PreparationProjection.ErrorSeverity, "provider",
                        ex is InvalidDataException ? "请求或响应超出允许的外发/结构限制，未能完成整理。" : "供应商未在期限内返回可用结果。")], provider.Model);
            }
            document.Records[index] = new(request.RequestId, fingerprint, result, DateTimeOffset.UtcNow);
            await persist();
            return result;
        }, ct);
    }

    public async Task<PreparationResult> GetRequest(string id, string token, string requestId, CancellationToken ct)
    {
        var campaignId = await store.Access(id, token, false, c =>
        {
            PartyEngine.RequireHost(c);
            return Task.FromResult(c.Id);
        }, ct);
        if (!Guid.TryParseExact(requestId, "D", out _)) throw new GameException("not_found", "未找到该准备请求。", 404);
        return catalog.Find(campaignId, requestId)?.Result
            ?? throw new GameException("not_found", "未找到该准备请求。", 404);
    }

    // Pure validation/projection for saved drafts, offline external output and local option
    // changes. It never contacts a provider and never needs one to be configured.
    public Task<PreparationInspectResult> Inspect(string id, string token, PreparationInspectRequest request, CancellationToken ct) =>
        store.Access(id, token, false, c =>
        {
            PartyEngine.RequireHost(c);
            PreparationProjection.ValidateInput(request?.Input);
            string inputHash = Hash(request!.Input);
            var outcome = PreparationProjection.Project(request.Input, request.Proposal);
            return Task.FromResult(new PreparationInspectResult(outcome.Status, inputHash, request.Proposal, outcome.Document, outcome.Issues));
        }, ct);

    private static string Hash<T>(T value) => JsonFiles.Hash(JsonSerializer.Serialize(value, JsonFiles.Options));
}
