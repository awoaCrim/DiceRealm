using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Application;

// A preparation call carries the host's own source text, intent and the exact system prompt the
// host supplied. The adapter must never substitute authored instructions of its own.
public sealed record PreparationGenerationRequest(string SourceText, string Intent, string SystemPrompt);

public interface IPreparationGenerator
{
    // One accepted preparation owns a stable provider through unknown receipt, HTTP and result.
    IPreparationGenerator Capture() => this;
    bool Enabled { get; }
    string Model { get; }
    Task<PreparationProposal> Generate(PreparationGenerationRequest request, CancellationToken cancellationToken, string campaignId);
}

// No configuration means no provider selection. Draft saving, export and offline inspection stay
// available; only the external organization step is disabled.
public sealed class OfflinePreparation : IPreparationGenerator
{
    public bool Enabled => false;
    public string Model => "";
    public Task<PreparationProposal> Generate(PreparationGenerationRequest request, CancellationToken cancellationToken, string campaignId) =>
        throw new InvalidOperationException("No text provider is configured for preparation.");
}
