using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Application;

public sealed record Narrative(string Text, string Source);
public sealed record NarrativeContext(string Scene, string CharacterName, string Outcome, string[] RecentEvents, string SourceText = "", string[]? Facts = null, PlayerActionContext? PlayerContext = null);
public interface IIntentInterpreter
{
    // Additive input-first protocol. Existing/offline interpreters keep their exact candidate behavior.
    async Task<AdventureDecision> Direct(AdventureContext context, CancellationToken cancellationToken, string campaignId = "", PromptBundle? prompts = null)
    {
        var decision = await Understand(context.Intent, cancellationToken, campaignId, prompts);
        return new(decision.Decision, decision.CandidateIds, decision.Question, Source: decision.Source);
    }

    // prompts carries the imported, user-authored system instructions. Live providers must fail
    // before any request or quota reservation when it is null; offline adapters may ignore it.
    Task<Intent?> Interpret(string text, ActionChoice[] allowed, CancellationToken cancellationToken, string campaignId = "", PromptBundle? prompts = null);
    async Task<IntentInterpretation> Understand(IntentContext context, CancellationToken cancellationToken, string campaignId = "", PromptBundle? prompts = null)
    {
        var legacy = context.Commands.Where(c => c.Action is not null).ToArray();
        var match = await Interpret(context.Text, legacy.Select(c => new ActionChoice(c.Action!.Kind, c.Action.Target, c.Label)).ToArray(), cancellationToken, campaignId, prompts);
        var candidate = legacy.FirstOrDefault(c => c.Action == match);
        return candidate is null ? new("adjudicate", [], Source: "legacy") : new("action", [candidate.Id], Source: "legacy");
    }
}
public interface INarrator
{
    Task<Narrative> Narrate(NarrativeContext context, CancellationToken cancellationToken, string campaignId = "", PromptBundle? prompts = null);
}
public interface IMapImageGenerator
{
    bool Enabled { get; }
    string CacheIdentity { get; }
    Task<byte[]> Generate(MapGenerationJob map, CancellationToken cancellationToken);
    // Additive, map-independent request for portraits. Existing map-only adapters keep their
    // original contract and fail explicitly rather than generating a portrait as a map.
    Task<byte[]> Generate(ImageGenerationRequest image, CancellationToken cancellationToken) =>
        throw new NotSupportedException("This image adapter only supports maps.");
}

// Offline mode is an explicit development adapter, never presented as live AI. It carries no
// authored prompt content: intent maps generic exact action labels and a small basic observe
// alias set, and narration deliberately produces no atmosphere text of its own.
public sealed class OfflineText : IIntentInterpreter, INarrator
{
    private static readonly string[] ObserveAliases = ["look", "observe", "观察"];

    public Task<Intent?> Interpret(string text, ActionChoice[] allowed, CancellationToken cancellationToken, string campaignId = "", PromptBundle? prompts = null)
    {
        var trimmed = text.Trim();
        var kind = ObserveAliases.Contains(trimmed.ToLowerInvariant()) ? "observe" : "";
        var choice = allowed.FirstOrDefault(a => (kind.Length > 0 && a.Kind == kind) || a.Label == trimmed);
        return Task.FromResult(choice is null ? null : new Intent(choice.Kind, choice.Target));
    }

    public Task<IntentInterpretation> Understand(IntentContext context, CancellationToken cancellationToken, string campaignId = "", PromptBundle? prompts = null)
    {
        string text = (context.Clarifications.LastOrDefault()?.Answer ?? context.Text).Trim();
        var exact = context.Candidates.Where(c => c.Label.Equals(text, StringComparison.OrdinalIgnoreCase)).ToArray();
        if (exact.Length == 0 && ObserveAliases.Contains(text.ToLowerInvariant()))
            exact = context.Candidates.Where(c => context.Commands.Any(x => x.Id == c.Id && x.Action?.Kind == "observe")).ToArray();
        if (exact.Length == 1) return Task.FromResult(new IntentInterpretation("action", [exact[0].Id], Source: "offline"));
        var matches = text.Length < 2 ? [] : context.Candidates.Where(c => c.Label.Contains(text, StringComparison.OrdinalIgnoreCase) || c.Details.TargetLabel.Equals(text, StringComparison.OrdinalIgnoreCase)).Take(6).ToArray();
        if (matches.Length > 0) return Task.FromResult(new IntentInterpretation("clarify", matches.Select(c => c.Id).ToArray(), "你想采用哪一种行动或来源？请根据目标与成本选择。", "offline"));
        return Task.FromResult(new IntentInterpretation("adjudicate", [], "", "offline"));
    }

    public Task<Narrative> Narrate(NarrativeContext context, CancellationToken cancellationToken, string campaignId = "", PromptBundle? prompts = null) =>
        // UI-neutral: offline narration is simply absent, not invented prose.
        Task.FromResult(new Narrative("", "offline"));
}
