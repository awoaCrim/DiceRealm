using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;

namespace DiceRealm.Server.Infrastructure;

// Uses the selected OpenAI-compatible or native Gemini helper protocol, without a model SDK.
// Every system-level instruction comes verbatim from an imported, validated PromptBundle.
// This adapter contains NO built-in intent or narrative prompt text and never substitutes one:
// a missing bundle fails before any HTTP request or provider-budget reservation. Protocol
// guarantees (intent must equal an offered choice; narration is decoration that never mutates
// state) are enforced by the structured payload contract and post-response validation below,
// not by author-facing prose owned by the server.
public sealed class OpenAiText(HttpClient http, IConfiguration configuration, ProviderBudget budget) : IIntentInterpreter, INarrator
{
    private const int MaximumNarrativeCharacters = 4096;

    private readonly TextProviderProtocol provider = new(configuration);

    // Fail-closed prompt gate: runs before Complete, so no quota is consumed without authored prompts.
    private static PromptBundle Require(PromptBundle? prompts, string field)
    {
        if (prompts is null)
            throw new InvalidOperationException($"{field} prompting requires an imported PromptBundle; OpenAiText holds no fallback prompt.");
        PromptBundles.Validate(prompts);
        return prompts;
    }

    private async Task<string> Complete(string system, object payload, CancellationToken cancellationToken, string campaignId, string? narrationSystem = null)
    {
        if (!provider.Enabled) throw new InvalidOperationException("Text provider is disabled.");
        string payloadJson = JsonSerializer.Serialize(payload, JsonFiles.Options);
        if (System.Text.Encoding.UTF8.GetByteCount(payloadJson) > 128 * 1024)
            throw new InvalidDataException("Text context exceeds the bounded request contract.");
        using var request = provider.CreateRequest(narrationSystem is null ? [system] : [system, narrationSystem], payloadJson);
        cancellationToken.ThrowIfCancellationRequested();
        budget.Reserve("text", campaignId);
        using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        response.EnsureSuccessStatusCode();
        var bytes = await BoundedHttp.Read(response.Content, 64 * 1024, cancellationToken);
        using var json = JsonDocument.Parse(bytes);
        string content = TextProviderProtocol.ReadText(json.RootElement, provider.IsGemini);
        budget.RecordTextUsage(campaignId, json.RootElement, provider.IsGemini);
        return content;
    }

    public async Task<Intent?> Interpret(string text, ActionChoice[] allowed, CancellationToken cancellationToken, string campaignId = "", PromptBundle? prompts = null)
    {
        var bundle = Require(prompts, "intent");
        // Player text and scene labels are untrusted data inside a structured envelope; the
        // machine-readable contract (not server prose) pins the expected reply shape.
        var result = await Complete(
            bundle.Intent,
            new
            {
                player_text = text,
                allowed,
                output_contract = new
                {
                    format = "json_object",
                    required_fields = new[] { "kind", "target" },
                    additional_fields_forbidden = true,
                    kind_target_pairs = allowed.Select(a => new { kind = a.Kind, target = a.Target }).ToArray(),
                    out_of_contract_result = new { kind = "", target = "" }
                }
            },
            cancellationToken, campaignId);
        // Strict deserialization rejects extra members (JsonFiles.Options), so the reply can never
        // smuggle dice, DCs, damage, or state back into the engine.
        var intent = JsonSerializer.Deserialize<Intent>(result, JsonFiles.Options);
        return intent is not null && allowed.Any(a => a.Kind == intent.Kind && a.Target == intent.Target)
            ? intent : null;
    }

    public async Task<IntentInterpretation> Understand(IntentContext context, CancellationToken cancellationToken, string campaignId = "", PromptBundle? prompts = null)
    {
        var bundle = Require(prompts, "intent");
        string result = await Complete(bundle.Intent, new
        {
            player_text = context.Text,
            clarifications = context.Clarifications,
            player_context = context.Context,
            candidates = context.Candidates,
            output_contract = new
            {
                format = "json_object", required_fields = new[] { "decision", "candidateIds", "question" },
                additional_fields_forbidden = true, decisions = new[] { "action", "clarify", "adjudicate" },
                allowed_candidate_ids = context.Candidates.Select(c => c.Id).ToArray(),
                action_candidate_count = 1, maximum_clarification_candidates = 6,
                adjudicate_candidate_count = 0, maximum_question_characters = 240,
                question_required_for = "clarify", commands_are_server_owned = true
            }
        }, cancellationToken, campaignId);
        using var parsed = JsonDocument.Parse(result);
        if (parsed.RootElement.ValueKind == JsonValueKind.Object && parsed.RootElement.TryGetProperty("kind", out _))
        {
            // Imported older instructions can still return their original strict pair, not arbitrary payloads.
            var legacy = JsonSerializer.Deserialize<Intent>(result, JsonFiles.Options);
            var candidate = context.Commands.FirstOrDefault(c => c.Action is not null && c.Action == legacy);
            return candidate is null ? new("adjudicate", [], Source: "legacy") : new("action", [candidate.Id], Source: "legacy");
        }
        var output = JsonSerializer.Deserialize<UnderstandingOutput>(result, JsonFiles.Options)
            ?? throw new InvalidDataException("Empty interpretation.");
        return IntentContexts.Validate(new(output.Decision, output.CandidateIds, output.Question), context);
    }
    private sealed record UnderstandingOutput(string Decision, string[] CandidateIds, string Question);

    public async Task<AdventureDecision> Direct(AdventureContext context, CancellationToken cancellationToken, string campaignId = "", PromptBundle? prompts = null)
    {
        var bundle = Require(prompts, "adventure");
        string result = await Complete(bundle.Intent, new
        {
            player_text = context.Intent.Text,
            clarifications = context.Intent.Clarifications,
            player_context = context.Intent.Context,
            candidates = context.Intent.Candidates,
            known_memory = context.KnownMemory,
            known_scenes = context.KnownScenes,
            output_contract = new
            {
                format = "json_object", required_fields = new[] { "decision", "candidateIds", "question", "narrative", "memory" },
                additional_fields_forbidden = true,
                decisions = context.CanNarrate ? new[] { "action", "clarify", "narrate", "adjudicate" } : new[] { "action", "clarify", "adjudicate" },
                allowed_candidate_ids = context.Intent.Candidates.Select(c => c.Id).ToArray(),
                action_candidate_count = 1, maximum_clarification_candidates = 6, maximum_question_characters = 240,
                narrative_required_for = "narrate", maximum_narrative_characters = 4096,
                narrative_candidate_count = 0, memory_only_for = "narrate", maximum_memory_entries = WorldMemories.MaximumProposals,
                memory_fields = new[] { "id", "kind", "name", "summary", "status", "sceneId" },
                memory_kinds = new[] { "npc", "quest", "place", "clue" }, memory_statuses = new[] { "known", "active", "resolved" },
                maximum_name_characters = 80, maximum_summary_characters = 800,
                new_memory_id = "", unknown_scene_id = "", updated_memory_ids = context.KnownMemory.Select(m => m.Id).ToArray(),
                allowed_scene_ids = context.KnownScenes.Select(s => s.Id).ToArray(),
                memory_and_narrative_are_nonmechanical = true, commands_are_server_owned = true,
                forbidden_effects = new[] { "dice", "dc", "hp", "resources", "items", "facts", "rewards", "routes", "coordinates" }
            }
        }, cancellationToken, campaignId, bundle.Narration);
        using var parsed = JsonDocument.Parse(result);
        if (parsed.RootElement.ValueKind == JsonValueKind.Object && parsed.RootElement.TryGetProperty("kind", out _))
        {
            var legacy = JsonSerializer.Deserialize<Intent>(result, JsonFiles.Options);
            var candidate = context.Intent.Commands.FirstOrDefault(c => c.Action is not null && c.Action == legacy);
            return candidate is null ? new("adjudicate", [], Source: "legacy") : new("action", [candidate.Id], Source: "legacy");
        }
        var output = JsonSerializer.Deserialize<AdventureOutput>(result, JsonFiles.Options) ?? throw new InvalidDataException("Empty adventure response.");
        return AdventureDirecting.Validate(new(output.Decision, output.CandidateIds, output.Question, output.Narrative, output.Memory), context);
    }
    private sealed record AdventureOutput(string Decision, string[] CandidateIds, string Question, string Narrative = "", WorldMemoryProposal[]? Memory = null);

    public async Task<Narrative> Narrate(NarrativeContext context, CancellationToken cancellationToken, string campaignId = "", PromptBundle? prompts = null)
    {
        var bundle = Require(prompts, "narration");
        var result = await Complete(
            bundle.Narration,
            new
            {
                scene = context.Scene,
                character = context.CharacterName,
                outcome = context.Outcome,
                recent_events = context.RecentEvents,
                player_context = context.PlayerContext,
                output_contract = new
                {
                    format = "json_object",
                    required_fields = new[] { "text" },
                    additional_fields_forbidden = true,
                    maximum_characters = MaximumNarrativeCharacters,
                    decoration_only = true,
                    authoritative_outcome = true
                }
            },
            cancellationToken, campaignId);
        // Bounded, control-sanitized string parse only. No language, digit, or length-of-style
        // assumptions: the author's bundle decides tone, limits here protect transport and the UI.
        var output = JsonSerializer.Deserialize<TextOutput>(result, JsonFiles.Options);
        if (output is null || string.IsNullOrWhiteSpace(output.Text) || output.Text.Length > MaximumNarrativeCharacters ||
            output.Text.Any(c => char.IsControl(c) && c != '\n' && c != '\t'))
            throw new InvalidDataException("Invalid narrative response.");
        // Prose is still untrusted decoration. It is never parsed into game state.
        return new Narrative(output.Text, "ai");
    }
    private sealed record TextOutput(string Text);
}

public static class BoundedHttp
{
    public static async Task<byte[]> Read(HttpContent content, int maxBytes, CancellationToken cancellationToken)
    {
        if (content.Headers.ContentLength > maxBytes) throw new InvalidDataException("Provider response too large.");
        await using var stream = await content.ReadAsStreamAsync(cancellationToken);
        using var output = new MemoryStream();
        var buffer = new byte[8192];
        int count;
        while ((count = await stream.ReadAsync(buffer, cancellationToken)) > 0)
        {
            if (output.Length + count > maxBytes) throw new InvalidDataException("Provider response too large.");
            output.Write(buffer, 0, count);
        }
        return output.ToArray();
    }
}
