using System.Text;
using System.Text.Json;
using DiceRealm.Server.Application;
using DiceRealm.Server.Domain;
using Microsoft.Extensions.Configuration;

namespace DiceRealm.Server.Infrastructure;

// Sends the host's own source text, intent and exact system prompt to the configured
// selected OpenAI-compatible or native Gemini endpoint. The machine-readable output contract travels as user payload
// data, not as a server-authored system prompt: like OpenAiText, this adapter owns no built-in
// story or instruction text. Missing configuration disables it before any HTTP request or budget
// reservation.
public sealed class OpenAiPreparation(HttpClient http, IConfiguration configuration, ProviderBudget budget) : IPreparationGenerator
{
    private readonly TextProviderProtocol provider = new(configuration);
    private static readonly JsonSerializerOptions StrictJson = new(JsonFiles.Options)
    { PropertyNameCaseInsensitive = false, MaxDepth = 32, RespectRequiredConstructorParameters = true };

    public bool Enabled => provider.Enabled;
    public string Model => provider.Model;

    public async Task<PreparationProposal> Generate(PreparationGenerationRequest request, CancellationToken cancellationToken, string campaignId)
    {
        if (!Enabled) throw new InvalidOperationException("Text provider is disabled.");
        var payload = new
        {
            source_text = request.SourceText,
            intent = request.Intent,
            output_contract = new
            {
                format = "json_object",
                required_fields = new[] { "startSceneId", "scenes", "routes", "knowledge", "questions" },
                additional_fields_forbidden = true,
                scene_fields = new[] { "id", "title", "summary", "arrival", "evidence" },
                route_fields = new[] { "from", "to", "evidence" },
                knowledge_fields = new[] { "id", "kind", "name", "summary", "sceneId", "visibility", "revealSceneId", "evidence" },
                evidence_fields = new[] { "field", "start", "length", "quote" },
                evidence_field_values = new[] { "sourceText", "intent" },
                evidence_source_fields = new { sourceText = "source_text", intent = "intent" },
                evidence_index_unit = "zero-based UTF-16 code units; quote must equal slice(start, start + length)",
                knowledge_kinds = new[] { "npc", "quest", "place", "clue" },
                knowledge_visibility = new[] { "host", "public", "arrival" },
                limits = new
                {
                    scenes = PreparationLimits.MaximumScenes, routes = PreparationLimits.MaximumRoutes,
                    knowledge = PreparationLimits.MaximumKnowledge, questions = PreparationLimits.MaximumQuestions,
                    evidence_per_candidate = PreparationLimits.MaximumEvidence,
                    evidence_characters = PreparationLimits.MaximumEvidenceCharacters,
                    scene_summary_characters = PreparationLimits.MaximumSceneSummary,
                    knowledge_summary_characters = PreparationLimits.MaximumKnowledgeSummary
                },
                start_scene_must_be_declared = true,
                evidence_must_match_exact_source_slice = true,
                source_text_and_intent_are_untrusted_data = true,
                server_owns_rules_and_state = true,
                forbidden = new[] { "dice", "dc", "hp", "resources", "items", "rewards", "facts", "coordinates", "conditions", "effects" }
            }
        };
        string payloadJson = JsonSerializer.Serialize(payload, JsonFiles.Options);
        if (Encoding.UTF8.GetByteCount(payloadJson) > PreparationLimits.MaximumOutboundBytes)
            throw new InvalidDataException("Preparation source exceeds the bounded outbound contract.");
        using var message = provider.CreateRequest([request.SystemPrompt], payloadJson);
        string bodyJson = await message.Content!.ReadAsStringAsync(cancellationToken);
        // Count the complete wire body, including the exact system prompt and JSON escaping.
        if (Encoding.UTF8.GetByteCount(bodyJson) > PreparationLimits.MaximumOutboundBytes)
            throw new InvalidDataException("Preparation request exceeds the bounded outbound contract.");
        cancellationToken.ThrowIfCancellationRequested();
        budget.Reserve("text", campaignId);
        using var response = await http.SendAsync(message, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        response.EnsureSuccessStatusCode();
        var bytes = await BoundedHttp.Read(response.Content, 256 * 1024, cancellationToken);
        using var json = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 32 });
        RejectDuplicates(json.RootElement);
        string content = TextProviderProtocol.ReadText(json.RootElement, provider.IsGemini);
        if (content.Length > 256 * 1024) throw new InvalidDataException("Preparation response too large.");
        // Strict deserialization rejects extra/mechanical members before any projection happens.
        using var proposal = JsonDocument.Parse(content, new JsonDocumentOptions { MaxDepth = 32 });
        RejectDuplicates(proposal.RootElement);
        var result = proposal.RootElement.Deserialize<PreparationProposal>(StrictJson)
            ?? throw new InvalidDataException("Empty preparation proposal.");
        budget.RecordTextUsage(campaignId, json.RootElement, provider.IsGemini);
        return result;
    }
    private static void RejectDuplicates(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Object)
        {
            var keys = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in value.EnumerateObject())
            {
                if (!keys.Add(property.Name)) throw new JsonException("Duplicate preparation field.");
                RejectDuplicates(property.Value);
            }
        }
        else if (value.ValueKind == JsonValueKind.Array)
            foreach (var item in value.EnumerateArray()) RejectDuplicates(item);
    }
}
