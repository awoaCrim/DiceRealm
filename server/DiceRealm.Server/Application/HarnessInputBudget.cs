namespace DiceRealm.Server.Application;

// Read compatibility for earlier v45 candidates. New slots use ContextPlan.ReportedInputTokens
// from normal generation responses; no metadata/countTokens request produces this record.
public sealed record HarnessInputBudget(string ProviderIdentity, string Model, string ResolvedModel,
    int InputLimit, int OutputLimit, int InputTokens, string WindowRelation, string Source,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    int? RequiredInputTokens = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    int? ReportedInputTokens = null,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingDefault)]
    int CountAdjustment = 0)
{
    [System.Text.Json.Serialization.JsonIgnore]
    public long EffectiveInputTokens => (long)InputTokens + CountAdjustment;
    public void Validate()
    {
        if (ProviderIdentity is not { Length: 64 } || !ProviderIdentity.All(char.IsAsciiHexDigit) ||
            string.IsNullOrWhiteSpace(Model) || Model.Length > 256 ||
            string.IsNullOrWhiteSpace(ResolvedModel) || ResolvedModel.Length > 512 ||
            InputLimit <= 0 || OutputLimit <= 0 || InputTokens < 0 || RequiredInputTokens < 0 || ReportedInputTokens < 0 || CountAdjustment < 0 ||
            WindowRelation != "separate_input_output" || Source != "gemini_models_get_and_count_tokens")
            throw new InvalidDataException();
    }
}
