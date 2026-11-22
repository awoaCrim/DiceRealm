using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Infrastructure;

// Capture once per operation, not once per process and not between HTTP retries.
// Native history still validates provider/model identity in the original adapters.
public sealed class ConfiguredHarnessModel(AiConfigurationStore settings, IHttpClientFactory clients,
    ProviderBudget budget, ILoggerFactory loggers) : IHarnessModel
{
    public bool Enabled => settings.Capture().Main.Enabled;
    public IHarnessModel Capture() => new Frozen(settings.ProviderConfiguration(settings.Capture(), true), clients, budget, loggers);
    public Task<HarnessModelReply> Complete(HarnessModelRequest request, string campaignId, CancellationToken ct) =>
        Capture().Complete(request, campaignId, ct);
    private sealed class Frozen(IConfiguration configuration, IHttpClientFactory clients, ProviderBudget budget,
        ILoggerFactory loggers) : IHarnessModel
    {
        public bool Enabled => new HarnessProviderSettings(configuration).Enabled;
        public async Task<HarnessModelReply> Complete(HarnessModelRequest request, string campaignId, CancellationToken ct)
        {
            bool gemini = new HarnessProviderSettings(configuration).IsGemini;
            using var client = clients.CreateClient(gemini ? nameof(GeminiHarnessModel) : nameof(OpenAiHarnessModel));
            IHarnessModel model = gemini
                ? new GeminiHarnessModel(client, configuration, budget, loggers.CreateLogger<GeminiHarnessModel>())
                : new OpenAiHarnessModel(client, configuration, budget, loggers.CreateLogger<OpenAiHarnessModel>());
            return await model.Complete(request, campaignId, ct);
        }
    }
}
public sealed class ConfiguredText(AiConfigurationStore settings, IHttpClientFactory clients, ProviderBudget budget,
    OfflineText offline) : IIntentInterpreter, INarrator
{
    public bool Enabled => settings.Capture().Helper.Enabled;
    public bool AnyEnabled { get { var snapshot = settings.Capture(); return snapshot.Main.Enabled || snapshot.Helper.Enabled; } }
    private async Task<T> Execute<T>(Func<IIntentInterpreter, INarrator, Task<T>> operation)
    {
        var snapshot = settings.Capture();
        if (!snapshot.Helper.Enabled) return await operation(offline, offline);
        using var client = clients.CreateClient(nameof(OpenAiText));
        var provider = new OpenAiText(client, settings.ProviderConfiguration(snapshot, false), budget);
        return await operation(provider, provider);
    }
    public Task<Intent?> Interpret(string text, ActionChoice[] allowed, CancellationToken cancellationToken, string campaignId = "", PromptBundle? prompts = null) =>
        Execute((interpreter, _) => interpreter.Interpret(text, allowed, cancellationToken, campaignId, prompts));
    public Task<IntentInterpretation> Understand(IntentContext context, CancellationToken cancellationToken, string campaignId = "", PromptBundle? prompts = null) =>
        Execute((interpreter, _) => interpreter.Understand(context, cancellationToken, campaignId, prompts));
    public Task<AdventureDecision> Direct(AdventureContext context, CancellationToken cancellationToken, string campaignId = "", PromptBundle? prompts = null) =>
        Execute((interpreter, _) => interpreter.Direct(context, cancellationToken, campaignId, prompts));
    public Task<Narrative> Narrate(NarrativeContext context, CancellationToken cancellationToken, string campaignId = "", PromptBundle? prompts = null) =>
        Execute((_, narrator) => narrator.Narrate(context, cancellationToken, campaignId, prompts));
}
public sealed class ConfiguredImages(AiConfigurationStore settings, IHttpClientFactory clients, SceneReferences references,
    ProviderBudget budget) : IMapImageGenerator
{
    public bool Enabled => settings.CaptureImage().Enabled;
    public string CacheIdentity => settings.CaptureImage().CacheIdentity;
    public Task<byte[]> Generate(MapGenerationJob map, CancellationToken cancellationToken) =>
        Generate(map.ProviderIdentity, provider => provider.Generate(map, cancellationToken));
    public Task<byte[]> Generate(ImageGenerationRequest image, CancellationToken cancellationToken) =>
        Generate(image.ProviderIdentity, provider => provider.Generate(image, cancellationToken));
    private async Task<byte[]> Generate(string providerIdentity, Func<OpenAiImages, Task<byte[]>> generate)
    {
        var snapshot = settings.CaptureImage();
        if (!snapshot.Enabled) throw new ImageGenerationException("image_provider_disabled", false);
        // Claim's identity check and this call can be separated by an operator save. Fail before
        // HTTP/budget reservation instead of generating new-provider pixels under an old cache key.
        if (snapshot.CacheIdentity != providerIdentity) throw new ImageGenerationException("image_provider_changed", false);
        using var client = clients.CreateClient(nameof(OpenAiImages));
        var provider = new OpenAiImages(client, AiConfigurationStore.ImageConfiguration(snapshot), references, budget);
        return await generate(provider);
    }
}
public sealed class ConfiguredPreparation(AiConfigurationStore settings, IHttpClientFactory clients, ProviderBudget budget,
    OfflinePreparation offline) : IPreparationGenerator
{
    public bool Enabled => settings.Capture().Helper.Enabled;
    public string Model => settings.Capture().Helper.Model;
    public IPreparationGenerator Capture()
    {
        var snapshot = settings.Capture();
        return snapshot.Helper.Enabled ? new Frozen(settings.ProviderConfiguration(snapshot, false), clients, budget) : offline;
    }
    public Task<PreparationProposal> Generate(PreparationGenerationRequest request, CancellationToken cancellationToken, string campaignId) =>
        Capture().Generate(request, cancellationToken, campaignId);
    private sealed class Frozen(IConfiguration configuration, IHttpClientFactory clients, ProviderBudget budget) : IPreparationGenerator
    {
        public bool Enabled => true;
        public string Model => configuration["TextAi:Model"] ?? "";
        public async Task<PreparationProposal> Generate(PreparationGenerationRequest request, CancellationToken cancellationToken, string campaignId)
        {
            using var client = clients.CreateClient(nameof(OpenAiPreparation));
            return await new OpenAiPreparation(client, configuration, budget).Generate(request, cancellationToken, campaignId);
        }
    }
}
