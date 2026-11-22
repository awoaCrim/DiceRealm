using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Infrastructure;

public sealed record PortraitGenerationJob(string Id, string CampaignId, string LeaseId, ImageGenerationRequest Request);

// A deliberately small image catalog, not game state or a general job queue. One atomic JSON
// owns each visual identity, lease and its permanent request receipts; PNGs are content-addressed.
public sealed class PortraitCatalog
{
    private readonly object gate = new();
    private readonly string records, images;
    private readonly IMapImageGenerator generator;
    private readonly Dictionary<string, SavedPortrait> portraits = new(StringComparer.Ordinal);
    private sealed record SavedPortrait
    {
        public int SchemaVersion { get; init; } = 1;
        public string Id { get; init; } = "";
        public string CampaignId { get; init; } = "";
        public string Prompt { get; init; } = "";
        public string ProviderIdentity { get; init; } = "";
        public string Status { get; init; } = "pending";
        public string LeaseId { get; init; } = "";
        public int Attempts { get; init; }
        public string ContentHash { get; init; } = "";
        public int Width { get; init; }
        public int Height { get; init; }
        public string Error { get; init; } = "";
        public string FailureId { get; init; } = "";
        public Dictionary<string, string> Receipts { get; init; } = new(StringComparer.Ordinal);
    }

    public PortraitCatalog(DataDirectory directory, IMapImageGenerator generator)
    {
        this.generator = generator;
        records = Path.Combine(directory.Root, "portraits");
        images = Path.Combine(directory.Root, "portrait-images");
        Directory.CreateDirectory(records);
        Directory.CreateDirectory(images);
        foreach (var path in Directory.EnumerateFiles(records, "*.json"))
        {
            var saved = JsonFiles.Read<SavedPortrait>(path);
            Validate(saved);
            if (Path.GetFileNameWithoutExtension(path) != saved.Id || !portraits.TryAdd(saved.Id, saved))
                throw new InvalidDataException("Invalid portrait identity.");
            // The directory's single-writer lease proves the old worker cannot still complete.
            // Even graceful shutdown may follow an accepted/billed HTTP request: never resend.
            if (saved.Status == "generating") Save(Failure(saved, "unknown", "portrait_generation_interrupted"));
        }
    }

    private static void Validate(SavedPortrait saved)
    {
        if (saved.SchemaVersion != 1 || !AssetCatalog.IsHash(saved.Id) ||
            !Guid.TryParseExact(saved.CampaignId, "D", out _) || string.IsNullOrWhiteSpace(saved.Prompt) || saved.Prompt.Length > 16000 ||
            saved.ProviderIdentity is null || saved.Status is not ("pending" or "generating" or "ready" or "failed" or "unknown" or "unavailable") ||
            saved.Attempts < 0 || saved.Receipts is null || saved.Receipts.Any(r => !AssetCatalog.IsHash(r.Key) || !AssetCatalog.IsHash(r.Value)) ||
            (saved.Status == "generating") != (saved.LeaseId.Length > 0) ||
            saved.Status == "ready" && (!AssetCatalog.IsHash(saved.ContentHash) || saved.Width is < 1 or > 4096 || saved.Height is < 1 or > 4096) ||
            (saved.Status is "failed" or "unknown" or "unavailable") && (string.IsNullOrEmpty(saved.Error) || string.IsNullOrEmpty(saved.FailureId)))
            throw new InvalidDataException("Invalid portrait record; original file retained.");
    }
    private void Save(SavedPortrait saved)
    {
        Validate(saved);
        JsonFiles.Write(Path.Combine(records, saved.Id + ".json"), saved);
        portraits[saved.Id] = saved;
    }
    private string ImagePath(string hash) => Path.Combine(images, hash + ".png");
    private bool HasImage(SavedPortrait saved) => AssetCatalog.IsHash(saved.ContentHash) && File.Exists(ImagePath(saved.ContentHash));
    private static string ReceiptKey(string campaignId, string actorId, string requestId) => JsonFiles.Hash(campaignId + ":" + actorId + ":" + requestId);
    private static SavedPortrait Failure(SavedPortrait saved, string status, string error) => saved with
    {
        Status = status, Error = error, FailureId = Guid.NewGuid().ToString(), LeaseId = ""
    };
    private SavedPortrait New(string campaignId, PortraitSpecification specification)
    {
        var saved = new SavedPortrait { Id = specification.Id, CampaignId = campaignId, Prompt = specification.Prompt,
            ProviderIdentity = generator.CacheIdentity };
        return !generator.Enabled ? Failure(saved, "unavailable", "image_provider_disabled") : saved;
    }
    private CharacterPortraitView View(SavedPortrait saved, string campaignId, string actorId)
    {
        bool missing = saved.Status == "ready" && !HasImage(saved);
        return new(saved.Id, missing ? "failed" : saved.Status,
            saved.Status == "ready" && !missing ? $"/api/v1/campaigns/{campaignId}/characters/{actorId}/portrait/image?portraitId={saved.Id}&contentHash={saved.ContentHash}" : "",
            saved.Status == "ready" && !missing ? saved.ContentHash : "",
            saved.Status == "ready" && !missing ? saved.Width : 0, saved.Status == "ready" && !missing ? saved.Height : 0,
            missing ? "portrait_image_missing" : saved.Error, missing ? "image:" + saved.ContentHash : saved.FailureId);
    }

    // Pure projection: missing configuration/status never creates a task from a GET or poll.
    public CharacterPortraitView Get(string campaignId, string actorId, PortraitSpecification specification, bool offlineTrial = false)
    {
        lock (gate)
        {
            if (portraits.TryGetValue(specification.Id, out var saved)) return View(saved, campaignId, actorId);
            return new(specification.Id, offlineTrial || !generator.Enabled ? "unavailable" : "missing", "", "", 0, 0,
                offlineTrial ? "portrait_offline_trial" : !generator.Enabled ? "image_provider_disabled" : "");
        }
    }

    // Called only AFTER successful Join/Resubmit commit, also on accepted request replay.
    // An existing unavailable/failed/unknown record is not a fresh authorization to send again.
    public CharacterPortraitView Ensure(string campaignId, string actorId, PortraitSpecification specification, bool offlineTrial = false)
    {
        lock (gate)
        {
            if (!portraits.TryGetValue(specification.Id, out var saved))
            {
                if (offlineTrial) return Get(campaignId, actorId, specification, offlineTrial: true);
                saved = New(campaignId, specification);
                Save(saved);
            }
            return View(saved, campaignId, actorId);
        }
    }

    public CharacterPortraitResponse Request(string campaignId, string callerActorId, string targetActorId,
        PortraitSpecification specification, RequestCharacterPortrait request, bool archived, bool offlineTrial)
    {
        lock (gate)
        {
            string key = ReceiptKey(campaignId, callerActorId, Guid.Parse(request.RequestId).ToString());
            string fingerprint = JsonFiles.Hash(targetActorId + ":" + request.ExpectedPortraitId + ":" + request.RetryFailureId);
            // Receipts precede mutable content/configuration/archival constraints. Return the
            // original identity's current status, not the later build under the same request ID.
            foreach (var original in portraits.Values)
                if (original.Receipts.TryGetValue(key, out var prior))
                {
                    if (prior != fingerprint) throw new GameException("portrait_idempotency_conflict", "该请求编号已用于另一份头像请求。", 409);
                    return new(View(original, campaignId, targetActorId), true);
                }
            if (request.ExpectedPortraitId != specification.Id)
                throw new GameException("portrait_changed", "角色视觉资料已变化，请读取当前头像身份后再提交。", 409);
            portraits.TryGetValue(specification.Id, out var saved);
            var view = saved is null ? null : View(saved, campaignId, targetActorId);
            bool retry = view?.Status is "failed" or "unknown" or "unavailable";
            if (retry ? request.RetryFailureId != view!.FailureId : request.RetryFailureId.Length > 0)
                throw new GameException("portrait_failure_changed", "请读取当前失败记录；只有显式携带该 failureId 的新请求才会重新尝试。", 409);
            if (saved is null || retry)
            {
                if (archived) throw new GameException("campaign_archived", "已归档战役不能请求新的头像生成。", 409);
                if (offlineTrial) throw new GameException("portrait_offline_trial", "离线试跑不会请求图片供应商。", 409);
                var replacement = New(campaignId, specification);
                saved = saved is null ? replacement : replacement with { Attempts = saved.Attempts, Receipts = saved.Receipts };
            }
            saved = saved! with { Receipts = new(saved!.Receipts, StringComparer.Ordinal) { [key] = fingerprint } };
            Save(saved); // Receipt and pending/failed state publish together, including retries.
            return new(View(saved, campaignId, targetActorId), false);
        }
    }

    public CharacterPortraitImage Image(string campaignId, string actorId, PortraitSpecification specification, string portraitId, string contentHash)
    {
        lock (gate)
        {
            if (portraitId != specification.Id || !portraits.TryGetValue(specification.Id, out var saved) ||
                saved.Status != "ready" || contentHash != saved.ContentHash || !HasImage(saved))
                throw new GameException("portrait_image_unavailable", "该角色头像尚未就绪或已经变化，请刷新头像状态。", 404);
            return new(ImagePath(saved.ContentHash), saved.ContentHash);
        }
    }

    public PortraitGenerationJob? Claim()
    {
        lock (gate)
        {
            foreach (var pending in portraits.Values.ToArray())
            {
                if (pending.Status != "pending") continue;
                if (!generator.Enabled) { Save(Failure(pending, "failed", "image_provider_disabled")); continue; }
                if (pending.ProviderIdentity != generator.CacheIdentity) { Save(Failure(pending, "failed", "image_provider_changed")); continue; }
                var saved = pending with { Status = "generating", Attempts = pending.Attempts + 1, LeaseId = Guid.NewGuid().ToString() };
                Save(saved); // Persist possible dispatch BEFORE the supplier/budget boundary.
                return new(saved.Id, saved.CampaignId, saved.LeaseId,
                    new(saved.CampaignId, saved.ProviderIdentity, saved.Prompt, CharacterPortraits.ImageSize, CharacterPortraits.ImageSize));
            }
            return null;
        }
    }
    private bool Owns(PortraitGenerationJob job, out SavedPortrait saved) =>
        portraits.TryGetValue(job.Id, out saved!) && saved.Status == "generating" && saved.LeaseId == job.LeaseId;

    public void Complete(PortraitGenerationJob job, byte[] png)
    {
        PngGuard.Validate(png);
        var (width, height) = PngGuard.Dimensions(png);
        lock (gate)
        {
            if (!Owns(job, out var saved)) return;
            string hash = JsonFiles.Hash(png);
            JsonFiles.WriteBytes(ImagePath(hash), png);
            Save(saved with { Status = "ready", ContentHash = hash, Width = width, Height = height,
                LeaseId = "", Error = "", FailureId = "" });
        }
    }
    public void Fail(PortraitGenerationJob job, string error, bool unknown = false)
    {
        lock (gate)
            if (Owns(job, out var saved)) Save(Failure(saved, unknown ? "unknown" : "failed", error));
    }
}
